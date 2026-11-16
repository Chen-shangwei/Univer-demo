/** 5.4 表25 主要错误码 */
export const ERR = {
  OK: 200,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  /** 1001 任务不在填报周期内 */
  OUT_OF_WINDOW: 1001,
  /** 1002 单位不在任务下发范围 */
  OUT_OF_SCOPE: 1002,
  /** 1003 必填字段未填写 */
  REQUIRED: 1003,
  /** 1004 字段格式校验不通过 */
  FORMAT: 1004,
  /** 1005 附件类型或数量超限 */
  ATTACH_LIMIT: 1005,
  /** 1006 该单位已提交且不允许重复提交 */
  DUPLICATE_SUBMIT: 1006,
  /** 1007 字段权限不足 */
  NO_FIELD_PERM: 1007,
  /** 1008 审核节点不匹配 */
  NODE_MISMATCH: 1008,
  /** 2001 模板字段标识重复 */
  DUP_FIELD_KEY: 2001,
  /** 原型补充：并发写入被占用（7.5） */
  LOCKED: 1009,
  /** 原型补充：差异规则字段标识冲突（3.3） */
  DUP_DIFF_KEY: 2002,
  /** 原型补充：下载链接已过期（3.9） */
  LINK_EXPIRED: 1010,
} as const

export const ERR_MSG: Record<number, string> = {
  200: '成功',
  401: '未登录或令牌失效',
  403: '无功能权限',
  404: '对象不存在',
  1001: '任务不在填报周期内',
  1002: '单位不在任务下发范围',
  1003: '必填字段未填写',
  1004: '字段格式校验不通过',
  1005: '附件类型或数量超限',
  1006: '该单位已提交且不允许重复提交',
  1007: '字段权限不足',
  1008: '审核节点不匹配',
  1009: '该填报正在编辑中',
  1010: '下载链接已过期',
  2001: '模板字段标识重复',
  2002: '差异规则字段标识冲突',
}

/** 业务异常，由接口层统一转成 { code, msg, data: null } */
export class ApiError extends Error {
  code: number
  detail: string[]
  constructor(code: number, msg?: string, detail: string[] = []) {
    super(msg ?? ERR_MSG[code] ?? `错误 ${code}`)
    this.code = code
    this.detail = detail
  }
}
