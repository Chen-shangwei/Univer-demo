<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown, DataAnalysis, EditPen, Files, Odometer, Setting, SwitchButton } from '@element-plus/icons-vue'
import { api } from './system/api'
import { db, orgById, rolesOf } from './system/db'
import { ROLE_LABEL } from './system/schema-service'
import { can, current, logout, session } from './system/session'
import type { Feature } from './system/session'
import { confirmAction, must, runAsync, toast } from './utils/notify'

const route = useRoute()
const router = useRouter()
const user = computed(() => current())

/** 6.1 导航项：按 10.2 权限矩阵与功能权限过滤 */
const NAVS: { to: string; label: string; feature?: Feature; group: string }[] = [
  { to: '/workbench', label: '工作台', group: '总览' },
  { to: '/system/org', label: '组织与用户', feature: 'org.view', group: '系统管理' },
  { to: '/log', label: '操作日志', feature: 'log.view', group: '系统管理' },
  { to: '/template/list', label: '表单模板', feature: 'template.view', group: '配置中心' },
  { to: '/template/diff', label: '差异化配置', feature: 'template.view', group: '配置中心' },
  { to: '/template/perm', label: '字段权限', feature: 'template.view', group: '配置中心' },
  { to: '/task/list', label: '填报任务', feature: 'task.view', group: '填报业务' },
  { to: '/fill/list', label: '我的填报', group: '填报业务' },
  { to: '/audit/list', label: '审核待办', feature: 'audit.view', group: '填报业务' },
  { to: '/summary', label: '汇总与导出', feature: 'summary.view', group: '填报业务' },
]

const navs = computed(() => {
  const u = user.value
  if (!u) return []
  return NAVS.filter((n) => !n.feature || can(u, n.feature))
})

/** 分组图标：el-sub-menu 的标题位 */
const GROUP_ICON: Record<string, Component> = {
  总览: markRaw(Odometer),
  系统管理: markRaw(Setting),
  配置中心: markRaw(Files),
  填报业务: markRaw(EditPen),
}

const grouped = computed(() => {
  const map = new Map<string, typeof navs.value>()
  navs.value.forEach((n) => {
    const arr = map.get(n.group) ?? []
    arr.push(n)
    map.set(n.group, arr)
  })
  return [...map.entries()].map(([group, items]) => ({ group, items, icon: GROUP_ICON[group] }))
})

const roleText = computed(() => {
  const u = user.value
  return u ? rolesOf(u).map((r) => ROLE_LABEL[r]).join(' / ') : ''
})

/** 详情页要把高亮落到它的入口上（/fill/detail → /fill/list） */
const activeNav = computed(() => {
  const path = route.path
  const exact = navs.value.find((n) => n.to === path)
  if (exact) return exact.to
  const seg = path.split('/')[1] ?? ''
  return navs.value.find((n) => n.to.startsWith(`/${seg}/`))?.to ?? ''
})

/** 5.1 令牌有效期：剩余时间到点自动退出 */
const leftText = ref('')
let timer = 0
function tick() {
  const s = session.value
  if (!s) {
    leftText.value = ''
    return
  }
  const ms = s.expireAt - Date.now()
  if (ms <= 0) {
    // 令牌过期不再留痕（接口要当前登录人，此时已取不到），直接回登录页
    void goLogin('登录已过期，请重新登录')
    return
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  leftText.value = `令牌剩余 ${h}小时${m}分`
}
onMounted(() => {
  tick()
  timer = window.setInterval(tick, 30_000)
})
onBeforeUnmount(() => window.clearInterval(timer))

/**
 * 退出后的统一落点：先清会话再跳登录页。
 * 路由守卫对 /login 的口径是「已登录则回各自首页」，先跳后清会被弹回原页面，永远停在登录页外。
 */
async function goLogin(tip: string) {
  if (timer) {
    window.clearInterval(timer)
    timer = 0
  }
  leftText.value = ''
  logout()
  await router.replace('/login')
  toast('info', tip)
}

/** 3.10：退出动作先调接口留痕（需当前登录人），再清会话回登录页 */
function doLogout() {
  void runAsync(async () => {
    const yes = await confirmAction('退出后需重新登录才能继续填报，未保存的草稿内容可能丢失，确认退出？', '退出登录')
    if (!yes) return
    must(api.auth.logout())
    await goLogin('已退出登录')
  })
}

/** el-dropdown 的 command 对所有项都会触发，按标识分流 */
function onUserCommand(cmd: string | number | object) {
  if (cmd === 'logout') doLogout()
}

const orgName = computed(() => orgById(user.value?.orgId ?? '')?.orgName ?? '')
const deptName = computed(() => {
  const u = user.value
  return u ? (db.sys_dept.find((d) => d.deptId === u.deptId)?.deptName ?? '') : ''
})
</script>

<template>
  <div class="app-shell">
    <header v-if="user" class="app-head">
      <span class="brand">
        <el-icon :size="20"><DataAnalysis /></el-icon>
        智能填报系统
      </span>

      <nav class="head-nav">
        <!-- 切换路由后重建菜单：EP 的横向菜单不响应 default-active 的后续变化 -->
        <el-menu :key="activeNav" mode="horizontal" :ellipsis="false" :default-active="activeNav" router>
          <template v-for="g in grouped" :key="g.group">
            <el-menu-item v-if="g.items.length === 1" :index="g.items[0]!.to">
              <el-icon><component :is="g.icon" /></el-icon>
              <span>{{ g.items[0]!.label }}</span>
            </el-menu-item>
            <el-sub-menu v-else :index="g.group">
              <template #title>
                <el-icon><component :is="g.icon" /></el-icon>
                <span>{{ g.group }}</span>
              </template>
              <el-menu-item v-for="n in g.items" :key="n.to" :index="n.to">{{ n.label }}</el-menu-item>
            </el-sub-menu>
          </template>
        </el-menu>
      </nav>

      <div class="head-slot">
        <el-tag type="info" effect="plain" size="small">{{ leftText }}</el-tag>
        <el-dropdown trigger="click" @command="onUserCommand">
          <span class="who-trigger">
            <el-avatar :size="28" class="avatar">{{ user.realName.slice(0, 1) }}</el-avatar>
            <span class="who">
              <b>{{ user.realName }}</b>
              <small>{{ roleText }}</small>
            </span>
            <el-icon class="caret"><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>
                {{ orgName }}{{ deptName ? ' / ' + deptName : '' }}
              </el-dropdown-item>
              <el-dropdown-item divided command="logout">
                <el-icon><SwitchButton /></el-icon>退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <main class="app-body">
      <!-- key 绑定 fullPath：页面间跳转时强制重建，避免沿用上一任务/记录的上下文 -->
      <RouterView :key="route.fullPath" />
    </main>
  </div>
</template>
