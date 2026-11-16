/**
 * 仅用于 CLI 逻辑验证（pnpm check）的浏览器 API 垫片。
 * Node 环境下没有 localStorage / window / document / URL.createObjectURL，
 * 而 db.ts、runtime.ts、flow.ts 在模块顶层与写入路径上会用到它们。
 */

/* --------------------------------------------------- localStorage */
const store = new Map<string, string>()

const stubStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v))
  },
  removeItem: (k: string) => {
    store.delete(k)
  },
  clear: () => store.clear(),
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

/** 下载动作在原型里靠 a.click() 触发，校验脚本只关心是否走到了这一步 */
export const downloads: { name: string; url: string }[] = []

const stubDocument = {
  createElement: () => ({
    href: '',
    download: '',
    click() {
      downloads.push({ name: this.download, url: this.href })
    },
  }),
  querySelector: () => null,
}

/* -------------------------------------------------- 对象 URL 与 Blob */
let blobSeq = 0
const blobs = new Map<string, string>()

/** 记录写入内容的文本，供断言核对导出文件正文 */
class StubBlob {
  readonly text: string
  constructor(parts: unknown[]) {
    this.text = parts.map((p) => (p instanceof Uint8Array ? String.fromCharCode(...p) : String(p))).join('')
  }
}

const g = globalThis as Record<string, unknown>
g.localStorage = stubStorage
g.window = stubWindow
g.document = stubDocument
g.Blob = StubBlob
// 无条件接管对象 URL，否则 Node 内置实现不会把内容留在可读的 Map 里
const U = URL as unknown as { createObjectURL: (b: unknown) => string; revokeObjectURL: (u: string) => void }
U.createObjectURL = (b: unknown) => {
  blobSeq += 1
  const url = `blob:zn-tb/${blobSeq}`
  blobs.set(url, b instanceof StubBlob ? b.text : String(b))
  return url
}
U.revokeObjectURL = (u: string) => {
  blobs.delete(u)
}

/** 校验脚本用：按对象 URL 取回写入的文本内容 */
export const blobText = (url: string): string => blobs.get(url) ?? ''

export {}
