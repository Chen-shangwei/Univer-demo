<script setup lang="ts">
/**
 * 3.3 子单位差异化配置：隐藏字段、修改字段属性、新增本单位独有字段，支持批量复制。
 * 合并语义见 7.1：同 fieldKey 多条规则以最后保存为准，新增字段冲突直接拒绝。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { CopyDocument, Delete, EditPen, Plus } from '@element-plus/icons-vue'
import { remote, type RemoteDiffInput, type RemoteTemplateBoard } from '../system/http'
import { FIELD_TYPE_LABEL, TARGET_LABEL } from '../system/schema-service'
import type { DiffType, FieldConfig, FieldType, FormField, FormOrgDiff, ID } from '../system/types'
import { must, runAsync, toast } from '../utils/notify'

const route = useRoute()
const board = ref<RemoteTemplateBoard | null>(null)
const templateId = ref<ID>((route.query.templateId as string) ?? '')
const orgId = ref<ID>('')

const templates = computed(() => board.value?.templates ?? [])
const subOrgs = computed(() => board.value?.subOrgs ?? [])
const orgName = (id: ID) => board.value?.orgs.find((o) => o.orgId === id)?.orgName ?? id

/** 当前模板版本的基础字段（后端 diff/merged 回带） */
const baseFields = ref<FormField[]>([])
const mergedFields = ref<FormField[]>([])
const rules = ref<FormOrgDiff[]>([])

async function loadMerged() {
  if (!templateId.value || !orgId.value) {
    baseFields.value = []
    mergedFields.value = []
    return
  }
  const r = await remote.diffMerged(templateId.value, orgId.value)
  if (r.code === 200 && r.data) {
    baseFields.value = r.data.base
    mergedFields.value = r.data.merged
  }
}
async function loadRules() {
  if (!templateId.value || !orgId.value) {
    rules.value = []
    return
  }
  const r = await remote.diffList(templateId.value, orgId.value)
  rules.value = r.code === 200 ? r.data : []
}

async function load() {
  const r = await remote.templateBoard()
  board.value = r.code === 200 ? r.data : null
  if (!templateId.value || !templates.value.some((t) => t.templateId === templateId.value)) {
    templateId.value = templates.value[0]?.templateId ?? ''
  }
  if (!subOrgs.value.some((o) => o.orgId === orgId.value)) orgId.value = subOrgs.value[0]?.orgId ?? ''
  await Promise.all([loadMerged(), loadRules()])
}
onMounted(() => void load())
watch([templateId, orgId], () => {
  void loadMerged()
  void loadRules()
})

const DIFF_TEXT: Record<DiffType, string> = { 1: '隐藏字段', 2: '修改属性', 3: '新增独有字段' }
const DIFF_TAG: Record<DiffType, 'danger' | 'warning' | 'success'> = { 1: 'danger', 2: 'warning', 3: 'success' }

/* ------------------------------------------------ 规则编辑 */
const draft = reactive({
  diffId: '',
  diffType: 1 as DiffType,
  fieldKey: '',
  fieldLabel: '',
  fieldType: 'text' as FieldType,
  isRequired: 0 as number,
  scope: 'header' as 'header' | 'detail',
  sort: 90,
  maxLength: 0,
  acceptText: '.pdf,.docx,.xlsx,.png',
  maxSize: 20,
  maxCount: 5,
  optionsText: '',
  note: '',
})
const editing = ref(false)

function newRule(type: DiffType) {
  Object.assign(draft, {
    diffId: '',
    diffType: type,
    fieldKey: type === 3 ? '' : (baseFields.value[0]?.fieldKey ?? ''),
    fieldLabel: '',
    fieldType: 'text',
    isRequired: 0,
    scope: 'header',
    sort: baseFields.value.length + 1,
    maxLength: 0,
    note: '',
  })
  editing.value = true
}

function editRule(d: FormOrgDiff) {
  const c = d.fieldConfig ?? {}
  Object.assign(draft, {
    diffId: d.diffId,
    diffType: d.diffType,
    fieldKey: d.fieldKey,
    fieldLabel: d.fieldLabel ?? '',
    fieldType: d.fieldType ?? 'text',
    isRequired: d.isRequired ?? 0,
    scope: d.scope ?? 'header',
    sort: d.sort ?? 90,
    maxLength: c.maxLength ?? 0,
    acceptText: (c.accept ?? []).join(','),
    maxSize: c.maxSize ?? 20,
    maxCount: c.maxCount ?? 5,
    optionsText: (c.options ?? []).map((o) => `${o.value}:${o.label}`).join('\n'),
    note: d.note ?? '',
  })
  editing.value = true
}

function buildConfig(): FieldConfig | undefined {
  const c: FieldConfig = {}
  if (draft.maxLength) c.maxLength = draft.maxLength
  if (draft.optionsText.trim()) {
    c.options = draft.optionsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':')
        return i < 0 ? { value: l, label: l } : { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() }
      })
  }
  if (draft.fieldType === 'upload') {
    c.accept = draft.acceptText.split(',').map((s) => s.trim()).filter(Boolean)
    c.maxSize = draft.maxSize
    c.maxCount = draft.maxCount
  }
  return Object.keys(c).length ? c : undefined
}

function save() {
  void runAsync(async () => {
    if (!orgId.value) throw new Error('请先选择子单位')
    if (!draft.fieldKey.trim()) throw new Error('请选择或填写字段标识')
    const payload: RemoteDiffInput = {
      diffId: draft.diffId || undefined,
      templateId: templateId.value,
      orgId: orgId.value,
      fieldKey: draft.fieldKey.trim(),
      diffType: draft.diffType,
      note: draft.note,
    }
    if (draft.diffType === 2) {
      if (draft.fieldLabel.trim()) payload.fieldLabel = draft.fieldLabel.trim()
      payload.isRequired = draft.isRequired === 1 ? 1 : 0
      const cfg = buildConfig()
      if (cfg) payload.fieldConfig = cfg
    }
    if (draft.diffType === 3) {
      if (!draft.fieldLabel.trim()) throw new Error('新增独有字段必须填写名称')
      payload.fieldLabel = draft.fieldLabel.trim()
      payload.fieldType = draft.fieldType
      payload.isRequired = draft.isRequired === 1 ? 1 : 0
      payload.sort = draft.sort
      payload.scope = draft.scope
      payload.fieldConfig = { ...(buildConfig() ?? {}), scope: draft.scope }
    }
    must(await remote.diffSave(payload))
    toast('ok', '差异规则已保存')
    editing.value = false
    await Promise.all([loadMerged(), loadRules()])
  })
}

function remove(d: FormOrgDiff) {
  void runAsync(async () => {
    must(await remote.diffRemove(d.diffId))
    toast('ok', '规则已删除')
    await Promise.all([loadMerged(), loadRules()])
  })
}

/* ------------------------------------------------ 批量复制（3.3 其四） */
const copyTargets = ref<ID[]>([])

function doCopy() {
  void runAsync(async () => {
    if (!copyTargets.value.length) throw new Error('请选择目标单位')
    const n = must(await remote.diffCopy(orgId.value, copyTargets.value, templateId.value))
    toast('ok', `已复制 ${n} 条规则到 ${copyTargets.value.length} 个单位，可在各单位下单独调整`)
    copyTargets.value = []
    await Promise.all([loadMerged(), loadRules()])
  })
}

/* ------------------------------------------------ 合并结果（7.1 自证） */
const hiddenKeys = computed(() => {
  const m = new Set(mergedFields.value.map((f) => f.fieldKey))
  return baseFields.value.filter((f) => !m.has(f.fieldKey)).map((f) => f.fieldKey)
})

/** 合并结果与被打掉的隐藏字段并表呈现，隐藏行置灰（6.3） */
const mergedRows = computed(() => [
  ...mergedFields.value.map((f) => ({
    rowKey: f.fieldId,
    hidden: false,
    sort: f.sort as number | string,
    fieldKey: f.fieldKey,
    fieldLabel: f.fieldLabel,
    fieldType: FIELD_TYPE_LABEL[f.fieldType],
    required: f.isRequired ? '是' : '否',
    source: baseFields.value.some((b) => b.fieldKey === f.fieldKey) ? '主模板' : '本单位独有',
  })),
  ...hiddenKeys.value.map((k) => ({
    rowKey: `h-${k}`,
    hidden: true,
    sort: '—' as number | string,
    fieldKey: k,
    fieldLabel: '已被差异规则隐藏，不渲染、不校验、不导出（6.3）',
    fieldType: '—',
    required: '—',
    source: '已隐藏',
  })),
])

function mergedClass({ row }: { row: { hidden: boolean } }) {
  return row.hidden ? 'row-hidden' : ''
}
</script>

<template>
  <div>
    <h2 class="page-title">子单位差异化配置</h2>
    <p class="page-sub">
      3.3：在不改动主模板的前提下，为某个子单位隐藏字段、调整字段属性或新增独有字段。规则按「模板 + 子单位」维度存储（表 15）。
    </p>

    <div class="card row-gap">
      <span class="muted">模板</span>
      <el-select v-model="templateId" filterable style="width: 280px">
        <el-option v-for="t in templates" :key="t.templateId" :label="`${t.templateName}（${t.version}）`" :value="t.templateId" />
      </el-select>
      <span class="muted">子单位</span>
      <el-select v-model="orgId" filterable style="width: 220px">
        <el-option v-for="o in subOrgs" :key="o.orgId" :label="o.orgName" :value="o.orgId" />
      </el-select>
      <span class="spacer" />
      <el-button :icon="Plus" @click="newRule(1)">+ 隐藏字段</el-button>
      <el-button :icon="Plus" @click="newRule(2)">+ 修改属性</el-button>
      <el-button type="primary" :icon="Plus" @click="newRule(3)">+ 新增独有字段</el-button>
    </div>

    <div class="split">
      <div class="main">
        <div class="card">
          <h3>{{ orgName(orgId) }} 的差异规则（{{ rules.length }} 条）</h3>
          <el-table :data="rules" size="small" border row-key="diffId" empty-text="该单位暂无差异化规则，完全沿用主模板">
            <el-table-column label="类型" width="130">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="DIFF_TAG[row.diffType as DiffType]">{{ DIFF_TEXT[row.diffType as DiffType] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="字段标识" width="140">
              <template #default="{ row }"><span class="mono">{{ row.fieldKey }}</span></template>
            </el-table-column>
            <el-table-column label="改写内容" min-width="260">
              <template #default="{ row }">
                <template v-if="row.diffType === 1">不渲染、不参与校验与导出</template>
                <template v-else-if="row.diffType === 2">
                  <span v-if="row.fieldLabel">名称→{{ row.fieldLabel }}　</span>
                  <span v-if="row.isRequired !== undefined">必填→{{ row.isRequired ? '是' : '否' }}　</span>
                  <span v-if="row.fieldConfig?.maxLength" class="mono">长度→{{ row.fieldConfig.maxLength }}</span>
                </template>
                <template v-else>
                  {{ row.fieldLabel }} · {{ row.fieldType ? FIELD_TYPE_LABEL[row.fieldType as FieldType] : '' }} · sort {{ row.sort }}
                </template>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="160" show-overflow-tooltip>
              <template #default="{ row }"><span class="muted">{{ row.note }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="130" align="right">
              <template #default="{ row }">
                <el-button link type="primary" :icon="EditPen" @click="editRule(row as FormOrgDiff)">编辑</el-button>
                <el-button link type="danger" :icon="Delete" @click="remove(row as FormOrgDiff)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <el-dialog v-model="editing" width="720px" :close-on-click-modal="false" :title="draft.diffId ? '编辑差异规则' : DIFF_TEXT[draft.diffType]">
          <label v-if="draft.diffType !== 3" class="fld" style="margin-bottom: 8px">
            <span class="cap">目标字段<i class="req">*</i></span>
            <el-select v-model="draft.fieldKey" filterable placeholder="选择主模板字段">
              <el-option v-for="f in baseFields" :key="f.fieldId" :label="`${f.fieldLabel}（${f.fieldKey}）`" :value="f.fieldKey" />
            </el-select>
          </label>

          <div v-if="draft.diffType === 3" class="fgrid">
            <label class="fld"><span class="cap">字段标识（不可与既有字段重复，2002）<i class="req">*</i></span><el-input v-model="draft.fieldKey" placeholder="如 rndRatio" /></label>
            <label class="fld"><span class="cap">字段名称<i class="req">*</i></span><el-input v-model="draft.fieldLabel" /></label>
            <label class="fld">
              <span class="cap">字段类型</span>
              <el-select v-model="draft.fieldType">
                <el-option v-for="(v, k) in FIELD_TYPE_LABEL" :key="k" :label="v" :value="k" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">所属区域</span>
              <el-select v-model="draft.scope">
                <el-option label="单头区" value="header" />
                <el-option label="明细区" value="detail" />
              </el-select>
            </label>
            <label class="fld"><span class="cap">排序（追加位置）</span><el-input-number v-model="draft.sort" :min="0" :controls-position="'right'" /></label>
            <label class="fld">
              <span class="cap">是否必填</span>
              <el-switch v-model="draft.isRequired" :active-value="1" :inactive-value="0" active-text="是" inactive-text="否" inline-prompt />
            </label>
          </div>

          <div v-if="draft.diffType === 2" class="fgrid">
            <label class="fld"><span class="cap">改名后的名称（留空不改）</span><el-input v-model="draft.fieldLabel" /></label>
            <label class="fld">
              <span class="cap">必填（0 不改则留空）</span>
              <el-select v-model="draft.isRequired">
                <el-option label="否" :value="0" />
                <el-option label="是" :value="1" />
              </el-select>
            </label>
            <label class="fld"><span class="cap">最大长度（仅文本类，0 不改）</span><el-input-number v-model="draft.maxLength" :min="0" :controls-position="'right'" /></label>
          </div>

          <div v-if="draft.diffType === 3 && ['select', 'radio', 'checkbox'].includes(draft.fieldType)" class="fld">
            <span class="cap">选项（每行 value:label）</span>
            <el-input v-model="draft.optionsText" type="textarea" :rows="4" spellcheck="false" />
          </div>

          <label class="fld" style="margin-top: 8px"><span class="cap">配置说明</span><el-input v-model="draft.note" placeholder="为什么要差异化，供后来的人看懂" /></label>

          <template #footer>
            <el-button @click="editing = false">取消</el-button>
            <el-button type="primary" @click="save">保存规则</el-button>
          </template>
        </el-dialog>

        <div class="card">
          <h3>合并后的字段（7.1 结果）</h3>
          <el-table :data="mergedRows" size="small" border row-key="rowKey" :row-class-name="mergedClass" max-height="520">
            <el-table-column label="sort" width="64" align="center" prop="sort" />
            <el-table-column label="字段标识" width="150">
              <template #default="{ row }"><span class="mono">{{ row.fieldKey }}</span></template>
            </el-table-column>
            <el-table-column label="名称" min-width="220" prop="fieldLabel" show-overflow-tooltip />
            <el-table-column label="类型" width="100" prop="fieldType" />
            <el-table-column label="必填" width="64" align="center" prop="required" />
            <el-table-column label="来源" width="120">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="row.hidden ? 'danger' : row.source === '本单位独有' ? 'success' : 'info'">{{ row.source }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h3>批量复制</h3>
          <p class="muted">把 {{ orgName(orgId) }} 的 {{ rules.length }} 条规则复制给其他单位（同 fieldKey 覆盖，无则新增）。</p>
          <el-checkbox-group v-model="copyTargets" class="check-col">
            <el-checkbox v-for="o in subOrgs.filter((x) => x.orgId !== orgId)" :key="o.orgId" :value="o.orgId">{{ o.orgName }}</el-checkbox>
          </el-checkbox-group>
          <el-button type="primary" :icon="CopyDocument" @click="doCopy">开始复制</el-button>
        </div>

        <div class="card">
          <h3>规则冲突口径</h3>
          <ul class="rule-list">
            <li>同一字段命中多条规则时，以最后保存的一条为准（7.1）</li>
            <li>新增独有字段的标识若与主模板或其他新增字段冲突，返回 2002</li>
            <li>字段名称可后续调整，不影响已填报数据（3.2）</li>
            <li>差异与权限规则不随版本复制，版本快照单独留存</li>
            <li>权限对象类型：{{ TARGET_LABEL[1] }} / {{ TARGET_LABEL[2] }} / {{ TARGET_LABEL[3] }} / {{ TARGET_LABEL[4] }}</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
