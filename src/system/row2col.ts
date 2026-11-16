/**
 * 7.4 行转列处理 + 3.8 数据汇总与导出 + 4.6 其一（数字副本列）。
 * 宽表：行对应填报记录（明细区多行时按行展开），列对应模板字段，字段顺序与模板一致。
 */
import { db, orgById, userById } from './db'
import { nowStr } from './time'
import { resolveSchema } from './schema-service'
import type { FieldValue, FormFieldPermission, FormRecord, FormSchema, FormTask, ID, SysUser } from './types'
import type { FieldType } from './types'

const isBlank = (v: FieldValue) => v === null || v === undefined || String(v).trim() === ''

/* --------------------------------------- 表20 form_record_data 投影 */

export interface RecordDataRow {
  dataId: string
  recordId: ID
  fieldKey: string
  fieldValue: string
  fieldValueNum: number | null
}

/**
 * 单头字段一行一值；明细区列以 JSON 数组文本存一行（4.4 表20 field_value 为 text，
 * 与「多选以分隔符拼接、附件存文件标识」同属序列化约定），行转列时按 index 还原。
 */
export function toRecordData(record: FormRecord): RecordDataRow[] {
  const out: RecordDataRow[] = []
  let i = 0
  const push = (fieldKey: string, value: FieldValue) => {
    i += 1
    const n = typeof value === 'number' ? value : value !== null && /^-?\d+(\.\d+)?$/.test(String(value)) ? Number(value) : null
    out.push({
      dataId: `${record.recordId}-D${i}`,
      recordId: record.recordId,
      fieldKey,
      fieldValue: value === null || value === undefined ? '' : String(value),
      fieldValueNum: n,
    })
  }
  Object.entries(record.data).forEach(([k, v]) => push(k, v))
  const keys = [...new Set(record.rows.flatMap((r) => Object.keys(r)))]
  keys.forEach((k) => push(k, JSON.stringify(record.rows.map((r) => r[k] ?? null))))
  return out
}

/** 表24 接口 24 的响应结构：按字段返回，便于前端与统计侧消费 */
export function recordDataOf(record: FormRecord): Record<string, unknown> {
  const head: Record<string, FieldValue> = {}
  Object.entries(record.data).forEach(([k, v]) => {
    head[k] = v
  })
  const rows = record.rows.map((r) => ({ ...r }))
  return { recordId: record.recordId, head, rows, flat: toRecordData(record) }
}

/* --------------------------------------------------- 宽表列定义 */

export interface WideColumn {
  key: string
  label: string
  fieldType: FieldType
  /** 差异规则改名导致的多个口径名 */
  aliases: string[]
  /** 该列适用的单位；为全部下发单位时 allOrgs = true（3.8 表头标注） */
  appliesTo: ID[]
  allOrgs: boolean
  /** 7.3 模板当前版本已删除该字段 */
  deprecated: boolean
  scope: 'header' | 'detail'
}

export interface WideRow {
  orgId: ID
  orgName: string
  recordSeq: number
  rowNo: number
  status: string
  values: Record<string, FieldValue>
}

export interface WideTable {
  columns: WideColumn[]
  rows: WideRow[]
}

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  submitted: '待审核',
  reject: '已驳回',
  pass: '已归档',
}

export const statusText = (s: string) => STATUS_TEXT[s] ?? '未填报'

/** 汇总视图使用当前登录人（业务部门管理员）的权限口径逐单位合并 Schema */
export function orgSchemas(task: FormTask, viewer: SysUser, orgIds: ID[]): Map<ID, FormSchema> {
  const m = new Map<ID, FormSchema>()
  orgIds.forEach((orgId) => {
    m.set(orgId, resolveSchema({ user: viewer, templateId: task.templateId, version: task.templateVersion, orgId, taskId: task.taskId, taskName: task.taskName }))
  })
  return m
}

export function buildWideTable(task: FormTask, viewer: SysUser, orgIds: ID[]): WideTable {
  const schemas = orgSchemas(task, viewer, orgIds)
  const currentVersion = db.form_template.find((t) => t.templateId === task.templateId)?.version ?? task.templateVersion

  // 列顺序：按各字段 sort 升序取并集（3.8 列对应模板字段，顺序与模板一致）
  const byKey = new Map<string, WideColumn>()
  orgIds.forEach((orgId) => {
    const s = schemas.get(orgId)
    if (!s) return
    s.fields.forEach((f) => {
      const exist = byKey.get(f.fieldKey)
      if (exist) {
        if (!exist.appliesTo.includes(orgId)) exist.appliesTo.push(orgId)
        if (!exist.aliases.includes(f.fieldLabel)) exist.aliases.push(f.fieldLabel)
        return
      }
      byKey.set(f.fieldKey, {
        key: f.fieldKey,
        label: f.fieldLabel,
        fieldType: f.fieldType,
        aliases: [f.fieldLabel],
        appliesTo: [orgId],
        allOrgs: false,
        deprecated: !db.form_field.some((x) => x.templateId === task.templateId && x.fieldKey === f.fieldKey && x.version === currentVersion && x.delFlag === 0),
        scope: f.config.scope === 'detail' ? 'detail' : 'header',
      })
    })
  })

  const columns = [...byKey.values()]
  // 保留 Schema 顺序：用首个出现该列的单位顺序 + sort 排序
  const order = new Map<string, number>()
  orgIds.forEach((orgId) => {
    schemas.get(orgId)?.fields.forEach((f, idx) => {
      if (!order.has(f.fieldKey)) order.set(f.fieldKey, f.sort + idx * 0.001 + (f.config.scope === 'detail' ? 1000 : 0))
    })
  })
  columns.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
  columns.forEach((c) => {
    c.allOrgs = c.appliesTo.length === orgIds.length
  })

  const rows: WideRow[] = []
  orgIds.forEach((orgId) => {
    const records = db.form_record.filter((r) => r.taskId === task.taskId && r.orgId === orgId && r.delFlag === 0).sort((a, b) => a.seq - b.seq)
    if (!records.length) {
      rows.push({ orgId, orgName: orgById(orgId)?.orgName ?? orgId, recordSeq: 0, rowNo: 0, status: '未填报', values: {} })
      return
    }
    records.forEach((rec) => {
      const detailCols = columns.filter((c) => c.scope === 'detail').map((c) => c.key)
      const lineCount = detailCols.length ? Math.max(rec.rows.length, 1) : 1
      for (let i = 0; i < lineCount; i += 1) {
        const values: Record<string, FieldValue> = {}
        columns.forEach((c) => {
          if (c.scope === 'detail') {
            const raw = rec.rows[i]?.[c.key]
            values[c.key] = formatCell(c, raw, rec, c.key)
          } else {
            values[c.key] = formatCell(c, rec.data[c.key] ?? null, rec, c.key)
          }
        })
        rows.push({
          orgId,
          orgName: orgById(orgId)?.orgName ?? orgId,
          recordSeq: rec.seq,
          rowNo: i + 1,
          status: statusText(rec.recordStatus),
          values,
        })
      }
    })
  })

  return { columns, rows }
}

function formatCell(c: WideColumn, raw: FieldValue, rec: FormRecord, fieldKey: string): FieldValue {
  if (c.fieldType === 'upload') {
    const list = db.form_attachment.filter((a) => a.recordId === rec.recordId && a.fieldKey === fieldKey && a.delFlag === 0)
    return list.length ? `${list.length}个：${list.map((a) => a.fileName).join('、')}` : ''
  }
  if (isBlank(raw)) return ''
  const s = String(raw)
  const optLabel = (v: string) => {
    const cfg = db.form_field.find((f) => f.templateId === rec.templateId && f.fieldKey === fieldKey)
    return cfg?.fieldConfig.options?.find((o) => o.value === v)?.label ?? v
  }
  if (c.fieldType === 'checkbox') return s.split(',').filter(Boolean).map(optLabel).join('、')
  if (c.fieldType === 'select' || c.fieldType === 'radio') return optLabel(s)
  return raw
}

/* ------------------------------------------------------ 3.8 进度统计 */

export interface ProgressRow {
  orgId: ID
  orgName: string
  orgCode: string
  status: string
  recordCount: number
  planTotal: number
  finishTotal: number
  rate: number
  lastUpdate: string
  reporter: string
}

export interface ProgressSummary {
  /** 应填报单位数 */
  expected: number
  submitted: number
  passed: number
  rejected: number
  missing: number
  draft: number
  rows: ProgressRow[]
}

/** 3.8 其四：填报进度看板。进度口径不随字段权限变化，viewer 仅为与宽表构建保持同一调用形态 */
export function buildProgress(task: FormTask, _viewer: SysUser, orgIds: ID[]): ProgressSummary {
  const rows: ProgressRow[] = orgIds.map((orgId) => {
    const records = db.form_record.filter((r) => r.taskId === task.taskId && r.orgId === orgId && r.delFlag === 0)
    const head = records[0]
    const sum = (key: string) =>
      records.reduce((acc, r) => acc + r.rows.reduce((a, row) => a + (Number(row[key]) || 0), 0), 0)
    const planTotal = sum('planNum')
    const finishTotal = sum('finishNum')
    const status = records.length
      ? records.some((r) => r.recordStatus === 'draft')
        ? '草稿'
        : records.some((r) => r.recordStatus === 'submitted')
          ? '待审核'
          : records.some((r) => r.recordStatus === 'reject')
            ? '已驳回'
            : '已归档'
      : '未填报'
    return {
      orgId,
      orgName: orgById(orgId)?.orgName ?? orgId,
      orgCode: orgById(orgId)?.orgCode ?? '',
      status,
      recordCount: records.length,
      planTotal,
      finishTotal,
      rate: planTotal ? Math.round((finishTotal / planTotal) * 100) : 0,
      lastUpdate: head?.updateTime ?? '—',
      reporter: head ? (userById(head.userId)?.realName ?? '—') : '—',
    }
  })

  const of = (s: string) => rows.filter((r) => r.status === s).length
  return {
    expected: rows.length,
    submitted: of('待审核'),
    passed: of('已归档'),
    rejected: of('已驳回'),
    missing: of('未填报'),
    draft: of('草稿'),
    rows,
  }
}

/* --------------------------------------------------------- CSV 输出 */

function csvCell(v: FieldValue): string {
  let s = v === null || v === undefined ? '' : String(v)
  // 防 CSV 公式注入
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

const line = (cells: FieldValue[]) => cells.map(csvCell).join(',')
const stamp = nowStr

export function csvFromLines(lines: string[]): string {
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** 8.2 其三：导出文件包含水印与导出人信息 */
function headerLines(task: FormTask, viewer: SysUser, filterDesc: string): string[] {
  return [
    line([`任务：${task.taskName}`]),
    line([`模板版本：${task.templateVersion}（历史记录按此版本呈现，7.3）`]),
    line([`导出人：${viewer.realName} / ${orgById(viewer.orgId)?.orgName ?? ''} / ${stamp()}`]),
    line([`筛选条件：${filterDesc}`]),
    line([`水印：内部资料 · 仅限 ${orgById(task.publishOrgId)?.orgName ?? '集团'} 汇总使用`]),
    line([]),
  ]
}

export function buildProgressCsv(task: FormTask, viewer: SysUser, sum: ProgressSummary): string {
  const lines = headerLines(task, viewer, '全部下发单位')
  lines.push(line(['单位编码', '子单位', '填报状态', '记录数', '计划合计', '完成合计', '完成率(%)', '最近更新时间', '填报人']))
  sum.rows.forEach((r) => lines.push(line([r.orgCode, r.orgName, r.status, r.recordCount, r.planTotal, r.finishTotal, r.rate, r.lastUpdate, r.reporter])))
  lines.push(line([]))
  lines.push(line([`应填报 ${sum.expected} · 已提交待审核 ${sum.submitted} · 审核通过 ${sum.passed} · 已驳回 ${sum.rejected} · 草稿 ${sum.draft} · 未填报 ${sum.missing}`]))
  lines.push(line([`导出时间：${stamp()}`]))
  return csvFromLines(lines)
}

export function buildWideCsv(task: FormTask, viewer: SysUser, table: WideTable, filterDesc: string): string {
  const lines = headerLines(task, viewer, filterDesc)
  const head = ['单位', '记录序号', '行号', '填报状态', ...table.columns.map((c) => {
    const alias = c.aliases.length > 1 ? `〔口径：${c.aliases.join(' / ')}〕` : ''
    const applies = c.allOrgs ? '' : `〔适用：${c.appliesTo.map((o) => orgById(o)?.orgName ?? o).join('、')}〕`
    const dep = c.deprecated ? '〔已停用字段〕' : ''
    return `${c.label}${alias}${applies}${dep}`
  })]
  lines.push(line(head))
  table.rows.forEach((r) => {
    lines.push(line([r.orgName, r.recordSeq || '', r.rowNo || '', r.status, ...table.columns.map((c) => r.values[c.key] ?? '')]))
  })
  lines.push(line([]))
  lines.push(line([`导出时间：${stamp()}　共 ${table.rows.length} 行　列数 ${table.columns.length}`]))
  return csvFromLines(lines)
}

/** 供接口层复用：字段权限行类型（保存时校验用） */
export type PermRow = FormFieldPermission
