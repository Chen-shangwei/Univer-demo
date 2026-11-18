/**
 * M3 扩面：把审核工作台 / 汇总看板所需的「列表读模型」在服务端组合好再返回，
 * 让前端视图不再回查本地 db.form_record / db.form_task 做 join。
 *
 * 只读组合，复用逻辑层 taskViewsFor / summaryView / canAuditNode，不改动业务判定本身。
 */
import { db, taskViewsFor, canAuditNode, orgById, userById, summaryView, orgTree, scopeOrgs, tickTasks, ApiError, ERR, previewSchema, mergeFields, decidePerm, OPER_TYPE, hasRole, exportJobs, buildWideCsv, buildProgressCsv } from './context'
import type { ID, OrgNode, SummaryFilter, SysDept, SysOrg, SysRole, SysUser, TaskView, FormTask, FormTemplate, FormField, TemplateVersion, FormSchema, PermType } from './context'

/** 审核待办行：TaskView + 定位到待审记录的 recordId / submitTime（前端「审核」按钮要用） */
export interface AuditTodoRow extends TaskView {
  recordId: ID | null
  submitTime: string
}

/** 全部在审 / 已办记录行：脱离本地 db 的最小可渲染集 */
export interface AuditRecordRow {
  recordId: ID
  taskId: ID
  taskName: string
  orgId: ID
  orgName: string
  recordStatus: string
  nodeName: string
  submitCount: number
  submitTime: string
  /** 该记录是否停在「本人负责节点」的待审核状态（前端「仅看我负责节点」筛选用） */
  mineTodo: boolean
}

export interface AuditListResult {
  todos: AuditTodoRow[]
  records: AuditRecordRow[]
  logs: { logId: string; operType: string; content: string; operTime: string; orgName: string }[]
}

/** 接口 22 扩展：审核工作台一次返回「我的待办 + 全部记录 + 近期审核留痕」 */
export function auditList(user: SysUser): AuditListResult {
  const views = taskViewsFor(user)

  const todos: AuditTodoRow[] = views
    .filter((v) => v.todo)
    .map((v) => {
      const rec = db.form_record.find(
        (r) => r.taskId === v.taskId && r.orgId === v.orgId && r.recordStatus === 'submitted' && r.currentNode === v.currentNode && r.delFlag === 0,
      )
      return { ...v, recordId: rec?.recordId ?? null, submitTime: rec?.submitTime ?? '' }
    })

  const records: AuditRecordRow[] = db.form_record
    .filter((r) => r.delFlag === 0 && r.recordStatus !== 'draft')
    .map((r) => {
      const task = db.form_task.find((t) => t.taskId === r.taskId)
      const mineTodo = !!task && r.recordStatus === 'submitted' && canAuditNode(user, task, r.currentNode)
      const nodeName = !task
        ? '—'
        : r.recordStatus !== 'submitted'
          ? task.auditType === 0
            ? '免审核'
            : '已结束'
          : task.auditNodes.find((n) => n.seq === r.currentNode)?.nodeName ?? `节点 ${r.currentNode}`
      return {
        recordId: r.recordId,
        taskId: r.taskId,
        taskName: task?.taskName ?? r.taskId,
        orgId: r.orgId,
        orgName: orgById(r.orgId)?.orgName ?? r.orgId,
        recordStatus: r.recordStatus,
        nodeName,
        submitCount: r.submitCount,
        submitTime: r.submitTime ?? '',
        mineTodo,
      }
    })
    .sort((a, b) => b.submitTime.localeCompare(a.submitTime))

  const logs = db.form_oper_log
    .filter((l) => l.operType === '审核操作' || l.operType === '管理员撤回')
    .slice(0, 8)
    .map((l) => ({
      logId: l.logId,
      operType: l.operType,
      content: l.content,
      operTime: l.operTime,
      orgName: orgById(l.orgId)?.orgName ?? '',
    }))

  return { todos, records, logs }
}

/** 供 FillListView / 汇总筛选复用的任务视图列表 */
export function myTaskViews(user: SysUser): TaskView[] {
  return taskViewsFor(user)
}

/** 看板用户信息（前端展示「以谁的字段权限口径」） */
export function reporterName(user: SysUser): string {
  return userById(user.userId)?.realName ?? user.realName
}

export interface SummaryBoardResult {
  task: ReturnType<typeof summaryView>['task']
  orgIds: ID[]
  progress: ReturnType<typeof summaryView>['progress']
  columns: ReturnType<typeof summaryView>['table']['columns']
  total: number
  pages: number
  list: ReturnType<typeof summaryView>['table']['rows']
}

/** 接口 23/24 合并：一次返回宽表分页 + 进度看板 + 列口径 + 任务信息（对齐前端 api.summary.page 形状） */
export function summaryBoard(user: SysUser, taskId: ID, filter: SummaryFilter, pageNum = 1, pageSize = 20): SummaryBoardResult {
  const view = summaryView(user, taskId, filter)
  const rows = view.table.rows
  const size = Math.min(Math.max(pageSize, 1), 200)
  const page = Math.max(pageNum, 1)
  return {
    task: view.task,
    orgIds: view.orgIds,
    progress: view.progress,
    columns: view.table.columns,
    total: rows.length,
    pages: Math.ceil(rows.length / size) || 1,
    list: rows.slice((page - 1) * size, (page - 1) * size + size),
  }
}

/* ============================================================ 3.1 组织与用户管理读模型 */

/** 去掉密码摘要后的用户投影 */
function safeUserProfile(u: SysUser) {
  const { password: _pwd, ...rest } = u
  return rest
}

export interface OrgBoardResult {
  tree: OrgNode[]
  orgs: SysOrg[]
  depts: SysDept[]
  users: ReturnType<typeof safeUserProfile>[]
  roles: SysRole[]
}

/** 组织管理一次返回：单位树 + 扁平单位/部门/用户/角色，前端不再回查本地 db */
export function orgBoard(): OrgBoardResult {
  return {
    tree: orgTree(),
    orgs: db.sys_org.filter((o) => o.delFlag === 0),
    depts: db.sys_dept.filter((d) => d.delFlag === 0),
    users: db.sys_user.filter((u) => u.delFlag === 0).map(safeUserProfile),
    roles: db.sys_role.filter((r) => r.delFlag === 0),
  }
}

/** 接口 3 GET /api/user/page —— 用户分页检索（与 api.org.userPage 同口径） */
export function userPage(p: { pageNum?: number; pageSize?: number; orgId?: ID; keyword?: string }) {
  const filtered = db.sys_user.filter(
    (u) =>
      u.delFlag === 0 &&
      (!p.orgId || u.orgId === p.orgId) &&
      (!p.keyword || u.realName.includes(p.keyword) || u.username.includes(p.keyword)),
  )
  const size = Math.min(Math.max(p.pageSize ?? 20, 1), 200)
  const page = Math.max(p.pageNum ?? 1, 1)
  return {
    total: filtered.length,
    pages: Math.ceil(filtered.length / size) || 1,
    list: filtered.map(safeUserProfile).slice((page - 1) * size, (page - 1) * size + size),
  }
}

/* ============================================================ 3.5 任务管理读模型 */

/** 任务台账行：FormTask + 模板名 + 下发范围 + 记录统计，前端直接渲染不再 join 本地 db */
export interface TaskBoardRow {
  taskId: ID
  templateId: ID
  templateVersion: string
  templateName: string
  taskName: string
  publishOrgId: ID
  startTime: string
  endTime: string
  auditType: number
  auditNodes: FormTask['auditNodes']
  status: number
  singleRecordPerOrg: boolean
  remindDays?: number
  createdBy?: string
  createdByName?: string
  createTime?: string
  publishOrgName: string
  scopeOrgIds: ID[]
  scopeOrgNames: string[]
  recordCount: number
  submittedCount: number
  reportedOrgCount: number
}

export interface TaskBoardResult {
  tasks: TaskBoardRow[]
  templates: { templateId: ID; templateName: string; version: string }[]
  orgs: SysOrg[]
  roles: SysRole[]
  users: { userId: ID; realName: string }[]
  reminds: string[]
}

/** 任务台账一次返回：读时先按 9.2 推进状态，再带出模板/单位/角色/用户字典与临期催办 */
export function taskBoard(): TaskBoardResult {
  const { reminds } = tickTasks()
  const tasks: TaskBoardRow[] = db.form_task
    .filter((t) => t.delFlag === 0)
    .map((t) => {
      const scopes = scopeOrgs(t.taskId)
      const recs = db.form_record.filter((r) => r.taskId === t.taskId && r.delFlag === 0)
      return {
        taskId: t.taskId,
        templateId: t.templateId,
        templateVersion: t.templateVersion,
        templateName: db.form_template.find((x) => x.templateId === t.templateId)?.templateName ?? t.templateId,
        taskName: t.taskName,
        publishOrgId: t.publishOrgId,
        startTime: t.startTime,
        endTime: t.endTime,
        auditType: t.auditType,
        auditNodes: t.auditNodes.map((n) => ({ ...n })),
        status: t.status,
        singleRecordPerOrg: t.singleRecordPerOrg,
        remindDays: t.remindDays,
        createdBy: t.createdBy,
        createdByName: t.createdBy ? userById(t.createdBy)?.realName ?? t.createdBy : undefined,
        createTime: t.createTime,
        publishOrgName: orgById(t.publishOrgId)?.orgName ?? t.publishOrgId,
        scopeOrgIds: scopes.map((o) => o.orgId),
        scopeOrgNames: scopes.map((o) => o.orgName),
        recordCount: recs.length,
        submittedCount: recs.filter((r) => r.recordStatus !== 'draft').length,
        reportedOrgCount: new Set(recs.map((r) => r.orgId)).size,
      }
    })
  return {
    tasks,
    templates: db.form_template
      .filter((t) => t.delFlag === 0 && t.status === 1)
      .map((t) => ({ templateId: t.templateId, templateName: t.templateName, version: t.version })),
    orgs: db.sys_org.filter((o) => o.orgLevel >= 2 && o.status === 1 && o.delFlag === 0),
    roles: db.sys_role.filter((r) => r.status === 1 && r.delFlag === 0),
    users: db.sys_user.filter((u) => u.delFlag === 0 && u.status === 1).map((u) => ({ userId: u.userId, realName: u.realName })),
    reminds,
  }
}

/* ==================================================== 3.2/3.3/3.4 模板配置读模型 */

/** 模板台账行：FormTemplate + 当前版本字段数 + 关联任务数（前端不再回查本地 db） */
export interface TemplateBoardRow extends FormTemplate {
  fieldCount: number
  taskCount: number
}

export interface TemplateBoardResult {
  templates: TemplateBoardRow[]
  bizTypes: { dictCode: string; label: string; value: string; sort: number }[]
  orgs: SysOrg[]
  subOrgs: SysOrg[]
  users: { userId: ID; realName: string; username: string; orgId: ID }[]
  roles: SysRole[]
  depts: SysDept[]
  operLogs: { logId: ID; operType: string; content: string; operTime: string; userName: string }[]
}

/** 模板三件套共享字典：台账行 + 业务分类 + 单位/用户/角色/部门 + 最近模板变更 */
export function templateBoard(): TemplateBoardResult {
  const templates: TemplateBoardRow[] = db.form_template
    .filter((t) => t.delFlag === 0)
    .map((t) => ({
      ...t,
      fieldCount: db.form_field.filter((f) => f.templateId === t.templateId && f.version === t.version && f.delFlag === 0).length,
      taskCount: db.form_task.filter((tk) => tk.templateId === t.templateId && tk.delFlag === 0).length,
    }))
  return {
    templates,
    bizTypes: db.sys_dict.filter((d) => d.dictCode === 'BIZ_TYPE').sort((a, b) => a.sort - b.sort),
    orgs: db.sys_org.filter((o) => o.delFlag === 0),
    subOrgs: db.sys_org.filter((o) => o.orgLevel >= 2 && o.delFlag === 0),
    users: db.sys_user.filter((u) => u.delFlag === 0).map((u) => ({ userId: u.userId, realName: u.realName, username: u.username, orgId: u.orgId })),
    roles: db.sys_role.filter((r) => r.delFlag === 0),
    depts: db.sys_dept.filter((d) => d.delFlag === 0),
    operLogs: db.form_oper_log
      .filter((l) => l.bizType === 'template')
      .slice(0, 6)
      .map((l) => ({ logId: l.logId, operType: l.operType, content: l.content, operTime: l.operTime, userName: userById(l.userId)?.realName ?? l.userId })),
  }
}

export interface TemplateDetailResult {
  template: FormTemplate
  fields: FormField[]
  versions: TemplateVersion[]
  createOrgName: string
}

/** 接口 6：模板详情（当前版本字段 + 历史版本快照 + 创建单位名） */
export function templateDetail(templateId: ID, version?: string): TemplateDetailResult {
  const t = db.form_template.find((x) => x.templateId === templateId && x.delFlag === 0)
  if (!t) throw new ApiError(ERR.NOT_FOUND, '模板不存在')
  const v = version ?? t.version
  return {
    template: t,
    fields: db.form_field.filter((f) => f.templateId === templateId && f.version === v && f.delFlag === 0).sort((a, b) => a.sort - b.sort),
    versions: db.form_template_version.filter((x) => x.templateId === templateId),
    createOrgName: orgById(t.createOrgId)?.orgName ?? t.createOrgId,
  }
}

/** 3.4 可选字段：当前版本基础字段 + 各子单位新增的独有字段标识 */
export function permFieldKeys(templateId: ID): { key: string; label: string }[] {
  const tpl = db.form_template.find((x) => x.templateId === templateId && x.delFlag === 0)
  if (!tpl) return []
  const base = db.form_field
    .filter((f) => f.templateId === templateId && f.version === tpl.version && f.delFlag === 0)
    .map((f) => ({ key: f.fieldKey, label: f.fieldLabel }))
  const add = db.form_org_diff
    .filter((d) => d.templateId === templateId && d.diffType === 3 && d.delFlag === 0)
    .map((d) => ({ key: d.fieldKey, label: `${d.fieldLabel ?? d.fieldKey}（独有字段）` }))
  const seen = new Set<string>()
  return [...base, ...add].filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
}

/** 裁决预览行：7.2 伪代码的表格化呈现（Schema 字段 + 采纳/命中规则） */
export interface PermDecisionRow {
  fieldKey: string
  label: string
  perm: PermType
  required: number
  hit: string
  matched: string[]
  systemValue?: string
  scope: string
}

export interface PermDecisionResult {
  schema: FormSchema
  rows: PermDecisionRow[]
}

/** 3.4 裁决预览：服务端跑 previewSchema + decidePerm，前端不再本地裁决 */
export function permDecision(templateId: ID, orgId: ID, viewerUserId: ID): PermDecisionResult {
  const tpl = db.form_template.find((x) => x.templateId === templateId && x.delFlag === 0)
  if (!tpl) throw new ApiError(ERR.NOT_FOUND, '模板不存在或已删除')
  const u = db.sys_user.find((x) => x.userId === viewerUserId)
  if (!u) throw new ApiError(ERR.NOT_FOUND, '预览用户不存在')
  const schema = previewSchema(u, templateId, tpl.version, orgId)
  const rows: PermDecisionRow[] = schema.fields.map((f) => {
    const d = decidePerm(f.fieldKey, u, templateId, f.isRequired)
    return {
      fieldKey: f.fieldKey,
      label: f.fieldLabel,
      perm: f.permission,
      required: f.isRequired,
      hit: d.hit ?? '无规则，默认 edit',
      matched: d.matched,
      systemValue: f.systemValue,
      scope: f.config.scope === 'detail' ? '明细' : '单头',
    }
  })
  return { schema, rows }
}

/** 3.3 合并结果：base 基础字段 + 应用差异规则后的 merged 字段（7.1 自证） */
export interface DiffMergedResult {
  merged: FormField[]
  base: FormField[]
}

export function diffMerged(templateId: ID, orgId: ID): DiffMergedResult {
  const tpl = db.form_template.find((x) => x.templateId === templateId && x.delFlag === 0)
  if (!tpl) return { merged: [], base: [] }
  const base = db.form_field
    .filter((f) => f.templateId === templateId && f.version === tpl.version && f.delFlag === 0)
    .sort((a, b) => a.sort - b.sort)
  const merged = mergeFields(templateId, tpl.version, orgId, [])
  return { merged, base }
}

/* ==================================================== 3.10 操作日志检索读模型 */

/** 日志检索的字典与埋点覆盖：操作人下拉 + 全部操作类型 + 每类型已记录条数 */
export function logBoard(): {
  users: { userId: ID; realName: string; username: string }[]
  operTypes: string[]
  points: { type: string; count: number }[]
} {
  const operTypes = Object.values(OPER_TYPE) as string[]
  return {
    users: db.sys_user.filter((u) => u.delFlag === 0).map((u) => ({ userId: u.userId, realName: u.realName, username: u.username })),
    operTypes,
    points: operTypes.map((t) => ({ type: t, count: db.form_oper_log.filter((l) => l.operType === t).length })),
  }
}

/** 3.10：日志只追加不修改，仅按条件分页检索，服务端预 join 操作人姓名与单位名 */
export interface LogPageParams {
  pageNum: number
  pageSize: number
  operType?: string
  userId?: ID
  bizId?: ID
  from?: string
  to?: string
  keyword?: string
}

export interface LogPageRow {
  logId: ID
  userId: ID
  orgId: ID
  operType: string
  bizId: ID
  bizType: string
  content: string
  ip: string
  result: 0 | 1
  operTime: string
  userName: string
  orgName: string
}

export function logPage(p: LogPageParams): { total: number; pages: number; list: LogPageRow[] } {
  const all = db.form_oper_log.filter(
    (l) =>
      (!p.operType || l.operType === p.operType) &&
      (!p.userId || l.userId === p.userId) &&
      (!p.bizId || l.bizId === p.bizId) &&
      (!p.keyword || l.content.includes(p.keyword)) &&
      (!p.from || l.operTime >= p.from) &&
      (!p.to || l.operTime <= p.to),
  )
  const size = Math.min(Math.max(p.pageSize || 20, 1), 200)
  const page = Math.max(p.pageNum || 1, 1)
  const list: LogPageRow[] = all.slice((page - 1) * size, (page - 1) * size + size).map((l) => ({
    logId: l.logId,
    userId: l.userId,
    orgId: l.orgId,
    operType: l.operType,
    bizId: l.bizId,
    bizType: l.bizType,
    content: l.content,
    ip: l.ip,
    result: l.result,
    operTime: l.operTime,
    userName: userById(l.userId)?.realName ?? l.userId,
    orgName: orgById(l.orgId)?.orgName ?? l.orgId,
  }))
  return { total: all.length, pages: Math.ceil(all.length / size) || 1, list }
}

/* ==================================================== 3.8 数据导出读模型 */

/** 导出作业投影：去掉内联 CSV 正文，只回状态与凭证有效期供界面轮询与下载入口 */
export interface ExportJobRow {
  jobId: ID
  taskId: ID
  userId: ID
  createdByName: string
  filters: string
  status: 'running' | 'done' | 'failed'
  fileName?: string
  rows?: number
  createTime: string
  finishTime?: string
  expireMinutes: number
  /** 完成后签发的下载凭证过期时刻（毫秒）；未完成为 0 */
  expireAt: number
}

export function exportBoard(user: SysUser): { canExport: boolean; jobs: ExportJobRow[] } {
  const jobs: ExportJobRow[] = exportJobs(user).map((j) => ({
    jobId: j.jobId,
    taskId: j.taskId,
    userId: j.userId,
    createdByName: userById(j.userId)?.realName ?? j.userId,
    filters: j.filters,
    status: j.status,
    fileName: j.fileName,
    rows: j.rows,
    createTime: j.createTime,
    finishTime: j.finishTime,
    expireMinutes: j.expireMinutes,
    expireAt: j.download?.expireAt ?? 0,
  }))
  return { canExport: hasRole(user, 'biz_admin'), jobs }
}

/** 立即导出（小数据量同步）：服务端直接产出 CSV 正文，交给路由以文件流回传 */
export function buildExportCsv(
  user: SysUser,
  taskId: ID,
  filter: SummaryFilter,
  kind: 'detail' | 'progress',
): { fileName: string; content: string } {
  const view = summaryView(user, taskId, filter)
  const task = view.task
  if (kind === 'progress') {
    return { fileName: `${task.taskName}_进度.csv`, content: buildProgressCsv(task, user, view.progress) }
  }
  const filterDesc = `单位：${view.orgIds.map((o) => orgById(o)?.orgName).join('、') || '全部'}`
  return { fileName: `${task.taskName}_明细.csv`, content: buildWideCsv(task, user, view.table, filterDesc) }
}
