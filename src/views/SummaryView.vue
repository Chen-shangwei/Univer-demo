<script setup lang="ts">
/**
 * 3.8 数据汇总与导出。
 * 7.4 行转列：列对应模板字段（含差异新增列与已停用列），行对应填报记录，明细区多行按行展开。
 * 3.8 其二：以当前登录人的字段权限口径呈现，hidden 字段不进入列；
 * 3.8 其五：数据量较大时走异步导出作业，完成后签发 30 分钟有效下载链接。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { api } from '../system/api'
import { db, hasRole, orgById } from '../system/db'
import { ASYNC_THRESHOLD, EXPORT_LINK_MINUTES } from '../system/flow'
import { current } from '../system/session'
import { ROLE } from '../system/types'
import type { SummaryFilter } from '../system/flow'
import type { WideRow } from '../system/row2col'
import type { ExportJob, FieldValue, ID, RecordStatus } from '../system/types'
import { must, fmt, run, toast } from '../utils/notify'
import { tagTypeOf } from '../utils/display'

const me = current()
/* ------------------------------------------------ 任务与筛选条件 */
const tasks = computed(() => db.form_task.filter((t) => t.delFlag === 0))
const taskId = ref(tasks.value[0]?.taskId ?? '')
const task = computed(() => tasks.value.find((t) => t.taskId === taskId.value) ?? null)

const scopeOrgs = computed<ID[]>(() => (taskId.value ? must(api.task.scopes(taskId.value)).map((o) => o.orgId) : []))
const pickedOrgs = ref<ID[]>([])
const status = ref<RecordStatus | 'none' | ''>('')
const submitFrom = ref('')
const submitTo = ref('')
const keyword = ref('')
const pageNum = ref(1)

/** 切换任务后下发范围失效，筛选条件一并重置 */
function switchTask(id: string) {
  taskId.value = id
  pickedOrgs.value = []
  status.value = ''
  submitFrom.value = ''
  submitTo.value = ''
  keyword.value = ''
  pageNum.value = 1
}

function toggleOrg(id: ID) {
  pickedOrgs.value = pickedOrgs.value.includes(id) ? pickedOrgs.value.filter((x) => x !== id) : [...pickedOrgs.value, id]
}

const filter = computed<SummaryFilter>(() => ({
  orgIds: pickedOrgs.value.length ? [...pickedOrgs.value] : undefined,
  status: status.value || undefined,
  submitFrom: submitFrom.value || undefined,
  submitTo: submitTo.value || undefined,
  keyword: keyword.value.trim() || undefined,
}))

/* ------------------------------------------------ 宽表与进度 */
const PAGE_SIZE = 20
const page = computed(() =>
  taskId.value
    ? must(api.summary.page(taskId.value, filter.value, { pageNum: pageNum.value, pageSize: PAGE_SIZE }))
    : null,
)
const columns = computed(() => page.value?.columns ?? [])
const progress = computed(() => page.value?.progress ?? null)
const totalRows = computed(() => page.value?.total ?? 0)
/** 7.4：超过该记录数时界面提示改走异步导出 */
const needAsync = computed(() => totalRows.value > ASYNC_THRESHOLD)

const STATUS_OPTIONS: { value: RecordStatus | 'none' | ''; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'none', label: '未填报' },
  { value: 'draft', label: '草稿' },
  { value: 'submitted', label: '待审核' },
  { value: 'reject', label: '已驳回' },
  { value: 'pass', label: '已归档' },
]

/** 列的适用单位与口径说明（3.8 差异字段标注） */
function colNote(c: { allOrgs: boolean; appliesTo: ID[]; aliases: string[]; deprecated: boolean }): string {
  const parts: string[] = []
  if (!c.allOrgs) parts.push(`仅适用：${c.appliesTo.map((o) => orgById(o)?.orgName ?? o).join('、')}`)
  if (c.aliases.length > 1) parts.push(`口径：${c.aliases.join(' / ')}`)
  if (c.deprecated) parts.push('当前模板版本已停用该字段，仅历史记录有值（7.3）')
  return parts.join('；')
}

const cellOf = (row: { values: Record<string, FieldValue> }, key: string) => {
  const v = row.values[key]
  return v === null || v === undefined ? '' : String(v)
}
const notApplied = (row: { orgId: ID }, c: { allOrgs: boolean; appliesTo: ID[] }) => !c.allOrgs && !c.appliesTo.includes(row.orgId)

/* ------------------------------------------------ 导出 */
const canExport = computed(() => hasRole(me, ROLE.BIZ_ADMIN))
const jobs = ref<ExportJob[]>([])
let timer = 0

function refreshJobs() {
  jobs.value = must(api.export.jobs())
}
/** 作业在后台分片生成，界面轮询状态直至完成 */
function watchJobs() {
  timer = window.setInterval(() => {
    refreshJobs()
    if (!jobs.value.some((j) => j.status === 'running')) {
      window.clearInterval(timer)
      timer = 0
    }
  }, 1200)
}
onBeforeUnmount(() => timer && window.clearInterval(timer))

function exportNow(kind: 'detail' | 'progress') {
  run(() => {
    if (!taskId.value) throw new Error('请先选择任务')
    must(api.export.now(taskId.value, filter.value, kind))
    toast('ok', kind === 'detail' ? '已按当前筛选条件导出宽表明细（小数据量同步导出）' : '已导出填报进度')
    refreshJobs()
  })
}

function exportAsync() {
  run(() => {
    const r = must(api.export.task(taskId.value, filter.value))
    toast('info', `导出作业 ${r.jobId} 已创建，生成中…完成后可下载（${EXPORT_LINK_MINUTES} 分钟内有效）`)
    refreshJobs()
    if (!timer) watchJobs()
  })
}

function download(token: string) {
  run(() => {
    must(api.export.download(token))
    toast('ok', '已通过短时凭证下载，链接不暴露存储地址')
  })
}

const expireLeft = (job: ExportJob) => {
  if (!job.download) return ''
  const min = Math.max(0, Math.round((job.download.expireAt - Date.now()) / 60_000))
  return `${min} 分钟后失效`
}

const orgName = (id: ID) => orgById(id)?.orgName ?? id
const stateText = () => (page.value ? `共 ${totalRows.value} 行 · ${columns.value.length} 列 · 刷新于 ${fmt(new Date()).slice(11, 19)}` : '')
</script>

<template>
  <div>
    <h2 class="page-title">数据汇总与导出</h2>
    <p class="page-sub">
      7.4 行转列为宽表：列对应模板字段、行对应填报记录，明细区多行按行展开；列顺序与模板一致，差异新增列与已停用列单独标注。
    </p>

    <div class="card">
      <div class="row-gap">
        <label class="muted">任务</label>
        <el-select :model-value="taskId" filterable style="width: 260px" @change="(v: string) => switchTask(v)">
          <el-option v-for="t in tasks" :key="t.taskId" :label="`${t.taskName}（${t.startTime.slice(0, 7)}）`" :value="t.taskId" />
        </el-select>
        <el-select v-model="status" style="width: 130px">
          <el-option v-for="s in STATUS_OPTIONS" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
        <el-date-picker v-model="submitFrom" type="date" value-format="YYYY-MM-DD" placeholder="提交时间起" style="width: 150px" />
        <span class="muted">~</span>
        <el-date-picker v-model="submitTo" type="date" value-format="YYYY-MM-DD" placeholder="提交时间止" style="width: 150px" />
        <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="按内容或单位检索" style="width: 220px" />
        <el-button @click="pageNum = 1">查询</el-button>
        <span class="spacer" />
        <span class="muted">{{ stateText() }}</span>
      </div>
      <div class="chips-wrap" style="margin-top: 8px">
        <span class="muted">下发单位：</span>
        <el-check-tag v-for="o in scopeOrgs" :key="o" :checked="pickedOrgs.includes(o)" @change="toggleOrg(o)">{{ orgName(o) }}</el-check-tag>
        <el-button v-if="pickedOrgs.length" link type="primary" @click="pickedOrgs = []">清空筛选</el-button>
      </div>
      <p v-if="task" class="flow-hint">
        任务周期 {{ task.startTime.slice(0, 10) }} ~ {{ task.endTime.slice(0, 10) }} ·
        状态 {{ ['待开始', '进行中', '已截止', '已归档'][task.status] }} ·
        审核方式 {{ ['免审核', '单级审核', '多级审核'][task.auditType] }} ·
        模板版本 {{ task.templateVersion }}（下发时冻结，历史记录按此版本汇总，7.3）·
        一单位{{ task.singleRecordPerOrg ? '一条' : '多条' }}记录（7.6）
      </p>
    </div>

    <!-- 3.8 其四：填报进度看板，六个口径 -->
    <div v-if="progress" class="card">
      <h3>填报进度看板</h3>
      <div class="stat-grid">
        <div class="stat"><b>{{ progress.expected }}</b><span>应填报单位</span></div>
        <div class="stat"><b>{{ progress.submitted }}</b><span>已提交待审核</span></div>
        <div class="stat"><b>{{ progress.passed }}</b><span>审核通过</span></div>
        <div class="stat"><b>{{ progress.rejected }}</b><span>已驳回</span></div>
        <div class="stat"><b>{{ progress.draft }}</b><span>草稿未提交</span></div>
        <div class="stat"><b>{{ progress.missing }}</b><span>未填报</span></div>
      </div>
      <el-table :data="progress.rows" size="small" border row-key="orgId" style="margin-top: 10px">
        <el-table-column label="单位" min-width="150" prop="orgName" show-overflow-tooltip />
        <el-table-column label="状态" width="92">
          <template #default="{ row }"><el-tag size="small" :type="tagTypeOf(row.status)">{{ row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column label="记录数" width="80" align="right" prop="recordCount" />
        <el-table-column label="计划合计" width="100" align="right">
          <template #default="{ row }">{{ row.planTotal || '—' }}</template>
        </el-table-column>
        <el-table-column label="完成合计" width="100" align="right">
          <template #default="{ row }">{{ row.finishTotal || '—' }}</template>
        </el-table-column>
        <el-table-column label="完成率" width="180">
          <template #default="{ row }"><el-progress :percentage="row.rate" :stroke-width="10" :text-inside="true" /></template>
        </el-table-column>
        <el-table-column label="最近更新" width="160">
          <template #default="{ row }"><span class="mono muted">{{ row.lastUpdate }}</span></template>
        </el-table-column>
        <el-table-column label="填报人" width="110">
          <template #default="{ row }"><span class="muted">{{ row.reporter }}</span></template>
        </el-table-column>
      </el-table>
      <p class="flow-hint">进度口径只统计「是否交、是否审完」，不随字段权限变化（3.8 其三）。</p>
    </div>

    <!-- 7.4 宽表 -->
    <div class="card">
      <div class="row-gap">
        <h3 style="margin: 0">汇总宽表</h3>
        <span class="spacer" />
        <el-tooltip :disabled="canExport" content="仅业务部门管理员可发起导出（10.2）" placement="top">
          <span>
            <el-button :disabled="!canExport" @click="exportNow('detail')">立即导出明细</el-button>
          </span>
        </el-tooltip>
        <el-button :disabled="!canExport" @click="exportNow('progress')">立即导出进度</el-button>
        <el-button type="primary" :disabled="!canExport" @click="exportAsync">异步导出作业</el-button>
      </div>
      <el-alert
        v-if="needAsync"
        type="info"
        :closable="false"
        show-icon
        style="margin-top: 6px"
        :title="`当前筛选结果 ${totalRows} 行，已超过同步导出阈值 ${ASYNC_THRESHOLD} 行，请改用异步导出作业（3.8 其五）`"
      />
      <p class="muted" style="margin-top: 4px">
        列按「{{ me?.realName }}」的字段权限合并生成，hidden 字段不进入表头也不参与导出；〔适用〕与〔口径〕来自子单位差异规则（3.3）。
      </p>
      <el-table :data="page?.list ?? []" size="small" border class="wide-table" max-height="520" empty-text="没有符合筛选条件的数据">
        <el-table-column label="单位" width="150" prop="orgName" show-overflow-tooltip />
        <el-table-column label="记录序号" width="90" align="right">
          <template #default="{ row }">{{ row.recordSeq || '—' }}</template>
        </el-table-column>
        <el-table-column label="行号" width="70" align="right">
          <template #default="{ row }">{{ row.rowNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="92">
          <template #default="{ row }"><el-tag size="small" :type="tagTypeOf(row.status)">{{ row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column v-for="c in columns" :key="c.key" min-width="140" show-overflow-tooltip>
          <template #header>
            <el-tooltip :content="colNote(c) || '全部下发单位口径一致'" placement="top" :show-after="300">
              <span class="col-hd">
                {{ c.label }}
                <el-tag v-if="c.aliases.length > 1" size="small" type="warning" effect="plain">多口径</el-tag>
                <el-tag v-if="!c.allOrgs" size="small" type="info" effect="plain">差异字段</el-tag>
                <el-tag v-if="c.deprecated" size="small" type="danger" effect="plain">已停用</el-tag>
                <span v-if="c.scope === 'detail'" class="muted">（明细）</span>
              </span>
            </el-tooltip>
          </template>
          <template #default="{ row }">
            <span :class="{ muted: notApplied(row as WideRow, c), dep: c.deprecated }">
              {{ notApplied(row as WideRow, c) ? '—' : cellOf(row as WideRow, c.key) }}
            </span>
          </template>
        </el-table-column>
      </el-table>
      <div class="pager-row">
        <el-pagination
          v-model:current-page="pageNum"
          size="small"
          background
          layout="total, prev, pager, next"
          :page-size="PAGE_SIZE"
          :total="totalRows"
        />
      </div>
    </div>

    <div class="split">
      <div class="main">
        <div class="card">
          <h3>导出作业（3.8 其五）</h3>
          <div class="row-gap">
            <el-button @click="refreshJobs">刷新</el-button>
            <span class="muted">下载凭证有效期 {{ EXPORT_LINK_MINUTES }} 分钟，过期后需重新发起（错误码 1010）。</span>
          </div>
          <el-table :data="jobs" size="small" border row-key="jobId" empty-text="尚无导出作业">
            <el-table-column label="作业号" width="140">
              <template #default="{ row }"><span class="mono">{{ row.jobId }}</span></template>
            </el-table-column>
            <el-table-column label="筛选条件快照" min-width="240" prop="filters" show-overflow-tooltip />
            <el-table-column label="状态" width="92">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'done' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'">
                  {{ row.status === 'done' ? '已完成' : row.status === 'failed' ? '失败' : '生成中' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="行数" width="80" align="right">
              <template #default="{ row }">{{ row.rows ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="发起时间" width="160">
              <template #default="{ row }"><span class="mono">{{ row.createTime }}</span></template>
            </el-table-column>
            <el-table-column label="操作" min-width="220">
              <template #default="{ row }">
                <el-button v-if="row.download" type="primary" link @click="download(row.download.token)">下载 {{ row.fileName }}</el-button>
                <span v-else class="muted">{{ row.status === 'running' ? '分页读取中…' : '—' }}</span>
                <span v-if="row.download" class="muted">{{ expireLeft(row as ExportJob) }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h3>列口径说明</h3>
          <el-table :data="columns" size="small" border row-key="key" max-height="420" empty-text="暂无列">
            <el-table-column label="列" width="150">
              <template #default="{ row }">
                <div>{{ row.label }}</div>
                <div class="mono muted">{{ row.key }}</div>
              </template>
            </el-table-column>
            <el-table-column label="口径">
              <template #default="{ row }"><span class="muted">{{ colNote(row as (typeof columns)[number]) || '全部下发单位口径一致' }}</span></template>
            </el-table-column>
          </el-table>
        </div>
        <div class="card">
          <h3>规则提示</h3>
          <ul class="rule-list">
            <li>导出文件头部含任务、模板版本、导出人与水印（8.2 其三）</li>
            <li>单元格以 = + - @ 开头时前置单引号，防 CSV 公式注入</li>
            <li>附件列输出「个数：文件名清单」，不输出存储地址</li>
            <li>已停用字段列保留并标注，历史记录不丢值（7.3）</li>
            <li>差异新增列对不适用单位输出空值而非 0（3.3）</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 多选单位标签行 */
.chips-wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* 宽表列头：标题与标注同一行展示 */
.col-hd {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
</style>
