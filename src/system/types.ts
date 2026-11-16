/**
 * 实体与契约类型 —— 严格对齐《智能填报系统详细设计说明书》第 4 章数据表结构与第 6.2 节 Schema 契约。
 * 说明：项目开启了 erasableSyntaxOnly，故状态码用 `as const` 对象而非 enum。
 */

/* ------------------------------------------------------------------ 通用 */

/** 原型内所有主键（生产为 bigint，此处用字符串承载，避免 Number 精度问题） */
export type ID = string

/** 逻辑删除标记与审计字段（4.1 设计原则其三） */
export interface AuditColumns {
  delFlag: 0 | 1
  createBy?: string
  createTime?: string
  updateBy?: string
  updateTime?: string
}

/* --------------------------------------------------------- 表10 sys_role */

/** 角色编码（3.1 预置四类 + 系统管理员，共五类，见 10.2 权限矩阵） */
export const ROLE = {
  SYS_ADMIN: 'sys_admin',
  TEMPLATE_ADMIN: 'template_admin',
  BIZ_ADMIN: 'biz_admin',
  REPORTER: 'reporter',
  AUDITOR: 'auditor',
} as const
export type RoleCode = (typeof ROLE)[keyof typeof ROLE]

export interface SysRole extends AuditColumns {
  roleId: ID
  roleName: string
  roleCode: RoleCode
  /** 1 管理类、2 业务类 */
  roleType: 1 | 2
  remark: string
  status: 0 | 1
}

/* ----------------------------------------------------------- 表8 sys_org */

export interface SysOrg extends AuditColumns {
  orgId: ID
  orgName: string
  /** 单位编码，全局唯一，用于汇总分组（4.5 约束） */
  orgCode: string
  /** 根节点为 '0' */
  parentId: ID
  /** 1 集团、2 二级单位、3 三级单位 */
  orgLevel: 1 | 2 | 3
  sort: number
  status: 0 | 1
}

/* ---------------------------------------------------------- 表9 sys_dept */

export interface SysDept extends AuditColumns {
  deptId: ID
  deptName: string
  orgId: ID
  parentId: ID
  sort: number
  status: 0 | 1
}

/* ---------------------------------------------------------- 表11 sys_user */

export interface SysUser extends AuditColumns {
  userId: ID
  username: string
  /** 密码摘要；对接统一认证时可为空（1.3、3.1） */
  password?: string
  realName: string
  /** 所属子单位，决定任务可见范围与表单视图 */
  orgId: ID
  /** 所属部门，参与字段权限裁决 */
  deptId: ID
  mobile: string
  status: 0 | 1
  /** 表12 sys_user_role 的展开：一个用户可同时具备填报与审核角色（3.1） */
  roleIds: ID[]
}

/* ------------------------------------------- 表6 form_template / 表7 form_field */

/** 模板状态：0 草稿、1 启用、2 停用、3 归档（3.2 状态管理） */
export const TPL_STATUS = { DRAFT: 0, ENABLED: 1, DISABLED: 2, ARCHIVED: 3 } as const
export type TplStatus = (typeof TPL_STATUS)[keyof typeof TPL_STATUS]

export interface FormTemplate extends AuditColumns {
  templateId: ID
  templateName: string
  /** 填报说明，随表单展示 */
  templateDesc: string
  bizType: string
  /** 当前版本号，如 V1.0 */
  version: string
  createOrgId: ID
  status: TplStatus
}

/** 表6 字段类型与配置项 —— 设计书列出的全部十种 */
export const FIELD_TYPE = {
  TEXT: 'text',
  TEXTAREA: 'textarea',
  NUMBER: 'number',
  DATE: 'date',
  DATETIME: 'datetime',
  RADIO: 'radio',
  CHECKBOX: 'checkbox',
  SELECT: 'select',
  UPLOAD: 'upload',
  RICHTEXT: 'richtext',
} as const
export type FieldType = (typeof FIELD_TYPE)[keyof typeof FIELD_TYPE]

export interface FieldOption {
  label: string
  value: string
}

/**
 * form_field.field_config（json）。
 * 新增字段类型只扩展此对象，不改 Schema 外层结构（6.2）。
 */
export interface FieldConfig {
  /** 单行/多行文本：最大长度 */
  maxLength?: number
  /** 单行文本：正则校验 */
  regex?: string
  /** 单行文本：是否唯一 */
  unique?: boolean
  /** 数字：小数位数、取值范围、单位 */
  scale?: number
  min?: number
  max?: number
  unit?: string
  /** 日期：格式与允许范围 */
  format?: string
  /** 单选/多选/下拉：选项、默认值、允许其他输入、选项来源 */
  options?: FieldOption[]
  defaultValue?: string
  allowOther?: boolean
  source?: 'static' | 'dict'
  dictCode?: string
  /** 附件：允许类型、单个大小 MB、数量上限 */
  accept?: string[]
  maxSize?: number
  maxCount?: number
  /** 富文本：工具栏范围、图片开关 */
  toolbar?: 'simple' | 'full'
  image?: boolean
  /**
   * 原型扩展：字段所属区域。
   * header = 单头区（DynamicForm 渲染）；detail = 明细区（Univer 表格渲染，对应 7.6 明细型填报）。
   * 设计书 6.2 的 Schema 为扁平结构，此处收进 config 以保持外层结构不变。
   */
  scope?: 'header' | 'detail'
  /** 6.5 前端性能：字段分组折叠的组名 */
  group?: string
  /** 填报提示语 */
  placeholder?: string
  remark?: string
}

export interface FormField extends AuditColumns {
  fieldId: ID
  templateId: ID
  /** 字段标识，模板内唯一，一经保存不再变更（3.2） */
  fieldKey: string
  fieldLabel: string
  fieldType: FieldType
  fieldConfig: FieldConfig
  isRequired: 0 | 1
  /** 决定渲染与导出顺序（表7） */
  sort: number
  version: string
  /** 3.2 字段标识不可变更，但可停用；停用后历史数据仍保留（7.3） */
  disabled?: 0 | 1
}

/* ------------------------------------------------ 表15 form_org_diff */

/** 差异类型：1 隐藏、2 修改属性、3 新增独有字段（3.3） */
export const DIFF_TYPE = { HIDE: 1, MODIFY: 2, ADD: 3 } as const
export type DiffType = (typeof DIFF_TYPE)[keyof typeof DIFF_TYPE]

export interface FormOrgDiff extends AuditColumns {
  diffId: ID
  templateId: ID
  orgId: ID
  fieldKey: string
  diffType: DiffType
  fieldLabel?: string
  fieldType?: FieldType
  fieldConfig?: FieldConfig
  isRequired?: 0 | 1
  sort?: number
  /** 原型辅助：新增时的区域，避免新增字段落错区 */
  scope?: 'header' | 'detail'
  note?: string
}

/* ------------------------------------------ 表16 form_field_permission */

/** 权限对象类型：1 角色、2 部门、3 子单位；4 为用户级扩展（7.2 裁决优先级需要） */
export const TARGET_TYPE = { ROLE: 1, DEPT: 2, ORG: 3, USER: 4 } as const
export type TargetType = (typeof TARGET_TYPE)[keyof typeof TARGET_TYPE]

/** 2.6 字段权限取值；注意是 read 而非旧版的 readonly */
export const PERM_TYPE = { HIDDEN: 'hidden', READ: 'read', EDIT: 'edit' } as const
export type PermType = (typeof PERM_TYPE)[keyof typeof PERM_TYPE]

export interface FormFieldPermission extends AuditColumns {
  permId: ID
  templateId: ID
  fieldKey: string
  targetType: TargetType
  targetId: ID
  permType: PermType
  /** 原型辅助：同一规则可同时收紧必填属性（跨部门协同填报场景） */
  requiredOverride?: 0 | 1
  note?: string
}

/* ------------------------------------- 表17 form_task / 表18 form_task_scope */

/** 0 待开始、1 进行中、2 已截止、3 已归档 */
export const TASK_STATUS = { PENDING: 0, RUNNING: 1, CLOSED: 2, ARCHIVED: 3 } as const
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS]

/** 审核方式：0 不审核、1 单级、2 多级（3.5） */
export const AUDIT_TYPE = { NONE: 0, SINGLE: 1, MULTI: 2 } as const
export type AuditType = (typeof AUDIT_TYPE)[keyof typeof AUDIT_TYPE]

export interface AuditNode {
  nodeId: ID
  /** 节点顺序，从 1 开始 */
  seq: number
  nodeName: string
  /** 审核人（与审核角色二选一，优先审核人） */
  userId?: ID
  roleCode?: RoleCode
}

export interface FormTask extends AuditColumns {
  taskId: ID
  templateId: ID
  /** 任务发布时冻结的模板版本（7.3） */
  templateVersion: string
  taskName: string
  publishOrgId: ID
  startTime: string
  endTime: string
  auditType: AuditType
  auditFlowId: ID | null
  auditNodes: AuditNode[]
  status: TaskStatus
  /** 7.6 一单位一任务一条记录（true）/ 允许一单位多条明细记录（false） */
  singleRecordPerOrg: boolean
  /** 8.1 附件留存与提醒等开关的原型承载 */
  remindDays?: number
  createdBy?: string
  createTime?: string
}

export interface FormTaskScope extends AuditColumns {
  scopeId: ID
  taskId: ID
  orgId: ID
}

/* --------------------------- 表19 form_record / 表20 form_record_data */

/** draft、submitted、reject、pass（表19 record_status） */
export const RECORD_STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  REJECT: 'reject',
  PASS: 'pass',
} as const
export type RecordStatus = (typeof RECORD_STATUS)[keyof typeof RECORD_STATUS]

export type FieldValue = string | number | null

/** 表20：按字段逐行存储 */
export interface FormRecordData {
  dataId: ID
  recordId: ID
  fieldKey: string
  /** 多选以分隔符拼接、附件存文件标识、富文本存纯文本 */
  fieldValue: string
  /** 数字型副本，用于排序与统计（4.6 其一） */
  fieldValueNum: number | null
}

/** 表21 form_attachment */
export interface FormAttachment extends AuditColumns {
  attId: ID
  recordId: ID
  fieldKey: string
  fileName: string
  /** 对象存储内的文件标识，非直接访问地址（3.9） */
  filePath: string
  fileSize: number
  fileType: string
  uploadUser: ID
  uploadTime: string
  /** 原型：小文件的内联内容，模拟 MinIO 取回 */
  blob?: string
}

/** 3.7 审核留痕，按节点顺序、不可修改 */
export interface AuditTrail {
  trailId: ID
  nodeId: ID
  nodeName: string
  seq: number
  userId: ID
  userName: string
  /** pass | reject | revoke */
  conclusion: 'pass' | 'reject' | 'revoke'
  opinion: string
  time: string
  /** 8.x 记录耗时 */
  costSeconds: number
}

export interface FormRecord extends AuditColumns {
  recordId: ID
  taskId: ID
  templateId: ID
  /** 填报时的模板版本，历史呈现依据（7.3） */
  templateVersion: string
  orgId: ID
  deptId: ID
  userId: ID
  recordStatus: RecordStatus
  submitTime?: string
  submitCount: number
  auditUserId?: ID
  auditTime?: string
  auditOpinion?: string
  /** 7.6 允许多条时的记录序号，导出按单位+序号排序 */
  seq: number
  /** 多级审核当前待审节点 seq；不在审中为 0 */
  currentNode: number
  auditTrails: AuditTrail[]
  /** 单头字段值（fieldKey -> value） */
  data: Record<string, FieldValue>
  /** 明细行（Univer 表格区），对应 7.6 明细型填报 */
  rows: Record<string, FieldValue>[]
  createTime: string
  updateTime: string
}

/* ------------------------------------------------- 表22 form_oper_log */

/** 3.10 日志覆盖的八类行为 + 撤回 */
export const OPER_TYPE = {
  LOGIN: '登录',
  TEMPLATE_CHANGE: '模板变更',
  DIFF_PERM_CHANGE: '差异与权限配置变更',
  TASK_PUBLISH: '任务下发',
  DRAFT_SAVE: '草稿保存',
  SUBMIT: '填报提交',
  AUDIT: '审核操作',
  EXPORT: '数据导出',
  ATTACH_DOWNLOAD: '附件下载',
  ATTACH_CHANGE: '附件变更',
  REVOKE: '管理员撤回',
} as const
export type OperType = (typeof OPER_TYPE)[keyof typeof OPER_TYPE]

export interface FormOperLog {
  logId: ID
  userId: ID
  orgId: ID
  operType: OperType
  bizId: ID
  /** task、record、template */
  bizType: 'task' | 'record' | 'template' | 'org' | 'user'
  content: string
  ip: string
  /** 1 成功、0 失败 */
  result: 0 | 1
  operTime: string
}

/* ------------------------------------------------ 3.8 异步导出作业 */

export interface ExportJob {
  jobId: ID
  taskId: ID
  userId: ID
  /** 筛选条件快照，用于导出说明区 */
  filters: string
  status: 'running' | 'done' | 'failed'
  fileName?: string
  rows?: number
  createTime: string
  finishTime?: string
  /** 下载凭证有效期（分钟，可配置） */
  expireMinutes: number
  /** 完成后签发的短时下载链接 */
  download?: SignedDownload
  content?: string
  error?: string
}

export interface SignedDownload {
  token: string
  url: string
  expireAt: number
}

/* ------------------------------------------------------ 7.5 编辑锁 */

export interface EditLock {
  /** `${taskId}__${orgId}` */
  key: string
  userId: ID
  userName: string
  /** 锁超时 30 秒 */
  expireAt: number
}

/* ------------------------------------------ 7.3 模板版本快照 */

export interface TemplateVersion {
  templateId: ID
  version: string
  publishTime: string
  operator: string
  summary: string
  fields: FormField[]
  diffs: FormOrgDiff[]
  perms: FormFieldPermission[]
}

/* --------------------------------------------------- 6.2 Schema 契约 */

/** 后端合并 + 裁决后的单字段输出，字段名与 6.2 示例完全一致 */
export interface SchemaField {
  fieldKey: string
  fieldLabel: string
  fieldType: FieldType
  isRequired: 0 | 1
  sort: number
  permission: PermType
  config: FieldConfig
  /** 原型扩展：来源（基础字段/新增独有字段/差异改名），用于渲染留痕 */
  origin: 'base' | 'diff-add'
  diffNote?: string
  /** 系统赋值列（原型扩展：单位名称、填报人、序号等由后端写入） */
  systemValue?: 'seq' | 'orgName' | 'userName' | 'deptName' | 'today'
}

export interface SchemaTraceStep {
  stage: 'base' | 'diff' | 'permission' | 'result'
  detail: string
}

export interface FormSchema {
  taskId: ID
  taskName: string
  templateVersion: string
  fields: SchemaField[]
  /** 原型扩展：被隐藏的字段标识，前端据此确认"不创建组件" */
  hiddenKeys: string[]
  trace: SchemaTraceStep[]
}

/* ------------------------------------------------ 5.1 统一响应结构 */

export interface ApiResult<T = unknown> {
  code: number
  msg: string
  data: T
}

/** 列表接口统一返回 total、pages、list（5.1） */
export interface PageResult<T> {
  total: number
  pages: number
  list: T[]
}
