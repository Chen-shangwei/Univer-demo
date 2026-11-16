<script setup lang="ts">
/**
 * 6.1 工作台（表 26 首页）：按角色聚合待办、进行中的任务与最近操作留痕。
 * 10.2 表 31 权限矩阵在此常驻呈现，并与实际生效的功能权限逐格自检。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { Right, WarningFilled } from '@element-plus/icons-vue'
import { api } from '../system/api'
import { orgById, rolesOf, userById } from '../system/db'
import { ROLE_LABEL } from '../system/schema-service'
import { current, PERM_MATRIX, permMatrixAudit } from '../system/session'
import type { RoleCode } from '../system/types'
import { LEVEL_TAG, tagTypeOf } from '../utils/display'
import { must } from '../utils/notify'

const router = useRouter()
const user = computed(() => current())
const data = computed(() => must(api.summary.workbench()))

/** 角色相关的关键指标卡（10.2 权限矩阵决定看到哪些） */
const cards = computed(() => {
  const d = data.value
  const list: { label: string; value: number; to?: string; note: string }[] = []
  if (user.value && d.fillCount >= 0) list.push({ label: '待我填报', value: d.fillCount, to: '/fill/list', note: '处于填报窗口内的任务' })
  if (d.rejectedCount) list.push({ label: '被驳回待修改', value: d.rejectedCount, to: '/fill/list', note: '含审核意见，修改后可重新提交' })
  if (d.draftCount) list.push({ label: '草稿', value: d.draftCount, to: '/fill/list', note: '30 秒自动保存的内容' })
  if (d.todoCount) list.push({ label: '审核待办', value: d.todoCount, to: '/audit/list', note: '停留在本节点的记录' })
  list.push({ label: '进行中任务', value: d.runningTasks, to: '/task/list', note: '在填报窗口内的任务' })
  list.push({ label: '待审核记录', value: d.waitingAudit, to: '/audit/list', note: '全部单位合计' })
  list.push({ label: '模板数', value: d.templates, to: '/template/list', note: '表 13 form_template' })
  list.push({ label: '填报单位', value: d.orgs, to: '/system/org', note: '二级及以上单位' })
  return list.slice(0, 8)
})

const statusText = ['待开始', '进行中', '已截止', '已归档']

/** el-table 的插槽行是 DefaultRow，这里只用到三个字段 */
function openView(v: Record<string, string>) {
  if (v.group === '已驳回' || v.group === '草稿' || v.group === '待填报') {
    router.push({ path: '/fill/detail', query: { taskId: v.taskId } })
    return
  }
  router.push({ path: '/fill/list' })
}

/* -------------------------------------------- 10.2 表 31 权限矩阵 */
const ROLES: RoleCode[] = ['sys_admin', 'template_admin', 'biz_admin', 'reporter', 'auditor']
const matrixAudit = computed(() => permMatrixAudit())
const drift = computed(() => matrixAudit.value.filter((m) => !m.ok))
const myRoles = computed(() => (user.value ? rolesOf(user.value) : []))
const isMine = (r: RoleCode) => myRoles.value.includes(r)
const cellOf = (label: string, role: RoleCode) => matrixAudit.value.find((m) => m.label === label && m.role === role)

/** 矩阵表一行一个角色，单元格带上与基线口径的比对结果 */
const matrixRows = computed(() =>
  ROLES.map((r) => ({
    role: r,
    name: ROLE_LABEL[r],
    mine: isMine(r),
    cells: PERM_MATRIX.map((c) => {
      const hit = cellOf(c.label, r)
      return { level: c.levels[r], actual: hit?.actual ?? '', ok: hit ? hit.ok : true }
    }),
  })),
)

function matrixClass({ row }: { row: { mine: boolean } }) {
  return row.mine ? 'row-mine' : ''
}
</script>

<template>
  <div>
    <h2 class="page-title">工作台</h2>
    <p class="page-sub">
      {{ user?.realName }}，欢迎回来。当前单位 {{ orgById(user?.orgId ?? '')?.orgName }}，这里只汇总与您角色相关的待办（10.2）。
    </p>

    <div class="stat-grid">
      <div
        v-for="c in cards"
        :key="c.label"
        class="stat"
        :style="{ cursor: c.to ? 'pointer' : 'default' }"
        @click="c.to && router.push(c.to)"
      >
        <b>{{ c.value }}</b>
        <span>{{ c.label }}</span>
        <p class="muted" style="margin: 4px 0 0">{{ c.note }}</p>
        <el-icon v-if="c.to" class="stat-go" :size="14"><Right /></el-icon>
      </div>
    </div>

    <div class="split" style="margin-top: 16px">
      <div class="main">
        <div class="card">
          <h3>我的任务（前 6 条）</h3>
          <el-table :data="data.myViews" size="small" border empty-text="当前账号没有可见任务">
            <el-table-column label="任务" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.taskName }}
                <div class="muted mono">{{ row.templateVersion }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="orgName" label="单位" min-width="130" show-overflow-tooltip />
            <el-table-column label="状态" width="90" align="center">
              <template #default="{ row }">{{ statusText[row.taskStatus] }}</template>
            </el-table-column>
            <el-table-column label="填报状态" width="100" align="center">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="tagTypeOf(row.recordStatus)">{{ row.group }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="截止" min-width="160">
              <template #default="{ row }">
                <span class="muted">{{ row.endTime }}（剩 {{ row.restDays }} 天）</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="center" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openView(row)">进入</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h3>最近操作留痕（3.10）</h3>
          <el-timeline>
            <el-timeline-item
              v-for="l in data.recentLogs"
              :key="l.logId"
              :timestamp="l.operTime"
              :type="l.result === 1 ? 'primary' : 'danger'"
              placement="top"
            >
              <div class="t-hd">{{ l.operType }} · {{ userById(l.userId)?.realName ?? l.userId }}</div>
              <div class="muted">{{ l.content }}</div>
              <div class="t-meta">{{ orgById(l.orgId)?.orgName ?? '' }} · {{ l.result === 1 ? '成功' : '失败' }}</div>
            </el-timeline-item>
          </el-timeline>
          <p class="row-gap" style="margin-top: 4px">
            <el-button size="small" @click="router.push('/log')">查看全部日志</el-button>
            <el-text size="small" type="info">日志只追加，不可修改删除</el-text>
          </p>
        </div>
      </div>
    </div>

    <!-- 10.2 表 31：功能权限基线，高亮行为当前账号所具备的档位 -->
    <div class="card" style="margin-top: 16px">
      <div class="row-gap">
        <h3 style="margin: 0">角色权限矩阵（10.2 表 31）</h3>
        <span class="spacer" />
        <el-tag v-if="!drift.length" type="success" effect="plain">矩阵与生效权限逐格一致</el-tag>
        <el-tag v-else type="danger" effect="plain">{{ drift.length }} 处口径不一致</el-tag>
        <el-button size="small" @click="router.push('/template/perm')">字段权限验证入口</el-button>
      </div>
      <el-table :data="matrixRows" size="small" border class="matrix-table" :row-class-name="matrixClass">
        <el-table-column label="角色" width="150" fixed>
          <template #default="{ row }">
            {{ row.name }}
            <el-tag v-if="row.mine" size="small" effect="plain">当前</el-tag>
            <div class="mono muted">{{ row.role }}</div>
          </template>
        </el-table-column>
        <el-table-column v-for="(c, ci) in PERM_MATRIX" :key="c.label" :label="c.label" min-width="104" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="LEVEL_TAG[row.cells[ci].level] ?? 'info'">{{ row.cells[ci].level }}</el-tag>
            <el-tooltip v-if="!row.cells[ci].ok" :content="`生效为 ${row.cells[ci].actual}`" placement="top">
              <el-icon class="drift"><WarningFilled /></el-icon>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
      <p class="flow-hint">
        上表为功能权限基线；字段权限需在填报与审核两个场景分别验证——填报场景重点看 edit 与 hidden，
        审核场景重点看 read 与 hidden（3.4）。高亮行为当前账号命中的角色。
      </p>
    </div>
  </div>
</template>

<style scoped>
.stat {
  position: relative;
}

.stat-go {
  position: absolute;
  right: 12px;
  top: 14px;
  color: var(--el-text-color-placeholder);
}

.stat:hover .stat-go {
  color: var(--el-color-primary);
}

.matrix-table {
  margin-top: 12px;
}

.drift {
  color: var(--el-color-warning);
  vertical-align: -2px;
  margin-left: 2px;
}
</style>
