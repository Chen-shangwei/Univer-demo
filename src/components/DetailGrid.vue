<script setup lang="ts">
/**
 * 明细区（7.6 明细型填报）—— 用 Univer 电子表格承载多行录入。
 * 6.3 三态在表格上的落地：
 *   hidden  → 列不进入 Schema，表头与单元格都不存在（DOM 无痕迹，3.4 场景二）
 *   read    → 灰底 + 表头标注「只读」，并且不响应输入（guardReadonly）
 *   edit    → 正常可编辑
 * 拦截只是体验层：sync() 仍如实回抽网格现值，最终裁决在 8.2 的 enforceAuthority。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { CustomCommandExecutionError, ICommandService, LocaleType, Univer, UniverInstanceType, mergeLocales } from '@univerjs/core'
import type { ICellData, IRange, IWorkbookData, Workbook } from '@univerjs/core'
import zhCNDesignLocale from '@univerjs/design/locale/zh-CN'
import zhCNDocsUILocale from '@univerjs/docs-ui/locale/zh-CN'
import zhCNFormulaLocale from '@univerjs/engine-formula/locale/zh-CN'
import zhCNSheetsLocale from '@univerjs/sheets/locale/zh-CN'
import zhCNSheetsFormulaLocale from '@univerjs/sheets-formula/locale/zh-CN'
import zhCNSheetsFormulaUILocale from '@univerjs/sheets-formula-ui/locale/zh-CN'
import zhCNSheetsNumfmtUILocale from '@univerjs/sheets-numfmt-ui/locale/zh-CN'
import zhCNSheetsUILocale from '@univerjs/sheets-ui/locale/zh-CN'
import zhCNUILocale from '@univerjs/ui/locale/zh-CN'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { PasteCommand, UniverUIPlugin } from '@univerjs/ui'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { ClearSelectionAllCommand, ClearSelectionContentCommand, SetRangeValuesCommand, SheetsSelectionsService, UniverSheetsPlugin } from '@univerjs/sheets'
import { SetCellEditVisibleOperation, SetZoomRatioCommand, UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui'
import { FUniver } from '@univerjs/core/facade'
import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import { isEditable } from '../system/schema-service'
import type { FieldValue, SchemaField } from '../system/types'
import { toast } from '../utils/notify'

const props = withDefaults(
  defineProps<{
    fields: SchemaField[]
    rows: Record<string, FieldValue>[]
    /** 整表锁定：屏蔽整表交互，供审核 / 归档 / 截止视角作为真只读 */
    locked?: boolean
  }>(),
  { locked: false },
)

const WB_ID = 'detail-workbook'
const SHEET_ID = 'detail-sheet'
/** 明细预留空行数 */
const SPARE_ROWS = 8

const hostEl = shallowRef<HTMLElement | null>(null)
const univer = shallowRef<Univer | null>(null)
const workbook = shallowRef<Workbook | null>(null)
const cmdSvc = shallowRef<ICommandService | null>(null)
const univerAPI = shallowRef<FUniver | null>(null)

/* ---------------------------------------- 主题（Facade API useThemeStyle） */
const THEME_STORAGE_KEY = 'zn.tb.gridTheme'
const currentTheme = ref<string>(localStorage.getItem(THEME_STORAGE_KEY) || '')

const THEMES: { group: string; items: { label: string; value: string }[] }[] = [
  { group: '内置', items: [
    { label: '默认蓝', value: 'default' },
    { label: '蓝底合计行', value: 'default-last-row' },
  ]},
  { group: '浅色系', items: [
    { label: '浅蓝', value: 'light-blue' },
    { label: '浅绿', value: 'light-green' },
    { label: '浅橙', value: 'light-orange' },
    { label: '浅紫', value: 'light-purple' },
  ]},
  { group: '中色系', items: [
    { label: '中蓝', value: 'middle-blue' },
    { label: '中绿', value: 'middle-green' },
    { label: '中红', value: 'middle-red' },
  ]},
  { group: '深色系', items: [
    { label: '深蓝', value: 'dark-blue' },
    { label: '深绿', value: 'dark-green' },
    { label: '深橙', value: 'dark-orange' },
  ]},
]

function applyTheme(name?: string): void {
  const fWorkbook = univerAPI.value?.getActiveWorkbook()
  if (!fWorkbook) return
  const fWorksheet = fWorkbook.getActiveSheet()
  if (!fWorksheet) return
  const rowCount = props.rows.length + SPARE_ROWS + 1
  const colCount = Math.max(props.fields.length, 1)
  const fRange = fWorksheet.getRange(0, 0, rowCount, colCount)
  fRange.useThemeStyle(name || undefined)
}

watch(currentTheme, (name) => {
  localStorage.setItem(THEME_STORAGE_KEY, name)
  applyTheme(name)
})

/* ---------------------------------------- 全屏 + 缩放（保留 Univer 自带工具栏，不改外观） */
const MIN_ZOOM = 0.5
const MAX_ZOOM = 2
const fullscreen = ref(false)
const zoom = ref(1)
const zoomPct = computed(() => Math.round(zoom.value * 100))

function applyZoom(next: number) {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100))
  zoom.value = z
  // Univer 1.4 原生缩放：按 unit/subUnit 定位当前工作表
  cmdSvc.value?.executeCommand(SetZoomRatioCommand.id, { unitId: WB_ID, subUnitId: SHEET_ID, zoomRatio: z })
}
const zoomIn = () => applyZoom(zoom.value + 0.1)
const zoomOut = () => applyZoom(zoom.value - 0.1)
const zoomReset = () => applyZoom(1)

async function toggleFullscreen() {
  fullscreen.value = !fullscreen.value
  await nextTick()
  // 容器尺寸变化，Univer 的 ResizeObserver 通常会自排；广播一次 resize 作兑底
  window.dispatchEvent(new Event('resize'))
}
function onGlobalKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && fullscreen.value) void toggleFullscreen()
}
watch(fullscreen, (v) => {
  if (v) window.addEventListener('keydown', onGlobalKey)
  else window.removeEventListener('keydown', onGlobalKey)
})

/** 只读列：无 edit 权限，或值由系统赋值 */
function isRo(f: SchemaField) {
  return !isEditable(f)
}

/** 只读列的列下标 → 列名，命令级拦截按列号判定 */
function readonlyColumns(): Map<number, string> {
  const map = new Map<number, string>()
  props.fields.forEach((f, i) => {
    if (isRo(f)) map.set(i, f.fieldLabel)
  })
  return map
}

let hintAt = 0
/** 对着只读列连敲时不刷屏 */
function hintReadonly(label: string): void {
  if (Date.now() - hintAt < 2000) return
  hintAt = Date.now()
  toast('info', `「${label}」是只读列，不能在这里修改`)
}

/**
 * 只读列光靠灰底标注拦不住输入：Univer 的单元格默认可写，越权值要到 8.2 落库时
 * 才被 enforceAuthority 拒掉（抛 1007），表现就成了「能敲但存不下去」。
 * 这里在命令层补齐前端拦截，走 Univer 自己的中止通道 —— 在 beforeCommandExecuted
 * 里抛 CustomCommandExecutionError，CommandService 会静默终止本次执行：
 * 只读列上编辑框不打开、写入与清除不生效、粘贴不落格。
 * 覆盖的是 Univer 全部输入入口：双击 / 直接键入 / F2 / 公式栏 / Delete / 右键清除 / 粘贴。
 */
function guardReadonly(inst: Univer): void {
  const columns = readonlyColumns()
  if (!columns.size) return

  const injector = inst.__getInjector()
  const commandService = injector.get(ICommandService)
  const selectionService = injector.get(SheetsSelectionsService)

  const selectedRanges = (): IRange[] => selectionService.getCurrentSelections().map((s) => s.range)
  const hitLabel = (range: IRange | undefined): string | undefined => {
    if (!range) return undefined
    for (let c = range.startColumn; c <= range.endColumn; c++) {
      const label = columns.get(c)
      if (label) return label
    }
    return undefined
  }

  commandService.beforeCommandExecuted((info) => {
    const params = info.params as { visible?: boolean; range?: IRange; target?: { range?: IRange } } | undefined

    let ranges: IRange[]
    if (info.id === SetCellEditVisibleOperation.id) {
      if (params?.visible === false) return
      // 该命令只带 unitId，落点单元格取主选区 —— Univer 自身的权限校验也是这个口径
      const cell = selectionService.getCurrentLastSelectionPrimaryCell()
      ranges = cell ? [cell] : selectedRanges()
    } else if (info.id === SetRangeValuesCommand.id) {
      // 显式 range 来自编辑器提交与公式栏，缺省时是粘贴 / 填充等按选区写入的操作
      ranges = params?.range ? [params.range] : selectedRanges()
    } else if (info.id === PasteCommand.id) {
      ranges = params?.target?.range ? [params.target.range] : selectedRanges()
    } else if (info.id === ClearSelectionContentCommand.id || info.id === ClearSelectionAllCommand.id) {
      ranges = selectedRanges()
    } else {
      return
    }

    for (const range of ranges) {
      const label = hitLabel(range)
      if (!label) continue
      hintReadonly(label)
      throw new CustomCommandExecutionError(`detail-grid: 「${label}」 is readonly`)
    }
  })
}

function optionLabel(f: SchemaField, v: FieldValue): string {
  const s = String(v)
  if (s.startsWith('other:')) return s.slice(6)
  return f.config.options?.find((o) => o.value === s)?.label ?? s
}

/** 网格里显示中文标签，回抽时再映射回枚举值 */
function display(f: SchemaField, v: FieldValue): string | number {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (f.fieldType === 'select' || f.fieldType === 'radio') return optionLabel(f, v)
  if (f.fieldType === 'checkbox') return s.split(',').filter(Boolean).map((x) => optionLabel(f, x)).join('、')
  if (f.fieldType === 'number') return Number.isFinite(Number(s)) ? Number(s) : s
  if (f.fieldType === 'richtext') return s.replace(/<[^>]+>/g, '')
  return s
}

/**
 * core 的 Range.getValues() 交回的是完整 ICellData（如 { v, s }），而不是基元值；
 * 编辑后的单元格还可能以文档形式存在（{ p: { body: { dataStream } } }）。
 * 先摊平成基元，再进入业务映射，否则会抽成「[object Object]」。
 */
function cellPrimitive(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return v
  const c = v as { v?: unknown; p?: { body?: { dataStream?: string } } }
  if (c.v !== undefined && c.v !== null) return c.v
  if (c.p?.body?.dataStream) return c.p.body.dataStream.replace(/[\r\n\u0000-\u0007]/g, '')
  return null
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Univer 装了 numfmt 后会把形如 2026-11-08 的输入自动识别为日期、底层存成序列号（天数），回抽需还原 */
function serialToIso(serial: number, time: boolean): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null
  const ms = Math.round((serial - 25569) * 86400000) // 25569 = 1899-12-30 → 1970-01-01 的天数
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  return time ? `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : date
}

/**
 * 把网格里的日期形态统一成 6.4 校验要求的 yyyy-MM-dd[ HH:mm]：
 * 数字→Univer 序列号还原；否则按日期解析后补零（兼容 2026/11/8、个位数）；再不行退回原串截断。
 */
function isoDate(s: string, time: boolean): FieldValue {
  const asNum = Number(s)
  if (s !== '' && Number.isFinite(asNum)) {
    const iso = serialToIso(asNum, time)
    if (iso) return iso
  }
  const d = new Date(s.replace(/-/g, '/').replace('T', ' '))
  if (!Number.isNaN(d.getTime())) {
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    return time ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date
  }
  return time ? s.replace('T', ' ').slice(0, 16) : s.slice(0, 10)
}

function valueOf(f: SchemaField, raw: unknown): FieldValue {
  const v = cellPrimitive(raw)
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (s === '') return null
  if (f.fieldType === 'select' || f.fieldType === 'radio' || f.fieldType === 'checkbox') {
    const parts = f.fieldType === 'checkbox' ? s.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) : [s]
    const opts = f.config.options ?? []
    const mapped = parts.map((p) => opts.find((o) => o.label === p)?.value ?? opts.find((o) => o.value === p)?.value ?? p)
    if (f.fieldType !== 'checkbox') return mapped[0] ?? s
    return mapped.join(',')
  }
  if (f.fieldType === 'number') {
    const n = Number(s)
    return Number.isNaN(n) ? s : n
  }
  if (f.fieldType === 'datetime') return isoDate(s, true)
  if (f.fieldType === 'date') return isoDate(s, false)
  return s
}

function headerText(f: SchemaField) {
  const ro = isRo(f)
  const cap = f.isRequired === 1 && !ro ? ' *' : ''
  return `${f.fieldLabel}${cap}${ro ? '（只读）' : ''}`
}

/** 列宽按表头长度估算，避免再往 Schema 里塞展示型属性 */
function widthOf(f: SchemaField) {
  const base = f.fieldLabel.length * 15 + 34
  if (f.fieldType === 'textarea' || f.fieldType === 'richtext') return Math.min(320, Math.max(200, base))
  return Math.min(240, Math.max(104, base))
}

function buildSnapshot(): IWorkbookData {
  const cols = Math.max(props.fields.length, 1)
  const total = props.rows.length + SPARE_ROWS + 1
  const cellData: Record<number, Record<number, ICellData>> = {}

  const head: Record<number, ICellData> = {}
  props.fields.forEach((f, i) => {
    head[i] = {
      v: headerText(f),
      s: {
        bg: { rgb: isRo(f) ? '#eceff3' : '#dbe7fb' },
        cl: { rgb: isRo(f) ? '#6b7280' : '#1f2d3d' },
        bl: isEditable(f) ? 1 : 0,
      },
    }
  })
  cellData[0] = head

  props.rows.forEach((row, ri) => {
    const line: Record<number, ICellData> = {}
    props.fields.forEach((f, ci) => {
      const v = display(f, row[f.fieldKey] ?? null)
      if (v === '' ) return
      line[ci] = {
        v,
        s: isRo(f) ? { bg: { rgb: '#f7f8fa' }, cl: { rgb: '#9ca3af' } } : undefined,
      }
    })
    cellData[ri + 1] = line
  })

  const columnData: Record<number, { w: number }> = {}
  props.fields.forEach((f, i) => {
    columnData[i] = { w: widthOf(f) }
  })

  return {
    id: WB_ID,
    name: '明细填报',
    appVersion: '1.4.0',
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder: [SHEET_ID],
    sheets: {
      [SHEET_ID]: {
        id: SHEET_ID,
        name: '明细',
        rowCount: total,
        columnCount: cols,
        columnData,
        cellData,
        freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
      },
    },
  }
}

function init() {
  const host = hostEl.value
  if (!host || !props.fields.length) return

  // 重新初始化前清掉上一次渲染残留的 DOM
  host.textContent = ''

  const inst = new Univer({
    locale: LocaleType.ZH_CN,
    // 不注册语言包会在渲染时抛 [LocaleService]: Locale not initialized
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(
        zhCNDesignLocale,
        zhCNUILocale,
        zhCNDocsUILocale,
        zhCNSheetsLocale,
        zhCNSheetsUILocale,
        zhCNFormulaLocale,
        zhCNSheetsFormulaLocale,
        zhCNSheetsFormulaUILocale,
        zhCNSheetsNumfmtUILocale,
      ),
    },
  })
  // 顺序按官方插件模式：渲染引擎 → 公式引擎 → UI → 文档 → 表格 → 公式/格式
  inst.registerPlugin(UniverRenderEnginePlugin)
  inst.registerPlugin(UniverFormulaEnginePlugin)
  inst.registerPlugin(UniverUIPlugin, { container: host })
  inst.registerPlugin(UniverDocsPlugin)
  inst.registerPlugin(UniverDocsUIPlugin)
  inst.registerPlugin(UniverSheetsPlugin)
  inst.registerPlugin(UniverSheetsUIPlugin)
  // 单元格编辑框由 sheets-formula-ui 注入的 FormulaEditor 组件承载，
  // 缺它则只能选中不能输入，且 Univer 不报任何错
  inst.registerPlugin(UniverSheetsFormulaPlugin)
  inst.registerPlugin(UniverSheetsFormulaUIPlugin)
  inst.registerPlugin(UniverSheetsNumfmtPlugin)
  inst.registerPlugin(UniverSheetsNumfmtUIPlugin)

  univer.value = inst
  workbook.value = inst.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, buildSnapshot())
  cmdSvc.value = inst.__getInjector().get(ICommandService)
  univerAPI.value = FUniver.newAPI(inst)
  guardReadonly(inst)
  if (currentTheme.value) applyTheme(currentTheme.value)
}

/**
 * 从网格抽回业务数据。
 * 这里如实返回网格现值（含被改动过的只读列），由服务层 enforceAuthority
 * 统一以库存值 / 系统值覆盖 —— 即「后端为准」，前端改动不生效（8.2）。
 */
function sync(): Record<string, FieldValue>[] {
  const ws = workbook.value?.getSheetByIndex(0)
  if (!ws) return props.rows

  const matrix = ws.getRange(1, 0, ws.getMaxRows() - 1, props.fields.length)?.getValues() ?? []
  const out: Record<string, FieldValue>[] = []

  for (const line of matrix) {
    const obj: Record<string, FieldValue> = {}
    let touched = false
    props.fields.forEach((f, i) => {
      const v = valueOf(f, line[i])
      obj[f.fieldKey] = v
      if (isEditable(f) && v !== null && v !== '') touched = true
    })
    if (touched) out.push(obj)
  }

  return out
}

defineExpose({ sync, reload: init })

onMounted(init)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
  univerAPI.value?.dispose()
  univerAPI.value = null
  univer.value?.dispose()
  univer.value = null
  workbook.value = null
  cmdSvc.value = null
})
</script>

<template>
  <div class="dg-wrap" :class="{ 'is-fs': fullscreen }">
    <div class="dg-bar">
      <el-select v-model="currentTheme" size="small" placeholder="主题" class="dg-theme" clearable>
        <el-option label="无主题" value="" />
        <el-option-group v-for="g in THEMES" :key="g.group" :label="g.group">
          <el-option v-for="t in g.items" :key="t.value" :label="t.label" :value="t.value" />
        </el-option-group>
      </el-select>
      <span class="spacer" />
      <div class="dg-zoom">
        <el-button size="small" :disabled="zoom <= MIN_ZOOM" @click="zoomOut">－</el-button>
        <span class="dg-zoom-val">{{ zoomPct }}%</span>
        <el-button size="small" :disabled="zoom >= MAX_ZOOM" @click="zoomIn">＋</el-button>
        <el-button size="small" text :disabled="zoom === 1" @click="zoomReset">重置</el-button>
      </div>
      <el-button size="small" type="primary" plain @click="toggleFullscreen">{{ fullscreen ? '退出全屏' : '全屏' }}</el-button>
    </div>
    <div ref="hostEl" class="univer-host" :class="{ 'is-locked': locked }" />
  </div>
</template>

<style scoped>
.univer-host {
  position: relative;
  height: 360px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  overflow: hidden;
  background: #fff;
}

/* 整表只读：审核与归档视角，直接屏蔽交互 */
.is-locked :deep(*) {
  pointer-events: none !important;
  user-select: none !important;
}

/* 工具条：缩放 + 全屏（右侧） */
.dg-wrap {
  display: flex;
  flex-direction: column;
}

.dg-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.dg-zoom {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dg-zoom-val {
  min-width: 46px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-regular);
}

.dg-theme {
  width: 120px;
}

/* 全屏遮罩：z-index 1000 低于 Univer 自身弹层（~1020-1420），ribbon 下拉/右键菜单仍可弹出 */
.dg-wrap.is-fs {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: #fff;
  padding: 10px 14px 14px;
}

.dg-wrap.is-fs .univer-host {
  flex: 1;
  height: auto;
  border-radius: 0;
}
</style>
