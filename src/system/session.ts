/**
 * 5.1 令牌与会话 + 2.6/10.2 功能权限矩阵。
 * 说明：原型在浏览器内模拟登录签发令牌（生产由统一身份平台发起，3.1），
 * 令牌有效期默认 8 小时，超时需重新获取。
 */
import { computed, ref } from 'vue'
import { db, hasRole, rolesOf } from './db'
import { ApiError, ERR } from './errors'
import { ROLE_LABEL } from './schema-service'
import type { RoleCode, SysUser } from './types'

const SESSION_KEY = 'zn-tb-session'
const TOKEN_TTL = 8 * 60 * 60 * 1000

interface SessionState {
  userId: string
  token: string
  issuedAt: number
  expireAt: number
}

const raw = localStorage.getItem(SESSION_KEY)
export const session = ref<SessionState | null>(raw ? (JSON.parse(raw) as SessionState) : null)

function randomToken(): string {
  const buf = new Uint32Array(4)
  crypto.getRandomValues(buf)
  return [...buf].map((n) => n.toString(36)).join('')
}

/** 5.2 接口 1：POST /api/auth/login */
export function login(username: string, password: string): SysUser {
  const u = db.sys_user.find((x) => x.username === username && x.delFlag === 0)
  if (!u || u.password !== password) throw new ApiError(ERR.UNAUTHORIZED, '账号或密码错误')
  if (u.status === 0) throw new ApiError(ERR.FORBIDDEN, '账号已停用，仅影响登录（3.1）')
  const s: SessionState = { userId: u.userId, token: randomToken(), issuedAt: Date.now(), expireAt: Date.now() + TOKEN_TTL }
  session.value = s
  localStorage.setItem(SESSION_KEY, JSON.stringify(s))
  return u
}

export function logout(): void {
  session.value = null
  localStorage.removeItem(SESSION_KEY)
}

/**
 * M3 前端联调：登录改走后台后，用后端签发的令牌接管本地会话。
 * 仅写入 userId + 后端 token + 过期时间，current() 仍按 userId 回查本地表驱动其余页面。
 */
export function adoptSession(u: SysUser, token: string): void {
  const s: SessionState = { userId: u.userId, token, issuedAt: Date.now(), expireAt: Date.now() + TOKEN_TTL }
  session.value = s
  localStorage.setItem(SESSION_KEY, JSON.stringify(s))
}

/** 供 http 层读取当前有效令牌；未登录或过期返回 null */
export function sessionToken(): string | null {
  const s = session.value
  if (!s || Date.now() > s.expireAt) return null
  return s.token
}

/** 令牌校验：401 未登录或令牌失效 */
export function current(): SysUser | null {
  const s = session.value
  if (!s) return null
  if (Date.now() > s.expireAt) {
    logout()
    return null
  }
  return db.sys_user.find((u) => u.userId === s.userId && u.status === 1) ?? null
}

export function mustCurrent(): SysUser {
  const u = current()
  if (!u) throw new ApiError(ERR.UNAUTHORIZED)
  return u
}

export const isLogin = computed(() => !!session.value)

/* -------------------------------------------- 10.2 权限矩阵（功能权限） */

export type Feature =
  | 'org.view'
  | 'org.edit'
  | 'log.view'
  | 'template.view'
  | 'template.edit'
  | 'task.view'
  | 'task.edit'
  | 'fill.edit'
  | 'audit.view'
  | 'audit.edit'
  | 'summary.view'
  | 'summary.export'

/** 表31 权限矩阵基线；「不可」= 矩阵中无该角色，「查看」= view 权限 */
export const FEATURE_ROLES: Record<Feature, RoleCode[]> = {
  'org.view': ['sys_admin'],
  'org.edit': ['sys_admin'],
  'log.view': ['sys_admin'],
  'template.view': ['sys_admin', 'template_admin', 'biz_admin'],
  'template.edit': ['template_admin'],
  // 10.2 表31：表单管理员不参与任务下发
  'task.view': ['sys_admin', 'biz_admin'],
  'task.edit': ['biz_admin'],
  'fill.edit': ['reporter'],
  'audit.view': ['biz_admin', 'auditor'],
  'audit.edit': ['auditor'],
  'summary.view': ['sys_admin', 'biz_admin', 'auditor'],
  'summary.export': ['biz_admin'],
}

export function can(user: SysUser | null, feature: Feature): boolean {
  if (!user) return false
  return FEATURE_ROLES[feature].some((r) => hasRole(user, r))
}

export function mustFeature(feature: Feature): SysUser {
  const u = mustCurrent()
  if (!can(u, feature)) throw new ApiError(ERR.FORBIDDEN, `当前账号缺少「${feature}」功能权限`)
  return u
}

/* -------------------------------------- 10.2 表31 权限矩阵呈现与自检 */

export type PermLevel = '编辑' | '查看' | '只读' | '不可'

export interface PermMatrixRow {
  /** 表31 的列名 */
  label: string
  /** 判定「编辑」档所需的功能权限 */
  edit?: Feature
  /** 判定「查看」档所需的功能权限 */
  view?: Feature
  levels: Record<RoleCode, PermLevel>
}

/** 表31 原文基线，用于界面呈现；与 FEATURE_ROLES 逐格比对，防止口径漂移 */
export const PERM_MATRIX: PermMatrixRow[] = [
  {
    label: '模板配置',
    edit: 'template.edit',
    view: 'template.view',
    levels: { sys_admin: '查看', template_admin: '编辑', biz_admin: '查看', reporter: '不可', auditor: '不可' },
  },
  {
    label: '任务下发',
    edit: 'task.edit',
    view: 'task.view',
    levels: { sys_admin: '查看', template_admin: '不可', biz_admin: '编辑', reporter: '不可', auditor: '不可' },
  },
  {
    label: '填报',
    edit: 'fill.edit',
    levels: { sys_admin: '不可', template_admin: '不可', biz_admin: '不可', reporter: '编辑', auditor: '只读' },
  },
  {
    label: '审核',
    edit: 'audit.edit',
    view: 'audit.view',
    levels: { sys_admin: '不可', template_admin: '不可', biz_admin: '查看', reporter: '不可', auditor: '编辑' },
  },
  {
    label: '汇总导出',
    edit: 'summary.export',
    view: 'summary.view',
    levels: { sys_admin: '查看', template_admin: '不可', biz_admin: '编辑', reporter: '不可', auditor: '查看' },
  },
]

/**
 * 逐格自检：矩阵声明的档位与实际生效的功能权限是否一致。
 * 编辑 = 具备 edit；查看 = 具备 view 且不具备 edit；不可 = 两者都不具备；只读 = 不具备 edit（审核场景以只读呈现表单）。
 */
export function permMatrixAudit(): { label: string; role: RoleCode; level: PermLevel; ok: boolean; actual: string }[] {
  const probe = (role: RoleCode, f?: Feature) => (f ? FEATURE_ROLES[f].includes(role) : false)
  const out: { label: string; role: RoleCode; level: PermLevel; ok: boolean; actual: string }[] = []
  PERM_MATRIX.forEach((row) => {
    ;(Object.keys(row.levels) as RoleCode[]).forEach((role) => {
      const level = row.levels[role]
      const editable = probe(role, row.edit)
      const viewable = probe(role, row.view) || editable
      let ok: boolean
      let actual: string
      if (level === '编辑') {
        ok = editable
        actual = editable ? 'edit' : viewable ? 'view' : 'none'
      } else if (level === '查看') {
        ok = viewable && !editable
        actual = editable ? 'edit' : viewable ? 'view' : 'none'
      } else if (level === '只读') {
        ok = !editable
        actual = editable ? 'edit' : 'none'
      } else {
        ok = !editable && !viewable
        actual = editable ? 'edit' : viewable ? 'view' : 'none'
      }
      out.push({ label: row.label, role, level, ok, actual })
    })
  })
  return out
}

/* ------------------------------------------------------- 导航与首页 */

/** 主角色：多角色用户按此顺序取第一个命中的作为落地页（3.1 一个用户可有多个角色） */
const PRIMARY: RoleCode[] = ['sys_admin', 'template_admin', 'biz_admin', 'auditor', 'reporter']

export const HOME_BY_ROLE: Record<RoleCode, string> = {
  sys_admin: '/system/org',
  template_admin: '/template/list',
  biz_admin: '/task/list',
  auditor: '/audit/list',
  reporter: '/fill/list',
}

export function homeOf(user: SysUser): string {
  const roles = rolesOf(user)
  const primary = PRIMARY.find((r) => roles.includes(r))
  return primary ? HOME_BY_ROLE[primary] : '/workbench'
}

export function roleLabels(user: SysUser): string {
  return rolesOf(user)
    .map((r) => ROLE_LABEL[r])
    .join(' / ')
}
