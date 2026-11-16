import { readFileSync } from 'node:fs'

const files = {
  core: 'node_modules/@univerjs/core/lib/es/index.js',
  sheets: 'node_modules/@univerjs/sheets/lib/es/plugin-ipfwehrC.js',
  sheetsUI: 'node_modules/@univerjs/sheets-ui/lib/es/index.js',
}

for (const [name, p] of Object.entries(files)) {
  const s = readFileSync(p, 'utf8')
  const re = /createIdentifier\(\s*"([^"]+)"/g
  const found = new Map()
  let m
  while ((m = re.exec(s))) {
    // 顺带把变量名抓出来，方便认 token 语义
    const head = s.slice(Math.max(0, m.index - 90), m.index)
    const varName = (head.match(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*[^=]*$/) || [])[1] || '?'
    found.set(m[1], varName)
  }
  console.log('###', name, 'total', found.size)
  for (const [tok, vn] of found) {
    if (/command|selection|sheet-interceptor|permission/i.test(tok) || /CommandService|Selection|PermissionCheck/.test(vn)) {
      console.log('   ', JSON.stringify(tok), '<-', vn)
    }
  }
}

// 命令 id 字面量
const cmds = {
  'sheet.command.set-range-values': 'SetRangeValuesCommand',
  'sheet.operation.set-cell-edit-visible': 'SetCellEditVisibleOperation',
  'sheet.operation.set-selections': 'SetSelectionsOperation',
  'sheet.command.clear-selection-content': 'ClearSelectionContentCommand',
}
const s2 = readFileSync(files.sheets, 'utf8')
const s3 = readFileSync(files.sheetsUI, 'utf8')
for (const [id, label] of Object.entries(cmds)) {
  console.log('id', JSON.stringify(id), 'in sheets:', s2.includes('"' + id + '"'), 'in sheets-ui:', s3.includes('"' + id + '"'))
}
const mAll = readFileSync(files.sheets, 'utf8').match(/"sheet\.(command|operation|mutation)\.set-selection[s]?[^"]*"/g)
console.log('selection-ish ids:', mAll ? [...new Set(mAll)] : null)

// 直接抓几个关键变量的 token 名
for (const [file, label] of [[files.core, 'core'], [files.sheets, 'sheets']]) {
  const s = readFileSync(file, 'utf8')
  for (const v of ['ICommandService', 'SheetsSelectionsService', 'IUniverInstanceService', 'SheetPermissionCheckController', 'SheetInterceptorService']) {
    const re = new RegExp('(?:const|let|var|,)\\s*' + v + '\\s*=\\s*createIdentifier(?:<[^>]*>)?\\(\\s*"([^"]+)"', 'g')
    let mm
    while ((mm = re.exec(s))) console.log(label, v, '=>', JSON.stringify(mm[1]))
  }
}
for (const id of ['sheet.command.clear-selection-content', 'sheet.command.clear-selection-all', 'sheet.command.set-range-values', 'sheet.operation.set-cell-edit-visible', 'ui.command.paste']) {
  console.log('id', JSON.stringify(id), 'sheets:', readFileSync(files.sheets, 'utf8').includes('"' + id + '"'), 'sheets-ui:', readFileSync(files.sheetsUI, 'utf8').includes('"' + id + '"'))
}
