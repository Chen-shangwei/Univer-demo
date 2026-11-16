/** 临时探针：单次进程内只登录一个账号，排除互相占锁干扰（不参与 pnpm check） */
import '../check/stub'
import { api } from '../src/system/api'
import { db } from '../src/system/db'

const [username, taskId] = [process.argv[2] ?? 'rep_a', process.argv[3] ?? 'TASK-1']
const u = db.sys_user.find((x) => x.username === username)!
const r = api.auth.login(username, '123456')
if (r.code !== 200) throw new Error(`登录失败：${r.msg}`)

const load = api.form.load(taskId, 1)
const ctx = load.code === 200 ? load.data : null
console.log(
  `${username}（${u.realName} ${u.orgId}/${u.deptId} roles=${u.roleIds}）${taskId} ` +
    `code=${load.code} readonly=${ctx?.readonly} recordStatus=${ctx?.record.recordStatus} ` +
    `owner=${ctx?.record.userId} me=${u.userId} 归属他人=${ctx ? ctx.record.userId !== u.userId : '-'}`,
)
if (ctx) {
  console.log(
    '  明细列：' +
      ctx.schema.fields
        .filter((f) => f.config.scope === 'detail')
        .map((f) => `${f.fieldKey}:${f.permission}`)
        .join(' '),
  )
  console.log('  可编辑列数=' + ctx.schema.fields.filter((f) => f.permission === 'edit').length)
}
