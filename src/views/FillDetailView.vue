<script setup lang="ts">
/**
 * 3.6 在线填报页（本轮最重的一个页面）。
 * 覆盖：6.2 Schema 驱动渲染、6.3 三态呈现、6.4 四类校验与定位、
 * 7.5 编辑锁与 30 秒自动保存、3.9 附件管理、7.3 版本呈现、7.6 一单位一记录。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AttachmentInput from '../components/AttachmentInput.vue'
import DetailGrid from '../components/DetailGrid.vue'
import DetailTable from '../components/DetailTable.vue'
import DynamicForm from '../components/DynamicForm.vue'
import SchemaTrace from '../components/SchemaTrace.vue'
import { api } from '../system/api'
import { db } from '../system/db'
import { current } from '../system/session'
import { detailFields, headerFields } from '../system/schema-service'
import type { FillContext, WriteResult } from '../system/flow'
import type { FieldValue } from '../system/types'
import { must, fmt, run, toast } from '../utils/notify'
import { tagTypeOf, type TagType } from '../utils/display'

const route = useRoute()
const router = useRouter()
const taskId = String(route.query.taskId ?? '')
const seq = Number(route.query.seq ?? 1) || 1
const me = current()

const ctx = ref<FillContext | null>(null)
/** 编辑锁被他人占用：界面转只读，保存与提交按钮禁用 */
const conflict = ref('')
const forceReadonly = ref(false)

const data = ref<Record<string, FieldValue>>({})
const rows = ref<Record<string, FieldValue>[]>([])
const grid = ref<InstanceType<typeof DetailGrid> | null>(null)

const errors = ref<WriteResult['errors']>([])
const saveHint = ref('')
const dirtyAt = ref('')

/* ------------------------------------------------ 进入页面 */
function enter() {
  run(() => {
    const r = api.form.load(taskId, seq)
    if (r.code === 200) {
      conflict.value = ''
      ctx.value = r.data
    } else if (r.code === 1009) {
      // 7.5：他人正在编辑同一单位同一任务，本次以只读方式打开，数据不被覆盖
      conflict.value = r.msg
      ctx.value = must(api.form.load(taskId, seq, undefined, false))
      forceReadonly.value = true
    } else {
      must(r)
    }
    hydrate()
  })
}

function hydrate() {
  const c = ctx.value
  if (!c) return
  data.value = { ...c.data }
  rows.value = c.rows.map((r) => ({ ...r }))
  snapshot.value = digest()
  saveHint.value = c.readonly ? c.readonlyReason || '该记录当前为只读视角' : '载入库存值，尚未修改'
}

const editable = computed(() => !!ctx.value && !ctx.value.readonly && !forceReadonly.value)
const heads = computed(() => (ctx.value ? headerFields(ctx.value.schema) : []))
const details = computed(() => (ctx.value ? detailFields(ctx.value.schema) : []))
const uploadFields = computed(() => heads.value.filter((f) => f.fieldType === 'upload'))
const recordId = computed(() => ctx.value?.record.recordId ?? '')
/** 填报说明取自模板（表6 template_desc），任务本身不冗余存放 */
const templateDesc = computed(() => (ctx.value ? db.form_template.find((t) => t.templateId === ctx.value!.task.templateId)?.templateDesc ?? '' : ''))

/* ------------------------------------------------ 脏检查（7.5 自动保存前提） */
const snapshot = ref('')
function digest() {
  return JSON.stringify({ data: data.value, rows: collectRows() })
}
const dirty = computed(() => !!ctx.value && editable.value && digest() !== snapshot.value)

/** 明细区以网格现值为准：如实抽出后交给服务层按权限覆盖（8.2） */
function collectRows(): Record<string, FieldValue>[] {
  return grid.value ? grid.value.sync() : rows.value.map((r) => ({ ...r }))
}

/* ------------------------------------------------ 保存 / 提交 */
function doSave(auto: boolean) {
  run(() => {
    const r = must(api.record.draft(taskId, seq, data.value, collectRows(), auto))
    if (!r.ok) throw new Error(r.message)
    errors.value = r.errors
    snapshot.value = digest()
    saveHint.value = r.message
    if (!auto) toast('ok', r.message)
  })
}

function doSubmit() {
  run(() => {
    const r = must(api.record.submit(taskId, seq, data.value, collectRows()))
    errors.value = r.errors
    if (!r.ok) {
      toast('err', r.message)
      if (r.errors.length) locate(r.errors[0]!.fieldKey)
      return
    }
    toast('ok', r.message)
    snapshot.value = digest()
    // 提交后重新载入：状态、审核留痕与只读判定均以服务层为准
    enter()
  })
}

function doValidate() {
  run(() => {
    const list = must(api.form.validate(taskId, seq, data.value, collectRows()))
    errors.value = list
    if (!list.length) toast('ok', '四类校验全部通过（必填 / 格式 / 附件 / 唯一性）')
    else {
      toast('err', `发现 ${list.length} 处问题，已定位首个`)
      locate(list[0]!.fieldKey)
    }
  })
}

/** 6.4 其五：错误项定位到具体字段 */
function locate(fieldKey: string) {
  if (!fieldKey) return
  const el = document.querySelector(`[data-key="${fieldKey}"]`)
  if (!el) {
    toast('info', `「${fieldKey}」位于明细区，请在表格中定位`)
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const input = el.querySelector('input, textarea, select, [contenteditable]') as HTMLElement | null
  input?.focus?.()
}

/* ------------------------------------------------ 定时器：30 秒自动保存 + 15 秒续锁 */
let saveTimer = 0
let lockTimer = 0

function startTimers() {
  stopTimers()
  saveTimer = window.setInterval(() => {
    if (!dirty.value) return
    dirtyAt.value = fmt(new Date()).slice(11, 19)
    doSave(true)
  }, 30_000)
  lockTimer = window.setInterval(() => {
    if (!editable.value) return
    const r = api.record.heartbeat(taskId)
    if (r.code === 200 && r.data && r.data !== me?.realName) {
      conflict.value = `该填报已被「${r.data}」占用，已停止自动保存（7.5）`
      forceReadonly.value = true
      stopTimers()
    }
  }, 15_000)
}

function stopTimers(): void {
  if (saveTimer) window.clearInterval(saveTimer)
  if (lockTimer) window.clearInterval(lockTimer)
  saveTimer = 0
  lockTimer = 0
}

onMounted(() => {
  enter()
  startTimers()
})
onBeforeUnmount(stopTimers)

const STATUS_TEXT: Record<string, string> = { draft: '草稿', submitted: '已提交待审', reject: '已驳回', pass: '已归档' }
const TRAIL_TEXT: Record<string, string> = { pass: '通过', reject: '驳回', revoke: '撤回' }
const TRAIL_TYPE: Record<string, TagType> = { pass: 'success', reject: 'danger', revoke: 'warning' }
</script>

<template>
  <div v-if="ctx">
    <h2 class="page-title">{{ ctx.task.taskName }}<span class="muted">　记录序号 {{ seq }}</span></h2>
    <p class="page-sub">
      表单由 Schema 驱动渲染（模板 {{ ctx.schema.templateVersion }}），字段可见性与可编辑性取决于当前身份「{{ me?.realName }}」的字段权限（3.4）。
    </p>

    <el-alert v-if="conflict" type="error" :closable="false" show-icon>{{ conflict }}</el-alert>
    <el-alert v-else-if="!editable && ctx.readonlyReason" type="info" :closable="false" show-icon style="margin-top: 10px">
      {{ ctx.readonlyReason }}
    </el-alert>

    <el-alert v-if="ctx.record.recordStatus === 'reject'" type="error" :closable="false" show-icon style="margin-top: 10px">
      <template #title><b>审核驳回意见（常驻显示，修改后可重新提交）</b></template>
      {{ ctx.record.auditOpinion || '（未填写意见）' }}
    </el-alert>

    <div class="card" style="margin-top: 12px">
      <div class="row-gap">
        <el-tag size="small" :type="tagTypeOf(ctx.record.recordStatus)">{{ STATUS_TEXT[ctx.record.recordStatus] }}</el-tag>
        <span class="muted">周期 {{ ctx.task.startTime.slice(0, 10) }} ~ {{ ctx.task.endTime.slice(0, 10) }}（剩余 {{ ctx.restDays > 0 ? ctx.restDays + ' 天' : '已截止' }}）</span>
        <span class="muted">提交次数 {{ ctx.record.submitCount }}</span>
        <el-tag v-if="ctx.lockOwner && ctx.lockOwner === me?.userId" size="small" type="success" effect="plain">本单位写入会话由你持有（7.5）</el-tag>
        <el-tag v-else-if="ctx.lockOwner" size="small" type="warning" effect="plain">写入会话由他人持有</el-tag>
        <el-tag size="small" type="info" effect="plain">{{ ctx.fromCache ? 'Schema 命中缓存（6.5）' : 'Schema 重新合并（6.5）' }}</el-tag>
        <span class="spacer" />
        <span class="muted">{{ saveHint }}</span>
        <el-tag v-if="dirty" size="small" type="warning">有未保存修改</el-tag>
        <span v-if="dirtyAt" class="muted">最近检查 {{ dirtyAt }}</span>
      </div>
      <div v-if="ctx.schema.hiddenKeys.length" class="lockbar" style="margin-top: 8px">
        <el-tag size="small" type="danger">已屏蔽字段</el-tag>
        <span class="mono">{{ ctx.schema.hiddenKeys.join('、') }}</span>
        <span class="muted">—— 对当前身份不可见，不创建组件、不参与校验与导出（6.3）</span>
      </div>
    </div>

    <div class="split">
      <div class="main">
        <div class="card">
          <h3>单头区</h3>
          <p class="muted" style="margin-top: 0">{{ templateDesc }}</p>
          <DynamicForm :fields="heads" v-model="data" :locked="!editable" />
        </div>

        <div v-if="details.length" class="card">
          <h3>
            明细区
            <span class="muted">（{{ editable ? '电子表格录入，一行一条' : '只读呈现' }}，共 {{ rows.length }} 行）</span>
          </h3>
          <DetailGrid v-if="editable" ref="grid" :fields="details" :rows="rows" />
          <DetailTable v-else :fields="details" :rows="rows" />
          <p class="flow-hint" style="margin-top: 8px">
            只读列以灰底标注并在提交时由服务端以库存值覆盖；明细区 hidden 列不进入表头，DOM 中不存在（7.1 / 8.2）。
          </p>
        </div>

        <div v-if="uploadFields.length" class="card">
          <h3>附件区</h3>
          <p class="muted" style="margin-top: 0">上传前校验类型、单个大小与数量；提交后随表单转为只读，仅可下载查看（3.9）。</p>
          <el-alert v-if="!editable && ctx.record.recordStatus === 'draft'" type="info" :closable="false" show-icon style="margin-bottom: 10px">
            当前为只读视角，附件仅支持下载。
          </el-alert>
          <div class="fgrid">
            <AttachmentInput
              v-for="f in uploadFields"
              :key="f.fieldKey"
              :field="f"
              :record-id="recordId"
              :editable="editable && (ctx.record.recordStatus === 'draft' || ctx.record.recordStatus === 'reject')"
            />
          </div>
        </div>

        <el-alert v-if="errors.length" type="error" :closable="false" show-icon style="margin-top: 12px">
          <template #title><b>共 {{ errors.length }} 处校验问题（错误码见 5.4 表 25）</b></template>
          <ul class="alert-list">
            <li v-for="(e, i) in errors" :key="i" class="err-item" @click="locate(e.fieldKey)">
              [{{ e.code }}] {{ e.row ? `第 ${e.row} 行 ` : '' }}{{ e.message }}
            </li>
          </ul>
        </el-alert>

        <div class="row-gap" style="margin-top: 12px">
          <el-button type="primary" :disabled="!editable" @click="doSave(false)">保存草稿</el-button>
          <el-button :disabled="!editable" @click="doValidate">校验</el-button>
          <el-button type="primary" :disabled="!editable" @click="doSubmit">提交</el-button>
          <el-button @click="router.push('/fill/list')">返回列表</el-button>
          <span class="muted">提交执行四类校验，草稿仅拦截格式与附件问题（3.6 / 6.4）。</span>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h3>填报说明</h3>
          <p class="muted" style="line-height: 1.8">{{ templateDesc || '模板未填写说明' }}</p>
          <ul class="rule-list">
            <li>带 * 的为必填项；只读项与系统赋值项不参与必填校验</li>
            <li>同一单位的多个部门可协同填写同一条记录，各自只能改动具备 edit 权限的列（7.6）</li>
            <li>停止输入 30 秒后若内容有变化会自动保存草稿（7.5）</li>
            <li>同一单位同一任务同时只允许一个写入会话，锁 30 秒自动释放</li>
            <li>任务截止后草稿转只读，数据保留（7.5）</li>
          </ul>
        </div>

        <div class="card">
          <h3>审核留痕（3.7，不可修改）</h3>
          <el-empty v-if="!ctx.record.auditTrails.length" description="暂无审核记录" :image-size="60" />
          <el-timeline v-else>
            <el-timeline-item
              v-for="t in ctx.record.auditTrails"
              :key="t.trailId"
              :timestamp="t.time"
              :type="TRAIL_TYPE[t.conclusion] ?? 'info'"
              placement="top"
            >
              <div class="t-hd">{{ t.nodeName }} · {{ TRAIL_TEXT[t.conclusion] ?? t.conclusion }}</div>
              <div>{{ t.opinion || '（未填写意见）' }}</div>
              <div class="t-meta">{{ t.userName }} · 耗时 {{ t.costSeconds }} 秒</div>
            </el-timeline-item>
          </el-timeline>
        </div>

        <SchemaTrace :schema="ctx.schema" />
      </div>
    </div>
  </div>

  <div v-else class="card">
    <h3>无法打开填报页</h3>
    <p class="muted">任务标识：{{ taskId || '缺失' }}。请从「我的填报」列表进入，或确认该单位在任务下发范围内（1002）。</p>
    <el-button @click="router.push('/fill/list')">回到列表</el-button>
  </div>
</template>

<style scoped>
.err-item {
  cursor: pointer;
}

.err-item:hover {
  text-decoration: underline;
}
</style>
