# 初始模拟数据清单（Seed Inventory）

> 来源：[`src/system/seed.ts`](../src/system/seed.ts) → 由 `buildSeed()` 组装为 `Database`（18 张表）→ 由 [`src/system/db.ts`](../src/system/db.ts) 加载并持久化到 `localStorage` 键 `zn-tb-db-v2`。
>
> 特征：
> - 所有日期相对当天生成（`dayAt` / `stamp`），保证任何时候打开原型都有「进行中」任务。
> - 只有 **1 个模板 T1 / 1 个版本 V1.0**，所有字段、差异、权限、任务、记录都围绕它展开。
> - 用户密码统一 `123456`。
> - 重置入口：`db.ts` 的 `resetDemo()`，或浏览器 DevTools `localStorage.removeItem('zn-tb-db-v2')` 后刷新。

---

## 一、组织架构

### 表8 · sys_org 单位（5 个，构成一棵树）

| orgId | 名称 | 编码 | 层级 | 上级 |
|---|---|---|---|---|
| O1 | 华东建设集团 | HDJT | 1 集团 | — |
| O11 | 城投分公司 | CTFG | 2 二级 | O1 |
| O12 | 交通工程公司 | JTGC | 2 二级 | O1 |
| O13 | 数智科技公司 | SZKJ | 2 二级 | O1 |
| O111 | 城投第一项目部 | CT01 | 3 三级 | O11 |

### 表9 · sys_dept 部门（8 个，`parentId` 统一 `'0'`）

| deptId | 名称 | 所属单位 |
|---|---|---|
| D11 | 工程管理部 | O11 城投 |
| D12 | 安全环保部 | O11 城投 |
| D13 | 财务部 | O11 城投 |
| D21 | 工程管理部 | O12 交通 |
| D22 | 安全环保部 | O12 交通 |
| D31 | 研发中心 | O13 数智 |
| D32 | 财务部 | O13 数智 |
| D01 | 业务管理部 | O1 集团 |

### 表10 · sys_role 角色（5 个，对应设计书 10.2 权限矩阵）

| roleId | 名称 | roleCode | 类型 | 说明 |
|---|---|---|---|---|
| R1 | 系统管理员 | sys_admin | 管理类 | 维护组织、用户、角色与日志审计 |
| R2 | 表单管理员 | template_admin | 管理类 | 维护模板、字段、差异规则与字段权限 |
| R3 | 业务部门管理员 | biz_admin | 管理类 | 创建与下发任务、汇总导出、审核查看 |
| R4 | 填报员 | reporter | 业务类 | 按本单位视图在线填报 |
| R5 | 审核员 | auditor | 业务类 | 审核填报内容，全程只读 |

### 表11 · sys_user 用户（9 个，密码全 `123456`）

| userId | 账号 | 姓名 | 单位/部门 | 角色 | 备注 |
|---|---|---|---|---|---|
| U1 | sysadmin | 周敏 | O1 / D01 | R1 | 系统管理员 |
| U2 | admin | 张明 | O1 / D01 | R2 | 表单管理员 |
| U3 | biz | 王芳 | O1 / D01 | R3 | 建任务、下发 |
| U4 | auditor | 李强 | O1 / D01 | R5 | 审核员 |
| U5 | rep_a | 陈涛 | O11 / D11 | R4 | 填报员（城投） |
| U6 | rep_b | 刘丽 | O12 / D21 | R4 + R5 | **双角色**演示 |
| U7 | rep_c | 赵磊 | O13 / D31 | R4 | 填报员（数智） |
| U8 | rep_a2 | 孙悦 | O11 / D13 | R4 | 部门级权限 / 并发编辑演示 |
| U9 | auditor2 | 何俊 | O1 / D01 | R5 | 第二审核人 |

---

## 二、模板与字段

### 表6 · form_template 模板（1 个）

| templateId | 名称 | bizType | 版本 | 创建单位 | 状态 |
|---|---|---|---|---|---|
| T1 | 项目任务月度完成情况填报表 | 生产运营 | V1.0 | O1 | 启用 |

### 表7 · form_field 字段（21 个 = 单头 11 + 明细 10）

**单头区（header）**

| # | fieldKey | 名称 | 类型 | 必填 | 备注 |
|---|---|---|---|---|---|
| 1 | orgName | 单位名称 | text | ✅ | 系统赋值 |
| 2 | period | 填报周期 | text | ✅ | 例 `2026-11` |
| 3 | deptName | 填报部门 | text | ✅ | 系统赋值 |
| 4 | userName | 填报人 | text | ✅ | 系统赋值 |
| 5 | reportDate | 填报日期 | date | ✅ | 系统赋值 |
| 6 | contact | 联系电话 | text | 选 | 带手机号/座机正则 |
| 7 | stopWork | 本月是否停工 | radio | ✅ | 是 / 否 |
| 8 | riskFund | 安全费用提取(万元) | number | 选 | scale 2, unit 万元 |
| 9 | summary | 总体情况说明 | textarea | 选 | maxLength 500 |
| 10 | issueDesc | 重大问题描述 | richtext | 选 | toolbar simple |
| 11 | evidence | 证明材料 | upload | 选 | 5 个 / 20MB · pdf/png/jpg/docx/xlsx |

**明细区（detail，Univer 表格承载多行）**

| # | fieldKey | 名称 | 类型 | 必填 | 备注 |
|---|---|---|---|---|---|
| 12 | seq | 序号 | number | — | 系统赋值 |
| 13 | itemName | 项目名称 | text | ✅ | 明细内唯一 |
| 14 | planNum | 计划数量 | number | ✅ | |
| 15 | finishNum | 完成数量 | number | ✅ | |
| 16 | status | 完成状态 | select | ✅ | 未开始 / 进行中 / 已完成 |
| 17 | owner | 责任人 | text | 选 | |
| 18 | lastCheck | 最近检查时间 | datetime | 选 | |
| 19 | hazard | 隐患类型 | checkbox | 选 | 高处作业 / 临时用电 / 有限空间 / 起重吊装 |
| 20 | remark | 备注 | textarea | 选 | maxLength 200 |
| 21 | budgetNote | 内部预算说明 | text | 选 | 敏感字段，仅管理层可见 |

### SYSTEM_VALUES 系统赋值列（前端 read 呈现，后端写入）

`seq`, `orgName`, `userName`, `deptName`, `reportDate` 五个 fieldKey 由系统写入。

---

## 三、差异与权限规则（都挂在 T1 上）

### 表15 · form_org_diff 单位差异规则（6 条）

| orgId | fieldKey | 类型 | 效果 |
|---|---|---|---|
| O12 | owner | 1 隐藏 | 交通公司按班组作业，不设责任人 |
| O11 | remark | 2 改属性 | 备注改必填 |
| O12 | remark | 2 改属性 | 改名「困难及诉求」+ maxLength 300 |
| O13 | hazard | 2 改属性 | 隐患改必填 |
| O13 | rndRatio | 3 新增 | 研发投入占比(%) · 明细 number |
| O11 | fundSource | 3 新增 | 资金来源 · 单头 select（自营/专项债/银行贷款）|

### 表16 · form_field_permission 字段权限（共 35 条）

规则分组：

- **审核只读（R5 × 全部 21 个字段 = 21 条）**：`read`，审核场景全程只读。
- **敏感字段隔离**：
  - `budgetNote` → R4 `hidden`（DOM 中不呈现）
  - `riskFund` → R4 `read`
  - `riskFund` → O13 `hidden`（数智不报送费用）
- **跨部门协同分段填报**：
  - `riskFund` → D13 `edit`（财务部开放费用编辑）
  - `hazard` → D13 `hidden`
  - `summary` → D13 `read`
- **用户级最高优先级**：`itemName` → U8 `read`（孙悦只做财务填报）
- **系统赋值列强制只读**：`seq / orgName / deptName / userName / reportDate` → R4 `read`
- **附件例外**：`evidence` → R5 `read`（允许审核人下载查看）

> `targetType`：1 角色 / 2 部门 / 3 子单位 / 4 用户。裁决优先级见 `flow.ts`（7.2）。

---

## 四、任务与填报

### 表17 · form_task 任务（4 个，覆盖 4 种状态）

| taskId | 名称 | 状态 | 审核方式 | 审核节点 | 唯一性 |
|---|---|---|---|---|---|
| TASK-1 | `{ym}` 项目任务月度完成情况填报 | 1 进行中 | 单级 | N1 集团业务管理部审核（auditor） | 一单位一条 |
| TASK-2 | `{ym}` 安全隐患排查（明细型·免审核） | 1 进行中 | 0 免审核 | — | **可多条** |
| TASK-3 | 上月项目任务填报（已归档） | 3 已归档 | 2 多级 | N1 子单位初审（U6）→ N2 集团复审（auditor） | 一单位一条 |
| TASK-4 | 下月度填报（待开始，5 天后启动） | 0 待开始 | 单级 | N1 集团业务管理部审核（auditor） | 一单位一条 |

### 表18 · form_task_scope 下发范围（9 条）

| taskId | 覆盖单位 |
|---|---|
| TASK-1 | O11, O12, O13 |
| TASK-2 | O11, O12 |
| TASK-3 | O11, O12, O13 |
| TASK-4 | O11 |

### 表19 · form_record 填报记录（8 条，覆盖 draft/submitted/reject/pass）

| recordId | 任务 | 填报人 | 状态 | 明细行 | 备注 |
|---|---|---|---|---|---|
| RC1 | TASK-1 | U5 陈涛 | draft 草稿 | 2 | 有 budgetNote 演示 |
| RC2 | TASK-1 | U6 刘丽 | submitted 已提交 | 2 | 带 2 个附件（AT-1、AT-2）|
| RC3 | TASK-1 | U7 赵磊 | reject 已驳回 | 2 | 含 auditTrails 与审核意见 |
| RC4 | TASK-2 | U5 陈涛 | pass 通过 | 1 | 隐患排查第 1 批 |
| RC5 | TASK-2 | U5 陈涛 | pass 通过 | 1 | 第 2 批（同一单位多条记录 seq=2）|
| RC6 | TASK-2 | U6 刘丽 | submitted 已提交 | 1 | |
| RC7 | TASK-3 | U5 陈涛 | pass 通过 | 1 | 归档历史 |
| RC8 | TASK-3 | U6 刘丽 | pass 通过 | 1 | 归档历史 |

### 表21 · form_attachment 附件（2 个，挂在 RC2）

| attId | 文件名 | 大小 | 类型 | 上传人 |
|---|---|---|---|---|
| AT-1 | 桥梁加固进度影像.pdf | ≈ 1.2 MB | pdf | U6 |
| AT-2 | 监理确认单.jpg | ≈ 386 KB | jpg | U6 |

---

## 五、字典与其它（`buildSeed` 内联）

### sys_dict 基础字典（4 条）

| dictCode | 值 |
|---|---|
| BIZ_TYPE | 生产运营 / 安全环保 / 投资计划 / 科技创新 |

### 少量或空表（运行时才增长）

| 表 | 初始 | 说明 |
|---|---|---|
| form_template_version | 1 条 | T1 V1.0 版本快照（含 fields / diffs / perms 深拷贝）|
| form_oper_log | 1 条 | LOG0「任务下发」|
| form_record_data | 空 | 运行期写入 |
| export_job | 空 | 3.8 异步导出作业 |
| edit_lock | 空 | 7.5 写会话锁 |
| seq | `1000` | ID 自增发号起点 |

---

## 六、结构依赖关系

```
组织树   O1 → { O11, O12, O13 } → O111
部门     D  →  属于某个 O
用户     U  →  属于 O + D ，持有 R[]
模板     T1 →  21 字段 F
  ├─ 差异规则 DIFFS  (T1 + O + F)
  └─ 权限规则 PERMS  (T1 + F + 目标 R / D / O / U)
任务     TASK → 引用 T1 并冻结版本 V1.0
  └─ 下发范围 SCOPES → 若干 O
记录     RC → 引用 TASK + U → 归属 O / D
  └─ 附件   AT → 挂在 RC
```

**整体特征**：窄而深的样本 —— 只 1 套「模板 + 版本」，但在组织层级、角色组合、字段类型、差异规则、权限优先级、任务状态与记录状态各分支上都刻意留了演示数据。
