<script setup lang="ts">
/**
 * 3.4 字段级权限配置：以「模板 + 字段 + 权限对象」三元组维护 hidden / read / edit 规则，
 * 并支持任选「用户 + 单位」预览裁决结果（7.2 算法的可视化自证）。
 * 规则本身不带版本列：作用于模板整体，随版本演进的快照在版本发布时留存。
 */
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Delete, EditPen, Plus } from '@element-plus/icons-vue'
import SchemaTrace from '../components/SchemaTrace.vue'
import { api } from '../system/api'
import { db, orgById } from '../system/db'
import { decidePerm, detailFields, headerFields, PERM_LABEL, TARGET_LABEL } from '../system/schema-service'
import type { FormFieldPermission, FormSchema, ID, PermType, TargetType } from '../system/types'
import { confirmAction, must, run, runAsync, toast } from '../utils/notify'

const route = useRoute()
const templateId = ref<ID>((route.query.templateId as string) ?? db.form_template.find((t) => t.delFlag === 0)?.templateId ?? '')

const templates = computed(() => db.form_template.filter((t) => t.delFlag === 0))
const template = computed(() => db.form_template.find((t) => t.templateId === templateId.value))
/** 可选字段：当前版本的基础字段 + 各子单位新增的独有字段标识 */
const fieldKeys = computed(() => {
  if (!template.value) return [] as { key: string; label: string }[]
  const base = db.form_field
    .filter((f) => f.templateId === templateId.value && f.version === template.value!.version && f.delFlag === 0)
    .map((f) => ({ key: f.fieldKey, label: f.fieldLabel }))
  const add = db.form_org_diff
    .filter((d) => d.templateId === templateId.value && d.diffType === 3 && d.delFlag === 0)
    .map((d) => ({ key: d.fieldKey, label: `${d.fieldLabel ?? d.fieldKey}（独有字段）` }))
  const seen = new Set<string>()
  return [...base, ...add].filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
})

const rules = computed(() => must(api.perm.list(templateId.value)))
const filtered = computed(() => (draft.fieldKey ? rules.value.filter((r) => r.fieldKey === draft.fieldKey) : rules.value))

function targetName(r: FormFieldPermission): string {
  switch (r.targetType) {
    case 1:
      return db.sys_role.find((x) => x.roleId === r.targetId)?.roleName ?? r.targetId
    case 2:
      return db.sys_dept.find((x) => x.deptId === r.targetId)?.deptName ?? r.targetId
    case 3:
      return orgById(r.targetId)?.orgName ?? r.targetId
    case 4:
      return db.sys_user.find((x) => x.userId === r.targetId)?.realName ?? r.targetId
  }
}

/* ------------------------------------------------ 规则编辑 */
const TARGET_KEYS = [1, 2, 3, 4] as TargetType[]
const PERM_KEYS = ['hidden', 'read', 'edit'] as PermType[]
const PERM_TAG: Record<PermType, 'danger' | 'info' | 'success'> = { hidden: 'danger', read: 'info', edit: 'success' }

const draft = reactive({
  permId: '',
  fieldKey: '' as string,
  targetType: 1 as TargetType,
  targetId: '' as ID,
  permType: 'read' as PermType,
  /** 空串代表不覆盖必填属性 */
  requiredOverride: '' as '' | '0' | '1',
  note: '',
})
const editing = ref(false)

/** 权限对象候选项随 targetType 切换 */
const targetOptions = computed(() => {
  if (draft.targetType === 1) return db.sys_role.filter((r) => r.status === 1).map((r) => ({ id: r.roleId, name: r.roleName }))
  if (draft.targetType === 2) return db.sys_dept.filter((d) => d.delFlag === 0).map((d) => ({ id: d.deptId, name: `${orgById(d.orgId)?.orgName ?? ''} / ${d.deptName}` }))
  if (draft.targetType === 3) return db.sys_org.filter((o) => o.orgLevel >= 2 && o.delFlag === 0).map((o) => ({ id: o.orgId, name: o.orgName }))
  return db.sys_user.filter((u) => u.delFlag === 0).map((u) => ({ id: u.userId, name: `${u.realName}（${orgById(u.orgId)?.orgName ?? ''}）` }))
})

function newRule() {
  Object.assign(draft, {
    permId: '',
    fieldKey: draft.fieldKey || (fieldKeys.value[0]?.key ?? ''),
    targetType: 1 as TargetType,
    targetId: targetOptions.value[0]?.id ?? '',
    permType: 'read' as PermType,
    requiredOverride: '' as const,
    note: '',
  })
  editing.value = true
}

function editRule(r: FormFieldPermission) {
  Object.assign(draft, {
    permId: r.permId,
    fieldKey: r.fieldKey,
    targetType: r.targetType,
    targetId: r.targetId,
    permType: r.permType,
    requiredOverride: r.requiredOverride === undefined ? ('' as const) : (String(r.requiredOverride) as '0' | '1'),
    note: r.note ?? '',
  })
  editing.value = true
}

function save() {
  run(() => {
    if (!draft.fieldKey) throw new Error('请选择字段标识')
    if (!draft.targetId) throw new Error('请选择权限对象')
    must(
      api.perm.save({
        permId: draft.permId || undefined,
        templateId: templateId.value,
        fieldKey: draft.fieldKey,
        targetType: draft.targetType,
        targetId: draft.targetId,
        permType: draft.permType,
        requiredOverride: draft.requiredOverride === '' ? undefined : (Number(draft.requiredOverride) as 0 | 1),
        note: draft.note,
      }),
    )
    toast('ok', '权限规则已保存，Schema 缓存同步失效（7.2）')
    editing.value = false
    refreshPreview()
  })
}

function remove(r: FormFieldPermission) {
  void runAsync(async () => {
    const yes = await confirmAction(
      `删除规则「${r.fieldKey} → ${TARGET_LABEL[r.targetType]}[${targetName(r)}] = ${PERM_LABEL[r.permType]}」？`,
      '删除确认',
    )
    if (!yes) return
    must(api.perm.remove(r.permId))
    toast('ok', '规则已删除')
    refreshPreview()
  })
}

/* ------------------------------------------------ 裁决预览 */
const viewUser = ref<ID>('U5')
const viewOrg = ref<ID>('O11')
const schema = ref<FormSchema | null>(null)

function refreshPreview() {
  run(() => {
    if (!template.value) return
    schema.value = must(api.template.preview(templateId.value, template.value.version, viewOrg.value, viewUser.value))
  })
}
refreshPreview()

/** 逐字段列出命中当前预览用户的规则与采纳结果（7.2 伪代码的表格化呈现） */
const decision = computed(() => {
  const u = db.sys_user.find((x) => x.userId === viewUser.value)
  if (!u || !schema.value) return []
  return schema.value.fields.map((f) => {
    const d = decidePerm(f.fieldKey, u, templateId.value, f.isRequired)
    return {
      fieldKey: f.fieldKey,
      label: f.fieldLabel,
      perm: f.permission,
      required: f.isRequired,
      hit: d.hit ?? '无规则，默认 edit',
      matched: d.matched,
      systemValue: f.systemValue,
      scope: f.config.scope === 'detail' ? '明细' : '单头',
    }
  })
})

const hiddenList = computed(() => schema.value?.hiddenKeys ?? [])

/* ------------------------------------------------ 3.4 三个典型场景 */
const SCENES = [
  { name: '场景一 · 审核人全程只读', user: 'U4', org: 'O11', desc: '审核角色命中模板全部字段的 read 规则，表单可查看不可修改。' },
  { name: '场景二 · 敏感字段隔离', user: 'U5', org: 'O11', desc: '填报员命中 budgetNote 的 hidden 规则，该字段不进 Schema、DOM 无痕迹。' },
  { name: '场景三 · 跨部门分段填报', user: 'U8', org: 'O11', desc: '财务部（D13）可改 riskFund、看不到 hazard，部门级优先于角色级。' },
]

function applyScene(s: (typeof SCENES)[number]) {
  viewUser.value = s.user
  viewOrg.value = s.org
  refreshPreview()
}

const headCount = computed(() => (schema.value ? headerFields(schema.value).length : 0))
const detailCount = computed(() => (schema.value ? detailFields(schema.value).length : 0))
</script>

<template>
  <div>
    <h2 class="page-title">字段级权限配置</h2>
    <p class="page-sub">
      3.4：对同一字段按角色 / 部门 / 子单位 / 用户四类对象设置隐藏、只读、可编辑。裁决优先级为 用户 &gt; 部门 &gt; 角色 &gt; 单位，严格程度为 隐藏 &gt; 只读 &gt; 可编辑（7.2）。
    </p>

    <div class="card row-gap">
      <span class="muted">模板</span>
      <el-select v-model="templateId" filterable style="width: 260px">
        <el-option v-for="t in templates" :key="t.templateId" :label="`${t.templateName}（${t.version}）`" :value="t.templateId" />
      </el-select>
      <span class="muted">聚焦字段</span>
      <el-select v-model="draft.fieldKey" filterable clearable placeholder="全部字段" style="width: 240px">
        <el-option label="全部字段" value="" />
        <el-option v-for="f in fieldKeys" :key="f.key" :label="`${f.label}（${f.key}）`" :value="f.key" />
      </el-select>
      <span class="spacer" />
      <el-button type="primary" :icon="Plus" @click="newRule">+ 新增规则</el-button>
      <span class="muted">共 {{ rules.length }} 条规则</span>
    </div>

    <div class="split">
      <div class="main">
        <div class="card">
          <h3>规则清单{{ draft.fieldKey ? ` · 字段 ${draft.fieldKey}` : '' }}</h3>
          <el-table :data="filtered" size="small" border row-key="permId" empty-text="没有规则，该范围按 2.6 默认全部可编辑">
            <el-table-column label="字段标识" width="150">
              <template #default="{ row }"><span class="mono">{{ row.fieldKey }}</span></template>
            </el-table-column>
            <el-table-column label="对象类型" width="100">
              <template #default="{ row }">{{ TARGET_LABEL[row.targetType as TargetType] }}</template>
            </el-table-column>
            <el-table-column label="对象" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">{{ targetName(row as FormFieldPermission) }}</template>
            </el-table-column>
            <el-table-column label="权限" width="90">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="PERM_TAG[row.permType as PermType]">{{ PERM_LABEL[row.permType as PermType] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="必填覆盖" width="110">
              <template #default="{ row }">
                <span class="muted">{{ row.requiredOverride === undefined ? '不改' : row.requiredOverride ? '强制必填' : '取消必填' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="180" show-overflow-tooltip>
              <template #default="{ row }"><span class="muted">{{ row.note }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="130" align="right">
              <template #default="{ row }">
                <el-button link type="primary" :icon="EditPen" @click="editRule(row as FormFieldPermission)">编辑</el-button>
                <el-button link type="danger" :icon="Delete" @click="remove(row as FormFieldPermission)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <el-dialog v-model="editing" width="680px" :close-on-click-modal="false" :title="draft.permId ? '编辑权限规则' : '新增权限规则'">
          <div class="fgrid dialog-form">
            <label class="fld">
              <span class="cap">字段<i class="req">*</i></span>
              <el-select v-model="draft.fieldKey" filterable placeholder="选择字段">
                <el-option v-for="f in fieldKeys" :key="f.key" :label="`${f.label}（${f.key}）`" :value="f.key" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">权限对象类型</span>
              <el-select v-model="draft.targetType" @change="draft.targetId = targetOptions[0]?.id ?? ''">
                <el-option v-for="k in TARGET_KEYS" :key="k" :label="TARGET_LABEL[k]" :value="k" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">权限对象</span>
              <el-select v-model="draft.targetId" filterable placeholder="选择权限对象">
                <el-option v-for="o in targetOptions" :key="o.id" :label="o.name" :value="o.id" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">权限</span>
              <el-select v-model="draft.permType">
                <el-option v-for="p in PERM_KEYS" :key="p" :label="PERM_LABEL[p]" :value="p" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">必填覆盖（仅 edit 生效）</span>
              <el-select v-model="draft.requiredOverride">
                <el-option label="不覆盖" value="" />
                <el-option label="强制必填" value="1" />
                <el-option label="取消必填" value="0" />
              </el-select>
            </label>
            <label class="fld wide"><span class="cap">说明</span><el-input v-model="draft.note" placeholder="例如：费用口径由集团维护，填报端只读" /></label>
          </div>
          <p class="tip">保存后按模板维度批量失效 Schema 缓存，下次加载即生效（5.3.1）。</p>
          <template #footer>
            <el-button @click="editing = false">取消</el-button>
            <el-button type="primary" @click="save">保存</el-button>
          </template>
        </el-dialog>

        <div class="card">
          <h3>裁决预览 · 以指定身份打开表单</h3>
          <div class="row-gap" style="margin-bottom: 10px">
            <span class="muted">用户</span>
            <el-select v-model="viewUser" filterable style="width: 220px" @change="refreshPreview">
              <el-option
                v-for="u in db.sys_user.filter((x) => x.delFlag === 0)"
                :key="u.userId"
                :label="`${u.realName}（${orgById(u.orgId)?.orgName}）`"
                :value="u.userId"
              />
            </el-select>
            <span class="muted">单位视图</span>
            <el-select v-model="viewOrg" style="width: 200px" @change="refreshPreview">
              <el-option v-for="o in db.sys_org.filter((x) => x.orgLevel >= 2 && x.delFlag === 0)" :key="o.orgId" :label="o.orgName" :value="o.orgId" />
            </el-select>
            <span class="spacer" />
            <el-tag size="small" type="info">单头 {{ headCount }}</el-tag>
            <el-tag size="small" type="info">明细 {{ detailCount }}</el-tag>
            <el-tag size="small" type="warning">隐藏 {{ hiddenList.length }}</el-tag>
          </div>

          <el-table :data="decision" size="small" border row-key="fieldKey" max-height="480" empty-text="该身份下没有任何可见字段">
            <el-table-column label="字段" min-width="200">
              <template #default="{ row }"><span class="mono">{{ row.fieldKey }}</span> {{ row.label }}</template>
            </el-table-column>
            <el-table-column label="区域" width="72">
              <template #default="{ row }"><span class="muted">{{ row.scope }}</span></template>
            </el-table-column>
            <el-table-column label="呈现" width="130">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="PERM_TAG[row.perm as PermType]">{{ PERM_LABEL[row.perm as PermType] }}</el-tag>
                <el-tag v-if="row.systemValue" size="small" type="primary" effect="plain">系统赋值</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="必填" width="84">
              <template #default="{ row }"><span class="muted">{{ row.required ? '必填' : '非必填' }}</span></template>
            </el-table-column>
            <el-table-column label="采纳规则" min-width="180">
              <template #default="{ row }"><span class="mono">{{ row.hit }}</span></template>
            </el-table-column>
            <el-table-column label="命中情况" min-width="180" show-overflow-tooltip>
              <template #default="{ row }"><span class="muted">{{ row.matched.length ? row.matched.join('，') : '—' }}</span></template>
            </el-table-column>
          </el-table>

          <el-alert
            v-if="hiddenList.length"
            type="error"
            :closable="false"
            show-icon
            title="字段完全隐藏"
            style="margin-top: 10px"
          >
            <template #default>以下字段对当前身份不创建组件、不占用布局、不参与校验与导出：<b class="mono">{{ hiddenList.join('、') }}</b></template>
          </el-alert>
        </div>

        <SchemaTrace v-if="schema" :schema="schema" />
      </div>

      <div class="side">
        <div class="card">
          <h3>典型场景自证</h3>
          <div v-for="s in SCENES" :key="s.name" style="margin-bottom: 12px">
            <el-button style="width: 100%" @click="applyScene(s)">{{ s.name }}</el-button>
            <p class="muted" style="margin: 4px 0 0">{{ s.desc }}</p>
          </div>
        </div>
        <div class="card">
          <h3>配置口径</h3>
          <ul class="rule-list">
            <li>隐藏优先级最高：命中即终止，不再看其它规则</li>
            <li>同一字段命中多条时，按 用户 &gt; 部门 &gt; 角色 &gt; 单位 排序后取最严格者</li>
            <li>单位名称、填报人、序号等系统赋值列强制只读，任何规则都打不开</li>
            <li>必填属性只在可编辑时生效，只读列不参与必填校验</li>
            <li>规则变更不影响历史数据，历史仍按记录自身版本呈现（7.3）</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
