<script setup lang="ts">
/**
 * 3.5 填报任务管理：创建任务、绑定模板版本、设定周期与审核方式、选择下发范围、发布与归档。
 * 9.2 定时任务口径在「发布 / 刷新状态」时同步执行，用于演示状态推进与临期催办。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Delete, EditPen, Plus } from '@element-plus/icons-vue'
import { remote } from '../system/http'
import type { RemoteTaskBoard, RemoteTaskRow } from '../system/http'
import type { AuditNode, ID, RoleCode } from '../system/types'
import { confirmAction, fmt, must, runAsync, toDateTimeInput, toast } from '../utils/notify'
import { TASK_TAG } from '../utils/display'

const router = useRouter()
const STATUS_TEXT = ['待开始', '进行中', '已截止', '已归档'] as const
const AUDIT_TEXT = ['不审核', '单级审核', '多级审核'] as const

/** 5.1 时间参数统一 yyyy-MM-dd HH:mm:ss；el-date-picker 的 value-format 为 yyyy-MM-dd HH:mm，补秒位即可 */
function toTs(v: string): string {
  return v ? `${v.replace('T', ' ')}:00` : ''
}

const board = ref<RemoteTaskBoard | null>(null)
const loading = ref(false)
const list = computed<RemoteTaskRow[]>(() => board.value?.tasks.slice().sort((a, b) => b.taskId.localeCompare(a.taskId)) ?? [])
/** 3.2：草稿与停用模板不可下发，归档模板不出现在可选列表（后台已按 status===1 过滤） */
const usableTemplates = computed(() => board.value?.templates ?? [])
const allOrgs = computed(() => board.value?.orgs ?? [])
const roleOptions = computed(() => board.value?.roles ?? [])
const userOptions = computed(() => board.value?.users ?? [])

const selected = ref<ID>('')
const current = computed(() => list.value.find((t) => t.taskId === selected.value) ?? null)
const reminds = ref<string[]>([])

const userNames = computed(() => new Map(userOptions.value.map((u) => [u.userId, u.realName])))
const roleNames = computed(() => new Map(roleOptions.value.map((r) => [r.roleCode, r.roleName])))
const nameOf = (id?: ID) => (id ? userNames.value.get(id) ?? id : '—')

/** 唯一数据源：一次拉全任务台账 + 字典；临期催办随读刷新 */
async function load(keepSelection = true) {
  loading.value = true
  try {
    const r = await remote.taskBoard()
    if (r.code === 200 && r.data) {
      board.value = r.data
      reminds.value = r.data.reminds
      if (!keepSelection || !r.data.tasks.some((t) => t.taskId === selected.value)) selected.value = ''
    } else {
      toast('err', r.msg)
    }
  } finally {
    loading.value = false
  }
}
onMounted(() => void load(false))

/* ------------------------------------------------ 任务表单 */
const form = reactive({
  taskId: '' as ID,
  taskName: '',
  templateId: '' as ID,
  startAt: '',
  endAt: '',
  auditType: 1 as 0 | 1 | 2,
  singleRecordPerOrg: true,
  remindDays: 3,
  orgIds: [] as ID[],
})
const nodes = ref<AuditNode[]>([])
const formOpen = ref(false)

function createNew() {
  const t = usableTemplates.value[0]
  Object.assign(form, {
    taskId: '',
    taskName: '',
    templateId: t?.templateId ?? '',
    startAt: toDateTimeInput(fmt(new Date())),
    endAt: toDateTimeInput(fmt(new Date(Date.now() + 20 * 86400_000))),
    auditType: 1 as const,
    singleRecordPerOrg: true,
    remindDays: 3,
    orgIds: allOrgs.value.map((o) => o.orgId),
  })
  nodes.value = [{ nodeId: 'N1', seq: 1, nodeName: '集团业务管理部审核', roleCode: 'auditor' }]
  formOpen.value = true
}

function edit(t: RemoteTaskRow) {
  Object.assign(form, {
    taskId: t.taskId,
    taskName: t.taskName,
    templateId: t.templateId,
    startAt: toDateTimeInput(t.startTime),
    endAt: toDateTimeInput(t.endTime),
    auditType: t.auditType,
    singleRecordPerOrg: t.singleRecordPerOrg,
    remindDays: t.remindDays ?? 0,
    orgIds: [...t.scopeOrgIds],
  })
  nodes.value = structuredClone(t.auditNodes)
  formOpen.value = true
}

function addNode() {
  nodes.value.push({ nodeId: `N${nodes.value.length + 1}`, seq: nodes.value.length + 1, nodeName: '', roleCode: 'auditor' })
}

function removeNode(i: number) {
  nodes.value.splice(i, 1)
  nodes.value.forEach((n, idx) => (n.seq = idx + 1))
}

/** el-select 不接受 undefined 作为选项值，用哨兵值映射「未配置」，写回时仍置 undefined 以保持裁决口径 */
const NONE = 'none'
function nodeRoleVal(i: number): string {
  return nodes.value[i]?.roleCode ?? NONE
}
function nodeRoleSet(i: number, v: string) {
  const n = nodes.value[i]
  if (!n) return
  n.roleCode = v === NONE ? undefined : (v as RoleCode)
  n.userId = undefined
}
function nodeUserVal(i: number): string {
  return nodes.value[i]?.userId ?? NONE
}
function nodeUserSet(i: number, v: string) {
  const n = nodes.value[i]
  if (!n) return
  n.userId = v === NONE ? undefined : v
  n.roleCode = undefined
}

function save() {
  void runAsync(async () => {
    if (!form.taskName.trim()) throw new Error('任务名称必填')
    if (!form.templateId) throw new Error('请选择填报模板')
    if (!form.startAt || !form.endAt) throw new Error('填报周期必填')
    if (toTs(form.startAt) >= toTs(form.endAt)) throw new Error('截止时间必须晚于开始时间')
    if (!form.orgIds.length) throw new Error('请至少选择一个下发单位')
    if (form.auditType > 0) {
      if (!nodes.value.length) throw new Error('开启审核后必须配置至少一个审核节点')
      if (nodes.value.some((n) => !n.nodeName.trim())) throw new Error('审核节点名称不能为空')
      const noAuditor = nodes.value.find((n) => !n.userId && !n.roleCode)
      if (noAuditor) throw new Error(`节点「${noAuditor.nodeName || '未命名'}」需指定审核人或审核角色`)
    }
    const taskId = must(
      await remote.taskCreate({
        taskId: form.taskId || undefined,
        taskName: form.taskName.trim(),
        templateId: form.templateId,
        startTime: toTs(form.startAt),
        endTime: toTs(form.endAt),
        auditType: form.auditType,
        auditNodes: nodes.value,
        singleRecordPerOrg: form.singleRecordPerOrg,
        orgIds: form.orgIds,
        remindDays: form.remindDays || undefined,
      }),
    )
    selected.value = taskId
    await load()
    toast('ok', `任务已保存，绑定模板版本 ${board.value?.tasks.find((t) => t.taskId === taskId)?.templateVersion}（7.3 发布即冻结）`)
    formOpen.value = false
  })
}

/* ------------------------------------------------ 状态动作 */
function publish(t: RemoteTaskRow) {
  void runAsync(async () => {
    const r = must(await remote.taskPublish(t.taskId))
    reminds.value = r.reminds
    toast('ok', `已发布「${t.taskName}」，状态 ${STATUS_TEXT[r.status as 0 | 1 | 2 | 3]}，推进 ${r.changed} 个任务`)
    await load()
  })
}

function archive(t: RemoteTaskRow) {
  void runAsync(async () => {
    const yes = await confirmAction(`归档「${t.taskName}」？归档后任务与数据均为只读，操作日志继续保留（3.5）`, '归档确认')
    if (!yes) return
    must(await remote.taskArchive(t.taskId))
    toast('ok', '任务已归档')
    await load()
  })
}

function refreshState() {
  void runAsync(async () => {
    const r = must(await remote.taskTick())
    reminds.value = r.reminds
    toast('ok', `已按当前时间推进 ${r.changed} 个任务状态`)
    await load()
  })
}

const scopeDraft = ref<ID[]>([])
function openScope(t: RemoteTaskRow) {
  selected.value = t.taskId
  scopeDraft.value = [...t.scopeOrgIds]
}
function applyScope() {
  const t = current.value
  if (!t) return
  void runAsync(async () => {
    must(await remote.taskScopeSave(t.taskId, scopeDraft.value))
    toast('ok', `下发范围已更新为 ${scopeDraft.value.length} 个单位`)
    await load()
  })
}

const nodeText = (t: RemoteTaskRow) =>
  t.auditNodes.map((n) => `${n.seq}.${n.nodeName}（${n.userId ? nameOf(n.userId) : n.roleCode ? roleNames.value.get(n.roleCode) ?? n.roleCode : '未配置'}）`).join(' → ') || '—'

/** 选中行回调的行已是台账行（el-table 会从 :data 推导行类型） */
function pickRow(row: RemoteTaskRow | null) {
  if (row) selected.value = row.taskId
}
</script>

<template>
  <div>
    <h2 class="page-title">填报任务管理</h2>
    <p class="page-sub">
      3.5：任务绑定模板的当前版本并冻结，周期内下发生效。归档后任务与数据只读；未在范围内的单位登录后不可见该任务。
    </p>

    <el-alert v-if="reminds.length" type="info" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title><b>临期催办（9.2 定时任务口径）</b></template>
      <ul class="alert-list"><li v-for="m in reminds" :key="m">{{ m }}</li></ul>
    </el-alert>

    <div class="split">
      <div class="main">
        <div class="card">
          <div class="row-gap">
            <h3 style="margin: 0">任务台账</h3>
            <span class="spacer" />
            <el-button @click="refreshState">刷新状态</el-button>
            <el-button type="primary" :icon="Plus" @click="createNew">+ 新建任务</el-button>
          </div>
          <el-table
            :data="list"
            size="small"
            border
            row-key="taskId"
            highlight-current-row
            :current-row-key="selected"
            empty-text="尚无任务"
            @current-change="pickRow"
          >
            <el-table-column label="任务名称" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.taskName }}
                <el-tooltip v-if="!row.singleRecordPerOrg" content="7.6 已关闭记录唯一性" placement="top">
                  <el-tag size="small" type="warning" effect="plain">一单位多条</el-tag>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="模板 / 版本" min-width="170">
              <template #default="{ row }">
                <span class="muted">{{ row.templateName }} · <span class="mono">{{ row.templateVersion }}</span></span>
              </template>
            </el-table-column>
            <el-table-column label="填报周期" width="190">
              <template #default="{ row }"><span class="mono">{{ row.startTime.slice(0, 10) }} ~ {{ row.endTime.slice(0, 10) }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="92">
              <template #default="{ row }">
                <el-tag size="small" :type="TASK_TAG[row.status as number]">{{ STATUS_TEXT[row.status as number] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="审核方式" width="92">
              <template #default="{ row }">{{ AUDIT_TEXT[row.auditType as number] }}</template>
            </el-table-column>
            <el-table-column label="范围" width="64" align="right">
              <template #default="{ row }">{{ row.scopeOrgIds.length }}</template>
            </el-table-column>
            <el-table-column label="记录" width="64" align="right">
              <template #default="{ row }">{{ row.recordCount }}</template>
            </el-table-column>
            <el-table-column label="操作" width="230" align="right">
              <template #default="{ row }">
                <el-button link type="primary" :icon="EditPen" @click.stop="edit(row as RemoteTaskRow)">编辑</el-button>
                <el-button link type="primary" @click.stop="openScope(row as RemoteTaskRow)">范围</el-button>
                <el-button v-if="row.status !== 3" link type="primary" @click.stop="publish(row as RemoteTaskRow)">发布</el-button>
                <el-button v-if="row.status !== 3" link type="danger" @click.stop="archive(row as RemoteTaskRow)">归档</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <el-dialog v-model="formOpen" width="820px" :close-on-click-modal="false" :title="form.taskId ? '编辑任务' : '新建任务'">
          <div class="fgrid dialog-form">
            <label class="fld"><span class="cap">任务名称<i class="req">*</i></span><el-input v-model="form.taskName" placeholder="如 2026-11 项目任务月度完成情况填报" /></label>
            <label class="fld">
              <span class="cap">填报模板（仅启用状态）<i class="req">*</i></span>
              <el-select v-model="form.templateId" filterable placeholder="选择模板">
                <el-option v-for="t in usableTemplates" :key="t.templateId" :label="`${t.templateName}（${t.version}）`" :value="t.templateId" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">开始时间<i class="req">*</i></span>
              <el-date-picker v-model="form.startAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" placeholder="填报开始时间" />
            </label>
            <label class="fld">
              <span class="cap">截止时间<i class="req">*</i></span>
              <el-date-picker v-model="form.endAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" placeholder="填报截止时间" />
            </label>
            <label class="fld">
              <span class="cap">审核方式</span>
              <el-select v-model="form.auditType">
                <el-option label="不审核（提交即生效）" :value="0" />
                <el-option label="单级审核" :value="1" />
                <el-option label="多级审核" :value="2" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">记录唯一性</span>
              <el-select v-model="form.singleRecordPerOrg">
                <el-option label="一单位一条记录（7.6）" :value="true" />
                <el-option label="允许一单位多条明细记录" :value="false" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">临期催办天数（0 关闭）</span>
              <el-input-number v-model="form.remindDays" :min="0" :controls-position="'right'" />
            </label>
          </div>

          <div v-if="form.auditType > 0" style="margin: 10px 0">
            <h4>审核节点{{ form.auditType === 2 ? '（多级，按顺序流转）' : '' }}</h4>
            <div v-for="(n, i) in nodes" :key="i" class="row-gap node-row">
              <span class="muted">第 {{ i + 1 }} 节点</span>
              <el-input v-model="n.nodeName" placeholder="节点名称，如 子单位初审" class="node-name" />
              <el-select :model-value="nodeRoleVal(i)" class="node-target" @update:model-value="(v) => nodeRoleSet(i, String(v))">
                <el-option label="未配置" :value="NONE" />
                <el-option v-for="r in roleOptions" :key="r.roleId" :label="r.roleName" :value="r.roleCode" />
              </el-select>
              <el-select :model-value="nodeUserVal(i)" class="node-target" filterable @update:model-value="(v) => nodeUserSet(i, String(v))">
                <el-option label="不限定具体人" :value="NONE" />
                <el-option v-for="u in userOptions" :key="u.userId" :label="u.realName" :value="u.userId" />
              </el-select>
              <el-button link type="danger" :icon="Delete" @click="removeNode(i)">删</el-button>
            </div>
            <el-button :icon="Plus" @click="addNode">+ 增加节点</el-button>
            <p class="muted" style="margin: 4px 0 0">指定审核人时以人为准，否则由该角色下任意成员办理（5.3.3）。</p>
          </div>

          <div style="margin: 10px 0">
            <h4>下发范围<i class="req">*</i></h4>
            <el-checkbox-group v-model="form.orgIds" class="chips-wrap">
              <el-checkbox v-for="o in allOrgs" :key="o.orgId" :value="o.orgId">{{ o.orgName }}</el-checkbox>
            </el-checkbox-group>
          </div>

          <p class="tip">保存后任务状态由周期自动推进，也可在台账点「发布」立即推进。</p>
          <template #footer>
            <el-button @click="formOpen = false">取消</el-button>
            <el-button type="primary" @click="save">保存并下发</el-button>
          </template>
        </el-dialog>

        <div v-if="current" class="card">
          <h3>任务详情 · {{ current.taskName }}</h3>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="绑定模板版本">
              <span class="mono">{{ current.templateVersion }}</span>（任务发布时冻结，历史记录按此呈现，7.3）
            </el-descriptions-item>
            <el-descriptions-item label="审核链路">{{ nodeText(current) }}</el-descriptions-item>
            <el-descriptions-item label="下发单位">{{ current.scopeOrgNames.join('、') || '—' }}</el-descriptions-item>
            <el-descriptions-item label="发布单位">{{ current.publishOrgName }}</el-descriptions-item>
            <el-descriptions-item label="创建人 / 时间">
              <span class="muted">{{ current.createdByName ?? '—' }} · {{ current.createTime }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <div class="row-gap" style="margin-top: 12px">
            <span class="muted">调整下发范围（保留已产生的记录）</span>
            <el-select v-model="scopeDraft" multiple filterable collapse-tags collapse-tags-tooltip class="scope-select">
              <el-option v-for="o in allOrgs" :key="o.orgId" :label="o.orgName" :value="o.orgId" />
            </el-select>
            <el-button type="primary" @click="applyScope">应用</el-button>
            <span class="spacer" />
            <el-button @click="router.push({ path: '/summary', query: { taskId: current.taskId } })">查看汇总</el-button>
          </div>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h3>状态口径</h3>
          <ul class="rule-list">
            <li>待开始：不可填报，不可提交（1001）</li>
            <li>进行中：范围内单位可填报、可提交</li>
            <li>已截止：草稿转只读，不再接收新增提交（7.5）</li>
            <li>已归档：任务与数据全部只读，日志保留</li>
          </ul>
        </div>
        <div class="card">
          <h3>各任务填报情况</h3>
          <el-table :data="list" size="small" border row-key="taskId">
            <el-table-column label="任务" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">{{ row.taskName.slice(0, 14) }}…</template>
            </el-table-column>
            <el-table-column label="已提交" width="76" align="right">
              <template #default="{ row }">{{ row.submittedCount }}</template>
            </el-table-column>
            <el-table-column label="未填报" width="76" align="right">
              <template #default="{ row }">{{ Math.max(row.scopeOrgIds.length - row.reportedOrgCount, 0) }}</template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 审核节点行：名称列弹性、两个对象下拉定宽 */
.node-row .node-name {
  flex: 1;
  min-width: 160px;
}

.node-row .node-target {
  width: 170px;
  flex: none;
}

.scope-select {
  width: 320px;
}

/* 下发单位多，折行排布 */
.chips-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 0 18px;
}
</style>
