/** 临时探针：协同填写与写锁互斥的行为验证（不参与 pnpm check） */
import '../check/stub'
import { api } from '../src/system/api'
import { db } from '../src/system/db'
import { detailFields } from '../src/system/schema-service'

function login(name: string) {
  const r = api.auth.login(name, '123456')
  if (r.code !== 200) throw new Error(`登录失败 ${name}：${r.msg}`)
  return db.sys_user.find((u) => u.username === name)!
}

const chen = login('rep_a')
// 1. 陈涛进入并持锁
const a = api.form.load('TASK-1', 1)
console.log(`1) 陈涛载入：code=${a.code} readonly=${a.data?.readonly} 原因=${a.data?.readonlyReason || '（可填写）'}`)

const sun = login('rep_a2')
console.log(`   陈涛=${chen.userId} 孙悦=${sun.userId} 同单位=${chen.orgId === sun.orgId}`)

// 2. 孙悦随后进入 → 应被锁拦下（1009）
const b = api.form.load('TASK-1', 1)
console.log(`2) 孙悦载入：code=${b.code} ${b.msg}`)

// 3. 孙悦以只读方式进入 → 只读，且原因是他人持锁
const c = api.form.load('TASK-1', 1, sun.userId, false)
console.log(`3) 孙悦只读进入：code=${c.code} readonly=${c.data?.readonly} 原因=${c.data?.readonlyReason}`)

// 4. 僵尸页面自动保存 → 应被写锁拒绝
const d = api.record.draft('TASK-1', 1, { ...c.data?.data, summary: '孙悦的覆盖写入' }, (c.data?.rows ?? []).map((r) => ({ ...r })))
console.log(`4) 锁在陈涛手上时孙悦保存：code=${d.code} msg=${d.msg}`)

// 5. 锁超时释放后孙悦正常进入 → 明细列可编辑，保存应成功
db.edit_lock.length = 0
const e = api.form.load('TASK-1', 1)
console.log(`5) 孙悦载入：code=${e.code} readonly=${e.data?.readonly} 原因=${e.data?.readonlyReason || '（可填写）'}`)
console.log(`   孙悦可编辑明细列：${e.data ? detailFields(e.data.schema).filter((f) => f.permission === 'edit').map((f) => f.fieldKey).join('、') : '-'}`)
const eRows = (e.data?.rows ?? []).map((r) => ({ ...r, planNum: Number(r.planNum ?? 0) + 1 }))
const f = api.record.draft('TASK-1', 1, { ...e.data?.data }, eRows)
console.log(`6) 孙悦保存草稿：code=${f.code} ok=${f.data?.ok} msg=${f.data?.message ?? f.msg}`)
const rc1 = db.form_record.find((r) => r.recordId === 'RC1')!
console.log(`   记录归属→${rc1.userId}（孙悦=${sun.userId}），填报人列=${rc1.data.userName}，部门列=${rc1.data.deptName}`)
console.log(`   明细 planNum=${rc1.rows.map((r) => r.planNum).join('/')}`)
