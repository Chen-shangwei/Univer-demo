import fs from 'node:fs'
const p = 'check/run.ts'
const s = fs.readFileSync(p, 'utf8')
const bad = `includes('\u5DF1\u63D0\u4EA4')`
const good = `includes('\u5DF2\u63D0\u4EA4')`
if (!s.includes(bad)) {
  console.log('bad sequence not found')
  process.exit(1)
}
fs.writeFileSync(p, s.replace(bad, good))
console.log('fixed ->', good)
