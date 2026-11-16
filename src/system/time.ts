/**
 * 5.1：所有时间参数与展示时间统一 yyyy-MM-dd HH:mm:ss。
 * 不用 toLocaleString('zh-CN')：它产出 2026/11/13 17:07:27（斜杠），
 * 会让 3.10 操作日志按时间区间检索（字符串比较）与字段完整性校验全部失效。
 */
const pad = (n: number) => String(n).padStart(2, '0')

export function fmtTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const nowStr = (): string => fmtTime(new Date())

/** 7.5 锁冲突提示只关心时刻，不带日期 */
export function fmtClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 6.4 日期型字段的取值口径 yyyy-MM-dd */
export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
