/**
 * M0 路由：健康检查 + 登录（接口 1）+ 工作台（接口 30 / 6.1）。
 * 业务判定一律复用 src/system 逻辑层，路由只做「HTTP ↔ 逻辑」的翻译与统一信封。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ApiError, ERR, db, rolesOf, workbench, loadFill, saveDraft, submitReport, resetDemo, recordDetail, auditOperate, revokeAudit, summaryView, orgTree, taskViewsFor, scopeOrgs, heartbeat, lockHolder, attachmentsOf, validateForm, addAttachment, removeAttachment, saveOrg, removeOrg, saveDept, saveUser, createTask, archiveTask, tickTasks, nextId, logOp, taskById, saveTemplate, changeTemplateStatus, saveField, removeField, moveField, publishVersion, saveDiff, removeDiff, copyDiff, savePerm, removePerm, previewSchema, createExportJob } from './context'
import type { FieldValue, SysUser, SummaryFilter, FormAttachment, ID, FormSchema } from './context'
import { auditList, myTaskViews, summaryBoard, orgBoard, userPage, taskBoard, templateBoard, templateDetail, permFieldKeys, permDecision, diffMerged, logBoard, logPage, exportBoard, buildExportCsv } from './read-model'
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

  /** 3.1 组织管理：GET /api/org/board —— 单位树 + 扁平单位/部门/用户/角色一次取全 */
  app.get('/api/org/board', async (req, reply) => {
    try {
      authenticate(req)
      return ok(orgBoard())
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 3：GET /api/user/page —— 用户分页检索 */
  app.get('/api/user/page', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      return ok(userPage({ pageNum: q.pageNum ? Number(q.pageNum) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined, orgId: q.orgId, keyword: q.keyword }))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.1：POST /api/org/save —— 新增/编辑单位（仅系统管理员，saveOrg 内建校验） */
  app.post('/api/org/save', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { orgId?: ID; orgName: string; orgCode: string; parentId: ID; orgLevel: 1 | 2 | 3; sort: number; status: 0 | 1 }
      if (!b.orgName || !b.orgCode) throw new ApiError(ERR.REQUIRED, '单位名称与编码必填')
      saveOrg(b, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.1：POST /api/org/remove —— 删除单位（软删除，下级/填报数据约束由 removeOrg 内建校验） */
  app.post('/api/org/remove', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { orgId?: ID }
      if (!b.orgId) throw new ApiError(ERR.REQUIRED, 'orgId 必填')
      removeOrg(b.orgId, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.1：POST /api/org/dept-save —— 新增/编辑部门 */
  app.post('/api/org/dept-save', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { deptId?: ID; deptName: string; orgId: ID; sort: number; status: 0 | 1 }
      if (!b.deptName || !b.orgId) throw new ApiError(ERR.REQUIRED, '部门名称与所属单位必填')
      saveDept(b, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.1：POST /api/user/save —— 新增/编辑用户（一人多角色，初始密码 123456） */
  app.post('/api/user/save', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { userId?: ID; username: string; realName: string; orgId: ID; deptId: ID; mobile: string; status: 0 | 1; roleIds: ID[] }
      if (!b.username || !b.realName) throw new ApiError(ERR.REQUIRED, '登录账号与姓名必填')
      saveUser(b, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.5 任务管理：GET /api/task/board —— 台账行（含范围/统计）+ 模板/单位/角色/用户字典 + 临期催办 */
  app.get('/api/task/board', async (req, reply) => {
    try {
      authenticate(req)
      return ok(taskBoard())
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 13：POST /api/task/create —— 新建/编辑任务并下发（返回 taskId） */
  app.post('/api/task/create', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as Parameters<typeof createTask>[0]
      if (!b.taskName || !b.templateId) throw new ApiError(ERR.REQUIRED, '任务名称与模板必填')
      return ok(createTask(b, user))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 15：POST /api/task/publish —— 发布即按 9.2 推进状态，返回 { status, changed, reminds } */
  app.post('/api/task/publish', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { taskId?: ID }
      if (!b.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      const t = taskById(b.taskId)
      if (!t) throw new ApiError(ERR.NOT_FOUND, '任务不存在')
      const changed = tickTasks()
      logOp({ userId: user.userId, orgId: user.orgId, operType: '任务下发', bizId: b.taskId, bizType: 'task', content: `发布任务「${t.taskName}」，当前状态 ${['待开始', '进行中', '已截止', '已归档'][t.status]}` })
      return ok({ status: t.status, changed: changed.changed, reminds: changed.reminds })
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 14：POST /api/task/archive —— 归档任务（数据转只读留存） */
  app.post('/api/task/archive', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { taskId?: ID }
      if (!b.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      archiveTask(b.taskId, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 9.2 定时任务口径：POST /api/task/tick —— 手动触发一次状态推进与临期催办 */
  app.post('/api/task/tick', async (req, reply) => {
    try {
      authenticate(req)
      return ok(tickTasks())
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 15 辅助：POST /api/task/scope-save —— 调整下发范围（保留已产生记录） */
  app.post('/api/task/scope-save', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { taskId?: ID; orgIds?: ID[] }
      if (!b.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      const orgIds = b.orgIds ?? []
      if (!orgIds.length) throw new ApiError(ERR.OUT_OF_SCOPE, '下发范围不能为空')
      db.form_task_scope = db.form_task_scope.filter((s) => s.taskId !== b.taskId)
      orgIds.forEach((orgId) => db.form_task_scope.push({ delFlag: 0, scopeId: nextId('S'), taskId: b.taskId!, orgId }))
      logOp({ userId: user.userId, orgId: user.orgId, operType: '任务下发', bizId: b.taskId, bizType: 'task', content: `调整任务下发范围为 ${orgIds.length} 个单位` })
      return ok(orgIds)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.2 模板管理：GET /api/template/board —— 台账行(含字段数/任务数) + 业务分类 + 字典 + 最近变更 */
  app.get('/api/template/board', async (req, reply) => {
    try {
      authenticate(req)
      return ok(templateBoard())
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 6：GET /api/template/detail —— 模板详情（当前版本字段 + 历史版本快照） */
  app.get('/api/template/detail', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.templateId) throw new ApiError(ERR.REQUIRED, 'templateId 必填')
      return ok(templateDetail(q.templateId, q.version))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 4：POST /api/template/save —— 新建/编辑模板（返回 templateId） */
  app.post('/api/template/save', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as Parameters<typeof saveTemplate>[0]
      if (!b.templateName) throw new ApiError(ERR.REQUIRED, '模板名称必填')
      return ok(saveTemplate(b, user))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 4 辅助：POST /api/template/status —— 启用/停用/归档 */
  app.post('/api/template/status', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { templateId?: ID; status?: 0 | 1 | 2 | 3 }
      if (!b.templateId) throw new ApiError(ERR.REQUIRED, 'templateId 必填')
      if (b.status === undefined) throw new ApiError(ERR.REQUIRED, 'status 必填')
      changeTemplateStatus(b.templateId, b.status, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 7：POST /api/template/publish-version —— 发布新版本（返回新版本号） */
  app.post('/api/template/publish-version', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { templateId?: ID; summary?: string }
      if (!b.templateId) throw new ApiError(ERR.REQUIRED, 'templateId 必填')
      return ok(publishVersion(b.templateId, b.summary ?? '', user))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 5：POST /api/template/field/save —— 新增/编辑字段 */
  app.post('/api/template/field/save', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { templateId?: ID; field?: Parameters<typeof saveField>[1] }
      if (!b.templateId || !b.field) throw new ApiError(ERR.REQUIRED, 'templateId 与 field 必填')
      saveField(b.templateId, b.field, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 5 辅助：POST /api/template/field/remove —— 删除字段（历史数据仍按原版本保留） */
  app.post('/api/template/field/remove', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { fieldId?: ID }
      if (!b.fieldId) throw new ApiError(ERR.REQUIRED, 'fieldId 必填')
      removeField(b.fieldId, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 5 辅助：POST /api/template/field/move —— 字段上/下移 */
  app.post('/api/template/field/move', async (req, reply) => {
    try {
      authenticate(req)
      const b = (req.body ?? {}) as { fieldId?: ID; delta?: number }
      if (!b.fieldId) throw new ApiError(ERR.REQUIRED, 'fieldId 必填')
      moveField(b.fieldId, Number(b.delta ?? 0))
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.2 预览：GET /api/template/preview —— 任选子单位/查看人预览表单 Schema */
  app.get('/api/template/preview', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.templateId || !q.version || !q.orgId || !q.userId) throw new ApiError(ERR.REQUIRED, 'templateId / version / orgId / userId 必填')
      const u = db.sys_user.find((x) => x.userId === q.userId)
      if (!u) throw new ApiError(ERR.NOT_FOUND, '预览用户不存在')
      return ok<FormSchema>(previewSchema(u, q.templateId, q.version, q.orgId))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.4 字段权限：GET /api/perm/list —— 模板维度规则清单 */
  app.get('/api/perm/list', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.templateId) throw new ApiError(ERR.REQUIRED, 'templateId 必填')
      return ok(db.form_field_permission.filter((p) => p.templateId === q.templateId && p.delFlag === 0 && (!q.fieldKey || p.fieldKey === q.fieldKey)))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 11：POST /api/perm/save —— 新增/编辑权限规则 */
  app.post('/api/perm/save', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as Parameters<typeof savePerm>[0]
      if (!b.templateId || !b.fieldKey || !b.targetId) throw new ApiError(ERR.REQUIRED, '模板/字段/权限对象必填')
      savePerm(b, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 12：POST /api/perm/remove —— 删除权限规则 */
  app.post('/api/perm/remove', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { permId?: ID }
      if (!b.permId) throw new ApiError(ERR.REQUIRED, 'permId 必填')
      removePerm(b.permId, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.4 辅助：GET /api/perm/field-keys —— 可选字段标识（基础 + 独有） */
  app.get('/api/perm/field-keys', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.templateId) throw new ApiError(ERR.REQUIRED, 'templateId 必填')
      return ok(permFieldKeys(q.templateId))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.4 裁决预览：GET /api/perm/decision —— 服务端产出 Schema + 逐字段裁决行 */
  app.get('/api/perm/decision', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.templateId || !q.orgId || !q.userId) throw new ApiError(ERR.REQUIRED, 'templateId / orgId / userId 必填')
      return ok(permDecision(q.templateId, q.orgId, q.userId))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.3 差异规则：GET /api/diff/list —— 模板(+单位)维度清单 */
  app.get('/api/diff/list', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.templateId) throw new ApiError(ERR.REQUIRED, 'templateId 必填')
      return ok(db.form_org_diff.filter((d) => d.templateId === q.templateId && d.delFlag === 0 && (!q.orgId || d.orgId === q.orgId)))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 8：POST /api/diff/save —— 新增/编辑差异规则 */
  app.post('/api/diff/save', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as Parameters<typeof saveDiff>[0]
      if (!b.templateId || !b.orgId || !b.fieldKey) throw new ApiError(ERR.REQUIRED, '模板/单位/字段标识必填')
      saveDiff(b, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 9：POST /api/diff/remove —— 删除差异规则 */
  app.post('/api/diff/remove', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { diffId?: ID }
      if (!b.diffId) throw new ApiError(ERR.REQUIRED, 'diffId 必填')
      removeDiff(b.diffId, user)
      return ok(true)
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 10：POST /api/diff/copy —— 批量复制差异规则，返回复制条数 */
  app.post('/api/diff/copy', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { fromOrgId?: ID; toOrgIds?: ID[]; templateId?: ID }
      if (!b.fromOrgId || !b.templateId || !b.toOrgIds?.length) throw new ApiError(ERR.REQUIRED, '来源/目标单位与模板必填')
      return ok(copyDiff(b.fromOrgId, b.toOrgIds, b.templateId, user))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.3 合并自证：GET /api/diff/merged —— base 基础字段 + 应用差异后的 merged */
  app.get('/api/diff/merged', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.templateId || !q.orgId) throw new ApiError(ERR.REQUIRED, 'templateId 与 orgId 必填')
      return ok(diffMerged(q.templateId, q.orgId))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.10 操作日志：GET /api/log/board —— 检索字典（操作人/类型）+ 埋点覆盖统计 */
  app.get('/api/log/board', async (req, reply) => {
    try {
      authenticate(req)
      return ok(logBoard())
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 接口 29：GET /api/log/page —— 日志只追加不修改，服务端按条件分页并 join 操作人/单位 */
  app.get('/api/log/page', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      return ok(
        logPage({
          pageNum: Number(q.pageNum ?? 1),
          pageSize: Number(q.pageSize ?? 20),
          operType: q.operType || undefined,
          userId: q.userId || undefined,
          bizId: q.bizId || undefined,
          from: q.from || undefined,
          to: q.to || undefined,
          keyword: q.keyword || undefined,
        }),
      )
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.8 其五：POST /api/export/job —— 发起异步导出作业（后台分片生成），返回 jobId */
  app.post('/api/export/job', async (req, reply) => {
    try {
      const user = authenticate(req)
      const b = (req.body ?? {}) as { taskId?: ID; filter?: SummaryFilter }
      if (!b.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      return ok({ jobId: createExportJob(user, b.taskId, b.filter ?? {}) })
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.8 其五：GET /api/export/jobs —— 作业清单（去内联正文，供轮询状态与下载入口） */
  app.get('/api/export/jobs', async (req, reply) => {
    try {
      const user = authenticate(req)
      return ok(exportBoard(user))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.8 立即导出：GET /api/export/now —— 同步产出 CSV，以文件流回传（不暴露存储地址） */
  app.get('/api/export/now', async (req, reply) => {
    try {
      const user = authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.taskId) throw new ApiError(ERR.REQUIRED, 'taskId 必填')
      const kind = q.kind === 'progress' ? 'progress' : 'detail'
      const filter: SummaryFilter = {}
      if (q.orgIds) filter.orgIds = q.orgIds.split(',').filter(Boolean)
      if (q.status) filter.status = q.status as SummaryFilter['status']
      if (q.submitFrom) filter.submitFrom = q.submitFrom
      if (q.submitTo) filter.submitTo = q.submitTo
      if (q.keyword) filter.keyword = q.keyword
      const { fileName, content } = buildExportCsv(user, q.taskId, filter, kind)
      logOp({ userId: user.userId, orgId: user.orgId, operType: '数据导出', bizId: q.taskId, bizType: 'task', content: kind === 'progress' ? '导出填报进度 CSV' : '导出宽表明细 CSV' })
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
      return reply.type('text/csv;charset=utf-8').send(Buffer.from(content, 'utf8'))
    } catch (e) {
      return handleError(reply, e)
    }
  })

  /** 3.8 作业下载：GET /api/export/file —— 按 jobId 流式回传后台已生成的正文 */
  app.get('/api/export/file', async (req, reply) => {
    try {
      authenticate(req)
      const q = req.query as Record<string, string | undefined>
      if (!q.jobId) throw new ApiError(ERR.REQUIRED, 'jobId 必填')
      const job = db.export_job.find((j) => j.jobId === q.jobId)
      if (!job || !job.content) throw new ApiError(ERR.NOT_FOUND, '导出作业不存在或正文未生成')
      if (job.status !== 'done') throw new ApiError(ERR.LINK_EXPIRED, '导出作业尚未完成')
      if (job.download && Date.now() > job.download.expireAt) throw new ApiError(ERR.LINK_EXPIRED, '下载链接已过期，请重新发起导出')
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(job.fileName ?? `${job.jobId}.csv`)}"`)
      return reply.type('text/csv;charset=utf-8').send(Buffer.from(job.content, 'utf8'))
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
