<script setup lang="ts">
/**
 * 3.1 组织与用户管理：单位树、部门、用户（一人多角色）。
 * 仅系统管理员可维护（表 31），其余角色由路由守卫挡在门外。
 */
import { computed, reactive, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { api } from '../system/api'
import { db, rolesOf } from '../system/db'
import type { OrgNode } from '../system/service'
import { ROLE_LABEL } from '../system/schema-service'
import { ROLE } from '../system/types'
import type { ID, SysDept, SysOrg, SysUser } from '../system/types'
import { must, run, toast } from '../utils/notify'

const selectedOrg = ref<ID>(db.sys_org.find((o) => o.parentId === '0' && o.delFlag === 0)?.orgId ?? 'O1')
const orgNodes = computed<OrgNode[]>(() => must(api.org.tree()))

interface OrgOption {
  org: SysOrg
  depth: number
}

/** 把单位树摊平，供上级单位 / 所属单位下拉使用 */
function flatten(nodes: OrgNode[], depth = 0, out: OrgOption[] = []): OrgOption[] {
  nodes.forEach((n) => {
    out.push({ org: n.org, depth })
    flatten(n.children, depth + 1, out)
  })
  return out
}
const orgOptions = computed(() => flatten(orgNodes.value))

/** el-tree 要求节点自带稳定的 key 与 children，这里把 OrgNode 转成树控件的节点模型 */
interface OrgTreeNode {
  key: ID
  label: string
  level: SysOrg['orgLevel']
  org: SysOrg
  children: OrgTreeNode[]
}

function toTreeNodes(nodes: OrgNode[]): OrgTreeNode[] {
  return nodes.map((n) => ({
    key: n.org.orgId,
    label: n.org.orgName,
    level: n.org.orgLevel,
    org: n.org,
    children: toTreeNodes(n.children),
  }))
}
const treeData = computed(() => toTreeNodes(orgNodes.value))

/** 点节点只切换右侧部门与用户视图，改单位仍走每行的「编辑」按钮 */
function pickNode(data: OrgTreeNode) {
  selectedOrg.value = data.key
}

const orgDepts = computed(() => db.sys_dept.filter((d) => d.orgId === selectedOrg.value && d.delFlag === 0))
const orgUsers = computed(() => db.sys_user.filter((u) => u.orgId === selectedOrg.value && u.delFlag === 0))

/* ----------------------------------------------- 单位编辑 */
const orgForm = reactive({ orgId: '', orgName: '', orgCode: '', parentId: '0', orgLevel: 2 as 1 | 2 | 3, sort: 1, status: 1 as 0 | 1 })
const editingOrg = ref(false)

function newOrg() {
  const parent = db.sys_org.find((o) => o.orgId === selectedOrg.value)
  Object.assign(orgForm, {
    orgId: '',
    orgName: '',
    orgCode: '',
    parentId: parent?.orgId ?? '0',
    orgLevel: (Math.min(3, (parent?.orgLevel ?? 0) + 1) as 1 | 2 | 3),
    sort: db.sys_org.filter((o) => o.parentId === parent?.orgId && o.delFlag === 0).length + 1,
    status: 1,
  })
  editingOrg.value = true
}

function editOrg(o: SysOrg) {
  Object.assign(orgForm, o)
  editingOrg.value = true
}

function saveOrg() {
  run(() => {
    must(api.org.save({ ...orgForm, orgId: orgForm.orgId || undefined }))
    toast('ok', '单位已保存')
    editingOrg.value = false
  })
}

/* ----------------------------------------------- 部门编辑 */
const deptForm = reactive({ deptId: '', deptName: '', orgId: '', sort: 1, status: 1 as 0 | 1 })
const editingDept = ref(false)

function newDept() {
  Object.assign(deptForm, { deptId: '', deptName: '', orgId: selectedOrg.value, sort: orgDepts.value.length + 1, status: 1 })
  editingDept.value = true
}

function editDept(d: SysDept) {
  Object.assign(deptForm, d)
  editingDept.value = true
}

function saveDept() {
  run(() => {
    must(api.org.deptSave({ ...deptForm, deptId: deptForm.deptId || undefined }))
    toast('ok', '部门已保存')
    editingDept.value = false
  })
}

/* ----------------------------------------------- 用户编辑（多角色，表 12） */
const userForm = reactive({
  userId: '',
  username: '',
  realName: '',
  orgId: '' as ID,
  deptId: '' as ID,
  mobile: '',
  status: 1 as 0 | 1,
  roleIds: [] as ID[],
})
const editingUser = ref(false)
const keyword = ref('')
const pageNum = ref(1)

const USER_PAGE_SIZE = 10
const userPage = computed(() =>
  must(api.org.userPage({ pageNum: pageNum.value, pageSize: USER_PAGE_SIZE, keyword: keyword.value || undefined })),
)

const roleList = computed(() => db.sys_role.filter((r) => r.delFlag === 0))

/** 用户表单里的部门下拉跟随所选单位联动 */
const userDeptOptions = computed(() => db.sys_dept.filter((x) => x.orgId === userForm.orgId && x.delFlag === 0))

function newUser() {
  Object.assign(userForm, {
    userId: '',
    username: '',
    realName: '',
    orgId: selectedOrg.value,
    deptId: orgDepts.value[0]?.deptId ?? '',
    mobile: '',
    status: 1,
    // 默认给填报角色，避免建出无权限账号
    roleIds: roleList.value.filter((r) => r.roleCode === ROLE.REPORTER).map((r) => r.roleId),
  })
  editingUser.value = true
}

function editUser(u: SysUser) {
  Object.assign(userForm, { ...u, roleIds: [...u.roleIds] })
  editingUser.value = true
}

function saveUser() {
  run(() => {
    if (!userForm.username || !userForm.realName) throw new Error('登录账号与姓名必填')
    if (!userForm.roleIds.length) throw new Error('至少选择一个角色（3.1 支持一人多角色）')
    must(api.org.userSave({ ...userForm, userId: userForm.userId || undefined }))
    toast('ok', '用户已保存')
    editingUser.value = false
  })
}

function roleText(u: SysUser) {
  return rolesOf(u)
    .map((r) => ROLE_LABEL[r])
    .join(' / ')
}

const orgOf = (id: ID) => db.sys_org.find((o) => o.orgId === id)?.orgName ?? '—'
const deptOf = (id: ID) => db.sys_dept.find((d) => d.deptId === id)?.deptName ?? '—'
</script>

<template>
  <div>
    <h2 class="page-title">组织与用户</h2>
    <p class="page-sub">
      3.1：维护单位层级、部门与账号。部门参与字段权限裁决（7.2），一个账号可挂多个角色。仅系统管理员可维护。
    </p>

    <div class="split">
      <div class="side">
        <div class="card">
          <h3>单位树</h3>
          <el-tree
            :data="treeData"
            node-key="key"
            :props="{ label: 'label', children: 'children' }"
            default-expand-all
            highlight-current
            :expand-on-click-node="false"
            :current-node-key="selectedOrg"
            class="org-tree"
            @node-click="pickNode"
          >
            <template #default="{ data }">
              <span class="tnode" :class="{ on: selectedOrg === data.key }">
                <span class="tname">{{ data.label }}</span>
                <span class="muted mono">L{{ data.level }}</span>
                <el-button link type="primary" @click.stop="editOrg(data.org)">编辑</el-button>
              </span>
            </template>
          </el-tree>
          <el-button type="primary" size="small" style="margin-top: 10px" @click="newOrg">+ 新增下级单位</el-button>
        </div>

        <el-dialog v-model="editingOrg" width="520px" :close-on-click-modal="false" :title="orgForm.orgId ? '编辑单位' : '新增单位'">
          <div class="fgrid dialog-form">
            <label class="fld"><span class="cap">名称</span><el-input v-model="orgForm.orgName" /></label>
            <label class="fld"><span class="cap">编码（4.5 唯一）</span><el-input v-model="orgForm.orgCode" /></label>
            <label class="fld">
              <span class="cap">上级单位</span>
              <el-select v-model="orgForm.parentId">
                <el-option label="（顶级）" value="0" />
                <el-option v-for="o in orgOptions" :key="o.org.orgId" :label="`${'　'.repeat(o.depth)}${o.org.orgName}`" :value="o.org.orgId" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">层级</span>
              <el-select v-model="orgForm.orgLevel">
                <el-option :value="1" label="1 集团" />
                <el-option :value="2" label="2 分公司" />
                <el-option :value="3" label="3 项目部" />
              </el-select>
            </label>
          </div>
          <template #footer>
            <el-button @click="editingOrg = false">取消</el-button>
            <el-button type="primary" @click="saveOrg">保存</el-button>
          </template>
        </el-dialog>
      </div>

      <div class="main">
        <div class="card">
          <h3>部门 · {{ orgOf(selectedOrg) }}</h3>
          <el-table :data="orgDepts" size="small" border row-key="deptId" empty-text="该单位暂无部门">
            <el-table-column label="部门" min-width="180" prop="deptName" show-overflow-tooltip />
            <el-table-column label="排序" width="80" align="right" prop="sort" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status ? 'success' : 'info'">{{ row.status ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="right">
              <template #default="{ row }"><el-button link type="primary" @click="editDept(row as SysDept)">编辑</el-button></template>
            </el-table-column>
          </el-table>
          <el-button size="small" style="margin-top: 8px" @click="newDept">+ 新增部门</el-button>
        </div>

        <el-dialog v-model="editingDept" width="600px" :close-on-click-modal="false" :title="deptForm.deptId ? '编辑部门' : '新增部门'">
          <div class="fgrid dialog-form">
            <label class="fld"><span class="cap">名称</span><el-input v-model="deptForm.deptName" /></label>
            <label class="fld">
              <span class="cap">所属单位</span>
              <el-select v-model="deptForm.orgId" filterable>
                <el-option v-for="o in orgOptions" :key="o.org.orgId" :label="o.org.orgName" :value="o.org.orgId" />
              </el-select>
            </label>
            <label class="fld"><span class="cap">排序</span><el-input-number v-model="deptForm.sort" :min="1" :controls-position="'right'" /></label>
          </div>
          <template #footer>
            <el-button @click="editingDept = false">取消</el-button>
            <el-button type="primary" @click="saveDept">保存</el-button>
          </template>
        </el-dialog>

        <div class="card">
          <h3>用户</h3>
          <div class="row-gap" style="margin-bottom: 8px">
            <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="按姓名/账号检索" style="width: 240px" @input="pageNum = 1" />
            <el-button @click="keyword = ''">清空</el-button>
            <span class="spacer" />
            <el-button type="primary" @click="newUser">+ 新增用户</el-button>
          </div>
          <el-table :data="userPage.list" size="small" border row-key="userId" empty-text="无匹配用户">
            <el-table-column label="账号" width="120">
              <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
            </el-table-column>
            <el-table-column label="姓名" width="100" prop="realName" show-overflow-tooltip />
            <el-table-column label="角色" min-width="170" show-overflow-tooltip>
              <template #default="{ row }">{{ roleText(row as SysUser) }}</template>
            </el-table-column>
            <el-table-column label="单位 / 部门" min-width="180" show-overflow-tooltip>
              <template #default="{ row }"><span class="muted">{{ orgOf(row.orgId as ID) }} / {{ deptOf(row.deptId as ID) }}</span></template>
            </el-table-column>
            <el-table-column label="手机" width="120">
              <template #default="{ row }"><span class="mono">{{ row.mobile }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="86">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status ? 'success' : 'info'">{{ row.status ? '正常' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="right">
              <template #default="{ row }"><el-button link type="primary" @click="editUser(row as SysUser)">编辑</el-button></template>
            </el-table-column>
          </el-table>
          <div class="pager-row">
            <el-pagination
              v-model:current-page="pageNum"
              size="small"
              background
              layout="total, prev, pager, next"
              :page-size="USER_PAGE_SIZE"
              :total="userPage.total"
            />
          </div>
        </div>

        <el-dialog v-model="editingUser" width="680px" :close-on-click-modal="false" :title="userForm.userId ? '编辑用户' : '新增用户'">
          <p v-if="!userForm.userId" class="muted" style="margin: -6px 0 10px">新增账号初始密码 123456</p>
          <div class="fgrid dialog-form">
            <label class="fld">
              <span class="cap">登录账号<i class="req">*</i></span>
              <el-input v-model="userForm.username" :disabled="!!userForm.userId" />
            </label>
            <label class="fld"><span class="cap">姓名<i class="req">*</i></span><el-input v-model="userForm.realName" /></label>
            <label class="fld">
              <span class="cap">所属单位</span>
              <el-select v-model="userForm.orgId" filterable @change="userForm.deptId = ''">
                <el-option v-for="o in orgOptions" :key="o.org.orgId" :label="o.org.orgName" :value="o.org.orgId" />
              </el-select>
            </label>
            <label class="fld">
              <span class="cap">所属部门</span>
              <el-select v-model="userForm.deptId">
                <el-option label="（不挂部门）" value="" />
                <el-option v-for="d in userDeptOptions" :key="d.deptId" :label="d.deptName" :value="d.deptId" />
              </el-select>
            </label>
            <label class="fld"><span class="cap">手机</span><el-input v-model="userForm.mobile" /></label>
          </div>
          <div class="fld" style="margin-top: 12px">
            <span class="cap">角色（可多选，3.1）<i class="req">*</i></span>
            <el-checkbox-group v-model="userForm.roleIds" class="chips-wrap">
              <el-checkbox v-for="r in roleList" :key="r.roleId" :value="r.roleId">{{ ROLE_LABEL[r.roleCode] }}</el-checkbox>
            </el-checkbox-group>
          </div>
          <p class="muted" style="margin-top: 10px">部门与角色都参与字段权限裁决，用户级规则优先（7.2）。</p>
          <template #footer>
            <el-button @click="editingUser = false">取消</el-button>
            <el-button type="primary" @click="saveUser">保存</el-button>
          </template>
        </el-dialog>

        <div class="card">
          <h3>本单位快速视图</h3>
          <el-table :data="orgUsers" size="small" border row-key="userId" empty-text="该单位下暂无账号">
            <el-table-column label="账号" width="120">
              <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
            </el-table-column>
            <el-table-column label="姓名" width="100" prop="realName" show-overflow-tooltip />
            <el-table-column label="角色" min-width="170" show-overflow-tooltip>
              <template #default="{ row }">{{ roleText(row as SysUser) }}</template>
            </el-table-column>
            <el-table-column label="部门" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ deptOf(row.deptId as ID) }}</template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 单位树行高与 EP 默认控件节奏对齐 */
.org-tree :deep(.el-tree-node__content) {
  height: 30px;
}

.org-tree :deep(.el-tree-node__content:hover) {
  background: var(--el-fill-color-light);
}

.org-tree :deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: var(--el-color-primary-light-9);
}

.tnode {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  padding-right: 6px;
  font-size: 13px;
}

.tnode .tname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tnode.on .tname {
  color: var(--el-color-primary);
  font-weight: 600;
}

/* 角色多选横排折行 */
.chips-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 0 18px;
  margin-top: 4px;
}
</style>
