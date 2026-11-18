<script setup lang="ts">
/**
 * 3.6 在线填报入口 —— 我的填报任务列表。
 * 任务按状态分组（待填报 / 草稿 / 已提交 / 已驳回 / 已归档 / 未填报），
 * 不可填报的任务原样展示原因，而不是把按钮置灰让用户猜（3.6 其五）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import { remote } from '../system/http'
import { current } from '../system/session'
import type { TaskView } from '../system/flow'
import { tagTypeOf } from '../utils/display'
import { run, toast } from '../utils/notify'

const router = useRouter()
const GROUPS = ['全部', '待填报', '草稿', '已驳回', '已提交', '已归档', '未填报'] as const
const group = ref<(typeof GROUPS)[number]>('全部')
const keyword = ref('')

const me = current()
const views = ref<TaskView[]>([])
const loading = ref(false)

/** M3 扩面：我的填报任务视图改由后台 taskViewsFor 下发 */
async function load() {
  loading.value = true
  try {
    const r = await remote.taskMyList()
    if (r.code === 200) views.value = (r.data ?? []) as unknown as TaskView[]
    else toast('err', r.msg)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const counted = computed(() => {
  const map = new Map<string, number>()
  GROUPS.slice(1).forEach((g) => map.set(g, views.value.filter((v) => v.group === g).length))
  return map
})

const list = computed(() =>
  views.value
    .filter((v) => group.value === '全部' || v.group === group.value)
    .filter((v) => !keyword.value.trim() || v.taskName.includes(keyword.value.trim()) || v.orgName.includes(keyword.value.trim()))
    .sort((a, b) => a.restDays - b.restDays || a.taskName.localeCompare(b.taskName)),
)

/** 7.6 一单位多条记录时，新建记录取下一个序号 */
function nextSeq(v: TaskView) {
  return v.recordCount + 1
}

function open(v: TaskView, seq: number) {
  run(() => {
    router.push({ path: '/fill/detail', query: { taskId: v.taskId, seq } })
  })
}

function addRecord(v: TaskView) {
  open(v, nextSeq(v))
}
</script>

<template>
  <div v-loading="loading">
    <h2 class="page-title">我的填报任务</h2>
    <p class="page-sub">
      3.6：仅展示本单位在下发范围内的任务。已提交与已归档的数据不可再改为草稿；被驳回的任务会常驻显示审核意见。
    </p>

    <div class="card row-gap">
      <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="按任务名称 / 单位名称检索" style="width: 300px" />
      <span class="spacer" />
      <el-text size="small" type="info">当前身份：{{ me?.realName }}，可见 {{ views.length }} 条任务视图</el-text>
    </div>

    <el-tabs v-model="group" class="fill-tabs">
      <el-tab-pane v-for="g in GROUPS" :key="g" :name="g">
        <template #label>
          {{ g }}
          <span v-if="g !== '全部'" class="muted">（{{ counted.get(g) ?? 0 }}）</span>
        </template>
      </el-tab-pane>
    </el-tabs>

    <div class="card">
      <el-table :data="list" border stripe empty-text="该分组下没有任务">
        <el-table-column label="任务名称" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.taskName }}
            <span class="muted mono">· {{ row.templateVersion }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="orgName" label="填报单位" min-width="140" show-overflow-tooltip />
        <el-table-column label="填报周期" min-width="180">
          <template #default="{ row }">
            <span class="mono">{{ String(row.startTime).slice(0, 10) }} ~ {{ String(row.endTime).slice(0, 10) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="剩余" width="90" align="center">
          <template #default="{ row }">
            <span :class="row.restDays <= 3 && row.canFill ? 'urgent' : 'muted'">
              {{ row.restDays > 0 ? `${row.restDays} 天` : '已截止' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="tagTypeOf(row.recordStatus)">{{ row.group }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="recordCount" label="记录数" width="80" align="right" />
        <el-table-column label="说明" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <el-text v-if="row.recordStatus === 'reject'" type="danger" size="small">被驳回，请修改后重新提交</el-text>
            <el-text v-else type="info" size="small">{{ row.reason || '可正常填报' }}</el-text>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="190" align="center" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              :type="row.canFill ? 'primary' : 'default'"
              @click="open(row as TaskView, row.recordCount || 1)"
            >
              {{ row.canFill ? '继续填报' : '查看' }}
            </el-button>
            <el-button v-if="row.canFill && row.recordCount" size="small" @click="addRecord(row as TaskView)">再加一条</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="flow-hint" style="margin-top: 12px">
        「再加一条」仅在任务关闭了一单位一记录限制时可用（7.6）；提交后同一单位的记录进入待审核，不允许重复提交（1006）。
      </p>
    </div>
  </div>
</template>

<style scoped>
.fill-tabs {
  margin: 0 0 16px;
}

.urgent {
  color: var(--el-color-danger);
  font-weight: 600;
}
</style>
