/**
 * 5.3.1 获取表单 Schema —— 对应设计书 7.1 表单合并算法 与 7.2 权限裁决算法。
 * 处理顺序：加载任务绑定版本的模板字段 → 加载本单位差异规则 → 合并生成字段列表 → 逐字段裁决权限 → 输出 Schema。
 * 合并过程不修改基础模板数据（7.1），保证其他单位视图不受影响。
 */
import { db, fieldsOf, orgById, rolesOf } from './db'
import { ApiError, ERR } from './errors'
import { SYSTEM_VALUES } from './seed'
import { fmtDate } from './time'
import type {
  FieldConfig,
  FieldType,
  FormField,
  FormFieldPermission,
  FormSchema,
  FormTask,
  ID,
  PermType,
  RoleCode,
  SchemaField,
  SchemaTraceStep,
  SysUser,
  TargetType,
} from './types'

export const PERM_LABEL: Record<PermType, string> = { hidden: '隐藏', read: '只读', edit: '可编辑' }

export const ROLE_LABEL: Record<RoleCode, string> = {
  sys_admin: '系统管理员',
  template_admin: '表单管理员',
  biz_admin: '业务部门管理员',
  reporter: '填报员',
  auditor: '审核员',
}

/** 表6 字段类型中文名 */
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  datetime: '日期时间',
  radio: '单选',
  checkbox: '多选',
  select: '下拉选择',
  upload: '附件上传',
  richtext: '富文本',
}

export const TARGET_LABEL: Record<TargetType, string> = { 1: '角色', 2: '部门', 3: '子单位', 4: '用户' }

/** 7.2 对象优先级：用户级 > 部门级 > 角色级 > 子单位级 */
const TARGET_RANK: Record<TargetType, number> = { 4: 0, 2: 1, 1: 2, 3: 3 }

const PERM_LABEL_BY_TARGET_ROLE: Record<string, string> = {}
db.sys_role.forEach((r) => {
  PERM_LABEL_BY_TARGET_ROLE[r.roleId] = r.roleName
})

function targetName(rule: FormFieldPermission): string {
  switch (rule.targetType) {
    case 1:
      return PERM_LABEL_BY_TARGET_ROLE[rule.targetId] ?? rule.targetId
    case 2:
      return db.sys_dept.find((d) => d.deptId === rule.targetId)?.deptName ?? rule.targetId
    case 3:
      return orgById(rule.targetId)?.orgName ?? rule.targetId
    case 4:
      return db.sys_user.find((u) => u.userId === rule.targetId)?.realName ?? rule.targetId
  }
}

function matchTarget(rule: FormFieldPermission, user: SysUser): boolean {
  switch (rule.targetType) {
    case 1: {
      const role = db.sys_role.find((r) => r.roleId === rule.targetId)
      return role ? rolesOf(user).includes(role.roleCode) : false
    }
    case 2:
      return rule.targetId === user.deptId
    case 3:
      return rule.targetId === user.orgId
    case 4:
      return rule.targetId === user.userId
  }
}

/* ------------------------------------------------------- 7.1 合并算法 */

/**
 * 按版本加载基础字段并按 fieldKey 建立索引 → 加载本单位差异规则按 fieldKey 归并 →
 * 按差异类型执行隐藏、覆盖属性与新增 → 按 sort 重排输出。
 */
export function mergeFields(templateId: ID, version: string, orgId: ID, trace: SchemaTraceStep[]): FormField[] {
  const base = fieldsOf(templateId, version)
  trace.push({ stage: 'base', detail: `加载模板 ${templateId} 版本 ${version} 的基础字段 ${base.length} 个` })

  // 3.3 同一子单位对同一字段的多条规则以最后保存的规则为准
  const raw = db.form_org_diff.filter((d) => d.templateId === templateId && d.orgId === orgId && d.delFlag === 0)
  const byKey = new Map<string, (typeof raw)[number]>()
  raw.forEach((d) => {
    const exist = byKey.get(d.fieldKey)
    if (exist) trace.push({ stage: 'diff', detail: `字段 ${d.fieldKey} 存在多条规则，按最后保存合并（覆盖 ${exist.diffId}）` })
    byKey.set(d.fieldKey, d)
  })

  const hidden = new Set<string>()
  let list = base
  let maxSort = base.reduce((m, f) => Math.max(m, f.sort), 0)

  byKey.forEach((rule) => {
    if (rule.diffType === 1) {
      if (!list.some((f) => f.fieldKey === rule.fieldKey)) {
        trace.push({ stage: 'diff', detail: `隐藏规则指向的字段 ${rule.fieldKey} 不存在，忽略` })
        return
      }
      hidden.add(rule.fieldKey)
      list = list.filter((f) => f.fieldKey !== rule.fieldKey)
      trace.push({ stage: 'diff', detail: `隐藏基础字段 ${rule.fieldKey}${rule.note ? `（${rule.note}）` : ''}` })
      return
    }
    if (rule.diffType === 2) {
      const idx = list.findIndex((f) => f.fieldKey === rule.fieldKey)
      if (idx < 0) {
        trace.push({ stage: 'diff', detail: `修改规则指向的字段 ${rule.fieldKey} 不存在，忽略` })
        return
      }
      const f = { ...list[idx]!, fieldConfig: { ...list[idx]!.fieldConfig } }
      const changes: string[] = []
      if (rule.fieldLabel) {
        f.fieldLabel = rule.fieldLabel
        changes.push(`展示名→${rule.fieldLabel}`)
      }
      if (rule.isRequired !== undefined) {
        f.isRequired = rule.isRequired
        changes.push(`必填→${rule.isRequired ? '是' : '否'}`)
      }
      if (rule.fieldConfig) {
        // 覆盖规则仅替换属性，保留原 fieldKey 与创建顺序（7.1）
        Object.assign(f.fieldConfig, rule.fieldConfig)
        if (rule.fieldConfig.options) changes.push(`选项范围→${rule.fieldConfig.options.length} 项`)
        if (rule.fieldConfig.maxLength !== undefined) changes.push(`长度→${rule.fieldConfig.maxLength}`)
      }
      list[idx] = f
      trace.push({ stage: 'diff', detail: `修改 ${rule.fieldKey} 属性：${changes.join('、') || '无'}${rule.note ? `（${rule.note}）` : ''}` })
      return
    }
    // 3.3 其三：新增独有字段，fieldKey 冲突时拒绝保存（此处兜底拒绝合并）
    if (list.some((f) => f.fieldKey === rule.fieldKey) || hidden.has(rule.fieldKey)) {
      throw new ApiError(ERR.DUP_DIFF_KEY, `差异新增字段标识冲突：${rule.fieldKey}`)
    }
    maxSort += 1
    const cfg: FieldConfig = { scope: rule.scope ?? 'detail', ...rule.fieldConfig }
    list = [
      ...list,
      {
        delFlag: 0,
        fieldId: `DF-${rule.diffId}`,
        templateId,
        fieldKey: rule.fieldKey,
        fieldLabel: rule.fieldLabel ?? rule.fieldKey,
        fieldType: rule.fieldType ?? 'text',
        fieldConfig: cfg,
        isRequired: rule.isRequired ?? 0,
        sort: rule.sort ?? maxSort,
        version,
      },
    ]
    trace.push({ stage: 'diff', detail: `新增本单位独有字段 ${rule.fieldKey}（${rule.fieldLabel ?? ''}）` })
  })

  // 按 sort 重排；同 sort 保持原顺序（Array.prototype.sort 在 V8 中稳定）
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.sort - b.f.sort || a.i - b.i)
    .map((x) => x.f)
}

/* ------------------------------------------------------ 7.2 权限裁决 */

export interface PermDecision {
  permType: PermType
  required: 0 | 1
  /** 采纳规则标识，用于裁决留痕 */
  hit?: string
  /** 全部命中规则描述 */
  matched: string[]
}

/**
 * 收集命中当前用户的全部规则 → 按对象优先级排序（用户、部门、角色、单位）→
 * hidden 命中即终止；否则采纳优先级最高的一条规则（3.4 场景三的部门级 edit 因此能覆盖角色级 read）；
 * 无规则时返回 edit（2.6）。
 */
export function decidePerm(
  fieldKey: string,
  user: SysUser,
  templateId: ID,
  /** 合并后的必填属性（差异规则可能已收紧） */
  mergedRequired: 0 | 1,
): PermDecision {
  const rules = db.form_field_permission.filter(
    (p) => p.templateId === templateId && p.fieldKey === fieldKey && p.delFlag === 0 && matchTarget(p, user),
  )
  rules.sort((a, b) => TARGET_RANK[a.targetType] - TARGET_RANK[b.targetType])
  const matched = rules.map((r) => `${TARGET_LABEL[r.targetType]}[${targetName(r)}]=${PERM_LABEL[r.permType]}`)

  // 7.2：隐藏最严格，任何优先级上命中即终止
  const picked = rules.find((r) => r.permType === 'hidden') ?? rules[0]
  // 系统赋值列由后端写入，除屏蔽外一律只读（8.2 后端二次校验的基础）
  const basePerm: PermType = picked ? picked.permType : 'edit'
  const permType: PermType = SYSTEM_VALUES[fieldKey] && basePerm !== 'hidden' ? 'read' : basePerm

  return {
    permType,
    // 6.3 渲染规则：hidden 不渲染、read 不参与必填校验，避免只读列卡住提交
    required: permType === 'edit' ? ((picked?.requiredOverride ?? mergedRequired) as 0 | 1) : 0,
    hit: picked ? `${TARGET_LABEL[picked.targetType]}[${targetName(picked)}]=${PERM_LABEL[picked.permType]}` : undefined,
    matched,
  }
}

/* --------------------------------------------------- Schema 输出（6.2） */

interface ResolveInput {
  user: SysUser
  templateId: ID
  version: string
  taskId?: ID
  taskName?: string
  /** 3.4 生效时点为表单加载时；overrideOrgId 用于配置端按任意单位预览 */
  orgId?: ID
}

export function resolveSchema(input: ResolveInput): FormSchema {
  const orgId = input.orgId ?? input.user.orgId
  const trace: SchemaTraceStep[] = []
  const merged = mergeFields(input.templateId, input.version, orgId, trace)

  const fields: SchemaField[] = []
  const hiddenKeys: string[] = []

  merged.forEach((f) => {
    const d = decidePerm(f.fieldKey, input.user, input.templateId, f.isRequired)
    const desc = `${f.fieldKey} → ${PERM_LABEL[d.permType]}${d.hit ? `（采纳 ${d.hit}）` : '（无规则，默认 edit）'}${d.matched.length > 1 ? `｜命中 ${d.matched.length} 条：${d.matched.join('，')}` : ''}`
    trace.push({ stage: 'permission', detail: desc })
    if (d.permType === 'hidden') {
      // 6.3 hidden：不创建组件、不占用布局位置
      hiddenKeys.push(f.fieldKey)
      return
    }
    const sys = SYSTEM_VALUES[f.fieldKey]
    fields.push({
      fieldKey: f.fieldKey,
      fieldLabel: f.fieldLabel,
      fieldType: f.fieldType,
      isRequired: sys ? 0 : d.required,
      sort: f.sort,
      permission: sys ? 'read' : d.permType,
      config: f.fieldConfig,
      origin: f.fieldId.startsWith('DF-') ? 'diff-add' : 'base',
      diffNote: f.fieldId.startsWith('DF-') ? '本单位独有字段' : undefined,
      systemValue: sys,
    })
  })

  fields.sort((a, b) => a.sort - b.sort)
  const head = fields.filter((f) => f.config.scope !== 'detail').length
  trace.push({
    stage: 'result',
    detail: `输出 Schema：单头 ${head} 项、明细 ${fields.length - head} 列、屏蔽 ${hiddenKeys.length} 个字段${hiddenKeys.length ? `（${hiddenKeys.join('、')}）` : ''}`,
  })

  return {
    taskId: input.taskId ?? '',
    taskName: input.taskName ?? '',
    templateVersion: input.version,
    fields,
    hiddenKeys,
    trace,
  }
}

/** 5.3.1 正式入口：任务 + 当前用户 → Schema（缓存键见 schemaCacheKey） */
export function buildSchemaFor(user: SysUser, task: FormTask): FormSchema {
  const tpl = db.form_template.find((t) => t.templateId === task.templateId)
  if (!tpl) throw new ApiError(ERR.NOT_FOUND, '模板不存在或已删除')
  return resolveSchema({
    user,
    templateId: task.templateId,
    // 7.3 任务发布时冻结版本，历史呈现按记录自身携带的版本
    version: task.templateVersion,
    taskId: task.taskId,
    taskName: task.taskName,
  })
}

/** 3.2 模板预览：任选子单位与用户预览表单呈现效果 */
export function previewSchema(user: SysUser, templateId: ID, version: string, orgId?: ID): FormSchema {
  const tpl = db.form_template.find((t) => t.templateId === templateId)
  if (!tpl) throw new ApiError(ERR.NOT_FOUND, '模板不存在或已删除')
  return resolveSchema({ user, templateId, version, taskName: `${tpl.templateName}（预览）`, orgId })
}

/** 5.3.1 缓存键：任务标识 + 单位标识 + 用户标识 */
export function schemaCacheKey(taskId: ID, orgId: ID, userId: ID, version: string): string {
  return `${taskId}__${orgId}__${userId}__${version}`
}

const schemaCache = new Map<string, { at: number; schema: FormSchema }>()
/** 缓存有效期 10 分钟（5.3.1） */
const CACHE_TTL = 10 * 60 * 1000

export function cachedBuildSchema(user: SysUser, task: FormTask): { schema: FormSchema; fromCache: boolean } {
  const key = schemaCacheKey(task.taskId, user.orgId, user.userId, task.templateVersion)
  const hit = schemaCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return { schema: hit.schema, fromCache: true }
  const schema = buildSchemaFor(user, task)
  schemaCache.set(key, { at: Date.now(), schema })
  return { schema, fromCache: false }
}

/** 7.2 规则变更时按模板维度批量失效缓存 */
export function invalidateSchema(templateId?: ID): void {
  if (!templateId) {
    schemaCache.clear()
    return
  }
  const ids = db.form_task.filter((t) => t.templateId === templateId).map((t) => t.taskId)
  ;[...schemaCache.keys()].forEach((k) => {
    if (ids.some((id) => k.startsWith(`${id}__`))) schemaCache.delete(k)
  })
}

/* --------------------------------------------------------- 视图辅助 */

export const headerFields = (s: FormSchema) => s.fields.filter((f) => f.config.scope !== 'detail')
export const detailFields = (s: FormSchema) => s.fields.filter((f) => f.config.scope === 'detail')
/** 6.3 渲染规则：只有 edit 且非系统赋值列可输入 */
export const isEditable = (f: SchemaField) => f.permission === 'edit' && !f.systemValue

export function systemValueOf(kind: string, ctx: { orgId: ID; userId: ID; deptId: ID; rowIndex: number }): string | number {
  switch (kind) {
    case 'seq':
      return ctx.rowIndex + 1
    case 'orgName':
      return orgById(ctx.orgId)?.orgName ?? ''
    case 'userName':
      return db.sys_user.find((u) => u.userId === ctx.userId)?.realName ?? ''
    case 'deptName':
      return db.sys_dept.find((d) => d.deptId === ctx.deptId)?.deptName ?? ''
    default:
      // 系统赋值日期取本地时区，toISOString 为 UTC 会在零点附近少一天
      return fmtDate(new Date())
  }
}
