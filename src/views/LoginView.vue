<script setup lang="ts">
/**
 * 6.1 登录页。对应流程节点 1（统一身份认证）。
 * 原型内直接读表 12 的演示账号，密码统一 123456（9.4 数据初始化）。
 */
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Lock, User } from '@element-plus/icons-vue'
import type { FormInstance, FormRules } from 'element-plus'
import { db, rolesOf } from '../system/db'
import { api } from '../system/api'
import { ROLE_LABEL } from '../system/schema-service'
import { homeOf } from '../system/session'
import { toast } from '../utils/notify'

const router = useRouter()
const formRef = ref<FormInstance>()
const model = reactive({ username: '', password: '' })
const busy = ref(false)

const rules: FormRules = {
  username: [{ required: true, message: '请输入登录账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

const demoUsers = computed(() =>
  db.sys_user
    .filter((u) => u.delFlag === 0)
    .map((u) => ({
      ...u,
      roleText: rolesOf(u)
        .map((r) => ROLE_LABEL[r])
        .join(' / '),
      orgText: db.sys_org.find((o) => o.orgId === u.orgId)?.orgName ?? '',
    })),
)

function pick(name: string) {
  model.username = name
  model.password = '123456'
}

async function submit() {
  if (!(await formRef.value?.validate().catch(() => false))) return
  busy.value = true
  try {
    const r = api.auth.login(model.username.trim(), model.password)
    if (r.code !== 200) {
      toast('err', r.msg)
      return
    }
    const u = db.sys_user.find((x) => x.userId === r.data.userId)!
    toast('ok', `欢迎，${u.realName}`)
    router.replace(homeOf(u))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <el-card class="login-box" shadow="never">
      <h2 class="page-title">智能填报系统</h2>
      <p class="page-sub">乌能投数据中台 · 填报 / 审核 / 汇总一体化原型</p>

      <el-form ref="formRef" :model="model" :rules="rules" label-position="top" size="large" @submit.prevent="submit">
        <el-form-item label="登录账号" prop="username">
          <el-input v-model="model.username" autocomplete="username" placeholder="username" :prefix-icon="User" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="model.password" type="password" autocomplete="current-password" show-password :prefix-icon="Lock" />
        </el-form-item>
        <el-button type="primary" native-type="submit" size="large" :loading="busy" style="width: 100%">
          {{ busy ? '登录中…' : '登录' }}
        </el-button>
      </el-form>

      <el-text size="small" type="info" class="login-note">
        真实环境由统一身份认证平台完成单点登录（3.1 待确认事项其一），此处使用本地账号表演示。
      </el-text>
    </el-card>

    <el-card class="acc-list" shadow="never">
      <template #header>演示账号（点击填入，密码统一 123456）</template>
      <el-table :data="demoUsers" size="small" border max-height="420" @row-click="(row: any) => pick(row.username)">
        <el-table-column label="账号" width="120">
          <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
        </el-table-column>
        <el-table-column prop="realName" label="姓名" width="88" />
        <el-table-column prop="roleText" label="角色" min-width="120" show-overflow-tooltip />
        <el-table-column label="所属单位" min-width="140" show-overflow-tooltip>
          <template #default="{ row }"><span class="muted">{{ row.orgText }}</span></template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.login-box :deep(.el-card__body) {
  padding: 24px;
}

.login-note {
  display: block;
  margin-top: 16px;
  line-height: 20px;
}
</style>
