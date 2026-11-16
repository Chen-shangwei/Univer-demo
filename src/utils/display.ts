/**
 * 展示层口径：状态、权限档位到 el-tag 档位的映射。
 * 只做视觉换算，不触碰 src/system 下的业务判定，
 * 因此 3.6/3.7/3.8 各处出现同一个状态时颜色口径一致。
 */

export type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger'

/** 填报记录状态（枚举值与中文口径都能查到） */
const TAG_MAP: Record<string, TagType> = {
  none: 'info',
  draft: 'warning',
  submitted: 'primary',
  reject: 'danger',
  rejected: 'danger',
  pass: 'success',
  approved: 'success',
  未填报: 'info',
  草稿: 'warning',
  待审核: 'primary',
  已驳回: 'danger',
  已归档: 'success',
}

export const tagTypeOf = (status: string): TagType => TAG_MAP[status] ?? 'info'

/** 10.2 表 31 的权限档位 */
export const LEVEL_TAG: Record<string, TagType> = {
  编辑: 'success',
  查看: 'info',
  只读: 'info',
  不可: 'warning',
}

/** 任务状态 0~3 */
export const TASK_TAG: TagType[] = ['info', 'success', 'danger', 'primary']
