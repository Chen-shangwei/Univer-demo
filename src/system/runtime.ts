/**
 * 7.5 并发与草稿机制（写会话锁）+ 3.9 附件管理（上传校验、短时签名下载）。
 * 原型内用 localStorage 中的锁表模拟 Redis 分布式锁，可跨标签页真实互斥。
 */
import { db, logOp, nextId, orgById } from './db'
import { ApiError, ERR } from './errors'
import { fmtClock, fmtDate, nowStr } from './time'
import type { FormAttachment, ID, SignedDownload, SysUser } from './types'

/* ----------------------------------------------------------- 7.5 锁 */

/** 锁超时 30 秒 */
export const LOCK_TTL = 30_000

export const lockKey = (taskId: ID, orgId: ID) => `${taskId}__${orgId}`

function prune(): void {
  const now = Date.now()
  const alive = db.edit_lock.filter((l) => l.expireAt > now)
  if (alive.length !== db.edit_lock.length) db.edit_lock.splice(0, db.edit_lock.length, ...alive)
}

/** 同一单位同一任务同一时刻只允许一个写入会话；同用户重入放行 */
export function acquireLock(taskId: ID, orgId: ID, user: SysUser): void {
  prune()
  const key = lockKey(taskId, orgId)
  const exist = db.edit_lock.find((l) => l.key === key)
  if (exist && exist.userId !== user.userId) {
    throw new ApiError(ERR.LOCKED, `该填报正在编辑中（${exist.userName} 于 ${fmtClock(new Date(exist.expireAt - LOCK_TTL))} 打开，锁 30 秒后自动释放）`)
  }
  const expireAt = Date.now() + LOCK_TTL
  if (exist) {
    exist.userId = user.userId
    exist.userName = user.realName
    exist.expireAt = expireAt
    return
  }
  db.edit_lock.push({ key, userId: user.userId, userName: user.realName, expireAt })
}

/** 页面每 15 秒续期一次 */
export function heartbeat(taskId: ID, orgId: ID, userId: ID): void {
  const l = db.edit_lock.find((x) => x.key === lockKey(taskId, orgId))
  if (l && l.userId === userId) l.expireAt = Date.now() + LOCK_TTL
}

export function releaseLock(taskId: ID, orgId: ID, userId: ID): void {
  const key = lockKey(taskId, orgId)
  const i = db.edit_lock.findIndex((l) => l.key === key && l.userId === userId)
  if (i >= 0) db.edit_lock.splice(i, 1)
}

export function lockHolder(taskId: ID, orgId: ID): string | null {
  prune()
  return db.edit_lock.find((l) => l.key === lockKey(taskId, orgId))?.userName ?? null
}

/* -------------------------------------------------------- 3.9 附件 */

export function attachmentsOf(recordId: ID, fieldKey?: string): FormAttachment[] {
  return db.form_attachment.filter(
    (a) => a.recordId === recordId && a.delFlag === 0 && (!fieldKey || a.fieldKey === fieldKey),
  )
}

export interface UploadLimit {
  accept: string[]
  maxSize: number
  maxCount: number
}

/** 8.2 其四：内容类型黑名单（扩展名之外的第二道闸） */
const EXEC_MIME = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-executable',
  'application/javascript',
  'text/javascript',
]

/** 可执行文件的文件头特征（Windows PE / ELF / shebang / Lua 字节码） */
const EXEC_HEADERS = ['MZ', '\u007fELF', '#!/', '\u001bLua']

/** 取内联内容的前若干字节做文件头嗅探；真实环境由对象存储侧扫描完成 */
function sniffHeader(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return ''
  const head = dataUrl.slice(0, comma)
  const body = dataUrl.slice(comma + 1)
  if (!head.includes('base64')) return decodeURIComponent(body.slice(0, 8))
  try {
    return atob(body.slice(0, 8))
  } catch {
    return ''
  }
}

/** 8.2 其四：上传校验扩展名、大小与数量，禁止可执行文件 */
export function addAttachment(
  recordId: ID,
  fieldKey: string,
  file: { name: string; size: number; type: string },
  user: SysUser,
  limit: UploadLimit,
  blob?: string,
): FormAttachment {
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
  if (['.exe', '.bat', '.cmd', '.sh', '.js', '.msi', '.dll'].includes(ext)) {
    throw new ApiError(ERR.ATTACH_LIMIT, `禁止上传可执行文件：${file.name}`)
  }
  if (limit.accept.length && !limit.accept.map((a) => a.toLowerCase()).includes(ext)) {
    throw new ApiError(ERR.ATTACH_LIMIT, `文件类型 ${ext || '未知'} 不在允许范围：${limit.accept.join('/')}`)
  }
  if (EXEC_MIME.includes((file.type ?? '').toLowerCase())) {
    throw new ApiError(ERR.ATTACH_LIMIT, `禁止上传可执行文件（内容类型 ${file.type}）：${file.name}`)
  }
  if (blob && EXEC_HEADERS.some((sig) => sniffHeader(blob).startsWith(sig))) {
    throw new ApiError(ERR.ATTACH_LIMIT, `文件头校验未通过，禁止上传可执行文件：${file.name}`)
  }
  if (file.size > limit.maxSize * 1024 * 1024) {
    throw new ApiError(ERR.ATTACH_LIMIT, `单个文件不得超过 ${limit.maxSize}MB，当前 ${(file.size / 1024 / 1024).toFixed(2)}MB`)
  }
  const exist = attachmentsOf(recordId, fieldKey)
  if (exist.length >= limit.maxCount) {
    throw new ApiError(ERR.ATTACH_LIMIT, `该字段最多 ${limit.maxCount} 个附件，当前已有 ${exist.length} 个`)
  }
  const att: FormAttachment = {
    delFlag: 0,
    attId: nextId('AT'),
    recordId,
    fieldKey,
    fileName: file.name,
    // 数据库只保存文件标识与访问路径，不暴露存储地址
    filePath: `minio://zn-tb/${fmtDate(new Date()).slice(0, 7).replace('-', '/')}/${nextId('OBJ')}${ext}`,
    fileSize: file.size,
    fileType: ext.replace('.', '') || 'bin',
    uploadUser: user.userId,
    uploadTime: nowStr(),
    blob,
  }
  db.form_attachment.push(att)
  return att
}

export function removeAttachment(attId: ID, user: SysUser, editable: boolean): void {
  if (!editable) throw new ApiError(ERR.FORBIDDEN, '提交后附件随表单转为只读（3.9）')
  const a = db.form_attachment.find((x) => x.attId === attId)
  if (!a) throw new ApiError(ERR.NOT_FOUND, '附件不存在')
  // 4.6 其二：仅标记删除，文件实体由归档任务统一清理
  a.delFlag = 1
  logOp({ userId: user.userId, orgId: user.orgId, operType: '附件变更', bizId: attId, bizType: 'record', content: `删除附件「${a.fileName}」` })
}

/* --------------------------------------- 短时签名地址（默认 5 分钟） */

const signed = new Map<string, SignedDownload & { fileName: string; content: Blob }>()

export function signDownload(attId: ID, user: SysUser, minutes = 5): SignedDownload {
  const a = db.form_attachment.find((x) => x.attId === attId && x.delFlag === 0)
  if (!a) throw new ApiError(ERR.NOT_FOUND, '附件不存在或已删除')
  const content = a.blob
    ? dataUrlToBlob(a.blob)
    : new Blob([`【原型占位文件】${a.fileName}\n存储地址：${a.filePath}\n大小：${a.fileSize} 字节\n上传人：${db.sys_user.find((u) => u.userId === a.uploadUser)?.realName ?? a.uploadUser}\n上传时间：${a.uploadTime}\n说明：真实环境由 MinIO 返回文件流。`], {
        type: 'text/plain;charset=utf-8',
      })
  const token = `${attId}-${Math.random().toString(36).slice(2, 10)}`
  const url = URL.createObjectURL(content)
  const rec = { token, url, expireAt: Date.now() + minutes * 60_000, fileName: a.fileName, content }
  signed.set(token, rec)
  logOp({ userId: user.userId, orgId: user.orgId, operType: '附件下载', bizId: attId, bizType: 'record', content: `签发 ${minutes} 分钟有效下载凭证并下载「${a.fileName}」` })
  return { token, url, expireAt: rec.expireAt }
}

export function consumeDownload(token: string): { fileName: string; url: string } {
  const rec = signed.get(token)
  if (!rec) throw new ApiError(ERR.NOT_FOUND, '下载凭证无效')
  if (Date.now() > rec.expireAt) {
    signed.delete(token)
    URL.revokeObjectURL(rec.url)
    throw new ApiError(ERR.LINK_EXPIRED, '下载链接已过期，请重新获取')
  }
  return { fileName: rec.fileName, url: rec.url }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(head ?? '')?.[1] ?? 'application/octet-stream'
  if ((head ?? '').includes('base64')) {
    const bin = atob(body ?? '')
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i)
    return new Blob([buf], { type: mime })
  }
  return new Blob([decodeURIComponent(body ?? '')], { type: mime })
}

/* ------------------------------------------------ 导出/下载通用触发 */

export function saveBlob(name: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function storageWarning(orgId: ID): string {
  const used = (localStorage.getItem('zn-tb-db-v2')?.length ?? 0) / 1024
  if (used < 3000) return ''
  return `当前本地存储占用约 ${(used / 1024).toFixed(1)}MB，接近浏览器配额上限，建议在 ${orgById(orgId)?.orgName ?? '管理端'} 清理历史附件。`
}
