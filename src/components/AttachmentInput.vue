<script setup lang="ts">
/**
 * 3.9 附件管理：上传前校验类型/大小/数量，提交后随表单转只读，
 * 下载走服务端签发的短时凭证，不暴露存储地址。
 * 选择文件与上传动作由 el-upload 承接（auto-upload 关掉，仍走本地 mock 接口）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Delete, Document, Download, UploadFilled } from '@element-plus/icons-vue'
import type { UploadFile, UploadInstance } from 'element-plus'
import { remote } from '../system/http'
import type { FormAttachment, ID, SchemaField } from '../system/types'
import { must, runAsync, toast } from '../utils/notify'

const props = withDefaults(
  defineProps<{
    field: SchemaField
    recordId: ID
    /** 可编辑（草稿/驳回）时才允许上传与删除 */
    editable?: boolean
  }>(),
  { editable: false },
)

const list = ref<FormAttachment[]>([])
const busy = ref(false)
const uploadRef = ref<UploadInstance>()

const accept = computed(() => props.field.config.accept ?? [])
const acceptStr = computed(() => accept.value.join(','))
const maxSize = computed(() => props.field.config.maxSize ?? 20)
const maxCount = computed(() => props.field.config.maxCount ?? 5)
const full = computed(() => list.value.length >= maxCount.value)
const hint = computed(
  () => `允许 ${accept.value.length ? accept.value.join('/') : '常见办公与图片格式'}，单文件 ≤ ${maxSize.value}MB，最多 ${maxCount.value} 个`,
)

async function reload() {
  const r = await remote.attachmentList(props.recordId, props.field.fieldKey)
  if (r.code === 200) list.value = r.data ?? []
  else toast('err', r.msg)
}
watch(() => props.recordId, () => void reload(), { immediate: true })

/** 小于该阈值才把内容内联到本地库，模拟对象存储的小文件直传 */
const INLINE_LIMIT = 1.5 * 1024 * 1024
/** 6.5（2）：分片大小取 3 的倍数，使各分片的 base64 无填充位，可直接拼接 */
const CHUNK_SIZE = 768 * 1024
/** 6.5（2）：单个文件分片并发数不超过 3，避免内网带宽被占满 */
const MAX_CONCURRENCY = 3
const progress = ref('')

function readChunk(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
    fr.onerror = () => reject(new Error('分片读取失败'))
    fr.readAsDataURL(blob)
  })
}

async function readDataUrl(file: File): Promise<string | undefined> {
  if (file.size > INLINE_LIMIT) return undefined
  const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
  const parts: string[] = new Array(total).fill('')
  let cursor = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const idx = cursor
      cursor += 1
      if (idx >= total) return
      parts[idx] = await readChunk(file.slice(idx * CHUNK_SIZE, Math.min((idx + 1) * CHUNK_SIZE, file.size)))
      done += 1
      progress.value = `${file.name}：${done}/${total} 分片完成（并发≤ ${MAX_CONCURRENCY}）`
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, total) }, () => worker()))
  return `data:${file.type || 'application/octet-stream'};base64,${parts.join('')}`
}

/** 一次选多个文件时 el-upload 会连续回调，串成队列以保持与原 for 循环相同的串行口径 */
let queue: Promise<void> = Promise.resolve()

function onPick(file: UploadFile) {
  const raw = file.raw
  if (raw) enqueue(raw)
}

function enqueue(file: File) {
  queue = queue.then(async () => {
    if (full.value) {
      toast('err', `最多上传 ${maxCount.value} 个附件，「${file.name}」已忽略`)
      uploadRef.value?.clearFiles()
      return
    }
    busy.value = true
    progress.value = ''
    try {
      const blob = await readDataUrl(file)
      const r = await remote.attachmentUpload(
        props.recordId,
        props.field.fieldKey,
        { name: file.name, size: file.size, type: file.type },
        { accept: accept.value, maxSize: maxSize.value, maxCount: maxCount.value },
        blob,
      )
      if (r.code !== 200) toast('err', r.msg)
      else if (!blob) toast('info', `「${file.name}」较大，原型仅登记文件信息（真实环境由对象存储承接）`)
      await reload()
    } catch (err) {
      toast('err', err instanceof Error ? err.message : '上传失败')
    } finally {
      busy.value = false
      progress.value = ''
      uploadRef.value?.clearFiles()
    }
  })
}

function del(a: FormAttachment) {
  void runAsync(async () => {
    must(await remote.attachmentRemove(a.attId, props.editable))
    toast('ok', `已删除「${a.fileName}」`)
    await reload()
  })
}

/* 短时下载凭证 */
const link = ref<{ url: string; fileName: string; left: number } | null>(null)
let timer = 0

function download(a: FormAttachment) {
  void runAsync(async () => {
    const d = must(await remote.attachmentDownload(a.attId))
    if (timer) window.clearInterval(timer)
    link.value = { url: d.url, fileName: a.fileName, left: Math.round((d.expireAt - Date.now()) / 1000) }
    const el = document.createElement('a')
    el.href = d.url
    el.download = a.fileName
    el.click()
    timer = window.setInterval(() => {
      if (!link.value) return
      link.value.left -= 1
      if (link.value.left <= 0) {
        window.clearInterval(timer)
        link.value = null
      }
    }, 1000)
  })
}

onBeforeUnmount(() => window.clearInterval(timer))

const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`)
</script>

<template>
  <div class="fld">
    <span class="cap">
      {{ field.fieldLabel }}
      <i v-if="field.isRequired === 1 && editable" class="req">*</i>
      <el-tag size="small" type="info" effect="plain">{{ list.length }}/{{ maxCount }}</el-tag>
      <el-tag v-if="!editable" size="small" type="info" effect="plain">只读</el-tag>
      <el-tag v-if="full && editable" size="small" type="warning" effect="plain">已达数量上限</el-tag>
    </span>

    <el-text size="small" type="info">{{ hint }}</el-text>

    <ul v-if="list.length" class="att-list">
      <li v-for="a in list" :key="a.attId">
        <el-icon><Document /></el-icon>
        <span class="mono">{{ a.fileName }}</span>
        <span class="muted">{{ size(a.fileSize) }} · {{ a.uploadTime }}</span>
        <span class="spacer" />
        <el-button link type="primary" :icon="Download" @click="download(a)">下载</el-button>
        <el-button v-if="editable" link type="danger" :icon="Delete" @click="del(a)">删除</el-button>
      </li>
    </ul>
    <el-text v-else size="small" type="info">暂无附件</el-text>

    <el-alert v-if="link" type="success" :closable="false" show-icon class="att-note">
      下载凭证有效，剩余 {{ link.left }} 秒（{{ link.fileName }}）
    </el-alert>

    <el-alert v-if="busy && progress" type="info" :closable="false" show-icon class="att-note">
      {{ progress }}
    </el-alert>

    <el-upload
      v-if="editable"
      ref="uploadRef"
      class="att-upload"
      :auto-upload="false"
      :show-file-list="false"
      :accept="acceptStr"
      multiple
      :disabled="busy || full"
      :on-change="onPick"
    >
      <el-button type="primary" plain :icon="UploadFilled" :loading="busy" :disabled="full">
        {{ busy ? '上传中…' : '选择文件' }}
      </el-button>
    </el-upload>
  </div>
</template>

<style scoped>
.att-list .el-icon {
  color: var(--el-text-color-secondary);
}

.att-note {
  margin-top: 6px;
  padding: 6px 10px;
}

.att-upload {
  margin-top: 6px;
  display: inline-block;
}

.att-upload :deep(.el-upload) {
  border: none;
}
</style>
