/**
 * 5.1 统一响应结构：{ code, msg, data }。
 * 与前端 src/system/api.ts 的信封完全一致，业务错误码（1001…2002）原样透传。
 * HTTP 状态：401/403/404 直接映射，其余业务错误仍走 HTTP 200，由 body.code 表达，
 * 便于前端统一拦截器处理（与原型当前行为一致）。
 */
import { ApiError, ERR, ERR_MSG } from './context'

export interface Envelope<T> {
  code: number
  msg: string
  data: T
}

export const ok = <T>(data: T): Envelope<T> => ({ code: ERR.OK, msg: ERR_MSG[200]!, data })

export const fail = (code: number, msg: string): Envelope<null> => ({ code, msg, data: null })

/** 把抛出的异常归一化为 { code, msg } */
export function toFail(e: unknown): { code: number; msg: string } {
  if (e instanceof ApiError) return { code: e.code, msg: e.message }
  return { code: 500, msg: e instanceof Error ? e.message : String(e) }
}

/** 业务码 → HTTP 状态：仅认证/鉴权/不存在用对应状态码，其它用 200 */
export function httpStatus(code: number): number {
  return code === 401 || code === 403 || code === 404 ? code : 200
}
