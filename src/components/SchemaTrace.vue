<script setup lang="ts">
/**
 * 配置端与填报端的 Schema 推导留痕（7.1 合并 + 7.2 裁决）。
 * 用于自证：基础字段如何被差异规则改写、又被哪一条权限规则决定了可见性。
 */
import { ref } from 'vue'
import type { FormSchema } from '../system/types'

const props = defineProps<{ schema: FormSchema }>()

const active = ref<string[]>([])
const STAGE = { base: '基础字段', diff: '差异规则', permission: '权限裁决', result: '最终结果' } as const
const STAGE_TYPE: Record<string, 'info' | 'warning' | 'danger' | 'success'> = {
  base: 'info',
  diff: 'warning',
  permission: 'danger',
  result: 'success',
}
</script>

<template>
  <div class="card">
    <el-collapse v-model="active">
      <el-collapse-item name="trace">
        <template #title>
          <span class="trace-cap">
            Schema 推导过程（{{ schema.fields.length }} 个可见字段 / {{ schema.hiddenKeys.length }} 个隐藏字段 / 模板
            {{ schema.templateVersion }}）
          </span>
        </template>

        <ol class="trace">
          <li v-for="(s, i) in schema.trace" :key="i">
            <el-tag size="small" effect="plain" :type="STAGE_TYPE[s.stage] ?? 'info'">{{ STAGE[s.stage] ?? s.stage }}</el-tag>
            <span class="trace-detail">{{ s.detail }}</span>
          </li>
        </ol>
        <el-text v-if="schema.hiddenKeys.length" size="small" type="info" class="trace-hidden">
          被隐藏且完全不渲染的字段标识：{{ schema.hiddenKeys.join('、') }}
        </el-text>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<style scoped>
.card :deep(.el-collapse) {
  border-top: none;
}

.card :deep(.el-collapse-item__header) {
  height: 24px;
  line-height: 24px;
}

.card :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}

.trace-cap {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.trace {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-size: 12px;
  line-height: 24px;
  color: var(--el-text-color-regular);
  max-height: 260px;
  overflow: auto;
}

.trace li {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.trace-detail {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.trace-hidden {
  display: block;
  margin-top: 8px;
}
</style>
