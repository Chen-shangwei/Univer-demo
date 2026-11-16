<script setup lang="ts">
/**
 * 明细区只读呈现（审核、日志回溯、记录详情等非填报视角）。
 * hidden 列不出现在 fields 中，因此不会渲染（6.3）；只读列正常展示值。
 */
import { computed } from 'vue'
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
</script>

<template>
  <el-table :data="rows" size="small" border stripe empty-text="无明细数据">
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
</template>
