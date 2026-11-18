/**
 * M0 路由：健康检查 + 登录（接口 1）+ 工作台（接口 30 / 6.1）。
 * 业务判定一律复用 src/system 逻辑层，路由只做「HTTP ↔ 逻辑」的翻译与统一信封。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ApiError, ERR, db, rolesOf, workbench, loadFill, saveDraft, submitReport, resetDemo, recordDetail, auditOperate, revokeAudit, summaryView, orgTree, taskViewsFor, scopeOrgs, heartbeat, lockHolder, attachmentsOf, validateForm, addAttachment, removeAttachment } from './context'
import type { FieldValue, SysUser, SummaryFilter, FormAttachment } from './context'
import { auditList, myTaskViews, summaryBoard } from './read-model'
import { issueToken, verifyToken } from './token'
import { httpStatus, ok, toFail } from './envelope'

/** 去除密码等敏感字段后再返回给前端 */
function safeUser(u: SysUser) {
  return {
    userId: u.userId,
    username: u.username,
    realName: u.realName,
    orgId: u.orgId,
    deptId: u.deptId,
    mobile: u.mobile,
    status: u.status,
    roleIds: u.roleIds,
  }
}

/** 从 Authorization: Bearer <token> 解析并校验身份，失败抛 401（5.1 令牌校验） */
function authenticate(req: FastifyRequest): SysUser {
  const auth = req.headers.authorization ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
  const userId = verifyToken(token)
  if (!userId) throw new ApiError(ERR.UNAUTHORIZED)
  const user = db.sys_user.find((u) => u.userId === userId && u.delFlag === 0 && u.status === 1)
  if (!user) throw new ApiError(ERR.UNAUTHORIZED)
  return user
}

/** 统一的异常出口：把 ApiError/未知异常转成 { code, msg, data:null } 并映射 HTTP 状态 */
function handleError(reply: FastifyReply, e: unknown) {
  const { code, msg } = toFail(e)
  return reply.status(httpStatus(code)).send({ code, msg, data: null })
}

/** 3.9 附件下发不含内联内容（base64 体积大），列表/上传返回前剪掉 blob */
function stripBlob(a: FormAttachment) {
  const { blob: _blob, ...rest } = a
  return rest
}

/** 解码内联 dataURL；大文件无 blob 时回退为原型占位文本（与本地 signDownload 口径一致） */
function attachmentBytes(att: FormAttachment): { mime: string; buf: Buffer } {
  if (att.blob) {
    const comma = att.blob.indexOf(',')
    const head = att.blob.slice(0, comma)
    const body = att.blob.slice(comma + 1)
    const mime = /:(.*?);/.exec(head)?.[1] ?? 'application/octet-stream'
    const buf = head.includes('base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8')
    return { mime, buf }
  }
  const uploader = db.sys_user.find((u) => u.userId === att.uploadUser)?.realName ?? att.uploadUser
  const placeholder = `【原型占位文件】${att.fileName}\n存储地址：${att.filePath}\n大小：${att.fileSize} 字节\n上传人：${uploader}\n上传时间：${att.uploadTime}\n说明：真实环境由 MinIO 返回文件流。`
  return { mime: 'text/plain;charset=utf-8', buf: Buffer.from(placeholder, 'utf8') }
}

export function registerRoutes(app: FastifyInstance): void {
  /** 健康检查：确认服务与内存数据库就绪 */
  app.get('/api/health', async () => {
    return ok({
      ts: Date.now(),
      users: db.sys_user.filter((u) => u.delFlag === 0).length,
      tasks: db.form_task.filter((t) => t.delFlag === 0).length,
      runningTasks: db.form_task.filter((t) => t.status === 1).length,
    })
  })

  /** 5.2 接口 1：POST /api/auth/login —— 校验账号密码，签发访问令牌 */
  app.post('/api/auth/login', async (req, reply) => {
    try {
      const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
      if (!username || !password) throw new ApiError(ERR.REQUIRED, '用户名与密码必填')

      const u = db.sys_user.find((x) => x.username === username && x.delFlag === 0)
      if (!u || u.password !== password) throw new ApiError(ERR.UNAUTHORIZED, '账号或密码错误')
      if (u.status === 0) throw new ApiError(ERR.FORBIDDEN, '账号已停用，仅影响登录（3.1）')

      const token = issueToken(u.userId)
      return ok({ token, user: safeUser(u), roles: rolesOf(u) })
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 6.1 / 接口 30：GET /api/summary/workbench —— 需登录，返回当前用户工作台聚合数据 */
  app.get('/api/summary/workbench', async (req, reply) => {
    try {
      const user = authenticate(req)
      return ok(workbench(user))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 17：GET /api/form/load —— 进入填报：Schema + 载荷 + 只读判定 + 编辑锁 */
  app.get('/api/form/load', async (req, reply) => {
    try {
      const user = authenticate(req)
      const q = req.query as Record<string, string | undefined>
      const taskId = q.taskId
      if (!taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      const seq = Number(q.seq ?? 1)
      const acquire = q.acquire !== 'false'
      return ok(loadFill(user, taskId, seq, { acquire }))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 18：POST /api/record/draft —— 保存草稿（业务拦截走 WriteResult，外层 200） */
  app.post('/api/record/draft', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { taskId?: string; seq?: number; data?: Record<string, FieldValue>; rows?: Record<string, FieldValue>[]; auto?: boolean }
      if (!b.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      return ok(saveDraft(user, b.taskId, Number(b.seq ?? 1), b.data ?? {}, b.rows ?? [], !!b.auto))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 19：POST /api/record/submit —— 提交填报（执行四类校验，通过后按审核配置流转） */
  app.post('/api/record/submit', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { taskId?: string; seq?: number; data?: Record<string, FieldValue>; rows?: Record<string, FieldValue>[] }
      if (!b.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      return ok(submitReport(user, b.taskId, Number(b.seq ?? 1), b.data ?? {}, b.rows ?? []))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 7.5 写会话续锁：POST /api/record/heartbeat —— 每 15 秒续期，返回当前持锁人（无人持锁为 null） */
  app.post('/api/record/heartbeat', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { taskId?: string }
      if (!b.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      heartbeat(b.taskId, user.orgId, user.userId)
      return ok(lockHolder(b.taskId, user.orgId))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 6.4：POST /api/form/validate —— 四类校验（不入库，仅返回错误明细） */
  app.post('/api/form/validate', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { taskId?: string; seq?: number; data?: Record<string, FieldValue>; rows?: Record<string, FieldValue>[] }
      if (!b.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      const ctx = loadFill(user, b.taskId, Number(b.seq ?? 1), { acquire: false })
      return ok(validateForm({ schema: ctx.schema, data: b.data ?? {}, rows: b.rows ?? [], attachments: attachmentsOf(ctx.record.recordId) }))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 2：GET /api/org/tree —— 组织树（下拉与范围选择用） */
  app.get('/api/org/tree', async (req, reply) => {
    try {
      authenticate(req)
      return ok(orgTree())
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 22：GET /api/audit/todo —— 当前审核人的待办列表 */
  app.get('/api/audit/todo', async (req, reply) => {
    try {
      const user = authenticate(req)
      return ok(taskViewsFor(user).filter((v) => v.todo))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 20：GET /api/record/detail —— 记录详情（按记录版本呈现 Schema） */
  app.get('/api/record/detail', async (req, reply) => {
    try {
      const user = authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.recordId) throw new ApiError(ERR.REQUIRED, 'recordId 必填')
      return ok(recordDetail(user, q.recordId))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 21：POST /api/audit/operate —— 审核通过/驳回（多级流转） */
  app.post('/api/audit/operate', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { recordId?: string; conclusion?: 'pass' | 'reject'; opinion?: string }
      if (!b.recordId) throw new ApiError(ERR.REQUIRED, 'recordId 必填')
      if (b.conclusion !== 'pass' && b.conclusion !== 'reject') throw new ApiError(ERR.FORMAT, 'conclusion 必须为 pass 或 reject')
      return ok(auditOperate(user, b.recordId, b.conclusion, b.opinion ?? ''))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 22：POST /api/audit/revoke —— 管理员撤回（回到草稿并留痕） */
  app.post('/api/audit/revoke', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { recordId?: string; reason?: string }
      if (!b.recordId) throw new ApiError(ERR.REQUIRED, 'recordId 必填')
      return ok(revokeAudit(user, b.recordId, b.reason ?? ''))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 23：GET /api/summary/progress —— 填报进度统计 */
  app.get('/api/summary/progress', async (req, reply) => {
    try {
      const user = authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      return ok(summaryView(user, q.taskId).progress)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 24：GET /api/summary/page —— 汇总宽表（含列定义与行数据） */
  app.get('/api/summary/page', async (req, reply) => {
    try {
      const user = authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      const filter: SummaryFilter = q.orgIds ? { orgIds: q.orgIds.split(',') } : {}
      return ok(summaryView(user, q.taskId, filter).table)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 14：GET /api/task/list —— 任务列表（汇总下拉等管理视图用） */
  app.get('/api/task/list', async (req, reply) => {
    try {
      authenticate(req)
      return ok(db.form_task.filter((t) => t.delFlag === 0))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 16：GET /api/task/my/list —— 我的填报任务视图（复用 taskViewsFor） */
  app.get('/api/task/my/list', async (req, reply) => {
    try {
      const user = authenticate(req)
      return ok(myTaskViews(user))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 15 辅助：GET /api/task/scopes —— 任务下发范围内的单位 */
  app.get('/api/task/scopes', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      return ok(scopeOrgs(q.taskId))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 22 扩展：GET /api/audit/list —— 审核工作台「待办 + 全部记录 + 留痕」读模型 */
  app.get('/api/audit/list', async (req, reply) => {
    try {
      const user = authenticate(req)
      return ok(auditList(user))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 23/24 合并：GET /api/summary/board —— 宽表分页 + 进度看板 + 列口径 + 任务信息 */
  app.get('/api/summary/board', async (req, reply) => {
    try {
      const user = authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      const filter: SummaryFilter = {}
      if (q.orgIds) filter.orgIds = q.orgIds.split(',').filter(Boolean)
      if (q.status) filter.status = q.status as SummaryFilter['status']
      if (q.submitFrom) filter.submitFrom = q.submitFrom
      if (q.submitTo) filter.submitTo = q.submitTo
      if (q.keyword) filter.keyword = q.keyword
      const pageNum = Number(q.pageNum ?? 1)
      const pageSize = Number(q.pageSize ?? 20)
      return ok(summaryBoard(user, q.taskId, filter, pageNum, pageSize))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.9 附件：POST /api/attachment/upload —— 登记附件（含小文件内联 blob），提交后拒绝 */
  app.post('/api/attachment/upload', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as {
        recordId?: string
        fieldKey?: string
        file?: { name: string; size: number; type: string }
        limit?: { accept: string[]; maxSize: number; maxCount: number }
        blob?: string
      }
      if (!b.recordId || !b.fieldKey || !b.file) throw new ApiError(ERR.REQUIRED, 'recordId / fieldKey / file 必填')
      const rec = db.form_record.find((r) => r.recordId === b.recordId)
      if (!rec) throw new ApiError(ERR.NOT_FOUND, '填报记录不存在')
      if (rec.recordStatus !== 'draft' && rec.recordStatus !== 'reject') throw new ApiError(ERR.FORBIDDEN, '提交后附件转为只读（3.9）')
      const limit = b.limit ?? { accept: [], maxSize: 20, maxCount: 5 }
      return ok(stripBlob(addAttachment(b.recordId, b.fieldKey, b.file, user, limit, b.blob)))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.9 附件：GET /api/attachment/list —— 某记录（可指定字段）的附件清单 */
  app.get('/api/attachment/list', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.recordId) throw new ApiError(ERR.REQUIRED, 'recordId 必填')
      return ok(attachmentsOf(q.recordId, q.fieldKey).map(stripBlob))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.9 附件：POST /api/attachment/remove —— 仅标记删除（提交后只读拒绝） */
  app.post('/api/attachment/remove', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { attId?: string; editable?: boolean }
      if (!b.attId) throw new ApiError(ERR.REQUIRED, 'attId 必填')
      removeAttachment(b.attId, user, !!b.editable)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.9 附件下载：GET /api/attachment/file —— 带 Bearer 回传原始字节，前端转 objectURL，不暴露存储地址 */
  app.get('/api/attachment/file', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.attId) throw new ApiError(ERR.REQUIRED, 'attId 必填')
      const att = db.form_attachment.find((a) => a.attId === q.attId && a.delFlag === 0)
      if (!att) throw new ApiError(ERR.NOT_FOUND, '附件不存在或已删除')
      const { mime, buf } = attachmentBytes(att)
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(att.fileName)}"`)
      return reply.type(mime).send(buf)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 开发辅助：POST /api/dev/reset —— 恢复初始种子数据（需登录） */
  app.post('/api/dev/reset', async (req, reply) => {
    try {
      authenticate(req)
      resetDemo()
      return ok({ reset: true, tasks: db.form_task.length, records: db.form_record.length })
    } catch (e) {
      return handleError(reply, e)
    }
  })
}
