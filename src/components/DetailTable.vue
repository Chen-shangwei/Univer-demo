<script setup lang="ts">
/**
 * 明细区只读呈现（审核、日志回溯、记录详情等非填报视角）。
 * hidden 列不出现在 fields 中，因此不会渲染（6.3）；只读列正常展示值。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { FieldValue, SchemaField } from '../system/types'

const props = defineProps<{
  fields: SchemaField[]
  rows: Record<string, FieldValue>[]
}>()

function label(f: SchemaField, v: FieldValue): string {
  if (v === null || v === undefined || String(v).trim() === '') return '—'
  const s = String(v)
  if (f.fieldType === 'select' || f.fieldType === 'radio') return optionLabel(f, s)
  if (f.fieldType === 'checkbox') return s.split(',').filter(Boolean).map((x) => optionLabel(f, x)).join('、')
  if (f.fieldType === 'number') return f.config.unit ? `${s} ${f.config.unit}` : s
  if (f.fieldType === 'richtext') return s.replace(/<[^>]+>/g, ' ').trim() || '—'
  return s
}

function optionLabel(f: SchemaField, s: string): string {
  if (s.startsWith('other:')) return s.slice(6) || '其他'
  return f.config.options?.find((o) => o.value === s)?.label ?? s
}

const numeric = computed(() => new Set(props.fields.filter((f) => f.fieldType === 'number').map((f) => f.fieldKey)))

/* 只读区全屏：审核/归档视角下把明细表铺满屏查看（z-index 1000） */
const fullscreen = ref(false)
async function toggleFullscreen() {
  fullscreen.value = !fullscreen.value
  await nextTick()
}
function onGlobalKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && fullscreen.value) fullscreen.value = false
}
watch(fullscreen, (v) => {
  if (v) window.addEventListener('keydown', onGlobalKey)
  else window.removeEventListener('keydown', onGlobalKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <div class="dt-wrap" :class="{ 'is-fs': fullscreen }">
    <div class="dt-bar">
      <span class="spacer" />
      <el-button size="small" type="primary" plain @click="toggleFullscreen">{{ fullscreen ? '退出全屏' : '全屏' }}</el-button>
    </div>
    <el-table :data="rows" size="small" border stripe empty-text="无明细数据" :max-height="fullscreen ? 'calc(100vh - 92px)' : undefined">
      <el-table-column type="index" label="#" width="48" align="center" />
      <el-table-column
        v-for="f in fields"
        :key="f.fieldKey"
        :label="f.fieldLabel"
        :align="numeric.has(f.fieldKey) ? 'right' : 'left'"
        min-width="120"
        show-overflow-tooltip
      >
        <template #default="{ row }">{{ label(f, (row as Record<string, FieldValue>)[f.fieldKey] ?? null) }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.dt-wrap {
  display: flex;
  flex-direction: column;
}

.dt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.dt-wrap.is-fs {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: #fff;
  padding: 10px 14px 14px;
}

.dt-wrap.is-fs .dt-bar {
  margin-bottom: 8px;
}
</style>
