/**
 * 令牌：M0 用 node:crypto 的 HMAC-SHA256 自签，零额外依赖，格式对齐 JWT 的 header.payload.signature 三段式（此处省略 header）。
 * 生产环境（M2+）可平滑替换为 @fastify/jwt 或非对称密钥；payload 结构不变。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.JWT_SECRET || 'zn-tb-dev-secret-change-me'
/** 有效期 8 小时，与前端 session.ts 的 TOKEN_TTL 口径一致（5.1） */
const TTL_SECONDS = 8 * 60 * 60

const b64url = (input: string) => Buffer.from(input).toString('base64url')

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url')
}

/** 签发令牌，载荷仅放用户标识与过期时间 */
export function issueToken(userId: string): string {
  const payload = b64url(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS }))
  return `${payload}.${sign(payload)}`
}

/** 校验令牌，通过返回 userId，失败返回 null */
export function verifyToken(token: string | undefined): string | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null

  const expect = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: string; exp?: number }
    if (!data.sub || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null
    return data.sub
  } catch {
    return null
  }
}
