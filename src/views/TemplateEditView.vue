<script setup lang="ts">
/**
 * 3.2 其二/其三：模板字段配置 + 表单预览。
 * 6.2 字段类型与 config 的对应关系在此维护，新增类型只扩展 config，不改外层结构。
 */
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowDown, ArrowUp, Delete, EditPen, Plus, View } from '@element-plus/icons-vue'
import DynamicForm from '../components/DynamicForm.vue'
import SchemaTrace from '../components/SchemaTrace.vue'
import DetailTable from '../components/DetailTable.vue'
import { api } from '../system/api'
import { db } from '../system/db'
import { detailFields, FIELD_TYPE_LABEL, headerFields } from '../system/schema-service'
import type { FieldConfig, FieldType, FormField, ID } from '../system/types'
import { confirmAction, must, run, runAsync, toast } from '../utils/notify'

const route = useRoute()
const templateId = ref<ID>((route.query.templateId as string) ?? db.form_template.find((t) => t.delFlag === 0)?.templateId ?? '')

const templates = computed(() => db.form_template.filter((t) => t.delFlag === 0))
const detail = computed(() => (templateId.value ? must(api.template.detail(templateId.value)) : null))
const fields = computed(() => (detail.value ? detail.value.fields : []))

const SCOPE_TEXT = { header: '单头区', detail: '明细区' } as const
const TYPE_KEYS = Object.keys(FIELD_TYPE_LABEL) as FieldType[]

/* ------------------------------------------------ 字段编辑表单 */
const emptyField = (): FieldDraft => ({
  fieldId: '',
  fieldKey: '',
  fieldLabel: '',
  fieldType: 'text',
  isRequired: 0,
  sort: 0,
  scope: 'header',
  group: '',
  placeholder: '',
  remark: '',
  maxLength: 0,
  regex: '',
  unique: false,
  scale: 2,
  min: '',
  max: '',
  unit: '',
  format: '',
  defaultValue: '',
  allowOther: false,
  optionsText: '',
  acceptText: '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg',
  maxSize: 20,
  maxCount: 5,
})

interface FieldDraft {
  fieldId: string
  fieldKey: string
  fieldLabel: string
  fieldType: FieldType
  isRequired: number
  sort: number
  scope: 'header' | 'detail'
  group: string
  placeholder: string
  remark: string
  maxLength: number
  regex: string
  unique: boolean
  scale: number
  min: string
  max: string
  unit: string
  format: string
  defaultValue: string
  allowOther: boolean
  optionsText: string
  acceptText: string
  maxSize: number
  maxCount: number
}

const draft = ref<FieldDraft>(emptyField())
const editing = ref(false)

function newField(scope: 'header' | 'detail') {
  draft.value = { ...emptyField(), scope, sort: fields.value.filter((f) => (f.fieldConfig.scope ?? 'header') === scope).length + 1 }
  editing.value = true
}

function editField(f: FormField) {
  const c = f.fieldConfig
  draft.value = {
    fieldId: f.fieldId,
    fieldKey: f.fieldKey,
    fieldLabel: f.fieldLabel,
    fieldType: f.fieldType,
    isRequired: f.isRequired,
    sort: f.sort,
    scope: (c.scope ?? 'header') as 'header' | 'detail',
    group: c.group ?? '',
    placeholder: c.placeholder ?? '',
    remark: c.remark ?? '',
    maxLength: c.maxLength ?? 0,
    regex: c.regex ?? '',
    unique: !!c.unique,
    scale: c.scale ?? 2,
    min: c.min === undefined ? '' : String(c.min),
    max: c.max === undefined ? '' : String(c.max),
    unit: c.unit ?? '',
    format: c.format ?? '',
    defaultValue: c.defaultValue === undefined ? '' : String(c.defaultValue),
    allowOther: !!c.allowOther,
    optionsText: (c.options ?? []).map((o) => `${o.value}:${o.label}`).join('\n'),
    acceptText: (c.accept ?? []).join(','),
    maxSize: c.maxSize ?? 20,
    maxCount: c.maxCount ?? 5,
  }
  editing.value = true
}

function toConfig(d: FieldDraft): FieldConfig {
  const cfg: FieldConfig = { scope: d.scope }
  if (d.group) cfg.group = d.group
  if (d.placeholder) cfg.placeholder = d.placeholder
  if (d.remark) cfg.remark = d.remark
  if (d.optionsText.trim()) {
    cfg.options = d.optionsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':')
        return i < 0 ? { value: l, label: l } : { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() }
      })
  }
  if (d.allowOther) cfg.allowOther = true
  switch (d.fieldType) {
    case 'text':
    case 'textarea':
    case 'richtext':
      if (d.maxLength) cfg.maxLength = d.maxLength
      if (d.regex) cfg.regex = d.regex
      if (d.unique) cfg.unique = true
      break
    case 'number':
      cfg.scale = d.scale
      if (d.min !== '') cfg.min = Number(d.min)
      if (d.max !== '') cfg.max = Number(d.max)
      if (d.unit) cfg.unit = d.unit
      break
    case 'date':
    case 'datetime':
      cfg.format = d.format || (d.fieldType === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm')
      break
    case 'upload':
      cfg.accept = d.acceptText.split(',').map((s) => s.trim()).filter(Boolean)
      cfg.maxSize = d.maxSize
      cfg.maxCount = d.maxCount
      break
    default:
      break
  }
  if (d.defaultValue) cfg.defaultValue = d.defaultValue
  return cfg
}

function saveField() {
  run(() => {
    if (!templateId.value) throw new Error('请先选择模板')
    if (!draft.value.fieldKey.trim() || !draft.value.fieldLabel.trim()) throw new Error('字段标识与名称必填')
    must(
      api.template.fieldSave(templateId.value, {
        fieldId: draft.value.fieldId || undefined,
        fieldKey: draft.value.fieldKey.trim(),
        fieldLabel: draft.value.fieldLabel.trim(),
        fieldType: draft.value.fieldType,
        isRequired: draft.value.isRequired === 1 ? 1 : 0,
        sort: draft.value.sort,
        fieldConfig: toConfig(draft.value),
      }),
    )
    toast('ok', '字段已保存')
    editing.value = false
  })
}

function removeField(f: FormField) {
  void runAsync(async () => {
    if (!(await confirmAction(`删除字段「${f.fieldLabel}」？历史数据仍按原版本保留（7.3）`, '删除确认'))) return
    must(api.template.fieldRemove(f.fieldId))
    toast('ok', '字段已删除，历史数据不受影响')
  })
}

function move(f: FormField, delta: number) {
  run(() => {
    must(api.template.fieldMove(f.fieldId, delta))
  })
}

/* ------------------------------------------------ 预览 */
const previewOrg = ref<ID>('O11')
const previewUser = ref<ID>('U4')
const previewSchema = ref<ReturnType<typeof buildPreview> | null>(null)

function buildPreview() {
  return must(api.template.preview(templateId.value, db.form_template.find((t) => t.templateId === templateId.value)?.version ?? 'V1.0', previewOrg.value, previewUser.value))
}

function doPreview() {
  run(() => {
    previewSchema.value = buildPreview()
  })
}

const previewData = ref<Record<string, string | number | null>>({})
</script>

<template>
  <div>
    <h2 class="page-title">模板字段配置</h2>
    <p class="page-sub">
      字段顺序即填报页呈现顺序（6.2 sort）。单头区按类型创建控件，明细区作为表格列（7.6 明细型填报）。
    </p>

    <div class="card row-gap">
      <el-text size="small" type="info">选择模板</el-text>
      <el-select v-model="templateId" style="width: 300px">
        <el-option v-for="t in templates" :key="t.templateId" :label="`${t.templateName}（${t.version}）`" :value="t.templateId" />
      </el-select>
      <el-button :icon="Plus" @click="newField('header')">单头字段</el-button>
      <el-button :icon="Plus" @click="newField('detail')">明细列</el-button>
      <span class="spacer" />
      <el-text size="small" type="info">共 {{ fields.length }} 个字段</el-text>
    </div>

    <div class="split">
      <div class="main">
        <div class="card">
          <h3>字段清单</h3>
          <el-table :data="fields" border stripe size="small" empty-text="该模板尚无字段">
            <el-table-column prop="sort" label="排序" width="64" align="right" />
            <el-table-column label="字段标识" min-width="140">
              <template #default="{ row }"><span class="mono">{{ row.fieldKey }}</span></template>
            </el-table-column>
            <el-table-column prop="fieldLabel" label="名称" min-width="120" show-overflow-tooltip />
            <el-table-column label="类型" width="96">
              <template #default="{ row }">{{ FIELD_TYPE_LABEL[row.fieldType as FieldType] }}</template>
            </el-table-column>
            <el-table-column label="必填" width="64" align="center">
              <template #default="{ row }">
                <el-tag size="small" :type="row.isRequired ? 'danger' : 'info'" effect="plain">{{ row.isRequired ? '是' : '否' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="区域" width="84" align="center">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ SCOPE_TEXT[((row.fieldConfig.scope ?? 'header') as 'header' | 'detail')] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="config 摘要" min-width="220">
              <template #default="{ row }">
                <el-tooltip :content="JSON.stringify(row.fieldConfig)" placement="top" :show-after="300">
                  <span class="mono cfg">{{ JSON.stringify(row.fieldConfig) }}</span>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="164" align="center" fixed="right">
              <template #default="{ row }">
                <el-button link :icon="ArrowUp" title="上移" @click="move(row as FormField, -1)" />
                <el-button link :icon="ArrowDown" title="下移" @click="move(row as FormField, 1)" />
                <el-button link type="primary" :icon="EditPen" @click="editField(row as FormField)">编辑</el-button>
                <el-button link type="danger" :icon="Delete" @click="removeField(row as FormField)" />
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h3>表单预览（3.2 其五）</h3>
          <div class="fld">
            <span class="cap">模拟子单位（差异规则生效范围）</span>
            <el-select v-model="previewOrg">
              <el-option
                v-for="o in db.sys_org.filter((x) => x.orgLevel >= 2 && x.delFlag === 0)"
                :key="o.orgId"
                :label="o.orgName"
                :value="o.orgId"
              />
            </el-select>
          </div>
          <div class="fld" style="margin-top: 10px">
            <span class="cap">模拟查看人（权限裁决生效）</span>
            <el-select v-model="previewUser" filterable>
              <el-option v-for="u in db.sys_user.filter((x) => x.delFlag === 0)" :key="u.userId" :label="`${u.realName}（${u.username}）`" :value="u.userId" />
            </el-select>
          </div>
          <el-button type="primary" :icon="View" style="margin-top: 12px" @click="doPreview">生成预览</el-button>
        </div>

        <template v-if="previewSchema">
          <SchemaTrace :schema="previewSchema" />
          <div class="card">
            <h4>单头区（{{ headerFields(previewSchema).length }} 项）</h4>
            <DynamicForm :fields="headerFields(previewSchema)" v-model="previewData" />
            <DetailTable v-if="detailFields(previewSchema).length" :fields="detailFields(previewSchema)" :rows="[]" />
            <el-text v-if="detailFields(previewSchema).length" size="small" type="info" class="block">
              上表为明细列预览（填报时由表格组件承载多行录入）。
            </el-text>
          </div>
        </template>
        <div v-else class="card">
          <el-empty description="选择单位与查看人后生成预览，用于下发前确认差异与权限是否符合预期" :image-size="72" />
        </div>
      </div>
    </div>

    <!-- 3.2 字段配置：字段标识保存后不可变更 -->
    <el-dialog
      v-model="editing"
      :title="draft.fieldId ? '编辑字段' : '新增字段'"
      width="780px"
      top="6vh"
      append-to-body
    >
      <el-alert type="info" :closable="false" show-icon class="dlg-tip">
        字段顺序即填报页呈现顺序（6.2 sort）；字段标识一经保存不再变更，否则历史数据无法对应（3.2）。
      </el-alert>

      <div class="fgrid">
        <label class="fld">
          <span class="cap">字段标识<i class="req">*</i></span>
          <el-input v-model="draft.fieldKey" :disabled="!!draft.fieldId" placeholder="如 itemName" />
        </label>
        <label class="fld"><span class="cap">字段名称<i class="req">*</i></span><el-input v-model="draft.fieldLabel" /></label>
        <label class="fld">
          <span class="cap">字段类型<i class="req">*</i></span>
          <el-select v-model="draft.fieldType">
            <el-option v-for="k in TYPE_KEYS" :key="k" :label="FIELD_TYPE_LABEL[k]" :value="k" />
          </el-select>
        </label>
        <label class="fld">
          <span class="cap">所属区域</span>
          <el-select v-model="draft.scope">
            <el-option label="单头区" value="header" />
            <el-option label="明细区（表格列）" value="detail" />
          </el-select>
        </label>
        <label class="fld">
          <span class="cap">排序</span>
          <el-input-number v-model="draft.sort" :min="0" :controls="false" />
        </label>
        <label class="fld">
          <span class="cap">是否必填</span>
          <el-switch v-model="draft.isRequired" :active-value="1" :inactive-value="0" active-text="必填" inactive-text="选填" inline-prompt />
        </label>
        <label class="fld"><span class="cap">分组（>60 字段时折叠依据，6.5）</span><el-input v-model="draft.group" placeholder="如 项目信息" /></label>
        <label class="fld"><span class="cap">占位提示</span><el-input v-model="draft.placeholder" /></label>
        <label class="fld wide"><span class="cap">字段说明（填报端灰字提示）</span><el-input v-model="draft.remark" /></label>
      </div>

      <div v-if="['text', 'textarea', 'richtext'].includes(draft.fieldType)" class="fgrid sub">
        <label class="fld"><span class="cap">最大长度</span><el-input-number v-model="draft.maxLength" :min="0" :max="4000" /></label>
        <label class="fld"><span class="cap">正则校验</span><el-input v-model="draft.regex" placeholder="^\d{6}$" /></label>
        <label class="fld">
          <span class="cap">明细内唯一</span>
          <el-switch v-model="draft.unique" />
        </label>
      </div>

      <div v-else-if="draft.fieldType === 'number'" class="fgrid sub">
        <label class="fld"><span class="cap">小数位</span><el-input-number v-model="draft.scale" :min="0" :max="6" /></label>
        <label class="fld"><span class="cap">最小值</span><el-input v-model="draft.min" /></label>
        <label class="fld"><span class="cap">最大值</span><el-input v-model="draft.max" /></label>
        <label class="fld"><span class="cap">计量单位</span><el-input v-model="draft.unit" placeholder="万元 / %" /></label>
      </div>

      <div v-else-if="['date', 'datetime'].includes(draft.fieldType)" class="fgrid sub">
        <label class="fld"><span class="cap">展示格式</span><el-input v-model="draft.format" placeholder="yyyy-MM-dd" /></label>
      </div>

      <div v-else-if="['select', 'radio', 'checkbox'].includes(draft.fieldType)" class="fgrid sub">
        <label class="fld wide">
          <span class="cap">选项（每行一条 value:label）</span>
          <el-input v-model="draft.optionsText" type="textarea" :rows="5" placeholder="0:未开始&#10;1:进行中&#10;2:已完成" />
        </label>
        <label class="fld">
          <span class="cap">允许「其他」</span>
          <el-switch v-model="draft.allowOther" />
        </label>
      </div>

      <div v-else-if="draft.fieldType === 'upload'" class="fgrid sub">
        <label class="fld wide"><span class="cap">允许的扩展名（逗号分隔）</span><el-input v-model="draft.acceptText" /></label>
        <label class="fld"><span class="cap">单文件上限 MB</span><el-input-number v-model="draft.maxSize" :min="1" :max="500" /></label>
        <label class="fld"><span class="cap">数量上限</span><el-input-number v-model="draft.maxCount" :min="1" :max="50" /></label>
      </div>

      <template #footer>
        <el-button @click="editing = false">取消</el-button>
        <el-button type="primary" @click="saveField">保存字段</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cfg {
  display: block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-secondary);
}

.fgrid.sub {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--el-border-color);
}

.dlg-tip {
  margin-bottom: 14px;
}

.block {
  display: block;
  margin-top: 6px;
}
</style>
