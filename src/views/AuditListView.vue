<script setup lang="ts">
/**
 * 3.7 填报审核 —— 待办列表。
 * 待办口径：记录处于 submitted，且当前待审节点的审核人 / 审核角色命中本人（5.3.3）。
 * 多级审核时同一记录只出现在当前节点的审核人待办中。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import { api } from '../system/api'
import { db, hasRole, orgById } from '../system/db'
import { canAuditNode } from '../system/service'
import { current } from '../system/session'
import { ROLE } from '../system/types'
import type { TaskView } from '../system/flow'
import type { FormRecord, ID } from '../system/types'
import { must, promptAction, runAsync, toast } from '../utils/notify'
import { tagTypeOf } from '../utils/display'

const router = useRouter()
const me = current()

const todos = computed(() => (me ? must(api.audit.todo(me.userId)) : []))

/** 待办对应的记录（TaskView 不带 recordId，按任务 + 单位 + 在审节点定位） */
function recordOfView(taskId: ID, orgId: ID, currentNode: number): FormRecord | undefined {
  return db.form_record.find((r) => r.taskId === taskId && r.orgId === orgId && r.recordStatus === 'submitted' && r.currentNode === currentNode)
}

const todoRecords = computed(() => {
  const out: { view: TaskView; record: FormRecord }[] = []
  todos.value.forEach((v) => {
    const record = recordOfView(v.taskId, v.orgId, v.currentNode)
    if (record) out.push({ view: v, record })
  })
  return out
})

/* ------------------------------------------------ 全部在审 / 已办记录 */
const onlyMine = ref(true)
const keyword = ref('')
const allRecords = computed(() => {
  const list = db.form_record.filter((r) => r.delFlag === 0 && r.recordStatus !== 'draft')
  return list
    .filter((r) => {
      if (!onlyMine.value) return true
      const task = db.form_task.find((t) => t.taskId === r.taskId)
      return !!me && !!task && r.recordStatus === 'submitted' && canAuditNode(me, task, r.currentNode)
    })
    .filter((r) => !keyword.value.trim() || (db.form_task.find((t) => t.taskId === r.taskId)?.taskName ?? '').includes(keyword.value.trim()))
    .sort((a, b) => (b.submitTime ?? '').localeCompare(a.submitTime ?? ''))
})

const STATUS_TEXT: Record<string, string> = { submitted: '待审核', pass: '已归档', reject: '已驳回' }

function nodeName(r: FormRecord): string {
  const t = db.form_task.find((x) => x.taskId === r.taskId)
  if (!t) return '—'
  if (r.recordStatus !== 'submitted') return t.auditType === 0 ? '免审核' : '已结束'
  return t.auditNodes.find((n) => n.seq === r.currentNode)?.nodeName ?? `节点 ${r.currentNode}`
}

/** 3.7 如需变更结论，由业务部门管理员发起撤回并记录原因 */
const canRevoke = computed(() => hasRole(me, ROLE.BIZ_ADMIN))

function revoke(r: FormRecord) {
  void runAsync(async () => {
    const res = await promptAction('请填写撤回原因（必填，将写入审核留痕）', '管理员撤回')
    if (!res) {
      toast('err', '撤回必须记录原因')
      return
    }
    const out = must(api.audit.revoke(r.recordId, res.value.trim()))
    if (!out.ok) throw new Error(out.message)
    toast('ok', out.message)
  })
}

function open(recordId: ID) {
  router.push({ path: '/audit/detail', query: { recordId } })
}

const orgName = (id: ID) => orgById(id)?.orgName ?? id
const taskName = (id: ID) => db.form_task.find((t) => t.taskId === id)?.taskName ?? id
</script>

<template>
  <div>
    <h2 class="page-title">审核工作台</h2>
    <p class="page-sub">
      3.7：审核视角的表单全程只读。通过进入下一节点或归档，驳回则退回填报人修改后重新提交，审核意见与结论按节点留痕、不可修改。
    </p>

    <div class="split">
      <div class="main">
        <div class="card">
          <h3>我的待办（{{ todoRecords.length }}）</h3>
          <el-table :data="todoRecords" size="small" border :row-key="(r) => r.record.recordId" empty-text="没有待办，全部已处理">
            <el-table-column label="任务" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">{{ row.view.taskName }}</template>
            </el-table-column>
            <el-table-column label="填报单位" min-width="140">
              <template #default="{ row }">{{ row.view.orgName }}</template>
            </el-table-column>
            <el-table-column label="当前节点" min-width="160">
              <template #default="{ row }"><el-tag size="small" type="primary">{{ row.view.nodeName }}</el-tag></template>
            </el-table-column>
            <el-table-column label="提交时间" width="160">
              <template #default="{ row }"><span class="mono">{{ row.record.submitTime }}</span></template>
            </el-table-column>
            <el-table-column label="距截止" width="90" align="right">
              <template #default="{ row }">{{ row.view.restDays > 0 ? row.view.restDays + ' 天' : '已截止' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" align="right">
              <template #default="{ row }">
                <el-button size="small" type="primary" @click="open(row.record.recordId)">审核</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      
        <div class="card">
          <div class="row-gap">
            <h3 style="margin: 0">全部记录</h3>
            <span class="spacer" />
            <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="按任务名称检索" style="width: 220px" />
            <el-checkbox v-model="onlyMine">仅看我负责节点的在审记录</el-checkbox>
          </div>
          <el-table :data="allRecords" size="small" border row-key="recordId" empty-text="没有符合条件的记录">
            <el-table-column label="任务" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">{{ taskName(row.taskId) }}</template>
            </el-table-column>
            <el-table-column label="单位" min-width="130">
              <template #default="{ row }">{{ orgName(row.orgId) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="92">
              <template #default="{ row }">
                <el-tag size="small" :type="tagTypeOf(row.recordStatus)">{{ STATUS_TEXT[row.recordStatus] ?? row.recordStatus }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="节点" min-width="150">
              <template #default="{ row }"><span class="muted">{{ nodeName(row as FormRecord) }}</span></template>
            </el-table-column>
            <el-table-column label="提交次数" width="88" align="right" prop="submitCount" />
            <el-table-column label="提交时间" width="160">
              <template #default="{ row }"><span class="mono">{{ row.submitTime ?? '—' }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="150" align="right">
              <template #default="{ row }">
                <el-button size="small" @click="open(row.recordId)">查看</el-button>
                <el-button v-if="canRevoke && row.recordStatus !== 'draft'" size="small" type="danger" plain @click="revoke(row as FormRecord)">撤回</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
      
      <div class="side">
        <div class="card">
          <h3>审核口径</h3>
          <ul class="rule-list">
            <li>免审核任务提交即生效并直接进入汇总（3.5）</li>
            <li>多级审核按节点顺序流转，只有当前节点审核人可见待办</li>
            <li>驳回必须填写不少于 5 个字的意见（5.3.3）</li>
            <li>留痕一经写入不可修改，变更结论走管理员撤回</li>
            <li>审核人对字段权限为只读，界面不提供任何输入控件（3.4 场景一）</li>
          </ul>
        </div>
        <div class="card">
          <h3>近期审核动作（3.10）</h3>
          <el-timeline>
            <el-timeline-item
              v-for="l in db.form_oper_log.filter((x) => x.operType === '审核操作' || x.operType === '管理员撤回').slice(0, 8)"
              :key="l.logId"
              :timestamp="l.operTime"
              placement="top"
            >
              <div class="t-hd">{{ l.operType }}</div>
              <div class="muted">{{ l.content }}</div>
              <div class="t-meta">{{ orgName(l.orgId) }}</div>
            </el-timeline-item>
          </el-timeline>
        </div>
      </div>
    </div>
  </div>
</template>
