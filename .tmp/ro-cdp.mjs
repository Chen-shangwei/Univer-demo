// 只读列拦截验证。
// 判定信号用 Univer 编辑容器 [data-u-comp="editor"] 的几何位置：隐藏时被平移到 -1000px，
// 打开时落在目标单元格上。activeElement 不可靠（Escape 后焦点仍留在编辑器节点里）。
const PORT = 9340
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:5175')) ?? list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('devtools endpoint not reachable')
}

const ws = new WebSocket(await connect())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let mid = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push('EX ' + String(msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params)).slice(0, 240))
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('CE ' + JSON.stringify(msg.params.args).slice(0, 240))
})
const send = (method, params = {}) => {
  const id = ++mid
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function js(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 400))
  return r.result.value
}
async function dblclick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 0, buttons: 0 })
  await sleep(90)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 0, buttons: 0 })
  await sleep(260)
}
async function typeText(s) {
  for (const ch of s) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
    await sleep(40)
  }
}
async function press(k) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: k, key: k, windowsVirtualKeyCode: k.charCodeAt(0) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: k, key: k, windowsVirtualKeyCode: k.charCodeAt(0) })
}

/** 编辑容器几何：open=false 表示被藏在 -1000px，即没有进入编辑态 */
const EDITOR = `(() => {
  const n = document.querySelector('[data-u-comp="editor"]')
  if (!n) return { open: false, why: 'no-editor-host' }
  const r = n.getBoundingClientRect()
  const open = r.left > -500 && r.width > 1 && r.height > 1
  return { open, left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), text: (n.textContent || '').trim().slice(0, 14) }
})()`

/** 组件真值：每列权限、列宽、sync() 业务输出 */
const SNAP = `(() => {
  const el = document.querySelector('.univer-host')
  const c = el && el.__vueParentComponent
  if (!c) return { err: 'no vue component' }
  const s = c.setupState
  const fields = (s.props ? s.props.fields : c.props.fields) || []
  const widthOf = (f) => { const base = f.fieldLabel.length * 15 + 34
    return (f.fieldType === 'textarea' || f.fieldType === 'richtext') ? Math.min(320, Math.max(200, base)) : Math.min(240, Math.max(104, base)) }
  return {
    perms: fields.map((f) => f.fieldKey + '=' + f.permission),
    widths: fields.map(widthOf),
    rows: s.workbook ? JSON.stringify(s.sync()) : null,
  }
})()`

async function openAs(userId, mutateDb) {
  // 先停在登录页：此时应用不写 db，避免 debounced persist 覆盖注入的规则
  await send('Page.navigate', { url: 'http://localhost:5175/#/login' })
  await sleep(2500)
  await js(`localStorage.setItem('zn-tb-session', JSON.stringify({userId:${JSON.stringify(userId)},token:'p',issuedAt:Date.now(),expireAt:Date.now()+3600000}));1`)
  if (mutateDb) await js(mutateDb)
  await js(`location.hash = '/fill/detail?taskId=TASK-1&seq=1';1`)
  await sleep(400)
  await js('location.reload();1')
  let ready = false
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    ready = await js(`!!(document.querySelector('.univer-host') && document.querySelector('.univer-host canvas') && document.querySelector('.univer-host').__vueParentComponent)`)
    if (ready) break
  }
  await sleep(2500)
  if (!ready) {
    console.log('  !! 网格未出现 url=', await js('location.href'))
    console.log('  !! 页面文本=', await js(`document.body.innerText.replace(/\s+/g,' ').slice(0, 420)`))
    return false
  }
  await js(`document.querySelector('.univer-host').scrollIntoView({block:'center'});1`)
  await sleep(500)
  return true
}

/**
 * 沿第一条数据行横扫双击。
 * 每次双击后若打开了编辑器，记录其 left（= canvas 左缘 + 行头槽宽 + 前置列宽之和），
 * 用它反推行头槽宽 gutter，从而把任意采样点 x 精确映射到列号。
 */
async function sweep(y, from, to, step, widths) {
  const samples = []
  for (let x = from; x <= to; x += step) {
    await dblclick(x, y)
    const st = await js(EDITOR)
    samples.push({ x, ...st })
    if (st.open) {
      await press('Escape')
      await sleep(120)
      await press('Escape')
      await dblclick(Math.round(from - 12), y) // 点到行头，彻底退出编辑态
      await sleep(120)
    }
    samples[samples.length - 1].after = (await js(EDITOR)).open
  }
  const prefix = [0]
  widths.forEach((w) => prefix.push(prefix[prefix.length - 1] + w))
  return { samples, prefix, gutter: solveGutter(samples, prefix) }
}

/**
 * 行头槽宽无法从 DOM 取（全部画在 canvas 上），改用“打开的编辑框 left 必定落在列边界”反解：
 * 对 10~90 逐个试，取让所有 opened 样本离列边界最近的值。
 */
function solveGutter(samples, prefix) {
  const opened = samples.filter((s) => s.open)
  if (!opened.length) return 40
  let best = 40
  let bestErr = Infinity
  for (let g = 8; g <= 96; g++) {
    let err = 0
    for (const s of opened) {
      const rel = s.left - canvasLeft - g
      let d = Infinity
      for (const p of prefix) d = Math.min(d, Math.abs(rel - p))
      err += d
    }
    if (err < bestErr) {
      bestErr = err
      best = g
    }
  }
  return best
}

function colOf(x, res) {
  const rel = x - canvasLeft - res.gutter
  const { prefix } = res
  for (let i = 0; i < prefix.length - 1; i++) if (rel >= prefix[i] && rel < prefix[i + 1]) return i
  return -1
}

function report(label, res, perms) {
  const { samples } = res
  console.log(`\n[${label}]  gutter=${res.gutter}  perms=${JSON.stringify(perms)}`)
  const byCol = new Map()
  for (const s of samples) {
    const c = colOf(s.x, res)
    if (c < 0) continue
    if (!byCol.has(c)) byCol.set(c, { open: 0, shut: 0, texts: new Set() })
    const e = byCol.get(c)
    s.open ? e.open++ : e.shut++
    if (s.open) e.texts.add(s.text)
  }
  console.log('  col | 权限              | 开编辑框/尝试 | 编辑框里载入的单元素文本')
  for (const [c, e] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`   ${String(c).padStart(2)} | ${(perms[c] || '?').padEnd(17)} | ${String(e.open + '/' + (e.open + e.shut)).padEnd(13)} | ${[...e.texts].join(',')}`)
  }
}

await send('Page.enable')
await send('Runtime.enable')
let canvasLeft = 0
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:5175/#/login' })
await sleep(4000)

// A：U5 陈涛 —— 只命中系统赋值列 seq 的只读
if (!(await openAs('U5', null))) process.exit(1)
let snap = await js(SNAP)
let box = await js(`(() => { const r = document.querySelector('.univer-host canvas').getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width } })()`)
canvasLeft = Math.round(box.left)
console.log('canvas', JSON.stringify(box), 'sync()=', snap.rows)
const y = Math.round(box.top + 20 + 22 + 11)
const from = canvasLeft + 45
report('A · U5 基线', await sweep(y, from, canvasLeft + 720, 22, snap.widths), snap.perms)

// B：U8 孙悦 —— 用户级规则 itemName=read（种子数据里的「给指定用户设只读」）
await openAs('U8', null) || process.exit(2)
snap = await js(SNAP)
report('B · U8 用户级 itemName=read', await sweep(y, from, canvasLeft + 720, 22, snap.widths), snap.perms)

await openAs('U5', `(() => {
  const db = JSON.parse(localStorage.getItem('zn-tb-db-v2'))
  db.form_field_permission = db.form_field_permission.filter(p => !(p.fieldKey === 'planNum' && p.targetId === 'U5'))
  db.form_field_permission.push({ permId: 'PM-PROBE', templateId: 'T1', fieldKey: 'planNum', targetType: 4, targetId: 'U5', permType: 'read', note: '探针新增', delFlag: 0, createOrgId: 'O1', createUserId: 'U5', createTime: '2026-11-16 00:00:00', updateTime: '2026-11-16 00:00:00' })
  localStorage.setItem('zn-tb-db-v2', JSON.stringify(db))
  return db.form_field_permission.filter(p => p.targetId === 'U5' && p.delFlag === 0).length
})()`)
snap = await js(SNAP)
report('C · U5 新规则 planNum=read', await sweep(y, from, canvasLeft + 720, 22, snap.widths), snap.perms)

// D：真键入 —— 被拦列写不进、可编辑列照常
const resC = await sweep(y, from, canvasLeft + 720, 22, snap.widths)
const shut = resC.samples.find((s) => !s.open && colOf(s.x, resC) >= 0)
const open = resC.samples.find((s) => s.open)
const before = (await js(SNAP)).rows
if (shut) {
  await dblclick(shut.x, y)
  const st = await js(EDITOR)
  await typeText('999')
  await press('Enter')
  await sleep(500)
  console.log('\nD 只读列 x=' + shut.x + ' col=' + colOf(shut.x, resC) + ' 编辑器open=' + st.open + ' → sync()=' + (await js(SNAP)).rows)
}
if (open) {
  await dblclick(open.x, y)
  await typeText('7')
  await press('Enter')
  await sleep(500)
  console.log('D 可编辑列 x=' + open.x + ' col=' + colOf(open.x, resC) + ' 键入 7 → 前=' + before + '\n                                  后=' + (await js(SNAP)).rows)
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
await (await import('node:fs')).promises.writeFile('.tmp/ro-sweep.png', Buffer.from(shot.data, 'base64'))
console.log('\nERRORS:', errors.length ? [...new Set(errors)].slice(0, 8).join('\n') : '(none)')
ws.close()
process.exit(0)
