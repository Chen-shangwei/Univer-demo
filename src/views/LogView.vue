<script setup lang="ts">
/**
 * 3.10 操作日志检索。
 * 日志只追加不修改，界面不提供任何删除入口（3.10 其二）；
 * 八类关键动作 + 附件与撤回共 11 个操作类型可按需组合检索，失败动作（result=0）标红呈现。
 */
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { api } from '../system/api'
import { db, orgById, userName } from '../system/db'
import { OPER_TYPE } from '../system/types'
import type { ID } from '../system/types'
import { must, run, toast } from '../utils/notify'

const OPER_TYPES = Object.values(OPER_TYPE) as string[]

const operType = ref('')
const userId = ref('')
const bizId = ref('')
const from = ref('')
const to = ref('')
const keyword = ref('')
const pageNum = ref(1)
const pageSize = ref(20)

/** 日期控件只到天，结束日补到当天最后一刻，避免漏掉当日日志 */
const timeFrom = computed(() => (from.value ? `${from.value} 00:00:00` : undefined))
const timeTo = computed(() => (to.value ? `${to.value} 23:59:59` : undefined))

const page = computed(() =>
  must(
    api.log.page({
      pageNum: pageNum.value,
      pageSize: pageSize.value,
      operType: operType.value || undefined,
      userId: (userId.value || undefined) as ID | undefined,
      bizId: (bizId.value.trim() || undefined) as ID | undefined,
      from: timeFrom.value,
      to: timeTo.value,
      keyword: keyword.value.trim() || undefined,
    }),
  ),
)

function search() {
  pageNum.value = 1
  run(() => {
    const total = page.value.total
    toast('info', `检索到 ${total} 条日志`)
  })
}

function reset() {
  operType.value = ''
  userId.value = ''
  bizId.value = ''
  from.value = ''
  to.value = ''
  keyword.value = ''
  pageNum.value = 1
}

/** 按任务 / 记录 / 模板定位日志：把列表中的业务标识回填为检索条件 */
function locate(biz: string) {
  bizId.value = biz
  search()
}

const users = computed(() => db.sys_user.filter((u) => u.delFlag === 0))
const orgName = (id: ID) => orgById(id)?.orgName ?? id
const BIZ_LABEL: Record<string, string> = { task: '任务', record: '填报记录', template: '模板', org: '组织', user: '用户' }

/** 3.10 其一：埋点清单，逐项对照本系统是否已落库 */
const POINTS = computed(() =>
  OPER_TYPES.map((t) => ({ type: t, count: db.form_oper_log.filter((l) => l.operType === t).length })),
)

/** 失败动作整行标红（result=0） */
function rowClass({ row }: { row: { result: number } }) {
  return row.result === 0 ? 'row-bad' : ''
}
</script>

<template>
  <div>
    <h2 class="page-title">操作日志</h2>
    <p class="page-sub">
      3.10：登录、模板变更、差异与权限配置变更、任务下发、草稿保存、填报提交、审核操作、数据导出等关键动作全部留痕，
      记录操作人、单位、时间、业务标识与结果，仅可追加与检索。
    </p>

    <div class="card">
      <div class="row-gap">
        <el-select v-model="operType" clearable placeholder="全部操作类型" style="width: 170px">
          <el-option label="全部操作类型" value="" />
          <el-option v-for="t in OPER_TYPES" :key="t" :label="t" :value="t" />
        </el-select>
        <el-select v-model="userId" filterable clearable placeholder="全部操作人" style="width: 190px">
          <el-option label="全部操作人" value="" />
          <el-option v-for="u in users" :key="u.userId" :label="`${u.realName}（${u.username}）`" :value="u.userId" />
        </el-select>
        <el-input v-model="bizId" placeholder="业务标识，如 TASK-1" style="width: 170px" />
        <el-date-picker v-model="from" type="date" value-format="YYYY-MM-DD" placeholder="起始日期" style="width: 140px" />
        <span class="muted">~</span>
        <el-date-picker v-model="to" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width: 140px" />
        <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="按日志内容检索" style="width: 200px" />
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>
    </div>

    <div class="card">
      <div class="row-gap">
        <h3 style="margin: 0">日志明细</h3>
        <span class="spacer" />
        <span class="muted">共 {{ page.total }} 条 / {{ page.pages }} 页</span>
      </div>
      <el-table :data="page.list" size="small" border row-key="logId" :row-class-name="rowClass" max-height="560" empty-text="没有符合条件的日志">
        <el-table-column label="时间" width="160">
          <template #default="{ row }"><span class="mono">{{ row.operTime }}</span></template>
        </el-table-column>
        <el-table-column label="操作类型" width="150">
          <template #default="{ row }"><el-tag size="small" type="info" effect="plain">{{ row.operType }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作人" width="100">
          <template #default="{ row }">{{ userName(row.userId as ID) }}</template>
        </el-table-column>
        <el-table-column label="单位" width="140" show-overflow-tooltip>
          <template #default="{ row }"><span class="muted">{{ orgName(row.orgId as ID) }}</span></template>
        </el-table-column>
        <el-table-column label="日志内容" min-width="300" prop="content" show-overflow-tooltip />
        <el-table-column label="业务标识" min-width="180">
          <template #default="{ row }">
            <el-button link type="primary" class="mono" @click="locate(row.bizId)">{{ row.bizId }}</el-button>
            <span class="muted">（{{ BIZ_LABEL[row.bizType] ?? row.bizType }}）</span>
          </template>
        </el-table-column>
        <el-table-column label="来源 IP" width="130">
          <template #default="{ row }"><span class="mono muted">{{ row.ip }}</span></template>
        </el-table-column>
        <el-table-column label="结果" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.result === 1 ? 'success' : 'danger'">{{ row.result === 1 ? '成功' : '失败' }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <div class="pager-row">
        <el-pagination
          v-model:current-page="pageNum"
          v-model:page-size="pageSize"
          size="small"
          background
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          :total="page.total"
          @size-change="pageNum = 1"
        />
      </div>
      <p class="flow-hint">
        失败日志同样保留（如 8.2 越权改写被拦截时 result=0）；日志表无删除接口，界面不提供删除按钮。
      </p>
    </div>

    <div class="split">
      <div class="main">
        <div class="card">
          <h3>埋点覆盖情况（3.10 其一）</h3>
          <el-table :data="POINTS" size="small" border row-key="type">
            <el-table-column label="操作类型" width="200" prop="type" />
            <el-table-column label="已记录条数" width="110" align="right">
              <template #default="{ row }"><span :class="{ muted: row.count === 0 }">{{ row.count }}</span></template>
            </el-table-column>
            <el-table-column label="说明">
              <template #default="{ row }">
                <span class="muted">{{ row.count ? '已产生日志' : '尚未触发，可在对应功能页操作后回到本页查询' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
      <div class="side">
        <div class="card">
          <h3>留痕字段（表22）</h3>
          <ul class="rule-list">
            <li>oper_time / oper_type / user_id / org_id</li>
            <li>biz_id + biz_type：可反查任务、记录、模板</li>
            <li>content：人可读的动作描述，含关键字段与结论</li>
            <li>ip：原型内固定为浏览器本机会话地址</li>
            <li>result：1 成功、0 失败（权限拦截、校验不通过）</li>
          </ul>
        </div>
        <div class="card">
          <h3>保留与归档</h3>
          <p class="muted" style="line-height: 1.8; font-size: 12px">
            日志在线保留 12 个月，到期转归档表可查（3.10 其二）。原型不做过期清理，
            全部数据可通过上方时间段筛选检索；导出侧同样记录「数据导出」类型。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
