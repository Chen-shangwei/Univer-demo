import { reactive, toRaw, watch } from 'vue'
import { buildSeed } from './seed'
import { nowStr } from './time'
import type {
  EditLock,
  ExportJob,
  FormAttachment,
  FormField,
  FormFieldPermission,
  FormOperLog,
  FormOrgDiff,
  FormRecord,
  FormRecordData,
  FormTask,
  FormTaskScope,
  FormTemplate,
  ID,
  RoleCode,
  SysDept,
  SysOrg,
  SysRole,
  SysUser,
  TemplateVersion,
} from './types'

const KEY = 'zn-tb-db-v2'

/** 4.3 表7 数据表清单：15 张业务表逐一对应，外加版本快照、导出作业、编辑锁、字典四张原型支撑表 */
export interface Database {
  sys_org: SysOrg[]
  sys_dept: SysDept[]
  sys_role: SysRole[]
  sys_user: SysUser[]
  form_template: FormTemplate[]
  form_field: FormField[]
  form_org_diff: FormOrgDiff[]
  form_field_permission: FormFieldPermission[]
  form_task: FormTask[]
  form_task_scope: FormTaskScope[]
  form_record: FormRecord[]
  form_record_data: FormRecordData[]
  form_attachment: FormAttachment[]
  form_oper_log: FormOperLog[]
  /** 7.3 模板版本快照 */
  form_template_version: TemplateVersion[]
  /** 3.8 异步导出作业 */
  export_job: ExportJob[]
  /** 7.5 写会话锁 */
  edit_lock: EditLock[]
  /** 9.4 基础字典 */
  sys_dict: { dictCode: string; label: string; value: string; sort: number }[]
  seq: number
}

function load(): Database {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Database
      // 结构升级后旧缓存缺表时直接放弃，避免 undefined.forEach
      if (parsed.sys_org && parsed.form_field && parsed.form_record) return parsed
    }
  } catch {
    /* 缓存损坏时回落种子数据 */
  }
  return buildSeed()
}

export const db = reactive<Database>(load())

const BLOB_LIMIT = 400 * 1024

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    // 超出配额：丢弃内联附件内容后重试，元数据保留（4.6 其二：不删文件只标记）
    db.form_attachment.forEach((a) => {
      if (a.blob) a.blob = ''
    })
    try {
      localStorage.setItem(KEY, JSON.stringify(db))
    } catch {
      /* 仍失败则本次仅驻内存 */
    }
  }
}

let timer: number | undefined
watch(
  db,
  () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(persist, 120)
  },
  { deep: true },
)

/** 7.5 跨标签页同步锁与数据，用于演示"同一单位两人同时编辑" */
window.addEventListener('storage', (e) => {
  if (e.key !== KEY || !e.newValue) return
  try {
    const remote = JSON.parse(e.newValue) as Database
    db.edit_lock = remote.edit_lock
  } catch {
    /* 忽略非法远端数据 */
  }
})

export function nextId(prefix: string): ID {
  db.seq += 1
  return `${prefix}${db.seq}`
}

/**
 * 跨表复制配置前取原始对象再深拷贝：db 是 Vue reactive 代理，
 * Proxy 无法被 structuredClone（抛 DataCloneError）。
 */
export function clone<T>(value: T): T {
  return structuredClone(toRaw(value as never)) as T
}

export function resetDemo(): void {
  const fresh = buildSeed()
  Object.assign(db, fresh)
  persist()
}

/* ------------------------------------------------------ 查询辅助 */

export const orgById = (id: ID) => db.sys_org.find((o) => o.orgId === id)
export const deptById = (id: ID) => db.sys_dept.find((d) => d.deptId === id)
export const userById = (id: ID) => db.sys_user.find((u) => u.userId === id)
export const roleById = (id: ID) => db.sys_role.find((r) => r.roleId === id)
export const templateById = (id: ID) => db.form_template.find((t) => t.templateId === id)
export const taskById = (id: ID) => db.form_task.find((t) => t.taskId === id)
export const recordById = (id: ID) => db.form_record.find((r) => r.recordId === id)

export const orgName = (id: ID) => orgById(id)?.orgName ?? '—'
export const deptName = (id: ID) => deptById(id)?.deptName ?? '—'
export const userName = (id: ID) => userById(id)?.realName ?? '—'

/** 3.1 角色与用户多对多 */
export function rolesOf(user: SysUser): RoleCode[] {
  return user.roleIds
    .map((rid) => roleById(rid)?.roleCode)
    .filter((r): r is RoleCode => !!r)
}

export function hasRole(user: SysUser | null, code: RoleCode): boolean {
  return !!user && rolesOf(user).includes(code)
}

/** 填报单位列表（orgLevel >= 2 才是可下发的子单位） */
export function subOrgs(): SysOrg[] {
  return db.sys_org.filter((o) => o.orgLevel >= 2 && o.status === 1).sort((a, b) => a.sort - b.sort)
}

export function scopeOrgs(taskId: ID): SysOrg[] {
  const ids = db.form_task_scope.filter((s) => s.taskId === taskId && s.delFlag === 0).map((s) => s.orgId)
  return subOrgs().filter((o) => ids.includes(o.orgId))
}

export function inScope(taskId: ID, orgId: ID): boolean {
  return db.form_task_scope.some((s) => s.taskId === taskId && s.orgId === orgId && s.delFlag === 0)
}

/** 表7：按模板与版本加载字段（对应索引 template_id、version）。返回深拷贝，避免调用方误改母版（7.1） */
export function fieldsOf(templateId: ID, version: string): FormField[] {
  return db.form_field
    .filter((f) => f.templateId === templateId && f.version === version && f.delFlag === 0)
    .sort((a, b) => a.sort - b.sort)
    .map((f) => ({ ...f, fieldConfig: { ...f.fieldConfig, options: f.fieldConfig.options?.map((o) => ({ ...o })) } }))
}

/** 当前版本号 = 模板表上的 version */
export function enabledTemplates(): FormTemplate[] {
  return db.form_template.filter((t) => t.status !== 0 && t.delFlag === 0)
}

export function recordOf(taskId: ID, orgId: ID, seq = 1): FormRecord | undefined {
  return db.form_record.find((r) => r.taskId === taskId && r.orgId === orgId && r.seq === seq && r.delFlag === 0)
}

export function recordsOf(taskId: ID, orgId: ID): FormRecord[] {
  return db.form_record.filter((r) => r.taskId === taskId && r.orgId === orgId && r.delFlag === 0).sort((a, b) => a.seq - b.seq)
}

/* ------------------------------------------------------ 22 操作日志 */

export function logOp(input: {
  userId: ID
  orgId: ID
  operType: FormOperLog['operType']
  bizId: ID
  bizType: FormOperLog['bizType']
  content: string
  result?: 0 | 1
}): void {
  db.form_oper_log.unshift({
    logId: nextId('LOG'),
    userId: input.userId,
    orgId: input.orgId,
    operType: input.operType,
    bizId: input.bizId,
    bizType: input.bizType,
    content: input.content,
    ip: '10.20.31.' + (100 + (db.seq % 90)),
    result: input.result ?? 1,
    // 5.1 统一 yyyy-MM-dd HH:mm:ss，日志按时间区间检索依赖该格式的字典序比较
    operTime: nowStr(),
  })
  // 3.10 日志只追加、界面不提供删除
  if (db.form_oper_log.length > 800) db.form_oper_log.length = 800
}

export { BLOB_LIMIT }
