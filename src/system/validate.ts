/**
 * 6.4 交互与校验 + 3.6 提交时的四类校验：
 * 必填、字段格式、附件类型与数量、业务唯一性。
 * 8.2：这些规则同样在后端服务层执行，前端提示仅为体验优化。
 */
import { ERR } from './errors'
import { isEditable } from './schema-service'
import type { FormAttachment, FormSchema, SchemaField, ID } from './types'

export type FieldValue = string | number | null

export interface ValidateError {
  code: number
  fieldKey: string
  label: string
  message: string
  /** 明细区行号，从 1 开始；单头区为 0 */
  row: number
}

const isBlank = (v: FieldValue) => v === null || v === undefined || String(v).trim() === ''

function toDate(v: string): Date | null {
  const d = new Date(v.replace(/-/g, '/'))
  return Number.isNaN(d.getTime()) ? null : d
}

/** 6.3：hidden 字段不渲染也不参与校验；read/系统赋值列不参与必填 */
function checkable(f: SchemaField): boolean {
  return isEditable(f)
}

function checkValue(
  f: SchemaField,
  value: FieldValue,
  rowIndex: number,
  seen: Map<string, Set<string>>,
): ValidateError[] {
  const errs: ValidateError[] = []
  const push = (code: number, message: string) =>
    errs.push({ code, fieldKey: f.fieldKey, label: f.fieldLabel, message, row: rowIndex })
  const cfg = f.config

  if (isBlank(value)) {
    if (f.isRequired === 1 && checkable(f)) push(ERR.REQUIRED, `「${f.fieldLabel}」为必填项`)
    return errs
  }

  const s = String(value)

  switch (f.fieldType) {
    case 'text':
    case 'textarea':
    case 'richtext': {
      if (cfg.maxLength && s.length > cfg.maxLength) push(ERR.FORMAT, `「${f.fieldLabel}」长度 ${s.length} 超过上限 ${cfg.maxLength}`)
      if (cfg.regex && !new RegExp(cfg.regex).test(s)) push(ERR.FORMAT, `「${f.fieldLabel}」格式不正确（要求 ${cfg.regex}）`)
      if (cfg.unique) {
        const set = seen.get(f.fieldKey) ?? new Set<string>()
        if (set.has(s)) push(ERR.FORMAT, `「${f.fieldLabel}」的值「${s}」重复，需保证唯一`)
        set.add(s)
        seen.set(f.fieldKey, set)
      }
      break
    }
    case 'number': {
      const n = Number(s)
      if (!Number.isFinite(n)) {
        push(ERR.FORMAT, `「${f.fieldLabel}」必须是数字`)
        break
      }
      const scale = cfg.scale ?? 2
      // scale=0 表示整数，不能拼出 \d{1,0} 这种非法量词
      const pattern = scale > 0 ? new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`) : /^-?\d+$/
      if (!pattern.test(s)) {
        push(ERR.FORMAT, scale > 0 ? `「${f.fieldLabel}」最多保留 ${scale} 位小数` : `「${f.fieldLabel}」必须是整数`)
        break
      }
      if (cfg.min !== undefined && n < cfg.min) push(ERR.FORMAT, `「${f.fieldLabel}」不得小于 ${cfg.min}${cfg.unit ?? ''}`)
      if (cfg.max !== undefined && n > cfg.max) push(ERR.FORMAT, `「${f.fieldLabel}」不得大于 ${cfg.max}${cfg.unit ?? ''}`)
      break
    }
    case 'date':
    case 'datetime': {
      const pattern = f.fieldType === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
      if (!pattern.test(s)) {
        push(ERR.FORMAT, `「${f.fieldLabel}」日期格式应为 ${cfg.format ?? (f.fieldType === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm')}`)
        break
      }
      const d = toDate(s)
      if (!d) push(ERR.FORMAT, `「${f.fieldLabel}」不是有效日期`)
      break
    }
    case 'select':
    case 'radio': {
      const opts = cfg.options ?? []
      const ok = opts.some((o) => o.value === s) || (cfg.allowOther && s.startsWith('other:'))
      if (!ok) push(ERR.FORMAT, `「${f.fieldLabel}」取值不合法，可选：${opts.map((o) => o.label).join('/')}`)
      break
    }
    case 'checkbox': {
      const parts = s.split(',').filter((p) => p !== '')
      const opts = cfg.options ?? []
      const bad = parts.filter((p) => !opts.some((o) => o.value === p) && !(cfg.allowOther && p.startsWith('other:')))
      if (bad.length) push(ERR.FORMAT, `「${f.fieldLabel}」存在非法取值：${bad.join('、')}`)
      break
    }
    case 'upload':
      break
  }

  return errs
}

export interface ValidateInput {
  schema: FormSchema
  data: Record<string, FieldValue>
  rows: Record<string, FieldValue>[]
  attachments: FormAttachment[]
  /** 同一任务同一单位下其他记录的字段值，用于业务唯一性校验 */
  otherRecords?: Record<string, FieldValue>[]
  /** 附件字段所属记录标识，用于按记录统计数量 */
  recordId?: ID
  /** 3.6 只校验单头（草稿保存场景传 false 跳过必填） */
  requireAll?: boolean
}

/**
 * 提交校验入口。返回空数组代表通过。
 * 错误顺序即为定位顺序：先单头后明细，前端据首个错误滚动定位（6.4）。
 */
export function validateForm(input: ValidateInput): ValidateError[] {
  const errs: ValidateError[] = []
  const head = input.schema.fields.filter((f) => f.config.scope !== 'detail')
  const detail = input.schema.fields.filter((f) => f.config.scope === 'detail')

  const seenHead = new Map<string, Set<string>>()
  head.forEach((f) => {
    errs.push(...checkValue(f, input.data[f.fieldKey] ?? null, 0, seenHead))
  })

  const seenRow = new Map<string, Set<string>>()
  input.rows.forEach((row, i) => {
    const filled = detail.some((f) => isEditable(f) && !isBlank(row[f.fieldKey]))
    if (!filled) return
    detail.forEach((f) => errs.push(...checkValue(f, row[f.fieldKey] ?? null, i + 1, seenRow)))
  })

  // 明细区至少要有一行有效数据
  if (detail.length && input.requireAll !== false) {
    const anyFilled = input.rows.some((row) => detail.some((f) => isEditable(f) && !isBlank(row[f.fieldKey])))
    if (!anyFilled) errs.push({ code: ERR.REQUIRED, fieldKey: '', label: '明细', message: '至少需要填报一行明细数据', row: 0 })
  }

  // 附件：类型、单个大小、数量上限（3.9）
  input.schema.fields
    .filter((f) => f.fieldType === 'upload')
    .forEach((f) => {
      const list = input.attachments.filter((a) => a.fieldKey === f.fieldKey && a.delFlag === 0)
      const maxCount = f.config.maxCount ?? 5
      const maxSize = f.config.maxSize ?? 20
      const accept = f.config.accept ?? []
      if (list.length > maxCount) errs.push({ code: ERR.ATTACH_LIMIT, fieldKey: f.fieldKey, label: f.fieldLabel, message: `「${f.fieldLabel}」附件数量 ${list.length} 超过上限 ${maxCount}`, row: 0 })
      list.forEach((a) => {
        const ext = `.${a.fileType}`
        if (accept.length && !accept.includes(ext)) {
          errs.push({ code: ERR.ATTACH_LIMIT, fieldKey: f.fieldKey, label: f.fieldLabel, message: `「${a.fileName}」类型 ${ext} 不在允许范围 ${accept.join('/')}`, row: 0 })
        }
        if (a.fileSize > maxSize * 1024 * 1024) {
          errs.push({ code: ERR.ATTACH_LIMIT, fieldKey: f.fieldKey, label: f.fieldLabel, message: `「${a.fileName}」大小超过单文件上限 ${maxSize}MB`, row: 0 })
        }
      })
    })

  // 业务唯一性：模板内标记唯一的字段，在同任务同单位的其他记录中也不可重复
  if (input.otherRecords?.length) {
    const taken = new Map<string, Set<string>>()
    input.otherRecords.forEach((r) => {
      Object.entries(r).forEach(([k, v]) => {
        if (isBlank(v)) return
        const set = taken.get(k) ?? new Set<string>()
        set.add(String(v))
        taken.set(k, set)
      })
    })
    input.rows.forEach((row, i) => {
      detail.forEach((f) => {
        if (!f.config.unique) return
        const v = row[f.fieldKey]
        if (!isBlank(v) && taken.get(f.fieldKey)?.has(String(v))) {
          errs.push({ code: ERR.FORMAT, fieldKey: f.fieldKey, label: f.fieldLabel, message: `第 ${i + 1} 行「${f.fieldLabel}」与本单位已提交记录重复：${String(v)}`, row: i + 1 })
        }
      })
    })
  }

  // 3.6 草稿保存：只拦格式与附件问题，不拦必填
  if (input.requireAll === false) return errs.filter((e) => e.code !== ERR.REQUIRED)

  return errs
}

/** 明细区某一整行是否为空行（供 UI 折叠展示与草稿清理） */
export function isBlankRow(detail: SchemaField[], row: Record<string, FieldValue>): boolean {
  return !detail.some((f) => !isBlank(row[f.fieldKey]))
}

/**
 * 6.4 其一：单字段即时校验（失焦触发）。
 * 与提交校验复用同一套规则，保证提示口径一致。
 */
export function checkOne(f: SchemaField, value: FieldValue, rowIndex = 0): ValidateError[] {
  return checkValue(f, value, rowIndex, new Map<string, Set<string>>())
}

export { isBlank }
