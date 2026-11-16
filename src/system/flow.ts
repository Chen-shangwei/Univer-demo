/**
 * 3.6 在线填报 / 3.7 填报审核 / 3.8 数据汇总与导出 / 6.1 工作台的流程实现。
 * 5.3.2 保存草稿与提交、5.3.3 审核操作的服务端语义全部在此。
 */
import {
  db,
  hasRole,
  inScope,
  logOp,
  nextId,
  orgById,
  recordOf,
  recordsOf,
  scopeOrgs,
  taskById,
  userById,
} from './db'
import { ApiError, ERR } from './errors'
import { acquireLock, attachmentsOf, heartbeat, lockKey, releaseLock, saveBlob } from './runtime'
import {
  buildProgress,
  buildProgressCsv,
  buildWideCsv,
  buildWideTable,
  recordDataOf,
  statusText,
  toRecordData,
  type WideTable,
} from './row2col'
import { canAuditNode } from './service'
import { fmtDate, nowStr } from './time'
import { buildSchemaFor, cachedBuildSchema, detailFields, headerFields, isEditable, resolveSchema, systemValueOf } from './schema-service'
import type { ValidateError } from './validate'
import { validateForm } from './validate'
import type { FieldValue, FormRecord, FormSchema, FormTask, ID, RecordStatus, SysUser } from './types'

const isBlank = (v: FieldValue) => v === null || v === undefined || String(v).trim() === ''

/* ------------------------------------------------ 6.1 任务列表口径 */

export interface TaskView {
  taskId: ID
  taskName: string
  orgId: ID
  orgName: string
  templateVersion: string
  startTime: string
  endTime: string
  taskStatus: number
  auditType: 0 | 1 | 2
  currentNode: number
  recordStatus: RecordStatus | 'none'
  recordCount: number
  /** 分组：待填报 / 草稿 / 已提交 / 已驳回（3.6 任务列表按状态分组） */
  group: '待填报' | '草稿' | '已提交' | '已驳回' | '已归档' | '未填报'
  canFill: boolean
  restDays: number
  reason: string
  /** 审核端字段 */
  todo?: boolean
  nodeName?: string
}

function restDays(endTime: string): number {
  return Math.ceil((new Date(endTime.replace(/-/g, '/')).getTime() - Date.now()) / 86400_000)
}

function headOf(records: FormRecord[]): FormRecord | undefined {
  if (!records.length) return undefined
  const order: RecordStatus[] = ['reject', 'submitted', 'draft', 'pass']
  return [...records].sort((a, b) => order.indexOf(a.recordStatus) - order.indexOf(b.recordStatus))[0]
}

/** 3.5 其四：未在范围内的单位登录后不可见该任务 */
export function taskViewsFor(user: SysUser): TaskView[] {
  const out: TaskView[] = []
  const isReporter = hasRole(user, 'reporter')
  const isAuditor = hasRole(user, 'auditor')
  const isManager = hasRole(user, 'biz_admin') || hasRole(user, 'template_admin') || hasRole(user, 'sys_admin')

  db.form_task
    .filter((t) => t.delFlag === 0)
    .forEach((task) => {
      if (!isReporter && !isAuditor && !isManager) return
      const scoped = scopeOrgs(task.taskId).map((o) => o.orgId)
      // 3.5 其四：未在范围内的单位登录后不可见该任务；填报行只呈现本单位，管理端保留全范围以便跟踪进度
      const fillOrgs = isReporter ? scoped.filter((orgId) => orgId === user.orgId) : scoped
      // 3.7 审核待办需覆盖全部下发单位（按节点指派的审核人可能不属于被审记录所在单位）
      const auditOrgs = isAuditor ? scoped : []
      const orgIds = [...new Set([...fillOrgs, ...auditOrgs])]
      orgIds.forEach((orgId) => {
        const showFillRow = (isReporter || isManager) && fillOrgs.includes(orgId)
        const records = recordsOf(task.taskId, orgId)
        const head = headOf(records)
        const status: RecordStatus | 'none' = head?.recordStatus ?? 'none'
        const days = restDays(task.endTime)
        let canFill = false
        let reason = ''
        if (!isReporter) reason = '当前账号不具备填报角色'
        else if (orgId !== user.orgId) reason = '仅可填写本单位任务'
        else if (task.status === 0) reason = '任务尚未开始'
        else if (task.status >= 2) reason = '任务已截止，草稿转只读（7.5）'
        else if (status === 'submitted') reason = '已提交，等待审核'
        else if (status === 'pass') reason = '数据已归档，只读留存'
        else canFill = true

        const group: TaskView['group'] =
          status === 'reject' ? '已驳回' : status === 'submitted' ? '已提交' : status === 'draft' ? '草稿' : status === 'pass' ? '已归档' : canFill ? '待填报' : '未填报'

        if (showFillRow) {
          out.push({
            taskId: task.taskId,
            taskName: task.taskName,
            orgId,
            orgName: orgById(orgId)?.orgName ?? orgId,
            templateVersion: task.templateVersion,
            startTime: task.startTime,
            endTime: task.endTime,
            taskStatus: task.status,
            auditType: task.auditType,
            currentNode: head?.currentNode ?? 0,
            recordStatus: status,
            recordCount: records.length,
            group,
            canFill,
            restDays: days,
            reason,
          })
        }

        // 3.7 审核待办：仅本节点且处于待审核的记录
        if (isAuditor && auditOrgs.includes(orgId) && head?.recordStatus === 'submitted' && canAuditNode(user, task, head.currentNode)) {
          out.push({
            taskId: task.taskId,
            taskName: task.taskName,
            orgId,
            orgName: orgById(orgId)?.orgName ?? orgId,
            templateVersion: task.templateVersion,
            startTime: task.startTime,
            endTime: task.endTime,
            taskStatus: task.status,
            auditType: task.auditType,
            currentNode: head.currentNode,
            recordStatus: 'submitted',
            recordCount: records.length,
            group: '已提交',
            canFill: false,
            restDays: days,
            reason: '',
            todo: true,
            nodeName: task.auditNodes.find((n) => n.seq === head.currentNode)?.nodeName,
          })
        }
      })
    })

  return isAuditor && !isReporter && !isManager ? out.filter((v) => v.todo) : out
}

/* ============================================== 3.6 在线填报 */

export interface FillContext {
  task: FormTask
  schema: FormSchema
  record: FormRecord
  data: Record<string, FieldValue>
  rows: Record<string, FieldValue>[]
  readonly: boolean
  /** 只读成因（供界面说明），可填写时为空串 */
  readonlyReason: string
  /** 6.2 Schema 是否命中缓存 */
  fromCache: boolean
  /** 当前持有本单位写入会话的用户标识（7.5），无人持锁为 null */
  lockOwner: ID | null
  restDays: number
}

function blankRecord(user: SysUser, task: FormTask, seq: number): FormRecord {
  return {
    delFlag: 0,
    recordId: nextId('RC'),
    taskId: task.taskId,
    templateId: task.templateId,
    templateVersion: task.templateVersion,
    orgId: user.orgId,
    deptId: user.deptId,
    userId: user.userId,
    recordStatus: 'draft',
    submitCount: 0,
    seq,
    currentNode: 0,
    auditTrails: [],
    data: {},
    rows: [],
    createTime: nowStr(),
    updateTime: nowStr(),
  }
}

/** 5.2 接口 16/17：查询可填任务并加载 Schema（含 5.3.1 校验顺序） */
export function loadFill(user: SysUser, taskId: ID, seq = 1, opts: { acquire?: boolean } = {}): FillContext {
  const task = taskById(taskId)
  if (!task) throw new ApiError(ERR.NOT_FOUND, '任务不存在')
  // 5.3.1 处理顺序第一步：校验任务状态与单位范围
  if (!inScope(taskId, user.orgId)) throw new ApiError(ERR.OUT_OF_SCOPE)
  if (opts.acquire !== false) {
    // 5.3.2：同一单位同一任务同一时刻只允许一个写入会话
    if (task.status !== 0) acquireLock(taskId, user.orgId, user)
    else heartbeat(taskId, user.orgId, user.userId)
  }

  const { schema, fromCache } = cachedBuildSchema(user, task)
  let found = recordOf(taskId, user.orgId, seq)
  const isNew = !found
  if (!found) {
    found = blankRecord(user, task, seq)
    db.form_record.push(found)
  }
  const record = found

  /*
   * 只读判定（3.6 / 7.5 / 7.6）：任务截止或归档、本单位记录已提交待审或已通过时只读。
   * 7.6 一单位一记录「允许多个部门协同填写同一记录」，所以不按记录创建人判只读 ——
   * 同单位同事各有其 edit 列，创建人一刀切会让分段填报场景根本进不去；
   * 并发互斥由 5.3.2 写会话锁负责：只读模式进入（acquire:false）且锁在他人手上时转只读呈现。
   */
  const holder = db.edit_lock.find((l) => l.key === lockKey(taskId, record.orgId)) ?? null
  const lockBusy = opts.acquire === false && !!holder && holder.userId !== user.userId
  const readonly = task.status >= 2 || record.recordStatus === 'submitted' || record.recordStatus === 'pass' || lockBusy
  const readonlyReason = task.status >= 2
    ? `任务已于 ${task.endTime} 截止，草稿转为只读留存，数据保留以便查阅（7.5）`
    : record.recordStatus === 'submitted'
      ? '本单位记录已提交、正在审核中，不可修改；如需变更请申请管理员撤回'
      : record.recordStatus === 'pass'
        ? '本单位记录已审核归档，数据只读留存'
        : lockBusy
          ? `该填报正在编辑中（${holder?.userName ?? '他人'} 持有写入会话，锁 30 秒后自动释放），本次以只读方式打开（7.5）`
          : ''

  // 系统赋值列在后端写入（8.2），新记录或空值时补齐
  const ctx = { orgId: record.orgId, userId: record.userId, deptId: record.deptId, rowIndex: 0 }
  headerFields(schema).forEach((f) => {
    if (f.systemValue) record.data[f.fieldKey] = systemValueOf(f.systemValue, ctx)
    else if (isNew && f.config.defaultValue) record.data[f.fieldKey] = f.config.defaultValue
  })
  const d = detailFields(schema)
  if (d.length && !record.rows.length) record.rows = [Object.fromEntries(d.map((f) => [f.fieldKey, null]))]
  record.rows.forEach((row, i) => {
    d.forEach((f) => {
      if (f.systemValue) row[f.fieldKey] = systemValueOf(f.systemValue, { ...ctx, rowIndex: i })
    })
  })

  return {
    task,
    schema,
    record,
    data: record.data,
    rows: record.rows,
    readonly,
    readonlyReason,
    fromCache,
    lockOwner: holder?.userId ?? null,
    restDays: restDays(task.endTime),
  }
}

/** 4.6 其一：数字型字段写入数值副本列（表20） */
export function syncRecordData(record: FormRecord): void {
  db.form_record_data = db.form_record_data.filter((d) => d.recordId !== record.recordId)
  db.form_record_data.push(...toRecordData(record))
}

interface Authority {
  data: Record<string, FieldValue>
  rows: Record<string, FieldValue>[]
}

/**
 * 8.2 其二：提交接口逐字段比对 edit 权限。
 * 系统赋值列一律重算；read 列取库存值；hidden / 不在本单位表单内的列拒绝写入。
 * 返回清洗后的载荷，并在发现越权改写时抛出 1007。
 */
function enforceAuthority(schema: FormSchema, payload: Authority, stored: Authority, user: SysUser): Authority {
  const violations: string[] = []
  const out: Authority = { data: {}, rows: [] }
  const ctx = { orgId: user.orgId, userId: user.userId, deptId: user.deptId, rowIndex: 0 }

  const headFields = headerFields(schema)
  const knownHead = new Set(headFields.map((f) => f.fieldKey))
  headFields.forEach((f) => {
    const inc = payload.data[f.fieldKey] ?? null
    if (f.systemValue) {
      out.data[f.fieldKey] = systemValueOf(f.systemValue, ctx)
      return
    }
    if (!isEditable(f)) {
      const base = stored.data[f.fieldKey] ?? null
      if (!isBlank(inc) && String(inc) !== String(base ?? '')) violations.push(`单头「${f.fieldLabel}」为 ${f.permission} 权限但收到修改值`)
      out.data[f.fieldKey] = base
      return
    }
    out.data[f.fieldKey] = inc
  })
  // Schema 之外的列（含 hidden 字段）不写入，保持库存原值（6.3 不可提交该字段）
  Object.entries(payload.data).forEach(([k, v]) => {
    if (knownHead.has(k)) return
    const base = stored.data[k] ?? null
    if (!isBlank(v) && String(v) !== String(base ?? '')) violations.push(`单头「${k}」不在本单位表单内，拒绝写入`)
  })
  Object.entries(stored.data).forEach(([k, v]) => {
    if (!(k in out.data)) out.data[k] = v
  })

  const dFields = detailFields(schema)
  const knownDetail = new Set(dFields.map((f) => f.fieldKey))
  payload.rows.forEach((row, i) => {
    const outRow: Record<string, FieldValue> = {}
    dFields.forEach((f) => {
      const inc = row[f.fieldKey] ?? null
      if (f.systemValue) {
        outRow[f.fieldKey] = systemValueOf(f.systemValue, { ...ctx, rowIndex: i })
        return
      }
      if (!isEditable(f)) {
        const base = stored.rows[i]?.[f.fieldKey] ?? null
        if (!isBlank(inc) && String(inc) !== String(base ?? '')) violations.push(`第 ${i + 1} 行「${f.fieldLabel}」为 ${f.permission} 权限但收到修改值`)
        outRow[f.fieldKey] = base
        return
      }
      outRow[f.fieldKey] = inc
    })
    // 明细区同样：本单位看不到的列不接受写入，已有值原样保留，避免填报端保存时丢掉管理侧数据
    Object.entries(row).forEach(([k, v]) => {
      if (knownDetail.has(k)) return
      const base = stored.rows[i]?.[k] ?? null
      if (!isBlank(v) && String(v) !== String(base ?? '')) violations.push(`第 ${i + 1} 行「${k}」不在本单位表单内，拒绝写入`)
    })
    Object.entries(stored.rows[i] ?? {}).forEach(([k, v]) => {
      if (!(k in outRow)) outRow[k] = v
    })
    out.rows.push(outRow)
  })

  if (violations.length) {
    logOp({ userId: user.userId, orgId: user.orgId, operType: '填报提交', bizId: schema.taskId, bizType: 'task', content: `拒绝越权字段写入：${violations.join('；')}`, result: 0 })
    throw new ApiError(ERR.NO_FIELD_PERM, `字段权限不足：${violations[0]}`, violations)
  }
  return out
}

export interface WriteResult {
  ok: boolean
  code: number
  message: string
  errors: ValidateError[]
  recordId?: ID
}

/** 写入前置校验：任务、角色、范围、记录定位与 Schema（载荷由调用方传入，便于 8.2 逐字段清洗） */
function writeInput(user: SysUser, taskId: ID, seq: number) {
  const task = taskById(taskId)
  if (!task) throw new ApiError(ERR.NOT_FOUND, '任务不存在')
  if (!hasRole(user, 'reporter')) throw new ApiError(ERR.FORBIDDEN, '当前账号无填报权限')
  // 5.3.2 校验其一/其二：任务周期与单位范围
  if (!inScope(taskId, user.orgId)) throw new ApiError(ERR.OUT_OF_SCOPE)
  // 7.5：写入会话互斥 —— 锁在他人手上时拒绝落库，避免僵尸页面的定时自动保存覆盖同事正在填的内容
  const holder = db.edit_lock.find((l) => l.key === lockKey(taskId, user.orgId))
  if (holder && holder.userId !== user.userId) {
    throw new ApiError(ERR.LOCKED, `该填报正在编辑中（${holder.userName} 持有写入会话），本次未保存，请稍后重试`)
  }
  const record = recordOf(taskId, user.orgId, seq) ?? blankRecord(user, task, seq)
  if (!db.form_record.includes(record)) db.form_record.push(record)
  const schema = buildSchemaFor(user, task)
  const atts = attachmentsOf(record.recordId)
  const others = recordsOf(taskId, user.orgId)
    .filter((r) => r.recordId !== record.recordId)
    .map((r) => r.data)
  return { task, record, schema, atts, others }
}

/** 5.2 接口 18：保存草稿。无记录时新建，有记录时按字段标识增量更新 */
export function saveDraft(
  user: SysUser,
  taskId: ID,
  seq: number,
  data: Record<string, FieldValue>,
  rows: Record<string, FieldValue>[],
  auto = false,
): WriteResult {
  const { task, record, schema, atts, others } = writeInput(user, taskId, seq)
  if (task.status >= 2) return { ok: false, code: ERR.OUT_OF_WINDOW, message: '任务已截止，草稿转为只读（7.5）', errors: [] }
  if (record.recordStatus === 'submitted' || record.recordStatus === 'pass') {
    return { ok: false, code: ERR.DUPLICATE_SUBMIT, message: '记录已提交，不能回退为草稿；如需修改请申请管理员撤回', errors: [] }
  }
  const clean = enforceAuthority(schema, { data, rows }, { data: record.data, rows: record.rows }, user)
  const errors = validateForm({ schema, data: clean.data, rows: clean.rows, attachments: atts, otherRecords: others, recordId: record.recordId, requireAll: false })
  const block = errors.filter((e) => e.code === ERR.ATTACH_LIMIT || e.code === ERR.FORMAT)
  if (block.length) return { ok: false, code: block[0]!.code, message: block[0]!.message, errors: block }

  record.data = clean.data
  record.rows = clean.rows
  record.recordStatus = 'draft'
  // 协同填写时记录归属最近写入人，与 8.2 重算的系统赋值列（填报人 / 部门）保持同一口径
  record.userId = user.userId
  record.deptId = user.deptId
  record.updateTime = nowStr()
  syncRecordData(record)
  if (!auto) logOp({ userId: user.userId, orgId: user.orgId, operType: '草稿保存', bizId: record.recordId, bizType: 'record', content: `手动保存草稿「${task.taskName}」` })
  return { ok: true, code: ERR.OK, message: auto ? `已自动保存 ${nowStr()}` : `草稿已保存 ${nowStr()}`, errors: [], recordId: record.recordId }
}

/** 5.2 接口 19：提交填报。执行四类校验，通过后冻结表单并按审核配置流转 */
export function submitReport(
  user: SysUser,
  taskId: ID,
  seq: number,
  data: Record<string, FieldValue>,
  rows: Record<string, FieldValue>[],
): WriteResult {
  const { task, record, schema, atts, others } = writeInput(user, taskId, seq)
  if (task.status === 0) return { ok: false, code: ERR.OUT_OF_WINDOW, message: `任务尚未开始，填报窗口 ${task.startTime} ~ ${task.endTime}`, errors: [] }
  if (task.status >= 2) return { ok: false, code: ERR.OUT_OF_WINDOW, message: `任务已于 ${task.endTime} 截止，不可新增提交（3.5）`, errors: [] }
  if (record.recordStatus === 'submitted') return { ok: false, code: ERR.DUPLICATE_SUBMIT, message: '该单位已提交且正在审核中，不允许重复提交', errors: [] }
  if (record.recordStatus === 'pass') return { ok: false, code: ERR.DUPLICATE_SUBMIT, message: '该单位数据已归档，不允许重复提交', errors: [] }
  // 7.6 一单位一记录：提交动作仅允许一次
  if (task.singleRecordPerOrg && record.submitCount > 0 && record.recordStatus !== 'reject') {
    return { ok: false, code: ERR.DUPLICATE_SUBMIT, message: '本任务限制一单位一条记录，已提交记录请通过管理员撤回后修改', errors: [] }
  }

  const clean = enforceAuthority(schema, { data, rows }, { data: record.data, rows: record.rows }, user)
  const errors = validateForm({ schema, data: clean.data, rows: clean.rows, attachments: atts, otherRecords: others, recordId: record.recordId })
  if (errors.length) {
    const first = errors[0]!
    logOp({ userId: user.userId, orgId: user.orgId, operType: '填报提交', bizId: record.recordId, bizType: 'record', content: `提交校验未通过：${first.message}`, result: 0 })
    return { ok: false, code: first.code, message: `校验未通过（共 ${errors.length} 项），已定位首个问题字段`, errors }
  }

  record.data = clean.data
  // 明细区剔除整行空行
  const d = detailFields(schema)
  record.rows = clean.rows.filter((row) => d.some((f) => !isBlank(row[f.fieldKey])))
  record.submitCount += 1
  record.submitTime = nowStr()
  record.updateTime = nowStr()
  record.userId = user.userId
  record.deptId = user.deptId

  if (task.auditType === 0) {
    // 3.5 不审核时提交即生效
    record.recordStatus = 'pass'
    record.currentNode = 0
    record.auditTime = nowStr()
    syncRecordData(record)
    logOp({ userId: user.userId, orgId: user.orgId, operType: '填报提交', bizId: record.recordId, bizType: 'record', content: `提交「${task.taskName}」，任务不审核，提交即生效并进入汇总口径` })
    releaseLock(taskId, user.orgId, user.userId)
    return { ok: true, code: ERR.OK, message: '提交成功，该任务无需审核，数据已生效并进入汇总口径', errors: [], recordId: record.recordId }
  }

  record.recordStatus = 'submitted'
  record.currentNode = 1
  record.auditOpinion = undefined
  syncRecordData(record)
  logOp({ userId: user.userId, orgId: user.orgId, operType: '填报提交', bizId: record.recordId, bizType: 'record', content: `提交「${task.taskName}」，进入 ${task.auditNodes[0]?.nodeName ?? '审核'} 待办（第 ${record.submitCount} 次提交）` })
  releaseLock(taskId, user.orgId, user.userId)
  return { ok: true, code: ERR.OK, message: `提交成功，已进入「${task.auditNodes[0]?.nodeName ?? '审核'}」待办`, errors: [], recordId: record.recordId }
}

/* ============================================== 3.7 填报审核 */

/** 5.2 接口 21/22 */
export function auditOperate(
  user: SysUser,
  recordId: ID,
  conclusion: 'pass' | 'reject',
  opinion: string,
): WriteResult {
  const record = db.form_record.find((r) => r.recordId === recordId)
  if (!record) throw new ApiError(ERR.NOT_FOUND, '填报记录不存在')
  const task = taskById(record.taskId)!
  // 5.3.3 校验操作人是否为本节点审核人、记录是否处于待审核状态
  if (record.recordStatus !== 'submitted') throw new ApiError(ERR.NODE_MISMATCH, '记录不处于待审核状态，无法审核')
  if (!canAuditNode(user, task, record.currentNode)) {
    logOp({ userId: user.userId, orgId: user.orgId, operType: '审核操作', bizId: recordId, bizType: 'record', content: `越权审核被拒绝（节点 ${record.currentNode}）`, result: 0 })
    throw new ApiError(ERR.FORBIDDEN, '您不是当前审核节点的审核人')
  }
  if (conclusion === 'reject' && opinion.trim().length < 5) throw new ApiError(ERR.REQUIRED, '驳回时审核意见为必填，且不少于 5 个字（5.3.3）')
  if (opinion.length > 500) throw new ApiError(ERR.FORMAT, '审核意见长度限制 500 字')

  const node = task.auditNodes.find((n) => n.seq === record.currentNode)!
  record.auditTrails.push({
    trailId: nextId('AT'),
    nodeId: node.nodeId,
    nodeName: node.nodeName,
    seq: node.seq,
    userId: user.userId,
    userName: user.realName,
    conclusion,
    opinion: opinion.trim(),
    time: nowStr(),
    costSeconds: Math.max(1, Math.round((Date.now() - new Date(record.submitTime?.replace(/-/g, '/') ?? Date.now()).getTime()) / 1000)),
  })
  record.auditUserId = user.userId
  record.auditOpinion = opinion.trim()

  if (conclusion === 'reject') {
    record.recordStatus = 'reject'
    record.currentNode = 0
    record.updateTime = nowStr()
    logOp({ userId: user.userId, orgId: user.orgId, operType: '审核操作', bizId: recordId, bizType: 'record', content: `驳回「${task.taskName}」/ ${orgById(record.orgId)?.orgName}：${record.auditOpinion}` })
    return { ok: true, code: ERR.OK, message: '已驳回，退回填报人修改后重新提交', errors: [], recordId }
  }

  const next = task.auditNodes.find((n) => n.seq === record.currentNode + 1)
  if (next) {
    record.currentNode = next.seq
    record.updateTime = nowStr()
    logOp({ userId: user.userId, orgId: user.orgId, operType: '审核操作', bizId: recordId, bizType: 'record', content: `通过节点「${node.nodeName}」，流转至「${next.nodeName}」（多级审核）` })
    return { ok: true, code: ERR.OK, message: `本节点通过，已流转至「${next.nodeName}」`, errors: [], recordId }
  }
  record.recordStatus = 'pass'
  record.currentNode = 0
  record.auditTime = nowStr()
  record.updateTime = nowStr()
  // 7.4 全部节点通过后写入统计宽表同步队列（原型直接落库）
  syncRecordData(record)
  logOp({ userId: user.userId, orgId: user.orgId, operType: '审核操作', bizId: recordId, bizType: 'record', content: `审核通过并归档「${task.taskName}」/ ${orgById(record.orgId)?.orgName}，数据进入汇总口径` })
  return { ok: true, code: ERR.OK, message: '全部节点审核通过，数据已归档并进入汇总口径', errors: [], recordId }
}

/** 3.7 如需变更结论，由管理员发起撤回并记录撤回原因 */
export function revokeAudit(user: SysUser, recordId: ID, reason: string): WriteResult {
  const record = db.form_record.find((r) => r.recordId === recordId)
  if (!record) throw new ApiError(ERR.NOT_FOUND, '填报记录不存在')
  if (!hasRole(user, 'biz_admin')) throw new ApiError(ERR.FORBIDDEN, '仅业务部门管理员可发起撤回')
  if (record.recordStatus === 'draft') throw new ApiError(ERR.NODE_MISMATCH, '记录当前为草稿，无需撤回')
  if (!reason.trim()) throw new ApiError(ERR.REQUIRED, '撤回必须记录原因')
  const task = taskById(record.taskId)!
  record.auditTrails.push({
    trailId: nextId('AT'),
    nodeId: 'REVOKE',
    nodeName: '管理员撤回',
    seq: record.currentNode || task.auditNodes.length,
    userId: user.userId,
    userName: user.realName,
    conclusion: 'revoke',
    opinion: reason.trim(),
    time: nowStr(),
    costSeconds: 0,
  })
  record.recordStatus = 'draft'
  record.currentNode = 0
  // 7.6：一单位一记录限制的是「提交动作仅允许一次」，撤回即为该单位重新开放一次修改与提交
  record.submitCount = 0
  record.auditOpinion = undefined
  record.updateTime = nowStr()
  logOp({ userId: user.userId, orgId: user.orgId, operType: '管理员撤回', bizId: recordId, bizType: 'record', content: `撤回「${task.taskName}」/ ${orgById(record.orgId)?.orgName}：${reason.trim()}` })
  return { ok: true, code: ERR.OK, message: '已撤回，记录回到草稿状态，填报人可修改后重新提交', errors: [], recordId }
}

/** 5.2 接口 20：填报详情（按记录携带的版本呈现，7.3） */
export function recordDetail(user: SysUser, recordId: ID) {
  const record = db.form_record.find((r) => r.recordId === recordId)
  if (!record) throw new ApiError(ERR.NOT_FOUND, '填报记录不存在')
  const task = taskById(record.taskId)!
  const owner = userById(record.userId)!
  // 3.4 生效时点为加载时：以查看人身份 + 被填报单位 + 记录自身版本重新合并 Schema（7.3）
  const schema = resolveSchema({
    user,
    templateId: task.templateId,
    version: record.templateVersion,
    orgId: record.orgId,
    taskId: task.taskId,
    taskName: task.taskName,
  })
  return {
    record,
    task,
    schema,
    data: recordDataOf(record),
    attachments: attachmentsOf(record.recordId),
    ownerName: owner.realName,
    statusText: statusText(record.recordStatus),
  }
}

/* ============================================== 3.8 汇总与导出 */

export interface SummaryFilter {
  orgIds?: ID[]
  status?: RecordStatus | 'none' | ''
  submitFrom?: string
  submitTo?: string
  keyword?: string
}

export function summaryView(user: SysUser, taskId: ID, filter: SummaryFilter = {}) {
  const task = taskById(taskId)
  if (!task) throw new ApiError(ERR.NOT_FOUND, '任务不存在')
  if (!hasRole(user, 'biz_admin') && !hasRole(user, 'auditor') && !hasRole(user, 'sys_admin')) {
    throw new ApiError(ERR.FORBIDDEN, '当前角色无汇总查看权限（10.2）')
  }
  const allOrgIds = scopeOrgs(taskId).map((o) => o.orgId)
  const orgIds = filter.orgIds?.length ? allOrgIds.filter((o) => filter.orgIds!.includes(o)) : allOrgIds
  const table = buildWideTable(task, user, orgIds)
  const progress = buildProgress(task, user, allOrgIds)
  const rows = table.rows.filter((r) => {
    if (filter.status && statusTextOfRecord(taskId, r.orgId, r.recordSeq) !== filter.status) return false
    if (filter.keyword) {
      const hit = Object.values(r.values).some((v) => String(v).includes(filter.keyword!)) || r.orgName.includes(filter.keyword)
      if (!hit) return false
    }
    if (filter.submitFrom || filter.submitTo) {
      const rec = recordOf(taskId, r.orgId, r.recordSeq)
      const t = rec?.submitTime ?? ''
      if (filter.submitFrom && t.slice(0, 10) < filter.submitFrom) return false
      if (filter.submitTo && t.slice(0, 10) > filter.submitTo) return false
    }
    return true
  })
  return { task, orgIds, progress, table: { ...table, rows } as WideTable }
}

function statusTextOfRecord(taskId: ID, orgId: ID, seq: number): RecordStatus | 'none' {
  return recordOf(taskId, orgId, seq)?.recordStatus ?? 'none'
}

/** 3.8 数据量较大时采用异步导出，生成文件后提供有时效的下载链接 */
export const EXPORT_LINK_MINUTES = 30
/** 7.4 单任务记录数超过该值时强制走异步任务 */
export const ASYNC_THRESHOLD = 5000

export function createExportJob(user: SysUser, taskId: ID, filter: SummaryFilter): ID {
  if (!hasRole(user, 'biz_admin')) throw new ApiError(ERR.FORBIDDEN, '仅业务部门管理员可发起导出（10.2）')
  const jobId = nextId('EXP')
  const view = summaryView(user, taskId, filter)
  const filterDesc = [
    `单位：${view.orgIds.map((o) => orgById(o)?.orgName).join('、') || '全部'}`,
    filter.status ? `状态：${statusText(filter.status)}` : '',
    filter.submitFrom || filter.submitTo ? `提交时间：${filter.submitFrom || '不限'} ~ ${filter.submitTo || '不限'}` : '',
    filter.keyword ? `关键字：${filter.keyword}` : '',
  ]
    .filter(Boolean)
    .join('；') || '无（全部数据）'

  db.export_job.unshift({
    jobId,
    taskId,
    userId: user.userId,
    filters: filterDesc,
    status: 'running',
    createTime: nowStr(),
    expireMinutes: EXPORT_LINK_MINUTES,
  })
  logOp({ userId: user.userId, orgId: user.orgId, operType: '数据导出', bizId: taskId, bizType: 'task', content: `发起导出作业 ${jobId}（${filterDesc}）` })

  // 分页读 + 流式写文件：原型用微任务队列分片模拟，避免长时间阻塞主线程
  const task = taskById(taskId)!
  const progress = buildProgress(task, user, scopeOrgs(taskId).map((o) => o.orgId))
  queueMicrotask(() => {
    const job = db.export_job.find((j) => j.jobId === jobId)
    if (!job) return
    const chunks: string[] = []
    const all = view.table.rows
    const SIZE = 2000
    let i = 0
    const step = () => {
      const slice = all.slice(i, i + SIZE)
      chunks.push(buildWideCsv(task, user, { columns: view.table.columns, rows: slice }, filterDesc).replace(/^\uFEFF/, ''))
      i += SIZE
      if (i < all.length) setTimeout(step, 30)
      else {
        const head = buildProgressCsv(task, user, progress).replace(/^\uFEFF/, '').split('\r\n').slice(0, 5).join('\r\n')
        job.content = `\uFEFF${chunks.join('')}\r\n${head}`
        job.fileName = `${task.taskName}_明细_${fmtDate(new Date())}.csv`
        job.rows = all.length
        job.status = 'done'
        job.finishTime = nowStr()
        const dl = signDownloadOfContent(job.jobId, job.fileName, job.content, EXPORT_LINK_MINUTES)
        job.download = dl
        logOp({ userId: user.userId, orgId: user.orgId, operType: '数据导出', bizId: taskId, bizType: 'task', content: `导出作业 ${jobId} 完成，${all.length} 行，下载链接 ${EXPORT_LINK_MINUTES} 分钟内有效` })
      }
    }
    setTimeout(step, 120)
  })
  return jobId
}

const generated = new Map<string, { url: string; fileName: string; expireAt: number }>()

function signDownloadOfContent(jobId: ID, fileName: string, content: string, minutes: number) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const token = `EXP-${jobId}-${Math.random().toString(36).slice(2, 8)}`
  generated.set(token, { url, fileName, expireAt: Date.now() + minutes * 60_000 })
  return { token, url, expireAt: Date.now() + minutes * 60_000 }
}

export function downloadExport(token: string): void {
  const rec = generated.get(token)
  if (!rec) throw new ApiError(ERR.NOT_FOUND, '导出凭证无效')
  if (Date.now() > rec.expireAt) {
    generated.delete(token)
    URL.revokeObjectURL(rec.url)
    throw new ApiError(ERR.LINK_EXPIRED, '下载链接已过期，请重新发起导出')
  }
  const a = document.createElement('a')
  a.href = rec.url
  a.download = rec.fileName
  a.click()
}

export function exportJobs(user: SysUser) {
  return db.export_job.filter((j) => hasRole(user, 'biz_admin') || j.userId === user.userId)
}

/** 立即导出（小数据量走同步，便于冒烟验证） */
export function exportNow(user: SysUser, taskId: ID, filter: SummaryFilter, kind: 'detail' | 'progress'): void {
  const view = summaryView(user, taskId, filter)
  const task = view.task
  if (kind === 'progress') {
    saveBlob(`${task.taskName}_进度.csv`, buildProgressCsv(task, user, view.progress))
    logOp({ userId: user.userId, orgId: user.orgId, operType: '数据导出', bizId: taskId, bizType: 'task', content: `导出填报进度 CSV` })
    return
  }
  const filterDesc = `单位：${view.orgIds.map((o) => orgById(o)?.orgName).join('、') || '全部'}`
  saveBlob(`${task.taskName}_明细.csv`, buildWideCsv(task, user, view.table, filterDesc))
  logOp({ userId: user.userId, orgId: user.orgId, operType: '数据导出', bizId: taskId, bizType: 'task', content: `导出宽表明细 CSV（${view.table.rows.length} 行）` })
}

/* ============================================== 6.1 工作台 */

export function workbench(user: SysUser) {
  const views = taskViewsFor(user)
  const myFill = views.filter((v) => v.canFill && v.orgId === user.orgId)
  const todos = views.filter((v) => v.todo)
  const waiting = db.form_record.filter((r) => r.recordStatus === 'submitted').length
  return {
    fillCount: myFill.length,
    todoCount: todos.length,
    rejectedCount: views.filter((v) => v.orgId === user.orgId && v.recordStatus === 'reject').length,
    draftCount: views.filter((v) => v.orgId === user.orgId && v.recordStatus === 'draft').length,
    runningTasks: db.form_task.filter((t) => t.status === 1).length,
    waitingAudit: waiting,
    templates: db.form_template.filter((t) => t.delFlag === 0).length,
    orgs: db.sys_org.filter((o) => o.orgLevel >= 2 && o.delFlag === 0).length,
    recentLogs: db.form_oper_log.slice(0, 8),
    myViews: views.slice(0, 6),
  }
}
