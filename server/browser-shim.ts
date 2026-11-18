/**
 * Node 运行环境下的浏览器 API 垫片（思路对齐 check/stub.ts）。
 *
 * src/system 下的业务逻辑层（db / flow / schema-service …）本就设计为「纯逻辑 + 少量浏览器耦合」，
 * 其中 db.ts 在模块顶层会读取 localStorage、注册 window.addEventListener。
 * 服务端只要在被 import 之前把这些全局对象补上，整套逻辑即可原样在 Node 中运行，
 * 因此 M0 阶段用内存 Map 顶替 localStorage（进程级单例数据库），无需真实持久化。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/* --------------------------------------------------- localStorage（文件持久化） */
// 落盘点：默认 server/data/db.json，可用 ZN_DB_FILE 覆盖；db.ts 的 watch→persist 防抖后调用 setItem，这里合并 50ms 落盘
const DB_FILE = resolve(process.env.ZN_DB_FILE ?? 'server/data/db.json')
const store = new Map<string, string>()
try {
  if (existsSync(DB_FILE)) {
    const raw = JSON.parse(readFileSync(DB_FILE, 'utf8')) as Record<string, string>
    for (const [k, v] of Object.entries(raw)) store.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
} catch {
  /* 文件损坏则从空开始，db.ts 的 load() 会自动回落 buildSeed */
}

let flushTimer: ReturnType<typeof setTimeout> | undefined
function flushStore(): void {
  try {
    mkdirSync(dirname(DB_FILE), { recursive: true })
    writeFileSync(DB_FILE, JSON.stringify(Object.fromEntries(store)), 'utf8')
  } catch {
    /* 落盘失败则本次仅驻内存，不影响进程内一致性 */
  }
}
function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushStore, 50)
}

const stubStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v))
    scheduleFlush()
  },
  removeItem: (k: string) => {
    store.delete(k)
    flushStore()
  },
  clear: () => {
    store.clear()
    flushStore()
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
}

/* -------------------------------------------------- window / document */
const stubWindow = {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (t: number) => clearTimeout(t as unknown as ReturnType<typeof setTimeout>),
  setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms) as unknown as number,
  clearInterval: (t: number) => clearInterval(t as unknown as ReturnType<typeof setInterval>),
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: stubStorage,
}

const stubDocument = {
  createElement: () => ({ href: '', download: '', click() {} }),
  querySelector: () => null,
}

/* -------------------------------------------------- 对象 URL（导出/下载用，M0 仅占位） */
let blobSeq = 0
const U = URL as unknown as { createObjectURL?: (b: unknown) => string; revokeObjectURL?: (u: string) => void }
if (typeof U.createObjectURL !== 'function') {
  U.createObjectURL = () => {
    blobSeq += 1
    return `blob:zn-tb-server/${blobSeq}`
  }
  U.revokeObjectURL = () => {}
}

const g = globalThis as Record<string, unknown>
if (!g.localStorage) g.localStorage = stubStorage
if (!g.window) g.window = stubWindow
if (!g.document) g.document = stubDocument

export {}
