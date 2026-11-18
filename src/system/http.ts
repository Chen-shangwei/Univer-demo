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
import type { FillContext, WriteResult } from './flow'
import type { ValidateError } from './validate'
import type { ApiResult, FieldValue, FormAttachment } from './types'

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
}
