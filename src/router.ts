/**
 * 6.1 页面清单（表 26）—— 全部 13 个页面路由，另加 3.1 组织与用户管理。
 * 6.5 其四：按路由拆分代码包，因此所有页面组件使用懒加载。
 */
import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { can, current, homeOf } from './system/session'
import type { Feature } from './system/session'

const V = (name: string) => (() => import(`./views/${name}.vue`))

const routes: RouteRecordRaw[] = [
  { path: '/login', component: V('LoginView'), meta: { public: true, title: '登录' } },
  { path: '/workbench', component: V('WorkbenchView'), meta: { title: '工作台' } },

  // 3.1 组织与用户管理
  { path: '/system/org', component: V('OrgManageView'), meta: { title: '组织与用户', feature: 'org.view' } },

  // 3.2 ~ 3.4 模板、差异、权限
  { path: '/template/list', component: V('TemplateListView'), meta: { title: '表单模板管理', feature: 'template.view' } },
  { path: '/template/edit', component: V('TemplateEditView'), meta: { title: '模板字段配置', feature: 'template.view' } },
  { path: '/template/diff', component: V('TemplateDiffView'), meta: { title: '子单位差异化配置', feature: 'template.view' } },
  { path: '/template/perm', component: V('TemplatePermView'), meta: { title: '字段级权限配置', feature: 'template.view' } },

  // 3.5 任务管理
  { path: '/task/list', component: V('TaskListView'), meta: { title: '填报任务管理', feature: 'task.view' } },

  // 3.6 在线填报
  { path: '/fill/list', component: V('FillListView'), meta: { title: '我的填报任务' } },
  { path: '/fill/detail', component: V('FillDetailView'), meta: { title: '在线填报', feature: 'fill.edit' } },

  // 3.7 填报审核
  { path: '/audit/list', component: V('AuditListView'), meta: { title: '审核工作台', feature: 'audit.view' } },
  { path: '/audit/detail', component: V('AuditDetailView'), meta: { title: '填报审核', feature: 'audit.view' } },

  // 3.8 数据汇总与导出
  { path: '/summary', component: V('SummaryView'), meta: { title: '数据汇总与导出', feature: 'summary.view' } },

  // 3.10 操作日志
  { path: '/log', component: V('LogView'), meta: { title: '操作日志', feature: 'log.view' } },

  {
    path: '/',
    redirect: () => {
      const u = current()
      return u ? homeOf(u) : '/login'
    },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  // hash 模式：dist 直接双击或任意静态托管都能跑
  history: createWebHashHistory(),
  routes,
})

/** 2.6 功能权限：路由级拦截，字段级权限在渲染与提交两处各自校验 */
router.beforeEach((to) => {
  if (to.meta.public) return current() ? '/' : true
  const u = current()
  if (!u) return '/login'

  const feature = to.meta.feature as Feature | undefined
  if (feature && !can(u, feature)) {
    // 无权访问时回落到该角色的首页，而不是报错页
    const home = homeOf(u)
    return home === to.path ? true : home
  }
  return true
})
