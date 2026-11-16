/** 临时探针：核对各填报账号进入 TASK-1 时的只读判定（不参与 pnpm check） */
import '../check/stub'
import { api } from '../src/system/api'
import { db } from '../src/system/db'
import { recordOf } from '../src/system/db'

function who(username: string) {
  const u = db.sys_user.find((x) => x.username === username)!
  const r = api.auth.login(username, '123456')
  if (r.code !== 200) throw new Error(`登录失败 ${username}: ${r.msg}`)
  return u
}

for (const t of db.form_task) {
  console.log(`任务 ${t.taskId} status=${t.status} auditType=${t.auditType} single=${t.singleRecordPerOrg} ${t.startTime.slice(0, 10)}~${t.endTime.slice(0, 10)}`)
}
console.log('')

for (const name of ['rep_a', 'rep_a2', 'rep_b', 'rep_c']) {
  const u = who(name)
  const rec = recordOf('TASK-1', u.orgId, 1)
  const r = api.form.load('TASK-1', 1)
  const ctx = r.code === 200 ? r.data : null
  console.log(
    `${name}（${u.realName} ${u.orgId}/${u.deptId}）TASK-1：code=${r.code} msg=${r.msg} readonly=${ctx?.readonly} ` +
      `recordStatus=${ctx?.record.recordStatus} record.userId=${rec?.userId ?? '无记录'} record.user!=me=${!!rec && rec.userId !== u.userId}`,
  )
  if (ctx) {
    console.log(
      `   明细列权限：` +
        ctx.schema.fields
          .filter((f) => f.config.scope === 'detail')
          .map((f) => `${f.fieldKey}:${f.permission}`)
          .join(' '),
    )
  }
  const out = api.record.draft('TASK-1', 1, { summary: '探针写入' }, ctx?.rows ?? [])
  console.log(`   保存草稿 → code=${out.code} ok=${out.data?.ok} msg=${out.data?.message ?? out.msg}`)
}
