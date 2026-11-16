/**
 * 3.x 功能详细设计的服务层实现 + 7.x 关键算法落地。
 * 8.2：所有字段级约束在此处二次校验，前端渲染控制不作为权限边界。
 */
import { clone, db, hasRole, logOp, nextId, orgName, recordsOf, scopeOrgs, taskById, userById } from './db'
import { ApiError, ERR } from './errors'
import { invalidateSchema } from './schema-service'
import { mustCurrent } from './session'
import { nowStr } from './time'
import type { FormField, FormTask, ID, SysDept, SysOrg, SysUser, TaskStatus } from './types'

/* ============================================ 9.2/2.3 定时任务：状态推进 */

/** 任务到期提醒、超期未填报提醒、状态推进（原 XXL-Job 承担） */
export function tickTasks(): { changed: number; reminds: string[] } {
  let changed = 0
  const reminds: string[] = []
  const now = nowStr()
  db.form_task.forEach((t) => {
    if (t.status === 3) return
    const next: TaskStatus = now < t.startTime ? 0 : now > t.endTime ? 2 : 1
    if (next !== t.status) {
      t.status = next
      changed += 1
    }
    if (next === 1 && t.remindDays) {
      const left = Math.ceil((new Date(t.endTime.replace(/-/g, '/')).getTime() - Date.now()) / 86400_000)
      if (left >= 0 && left <= t.remindDays) {
        const missing = scopeOrgs(t.taskId).filter((o) => !recordsOf(t.taskId, o.orgId).some((r) => r.recordStatus !== 'draft'))
        if (missing.length) reminds.push(`距截止 ${left} 天，${missing.map((m) => m.orgName).join('、')} 尚未提交`)
      }
    }
    if (next === 2) {
      // 7.5 草稿超过任务截止时间后转为不可编辑，数据保留
      db.form_record.filter((r) => r.taskId === t.taskId && r.recordStatus === 'draft').forEach((r) => {
        r.data.__expiredReadonly = 1
      })
    }
  })
  return { changed, reminds }
}

/* ================================================= 3.1 组织与用户管理 */

/** 3.1 单位树：节点携带本单位部门，供组织管理与下发范围选择复用 */
export interface OrgNode {
  org: SysOrg
  children: OrgNode[]
  depts: SysDept[]
}

export function orgTree(parentId = '0'): OrgNode[] {
  const build = (pid: ID): OrgNode[] =>
    db.sys_org
      .filter((o) => o.parentId === pid && o.delFlag === 0)
      .sort((a, b) => a.sort - b.sort)
      .map((o) => ({ org: o, children: build(o.orgId), depts: db.sys_dept.filter((d) => d.orgId === o.orgId && d.delFlag === 0) }))
  return build(parentId)
}

export function saveOrg(input: { orgId?: ID; orgName: string; orgCode: string; parentId: ID; orgLevel: 1 | 2 | 3; sort: number; status: 0 | 1 }, user = mustCurrent()): void {
  if (!hasRole(user, 'sys_admin')) throw new ApiError(ERR.FORBIDDEN, '仅系统管理员可维护组织')
  // 4.5 约束：org_code 全局唯一
  if (db.sys_org.some((o) => o.orgCode === input.orgCode && o.orgId !== input.orgId && o.delFlag === 0)) {
    throw new ApiError(ERR.FORBIDDEN, `单位编码 ${input.orgCode} 已存在（4.5 唯一约束）`)
  }
  if (input.orgId) {
    const o = db.sys_org.find((x) => x.orgId === input.orgId)
    if (!o) throw new ApiError(ERR.NOT_FOUND, '单位不存在')
    Object.assign(o, input)
  } else {
    db.sys_org.push({ delFlag: 0, orgId: nextId('O'), ...input })
  }
  logOp({ userId: user.userId, orgId: user.orgId, operType: '模板变更', bizId: input.orgId ?? '', bizType: 'org', content: `保存单位 ${input.orgName}(${input.orgCode})` })
}

export function saveDept(input: { deptId?: ID; deptName: string; orgId: ID; sort: number; status: 0 | 1 }, user = mustCurrent()): void {
  if (!hasRole(user, 'sys_admin')) throw new ApiError(ERR.FORBIDDEN, '仅系统管理员可维护部门')
  if (input.deptId) {
    const d = db.sys_dept.find((x) => x.deptId === input.deptId)
    if (!d) throw new ApiError(ERR.NOT_FOUND, '部门不存在')
    Object.assign(d, input, { parentId: '0' })
  } else {
    db.sys_dept.push({ delFlag: 0, deptId: nextId('D'), parentId: '0', ...input })
  }
}

export function saveUser(
  input: { userId?: ID; username: string; realName: string; orgId: ID; deptId: ID; mobile: string; status: 0 | 1; roleIds: ID[] },
  user = mustCurrent(),
): void {
  if (!hasRole(user, 'sys_admin')) throw new ApiError(ERR.FORBIDDEN, '仅系统管理员可维护用户')
  // 4.5 约束：username 唯一
  if (db.sys_user.some((u) => u.username === input.username && u.userId !== input.userId && u.delFlag === 0)) {
    throw new ApiError(ERR.FORBIDDEN, `登录账号 ${input.username} 已存在（4.5 唯一约束）`)
  }
  if (input.userId) {
    const u = db.sys_user.find((x) => x.userId === input.userId)
    if (!u) throw new ApiError(ERR.NOT_FOUND, '用户不存在')
    Object.assign(u, input)
  } else {
    db.sys_user.push({ delFlag: 0, userId: nextId('U'), password: '123456', ...input })
  }
  logOp({ userId: user.userId, orgId: user.orgId, operType: '模板变更', bizId: input.userId ?? '', bizType: 'user', content: `保存用户 ${input.realName}(${input.username})` })
}

/* ================================== 3.2 表单模板管理 + 7.3 版本管理 */

export function saveTemplate(
  input: { templateId?: ID; templateName: string; templateDesc: string; bizType: string; status?: 0 | 1 | 2 | 3 },
  user = mustCurrent(),
): ID {
  if (!hasRole(user, 'template_admin')) throw new ApiError(ERR.FORBIDDEN, '仅表单管理员可维护模板')
  if (input.templateId) {
    const t = db.form_template.find((x) => x.templateId === input.templateId)
    if (!t) throw new ApiError(ERR.NOT_FOUND, '模板不存在')
    // 状态变更走 changeTemplateStatus，此处不随表单提交覆写
    Object.assign(t, { templateName: input.templateName, templateDesc: input.templateDesc, bizType: input.bizType })
    return t.templateId
  }
  const templateId = nextId('T')
  db.form_template.push({
    delFlag: 0,
    templateId,
    templateName: input.templateName,
    templateDesc: input.templateDesc,
    bizType: input.bizType,
    version: 'V1.0',
    createOrgId: user.orgId,
    status: 0,
  })
  logOp({ userId: user.userId, orgId: user.orgId, operType: '模板变更', bizId: templateId, bizType: 'template', content: `新建模板 ${input.templateName}` })
  invalidateSchema(templateId)
  return templateId
}

export function changeTemplateStatus(templateId: ID, status: 0 | 1 | 2 | 3, user = mustCurrent()): void {
  const t = db.form_template.find((x) => x.templateId === templateId)
  if (!t) throw new ApiError(ERR.NOT_FOUND, '模板不存在')
  // 3.2 停用后不再允许新建任务（createTask 中校验），已在办任务不受影响
  t.status = status
  logOp({ userId: user.userId, orgId: user.orgId, operType: '模板变更', bizId: templateId, bizType: 'template', content: `模板状态变更为 ${['草稿', '启用', '停用', '归档'][status]}` })
}

/** 3.2 字段配置：字段标识模板内唯一，一经保存不再变更 */
export function saveField(templateId: ID, input: Partial<FormField> & { fieldKey: string; fieldLabel: string }, user = mustCurrent()): void {
  if (!hasRole(user, 'template_admin')) throw new ApiError(ERR.FORBIDDEN, '仅表单管理员可维护字段')
  const tpl = db.form_template.find((t) => t.templateId === templateId)
  if (!tpl) throw new ApiError(ERR.NOT_FOUND, '模板不存在')
  const exist = db.form_field.some((f) => f.templateId === templateId && f.fieldKey === input.fieldKey && f.version === tpl.version && f.delFlag === 0)

  if (input.fieldId) {
    const f = db.form_field.find((x) => x.fieldId === input.fieldId)
    if (!f) throw new ApiError(ERR.NOT_FOUND, '字段不存在')
    if (f.fieldKey !== input.fieldKey) throw new ApiError(ERR.DUP_FIELD_KEY, '字段标识一经保存不再变更（3.2）')
    Object.assign(f, {
      fieldLabel: input.fieldLabel,
      fieldType: input.fieldType ?? f.fieldType,
      isRequired: input.isRequired ?? f.isRequired,
      sort: input.sort ?? f.sort,
      fieldConfig: input.fieldConfig ?? f.fieldConfig,
      disabled: input.disabled ?? f.disabled,
    })
  } else {
    // 表14：对（template_id, field_key, version）建立唯一约束
    if (exist) throw new ApiError(ERR.DUP_FIELD_KEY, `字段标识 ${input.fieldKey} 在模板 ${tpl.version} 内已存在`)
    const maxSort = db.form_field.filter((f) => f.templateId === templateId && f.version === tpl.version).reduce((m, f) => Math.max(m, f.sort), 0)
    db.form_field.push({
      delFlag: 0,
      fieldId: nextId('F'),
      templateId,
      fieldKey: input.fieldKey,
      fieldLabel: input.fieldLabel,
      fieldType: input.fieldType ?? 'text',
      fieldConfig: input.fieldConfig ?? {},
      isRequired: input.isRequired ?? 0,
      sort: input.sort ?? maxSort + 1,
      version: tpl.version,
    })
  }
  logOp({ userId: user.userId, orgId: user.orgId, operType: '模板变更', bizId: templateId, bizType: 'template', content: `保存字段 ${input.fieldKey}（${input.fieldLabel}）` })
  invalidateSchema(templateId)
}

export function removeField(fieldId: ID, user = mustCurrent()): void {
  if (!hasRole(user, 'template_admin')) throw new ApiError(ERR.FORBIDDEN, '仅表单管理员可维护字段')
  const f = db.form_field.find((x) => x.fieldId === fieldId)
  if (!f) throw new ApiError(ERR.NOT_FOUND, '字段不存在')
  // 7.3：删除字段后历史数据仍保留，导出标注「已停用字段」
  f.delFlag = 1
  logOp({ userId: user.userId, orgId: user.orgId, operType: '模板变更', bizId: f.templateId, bizType: 'template', content: `删除字段 ${f.fieldKey}，历史数据仍按原版本保留` })
  invalidateSchema(f.templateId)
}

export function moveField(fieldId: ID, delta: number): void {
  const f = db.form_field.find((x) => x.fieldId === fieldId)
  if (!f) return
  const siblings = db.form_field
    .filter((x) => x.templateId === f.templateId && x.version === f.version && x.delFlag === 0 && x.fieldConfig.scope === f.fieldConfig.scope)
    .sort((a, b) => a.sort - b.sort)
  const i = siblings.findIndex((x) => x.fieldId === fieldId)
  const j = i + delta
  if (j < 0 || j >= siblings.length) return
  const tmp = siblings[i]!.sort
  siblings[i]!.sort = siblings[j]!.sort
  siblings[j]!.sort = tmp
}

/** 3.2 其四：版本随保存动作递增，记录变更人、时间与内容摘要 */
export function publishVersion(templateId: ID, summary: string, user = mustCurrent()): string {
  if (!hasRole(user, 'template_admin')) throw new ApiError(ERR.FORBIDDEN, '仅表单管理员可发布版本')
  const tpl = db.form_template.find((t) => t.templateId === templateId)
  if (!tpl) throw new ApiError(ERR.NOT_FOUND, '模板不存在')
  const [maj, min] = tpl.version.replace(/^V/i, '').split('.').map((n) => Number(n) || 0)
  const next = `V${maj}.${min + 1}`
  const fields = db.form_field.filter((f) => f.templateId === templateId && f.version === tpl.version && f.delFlag === 0)
  // 字段按版本隔离，历史版本数据保持不动，在办任务继续按旧版本呈现（7.3）
  const copied = fields.map((f) => ({ ...clone(f), fieldId: nextId('F'), version: next }))
  copied.forEach((f) => db.form_field.push(f))
  // 表23 快照留存的是「本次生效的版本」，版本号取发布后的 next，否则与上一版本的快照重复
  const versionSnap = {
    templateId,
    version: next,
    publishTime: nowStr(),
    operator: user.realName,
    summary: summary || '本次发布快照',
    fields: clone(copied),
    diffs: clone(db.form_org_diff.filter((d) => d.templateId === templateId && d.delFlag === 0).map(clone)),
    perms: clone(db.form_field_permission.filter((p) => p.templateId === templateId && p.delFlag === 0).map(clone)),
  }
  // 表15/表16 无版本列：差异与权限规则作用于模板整体，随版本演进的快照已在 versionSnap 中留存
  db.form_template_version.push(versionSnap)
  tpl.version = next
  logOp({ userId: user.userId, orgId: user.orgId, operType: '模板变更', bizId: templateId, bizType: 'template', content: `发布新版本 ${next}：${versionSnap.summary}` })
  invalidateSchema(templateId)
  return next
}

/* ================================== 3.3 子单位差异化配置 */

export function saveDiff(input: {
  diffId?: ID
  templateId: ID
  orgId: ID
  fieldKey: string
  diffType: 1 | 2 | 3
  fieldLabel?: string
  fieldType?: FormField['fieldType']
  fieldConfig?: FormField['fieldConfig']
  isRequired?: 0 | 1
  sort?: number
  scope?: 'header' | 'detail'
  note?: string
}, user = mustCurrent()): void {
  if (!hasRole(user, 'template_admin')) throw new ApiError(ERR.FORBIDDEN, '仅表单管理员可维护差异规则')
  const tpl = db.form_template.find((t) => t.templateId === input.templateId)
  if (!tpl) throw new ApiError(ERR.NOT_FOUND, '模板不存在')
  // 3.3：新增独有字段的 fieldKey 需在模板全部字段中唯一，重复则拒绝并提示冲突
  if (input.diffType === 3) {
    const conflict =
      db.form_field.some((f) => f.templateId === input.templateId && f.fieldKey === input.fieldKey && f.delFlag === 0) ||
      db.form_org_diff.some((d) => d.templateId === input.templateId && d.fieldKey === input.fieldKey && d.diffType === 3 && d.delFlag === 0 && d.diffId !== input.diffId)
    if (conflict) throw new ApiError(ERR.DUP_DIFF_KEY, `新增字段标识 ${input.fieldKey} 与既有字段冲突（3.3 唯一性校验）`)
  }
  if (input.diffId) {
    const d = db.form_org_diff.find((x) => x.diffId === input.diffId)
    if (!d) throw new ApiError(ERR.NOT_FOUND, '差异规则不存在')
    Object.assign(d, input)
  } else {
    db.form_org_diff.push({ delFlag: 0, diffId: nextId('DF'), ...input })
  }
  logOp({ userId: user.userId, orgId: user.orgId, operType: '差异与权限配置变更', bizId: input.templateId, bizType: 'template', content: `保存 ${orgName(input.orgId)} 的差异规则：${['', '隐藏', '修改属性', '新增独有'][input.diffType]} ${input.fieldKey}` })
  invalidateSchema(input.templateId)
}

export function removeDiff(diffId: ID, user = mustCurrent()): void {
  const d = db.form_org_diff.find((x) => x.diffId === diffId)
  if (!d) throw new ApiError(ERR.NOT_FOUND, '差异规则不存在')
  d.delFlag = 1
  logOp({ userId: user.userId, orgId: user.orgId, operType: '差异与权限配置变更', bizId: d.templateId, bizType: 'template', content: `删除差异规则 ${d.fieldKey}` })
  invalidateSchema(d.templateId)
}

/** 3.3：将某子单位的差异规则批量复制到其他子单位，复制后仍可单独调整 */
export function copyDiff(fromOrgId: ID, toOrgIds: ID[], templateId: ID, user = mustCurrent()): number {
  if (!hasRole(user, 'template_admin')) throw new ApiError(ERR.FORBIDDEN, '仅表单管理员可维护差异规则')
  const src = db.form_org_diff.filter((d) => d.templateId === templateId && d.orgId === fromOrgId && d.delFlag === 0)
  let n = 0
  toOrgIds.forEach((orgId) => {
    if (orgId === fromOrgId) return
    src.forEach((d) => {
      const same = db.form_org_diff.find((x) => x.templateId === templateId && x.orgId === orgId && x.fieldKey === d.fieldKey && x.delFlag === 0)
      if (same) Object.assign(same, { ...clone(d), diffId: same.diffId })
      else db.form_org_diff.push({ ...clone(d), diffId: nextId('DF'), orgId })
      n += 1
    })
  })
  logOp({ userId: user.userId, orgId: user.orgId, operType: '差异与权限配置变更', bizId: templateId, bizType: 'template', content: `将 ${orgName(fromOrgId)} 的 ${src.length} 条差异规则复制到 ${toOrgIds.length} 个单位，共 ${n} 条` })
  invalidateSchema(templateId)
  return n
}

/* ================================== 3.4 字段权限配置 */

export function savePerm(input: {
  permId?: ID
  templateId: ID
  fieldKey: string
  targetType: 1 | 2 | 3 | 4
  targetId: ID
  permType: 'hidden' | 'read' | 'edit'
  requiredOverride?: 0 | 1
  note?: string
}, user = mustCurrent()): void {
  if (!hasRole(user, 'template_admin')) throw new ApiError(ERR.FORBIDDEN, '仅表单管理员可维护字段权限')
  if (input.permId) {
    const p = db.form_field_permission.find((x) => x.permId === input.permId)
    if (!p) throw new ApiError(ERR.NOT_FOUND, '权限规则不存在')
    Object.assign(p, input)
  } else {
    db.form_field_permission.push({ delFlag: 0, permId: nextId('PM'), ...input })
  }
  const target =
    input.targetType === 1
      ? db.sys_role.find((r) => r.roleId === input.targetId)?.roleName
      : input.targetType === 2
        ? db.sys_dept.find((d) => d.deptId === input.targetId)?.deptName
        : input.targetType === 3
          ? orgName(input.targetId)
          : userById(input.targetId)?.realName
  logOp({ userId: user.userId, orgId: user.orgId, operType: '差异与权限配置变更', bizId: input.templateId, bizType: 'template', content: `配置字段 ${input.fieldKey} 对 ${target} 为 ${input.permType}` })
  // 7.2 规则变更时按模板维度批量失效缓存
  invalidateSchema(input.templateId)
}

export function removePerm(permId: ID, user = mustCurrent()): void {
  const p = db.form_field_permission.find((x) => x.permId === permId)
  if (!p) throw new ApiError(ERR.NOT_FOUND, '权限规则不存在')
  p.delFlag = 1
  logOp({ userId: user.userId, orgId: user.orgId, operType: '差异与权限配置变更', bizId: p.templateId, bizType: 'template', content: `删除字段权限规则 ${p.fieldKey}` })
  invalidateSchema(p.templateId)
}

/* ============================= 3.5 填报任务管理 */

export function createTask(input: {
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
}, user = mustCurrent()): ID {
  if (!hasRole(user, 'biz_admin')) throw new ApiError(ERR.FORBIDDEN, '仅业务部门管理员可创建任务')
  const tpl = db.form_template.find((t) => t.templateId === input.templateId)
  if (!tpl) throw new ApiError(ERR.NOT_FOUND, '模板不存在')
  // 3.2 草稿不可下发、停用后不再允许新建任务
  if (tpl.status === 0) throw new ApiError(ERR.FORBIDDEN, `模板 ${tpl.templateName} 仍是草稿状态，不可下发`)
  if (tpl.status >= 2) throw new ApiError(ERR.FORBIDDEN, `模板 ${tpl.templateName} 已${tpl.status === 2 ? '停用' : '归档'}，不再允许新建任务`)
  if (!input.orgIds.length) throw new ApiError(ERR.FORBIDDEN, '请至少选择一个下发单位')
  if (input.auditType > 0 && !input.auditNodes.length) throw new ApiError(ERR.FORBIDDEN, '开启审核时必须配置审核节点与审核人')

  const taskId = input.taskId ?? nextId('TASK')
  const task: FormTask = {
    delFlag: 0,
    taskId,
    templateId: input.templateId,
    templateVersion: tpl.version,
    taskName: input.taskName,
    publishOrgId: user.orgId,
    startTime: input.startTime,
    endTime: input.endTime,
    auditType: input.auditType,
    auditFlowId: input.auditType > 0 ? nextId('AF') : null,
    auditNodes: input.auditNodes.map((n, i) => ({ ...n, seq: i + 1 })),
    status: 0,
    singleRecordPerOrg: input.singleRecordPerOrg,
    remindDays: input.remindDays,
    createdBy: user.userId,
    createTime: nowStr(),
  }
  const exist = db.form_task.findIndex((t) => t.taskId === taskId)
  if (exist >= 0) db.form_task.splice(exist, 1, { ...task, status: db.form_task[exist]!.status, createTime: db.form_task[exist]!.createTime })
  else db.form_task.push(task)

  db.form_task_scope = db.form_task_scope.filter((s) => s.taskId !== taskId)
  input.orgIds.forEach((orgId) => db.form_task_scope.push({ delFlag: 0, scopeId: nextId('S'), taskId, orgId }))

  tickTasks()
  logOp({ userId: user.userId, orgId: user.orgId, operType: '任务下发', bizId: taskId, bizType: 'task', content: `保存并发布任务「${task.taskName}」，绑定模板版本 ${task.templateVersion}，下发 ${input.orgIds.length} 个单位` })
  return taskId
}

export function archiveTask(taskId: ID, user = mustCurrent()): void {
  if (!hasRole(user, 'biz_admin')) throw new ApiError(ERR.FORBIDDEN, '仅业务部门管理员可归档任务')
  const t = taskById(taskId)
  if (!t) throw new ApiError(ERR.NOT_FOUND, '任务不存在')
  t.status = 3
  // 3.5 归档后任务与数据均为只读，操作日志继续保留
  db.form_record.filter((r) => r.taskId === taskId).forEach((r) => {
    r.updateTime = nowStr()
  })
  logOp({ userId: user.userId, orgId: user.orgId, operType: '任务下发', bizId: taskId, bizType: 'task', content: `归档任务「${t.taskName}」，数据转只读留存` })
}

export function canAuditNode(user: SysUser, task: FormTask, seq: number): boolean {
  const node = task.auditNodes.find((n) => n.seq === seq)
  if (!node) return false
  if (node.userId) return node.userId === user.userId
  return !!node.roleCode && hasRole(user, node.roleCode)
}
