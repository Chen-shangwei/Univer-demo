<script setup lang="ts">
/**
 * 3.7 审核详情页：以查看人身份 + 记录自身版本重新合并 Schema（7.3），全程只读。
 * 通过 / 驳回写入不可修改的审核留痕；多级审核自动流转至下一节点。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Download } from '@element-plus/icons-vue'
import DetailTable from '../components/DetailTable.vue'
import DynamicForm from '../components/DynamicForm.vue'
import SchemaTrace from '../components/SchemaTrace.vue'
import { remote } from '../system/http'
import { db, deptName, orgById, userName } from '../system/db'
import { canAuditNode } from '../system/service'
import { detailFields, headerFields } from '../system/schema-service'
import { current } from '../system/session'
import { must, runAsync, toast } from '../utils/notify'
import { tagTypeOf, type TagType } from '../utils/display'

const TRAIL_TEXT: Record<string, string> = { pass: '通过', reject: '驳回', revoke: '撤回' }
const TRAIL_TYPE: Record<string, TagType> = { pass: 'success', reject: 'danger', revoke: 'warning' }

const route = useRoute()
const router = useRouter()
const recordId = String(route.query.recordId ?? '')
const me = current()

/* M3 扩面：审核记录读取走后台 /api/record/detail（按记录版本重新合并 Schema） */
const detail = ref<Record<string, any> | null>(null)
const loading = ref(false)

async function load() {
  if (!recordId) return
  loading.value = true
  try {
    const r = await remote.recordDetail(recordId)
    if (r.code === 200) detail.value = r.data
    else toast('err', r.msg)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const heads = computed(() => (detail.value ? headerFields(detail.value.schema) : []))
const details = computed(() => (detail.value ? detailFields(detail.value.schema) : []))
const uploadKeys = computed(() => heads.value.filter((f) => f.fieldType === 'upload'))

/** 5.3.3：仅当前节点的审核人可办理，且记录必须处于待审核状态 */
const actionable = computed(() => {
  const d = detail.value
  if (!d || !me) return false
  return d.record.recordStatus === 'submitted' && canAuditNode(me, d.task, d.record.currentNode)
})

const nodeInfo = computed(() => {
  const d = detail.value
  if (!d) return '—'
  const node = d.task.auditNodes.find((n: any) => n.seq === d.record.currentNode)
  if (!node) return d.record.recordStatus === 'pass' ? '全部节点已通过' : '不在审中'
  return `第 ${node.seq} 节点「${node.nodeName}」${node.userId ? '（指定审核人：' + userName(node.userId) + '）' : '（审核角色：' + (db.sys_role.find((r) => r.roleCode === node.roleCode)?.roleName ?? '未配置') + '）'}`
})

/* ------------------------------------------------ 审核操作 */
const opinion = ref('')
const conclusion = ref<'pass' | 'reject'>('pass')

function submit() {
  void runAsync(async () => {
    const res = must(await remote.auditOperate(recordId, conclusion.value, opinion.value))
    if (!res.ok) throw new Error(res.message)
    toast('ok', res.message)
    opinion.value = ''
    // 审核结论已落入后台 db，回读刷新状态与留痕
    await load()
  })
}

const ATTACH_SIZE = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`)

function download(attId: string) {
  void runAsync(async () => {
    const d = must(await remote.attachmentDownload(attId))
    const a = document.createElement('a')
    a.href = d.url
    a.download = d.fileName
    a.click()
    toast('info', `已下载「${d.fileName}」（3.9 不暴露存储地址）`)
  })
}
</script>

<template>
  <div v-if="detail" v-loading="loading">
    <h2 class="page-title">
      {{ detail.task.taskName }}
      <el-tag size="small" :type="tagTypeOf(detail.record.recordStatus)">{{ detail.statusText }}</el-tag>
    </h2>
    <p class="page-sub">
      {{ orgById(detail.record.orgId)?.orgName }}{{ detail.record.deptId ? ' / ' + deptName(detail.record.deptId) : '' }} · 填报人 {{ detail.ownerName }} ·
      提交于 {{ detail.record.submitTime ?? '—' }} · 模板版本 {{ detail.record.templateVersion }}（历史按此版本呈现，7.3）
    </p>

    <div class="card row-gap" style="margin-top: 12px">
      <span class="muted">审核链路：{{ nodeInfo }}</span>
      <span class="spacer" />
      <el-tag v-if="!actionable" size="small" type="info">您不是本节点审核人或记录不在待审核状态</el-tag>
      <el-button @click="router.push('/audit/list')">返回待办</el-button>
    </div>

    <div class="split">
      <div class="main">
        <div class="card">
          <h3>单头区（只读）</h3>
          <DynamicForm :fields="heads" :model-value="{ ...detail.record.data }" locked />
        </div>

        <div v-if="details.length" class="card">
          <h3>明细区（只读，共 {{ detail.record.rows.length }} 行）</h3>
          <DetailTable :fields="details" :rows="detail.record.rows" />
        </div>

        <div v-if="uploadKeys.length" class="card">
          <h3>附件（提交后只读，可下载）</h3>
          <el-table :data="detail.attachments" size="small" border row-key="attId" empty-text="本次填报未上传附件">
            <el-table-column label="字段" width="160">
              <template #default="{ row }"><span class="mono">{{ row.fieldKey }}</span></template>
            </el-table-column>
            <el-table-column label="文件名" min-width="220" prop="fileName" show-overflow-tooltip />
            <el-table-column label="大小" width="100" align="right">
              <template #default="{ row }">{{ ATTACH_SIZE(row.fileSize) }}</template>
            </el-table-column>
            <el-table-column label="上传时间" width="160">
              <template #default="{ row }"><span class="muted">{{ row.uploadTime }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="90" align="right">
              <template #default="{ row }">
                <el-button link type="primary" :icon="Download" @click="download(row.attId)">下载</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div v-if="actionable" class="card">
          <h3>审核意见</h3>
          <el-radio-group v-model="conclusion" style="margin-bottom: 8px">
            <el-radio value="pass">通过</el-radio>
            <el-radio value="reject">驳回</el-radio>
          </el-radio-group>
          <el-input
            v-model="opinion"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            :placeholder="conclusion === 'reject' ? '驳回必填，且不少于 5 个字（5.3.3）' : '通过可不填意见'"
          />
          <div class="row-gap" style="margin-top: 8px">
            <el-button type="primary" @click="submit">提交结论</el-button>
            <span class="muted">意见长度上限 500 字，写入留痕后不可修改；多级审核通过即流转下一节点。</span>
          </div>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h3>审核留痕（不可修改）</h3>
          <el-empty v-if="!detail.record.auditTrails.length" description="本记录尚无留痕" :image-size="60" />
          <el-timeline v-else>
            <el-timeline-item
              v-for="t in detail.record.auditTrails"
              :key="t.trailId"
              :timestamp="t.time"
              :type="TRAIL_TYPE[t.conclusion] ?? 'info'"
              placement="top"
            >
              <div class="t-hd">{{ t.nodeName }} · {{ TRAIL_TEXT[t.conclusion] ?? t.conclusion }}</div>
              <div>{{ t.opinion || '（未填写意见）' }}</div>
              <div class="t-meta">{{ t.userName }} · 耗时 {{ t.costSeconds }} 秒</div>
            </el-timeline-item>
          </el-timeline>
        </div>

        <div class="card">
          <h3>记录信息</h3>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="记录标识"><span class="mono">{{ detail.record.recordId }}</span></el-descriptions-item>
            <el-descriptions-item label="序号">{{ detail.record.seq }}</el-descriptions-item>
            <el-descriptions-item label="提交次数">{{ detail.record.submitCount }}</el-descriptions-item>
            <el-descriptions-item label="最近更新"><span class="mono">{{ detail.record.updateTime }}</span></el-descriptions-item>
            <el-descriptions-item label="屏蔽字段">
              <span class="mono muted">{{ detail.schema.hiddenKeys.join('、') || '无' }}</span>
            </el-descriptions-item>
          </el-descriptions>
        </div>

        <SchemaTrace :schema="detail.schema" />
      </div>
    </div>
  </div>

  <div v-else class="card">
    <h3>记录不存在</h3>
    <p class="muted">记录标识：{{ recordId || '缺失' }}，请从审核工作台进入。</p>
    <el-button @click="router.push('/audit/list')">返回待办</el-button>
  </div>
</template>
