<script setup lang="ts">
/**
 * 6.2/6.3 单字段渲染单元 + 表 27 渲染规则。
 * hidden 字段不会进入 Schema，因此本组件只会收到 read 与 edit 两种形态；
 * 兜底分支保证即使收到 hidden 也不会在 DOM 中留下任何节点（3.4 场景二）。
 * 控件统一用 Element Plus 的 default 档（高 32px、正文 14px）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { checkOne } from '../system/validate'
import type { FieldValue, SchemaField } from '../system/types'
import { promptAction } from '../utils/notify'

const props = withDefaults(
  defineProps<{
    field: SchemaField
    modelValue: FieldValue
    /** 整表只读（审核/归档/截止视角），覆盖字段自身权限 */
    locked?: boolean
    /** 明细区行号，从 1 开始；单头区传 0 */
    rowIndex?: number
  }>(),
  { locked: false, rowIndex: 0 },
)

const emit = defineEmits<{ 'update:modelValue': [value: FieldValue] }>()

const errors = ref<string[]>([])

const isHidden = computed(() => props.field.permission === 'hidden')
const isRead = computed(() => props.locked || props.field.permission !== 'edit' || !!props.field.systemValue)
const wide = computed(() => ['textarea', 'richtext', 'upload', 'checkbox'].includes(props.field.fieldType))
const showReq = computed(() => props.field.isRequired === 1 && !isRead.value)

/** 控件里的显示值（read 态与控件值统一走这个） */
const raw = computed(() => (props.modelValue === null || props.modelValue === undefined ? '' : String(props.modelValue)))

const text = computed(() => {
  const f = props.field
  if (!raw.value) return ''
  if (f.fieldType === 'select' || f.fieldType === 'radio') return optionLabel(f, raw.value)
  if (f.fieldType === 'checkbox') {
    return raw.value
      .split(',')
      .filter(Boolean)
      .map((v) => optionLabel(f, v))
      .join('、')
  }
  if (f.fieldType === 'number' && f.config.unit) return `${raw.value} ${f.config.unit}`
  if (f.fieldType === 'richtext') return stripHtml(raw.value)
  return raw.value
})

/** 只读态下的富文本展示（无值给占位符） */
const readHtml = computed(() => raw.value || '<span class="muted">—</span>')

function optionLabel(f: SchemaField, v: string) {
  if (v.startsWith('other:')) return v.slice(6) || '其他'
  return f.config.options?.find((o) => o.value === v)?.label ?? v
}

function stripHtml(s: string) {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
}

function patch(v: FieldValue) {
  emit('update:modelValue', v)
}

/* -------------------------------------------------- edit 态交互 */

/** 空串落库为 null，与 6.4 的必填判定口径一致 */
function setText(v: string) {
  patch(v === '' ? null : v)
}

/** 6.4 其一：失焦即时提示 */
function onBlur() {
  errors.value = checkOne(props.field, props.modelValue ?? null, props.rowIndex).map((x) => x.message)
}

/** 6.4 数字列按 config.scale 限定小数位，直接交给 el-input-number 的 precision */
const precision = computed(() => {
  const scale = props.field.config.scale
  return scale === undefined || scale < 0 ? undefined : scale
})

const numberValue = computed(() => {
  const v = props.modelValue
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
})

function setNumber(v: number | undefined) {
  patch(v === undefined ? null : v)
  onBlur()
}

const options = computed(() => props.field.config.options ?? [])

/* 单选：other:文本 归一到 other: 这个虚拟值上，才能把「其他」radio 点亮 */
const OTHER = 'other:'
const radioValue = computed(() => (raw.value.startsWith(OTHER) ? OTHER : raw.value))

function setRadio(v: string | number | boolean | undefined) {
  const value = String(v ?? '')
  if (value === OTHER) {
    void promptOther()
    return
  }
  patch(value)
  onBlur()
}

/** 「其他」以 other:文本 形式存储，与 6.4 选项合法性校验一致 */
async function promptOther() {
  const cur = raw.value.startsWith(OTHER) ? raw.value.slice(OTHER.length) : ''
  const r = await promptAction('请输入「其他」的具体内容', '其他选项', { value: cur })
  if (!r) return
  patch(`${OTHER}${r.value.trim()}`)
  onBlur()
}

/* 多选：库存是逗号串，控件要的是数组 */
function checkValues(): string[] {
  return raw.value ? raw.value.split(',').filter(Boolean) : []
}

const checkboxValue = computed<string[]>({
  get: checkValues,
  set: (v) => {
    patch(v.join(','))
    onBlur()
  },
})

const otherChecked = computed(() => checkValues().some((v) => v.startsWith(OTHER)))

async function toggleOther(checked: boolean) {
  const set = new Set(checkValues())
  set.forEach((v) => {
    if (v.startsWith(OTHER)) set.delete(v)
  })
  if (checked) {
    const r = await promptAction('请输入「其他」的具体内容', '其他选项')
    const t = r?.value.trim()
    if (t) set.add(`${OTHER}${t}`)
  }
  patch([...set].join(','))
  onBlur()
}

/* 日期：5.1 统一 yyyy-MM-dd / yyyy-MM-dd HH:mm，与 el-date-picker 的 value-format 同口径 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}/
const dateValue = computed(() => (DATE_RE.test(raw.value) ? raw.value.slice(0, 10) : ''))
const dateTimeValue = computed(() =>
  DATE_RE.test(raw.value) ? `${raw.value.slice(0, 10)} ${raw.value.slice(11, 16)}` : '',
)

function setDate(v: string | null, time: boolean) {
  patch(v || null)
  if (time) onBlur()
}

/* -------------------------------------------------- 富文本 */

const rtEl = ref<HTMLElement | null>(null)

/**
 * 可编辑区不能用 v-html 反向刷新（会抢光标），
 * 只在外部重置（切换记录、载入库存值）时写回。
 */
function writeRt() {
  const el = rtEl.value
  if (el && el.innerHTML !== raw.value) el.innerHTML = raw.value
}
onMounted(writeRt)
watch(() => props.modelValue, writeRt)

function rtCmd(cmd: string) {
  document.execCommand(cmd)
  if (rtEl.value) patch(rtEl.value.innerHTML)
}

function rtInput() {
  if (rtEl.value) patch(rtEl.value.innerHTML)
}
</script>

<template>
  <div v-if="!isHidden" class="fld" :class="{ wide, bad: errors.length }" :data-key="field.fieldKey">
    <span class="cap">
      {{ field.fieldLabel }}
      <i v-if="showReq" class="req">*</i>
      <el-tag v-if="field.systemValue" size="small" type="info" effect="plain" class="badge-sys">系统赋值</el-tag>
      <el-tag v-else-if="field.permission === 'read'" size="small" type="info" effect="plain">只读</el-tag>
      <el-tag v-if="field.origin === 'diff-add'" size="small" effect="plain" class="badge-diff">本单位独有</el-tag>
      <el-tooltip v-else-if="field.diffNote" :content="field.diffNote" placement="top">
        <el-tag size="small" type="warning" effect="plain">{{ field.diffNote }}</el-tag>
      </el-tooltip>
    </span>

    <!-- ============ 只读：有值展示、无值占位（表 27） ============ -->
    <template v-if="isRead">
      <div v-if="field.fieldType === 'richtext'" class="rt-editor" style="pointer-events: none" v-html="readHtml" />
      <p v-else class="ro-text" :class="{ muted: !text }">
        {{ text || '—' }}
        <span v-if="field.fieldType === 'upload' && !text">未上传附件</span>
      </p>
    </template>

    <!-- ============ 可编辑：按字段类型创建控件 ============ -->
    <template v-else>
      <el-input
        v-if="field.fieldType === 'textarea'"
        type="textarea"
        :rows="3"
        :autosize="{ minRows: 3, maxRows: 8 }"
        :model-value="raw"
        :maxlength="field.config.maxLength ?? undefined"
        :show-word-limit="!!field.config.maxLength"
        :placeholder="field.config.placeholder ?? (field.config.maxLength ? `最多 ${field.config.maxLength} 字` : '')"
        @update:model-value="setText(String($event ?? ''))"
        @blur="onBlur"
      />

      <template v-else-if="field.fieldType === 'richtext'">
        <div class="rt-bar">
          <el-button-group>
            <el-button size="small" @click="rtCmd('bold')"><b>B</b></el-button>
            <el-button size="small" @click="rtCmd('italic')"><i>I</i></el-button>
            <el-button size="small" @click="rtCmd('underline')"><u>U</u></el-button>
            <el-button size="small" @click="rtCmd('insertUnorderedList')">列表</el-button>
          </el-button-group>
        </div>
        <div ref="rtEl" class="rt-editor" contenteditable="true" @input="rtInput" @blur="onBlur" />
      </template>

      <el-input-number
        v-else-if="field.fieldType === 'number'"
        :model-value="numberValue"
        :precision="precision"
        :min="field.config.min"
        :max="field.config.max"
        :value-on-clear="null"
        controls-position="right"
        :placeholder="field.config.unit ? `单位：${field.config.unit}` : ''"
        @update:model-value="setNumber($event ?? undefined)"
        @blur="onBlur"
      />

      <el-date-picker
        v-else-if="field.fieldType === 'date'"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="请选择日期"
        :model-value="dateValue"
        @update:model-value="setDate(($event as string | null), false)"
        @blur="onBlur"
      />

      <el-date-picker
        v-else-if="field.fieldType === 'datetime'"
        type="datetime"
        value-format="YYYY-MM-DD HH:mm"
        placeholder="请选择时间"
        :model-value="dateTimeValue"
        @update:model-value="setDate(($event as string | null), true)"
        @blur="onBlur"
      />

      <el-radio-group v-else-if="field.fieldType === 'radio'" :model-value="radioValue" @update:model-value="setRadio">
        <el-radio v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</el-radio>
        <el-radio v-if="field.config.allowOther" :value="OTHER">其他</el-radio>
      </el-radio-group>

      <div v-else-if="field.fieldType === 'checkbox'" class="check-row">
        <el-checkbox-group v-model="checkboxValue">
          <el-checkbox v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</el-checkbox>
        </el-checkbox-group>
        <el-checkbox v-if="field.config.allowOther" :model-value="otherChecked" @change="toggleOther(!!$event)">其他</el-checkbox>
      </div>

      <el-select
        v-else-if="field.fieldType === 'select'"
        :model-value="raw || ''"
        clearable
        placeholder="请选择"
        @update:model-value="setText(String($event ?? '')); onBlur()"
        @blur="onBlur"
      >
        <el-option v-for="o in options" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>

      <el-text v-else-if="field.fieldType === 'upload'" size="small" type="info">
        附件在本页「附件区」统一上传与管理（3.9），当前已上传数量以附件区为准。
      </el-text>

      <el-input
        v-else
        :model-value="raw"
        :maxlength="field.config.maxLength ?? undefined"
        :placeholder="field.config.placeholder ?? ''"
        @update:model-value="setText(String($event ?? ''))"
        @blur="onBlur"
      />
    </template>

    <span v-if="field.config.remark && !isRead" class="tip">{{ field.config.remark }}</span>
    <span v-for="e in errors" :key="e" class="err">{{ e }}</span>
  </div>
</template>

<style scoped>
/* 只读呈现与 32px 控件同高，切换权限态时列表不错位 */
.ro-text {
  margin: 0;
  padding: 5px 11px;
  font-size: 14px;
  line-height: 22px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  color: var(--el-text-color-regular);
  min-height: 32px;
  box-sizing: border-box;
  white-space: pre-wrap;
  word-break: break-all;
}

.check-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 14px;
  min-height: 32px;
}

.cap :deep(.badge-sys) {
  --el-tag-text-color: #075985;
  --el-tag-bg-color: var(--el-color-info-light-9);
  --el-tag-border-color: #bae6fd;
}

.cap :deep(.badge-diff) {
  --el-tag-text-color: #5b21b6;
  --el-tag-bg-color: #ede9fe;
  --el-tag-border-color: #ddd6fe;
}
</style>
