/**
 * M3 前端联调：把「登录 + 工作台」这两个已在后台验证过的接口，从本地 localStorage 直连
 * 切换为真正的 HTTP 调用。返回体沿用 5.1 的 { code, msg, data } 结构（ApiResult），
 * 因此视图里既有的 must()/toast() 用法保持不变，只是调用点要 await。
 *
 * 走 Vite dev proxy：请求打到同源 `/api/**`，由 dev server 转发到 Fastify（默认 8787）。
 */
import { adoptSession, sessionToken } from './session'
import { db } from './db'
import { ERR_MSG } from './errors'
import type { FillContext, SummaryFilter, WriteResult } from './flow'
import type { ValidateError } from './validate'
import type { ApiResult, FieldValue, FormAttachment, FormField, FormFieldPermission, FormOrgDiff, FormSchema, FormTask, FormTemplate, DiffType, ID, PageResult, PermType, SysDept, SysOrg, SysRole, SysUser, TargetType, TemplateVersion } from './types'
import type { OrgNode } from './service'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

/** 统一请求：附带 Bearer 令牌，解析后台信封；网络/解析异常归一化为 500 信封 */
async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
  const token = sessionToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const env = (await res.json()) as ApiResult<T>
    // 后台已统一 { code, msg, data }；直接透传，保持与本地 api 门面同构
    return { code: env.code, msg: env.msg ?? ERR_MSG[env.code] ?? '', data: env.data }
  } catch (e) {
    return { code: 500, msg: `无法连接后台（${API_BASE}）：${e instanceof Error ? e.message : String(e)}`, data: null as unknown as T }
  }
}

/** 带 Bearer 拉取二进制（附件下载）：成功返回 objectURL，失败归一为信封 */
async function requestBlob(path: string): Promise<ApiResult<{ url: string; fileName: string; expireAt: number }>> {
  const token = sessionToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers })
    if (!res.ok) {
      const env = (await res.json().catch(() => null)) as ApiResult<unknown> | null
      return { code: env?.code ?? res.status, msg: env?.msg ?? `下载失败（HTTP ${res.status}）`, data: null as never }
    }
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const m = /filename\*?="?([^";]+)"?/i.exec(disposition)
    const fileName = m ? decodeURIComponent(m[1]!) : 'file'
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    return { code: 200, msg: '成功', data: { url, fileName, expireAt: Date.now() + 5 * 60_000 } }
  } catch (e) {
    return { code: 500, msg: `无法连接后台（${API_BASE}）：${e instanceof Error ? e.message : String(e)}`, data: null as never }
  }
}

export interface RemoteLoginResult {
  token: string
  user: { userId: string; username: string; realName: string; orgId: string; deptId: string; mobile: string; status: number; roleIds: string[] }
  roles: string[]
}

/** 3.1 组织管理读模型（对齐 server/read-model.ts orgBoard） */
export interface RemoteOrgBoard {
  tree: OrgNode[]
  orgs: SysOrg[]
  depts: SysDept[]
  users: SysUser[]
  roles: SysRole[]
}

/** 3.5 任务台账行：FormTask + 后端预join 的模板名/下发范围/记录统计 */
export interface RemoteTaskRow extends FormTask {
  templateName: string
  publishOrgName: string
  createdByName?: string
  scopeOrgIds: ID[]
  scopeOrgNames: string[]
  recordCount: number
  submittedCount: number
  reportedOrgCount: number
}

/** 3.5 任务管理读模型（对齐 server/read-model.ts taskBoard） */
export interface RemoteTaskBoard {
  tasks: RemoteTaskRow[]
  templates: { templateId: ID; templateName: string; version: string }[]
  orgs: SysOrg[]
  roles: SysRole[]
  users: { userId: ID; realName: string }[]
  reminds: string[]
}

/** 任务创建入参（对齐 createTask） */
export interface RemoteTaskCreateInput {
  taskId?: ID
  taskName: string
  templateId: ID
  startTime: string
  endTime: string
  auditType: 0 | 1 | 2
  auditNodes: FormTask['auditNodes']
  singleRecordPerOrg: boolean
  orgIds: ID[]
  remindDays?: number
}

/** 3.2 模板台账行：FormTemplate + 后端预join 的字段数/任务数 */
export interface RemoteTemplateRow extends FormTemplate {
  fieldCount: number
  taskCount: number
}

/** 模板三件套共享字典（对齐 server/read-model.ts templateBoard） */
export interface RemoteTemplateBoard {
  templates: RemoteTemplateRow[]
  bizTypes: { dictCode: string; label: string; value: string; sort: number }[]
  orgs: SysOrg[]
  subOrgs: SysOrg[]
  users: { userId: ID; realName: string; username: string; orgId: ID }[]
  roles: SysRole[]
  depts: SysDept[]
  operLogs: { logId: ID; operType: string; content: string; operTime: string; userName: string }[]
}

/** 模板详情（对齐 server templateDetail） */
export interface RemoteTemplateDetail {
  template: FormTemplate
  fields: FormField[]
  versions: TemplateVersion[]
  createOrgName: string
}

/** 3.4 裁决预览行（对齐 server PermDecisionRow） */
export interface RemotePermDecisionRow {
  fieldKey: string
  label: string
  perm: PermType
  required: number
  hit: string
  matched: string[]
  systemValue?: string
  scope: string
}

export interface RemotePermDecision {
  schema: FormSchema
  rows: RemotePermDecisionRow[]
}

/** 字段保存入参（对齐 saveField 第二参） */
export type RemoteFieldInput = Partial<FormField> & { fieldKey: string; fieldLabel: string }
/** 权限规则保存入参（对齐 savePerm） */
export interface RemotePermInput {
  permId?: ID
  templateId: ID
  fieldKey: string
  targetType: TargetType
  targetId: ID
  permType: PermType
  requiredOverride?: 0 | 1
  note?: string
}
/** 差异规则保存入参（对齐 saveDiff） */
export interface RemoteDiffInput {
  diffId?: ID
  templateId: ID
  orgId: ID
  fieldKey: string
  diffType: DiffType
  fieldLabel?: string
  fieldType?: FormField['fieldType']
  fieldConfig?: FormField['fieldConfig']
  isRequired?: 0 | 1
  sort?: number
  scope?: 'header' | 'detail'
  note?: string
}

/** 3.10 日志检索字典（对齐 server logBoard） */
export interface RemoteLogBoard {
  users: { userId: ID; realName: string; username: string }[]
  operTypes: string[]
  points: { type: string; count: number }[]
}

/** 日志行：后端已 join 操作人姓名与单位名（对齐 server LogPageRow） */
export interface RemoteLogRow {
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

export interface RemoteLogPage {
  total: number
  pages: number
  list: RemoteLogRow[]
}

/** 导出作业行（对齐 server ExportJobRow，不含正文） */
export interface RemoteExportJob {
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
  expireAt: number
}

export interface RemoteExportBoard {
  canExport: boolean
  jobs: RemoteExportJob[]
}

/** 导出/汇总检索条件（query 形态，orgIds 为逗号串） */
export interface RemoteFilterQuery {
  orgIds?: string
  status?: string
  submitFrom?: string
  submitTo?: string
  keyword?: string
}

/** 把参数对象拼成 query string（跳过空值），供只读接口复用 */
function qs(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== null) usp.set(k, String(v))
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export const remote = {
  /** 接口 1：POST /api/auth/login —— 后台校验账号密码并签发令牌，成功后接管本地会话 */
  async login(username: string, password: string): Promise<ApiResult<RemoteLoginResult>> {
    const r = await request<RemoteLoginResult>('POST', '/auth/login', { username, password })
    if (r.code === 200 && r.data) {
      // 用后端返回的 userId 回查本地表拿到完整 SysUser，写入会话，令其余页面 current() 正常驱动
      const localUser = db.sys_user.find((u) => u.userId === r.data!.user.userId)
      if (localUser) adoptSession(localUser, r.data.token)
    }
    return r
  },

  /** 接口 30 / 6.1：GET /api/summary/workbench —— 工作台聚合数据来自后台真实逻辑层 */
  workbench(): Promise<ApiResult<Record<string, unknown>>> {
    return request<Record<string, unknown>>('GET', '/summary/workbench')
  },

  /** 接口 14：GET /api/task/list —— 任务列表（汇总下拉用） */
  taskList(): Promise<ApiResult<Record<string, unknown>[]>> {
    return request<Record<string, unknown>[]>('GET', '/task/list')
  },

  /** 接口 16：GET /api/task/my/list —— 我的填报任务视图（TaskView[]） */
  taskMyList(): Promise<ApiResult<Record<string, unknown>[]>> {
    return request<Record<string, unknown>[]>('GET', '/task/my/list')
  },

  /** 接口 15 辅助：GET /api/task/scopes —— 任务下发范围内单位 */
  taskScopes(taskId: string): Promise<ApiResult<{ orgId: string; orgName: string }[]>> {
    return request<{ orgId: string; orgName: string }[]>('GET', `/task/scopes${qs({ taskId })}`)
  },

  /** 接口 17：GET /api/form/load —— 进入填报：Schema + 载荷 + 只读判定 + 编辑锁（读取走后台） */
  formLoad(taskId: string, seq = 1, acquire = true): Promise<ApiResult<FillContext>> {
    return request<FillContext>('GET', `/form/load${qs({ taskId, seq, acquire: acquire ? undefined : 'false' })}`)
  },

  /** 接口 20：GET /api/record/detail —— 记录详情（按记录版本呈现 Schema，审核详情页读取用） */
  recordDetail(recordId: string): Promise<ApiResult<Record<string, any>>> {
    return request<Record<string, any>>('GET', `/record/detail${qs({ recordId })}`)
  },

  /** 接口 18：POST /api/record/draft —— 保存草稿（写后端 db） */
  saveDraft(taskId: string, seq: number, data: Record<string, FieldValue>, rows: Record<string, FieldValue>[], auto = false): Promise<ApiResult<WriteResult>> {
    return request<WriteResult>('POST', '/record/draft', { taskId, seq, data, rows, auto })
  },

  /** 接口 19：POST /api/record/submit —— 提交填报（四类校验后按审核配置流转） */
  submitReport(taskId: string, seq: number, data: Record<string, FieldValue>, rows: Record<string, FieldValue>[]): Promise<ApiResult<WriteResult>> {
    return request<WriteResult>('POST', '/record/submit', { taskId, seq, data, rows })
  },

  /** 6.4 校验：POST /api/form/validate —— 不入库，返回错误明细 */
  formValidate(taskId: string, seq: number, data: Record<string, FieldValue>, rows: Record<string, FieldValue>[]): Promise<ApiResult<ValidateError[]>> {
    return request<ValidateError[]>('POST', '/form/validate', { taskId, seq, data, rows })
  },

  /** 7.5：POST /api/record/heartbeat —— 续写会话锁，返回当前持锁人 realName（无人 null） */
  heartbeat(taskId: string): Promise<ApiResult<string | null>> {
    return request<string | null>('POST', '/record/heartbeat', { taskId })
  },

  /** 接口 21：POST /api/audit/operate —— 审核通过/驳回（写后端 db） */
  auditOperate(recordId: string, conclusion: 'pass' | 'reject', opinion: string): Promise<ApiResult<WriteResult>> {
    return request<WriteResult>('POST', '/audit/operate', { recordId, conclusion, opinion })
  },

  /** 3.9：GET /api/attachment/list —— 某字段附件清单 */
  attachmentList(recordId: string, fieldKey?: string): Promise<ApiResult<FormAttachment[]>> {
    return request<FormAttachment[]>('GET', `/attachment/list${qs({ recordId, fieldKey })}`)
  },

  /** 3.9：POST /api/attachment/upload —— 登记附件（blob 为小文件内联 dataURL） */
  attachmentUpload(
    recordId: string,
    fieldKey: string,
    file: { name: string; size: number; type: string },
    limit: { accept: string[]; maxSize: number; maxCount: number },
    blob?: string,
  ): Promise<ApiResult<FormAttachment>> {
    return request<FormAttachment>('POST', '/attachment/upload', { recordId, fieldKey, file, limit, blob })
  },

  /** 3.9：POST /api/attachment/remove —— 删除附件（仅标记） */
  attachmentRemove(attId: string, editable: boolean): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/attachment/remove', { attId, editable })
  },

  /** 3.9：GET /api/attachment/file —— 带令牌取回字节，前端转 objectURL（不暴露存储地址） */
  attachmentDownload(attId: string): Promise<ApiResult<{ url: string; fileName: string; expireAt: number }>> {
    return requestBlob(`/attachment/file${qs({ attId })}`)
  },

  /** 接口 22 扩展：GET /api/audit/list —— 审核工作台读模型 */
  auditList(): Promise<ApiResult<{ todos: Record<string, unknown>[]; records: Record<string, unknown>[]; logs: Record<string, unknown>[] }>> {
    return request('GET', '/audit/list')
  },

  /** 接口 22：POST /api/audit/revoke —— 管理员撤回 */
  auditRevoke(recordId: string, reason: string): Promise<ApiResult<Record<string, unknown>>> {
    return request<Record<string, unknown>>('POST', '/audit/revoke', { recordId, reason })
  },

  /** 接口 23/24 合并：GET /api/summary/board —— 汇总看板（宽表分页 + 进度 + 列 + 任务） */
  summaryBoard(params: {
    taskId: string
    orgIds?: string
    status?: string
    submitFrom?: string
    submitTo?: string
    keyword?: string
    pageNum?: number
    pageSize?: number
  }): Promise<ApiResult<Record<string, unknown>>> {
    return request<Record<string, unknown>>('GET', `/summary/board${qs(params as Record<string, string | number | undefined>)}`)
  },

  /* ---------------------------- 3.1 组织与用户管理 ---------------------------- */

  /** GET /api/org/board —— 单位树 + 扁平单位/部门/用户/角色 */
  orgBoard(): Promise<ApiResult<RemoteOrgBoard>> {
    return request<RemoteOrgBoard>('GET', '/org/board')
  },

  /** GET /api/user/page —— 用户分页检索 */
  userPage(params: { pageNum?: number; pageSize?: number; orgId?: ID; keyword?: string }): Promise<ApiResult<PageResult<SysUser>>> {
    return request<PageResult<SysUser>>('GET', `/user/page${qs(params as Record<string, string | number | undefined>)}`)
  },

  /** POST /api/org/save —— 新增/编辑单位 */
  orgSave(input: { orgId?: ID; orgName: string; orgCode: string; parentId: ID; orgLevel: 1 | 2 | 3; sort: number; status: 0 | 1 }): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/org/save', input)
  },

  /** POST /api/org/remove —— 删除单位（软删除，有下级或填报数据时后台拒绝） */
  orgRemove(orgId: ID): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/org/remove', { orgId })
  },

  /** POST /api/org/dept-save —— 新增/编辑部门 */
  orgDeptSave(input: { deptId?: ID; deptName: string; orgId: ID; sort: number; status: 0 | 1 }): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/org/dept-save', input)
  },

  /** POST /api/user/save —— 新增/编辑用户 */
  userSave(input: { userId?: ID; username: string; realName: string; orgId: ID; deptId: ID; mobile: string; status: 0 | 1; roleIds: ID[] }): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/user/save', input)
  },

  /* ---------------------------- 3.5 填报任务管理 ---------------------------- */

  /** GET /api/task/board —— 任务台账 + 模板/单位/角色/用户字典 + 临期催办 */
  taskBoard(): Promise<ApiResult<RemoteTaskBoard>> {
    return request<RemoteTaskBoard>('GET', '/task/board')
  },

  /** POST /api/task/create —— 新建/编辑任务并下发（返回 taskId） */
  taskCreate(input: RemoteTaskCreateInput): Promise<ApiResult<ID>> {
    return request<ID>('POST', '/task/create', input)
  },

  /** POST /api/task/publish —— 发布并推进状态 */
  taskPublish(taskId: ID): Promise<ApiResult<{ status: number; changed: number; reminds: string[] }>> {
    return request<{ status: number; changed: number; reminds: string[] }>('POST', '/task/publish', { taskId })
  },

  /** POST /api/task/archive —— 归档任务 */
  taskArchive(taskId: ID): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/task/archive', { taskId })
  },

  /** POST /api/task/tick —— 手动推进状态与临期催办 */
  taskTick(): Promise<ApiResult<{ changed: number; reminds: string[] }>> {
    return request<{ changed: number; reminds: string[] }>('POST', '/task/tick')
  },

  /** POST /api/task/scope-save —— 调整下发范围 */
  taskScopeSave(taskId: ID, orgIds: ID[]): Promise<ApiResult<ID[]>> {
    return request<ID[]>('POST', '/task/scope-save', { taskId, orgIds })
  },

  /* ---------------------------- 3.2/3.3/3.4 模板配置 ---------------------------- */

  /** GET /api/template/board —— 模板台账 + 字典 + 最近变更 */
  templateBoard(): Promise<ApiResult<RemoteTemplateBoard>> {
    return request<RemoteTemplateBoard>('GET', '/template/board')
  },

  /** GET /api/template/detail —— 模板详情（当前版本字段 + 历史版本快照） */
  templateDetail(templateId: ID, version?: string): Promise<ApiResult<RemoteTemplateDetail>> {
    return request<RemoteTemplateDetail>('GET', `/template/detail${qs({ templateId, version })}`)
  },

  /** POST /api/template/save —— 新建/编辑模板（返回 templateId） */
  templateSave(input: { templateId?: ID; templateName: string; templateDesc: string; bizType: string }): Promise<ApiResult<ID>> {
    return request<ID>('POST', '/template/save', input)
  },

  /** POST /api/template/status —— 启用/停用/归档 */
  templateStatus(templateId: ID, status: 0 | 1 | 2 | 3): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/template/status', { templateId, status })
  },

  /** POST /api/template/publish-version —— 发布新版本（返回新版本号） */
  templatePublishVersion(templateId: ID, summary: string): Promise<ApiResult<string>> {
    return request<string>('POST', '/template/publish-version', { templateId, summary })
  },

  /** POST /api/template/field/save —— 新增/编辑字段 */
  templateFieldSave(templateId: ID, field: RemoteFieldInput): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/template/field/save', { templateId, field })
  },

  /** POST /api/template/field/remove —— 删除字段 */
  templateFieldRemove(fieldId: ID): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/template/field/remove', { fieldId })
  },

  /** POST /api/template/field/move —— 字段上/下移 */
  templateFieldMove(fieldId: ID, delta: number): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/template/field/move', { fieldId, delta })
  },

  /** GET /api/template/preview —— 任选子单位/查看人预览表单 Schema */
  templatePreview(templateId: ID, version: string, orgId: ID, userId: ID): Promise<ApiResult<FormSchema>> {
    return request<FormSchema>('GET', `/template/preview${qs({ templateId, version, orgId, userId })}`)
  },

  /** GET /api/perm/list —— 模板维度权限规则 */
  permList(templateId: ID): Promise<ApiResult<FormFieldPermission[]>> {
    return request<FormFieldPermission[]>('GET', `/perm/list${qs({ templateId })}`)
  },

  /** POST /api/perm/save —— 新增/编辑权限规则 */
  permSave(input: RemotePermInput): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/perm/save', input)
  },

  /** POST /api/perm/remove —— 删除权限规则 */
  permRemove(permId: ID): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/perm/remove', { permId })
  },

  /** GET /api/perm/field-keys —— 可选字段标识（基础 + 独有） */
  permFieldKeys(templateId: ID): Promise<ApiResult<{ key: string; label: string }[]>> {
    return request<{ key: string; label: string }[]>('GET', `/perm/field-keys${qs({ templateId })}`)
  },

  /** GET /api/perm/decision —— 裁决预览（Schema + 逐字段裁决行） */
  permDecision(templateId: ID, orgId: ID, userId: ID): Promise<ApiResult<RemotePermDecision>> {
    return request<RemotePermDecision>('GET', `/perm/decision${qs({ templateId, orgId, userId })}`)
  },

  /** GET /api/diff/list —— 差异规则清单 */
  diffList(templateId: ID, orgId?: ID): Promise<ApiResult<FormOrgDiff[]>> {
    return request<FormOrgDiff[]>('GET', `/diff/list${qs({ templateId, orgId })}`)
  },

  /** POST /api/diff/save —— 新增/编辑差异规则 */
  diffSave(input: RemoteDiffInput): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/diff/save', input)
  },

  /** POST /api/diff/remove —— 删除差异规则 */
  diffRemove(diffId: ID): Promise<ApiResult<boolean>> {
    return request<boolean>('POST', '/diff/remove', { diffId })
  },

  /** POST /api/diff/copy —— 批量复制差异规则（返回条数） */
  diffCopy(fromOrgId: ID, toOrgIds: ID[], templateId: ID): Promise<ApiResult<number>> {
    return request<number>('POST', '/diff/copy', { fromOrgId, toOrgIds, templateId })
  },

  /** GET /api/diff/merged —— 合并自证（base + merged） */
  diffMerged(templateId: ID, orgId: ID): Promise<ApiResult<{ merged: FormField[]; base: FormField[] }>> {
    return request<{ merged: FormField[]; base: FormField[] }>('GET', `/diff/merged${qs({ templateId, orgId })}`)
  },

  /* ---------------------------- 3.10 操作日志 ---------------------------- */

  /** GET /api/log/board —— 检索字典 + 埋点覆盖 */
  logBoard(): Promise<ApiResult<RemoteLogBoard>> {
    return request<RemoteLogBoard>('GET', '/log/board')
  },

  /** GET /api/log/page —— 日志分页检索 */
  logPage(p: {
    pageNum: number
    pageSize: number
    operType?: string
    userId?: ID
    bizId?: ID
    from?: string
    to?: string
    keyword?: string
  }): Promise<ApiResult<RemoteLogPage>> {
    return request<RemoteLogPage>('GET', `/log/page${qs(p as Record<string, string | number | undefined>)}`)
  },

  /* ---------------------------- 3.8 数据导出 ---------------------------- */

  /** POST /api/export/job —— 发起异步导出作业（返回 jobId） */
  exportJob(taskId: ID, filter: SummaryFilter): Promise<ApiResult<{ jobId: ID }>> {
    return request<{ jobId: ID }>('POST', '/export/job', { taskId, filter })
  },

  /** GET /api/export/jobs —— 作业清单 */
  exportJobs(): Promise<ApiResult<RemoteExportBoard>> {
    return request<RemoteExportBoard>('GET', '/export/jobs')
  },

  /** GET /api/export/now —— 同步导出：带令牌取回 CSV 字节，前端转 objectURL */
  exportNowBlob(taskId: ID, kind: 'detail' | 'progress', filter: RemoteFilterQuery): Promise<ApiResult<{ url: string; fileName: string; expireAt: number }>> {
    return requestBlob(`/export/now${qs({ taskId, kind, ...filter })}`)
  },

  /** GET /api/export/file —— 按 jobId 取回后台已生成的作业正文 */
  exportFileBlob(jobId: ID): Promise<ApiResult<{ url: string; fileName: string; expireAt: number }>> {
    return requestBlob(`/export/file${qs({ jobId })}`)
  },
}
