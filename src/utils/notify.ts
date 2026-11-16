/**
 * 提示与确认全部走 Element Plus；接口约定不变（5.1「msg 可直接用于前端提示」）。
 * toast() 保留原签名，视图里的调用点无需改动，内部统一换成 ElMessage。
 */
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ApiResult } from '../system/types'

export type ToastKind = 'ok' | 'err' | 'info'

const KIND: Record<ToastKind, 'success' | 'error' | 'info'> = { ok: 'success', err: 'error', info: 'info' }

/** 错误往往要读完一长串校验明细，普通 message 会自动消失，故错误改为手动关闭 */
export function toast(kind: ToastKind, text: string): void {
  const type = KIND[kind]
  if (type === 'error') {
    ElMessage({ message: text, type, duration: 0, showClose: true, offset: 16 })
    return
  }
  ElMessage({ message: text, type, duration: 3000, showClose: true, offset: 16 })
}

/** 替代 window.confirm：取消时 reject，调用方用 .then 包住后续动作 */
export function confirmAction(message: string, title = '操作确认'): Promise<boolean> {
  return ElMessageBox.confirm(message, title, {
    type: 'warning',
    confirmButtonText: '确定',
    cancelButtonText: '取消',
  }).then(
    () => true,
    () => false,
  )
}

export interface PromptResult {
  value: string
}

/** 替代 window.prompt：空输入按 action 区分「取消」与「清空」，与原有用法等价 */
export function promptAction(message: string, title: string, options: { value?: string; emptyAsCancel?: boolean } = {}): Promise<PromptResult | null> {
  const emptyAsCancel = options.emptyAsCancel ?? true
  return ElMessageBox.prompt(message, title, {
    inputValue: options.value ?? '',
    confirmButtonText: '确定',
    cancelButtonText: '取消',
  }).then(
    ({ value }) => (emptyAsCancel && !value.trim() ? null : { value }),
    () => null,
  )
}

/** 取出接口结果；失败时提示 msg 并中断当前操作 */
export function must<T>(r: ApiResult<T>): T {
  if (r.code !== 200) {
    toast('err', r.msg)
    throw new ApiAbort(r.code, r.msg)
  }
  return r.data
}

/** 业务中断标记：已被提示过，无需再次展示 */
export class ApiAbort extends Error {
  readonly code: number
  constructor(code: number, msg: string) {
    super(msg)
    this.code = code
    this.name = 'ApiAbort'
  }
}

/** 视图事件处理统一入口：捕获业务中断与其他异常 */
export function run(fn: () => void): void {
  try {
    fn()
  } catch (e) {
    if (e instanceof ApiAbort) return
    toast('err', e instanceof Error ? e.message : String(e))
  }
}

/** run 的 Promise 版：await 之后的异常同样落到 ElMessage */
export async function runAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof ApiAbort) return
    toast('err', e instanceof Error ? e.message : String(e))
  }
}

/** 5.1 时间统一 yyyy-MM-dd HH:mm:ss */
export function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function todayStr(): string {
  return fmt(new Date()).slice(0, 10)
}

/** 6.4 日期型字段的取值口径：el-date-picker 统一用 value-format="YYYY-MM-DD" */
export const toDateInput = (v: unknown): string => (v ? String(v).slice(0, 10) : '')

/**
 * 7.1 填报起止时间用 el-date-picker 的 datetime 类型，
 * value-format 为 YYYY-MM-DD HH:mm，与接口入参口径一致（不再需要 T 分隔）。
 */
export const toDateTimeInput = (v: unknown): string => (v ? `${String(v).slice(0, 10)} ${String(v).slice(11, 16)}` : '')
