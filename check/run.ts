/**
 * 10.1 表30 功能测试要点 T01–T14 的自动化断言。
 * 运行：pnpm check —— 以 SSR 方式转译 src/system 下的纯逻辑层，在 Node 中按设计书逐条验证。
 * 每条断言的注释标注了对应的设计书条款，失败时打印实际值。
 */
import './stub'
import { blobText, downloads } from './stub'
import { api } from '../src/system/api'
import { db, recordOf, recordsOf, resetDemo, scopeOrgs } from '../src/system/db'
import { ASYNC_THRESHOLD, EXPORT_LINK_MINUTES, taskViewsFor } from '../src/system/flow'
import type { FillContext } from '../src/system/flow'
import { ApiError, ERR, ERR_MSG } from '../src/system/errors'
import { buildWideCsv, buildWideTable, statusText, toRecordData } from '../src/system/row2col'
import { consumeDownload, lockHolder, releaseLock, LOCK_TTL } from '../src/system/runtime'
import { buildSchemaFor, decidePerm, detailFields, headerFields, isEditable, previewSchema } from '../src/system/schema-service'
import { removeDiff, removePerm } from '../src/system/service'
import { logout, permMatrixAudit } from '../src/system/session'
import { SYSTEM_VALUES } from '../src/system/seed'
import { validateForm } from '../src/system/validate'
import { OPER_TYPE } from '../src/system/types'
import type { ApiResult, FieldValue, FormAttachment, ID, SysUser } from '../src/system/types'
import type { WriteResult } from '../src/system/flow'

/* ==================================================== 断言基础设施 */

let passed = 0
let failed = 0
/** 表25 错误码覆盖度统计：每条负向断言把实际返回码登记进来 */
const observedCodes = new Set<number>()

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${extra ? `  <<< ${extra}` : ''}`)
  }
}

function must200<T>(r: ApiResult<T>): T {
  if (r.code !== ERR.OK) throw new Error(`期望 200，实际 ${r.code} ${r.msg}`)
  return r.data
}

function expectCode(name: string, r: ApiResult<unknown>, code: number, msgPart = ''): void {
  observedCodes.add(r.code)
  ok(name, r.code === code && (!msgPart || r.msg.includes(msgPart)), `实际 code=${r.code} msg=${r.msg}`)
}

/**
 * 接口 18/19/20（草稿、提交、审核）的业务拦截走 WriteResult，外层仍是 200；
 * 断言需下钻 data.code，才能真正验证 5.3 校验顺序生效。
 */
function expectRejected(name: string, r: ApiResult<WriteResult>, code: number, msgPart = ''): void {
  const eff = r.code === ERR.OK ? (r.data?.code ?? -1) : r.code
  const msg = r.code === ERR.OK ? (r.data?.message ?? '') : r.msg
  observedCodes.add(eff)
  ok(name, eff === code && (!msgPart || msg.includes(msgPart)), `实际 code=${eff} msg=${msg}`)
}

/** 直接调用内部函数时的异常码提取（未经接口层 wrap 包装） */
function expectThrow(name: string, fn: () => unknown, code: number, msgPart = ''): void {
  let actual = ERR.OK
  let msg = ''
  try {
    fn()
  } catch (e) {
    if (e instanceof ApiError) {
      actual = e.code
      msg = e.message
    } else {
      actual = -1
      msg = e instanceof Error ? e.message : String(e)
    }
  }
  observedCodes.add(actual)
  ok(name, actual === code && (!msgPart || msg.includes(msgPart)), `实际 code=${actual} msg=${msg}`)
}

async function section(id: string, title: string, fn: () => void | Promise<void>): Promise<void> {
  console.log(`\n===== ${id}　${title} =====`)
  try {
    await fn()
  } catch (e) {
    failed += 1
    console.log(`  FAIL  本节异常中断：${e instanceof Error ? e.message : String(e)}`)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/* ==================================================== 种子与身份 */

resetDemo()

const pad = (n: number) => String(n).padStart(2, '0')
const today = new Date()
const ym = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`
const dayAt = (offset: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function who(username: string): SysUser {
  const u = db.sys_user.find((x) => x.username === username)
  if (!u) throw new Error(`种子账号缺失：${username}`)
  return u
}

/** 5.2 接口 1：以指定身份登录，后续接口调用均使用该会话 */
function as(username: string): SysUser {
  must200(api.auth.login(username, '123456'))
  return who(username)
}

const task1 = () => db.form_task.find((t) => t.taskId === 'TASK-1')!

/**
 * 构造「当前用户视图内合法」的载荷。
 * 8.2 其二：只写具备 edit 权限的列，read / hidden 列原样带回，越权改写由专项断言验证。
 */
function payloadOf(ctx: FillContext, patch: { data?: Record<string, FieldValue>; rows?: Record<string, FieldValue>[] } = {}) {
  const editHead = new Set(headerFields(ctx.schema).filter(isEditable).map((f) => f.fieldKey))
  const editDetail = new Set(detailFields(ctx.schema).filter(isEditable).map((f) => f.fieldKey))

  const wanted: Record<string, FieldValue> = {
    period: ym,
    stopWork: '0',
    contact: '13900000009',
    summary: '断言脚本写入的总体说明',
    issueDesc: '',
    fundSource: 'self',
  }
  const wantedRow: Record<string, FieldValue> = {
    planNum: 10,
    finishNum: 6,
    status: '1',
    owner: '张三',
    remark: '正常推进',
    hazard: '',
    lastCheck: '',
  }

  const data: Record<string, FieldValue> = { ...ctx.data }
  Object.entries({ ...wanted, ...(patch.data ?? {}) }).forEach(([k, v]) => {
    if (editHead.has(k)) data[k] = v
  })

  const emptyRow: Record<string, FieldValue> = Object.fromEntries(detailFields(ctx.schema).map((f) => [f.fieldKey, null]))
  const rows = (patch.rows ?? [{}]).map((rowPatch, i) => {
    const base: Record<string, FieldValue> = { ...emptyRow, ...(ctx.rows[i] ?? {}) }
    Object.entries({ ...wantedRow, itemName: `断言项目 ${i + 1}`, ...rowPatch }).forEach(([k, v]) => {
      if (editDetail.has(k)) base[k] = v
    })
    return base
  })
  return { data, rows }
}

/** 逻辑删除临时任务及其派生数据，避免污染后续章节 */
function dropTask(taskId: ID): void {
  db.form_task = db.form_task.filter((t) => t.taskId !== taskId)
  db.form_task_scope = db.form_task_scope.filter((s) => s.taskId !== taskId)
  db.form_record = db.form_record.filter((r) => r.taskId !== taskId)
  db.edit_lock = db.edit_lock.filter((l) => !l.key.startsWith(`${taskId}__`))
}

/** 删除临时模板及其字段 */
function dropTemplate(templateId: ID): void {
  db.form_template = db.form_template.filter((t) => t.templateId !== templateId)
  db.form_field = db.form_field.filter((f) => f.templateId !== templateId)
  db.form_org_diff = db.form_org_diff.filter((d) => d.templateId !== templateId)
  db.form_field_permission = db.form_field_permission.filter((p) => p.templateId !== templateId)
}

/* ============================================ T01 模板字段配置 */

await section('T01', '模板字段配置（3.2 / 6.4）', () => {
  as('admin') // 表单管理员
  const tpl = must200(api.template.save({ templateName: 'T01 断言用模板', templateDesc: '字段配置用例', bizType: '生产运营' }))
  ok('新建模板返回标识且状态为草稿', !!tpl && must200(api.template.detail(tpl)).template.status === 0)

  // 3.2 其一：字段标识在模板内唯一
  must200(api.template.fieldSave(tpl, { fieldKey: 'k1', fieldLabel: '字段一', fieldType: 'text', isRequired: 1, fieldConfig: { scope: 'header', maxLength: 5 } }))
  expectCode('重复字段标识被拒绝（2001）', api.template.fieldSave(tpl, { fieldKey: 'k1', fieldLabel: '重复字段', fieldType: 'text' }), ERR.DUP_FIELD_KEY)
  const k1 = db.form_field.find((f) => f.templateId === tpl && f.fieldKey === 'k1')!
  expectCode('字段标识保存后不可变更（2001）', api.template.fieldSave(tpl, { fieldId: k1.fieldId, fieldKey: 'k1b', fieldLabel: '字段一' }), ERR.DUP_FIELD_KEY)

  // 3.2 其四：排序与预览一致（倒序录入 sort）
  must200(api.template.fieldSave(tpl, { fieldKey: 'k3', fieldLabel: '字段三', fieldType: 'number', sort: 10 }))
  must200(api.template.fieldSave(tpl, { fieldKey: 'k2', fieldLabel: '字段二', fieldType: 'date', sort: 20 }))
  const view = must200(api.template.preview(tpl, 'V1.0', 'O11', 'U5'))
  const order = view.fields.map((f) => f.fieldKey).join()
  ok('预览顺序 = sort 升序', order === 'k1,k3,k2', order)
  ok('排序号原样写入 Schema', view.fields.every((f, i, arr) => i === 0 || arr[i - 1]!.sort <= f.sort))

  // 6.4 必填与校验规则生效
  ok('必填属性随 Schema 下发', view.fields.find((f) => f.fieldKey === 'k1')?.isRequired === 1)
  const lenErrs = validateForm({ schema: view, data: { k1: '这段文本超过五个字', k2: '2026-11-01' }, rows: [], attachments: [] })
  lenErrs.forEach((e) => observedCodes.add(e.code))
  ok('maxLength 规则生效（1004）', lenErrs.length === 1 && lenErrs[0]!.code === ERR.FORMAT && lenErrs[0]!.fieldKey === 'k1', JSON.stringify(lenErrs))
  ok('date 格式规则生效（1004）', validateForm({ schema: view, data: { k1: 'ok', k2: '2026/11/01' }, rows: [], attachments: [] }).some((e) => e.fieldKey === 'k2'))
  ok('正则规则生效（1004）', (() => {
    must200(api.template.fieldSave(tpl, { fieldKey: 'k5', fieldLabel: '字段五', fieldType: 'text', fieldConfig: { regex: '^\\d{6}$' } }))
    const s = must200(api.template.preview(tpl, 'V1.0', 'O11', 'U5'))
    return validateForm({ schema: s, data: { k1: 'ok', k2: '2026-11-01', k3: 1, k5: 'abc' }, rows: [], attachments: [] }).some((e) => e.fieldKey === 'k5')
  })())
  ok('可选字段留空不报错', validateForm({ schema: view, data: { k1: 'ok', k2: '', k3: null }, rows: [], attachments: [] }).length === 0)
  const missing = validateForm({ schema: view, data: { k1: '', k2: '', k3: null }, rows: [], attachments: [] })
  missing.forEach((e) => observedCodes.add(e.code))
  ok('必填缺失定位到具体字段（1003）', missing.length === 1 && missing[0]!.code === ERR.REQUIRED && missing[0]!.fieldKey === 'k1', JSON.stringify(missing))

  // 3.2 其五 / 7.3：字段停用为逻辑删除，排序调整即时生效
  must200(api.template.fieldSave(tpl, { fieldKey: 'k4', fieldLabel: '字段四', fieldType: 'text', sort: 30 }))
  must200(api.template.fieldRemove(k1.fieldId))
  ok('删除字段为逻辑删除', db.form_field.find((f) => f.fieldId === k1.fieldId)?.delFlag === 1)
  ok('删除后预览不再呈现', !must200(api.template.preview(tpl, 'V1.0', 'O11', 'U5')).fields.some((f) => f.fieldKey === 'k1'))
  must200(api.template.fieldMove(db.form_field.find((f) => f.templateId === tpl && f.fieldKey === 'k3')!.fieldId, 1))
  const moved = must200(api.template.preview(tpl, 'V1.0', 'O11', 'U5')).fields.map((f) => f.fieldKey).join()
  ok('上移/下移改变呈现顺序', moved.startsWith('k2,k3'), moved)

  // 3.2 状态管理：草稿与停用模板均不可下发
  const draftTask = { taskName: '不应成功', templateId: tpl, startTime: `${dayAt(-1)} 00:00:00`, endTime: `${dayAt(3)} 23:59:59`, auditType: 0 as const, auditNodes: [], singleRecordPerOrg: true, orgIds: ['O11'] }
  as('biz')
  expectCode('草稿模板不可创建任务（403）', api.task.create(draftTask), ERR.FORBIDDEN, '草稿')
  as('admin')
  must200(api.template.status(tpl, 2))
  as('biz')
  expectCode('停用模板不可创建任务（403）', api.task.create(draftTask), ERR.FORBIDDEN, '停用')
  dropTemplate(tpl)
})

/* ============================================ T02 差异规则生效 */

await section('T02', '差异规则生效（3.3 / 7.1）', () => {
  const reporter = who('rep_a')
  // 同一模板同一版本，按单位合并出三种视图
  const s11 = previewSchema(reporter, 'T1', 'V1.0', 'O11')
  const s12 = previewSchema(reporter, 'T1', 'V1.0', 'O12')
  const s13 = previewSchema(reporter, 'T1', 'V1.0', 'O13')
  const keys = (s: typeof s11) => s.fields.map((f) => f.fieldKey)

  ok('O11 保留责任人列', keys(s11).includes('owner'))
  ok('O12 隐藏责任人列（差异·隐藏）', !keys(s12).includes('owner') && s12.trace.some((t) => t.detail.includes('隐藏基础字段 owner')), keys(s12).join())
  ok('O12 备注改名为「困难及诉求」（差异·修改）', s12.fields.find((f) => f.fieldKey === 'remark')?.fieldLabel === '困难及诉求')
  ok('O12 备注长度上限改为 300', s12.fields.find((f) => f.fieldKey === 'remark')?.config.maxLength === 300)
  ok('O11 备注被收紧为必填', s11.fields.find((f) => f.fieldKey === 'remark')?.isRequired === 1)
  ok('O12 备注未收紧必填', s12.fields.find((f) => f.fieldKey === 'remark')?.isRequired === 0)
  ok('O11 独有单头字段 资金来源', s11.fields.some((f) => f.fieldKey === 'fundSource' && f.origin === 'diff-add'))
  ok('O13 独有明细列 研发投入占比', s13.fields.some((f) => f.fieldKey === 'rndRatio' && f.origin === 'diff-add' && f.config.scope === 'detail'))
  ok('O13 隐患类型收紧必填', s13.fields.find((f) => f.fieldKey === 'hazard')?.isRequired === 1)
  ok('差异新增字段排在末尾', keys(s13).at(-1) === 'rndRatio', keys(s13).join())
  ok('合并留痕包含四个阶段', new Set(s13.trace.map((t) => t.stage)).size === 4)
  ok('合并不修改基础模板数据（7.1）', db.form_field.filter((f) => f.templateId === 'T1' && f.version === 'V1.0' && f.delFlag === 0).length === 21)
  ok('三种视图字段集合互不相同', keys(s11) !== keys(s12) && keys(s12) !== keys(s13))

  // 真实登录身份下的单位视图（含权限裁决）
  ok('O13 填报人不呈现费用列（单位级 hidden）', !buildSchemaFor(who('rep_c'), task1()).fields.some((f) => f.fieldKey === 'riskFund'))
  ok('O11 填报人费用列只读（角色级 read）', buildSchemaFor(reporter, task1()).fields.find((f) => f.fieldKey === 'riskFund')?.permission === 'read')
})

/* ============================================ T03 差异规则批量复制 */

await section('T03', '差异规则批量复制（3.3 其四）', () => {
  as('admin')
  const tpl = must200(api.template.save({ templateName: 'T03 差异复制用例', templateDesc: '', bizType: '生产运营' }))
  must200(api.template.fieldSave(tpl, { fieldKey: 'c1', fieldLabel: '列一', fieldType: 'text', isRequired: 1, fieldConfig: { scope: 'header' } }))
  must200(api.diff.save({ templateId: tpl, orgId: 'O12', fieldKey: 'c1', diffType: 1, note: '源单位隐藏' }))
  must200(api.diff.save({ templateId: tpl, orgId: 'O12', fieldKey: 'c9', diffType: 3, fieldLabel: '备用', fieldType: 'text', scope: 'header' }))
  expectCode('差异新增字段标识冲突被拒绝（2002）', api.diff.save({ templateId: tpl, orgId: 'O12', fieldKey: 'c1', diffType: 3, fieldLabel: '冲突', fieldType: 'text' }), ERR.DUP_DIFF_KEY)

  const copied = must200(api.diff.copy('O12', ['O13', 'O11'], tpl))
  ok('复制条数 = 源规则数 × 目标单位数', copied === 4, String(copied))
  const norm = (orgId: ID) => must200(api.diff.list(tpl, orgId)).map((d) => `${d.fieldKey}:${d.diffType}`).sort().join()
  ok('目标单位规则与源单位一致', norm('O12') === norm('O13'), `${norm('O12')} != ${norm('O13')}`)

  // 复制后单独调整互不影响
  const target = must200(api.diff.list(tpl, 'O13')).find((d) => d.fieldKey === 'c1')!
  must200(api.diff.save({ diffId: target.diffId, templateId: tpl, orgId: 'O13', fieldKey: 'c1', diffType: 2, fieldLabel: '列一改过', isRequired: 0 }))
  ok('源单位仍为隐藏', !previewSchema(who('rep_a'), tpl, 'V1.0', 'O12').fields.some((f) => f.fieldKey === 'c1'))
  ok('目标单位改为修改属性', previewSchema(who('rep_a'), tpl, 'V1.0', 'O13').fields.find((f) => f.fieldKey === 'c1')?.fieldLabel === '列一改过')

  removeDiff(target.diffId)
  ok('删除规则后目标单位恢复母版呈现', previewSchema(who('rep_a'), tpl, 'V1.0', 'O13').fields.some((f) => f.fieldKey === 'c1'))
  ok('删除规则按条隔离，不影响其他单位', must200(api.diff.list(tpl, 'O12')).length === 2)

  // 同一单位对同一字段的多条规则以最后保存的为准（3.3）
  must200(api.diff.save({ templateId: tpl, orgId: 'O11', fieldKey: 'c1', diffType: 2, fieldLabel: '第一次', isRequired: 0 }))
  must200(api.diff.save({ templateId: tpl, orgId: 'O11', fieldKey: 'c1', diffType: 2, fieldLabel: '最后一次', isRequired: 1 }))
  const merged = previewSchema(who('rep_a'), tpl, 'V1.0', 'O11').fields.find((f) => f.fieldKey === 'c1')!
  ok('同字段多条规则按最后保存合并', merged.fieldLabel === '最后一次' && merged.isRequired === 1, JSON.stringify(merged))
  ok('合并留痕提示多条规则', previewSchema(who('rep_a'), tpl, 'V1.0', 'O11').trace.some((t) => t.detail.includes('多条规则')))
  dropTemplate(tpl)
})

/* ============================================ T04 字段权限裁决 */

await section('T04', '字段权限裁决（3.4 / 6.3）', () => {
  const t1 = task1()
  const reporter = buildSchemaFor(who('rep_a'), t1) // U5 O11/D11 填报员
  const finance = buildSchemaFor(who('rep_a2'), t1) // U8 O11/D13 财务部
  const tech = buildSchemaFor(who('rep_c'), t1) // U7 O13/D31 研发中心
  const auditor = buildSchemaFor(who('auditor'), t1) // U4 审核员

  // hidden：不创建组件、不占用布局位置
  ok('填报端 hidden 列不呈现', !reporter.fields.some((f) => f.fieldKey === 'budgetNote') && reporter.hiddenKeys.includes('budgetNote'))
  ok('审核端可见该敏感列（read）', auditor.fields.find((f) => f.fieldKey === 'budgetNote')?.permission === 'read')
  // read：只读呈现、不可改
  ok('审核端全部字段为 read', auditor.fields.every((f) => f.permission === 'read'))
  ok('审核端无 edit 字段', !auditor.fields.some((f) => f.permission === 'edit'))
  // edit：提供输入控件
  ok('填报端 hazard 可编辑', reporter.fields.find((f) => f.fieldKey === 'hazard')?.permission === 'edit')
  ok('财务部 hazard 被隐藏（部门级场景三）', !finance.fields.some((f) => f.fieldKey === 'hazard'))
  ok('财务部 riskFund 可编辑（跨部门分段填报）', finance.fields.find((f) => f.fieldKey === 'riskFund')?.permission === 'edit')
  ok('财务部 summary 只读', finance.fields.find((f) => f.fieldKey === 'summary')?.permission === 'read')
  ok('财务部 itemName 用户级只读', finance.fields.find((f) => f.fieldKey === 'itemName')?.permission === 'read')
  ok('O13 hazard 可编辑且必填', tech.fields.find((f) => f.fieldKey === 'hazard')?.permission === 'edit' && tech.fields.find((f) => f.fieldKey === 'hazard')?.isRequired === 1)
  // 系统赋值列强制只读（8.2 后端二次校验的基础）
  ok('系统赋值列一律只读', ['orgName', 'userName', 'deptName', 'reportDate'].every((k) => reporter.fields.find((f) => f.fieldKey === k)?.permission === 'read'))
  ok('序号列只读并标注系统值', reporter.fields.find((f) => f.fieldKey === 'seq')?.systemValue === 'seq')

  // 6.3：read 列不参与必填校验，避免只读列卡住提交
  ok('read 列必填属性归零', auditor.fields.find((f) => f.fieldKey === 'period')?.isRequired === 0)
  const blankData: Record<string, FieldValue> = {}
  auditor.fields.forEach((f) => {
    blankData[f.fieldKey] = ''
  })
  const errs = validateForm({ schema: auditor, data: blankData, rows: [], attachments: [] })
  ok('只读列留空不产生必填错误', !errs.some((e) => e.fieldKey === 'period'), JSON.stringify(errs))

  // 3.4 生效时点为表单加载时，裁决结果随 Schema 下发
  ok('裁决结果写入 trace', reporter.trace.some((t) => t.stage === 'permission' && t.detail.includes('riskFund') && t.detail.includes('只读')))
  ok('Schema 字段带 permission 属性', reporter.fields.every((f) => ['edit', 'read'].includes(f.permission)))
})

/* ============================================ T05 权限优先级 */

await section('T05', '权限优先级（7.2 / 2.6）', () => {
  const u5 = who('rep_a')
  const u8 = who('rep_a2')

  // 对象优先级：用户级 > 部门级 > 角色级 > 单位级
  const d1 = decidePerm('riskFund', u8, 'T1', 0)
  ok('部门级 edit 优先于角色级 read', d1.permType === 'edit' && d1.hit?.includes('部门') === true, JSON.stringify(d1))
  ok('全部命中规则均留痕', d1.matched.length === 2, d1.matched.join())
  const d2 = decidePerm('itemName', u8, 'T1', 1)
  ok('用户级规则优先命中', d2.permType === 'read' && d2.hit?.includes('用户') === true, JSON.stringify(d2))
  ok('用户级规则只作用于该用户', decidePerm('itemName', u5, 'T1', 1).permType === 'edit')

  // 隐藏优先：最低优先级的单位级 hidden 也必须终止裁决
  as('admin')
  must200(api.perm.save({ templateId: 'T1', fieldKey: 'itemName', targetType: 3, targetId: 'O11', permType: 'hidden', note: 'T05 临时规则' }))
  ok('hidden 命中即终止，压过用户级 read', decidePerm('itemName', u8, 'T1', 1).permType === 'hidden')
  ok('未受影响的字段保持原裁决', decidePerm('riskFund', u8, 'T1', 0).permType === 'edit')
  const temp = db.form_field_permission.find((p) => p.note === 'T05 临时规则' && p.permType === 'hidden' && p.delFlag === 0)!
  removePerm(temp.permId)
  ok('临时规则清理后回到用户级裁决', decidePerm('itemName', u8, 'T1', 1).permType === 'read')

  // read 命中且无 edit 冲突时生效
  must200(api.perm.save({ templateId: 'T1', fieldKey: 'planNum', targetType: 2, targetId: 'D11', permType: 'read', note: 'T05 临时规则' }))
  ok('部门级 read 生效', decidePerm('planNum', u5, 'T1', 1).permType === 'read')
  const temp2 = db.form_field_permission.find((p) => p.note === 'T05 临时规则' && p.permType === 'read' && p.delFlag === 0)!
  removePerm(temp2.permId)
  ok('删除规则后回到默认 edit', decidePerm('planNum', u5, 'T1', 1).permType === 'edit')

  // 无规则时返回 edit（2.6）
  ok('无规则字段默认 edit', decidePerm('lastCheck', u5, 'T1', 0).permType === 'edit' && decidePerm('lastCheck', u5, 'T1', 0).hit === undefined)
  // 7.2 尾注：规则变更按模板维度批量失效缓存
  ok('规则变更后重新加载的 Schema 立即反映', buildSchemaFor(u5, task1()).fields.find((f) => f.fieldKey === 'planNum')?.permission === 'edit')
})

/* ============================================ T06 任务范围控制 */

await section('T06', '任务范围控制（3.5 其二）', () => {
  const u7 = as('rep_c') // O13 不在 TASK-2 范围内
  const views = taskViewsFor(u7)
  ok('范围外单位任务列表不可见', !views.some((v) => v.taskId === 'TASK-2'))
  ok('范围内单位任务列表可见', views.some((v) => v.taskId === 'TASK-1'))
  ok('我的任务列表接口同样过滤范围外任务', !must200(api.task.myList(u7.userId)).some((v) => v.taskId === 'TASK-2'))
  expectCode('范围外加载表单被拒绝（1002）', api.form.load('TASK-2', 1, u7.userId), ERR.OUT_OF_SCOPE)
  expectCode('范围外提交接口被拒绝（1002）', api.record.submit('TASK-2', 1, { period: ym }, [{ itemName: '越界提交' }]), ERR.OUT_OF_SCOPE)
  expectCode('范围外草稿接口被拒绝（1002）', api.record.draft('TASK-2', 1, { period: ym }, []), ERR.OUT_OF_SCOPE)
  ok('范围外未产生填报记录', recordsOf('TASK-2', 'O13').length === 0)
  ok('下发范围接口返回 2 个单位', must200(api.task.scopes('TASK-2')).length === 2)

  // 10.2 表31：无填报角色不能调用写入接口
  as('auditor')
  expectCode('审核员直接调用提交接口被拒绝（403）', api.record.submit('TASK-1', 1, {}, []), ERR.FORBIDDEN, '无填报权限')
  ok('审核员待办列表只含待审核记录', must200(api.audit.todo(who('auditor').userId)).every((v) => v.recordStatus === 'submitted'))
  as('rep_a')
  ok('一单位一任务一条记录（7.6 默认）', recordsOf('TASK-1', 'O11').length === 1)
})

/* ============================================ T07 填报周期控制 */

await section('T07', '填报周期控制（3.5 其三 / 7.5）', () => {
  const u5 = as('rep_a')
  // 开始时间之前：待开始状态不可填报
  const v4 = taskViewsFor(u5).find((v) => v.taskId === 'TASK-4')!
  ok('待开始任务不可填报', v4.canFill === false && v4.reason.includes('尚未开始'), v4.reason)
  expectRejected('开始前提交被拒绝（1001）', api.record.submit('TASK-4', 1, { period: ym }, [{ itemName: 'x' }]), ERR.OUT_OF_WINDOW, '尚未开始')
  db.form_record = db.form_record.filter((r) => !(r.taskId === 'TASK-4' && r.orgId === 'O11'))

  // 截止时间之后：不可新增提交
  expectRejected('已归档任务提交被拒绝（1001）', api.record.submit('TASK-3', 1, { period: ym }, [{ itemName: 'x' }]), ERR.OUT_OF_WINDOW, '截止')
  ok('已归档任务的记录保持只读留存', recordOf('TASK-3', 'O11', 1)!.recordStatus === 'pass')

  // 草稿超过任务截止时间后转为不可编辑，数据保留
  as('biz')
  const tid = must200(api.task.create({
    taskName: 'T07 周期控制用例', templateId: 'T1', startTime: `${dayAt(-1)} 00:00:00`, endTime: `${dayAt(3)} 23:59:59`,
    auditType: 0, auditNodes: [], singleRecordPerOrg: true, orgIds: ['O11'],
  }))
  ok('窗口内任务由定时推进为进行中', db.form_task.find((t) => t.taskId === tid)!.status === 1)
  as('rep_a')
  const ctx = must200(api.form.load(tid, 1))
  const p = payloadOf(ctx, { data: { period: 'T07 草稿周期' } })
  ok('窗口内草稿保存成功', must200(api.record.draft(tid, 1, p.data, p.rows)).ok)
  const rec = recordOf(tid, 'O11', 1)!
  ok('草稿写入内存记录', rec.recordStatus === 'draft' && rec.data.period === 'T07 草稿周期', String(rec.data.period))

  // 模拟时间推进到截止之后（等价于定时任务扫描）
  db.form_task.find((t) => t.taskId === tid)!.endTime = `${dayAt(-1)} 23:59:59`
  must200(api.task.tick())
  ok('定时推进后任务转为已截止', db.form_task.find((t) => t.taskId === tid)!.status === 2)
  expectRejected('截止后保存草稿被拒绝（1001）', api.record.draft(tid, 1, { ...p.data, period: '截止后再写' }, p.rows), ERR.OUT_OF_WINDOW, '草稿转为只读')
  expectRejected('截止后提交被拒绝（1001）', api.record.submit(tid, 1, p.data, p.rows), ERR.OUT_OF_WINDOW, '截止')
  ok('草稿数据保留以便查阅（7.5）', recordOf(tid, 'O11', 1)!.data.period === 'T07 草稿周期', String(rec.data.period))
  ok('草稿被标记超期只读', recordOf(tid, 'O11', 1)!.data.__expiredReadonly === 1)
  ok('进入页面为只读呈现', must200(api.form.load(tid, 1, u5.userId, false)).readonly === true)
  ok('只读成因说明为任务已截止', must200(api.form.load(tid, 1, u5.userId, false)).readonlyReason.includes('截止'))
  ok('已提交数据超期后仍保留', recordOf('TASK-3', 'O11', 1)!.recordStatus === 'pass')
  releaseLock(tid, 'O11', u5.userId)
  dropTask(tid)
})

/* ============================================ T08 草稿与提交 */

await section('T08', '草稿与提交（3.6 / 6.4 / 8.2 其二）', () => {
  const u5 = as('rep_a')
  const ctx = must200(api.form.load('TASK-1', 1))
  const p = payloadOf(ctx, { rows: [{ itemName: '断言项目 1' }, { itemName: '断言项目 2' }] })

  // 3.6 草稿不进入汇总统计口径
  const prog = must200(api.summary.progress('TASK-1', who('biz').userId))
  const o11 = prog.rows.find((r) => r.orgId === 'O11')!
  ok('应填报数 = 下发单位数', prog.expected === scopeOrgs('TASK-1').length, String(prog.expected))
  ok('草稿单位识别为草稿', o11.status === '草稿' && prog.draft >= 1, o11.status)
  ok('草稿不计入审核通过数', prog.passed === scopeOrgs('TASK-1').filter((o) => recordOf('TASK-1', o.orgId, 1)?.recordStatus === 'pass').length)
  ok('应报 = 待审 + 通过 + 驳回 + 草稿 + 未报', prog.expected === prog.submitted + prog.passed + prog.rejected + prog.draft + prog.missing,
    `${prog.submitted}+${prog.passed}+${prog.rejected}+${prog.draft}+${prog.missing} vs ${prog.expected}`)

  // 6.4 四类校验与定位顺序（先单头后明细）
  const badHead = must200(api.form.validate('TASK-1', 1, { ...ctx.data, period: '' }, [{ ...p.rows[0]!, itemName: '' }, p.rows[1]!]))
  badHead.forEach((e) => observedCodes.add(e.code))
  ok('必填错误排在首位并定位到单头', badHead[0]?.code === ERR.REQUIRED && badHead[0]?.fieldKey === 'period' && badHead[0]?.row === 0, JSON.stringify(badHead[0]))
  ok('明细必填错误带行号', badHead.some((e) => e.fieldKey === 'itemName' && e.row === 1), JSON.stringify(badHead.map((e) => `${e.row}:${e.fieldKey}`)))
  const badFmt = must200(api.form.validate('TASK-1', 1, { ...ctx.data, contact: '123' }, p.rows))
  badFmt.forEach((e) => observedCodes.add(e.code))
  ok('格式校验（正则）生效并给出提示', badFmt.length === 1 && badFmt[0]!.code === ERR.FORMAT && badFmt[0]!.fieldKey === 'contact', JSON.stringify(badFmt))
  ok('数字类型校验生效', must200(api.form.validate('TASK-1', 1, ctx.data, [{ ...p.rows[0]!, planNum: 'abc' }, p.rows[1]!])).some((e) => e.fieldKey === 'planNum' && e.row === 1))
  ok('下拉非法取值校验生效', must200(api.form.validate('TASK-1', 1, ctx.data, [{ ...p.rows[0]!, status: '随便写' }, p.rows[1]!])).some((e) => e.fieldKey === 'status'))
  const dup = must200(api.form.validate('TASK-1', 1, ctx.data, [{ ...p.rows[0]!, itemName: '同名项目' }, { ...p.rows[1]!, itemName: '同名项目' }]))
  ok('业务唯一性校验生效（明细内重复）', dup.some((e) => e.fieldKey === 'itemName' && e.row === 2), JSON.stringify(dup.map((e) => `${e.row}:${e.message}`)))
  const emptyRow = Object.fromEntries(detailFields(ctx.schema).map((f) => [f.fieldKey, null]))
  ok('整行空白按未填报拦截', must200(api.form.validate('TASK-1', 1, ctx.data, [emptyRow])).some((e) => e.message.includes('至少需要填报一行')))

  // 附件类型与数量校验（3.9 → 6.4 其三）
  const fakeAtt = (fileType: string, fileSize: number): FormAttachment => ({
    delFlag: 0, attId: `X-${fileType}-${fileSize}`, recordId: 'RC1', fieldKey: 'evidence', fileName: `x.${fileType}`,
    filePath: 'minio://x', fileSize, fileType, uploadUser: 'U5', uploadTime: '',
  })
  const attErrs = validateForm({ schema: ctx.schema, data: ctx.data, rows: p.rows, attachments: [fakeAtt('exe', 1024), fakeAtt('pdf', 30 * 1024 * 1024)] })
  attErrs.forEach((e) => observedCodes.add(e.code))
  ok('附件类型与大小超限在校验中拦截（1005）', attErrs.length === 2 && attErrs.every((e) => e.code === ERR.ATTACH_LIMIT), JSON.stringify(attErrs.map((e) => e.message)))

  // 8.2 其二：提交接口逐字段比对 edit 权限
  expectCode('改写 read 列被拒绝（1007）', api.record.draft('TASK-1', 1, { ...ctx.data, riskFund: 999 }, p.rows), ERR.NO_FIELD_PERM, '安全费用')
  ok('被拒绝的写入未落库', recordOf('TASK-1', 'O11', 1)!.data.riskFund === 12.5, String(recordOf('TASK-1', 'O11', 1)!.data.riskFund))
  expectCode('改写 hidden 列被拒绝（1007）', api.record.draft('TASK-1', 1, p.data, [{ ...p.rows[0]!, budgetNote: '越权写入' }, p.rows[1]!]), ERR.NO_FIELD_PERM, 'budgetNote')
  ok('越权写入记录失败日志', db.form_oper_log.some((l) => l.operType === '填报提交' && l.result === 0 && l.content.includes('越权')))
  const sysTampered = must200(api.record.draft('TASK-1', 1, { ...p.data, orgName: '伪造单位' }, p.rows.map((r) => ({ ...r, seq: 999 }))))
  ok('系统赋值列由后端重算而非采信入参', sysTampered.ok)
  const stored = recordOf('TASK-1', 'O11', 1)!
  ok('单位名称取登录用户所属单位', stored.data.orgName === '城投分公司', String(stored.data.orgName))
  ok('明细序号按行号重算', Number(stored.rows[0]!.seq) === 1 && Number(stored.rows[1]!.seq) === 2, JSON.stringify(stored.rows.map((r) => r.seq)))
  ok('本单位不可见的列保留库存原值', stored.rows[0]!.budgetNote === '预留变更金 80 万', String(stored.rows[0]!.budgetNote))
  ok('表20 数字副本列落库（4.6 其一）', db.form_record_data.some((d) => d.recordId === 'RC1' && d.fieldKey === 'riskFund' && d.fieldValueNum === 12.5))
  ok('手动草稿保存留痕', db.form_oper_log.some((l) => l.operType === '草稿保存' && l.bizId === 'RC1'))

  // 7.5 自动保存仅在内容变化时触发，不刷屏写日志
  const logBefore = db.form_oper_log.length
  ok('自动保存返回成功', must200(api.record.draft('TASK-1', 1, p.data, p.rows, true)).ok)
  ok('自动保存不写操作日志', db.form_oper_log.length === logBefore, String(db.form_oper_log.length - logBefore))
  ok('自动保存不改变记录状态', recordOf('TASK-1', 'O11', 1)!.recordStatus === 'draft')

  // 3.6 提交成功：记录提交时间与提交人，表单转只读
  const submitted = must200(api.record.submit('TASK-1', 1, p.data, p.rows))
  ok('提交成功', submitted.ok && submitted.code === ERR.OK, submitted.message)
  ok('配置审核则进入待审核状态', stored.recordStatus === 'submitted' && stored.currentNode === 1)
  ok('提交时间与提交人落库', !!stored.submitTime && stored.userId === u5.userId)
  expectRejected('提交后保存草稿被拒绝（1006）', api.record.draft('TASK-1', 1, p.data, p.rows), ERR.DUPLICATE_SUBMIT)
  expectRejected('提交后重复提交被拒绝（1006）', api.record.submit('TASK-1', 1, p.data, p.rows), ERR.DUPLICATE_SUBMIT)
  ok('提交后表单为只读', must200(api.form.load('TASK-1', 1, u5.userId, false)).readonly === true)
  ok('只读成因说明为已提交待审', must200(api.form.load('TASK-1', 1, u5.userId, false)).readonlyReason.includes('已提交'))
  const view = taskViewsFor(u5).find((v) => v.taskId === 'TASK-1')!
  ok('任务列表分组为已提交', view.group === '已提交' && view.canFill === false)
  ok('提交后草稿状态从统计中移出', must200(api.summary.progress('TASK-1', who('biz').userId)).draft === 0)
})

/* ============================================ T09 审核流转 */

await section('T09', '审核流转（3.7）', () => {
  const u5 = who('rep_a')
  const rc1 = recordOf('TASK-1', 'O11', 1)!
  as('auditor')
  expectCode('驳回意见少于 5 字被拒绝（1003）', api.audit.operate('RC1', 'reject', '不同意'), ERR.REQUIRED)
  expectCode('非本节点审核人被拒绝（403）', api.audit.operate('RC1', 'pass', '', u5.userId), ERR.FORBIDDEN)
  ok('越权审核失败留痕（result=0）', db.form_oper_log.some((l) => l.operType === '审核操作' && l.bizId === 'RC1' && l.result === 0))
  expectCode('审核意见超长被拒绝（1004）', api.audit.operate('RC1', 'reject', '长'.repeat(501)), ERR.FORMAT)

  // 单级审核：驳回 → 意见可见 → 重新提交
  ok('驳回成功且退回填报人', must200(api.audit.operate('RC1', 'reject', '完成数量与台账不一致，请补充证明材料后重提。')).ok && rc1.recordStatus === 'reject' && rc1.currentNode === 0)
  ok('驳回意见随记录保存', rc1.auditOpinion?.includes('证明材料') === true)
  ok('填报人详情可见驳回意见', must200(api.record.detail('RC1', u5.userId)).record.auditOpinion?.includes('证明材料') === true)
  const rejected = taskViewsFor(u5).find((x) => x.taskId === 'TASK-1')!
  ok('驳回后分组为已驳回且可修改', rejected.group === '已驳回' && rejected.canFill)
  const ctx = must200(api.form.load('TASK-1', 1, u5.userId))
  ok('重提页面转为可编辑', ctx.readonly === false)
  as('rep_a')
  const p = payloadOf(ctx, { rows: [{ itemName: '断言项目 1' }, { itemName: '断言项目 2' }] })
  ok('驳回后重新提交成功', must200(api.record.submit('TASK-1', 1, p.data, p.rows)).ok && rc1.recordStatus === 'submitted')
  ok('重提清空上次驳回意见', rc1.auditOpinion === undefined)
  ok('重提次数累加', rc1.submitCount === 2, String(rc1.submitCount))

  // 单级审核：通过后数据进入汇总口径
  as('auditor')
  ok('审核通过并归档', must200(api.audit.operate('RC1', 'pass', '口径已核对，通过')).ok && rc1.recordStatus === 'pass' && rc1.currentNode === 0)
  expectCode('非待审核状态再次审核被拒绝（1008）', api.audit.operate('RC1', 'pass', ''), ERR.NODE_MISMATCH)
  ok('审核留痕按节点顺序记录', rc1.auditTrails.map((t) => `${t.nodeName}:${t.conclusion}`).join('→') === '集团业务管理部审核:reject→集团业务管理部审核:pass', JSON.stringify(rc1.auditTrails.map((t) => t.conclusion)))
  ok('留痕含审核人、时间、结论、意见', rc1.auditTrails.every((t) => t.userName && t.time && t.conclusion && t.opinion))
  ok('通过后填报端为只读归档', (() => {
    const v = taskViewsFor(u5).find((x) => x.taskId === 'TASK-1')!
    return v.group === '已归档' && !v.canFill
  })())

  // 3.7 结论不可修改，如需变更由管理员发起撤回并记录原因
  as('auditor')
  expectCode('非业务管理员不可撤回（403）', api.audit.revoke('RC1', '口径需复核'), ERR.FORBIDDEN)
  as('biz')
  expectCode('撤回必须填写原因（1003）', api.audit.revoke('RC1', '   '), ERR.REQUIRED)
  ok('管理员撤回成功回到草稿', must200(api.audit.revoke('RC1', '集团口径调整，需重新核对费用数据')).ok && rc1.recordStatus === 'draft')
  ok('撤回以 revoke 结论留痕', rc1.auditTrails.some((t) => t.conclusion === 'revoke' && t.opinion.includes('集团口径')))
  as('rep_a')
  ok('撤回后可修改并重新提交', must200(api.record.submit('TASK-1', 1, p.data, p.rows)).ok && rc1.recordStatus === 'submitted')

  // 多级审核：节点顺序流转，全部通过才生效
  as('biz')
  const mid = must200(api.task.create({
    taskName: 'T09 多级审核用例', templateId: 'T1', startTime: `${dayAt(-1)} 00:00:00`, endTime: `${dayAt(5)} 23:59:59`,
    auditType: 2, auditNodes: [{ nodeId: 'N1', nodeName: '子单位初审', userId: 'U6' }, { nodeId: 'N2', nodeName: '集团复审', roleCode: 'auditor' }],
    singleRecordPerOrg: true, orgIds: ['O11'],
  }))
  ok('多级审核节点按数组顺序编号', db.form_task.find((t) => t.taskId === mid)!.auditNodes.map((n) => n.seq).join() === '1,2')
  as('rep_a')
  const ctxM = must200(api.form.load(mid, 1))
  const pM = payloadOf(ctxM)
  const rcM = recordOf(mid, 'O11', 1)!
  ok('多级任务提交进入第一个节点', must200(api.record.submit(mid, 1, pM.data, pM.rows)).ok && rcM.currentNode === 1)
  as('auditor')
  expectCode('跳过前序节点直接审核被拒绝（403）', api.audit.operate(rcM.recordId, 'pass', ''), ERR.FORBIDDEN)
  ok('前序节点审核人待办可见该记录', must200(api.audit.todo(who('rep_b').userId)).some((v) => v.taskId === mid && v.nodeName === '子单位初审'))
  as('auditor2')
  expectCode('非当前节点审核人被拒绝（403）', api.audit.operate(rcM.recordId, 'pass', ''), ERR.FORBIDDEN)
  as('rep_b')
  ok('第一节点通过后仍停留待审', must200(api.audit.operate(rcM.recordId, 'pass', '初审无误')).ok && rcM.recordStatus === 'submitted' && rcM.currentNode === 2)
  ok('第一节点通过未计入通过数', must200(api.summary.progress(mid, who('biz').userId)).passed === 0)
  as('auditor')
  ok('末节点通过后数据生效', must200(api.audit.operate(rcM.recordId, 'pass', '复审通过')).ok && rcM.recordStatus === 'pass' && rcM.currentNode === 0)
  ok('多级留痕记录节点名称', rcM.auditTrails.map((t) => t.nodeName).join('→') === '子单位初审→集团复审')
  ok('全部节点通过后才计入通过数', must200(api.summary.progress(mid, who('biz').userId)).passed === 1)
  releaseLock(mid, 'O11', u5.userId)
  dropTask(mid)
})

/* ============================================ T10 模板版本兼容 */

await section('T10', '模板版本兼容（7.3）', () => {
  as('admin')
  const t1 = db.form_template.find((t) => t.templateId === 'T1')!
  const v1Count = must200(api.template.detail('T1', 'V1.0')).fields.length
  ok('初始版本 V1.0 含 21 个字段', t1.version === 'V1.0' && v1Count === 21, String(v1Count))

  const next = must200(api.template.publishVersion('T1', 'T10 用例：新增扩展编码列'))
  ok('发布后版本号递增', next === 'V1.1' && t1.version === 'V1.1', t1.version)
  ok('新版本整体复制当前字段', must200(api.template.detail('T1', 'V1.1')).fields.length === v1Count)
  ok('V1.0 字段定义保持不动', must200(api.template.detail('T1', 'V1.0')).fields.length === v1Count)
  ok('版本快照按生效版本留存且不重复', db.form_template_version.filter((v) => v.version === 'V1.1').length === 1 && db.form_template_version.filter((v) => v.version === 'V1.0').length === 1)
  ok('快照含字段/差异/权限三张配置表', (() => {
    const snap = db.form_template_version.find((v) => v.version === 'V1.1')!
    return snap.fields.length === v1Count && snap.diffs.length > 0 && snap.perms.length > 0
  })())

  must200(api.template.fieldSave('T1', { fieldKey: 'extCode', fieldLabel: '扩展编码', fieldType: 'text', fieldConfig: { scope: 'header' } }))
  const bnV11 = db.form_field.find((f) => f.templateId === 'T1' && f.fieldKey === 'budgetNote' && f.version === 'V1.1')!
  must200(api.template.fieldRemove(bnV11.fieldId))
  ok('字段停用仅作用于当前版本', db.form_field.find((f) => f.fieldId === bnV11.fieldId)!.delFlag === 1 && db.form_field.some((f) => f.fieldKey === 'budgetNote' && f.version === 'V1.0' && f.delFlag === 0))

  // 任务发布时冻结版本：在办任务不受影响
  ok('在办任务版本未被抬高', task1().templateVersion === 'V1.0')
  const fill = buildSchemaFor(who('rep_a'), task1())
  ok('在办任务 Schema 仍按 V1.0 构建', fill.templateVersion === 'V1.0')
  ok('新版本字段不进入在办任务', !fill.fields.some((f) => f.fieldKey === 'extCode'))

  // 历史记录按原版本呈现
  as('auditor')
  const detail = must200(api.record.detail('RC1'))
  ok('历史记录按记录自身版本呈现', detail.schema.templateVersion === 'V1.0' && detail.record.templateVersion === 'V1.0')
  ok('已停用字段在历史详情中仍呈现', detail.schema.fields.some((f) => f.fieldKey === 'budgetNote'))
  ok('历史字段值未丢失', Object.keys(detail.record.data).length > 0)

  // 新版本仅对新建任务生效
  as('biz')
  const nid = must200(api.task.create({
    taskName: 'T10 新版本任务', templateId: 'T1', startTime: `${dayAt(0)} 00:00:00`, endTime: `${dayAt(9)} 23:59:59`,
    auditType: 0, auditNodes: [], singleRecordPerOrg: true, orgIds: ['O11'],
  }))
  ok('新建任务绑定 V1.1', db.form_task.find((t) => t.taskId === nid)!.templateVersion === 'V1.1')
  ok('新版本字段对新任务生效', buildSchemaFor(who('rep_a'), db.form_task.find((t) => t.taskId === nid)!).fields.some((f) => f.fieldKey === 'extCode'))
  dropTask(nid)

  // 7.3 导出按历史版本呈现并标注「已停用字段」
  const table = buildWideTable(task1(), who('biz'), scopeOrgs('TASK-1').map((o) => o.orgId))
  ok('宽表标注已停用字段', table.columns.find((c) => c.key === 'budgetNote')?.deprecated === true)
  ok('新版本新增字段不进入旧版本导出', !table.columns.some((c) => c.key === 'extCode'))
  ok('导出表头标注已停用字段', buildWideCsv(task1(), who('biz'), table, '全部下发单位').includes('〔已停用字段〕'))
  ok('历史数据的停用字段值仍可导出', table.rows.some((r) => String(r.values.budgetNote ?? '').includes('预留变更金')))
})

/* ============================================ T11 汇总与导出 */

await section('T11', '汇总与导出（3.8 / 7.4 / 8.2 其三）', async () => {
  const u3 = as('biz')
  const t1 = task1()
  const orgIds = scopeOrgs('TASK-1').map((o) => o.orgId)
  const prog = must200(api.summary.progress('TASK-1'))

  // 3.8 进度统计口径
  ok('进度状态与记录实际状态一致', orgIds.every((o) => prog.rows.find((r) => r.orgId === o)!.status === statusText(recordOf('TASK-1', o, 1)?.recordStatus ?? 'none')),
    JSON.stringify(prog.rows.map((r) => `${r.orgName}:${r.status}`)))
  const o12 = prog.rows.find((r) => r.orgId === 'O12')!
  ok('完成率 = 完成合计 / 计划合计（四舍五入）', o12.planTotal === 31 && o12.finishTotal === 22 && o12.rate === 71, `${o12.planTotal}/${o12.finishTotal}/${o12.rate}`)
  ok('未填报数按无记录单位统计', prog.missing === orgIds.filter((o) => recordsOf('TASK-1', o).length === 0).length)
  ok('进度含五类计数', ['expected', 'submitted', 'passed', 'rejected', 'missing'].every((k) => typeof (prog as never as Record<string, number>)[k] === 'number'))

  // 3.8 宽表与筛选
  const table = buildWideTable(t1, u3, orgIds)
  const page = must200(api.summary.page('TASK-1', {}, { pageNum: 1, pageSize: 1 }))
  ok('行对应记录明细行（7.4 行转列）', page.total === table.rows.length, `${page.total} vs ${table.rows.length}`)
  ok('分页返回 total/pages/list（5.1）', page.list.length === 1 && page.pages === table.rows.length)
  ok('列顺序与模板字段顺序一致', table.columns.findIndex((c) => c.key === 'itemName') < table.columns.findIndex((c) => c.key === 'planNum'))
  ok('按单位筛选生效', must200(api.summary.page('TASK-1', { orgIds: ['O12'] })).list.every((r) => r.orgId === 'O12'))
  ok('按状态筛选生效', (() => {
    const r = must200(api.summary.page('TASK-1', { status: 'reject' }))
    return r.list.length > 0 && r.list.every((x) => x.status === '已驳回')
  })())
  ok('按提交时间区间筛选生效（无提交时间的行不参与）', (() => {
    const withSubmit = table.rows.filter((r) => recordOf('TASK-1', r.orgId, r.recordSeq)?.submitTime)
    return must200(api.summary.page('TASK-1', { submitFrom: '2000-01-01', submitTo: '2099-12-31' })).total === withSubmit.length
  })(), JSON.stringify(table.rows.map((r) => `${r.orgId}:${recordOf('TASK-1', r.orgId, r.recordSeq)?.submitTime ?? '-'}`)))
  ok('提交时间下界之外的行被过滤', must200(api.summary.page('TASK-1', { submitFrom: '2099-01-01' })).total === 0)
  ok('关键字检索命中明细列', must200(api.summary.page('TASK-1', { keyword: 'G204' })).list.every((r) => r.orgId === 'O12'))
  ok('关键字检索命中附件摘要（7.4）', (() => {
    const hit = must200(api.summary.page('TASK-1', { keyword: '监理确认单' }))
    return hit.total > 0 && hit.list.every((r) => String(r.values.evidence).includes('监理确认单'))
  })())
  ok('pageSize 上限 200（5.1）', (() => {
    const r = must200(api.log.page({ pageNum: 1, pageSize: 9999 }))
    return r.pages === Math.max(1, Math.ceil(r.total / 200))
  })())

  // 3.8 差异字段：单元格留空并标注适用单位范围
  const rnd = table.columns.find((c) => c.key === 'rndRatio')!
  ok('差异列标注适用单位', rnd.allOrgs === false && rnd.appliesTo.join() === 'O13')
  ok('公共列 allOrgs 为真', table.columns.find((c) => c.key === 'period')!.allOrgs === true)
  ok('隐藏列适用单位不含该单位', table.columns.find((c) => c.key === 'owner')!.appliesTo.join() === 'O11,O13')
  ok('改名形成多口径', table.columns.find((c) => c.key === 'remark')!.aliases.join() === '备注,困难及诉求')
  const o11Row = table.rows.find((r) => r.orgId === 'O11' && r.rowNo === 1)!
  ok('部分单位不存在的列留空', o11Row.values.rndRatio === '', String(o11Row.values.rndRatio))
  ok('附件列输出数量与文件名摘要（7.4）', String(table.rows.find((r) => r.orgId === 'O12')!.values.evidence).startsWith('2个：'))

  const csv = buildWideCsv(t1, u3, table, '单位：全部')
  const lines = csv.split('\r\n')
  ok('导出含表头说明与数据区（3.8）', lines[0]!.includes('任务：') && lines[6]!.includes('单位名称'), lines[0])
  ok('导出含水印与导出人（8.2 其三）', csv.includes('水印') && csv.includes('导出人：王芳'))
  ok('导出含模板版本与导出时间', csv.includes('模板版本：V1.0') && csv.includes('导出时间：'))
  ok('导出行数与页面宽表一致', lines.length === table.rows.length + 10, String(lines.length))
  ok('导出含差异字段适用标注', csv.includes('〔适用：数智科技公司〕'))
  ok('导出含多口径标注', csv.includes('〔口径：备注 / 困难及诉求〕'))
  ok('导出表头用中文标签不泄漏字段标识', !lines[6]!.includes('rndRatio') && !lines[6]!.includes('budgetNote'), lines[6])

  // CSV 公式注入防护
  const rc1 = recordOf('TASK-1', 'O11', 1)!
  const original = String(rc1.rows[0]!.itemName)
  rc1.rows[0]!.itemName = '=HYPERLINK("http://evil","x")'
  const evil = buildWideCsv(t1, u3, buildWideTable(t1, u3, orgIds), '注入用例')
  ok('CSV 公式注入被转义', evil.includes(`"'=HYPERLINK`))
  ok('CSV 内双引号转义为两个双引号', evil.includes('""'))
  rc1.rows[0]!.itemName = original

  // 3.8 同步导出（小数据量）与 7.4 异步阈值
  ok('异步阈值 5000 条 / 下载时效 30 分钟', ASYNC_THRESHOLD === 5000 && EXPORT_LINK_MINUTES === 30)
  const dlBefore = downloads.length
  must200(api.export.now('TASK-1', {}, 'progress'))
  must200(api.export.now('TASK-1', { orgIds: ['O12'] }, 'detail'))
  ok('同步导出触发文件下载', downloads.length === dlBefore + 2 && downloads.at(-1)!.name.endsWith('.csv'), JSON.stringify(downloads.slice(dlBefore)))
  ok('进度导出含完成率表头与五类计数', blobText(downloads[dlBefore]!.url).includes('完成率(%)') && blobText(downloads[dlBefore]!.url).includes('应填报 3'), blobText(downloads[dlBefore]!.url).slice(0, 200))

  // 3.8 异步导出：作业表 + 限时下载链接
  const { jobId } = must200(api.export.task('TASK-1', { orgIds: ['O12'] }))
  const running = must200(api.export.jobs()).find((j) => j.jobId === jobId)!
  ok('作业初始状态为运行中且含筛选快照', running.status === 'running' && running.filters.includes('交通工程公司'))
  await sleep(400)
  const done = must200(api.export.jobs()).find((j) => j.jobId === jobId)!
  ok('作业完成后带文件名与行数', done.status === 'done' && done.rows === 2 && !!done.fileName, `${done.status}/${done.rows}`)
  ok('异步内容与筛选范围一致（仅本单位行）', (done.content ?? '').includes('G204 桥梁加固') && !(done.content ?? '').includes('城东大道雨污分流改造'))
  ok('异步内容含水印与导出人（8.2 其三）', (done.content ?? '').includes('水印') && (done.content ?? '').includes('导出人：'))
  ok('完成后签发限时下载链接', !!done.download && done.download.url.startsWith('blob:') && done.download.expireAt > Date.now())
  const dlCount = downloads.length
  must200(api.export.download(done.download!.token))
  ok('凭证有效时可下载', downloads.length === dlCount + 1 && downloads.at(-1)!.name === done.fileName)
  expectCode('无效凭证下载失败（404）', api.export.download('EXP-NOT-EXIST'), ERR.NOT_FOUND)
  ok('导出作业留痕两类（发起 + 完成）', db.form_oper_log.filter((l) => l.operType === '数据导出' && l.bizId === 'TASK-1').length >= 2)

  as('auditor')
  expectCode('审核员不可发起导出作业（403）', api.export.task('TASK-1', {}), ERR.FORBIDDEN)
  as('rep_a')
  expectCode('填报员不可查看汇总宽表（403）', api.summary.page('TASK-1'), ERR.FORBIDDEN)
  expectCode('填报员不可立即导出（403）', api.export.now('TASK-1', {}, 'detail'), ERR.FORBIDDEN)
})

/* ============================================ T12 附件管理 */

await section('T12', '附件管理（3.9 / 8.2 其四）', () => {
  const u7 = as('rep_c')
  const cfg = buildSchemaFor(u7, task1()).fields.find((f) => f.fieldKey === 'evidence')!.config
  const limit = { accept: cfg.accept ?? [], maxSize: cfg.maxSize ?? 20, maxCount: cfg.maxCount ?? 5 }
  ok('限制项取自字段配置（表6）', limit.accept.includes('.pdf') && limit.maxCount === 5 && limit.maxSize === 20)

  const rc3 = recordOf('TASK-1', 'O13', 1)!
  ok('被驳回记录的附件可继续维护', rc3.recordStatus === 'reject')
  expectCode('可执行扩展名被拒绝（1005）', api.attachment.upload(rc3.recordId, 'evidence', { name: 'a.exe', size: 1024, type: 'application/octet-stream' }, limit), ERR.ATTACH_LIMIT, '可执行')
  expectCode('可执行内容类型被拒绝（1005）', api.attachment.upload(rc3.recordId, 'evidence', { name: 'b.pdf', size: 1024, type: 'application/x-msdownload' }, limit), ERR.ATTACH_LIMIT, '内容类型')
  expectCode('文件头与扩展名不符被拒绝（1005）', api.attachment.upload(rc3.recordId, 'evidence', { name: 'c.pdf', size: 1024, type: 'application/pdf' }, limit, 'data:application/pdf;base64,TVpVSUZMTkVXT1JL'), ERR.ATTACH_LIMIT, '文件头')
  expectCode('未批准类型被拒绝（1005）', api.attachment.upload(rc3.recordId, 'evidence', { name: 'd.txt', size: 1024, type: 'text/plain' }, limit), ERR.ATTACH_LIMIT, '不在允许范围')
  expectCode('超过单文件大小被拒绝（1005）', api.attachment.upload(rc3.recordId, 'evidence', { name: 'e.pdf', size: 30 * 1024 * 1024, type: 'application/pdf' }, limit), ERR.ATTACH_LIMIT, '30.00MB')
  ok('超限附件未落库', must200(api.attachment.list(rc3.recordId, 'evidence')).length === 0)

  for (let i = 1; i <= limit.maxCount; i += 1) {
    must200(api.attachment.upload(rc3.recordId, 'evidence', { name: `凭证${i}.pdf`, size: 2048, type: 'application/pdf' }, limit))
  }
  expectCode('超过数量上限被拒绝（1005）', api.attachment.upload(rc3.recordId, 'evidence', { name: '凭证6.pdf', size: 2048, type: 'application/pdf' }, limit), ERR.ATTACH_LIMIT, '最多 5 个')

  const first = must200(api.attachment.list(rc3.recordId, 'evidence'))[0]!
  ok('库内只存文件标识与访问路径（3.9）', first.filePath.startsWith('minio://') && !first.filePath.includes('http'), first.filePath)
  ok('附件与记录、字段标识绑定', first.recordId === rc3.recordId && first.fieldKey === 'evidence')
  ok('同一字段可上传多个文件', must200(api.attachment.list(rc3.recordId, 'evidence')).length === 5)
  must200(api.attachment.remove(first.attId, true))
  ok('提交前可删除，删除为标记删除', db.form_attachment.find((a) => a.attId === first.attId)!.delFlag === 1 && must200(api.attachment.list(rc3.recordId, 'evidence')).length === 4)
  ok('附件变更留痕', db.form_oper_log.some((l) => l.operType === '附件变更' && l.content.includes(first.fileName)))
  ok('数量上限按未删除计数', must200(api.attachment.upload(rc3.recordId, 'evidence', { name: '补传.pdf', size: 1024, type: 'application/pdf' }, limit)).fileName === '补传.pdf')

  // 3.9 提交后附件随表单转为只读
  expectCode('已提交记录禁止上传附件（403）', api.attachment.upload('RC2', 'evidence', { name: 'x.pdf', size: 1024, type: 'application/pdf' }, limit), ERR.FORBIDDEN, '只读')
  expectCode('已提交记录禁止删除附件（403）', api.attachment.remove('AT-1', false), ERR.FORBIDDEN)

  // 8.2 其四：下载链接为短时凭证
  as('auditor')
  const dl = must200(api.attachment.download('AT-1'))
  ok('审核人可下载查看附件', dl.url.startsWith('blob:') && dl.token.startsWith('AT-1-'))
  ok('签发凭证默认 5 分钟有效', dl.expireAt - Date.now() > 4 * 60_000 && dl.expireAt - Date.now() <= 5 * 60_000, String(dl.expireAt - Date.now()))
  expectThrow('有效期内凭证可用（不抛异常）', () => consumeDownload(dl.token), ERR.OK)
  expectThrow('链接超时后失效（1010）', () => consumeDownload(must200(api.attachment.download('AT-1', -1)).token), ERR.LINK_EXPIRED)
  expectCode('不存在的附件下载（404）', api.attachment.download('AT-NONE'), ERR.NOT_FOUND)
  expectCode('已删除附件不可下载（404）', api.attachment.download(first.attId), ERR.NOT_FOUND)
  ok('下载链接不暴露存储路径', !must200(api.attachment.download('AT-2')).url.includes('minio://'))
  ok('附件下载留痕', db.form_oper_log.some((l) => l.operType === '附件下载' && l.bizId.startsWith('AT-')))
})

/* ============================================ T13 并发填写 */

await section('T13', '并发填写（7.5）', () => {
  const u5 = as('rep_a')
  const u8 = who('rep_a2')
  db.edit_lock.length = 0
  const recordsBefore = db.form_record.length

  must200(api.form.load('TASK-1', 1, u5.userId))
  ok('首个会话取得写锁', lockHolder('TASK-1', 'O11') === u5.realName, String(lockHolder('TASK-1', 'O11')))
  ok('锁超时时间为 30 秒', LOCK_TTL === 30_000)
  expectCode('同单位他人进入被提示占用（1009）', api.form.load('TASK-1', 1, u8.userId), ERR.LOCKED, '正在编辑中')
  ok('占用时可只读进入', must200(api.form.load('TASK-1', 1, u8.userId, false)).readonly === true)
  ok('占用时载入报出占用提示文案', (() => {
    const r = api.form.load('TASK-1', 1, u8.userId)
    return r.code === ERR.LOCKED && r.msg.includes('锁 30 秒后自动释放')
  })())
  ok('同一用户重复进入放行（锁可重入）', must200(api.form.load('TASK-1', 1, u5.userId)).record.recordId === 'RC1')
  ok('不产生重复记录（7.5 数据层兜底）', db.form_record.length === recordsBefore && recordsOf('TASK-1', 'O11').length === 1)

  const state = must200(api.record.lockState('TASK-1', 'O11'))
  ok('锁状态查询返回持有人与 TTL', state.holder === u5.realName && state.ttl === LOCK_TTL)
  ok('持有人心跳续期', must200(api.record.heartbeat('TASK-1')) === u5.realName)
  as('rep_a2')
  ok('非持有人心跳不改变持有人', must200(api.record.heartbeat('TASK-1')) === u5.realName && lockHolder('TASK-1', 'O11') === u5.realName)
  as('rep_a')

  // 锁 30 秒后自动释放（此处直接把到期时间提前，等价于等待超时）
  const lock = db.edit_lock.find((l) => l.key === 'TASK-1__O11')!
  lock.expireAt = Date.now() - 1
  ok('锁超时自动释放且他人可取得', must200(api.form.load('TASK-1', 1, u8.userId)).record.recordId === 'RC1' && lockHolder('TASK-1', 'O11') === u8.realName)
  releaseLock('TASK-1', 'O11', u8.userId)
  ok('显式释放后无人持有', lockHolder('TASK-1', 'O11') === null)
  ok('提交后释放写锁', (() => {
    // 3.7 已提交记录需先由管理员撤回才能回到可提交状态，再验证提交动作释放锁
    as('biz')
    must200(api.audit.revoke('RC1', '并发用例：验证提交后释放写锁'))
    as('rep_a')
    const ctxSub = must200(api.form.load('TASK-1', 1, u5.userId))
    ok('撤回后载入重新取得写锁', lockHolder('TASK-1', 'O11') === u5.realName, String(lockHolder('TASK-1', 'O11')))
    const pSub = payloadOf(ctxSub, { rows: [{ itemName: '断言项目 1' }, { itemName: '断言项目 2' }] })
    ok('撤回后可重新提交', must200(api.record.submit('TASK-1', 1, pSub.data, pSub.rows)).ok)
    return lockHolder('TASK-1', 'O11') === null
  })())
  ok('全流程仍只有一条记录', recordsOf('TASK-1', 'O11').length === 1 && db.form_record.length === recordsBefore)

  // 7.6 一单位一记录「允许多个部门协同填写同一记录」：记录创建人不构成只读理由，互斥交给写锁
  as('rep_a2')
  const ctxCo = must200(api.form.load('TASK-1', 1))
  ok('同单位非创建人进入为可编辑视角（7.6）', ctxCo.readonly === false && ctxCo.record.userId !== u8.userId, ctxCo.readonlyReason)
  ok('协同填写仍受字段权限约束（只放开本部门 edit 列）', detailFields(ctxCo.schema).some(isEditable) && !!detailFields(ctxCo.schema).find((f) => f.fieldKey === 'itemName' && !isEditable(f)))
  const pCo = payloadOf(ctxCo, { rows: [{ remark: '财务部补充口径' }] })
  ok('协同保存到同一条记录', must200(api.record.draft('TASK-1', 1, pCo.data, pCo.rows)).ok && recordOf('TASK-1', 'O11', 1)!.recordId === 'RC1')
  as('rep_a')
  expectCode('锁在他人手上时写入被拒（1009）', api.record.draft('TASK-1', 1, pCo.data, pCo.rows), ERR.LOCKED, '正在编辑中')
  ok('被拒的越权会话未落库', recordOf('TASK-1', 'O11', 1)!.userId === u8.userId)
  releaseLock('TASK-1', 'O11', u8.userId)
})

/* ============================================ T14 日志留痕 */

await section('T14', '日志留痕（3.10 / 8.2 其五）', () => {
  as('sysadmin')
  const snapshot = new Set(db.form_oper_log.map((l) => l.logId))

  const byTask = must200(api.log.page({ bizId: 'TASK-1', pageNum: 1, pageSize: 200 }))
  ok('按业务对象可回溯', byTask.total > 0 && byTask.list.every((l) => l.bizId === 'TASK-1'), String(byTask.total))
  const byRecord = must200(api.log.page({ bizId: 'RC1' }))
  const types = new Set(byRecord.list.map((l) => l.operType))
  ok('一条记录可回溯草稿/提交/审核/撤回全链路', ['草稿保存', '填报提交', '审核操作', '管理员撤回'].every((t) => types.has(t as (typeof OPER_TYPE)[keyof typeof OPER_TYPE])), [...types].join())
  ok('失败操作同样留痕（result=0）', db.form_oper_log.some((l) => l.result === 0 && l.content.includes('越权')))
  const logOk = (l: (typeof byRecord.list)[number]) =>
    !!l.userId && !!l.orgId && /^\d+\.\d+\.\d+\.\d+$/.test(l.ip) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(l.operTime) && (l.result === 0 || l.result === 1)
  ok('日志含操作人、单位、来源地址、时间、结果', byRecord.list.every(logOk), JSON.stringify(byRecord.list.find((l) => !logOk(l))))
  const todayLogs = db.form_oper_log.filter((l) => l.operTime >= `${dayAt(0)} 00:00:00` && l.operTime <= `${dayAt(0)} 23:59:59`)
  ok('当日边界检索与本地比对一致', must200(api.log.page({ from: `${dayAt(0)} 00:00:00`, to: `${dayAt(0)} 23:59:59` })).total === todayLogs.length,
    `当日 ${todayLogs.length} 条，样本 ${todayLogs[0]?.operTime ?? '无'} / 库内最新 ${db.form_oper_log[0]?.operTime ?? '无'}`)
  ok('按操作类型检索', must200(api.log.page({ operType: '审核操作' })).list.every((l) => l.operType === '审核操作'))
  ok('按操作人检索', must200(api.log.page({ userId: 'U4' })).list.every((l) => l.userId === 'U4'))
  ok('按内容关键字检索', must200(api.log.page({ keyword: '撤回' })).total > 0)
  ok('按时间区间检索命中当日记录', todayLogs.length > 0, String(todayLogs.length))
  ok('全区间检索等于总量', must200(api.log.page({ from: '2000-01-01 00:00:00', to: '2099-12-31 23:59:59' })).total === db.form_oper_log.length)

  // 3.10 八类行为全覆盖（本表把「数据导出」与「附件下载」分列，共 11 类取值）
  const eight = ['登录', '模板变更', '差异与权限配置变更', '任务下发', '草稿保存', '填报提交', '审核操作']
  ok('八类行为全部留痕', eight.every((t) => db.form_oper_log.some((l) => l.operType === t))
    && db.form_oper_log.some((l) => l.operType === '数据导出') && db.form_oper_log.some((l) => l.operType === '附件下载'),
  JSON.stringify([...new Set(db.form_oper_log.map((l) => l.operType))]))
  ok('留痕类型取值合法', db.form_oper_log.every((l) => Object.values(OPER_TYPE).includes(l.operType)))

  // 3.10 日志只追加，界面不提供删除
  ok('接口层仅提供查询能力', Object.keys(api.log).join() === 'page', Object.keys(api.log).join())
  ok('无删除/清空/修改方法', !('remove' in api.log) && !('clear' in api.log) && !('delete' in api.log) && !('update' in api.log))
  as('admin') // 任意写操作都应只追加
  ok('新操作不覆盖既有日志', db.form_oper_log.length > snapshot.size && [...snapshot].every((id) => db.form_oper_log.some((l) => l.logId === id)))
  ok('日志按时间倒序呈现', db.form_oper_log[0]!.operTime >= db.form_oper_log.at(-1)!.operTime)
})

/* ==================================== 10.2 表31 权限矩阵 + 第 5 章接口契约 */

await section('M', '权限矩阵与接口契约（10.2 / 第 5 章）', () => {
  const audit = permMatrixAudit()
  ok('表31 共 5 行 × 5 角色 = 25 格', audit.length === 25, String(audit.length))
  const drift = audit.filter((m) => !m.ok)
  ok('矩阵声明与实际功能权限逐格一致', drift.length === 0, JSON.stringify(drift))

  as('sysadmin')
  expectCode('系统管理员不可填报（403）', api.record.submit('TASK-1', 1, {}, []), ERR.FORBIDDEN)
  ok('系统管理员可维护组织与查看日志', must200(api.org.tree()).length > 0 && must200(api.log.page({ pageNum: 1, pageSize: 1 })).total >= 1)
  expectCode('系统管理员不可维护字段（403）', api.template.fieldSave('T1', { fieldKey: 'zz', fieldLabel: 'zz' }), ERR.FORBIDDEN)

  as('admin')
  expectCode('表单管理员不可下发任务（403）', api.task.create({
    taskName: '不应成功', templateId: 'T1', startTime: `${dayAt(0)} 00:00:00`, endTime: `${dayAt(3)} 23:59:59`,
    auditType: 0, auditNodes: [], singleRecordPerOrg: true, orgIds: ['O11'],
  }), ERR.FORBIDDEN, '创建任务')
  expectCode('表单管理员不可填报（403）', api.record.draft('TASK-1', 1, {}, []), ERR.FORBIDDEN)
  ok('表单管理员可维护模板', must200(api.template.detail('T1')).template.templateId === 'T1')

  as('biz')
  expectCode('业务管理员不可维护模板字段（403）', api.template.fieldSave('T1', { fieldKey: 'zz', fieldLabel: 'zz' }), ERR.FORBIDDEN)
  expectCode('业务管理员不可填报（403）', api.record.draft('TASK-1', 1, {}, []), ERR.FORBIDDEN)
  ok('业务管理员可下发任务与汇总', must200(api.task.scopes('TASK-1')).length === 3 && must200(api.summary.progress('TASK-1')).expected === 3)
  ok('业务管理员审核为查看档（无待办操作权）', must200(api.audit.todo(who('biz').userId)).every((v) => v.todo))

  as('rep_a')
  expectCode('填报员不可撤回审核（403）', api.audit.revoke('RC1', '越权撤回'), ERR.FORBIDDEN)
  ok('填报员审核待办为空', must200(api.audit.todo(who('rep_a').userId)).length === 0)
  ok('填报员可填报（edit）', must200(api.form.load('TASK-1', 1, who('rep_a').userId, false)).schema.fields.some((f) => f.permission === 'edit'))

  as('auditor')
  ok('审核员填报呈现为只读', buildSchemaFor(who('auditor'), task1()).fields.every((f) => f.permission === 'read'))
  ok('审核员可查看汇总（查看档）', must200(api.summary.progress('TASK-1')).expected === 3)
  expectCode('审核员不可发起导出（编辑档才有）', api.export.task('TASK-1', {}), ERR.FORBIDDEN)

  // 5.1 统一响应结构 code / msg / data
  const err = api.record.submit('TASK-2', 1, {}, [])
  ok('非 200 时 msg 可直接展示且 data 为 null', err.code !== 200 && err.msg.length > 0 && err.data === null, JSON.stringify(err))
  expectCode('未登录访问被拒绝（401）', (logout(), api.summary.workbench()), ERR.UNAUTHORIZED)
  expectCode('账号或密码错误（401）', api.auth.login('rep_a', 'wrong'), ERR.UNAUTHORIZED)
  as('rep_a')
  expectCode('对象不存在（404）', api.record.detail('RC-NONE'), ERR.NOT_FOUND)

  const TABLE25 = [401, 403, 404, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 2001, 2002]
  const missed = TABLE25.filter((c) => !observedCodes.has(c))
  ok('表25 全部错误码在断言中被触发', missed.length === 0, `未触发：${missed.join()}`)
  ok('每个错误码都有可读文案', TABLE25.every((c) => !!ERR_MSG[c]))

  // 5.3.1 Schema 缓存与失效（用从未加载过的用户/单位组合验证首次未命中）
  const first = must200(api.form.load('TASK-1', 1, who('rep_c').userId, false))
  const second = must200(api.form.load('TASK-1', 1, who('rep_c').userId, false))
  ok('首次构建后再次加载命中缓存（6.5 / 5.3.1）', first.fromCache === false && second.fromCache === true, `${first.fromCache}/${second.fromCache}`)
  as('admin')
  must200(api.perm.save({ templateId: 'T1', fieldKey: 'planNum', targetType: 1, targetId: 'R4', permType: 'read', note: 'M 临时规则' }))
  ok('规则变更后缓存按模板维度失效（7.2）', must200(api.form.load('TASK-1', 1, who('rep_a').userId, false)).fromCache === false)
  const temp = db.form_field_permission.find((p) => p.note === 'M 临时规则' && p.delFlag === 0)!
  removePerm(temp.permId)
  ok('缓存内不含过期权限', must200(api.form.load('TASK-1', 1, who('rep_a').userId, false)).schema.fields.find((f) => f.fieldKey === 'planNum')?.permission === 'edit')

  // 6.2 Schema 契约
  const s = must200(api.form.load('TASK-1', 1, who('rep_a').userId, false)).schema
  ok('Schema 为扁平结构且属性齐备', s.fields.every((f) => !!f.fieldKey && !!f.fieldLabel && !!f.fieldType && !!f.permission && !!f.config && !!f.origin))
  ok('Schema 顶层含 taskId/taskName/templateVersion/fields', !!s.taskId && !!s.taskName && /^V\d+\.\d+$/.test(s.templateVersion) && s.fields.length > 0)
  ok('系统赋值列标注与种子一致', s.fields.filter((f) => f.systemValue).every((f) => SYSTEM_VALUES[f.fieldKey] === f.systemValue))
  ok('表20 按字段逐行投影（4.4）', (() => {
    const rows = toRecordData(recordOf('TASK-1', 'O11', 1)!)
    return rows.length > 0 && rows.every((r) => r.recordId === 'RC1' && !!r.fieldKey && typeof r.fieldValue === 'string')
  })())
  ok('9.4 基础字典可读', must200(api.dict.of('BIZ_TYPE')).length === 4)
})

console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====`)
process.exitCode = failed ? 1 : 0
