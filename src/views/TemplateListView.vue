<script setup lang="ts">
/**
 * 3.2 表单模板管理：模板台账、状态流转、版本发布。
 * 字段配置在本页「配置字段」跳转至 /template/edit 完成。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import type { FormInstance, FormRules } from 'element-plus'
import { remote, type RemoteTemplateBoard, type RemoteTemplateDetail, type RemoteTemplateRow } from '../system/http'
import { must, runAsync, toast } from '../utils/notify'

const router = useRouter()
const TPL_STATUS_TEXT = ['草稿', '启用', '停用', '归档']

/** 后台读模型：台账/字典/最近变更一次取回，视图不再回查本地 db */
const board = ref<RemoteTemplateBoard | null>(null)
const bizTypes = computed(() => board.value?.bizTypes ?? [])
const list = computed<RemoteTemplateRow[]>(() => board.value?.templates ?? [])

const selected = ref<string>('')
const detail = ref<RemoteTemplateDetail | null>(null)

const formRef = ref<FormInstance>()
const form = reactive({ templateId: '', templateName: '', templateDesc: '', bizType: '' })
const rules: FormRules = {
  templateName: [{ required: true, message: '请输入模板名称', trigger: 'blur' }],
}
const editing = ref(false)
const publishOpen = ref(false)
const publishSummary = ref('')

async function loadDetail(id: string) {
  if (!id) {
    detail.value = null
    return
  }
  const r = await remote.templateDetail(id)
  detail.value = r.code === 200 ? r.data : null
}

async function load(keepSelection = true) {
  const r = await remote.templateBoard()
  board.value = r.code === 200 ? r.data : null
  if (keepSelection && selected.value && list.value.some((t) => t.templateId === selected.value)) {
    await loadDetail(selected.value)
  } else {
    selected.value = list.value[0]?.templateId ?? ''
    await loadDetail(selected.value)
  }
}
onMounted(() => void load(false))

function create() {
  Object.assign(form, { templateId: '', templateName: '', templateDesc: '', bizType: bizTypes.value[0]?.value ?? '' })
  editing.value = true
}

function edit(t: RemoteTemplateRow) {
  Object.assign(form, { templateId: t.templateId, templateName: t.templateName, templateDesc: t.templateDesc, bizType: t.bizType })
  editing.value = true
}

function save() {
  void runAsync(async () => {
    if (!(await formRef.value?.validate().catch(() => false))) return
    const id = must(await remote.templateSave({ ...form, templateId: form.templateId || undefined }))
    selected.value = id
    await load()
    toast('ok', '模板已保存，可继续配置字段')
    editing.value = false
  })
}

function setStatus(t: { templateId: string; templateName: string }, status: 0 | 1 | 2 | 3) {
  void runAsync(async () => {
    must(await remote.templateStatus(t.templateId, status))
    await load()
    toast('ok', `「${t.templateName}」已置为${TPL_STATUS_TEXT[status]}`)
  })
}

function publish() {
  void runAsync(async () => {
    if (!selected.value) throw new Error('请先选择模板')
    const v = must(await remote.templatePublishVersion(selected.value, publishSummary.value))
    await load()
    toast('ok', `已发布 ${v}，历史记录仍按原版本呈现（7.3）`)
    publishOpen.value = false
    publishSummary.value = ''
  })
}

/** 台账状态到 el-tag 档位 */
function tplTag(status: number): 'success' | 'warning' | 'info' {
  return status === 1 ? 'success' : status === 0 ? 'warning' : 'info'
}

function pickRow(row: { templateId?: string } | null) {
  if (row?.templateId) {
    selected.value = row.templateId
    void loadDetail(row.templateId)
  }
}

function go(path: string, templateId: string) {
  router.push({ path, query: { templateId } })
}
</script>

<template>
  <div>
    <h2 class="page-title">表单模板管理</h2>
    <p class="page-sub">
      3.2：定义表单字段与版本。字段标识一经保存不再变更；停用后不再用于新建任务，已下发的在办任务不受影响。
    </p>

    <div class="split">
      <div class="main">
        <div class="card">
          <div class="row-gap">
            <h3 style="margin: 0">模板清单</h3>
            <span class="spacer" />
            <el-button type="primary" :icon="Plus" @click="create">新建模板</el-button>
          </div>
          <el-table
            :data="list"
            border
            stripe
            highlight-current-row
            row-key="templateId"
            :current-row-key="selected || undefined"
            empty-text="尚无模板"
            class="tbl-gap"
            @current-change="pickRow"
          >
            <el-table-column prop="templateName" label="模板名称" min-width="180" show-overflow-tooltip />
            <el-table-column label="业务分类" min-width="110">
              <template #default="{ row }"><span class="muted">{{ row.bizType }}</span></template>
            </el-table-column>
            <el-table-column label="当前版本" width="100">
              <template #default="{ row }"><span class="mono">{{ row.version }}</span></template>
            </el-table-column>
            <el-table-column label="字段数" width="80" align="right">
              <template #default="{ row }">{{ row.fieldCount }}</template>
            </el-table-column>
            <el-table-column label="关联任务" width="90" align="right">
              <template #default="{ row }">{{ row.taskCount }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90" align="center">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="tplTag(row.status)">{{ TPL_STATUS_TEXT[row.status] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="280" align="center" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click.stop="go('/template/edit', row.templateId)">配置字段</el-button>
                <el-button link type="primary" @click.stop="go('/template/diff', row.templateId)">差异化</el-button>
                <el-button link type="primary" @click.stop="go('/template/perm', row.templateId)">权限</el-button>
                <el-button link @click.stop="edit(row as RemoteTemplateRow)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div v-if="selected && detail" class="card">
          <h3>版本与状态 · {{ detail.template.templateName }}</h3>
          <div class="row-gap" style="margin-bottom: 12px">
            <el-button v-if="detail.template.status !== 1" type="primary" @click="setStatus(detail.template, 1)">启用</el-button>
            <el-button v-if="detail.template.status === 1" @click="setStatus(detail.template, 2)">停用</el-button>
            <el-button v-if="detail.template.status !== 3 && detail.template.status !== 0" @click="setStatus(detail.template, 3)">
              归档
            </el-button>
            <el-button v-if="detail.template.status === 0" @click="setStatus(detail.template, 1)">启用草稿</el-button>
            <el-button @click="publishOpen = true">发布新版本</el-button>
          </div>

          <el-table :data="detail.versions" border size="small" empty-text="尚无历史版本快照">
            <el-table-column label="版本" width="100">
              <template #default="{ row }"><span class="mono">{{ row.version }}</span></template>
            </el-table-column>
            <el-table-column label="发布时间" width="170">
              <template #default="{ row }"><span class="muted">{{ row.publishTime }}</span></template>
            </el-table-column>
            <el-table-column prop="operator" label="操作人" width="110" />
            <el-table-column prop="summary" label="变更摘要" min-width="220" show-overflow-tooltip />
            <el-table-column label="字段数" width="80" align="right">
              <template #default="{ row }">{{ row.fields.length }}</template>
            </el-table-column>
          </el-table>
          <p class="flow-hint" style="margin: 12px 0 0">创建单位：{{ detail.createOrgName }}</p>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h3>操作口径</h3>
          <ul class="rule-list">
            <li>字段标识（fieldKey）保存后不可变更，否则历史数据无法对应</li>
            <li>停用只影响新建任务，不打断在办任务</li>
            <li>归档模板不再出现在任务下发的可选列表中</li>
            <li>版本随发布动作递增，快照含字段/差异/权限三张配置表</li>
          </ul>
        </div>
        <div class="card">
          <h3>最近模板变更（3.10）</h3>
          <el-timeline>
            <el-timeline-item
              v-for="l in board?.operLogs ?? []"
              :key="l.logId"
              :timestamp="l.operTime"
              placement="top"
            >
              <div class="t-hd">{{ l.operType }}</div>
              <div class="muted">{{ l.content }}</div>
              <div class="t-meta">{{ l.userName }}</div>
            </el-timeline-item>
          </el-timeline>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑模板 -->
    <el-dialog v-model="editing" :title="form.templateId ? '编辑模板' : '新建模板'" width="560px" append-to-body>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="88px" class="dialog-form">
        <el-form-item label="模板名称" prop="templateName">
          <el-input v-model="form.templateName" maxlength="60" show-word-limit placeholder="必填" />
        </el-form-item>
        <el-form-item label="业务分类" prop="bizType">
          <el-select v-model="form.bizType" placeholder="请选择业务分类" style="width: 100%">
            <el-option v-for="d in bizTypes" :key="d.value" :label="d.label" :value="d.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="说明" prop="templateDesc">
          <el-input v-model="form.templateDesc" type="textarea" :rows="2" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-text size="small" type="info" class="dialog-tip">新建模板默认为草稿，需配置字段后启用</el-text>
        <el-button @click="editing = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 7.3 发布新版本 -->
    <el-dialog v-model="publishOpen" title="发布新版本" width="520px" append-to-body>
      <el-form label-width="88px" class="dialog-form" @submit.prevent="publish">
        <el-form-item label="变更摘要">
          <el-input v-model="publishSummary" placeholder="写入版本快照" maxlength="120" show-word-limit />
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" show-icon>
        7.3：发布后当前字段、差异、权限配置整体复制为新版本；历史填报记录按其自身版本呈现，
        被删除的字段在导出中标注「已停用字段」。
      </el-alert>
      <template #footer>
        <el-button @click="publishOpen = false">取消</el-button>
        <el-button type="primary" @click="publish">确认发布</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tbl-gap {
  margin-top: 12px;
}

.rule-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.9;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.dialog-tip {
  float: left;
  line-height: 32px;
}
</style>
