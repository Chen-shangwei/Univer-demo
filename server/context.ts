/**
 * 服务端访问业务逻辑层的唯一入口。
 *
 * 关键点：第一行先 import 垫片，再 re-export src/system 的模块。
 * ESM/CJS 依赖按书写顺序深度优先求值，垫片无自身依赖会最先执行，
 * 从而保证 db.ts 顶层读取 localStorage / window 时全局对象已就绪。
 * 所有路由只从本文件取逻辑层能力，避免绕过垫片。
 */
import './browser-shim'

export { db, rolesOf, hasRole, userById, orgById, resetDemo, scopeOrgs } from '../src/system/db'
export { workbench, taskViewsFor, loadFill, saveDraft, submitReport, recordDetail, auditOperate, revokeAudit, summaryView } from '../src/system/flow'
export type { FillContext, WriteResult, TaskView, SummaryFilter } from '../src/system/flow'
export { orgTree } from '../src/system/service'
export { canAuditNode } from '../src/system/service'
export { heartbeat, lockHolder, attachmentsOf } from '../src/system/runtime'
export { addAttachment, removeAttachment } from '../src/system/runtime'
export type { UploadLimit } from '../src/system/runtime'
export { validateForm } from '../src/system/validate'
export type { ValidateError } from '../src/system/validate'
export { buildProgress } from '../src/system/row2col'
export { ApiError, ERR, ERR_MSG } from '../src/system/errors'
export type { SysUser, FieldValue, ID } from '../src/system/types'
export type { FormAttachment } from '../src/system/types'
