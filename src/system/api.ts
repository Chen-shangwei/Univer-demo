/**
 * 第 5 章 接口设计 —— 原型内的等价实现。
 * 真实环境是 Spring Boot REST 接口，此处以同名方法 + 统一 { code, msg, data } 结构复刻契约，
 * 便于后续把每个方法替换成一次 fetch 调用而前端页面零改动。
 */
import { db, logOp, nextId, rolesOf, scopeOrgs } from './db'
import { ApiError, ERR, ERR_MSG } from './errors'
import {
  archiveTask,
  changeTemplateStatus,
  copyDiff,
  createTask,
  moveField,
  orgTree,
  publishVersion,
  removeField,
  saveDept,
  saveDiff,
  saveField,
  saveOrg,
  savePerm,
  saveTemplate,
  saveUser,
  tickTasks,
} from './service'
import {
  auditOperate,
  createExportJob,
  downloadExport,
  exportJobs,
  exportNow,
  loadFill,
  recordDetail,
  revokeAudit,
  saveDraft,
  submitReport,
  summaryView,
  taskViewsFor,
  workbench,
} from './flow'
import type { SummaryFilter, TaskView, WriteResult } from './flow'
import { addAttachment, attachmentsOf, heartbeat, removeAttachment, signDownload, LOCK_TTL, lockHolder } from './runtime'
import { buildSchemaFor, previewSchema } from './schema-service'
import { login, mustCurrent } from './session'
import { validateForm } from './validate'
import { buildProgress, toRecordData } from './row2col'
import type { ApiResult, FieldValue, FormFieldPermission, ID, PageResult, SysUser } from './types'

/** 5.1 统一响应结构：非 200 时 msg 可直接展示 */
function wrap<T>(fn: () => T): ApiResult<T> {
  try {
    return { code: ERR.OK, msg: ERR_MSG[200]!, data: fn() }
  } catch (e) {
    if (e instanceof ApiError) return { code: e.code, msg: e.message, data: null as unknown as T }
    return { code: 500, msg: e instanceof Error ? e.message : String(e), data: null as unknown as T }
  }
}

/** 5.1 分页：pageSize 默认 20、上限 200 */
function paginate<T>(list: T[], pageNum = 1, pageSize = 20): PageResult<T> {
  const size = Math.min(Math.max(pageSize, 1), 200)
  const page = Math.max(pageNum, 1)
  return { total: list.length, pages: Math.ceil(list.length / size) || 1, list: list.slice((page - 1) * size, (page - 1) * size + size) }
}

export interface PageParams {
  pageNum?: number
  pageSize?: number
}

/* ------------------------------------------------ 5.2 接口清单实现 */

export const api = {
  /** 1 POST /api/auth/login */
  auth: {
    login(username: string, password: string) {
      return wrap(() => {
        const user = login(username, password)
        logOp({ userId: user.userId, orgId: user.orgId, operType: '登录', bizId: user.userId, bizType: 'user', content: `${user.realName} 登录系统` })
        return { userId: user.userId, realName: user.realName, orgId: user.orgId, roles: rolesOf(user), token: tokenOf(user) }
      })
    },
    logout() {
      return wrap(() => {
        const u = mustCurrent()
        logOp({ userId: u.userId, orgId: u.orgId, operType: '登录', bizId: u.userId, bizType: 'user', content: `${u.realName} 退出登录` })
        return true
      })
    },
  },

  /** 2 GET /api/org/tree */
  org: {
    tree: () => wrap(() => orgTree()),
    save: (input: Parameters<typeof saveOrg>[0]) => wrap(() => saveOrg(input)),
    deptSave: (input: Parameters<typeof saveDept>[0]) => wrap(() => saveDept(input)),
    /** 3 GET /api/user/page */
    userPage: (p: PageParams & { orgId?: ID; keyword?: string }) =>
      wrap(() =>
        paginate(
          db.sys_user.filter(
            (u) =>
              u.delFlag === 0 &&
              (!p.orgId || u.orgId === p.orgId) &&
              (!p.keyword || u.realName.includes(p.keyword) || u.username.includes(p.keyword)),
          ),
          p.pageNum,
          p.pageSize,
        ),
      ),
    userSave: (input: Parameters<typeof saveUser>[0]) => wrap(() => saveUser(input)),
  },

  /** 4-7 模板 */
  template: {
    save: (input: Parameters<typeof saveTemplate>[0]) => wrap(() => saveTemplate(input)),
    status: (templateId: ID, status: 0 | 1 | 2 | 3) => wrap(() => changeTemplateStatus(templateId, status)),
    /** 5 POST /api/template/field/save */
    fieldSave: (templateId: ID, input: Parameters<typeof saveField>[1]) => wrap(() => saveField(templateId, input)),
    fieldRemove: (fieldId: ID) => wrap(() => removeField(fieldId)),
    fieldMove: (fieldId: ID, delta: number) => wrap(() => moveField(fieldId, delta)),
    /** 6 GET /api/template/detail */
    detail: (templateId: ID, version?: string) =>
      wrap(() => {
        const t = db.form_template.find((x) => x.templateId === templateId)
        if (!t) throw new ApiError(ERR.NOT_FOUND)
        const v = version ?? t.version
        return {
          template: t,
          fields: db.form_field.filter((f) => f.templateId === templateId && f.version === v).sort((a, b) => a.sort - b.sort),
          versions: db.form_template_version.filter((x) => x.templateId === templateId),
        }
      }),
    /** 7 POST /api/template/version/publish */
    publishVersion: (templateId: ID, summary: string) => wrap(() => publishVersion(templateId, summary)),
    /** 3.2 模板预览 */
    preview: (templateId: ID, version: string, orgId: ID, viewerUserId: ID) =>
      wrap(() => {
        const u = db.sys_user.find((x) => x.userId === viewerUserId)
        if (!u) throw new ApiError(ERR.NOT_FOUND, '预览用户不存在')
        return previewSchema(u, templateId, version, orgId)
      }),
  },

  /** 8-10 差异规则 */
  diff: {
    list: (templateId: ID, orgId?: ID) =>
      wrap(() => db.form_org_diff.filter((d) => d.templateId === templateId && d.delFlag === 0 && (!orgId || d.orgId === orgId))),
    save: (input: Parameters<typeof saveDiff>[0]) => wrap(() => saveDiff(input)),
    remove: (diffId: ID) =>
      wrap(() => {
        const d = db.form_org_diff.find((x) => x.diffId === diffId)
        if (!d) throw new ApiError(ERR.NOT_FOUND)
        d.delFlag = 1
        return true
      }),
    copy: (fromOrgId: ID, toOrgIds: ID[], templateId: ID) => wrap(() => copyDiff(fromOrgId, toOrgIds, templateId)),
  },

  /** 11-12 字段权限 */
  perm: {
    list: (templateId: ID, fieldKey?: string) =>
      wrap(() => db.form_field_permission.filter((p) => p.templateId === templateId && p.delFlag === 0 && (!fieldKey || p.fieldKey === fieldKey))),
    save: (input: Partial<FormFieldPermission> & { templateId: ID; fieldKey: string; targetType: 1 | 2 | 3 | 4; targetId: ID; permType: 'hidden' | 'read' | 'edit' }) =>
      wrap(() => savePerm(input as FormFieldPermission)),
    remove: (permId: ID) =>
      wrap(() => {
        const p = db.form_field_permission.find((x) => x.permId === permId)
        if (!p) throw new ApiError(ERR.NOT_FOUND)
        p.delFlag = 1
        return true
      }),
  },

  /** 13-16 任务 */
  task: {
    create: (input: Parameters<typeof createTask>[0]) => wrap(() => createTask(input)),
    scopeSave: (taskId: ID, orgIds: ID[]) =>
      wrap(() => {
        if (!orgIds.length) throw new ApiError(ERR.OUT_OF_SCOPE, '下发范围不能为空')
        db.form_task_scope = db.form_task_scope.filter((s) => s.taskId !== taskId)
        orgIds.forEach((orgId) => db.form_task_scope.push({ delFlag: 0, scopeId: nextId('S'), taskId, orgId }))
        return orgIds
      }),
    /** 15 POST /api/task/publish */
    publish: (taskId: ID) =>
      wrap(() => {
        const t = db.form_task.find((x) => x.taskId === taskId)
        if (!t) throw new ApiError(ERR.NOT_FOUND)
        const changed = tickTasks()
        logOp({ userId: mustCurrent().userId, orgId: mustCurrent().orgId, operType: '任务下发', bizId: taskId, bizType: 'task', content: `发布任务「${t.taskName}」，当前状态 ${['待开始', '进行中', '已截止', '已归档'][t.status]}` })
        // 9.2 定时任务口径：发布即推进状态，并带回临期未报单位的催办提示
        return { status: t.status, changed: changed.changed, reminds: changed.reminds }
      }),
    archive: (taskId: ID) => wrap(() => archiveTask(taskId)),
    list: () => wrap(() => (tickTasks(), db.form_task.filter((t) => t.delFlag === 0))),
    /** 9.2 定时任务：手动触发一次状态推进与临期催办（原型按钮，代替调度台） */
    tick: () => wrap(() => tickTasks()),
    /** 16 GET /api/task/my/list */
    myList: (userId?: ID) => wrap(() => taskViewsFor(userOf(userId))),
    scopes: (taskId: ID) => wrap(() => scopeOrgs(taskId)),
  },

  /** 17 GET /api/form/schema */
  form: {
    schema: (taskId: ID, recordId?: ID, userId?: ID) =>
      wrap(() => {
        const user = userOf(userId)
        const task = db.form_task.find((t) => t.taskId === taskId)
        if (!task) throw new ApiError(ERR.NOT_FOUND, '任务不存在')
        if (recordId) {
          const rec = db.form_record.find((r) => r.recordId === recordId)
          if (!rec) throw new ApiError(ERR.NOT_FOUND, '填报记录不存在')
          return { schema: buildSchemaFor(user, { ...task, templateVersion: rec.templateVersion }), record: rec }
        }
        return { schema: buildSchemaFor(user, task), record: null }
      }),
    /** 3.6 进入填报：Schema + 载荷 + 只读判定 + 编辑锁 */
    load: (taskId: ID, seq = 1, userId?: ID, acquire = true) => wrap(() => loadFill(userOf(userId), taskId, seq, { acquire })),
    validate: (taskId: ID, seq: number, data: Record<string, FieldValue>, rows: Record<string, FieldValue>[]) =>
      wrap(() => {
        const user = userOf()
        const ctx = loadFill(user, taskId, seq, { acquire: false })
        return validateForm({ schema: ctx.schema, data, rows, attachments: attachmentsOf(ctx.record.recordId) })
      }),
  },

  /** 18-20 填报记录 */
  record: {
    draft: (taskId: ID, seq: number, data: Record<string, FieldValue>, rows: Record<string, FieldValue>[], auto = false) =>
      wrap<WriteResult>(() => saveDraft(userOf(), taskId, seq, data, rows, auto)),
    submit: (taskId: ID, seq: number, data: Record<string, FieldValue>, rows: Record<string, FieldValue>[]) =>
      wrap<WriteResult>(() => submitReport(userOf(), taskId, seq, data, rows)),
    detail: (recordId: ID, userId?: ID) => wrap(() => recordDetail(userOf(userId), recordId)),
    /** 7.5 写会话每 15 秒续期一次，锁 30 秒后自动释放 */
    heartbeat: (taskId: ID) =>
      wrap(() => {
        const u = userOf()
        heartbeat(taskId, u.orgId, u.userId)
        return lockHolder(taskId, u.orgId)
      }),
    /** 表20 投影：按字段逐行返回 */
    data: (recordId: ID) =>
      wrap(() => {
        const rec = db.form_record.find((r) => r.recordId === recordId)
        if (!rec) throw new ApiError(ERR.NOT_FOUND)
        return toRecordData(rec)
      }),
    lockState: (taskId: ID, orgId: ID) => wrap(() => ({ holder: lockHolder(taskId, orgId), ttl: LOCK_TTL })),
  },

  /** 21-22 审核 */
  audit: {
    operate: (recordId: ID, conclusion: 'pass' | 'reject', opinion: string, userId?: ID) =>
      wrap<WriteResult>(() => auditOperate(userOf(userId), recordId, conclusion, opinion)),
    todo: (userId?: ID) => wrap(() => taskViewsFor(userOf(userId)).filter((v: TaskView) => v.todo)),
    revoke: (recordId: ID, reason: string) => wrap<WriteResult>(() => revokeAudit(userOf(), recordId, reason)),
  },

  /** 23-24 汇总 */
  summary: {
    progress: (taskId: ID, userId?: ID) =>
      wrap(() => {
        const user = userOf(userId)
        return buildProgress(db.form_task.find((t) => t.taskId === taskId)!, user, scopeOrgs(taskId).map((o) => o.orgId))
      }),
    page: (taskId: ID, filter: SummaryFilter = {}, p: PageParams = {}) =>
      wrap(() => {
        const view = summaryView(userOf(), taskId, filter)
        return { ...paginate(view.table.rows, p.pageNum, p.pageSize), columns: view.table.columns, progress: view.progress, task: view.task, orgIds: view.orgIds }
      }),
    workbench: (userId?: ID) => wrap(() => workbench(userOf(userId))),
  },

  /** 25-26 异步导出 */
  export: {
    task: (taskId: ID, filter: SummaryFilter = {}) => wrap(() => ({ jobId: createExportJob(userOf(), taskId, filter) })),
    download: (token: string) =>
      wrap(() => {
        downloadExport(token)
        return true
      }),
    jobs: () => wrap(() => exportJobs(userOf())),
    now: (taskId: ID, filter: SummaryFilter, kind: 'detail' | 'progress') => wrap(() => exportNow(userOf(), taskId, filter, kind)),
  },

  /** 27-28 附件 */
  attachment: {
    upload: (
      recordId: ID,
      fieldKey: string,
      file: { name: string; size: number; type: string },
      limit: { accept: string[]; maxSize: number; maxCount: number },
      blob?: string,
    ) =>
      wrap(() => {
        const rec = db.form_record.find((r) => r.recordId === recordId)
        if (!rec) throw new ApiError(ERR.NOT_FOUND, '填报记录不存在')
        if (rec.recordStatus !== 'draft' && rec.recordStatus !== 'reject') throw new ApiError(ERR.FORBIDDEN, '提交后附件转为只读（3.9）')
        return addAttachment(recordId, fieldKey, file, userOf(), limit, blob)
      }),
    list: (recordId: ID, fieldKey?: string) => wrap(() => attachmentsOf(recordId, fieldKey)),
    remove: (attId: ID, editable: boolean) => wrap(() => removeAttachment(attId, userOf(), editable)),
    /** 返回短时有效凭证，不直接暴露存储路径 */
    download: (attId: ID, minutes = 5) => wrap(() => signDownload(attId, userOf(), minutes)),
  },

  /** 29 GET /api/log/page —— 3.10 日志只追加，界面不提供删除 */
  log: {
    page: (p: PageParams & { operType?: string; userId?: ID; bizId?: ID; from?: string; to?: string; keyword?: string }) =>
      wrap(() =>
        paginate(
          db.form_oper_log.filter(
            (l) =>
              (!p.operType || l.operType === p.operType) &&
              (!p.userId || l.userId === p.userId) &&
              (!p.bizId || l.bizId === p.bizId) &&
              (!p.keyword || l.content.includes(p.keyword)) &&
              (!p.from || l.operTime >= p.from) &&
              (!p.to || l.operTime <= p.to),
          ),
          p.pageNum,
          p.pageSize,
        ),
      ),
  },

  /** 原型辅助：基础字典（9.4） */
  dict: {
    of: (code: string) => wrap(() => db.sys_dict.filter((d) => d.dictCode === code)),
  },
}

/* ------------------------------------------------------ 内部工具 */

function userOf(userId?: ID): SysUser {
  if (!userId) return mustCurrent()
  const u = db.sys_user.find((x) => x.userId === userId)
  if (!u) throw new ApiError(ERR.NOT_FOUND, '用户不存在')
  return u
}

/** 5.1 令牌有效期 8 小时；原型从会话缓存中取回 */
function tokenOf(user: SysUser): string {
  const raw = localStorage.getItem('zn-tb-session')
  if (raw) {
    const s = JSON.parse(raw) as { userId: string; token: string; expireAt: number }
    if (s.userId === user.userId && Date.now() < s.expireAt) return s.token
  }
  throw new ApiError(ERR.UNAUTHORIZED)
}
