<script setup lang="ts">
/**
 * 6.1 在线填报页的单头区容器。
 * 6.5（1）：字段数量超过 60 个时按 config.group 分组，默认展开首组、其余组折叠，减少首屏渲染负担。
 */
import { computed, ref } from 'vue'
import { ArrowDown, ArrowRight } from '@element-plus/icons-vue'
import SchemaFieldInput from './SchemaFieldInput.vue'
import type { FieldValue, SchemaField } from '../system/types'

const props = withDefaults(
  defineProps<{
    fields: SchemaField[]
    modelValue: Record<string, FieldValue>
    locked?: boolean
    /** 超过该字段数时默认折叠分组（6.5（1）：阈值 60） */
    collapseAt?: number
  }>(),
  { locked: false, collapseAt: 60 },
)

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, FieldValue>] }>()

/** 分组：无 group 的字段归入「基本信息」，保持 Schema 给出的 sort 顺序 */
const groups = computed(() => {
  const map = new Map<string, SchemaField[]>()
  props.fields.forEach((f) => {
    const g = f.config.group ?? '基本信息'
    const arr = map.get(g) ?? []
    arr.push(f)
    map.set(g, arr)
  })
  return [...map.entries()].map(([name, items]) => ({
    name,
    items,
    /** 分组内存在必填且为空的字段时，折叠后仍要点提示 */
    missing: items.filter((f) => f.isRequired === 1 && f.permission === 'edit' && !props.modelValue[f.fieldKey]).length,
  }))
})

const collapsed = ref<Set<string>>(new Set())

function initCollapse() {
  if (props.fields.length <= props.collapseAt) return
  // 6.5（1）：字段数超阈值时，除第一组外默认折叠
  groups.value.slice(1).forEach((g) => collapsed.value.add(g.name))
}
initCollapse()

function toggle(name: string) {
  const s = new Set(collapsed.value)
  if (s.has(name)) s.delete(name)
  else s.add(name)
  collapsed.value = s
}

function patch(key: string, v: FieldValue) {
  emit('update:modelValue', { ...props.modelValue, [key]: v })
}
</script>

<template>
  <div class="fgrid">
    <template v-for="g in groups" :key="g.name">
      <h4 v-if="groups.length > 1" class="group-hd" style="grid-column: 1 / -1" @click="toggle(g.name)">
        <el-icon class="caret" :size="14">
          <component :is="collapsed.has(g.name) ? ArrowRight : ArrowDown" />
        </el-icon>
        {{ g.name }}
        <span class="muted">（{{ g.items.length }} 项）</span>
        <el-tag v-if="g.missing" size="small" type="warning" effect="plain">必填未填 {{ g.missing }}</el-tag>
      </h4>
      <SchemaFieldInput
        v-for="f in collapsed.has(g.name) ? [] : g.items"
        :key="f.fieldKey"
        :field="f"
        :row-index="0"
        :locked="locked"
        :model-value="modelValue[f.fieldKey] ?? null"
        @update:model-value="patch(f.fieldKey, $event)"
      />
    </template>
    <el-empty
      v-if="!fields.length"
      class="field-empty"
      description="当前账号在单头区没有任何可见字段（全部被字段权限隐藏，3.4 场景二）"
      :image-size="40"
    />
  </div>
</template>

<style scoped>
.group-hd .caret {
  color: var(--el-text-color-secondary);
}

/* 空状态占满整行网格，并去掉 el-empty 默认的大上下内边距，避免单头区标题下方一片空白 */
.field-empty {
  grid-column: 1 / -1;
  --el-empty-padding: 8px 0;
}

.field-empty :deep(.el-empty__description) {
  margin-top: 4px;
}
</style>
