/**
 * 9.4 数据初始化 —— 组织树、部门、角色、账号、字典、模板、差异规则、权限规则、任务与历史填报。
 * 日期相对当天生成，保证任何时候打开原型都有「进行中」的任务可填。
 */
import type {
  DiffType,
  FieldConfig,
  FieldType,
  FormField,
  FormOrgDiff,
  FormRecord,
  FormTemplate,
  FormTask,
  PermType,
  SysDept,
  SysOrg,
  SysRole,
  SysUser,
  TargetType,
} from './types'
import type { Database } from './db'

const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const now = new Date()
const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
const monthFirst = `${ym}-01`
const monthLast = `${ym}-${pad(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`
const dayAt = (offset: number) => fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset))
const stamp = (offset: number, hm = '09:30') => `${dayAt(offset)} ${hm}`

const AUD = { delFlag: 0 as const }

/* ------------------------------------------------ 表10 sys_role */

const ROLES: SysRole[] = (
  [
    { roleId: 'R1', roleName: '系统管理员', roleCode: 'sys_admin', roleType: 1, remark: '维护组织、用户、角色与日志审计' },
    { roleId: 'R2', roleName: '表单管理员', roleCode: 'template_admin', roleType: 1, remark: '维护模板、字段、差异规则与字段权限' },
    { roleId: 'R3', roleName: '业务部门管理员', roleCode: 'biz_admin', roleType: 1, remark: '创建与下发任务、汇总导出、审核查看' },
    { roleId: 'R4', roleName: '填报员', roleCode: 'reporter', roleType: 2, remark: '按本单位视图在线填报' },
    { roleId: 'R5', roleName: '审核员', roleCode: 'auditor', roleType: 2, remark: '审核填报内容，全程只读' },
  ] satisfies Omit<SysRole, 'delFlag' | 'status'>[]
).map((r) => ({ ...AUD, ...r, status: 1 as const }))

/* -------------------------------------------- 表8 sys_org / 表9 sys_dept */

const ORGS: SysOrg[] = (
  [
    { orgId: 'O1', orgName: '华东建设集团', orgCode: 'HDJT', parentId: '0', orgLevel: 1, sort: 1 },
    { orgId: 'O11', orgName: '城投分公司', orgCode: 'CTFG', parentId: 'O1', orgLevel: 2, sort: 2 },
    { orgId: 'O12', orgName: '交通工程公司', orgCode: 'JTGC', parentId: 'O1', orgLevel: 2, sort: 3 },
    { orgId: 'O13', orgName: '数智科技公司', orgCode: 'SZKJ', parentId: 'O1', orgLevel: 2, sort: 4 },
    { orgId: 'O111', orgName: '城投第一项目部', orgCode: 'CT01', parentId: 'O11', orgLevel: 3, sort: 5 },
  ] satisfies Omit<SysOrg, 'delFlag' | 'status'>[]
).map((o) => ({ ...AUD, ...o, status: 1 as const }))

const DEPTS: SysDept[] = (
  [
    { deptId: 'D11', deptName: '工程管理部', orgId: 'O11', sort: 1 },
    { deptId: 'D12', deptName: '安全环保部', orgId: 'O11', sort: 2 },
    { deptId: 'D13', deptName: '财务部', orgId: 'O11', sort: 3 },
    { deptId: 'D21', deptName: '工程管理部', orgId: 'O12', sort: 1 },
    { deptId: 'D22', deptName: '安全环保部', orgId: 'O12', sort: 2 },
    { deptId: 'D31', deptName: '研发中心', orgId: 'O13', sort: 1 },
    { deptId: 'D32', deptName: '财务部', orgId: 'O13', sort: 2 },
    { deptId: 'D01', deptName: '业务管理部', orgId: 'O1', sort: 1 },
  ] satisfies Omit<SysDept, 'delFlag' | 'status' | 'parentId'>[]
).map((d) => ({ ...AUD, ...d, parentId: '0', status: 1 as const }))

/* --------------------------------------------- 表11 sys_user + 表12 */

function user(
  userId: string,
  username: string,
  realName: string,
  orgId: string,
  deptId: string,
  mobile: string,
  roleIds: string[],
): SysUser {
  return { ...AUD, userId, username, password: '123456', realName, orgId, deptId, mobile, status: 1, roleIds }
}

const USERS: SysUser[] = [
  user('U1', 'sysadmin', '周敏', 'O1', 'D01', '13800000001', ['R1']),
  user('U2', 'admin', '张明', 'O1', 'D01', '13800000002', ['R2']),
  user('U3', 'biz', '王芳', 'O1', 'D01', '13800000003', ['R3']),
  user('U4', 'auditor', '李强', 'O1', 'D01', '13800000004', ['R5']),
  user('U5', 'rep_a', '陈涛', 'O11', 'D11', '13900000001', ['R4']),
  // 3.1 一个用户可同时具备填报与审核角色
  user('U6', 'rep_b', '刘丽', 'O12', 'D21', '13900000002', ['R4', 'R5']),
  user('U7', 'rep_c', '赵磊', 'O13', 'D31', '13900000003', ['R4']),
  // 用于演示部门级权限与并发编辑占用
  user('U8', 'rep_a2', '孙悦', 'O11', 'D13', '13900000004', ['R4']),
  user('U9', 'auditor2', '何俊', 'O1', 'D01', '13800000005', ['R5']),
]

/* -------------------------------------- 表6 form_template / 表7 form_field */

const TPL: FormTemplate = {
  ...AUD,
  templateId: 'T1',
  templateName: '项目任务月度完成情况填报表',
  templateDesc: '各子单位按月报送在建项目任务完成情况、安全隐患与费用提取情况，明细区一行一个项目。',
  bizType: '生产运营',
  version: 'V1.0',
  createOrgId: 'O1',
  status: 1,
}

let fieldSeq = 0
let sortCursor = { header: 0, detail: 0 }

function field(
  scope: 'header' | 'detail',
  fieldKey: string,
  fieldLabel: string,
  fieldType: FieldType,
  isRequired: 0 | 1,
  fieldConfig: FieldConfig = {},
): FormField {
  sortCursor[scope] += 1
  fieldSeq += 1
  return {
    ...AUD,
    fieldId: `F${fieldSeq}`,
    templateId: 'T1',
    fieldKey,
    fieldLabel,
    fieldType,
    fieldConfig: { scope, ...fieldConfig },
    isRequired,
    sort: sortCursor[scope],
    version: 'V1.0',
  }
}

const OPT_STATUS = [
  { label: '未开始', value: '0' },
  { label: '进行中', value: '1' },
  { label: '已完成', value: '2' },
]
const OPT_HAZARD = [
  { label: '高处作业', value: 'high' },
  { label: '临时用电', value: 'elec' },
  { label: '有限空间', value: 'space' },
  { label: '起重吊装', value: 'crane' },
]

const FIELDS: FormField[] = [
  // ---- 单头区
  field('header', 'orgName', '单位名称', 'text', 1, { maxLength: 50 }),
  field('header', 'period', '填报周期', 'text', 1, { maxLength: 20, placeholder: '如 2026-11' }),
  field('header', 'deptName', '填报部门', 'text', 1, { maxLength: 50 }),
  field('header', 'userName', '填报人', 'text', 1, { maxLength: 20 }),
  field('header', 'reportDate', '填报日期', 'date', 1, { format: 'yyyy-MM-dd' }),
  field('header', 'contact', '联系电话', 'text', 0, { maxLength: 20, regex: '^1[3-9]\\d{9}$|^0\\d{2,3}-?\\d{7,8}$' }),
  field('header', 'stopWork', '本月是否停工', 'radio', 1, { options: [{ label: '是', value: '1' }, { label: '否', value: '0' }] }),
  field('header', 'riskFund', '安全费用提取(万元)', 'number', 0, { scale: 2, min: 0, unit: '万元' }),
  field('header', 'summary', '总体情况说明', 'textarea', 0, { maxLength: 500 }),
  field('header', 'issueDesc', '重大问题描述(富文本)', 'richtext', 0, { toolbar: 'simple', image: false }),
  field('header', 'evidence', '证明材料', 'upload', 0, { maxCount: 5, maxSize: 20, accept: ['.pdf', '.png', '.jpg', '.docx', '.xlsx'] }),
  // ---- 明细区（Univer 表格）
  field('detail', 'seq', '序号', 'number', 0, { scale: 0 }),
  field('detail', 'itemName', '项目名称', 'text', 1, { maxLength: 60, unique: true }),
  field('detail', 'planNum', '计划数量', 'number', 1, { scale: 0, min: 0 }),
  field('detail', 'finishNum', '完成数量', 'number', 1, { scale: 0, min: 0 }),
  field('detail', 'status', '完成状态', 'select', 1, { options: OPT_STATUS }),
  field('detail', 'owner', '责任人', 'text', 0, { maxLength: 20 }),
  field('detail', 'lastCheck', '最近检查时间', 'datetime', 0, { format: 'yyyy-MM-dd HH:mm' }),
  field('detail', 'hazard', '隐患类型', 'checkbox', 0, { options: OPT_HAZARD, allowOther: false }),
  field('detail', 'remark', '备注', 'textarea', 0, { maxLength: 200 }),
  field('detail', 'budgetNote', '内部预算说明', 'text', 0, { maxLength: 200, remark: '敏感字段，仅管理层可见' }),
]

/** 系统赋值列：后端写入，前端 read 呈现（8.2 后端二次校验） */
export const SYSTEM_VALUES: Record<string, 'seq' | 'orgName' | 'userName' | 'deptName' | 'today'> = {
  seq: 'seq',
  orgName: 'orgName',
  userName: 'userName',
  deptName: 'deptName',
  reportDate: 'today',
}

/* ------------------------------------------- 表15 form_org_diff */

let diffSeq = 0
function diff(
  orgId: string,
  fieldKey: string,
  diffType: DiffType,
  extra: Partial<FormOrgDiff> = {},
): FormOrgDiff {
  diffSeq += 1
  return { ...AUD, diffId: `DF${diffSeq}`, templateId: 'T1', orgId, fieldKey, diffType, ...extra }
}

const DIFFS: FormOrgDiff[] = [
  // 3.3 其一：隐藏基础字段
  diff('O12', 'owner', 1, { note: '交通工程公司按班组作业，不设责任人' }),
  // 3.3 其二：修改基础字段属性（必填、选项范围、校验、默认值、展示名）
  diff('O11', 'remark', 2, { isRequired: 1, note: '城投分公司备注必填' }),
  diff('O12', 'remark', 2, { fieldLabel: '困难及诉求', fieldConfig: { scope: 'detail', maxLength: 300 }, note: '同名口径不同' }),
  diff('O13', 'hazard', 2, { isRequired: 1, note: '数智科技上线项目必须勾选隐患类型' }),
  // 3.3 其三：新增独有字段
  diff('O13', 'rndRatio', 3, {
    fieldLabel: '研发投入占比(%)',
    fieldType: 'number',
    fieldConfig: { scope: 'detail', scale: 1, min: 0, max: 100, unit: '%' },
    isRequired: 1,
    sort: 99,
    note: '仅数智科技公司需要报送',
  }),
  diff('O11', 'fundSource', 3, {
    fieldLabel: '资金来源',
    fieldType: 'select',
    fieldConfig: { scope: 'header', options: [{ label: '自营资金', value: 'self' }, { label: '专项债', value: 'bond' }, { label: '银行贷款', value: 'loan' }] },
    isRequired: 0,
    sort: 98,
    note: '仅城投分公司需要报送',
  }),
]

/* ------------------------------------- 表16 form_field_permission */

let permSeq = 0
function perm(fieldKey: string, targetType: TargetType, targetId: string, permType: PermType, note = ''): FormFieldPermissionRow {
  permSeq += 1
  return { ...AUD, permId: `PM${permSeq}`, templateId: 'T1', fieldKey, targetType, targetId, permType, note }
}
type FormFieldPermissionRow = {
  permId: string
  templateId: string
  fieldKey: string
  targetType: TargetType
  targetId: string
  permType: PermType
  requiredOverride?: 0 | 1
  note: string
  delFlag: 0
}

const PERMS: FormFieldPermissionRow[] = [
  // 场景一：审核人全程只读（3.4）
  ...FIELDS.map((f) => perm(f.fieldKey, 1, 'R5', 'read', '审核场景只读')),
  // 场景二：敏感字段隔离（3.4）—— 填报员不可见内部预算说明
  perm('budgetNote', 1, 'R4', 'hidden', '填报端不呈现，DOM 中不存在'),
  perm('riskFund', 1, 'R4', 'read', '费用口径由集团维护，填报端只读'),
  perm('riskFund', 3, 'O13', 'hidden', '数智科技公司不报送费用'),
  // 场景三：跨部门协同分段填报（3.4）—— 财务部可改费用，不可见隐患
  perm('riskFund', 2, 'D13', 'edit', '财务部开放费用编辑'),
  perm('hazard', 2, 'D13', 'hidden', '财务部不涉及安全隐患'),
  perm('summary', 2, 'D13', 'read', '财务部仅查看总体说明'),
  // 用户级最高优先级（7.2）
  perm('itemName', 4, 'U8', 'read', '孙悦只做财务填报，项目名不可改'),
  // 系统赋值列强制只读
  perm('seq', 1, 'R4', 'read', '序号由系统生成'),
  perm('orgName', 1, 'R4', 'read', '单位名称取登录用户所属单位'),
  perm('deptName', 1, 'R4', 'read', '部门取登录用户所属部门'),
  perm('userName', 1, 'R4', 'read', '填报人取登录用户'),
  perm('reportDate', 1, 'R4', 'read', '填报日期取系统当天'),
  // 表单管理员配置态需要可编辑，显式放开，避免被审核只读误伤
  perm('evidence', 1, 'R5', 'read', '附件允许审核人下载查看'),
]

/* ------------------------------------ 表17 form_task / 表18 form_task_scope */

const TASKS: FormTask[] = [
  {
    ...AUD,
    taskId: 'TASK-1',
    templateId: 'T1',
    templateVersion: 'V1.0',
    taskName: `${ym} 项目任务月度完成情况填报`,
    publishOrgId: 'O1',
    startTime: `${monthFirst} 00:00:00`,
    endTime: `${monthLast} 23:59:59`,
    auditType: 1,
    auditFlowId: 'AF1',
    auditNodes: [{ nodeId: 'N1', seq: 1, nodeName: '集团业务管理部审核', roleCode: 'auditor' }],
    status: 1,
    singleRecordPerOrg: true,
    remindDays: 3,
    createdBy: 'U3',
    createTime: stamp(-10),
  },
  {
    ...AUD,
    taskId: 'TASK-2',
    templateId: 'T1',
    templateVersion: 'V1.0',
    taskName: `${ym} 安全隐患排查（明细型·免审核）`,
    publishOrgId: 'O1',
    startTime: `${monthFirst} 00:00:00`,
    endTime: `${monthLast} 23:59:59`,
    auditType: 0,
    auditFlowId: null,
    auditNodes: [],
    status: 1,
    // 7.6 关闭唯一性：同一单位可提交多条记录
    singleRecordPerOrg: false,
    createdBy: 'U3',
    createTime: stamp(-8),
  },
  {
    ...AUD,
    taskId: 'TASK-3',
    templateId: 'T1',
    templateVersion: 'V1.0',
    taskName: `${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}年${now.getMonth() === 0 ? 9 : now.getMonth()}月 项目任务填报（已归档）`,
    publishOrgId: 'O1',
    startTime: stamp(-45),
    endTime: stamp(-15),
    auditType: 2,
    auditFlowId: 'AF2',
    auditNodes: [
      { nodeId: 'N1', seq: 1, nodeName: '子单位初审', userId: 'U6' },
      { nodeId: 'N2', seq: 2, nodeName: '集团复审', roleCode: 'auditor' },
    ],
    status: 3,
    singleRecordPerOrg: true,
    createdBy: 'U3',
    createTime: stamp(-50),
  },
  {
    ...AUD,
    taskId: 'TASK-4',
    templateId: 'T1',
    templateVersion: 'V1.0',
    taskName: `${dayAt(5)} 启动的下月度填报（待开始）`,
    publishOrgId: 'O1',
    startTime: `${dayAt(5)} 00:00:00`,
    endTime: `${dayAt(35)} 23:59:59`,
    auditType: 1,
    auditFlowId: 'AF1',
    auditNodes: [{ nodeId: 'N1', seq: 1, nodeName: '集团业务管理部审核', roleCode: 'auditor' }],
    status: 0,
    singleRecordPerOrg: true,
    createdBy: 'U3',
    createTime: stamp(-1),
  },
]

const SCOPES = [
  ['S1', 'TASK-1', 'O11'],
  ['S2', 'TASK-1', 'O12'],
  ['S3', 'TASK-1', 'O13'],
  ['S4', 'TASK-2', 'O11'],
  ['S5', 'TASK-2', 'O12'],
  ['S6', 'TASK-3', 'O11'],
  ['S7', 'TASK-3', 'O12'],
  ['S8', 'TASK-3', 'O13'],
  ['S9', 'TASK-4', 'O11'],
].map(([scopeId, taskId, orgId]) => ({ ...AUD, scopeId, taskId, orgId }))

/* -------------------------------- 表19 form_record / 表20 / 表21 */

function record(
  recordId: string,
  taskId: string,
  userId: string,
  recordStatus: FormRecord['recordStatus'],
  data: Record<string, string | number | null>,
  rows: Record<string, string | number | null>[],
  opt: Partial<FormRecord> = {},
): FormRecord {
  const u = USERS.find((x) => x.userId === userId)!
  return {
    ...AUD,
    recordId,
    taskId,
    templateId: 'T1',
    templateVersion: 'V1.0',
    orgId: u.orgId,
    deptId: u.deptId,
    userId,
    recordStatus,
    submitCount: recordStatus === 'draft' ? 0 : 1,
    seq: opt.seq ?? 1,
    currentNode: 0,
    auditTrails: [],
    data: {
      orgName: u ? orgNameOf(u.orgId) : '',
      userName: u.realName,
      deptName: DEPTS.find((d) => d.deptId === u.deptId)?.deptName ?? '',
      reportDate: dayAt(-1),
      period: ym,
      ...data,
    },
    rows,
    createTime: stamp(-3),
    updateTime: stamp(-1),
    ...opt,
  }
}

function orgNameOf(id: string) {
  return ORGS.find((o) => o.orgId === id)?.orgName ?? ''
}

const detailRow = (
  itemName: string,
  planNum: number,
  finishNum: number,
  status: string,
  owner: string,
  remark: string,
  extra: Record<string, string | number | null> = {},
): Record<string, string | number | null> => ({
  seq: 0,
  itemName,
  planNum,
  finishNum,
  status,
  owner,
  remark,
  hazard: '',
  lastCheck: `${dayAt(-2)} 14:30`,
  budgetNote: '',
  ...extra,
})

const RECORDS: FormRecord[] = [
  record('RC1', 'TASK-1', 'U5', 'draft', { contact: '13900000001', summary: '11 月在建项目 3 个，总体进度正常。', riskFund: 12.5, stopWork: '0' }, [
    detailRow('城东大道雨污分流改造', 12, 8, '1', '王建国', '管线迁改影响进度', { seq: 1, budgetNote: '预留变更金 80 万' }),
    detailRow('城南保障房二期', 20, 20, '2', '刘志强', '已完工待验收', { seq: 2, budgetNote: '结算下浮 3%' }),
  ]),
  record('RC2', 'TASK-1', 'U6', 'submitted', { contact: '13900000002', summary: '路桥养护类项目按计划推进。', riskFund: 8.2, stopWork: '0' }, [
    detailRow('G204 桥梁加固', 15, 11, '1', '', '夜间施工许可待批', { seq: 1, budgetNote: '夜间施工增加费 26 万' }),
    detailRow('隧道机电更新', 16, 11, '1', '', '设备到货延迟', { seq: 2, budgetNote: '' }),
  ], {
    submitTime: stamp(-1, '16:20'),
    currentNode: 1,
    auditTrails: [],
  }),
  record('RC3', 'TASK-1', 'U7', 'reject', { contact: '13900000003', summary: '研发类项目投入占比已按财务口径核算。', riskFund: 30, stopWork: '0' }, [
    detailRow('智慧工地平台迭代', 8, 6, '1', '孙敏', '需求变更 2 次', { seq: 1, rndRatio: 28, budgetNote: '研发投入归集口径 A' }),
    detailRow('数据中台治理', 7, 5, '1', '周野', '数据源协调中', { seq: 2, rndRatio: 35, budgetNote: '' }),
  ], {
    submitTime: stamp(-2, '10:05'),
    auditUserId: 'U4',
    auditTime: stamp(-1, '11:12'),
    auditOpinion: '研发投入占比与财务归集口径不一致，请与财务部核对后重提。',
    currentNode: 0,
    auditTrails: [
      {
        trailId: 'AT1',
        nodeId: 'N1',
        nodeName: '集团业务管理部审核',
        seq: 1,
        userId: 'U4',
        userName: '李强',
        conclusion: 'reject',
        opinion: '研发投入占比与财务归集口径不一致，请与财务部核对后重提。',
        time: stamp(-1, '11:12'),
        costSeconds: 86_400,
      },
    ],
  }),
  // 7.6 一单位多条记录
  record('RC4', 'TASK-2', 'U5', 'pass', { summary: '隐患排查第 1 批', stopWork: '0' }, [
    detailRow('深基坑支护变形', 1, 1, '2', '王建国', '已完成整改', { seq: 1, hazard: 'space' }),
  ], { submitTime: stamp(-4, '09:00'), auditTrails: [] }),
  record('RC5', 'TASK-2', 'U5', 'pass', { summary: '隐患排查第 2 批', stopWork: '0' }, [
    detailRow('塔吊力矩限制器失效', 1, 1, '2', '刘志强', '已更换', { seq: 1, hazard: 'crane,high' }),
  ], { seq: 2, submitTime: stamp(-3, '15:00') }),
  record('RC6', 'TASK-2', 'U6', 'submitted', { summary: '道路巡查隐患', stopWork: '1' }, [
    detailRow('标线缺失', 6, 2, '1', '', '待采购材料', { seq: 1, hazard: 'elec' }),
  ], { submitTime: stamp(-1, '17:40'), currentNode: 0 }),
  record('RC7', 'TASK-3', 'U5', 'pass', { summary: '9 月填报', stopWork: '0' }, [
    detailRow('城东大道雨污分流改造', 10, 9, '1', '王建国', '', { seq: 1 }),
  ], { submitTime: stamp(-18, '10:00'), auditUserId: 'U4', auditTime: stamp(-16, '09:00') }),
  record('RC8', 'TASK-3', 'U6', 'pass', { summary: '9 月填报', stopWork: '0' }, [
    detailRow('G204 桥梁加固', 14, 12, '1', '', '', { seq: 1 }),
  ], { submitTime: stamp(-19, '10:00'), auditUserId: 'U4', auditTime: stamp(-16, '09:30') }),
]

const ATTACHMENTS = [
  {
    ...AUD,
    attId: 'AT-1',
    recordId: 'RC2',
    fieldKey: 'evidence',
    fileName: '桥梁加固进度影像.pdf',
    filePath: 'minio://zn-tb/2026/11/AT-1.pdf',
    fileSize: 1_248_512,
    fileType: 'pdf',
    uploadUser: 'U6',
    uploadTime: stamp(-1, '16:10'),
  },
  {
    ...AUD,
    attId: 'AT-2',
    recordId: 'RC2',
    fieldKey: 'evidence',
    fileName: '监理确认单.jpg',
    filePath: 'minio://zn-tb/2026/11/AT-2.jpg',
    fileSize: 386_240,
    fileType: 'jpg',
    uploadUser: 'U6',
    uploadTime: stamp(-1, '16:12'),
  },
]

/* --------------------------------------------- 9.4 基础字典 */

const DICTS = [
  { dictCode: 'BIZ_TYPE', label: '生产运营', value: '生产运营', sort: 1 },
  { dictCode: 'BIZ_TYPE', label: '安全环保', value: '安全环保', sort: 2 },
  { dictCode: 'BIZ_TYPE', label: '投资计划', value: '投资计划', sort: 3 },
  { dictCode: 'BIZ_TYPE', label: '科技创新', value: '科技创新', sort: 4 },
]

export function buildSeed(): Database {
  return {
    sys_org: structuredClone(ORGS),
    sys_dept: structuredClone(DEPTS),
    sys_role: structuredClone(ROLES),
    sys_user: structuredClone(USERS),
    form_template: structuredClone([TPL]),
    form_field: structuredClone(FIELDS),
    form_org_diff: structuredClone(DIFFS),
    form_field_permission: structuredClone(PERMS),
    form_task: structuredClone(TASKS),
    form_task_scope: structuredClone(SCOPES),
    form_record: structuredClone(RECORDS),
    form_record_data: [],
    form_attachment: structuredClone(ATTACHMENTS),
    form_oper_log: [
      {
        logId: 'LOG0',
        userId: 'U3',
        orgId: 'O1',
        operType: '任务下发',
        bizId: 'TASK-1',
        bizType: 'task',
        content: `发布任务「${ym} 项目任务月度完成情况填报」，下发 3 个单位，单级审核`,
        ip: '10.20.31.101',
        result: 1,
        operTime: stamp(-10, '10:02'),
      },
    ],
    form_template_version: [
      {
        templateId: 'T1',
        version: 'V1.0',
        publishTime: stamp(-30, '09:00'),
        operator: '张明',
        summary: '初始版本：11 个单头字段 + 10 个明细字段',
        fields: structuredClone(FIELDS),
        diffs: structuredClone(DIFFS),
        perms: structuredClone(PERMS),
      },
    ],
    export_job: [],
    edit_lock: [],
    sys_dict: structuredClone(DICTS),
    seq: 1000,
  }
}
