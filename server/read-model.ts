/**
 * M3 扩面：把审核工作台 / 汇总看板所需的「列表读模型」在服务端组合好再返回，
 * 让前端视图不再回查本地 db.form_record / db.form_task 做 join。
 *
 * 只读组合，复用逻辑层 taskViewsFor / summaryView / canAuditNode，不改动业务判定本身。
 */
import { db, taskViewsFor, canAuditNode, orgById, userById, summaryView } from './context'
import type { ID, SummaryFilter, SysUser, TaskView } from './context'

/** 审核待办行：TaskView + 定位到待审记录的 recordId / submitTime（前端「审核」按钮要用） */
export interface AuditTodoRow extends TaskView {
  recordId: ID | null
  submitTime: string
}

/** 全部在审 / 已办记录行：脱离本地 db 的最小可渲染集 */
export interface AuditRecordRow {
  recordId: ID
  taskId: ID
  taskName: string
  orgId: ID
  orgName: string
  recordStatus: string
  nodeName: string
  submitCount: number
  submitTime: string
  /** 该记录是否停在「本人负责节点」的待审核状态（前端「仅看我负责节点」筛选用） */
  mineTodo: boolean
}

export interface AuditListResult {
  todos: AuditTodoRow[]
  records: AuditRecordRow[]
  logs: { logId: string; operType: string; content: string; operTime: string; orgName: string }[]
}

/** 接口 22 扩展：审核工作台一次返回「我的待办 + 全部记录 + 近期审核留痕」 */
export function auditList(user: SysUser): AuditListResult {
  const views = taskViewsFor(user)

  const todos: AuditTodoRow[] = views
    .filter((v) => v.todo)
    .map((v) => {
      const rec = db.form_record.find(
        (r) => r.taskId === v.taskId && r.orgId === v.orgId && r.recordStatus === 'submitted' && r.currentNode === v.currentNode && r.delFlag === 0,
      )
      return { ...v, recordId: rec?.recordId ?? null, submitTime: rec?.submitTime ?? '' }
    })

  const records: AuditRecordRow[] = db.form_record
    .filter((r) => r.delFlag === 0 && r.recordStatus !== 'draft')
    .map((r) => {
      const task = db.form_task.find((t) => t.taskId === r.taskId)
      const mineTodo = !!task && r.recordStatus === 'submitted' && canAuditNode(user, task, r.currentNode)
      const nodeName = !task
        ? '—'
        : r.recordStatus !== 'submitted'
          ? task.auditType === 0
            ? '免审核'
            : '已结束'
          : task.auditNodes.find((n) => n.seq === r.currentNode)?.nodeName ?? `节点 ${r.currentNode}`
      return {
        recordId: r.recordId,
        taskId: r.taskId,
        taskName: task?.taskName ?? r.taskId,
        orgId: r.orgId,
        orgName: orgById(r.orgId)?.orgName ?? r.orgId,
        recordStatus: r.recordStatus,
        nodeName,
        submitCount: r.submitCount,
        submitTime: r.submitTime ?? '',
        mineTodo,
      }
    })
    .sort((a, b) => b.submitTime.localeCompare(a.submitTime))

  const logs = db.form_oper_log
    .filter((l) => l.operType === '审核操作' || l.operType === '管理员撤回')
    .slice(0, 8)
    .map((l) => ({
      logId: l.logId,
      operType: l.operType,
      content: l.content,
      operTime: l.operTime,
      orgName: orgById(l.orgId)?.orgName ?? '',
    }))

  return { todos, records, logs }
}

/** 供 FillListView / 汇总筛选复用的任务视图列表 */
export function myTaskViews(user: SysUser): TaskView[] {
  return taskViewsFor(user)
}

/** 看板用户信息（前端展示「以谁的字段权限口径」） */
export function reporterName(user: SysUser): string {
  return userById(user.userId)?.realName ?? user.realName
}

export interface SummaryBoardResult {
  task: ReturnType<typeof summaryView>['task']
  orgIds: ID[]
  progress: ReturnType<typeof summaryView>['progress']
  columns: ReturnType<typeof summaryView>['table']['columns']
  total: number
  pages: number
  list: ReturnType<typeof summaryView>['table']['rows']
}

/** 接口 23/24 合并：一次返回宽表分页 + 进度看板 + 列口径 + 任务信息（对齐前端 api.summary.page 形状） */
export function summaryBoard(user: SysUser, taskId: ID, filter: SummaryFilter, pageNum = 1, pageSize = 20): SummaryBoardResult {
  const view = summaryView(user, taskId, filter)
  const rows = view.table.rows
  const size = Math.min(Math.max(pageSize, 1), 200)
  const page = Math.max(pageNum, 1)
  return {
    task: view.task,
    orgIds: view.orgIds,
    progress: view.progress,
    columns: view.table.columns,
    total: rows.length,
    pages: Math.ceil(rows.length / size) || 1,
    list: rows.slice((page - 1) * size, (page - 1) * size + size),
  }
}
