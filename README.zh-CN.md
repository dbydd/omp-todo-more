# omp-todo-more

[English](README.md) | 简体中文

OMP 的富信息 Todo 插件。替代原生 `todo`，保留标题寻址、阶段进度、提醒、planning 检查与 `task:*` 子会话行为；列表包含 goal 和每项 explanation。

## 安装与启用

```sh
omp install https://github.com/oh-my-omp/omp-todo-more
```

插件入口是包根 `index.ts`，由 `package.json` 的 `omp.extensions` 声明。使用插件前在 OMP 配置中关闭原生 Todo：

```yaml
todo:
  enabled: false
```

不要同时加载旧的本地 `extensions/todo-more/`。已在用 omp-config 的机器，旧模块在独立插件安装并通过运行验证后，由 omp-config 更新器执行受门禁保护的退休。

本地开发使用 `omp plugin link <package-directory>`。运行验证应使用 `/tmp` 下无开发 `node_modules` 的源码副本；类型检查不能证明 OMP 二进制能加载 host imports。

## 工具与状态

模型每次调用发送一份 Todo 文档。支持 OMP custom-tool wire 的 provider 使用与内置 `edit` 相同的 Lark grammar 接口；其他 provider 发送 `{input: "<同一份文档>"}`。工具只接受这一个文档输入。

一次初始化全部阶段和任务：

```text
*** Begin Todo
INIT "交付流式 Todo" "真实用户路径通过" "实现与运行验证完成"
PHASE "实现"
ADD "实现文档解析" "接受完整文档并保留任务标题的精确身份"
ADD "显示流式预览" "显示生成中的命令，但不改变已保存状态"
PHASE "验证"
ADD "验证已安装工具" "检查注册工具与持久化结果"
*** End Todo
```

后续一次调用合并相关编辑，不按任务或字段拆调用：

```text
*** Begin Todo
DONE "实现文档解析"
START "显示流式预览"
EXPLAIN "显示流式预览" "检查 ANSI 与 native 两个预览入口"
PHASE "验证"
ADD "检查任务历史" "确认接受的批次保留完整操作记录"
*** End Todo
```

命令使用大写，每条命令占一个物理行。字符串按 JSON 规则加引号；`\"`、`\\`、`\n` 分别保留引号、反斜杠和多行正文，不 trim 完整 title。

| 命令 | 语义 |
| --- | --- |
| `INIT "objective" "measure" "doneWhen"` | 替换列表与 goal；只能作为第一条命令且至多一次。紧随的 `PHASE`/`ADD` 合成一次初始化。 |
| `PHASE "name"` 后跟 `ADD "title" "explanation"` | 向该阶段增加一个或多个任务，阶段不存在时创建。初始化之外，每个追加块都必须有自己的 `PHASE`。 |
| `GOAL "objective" "measure" "doneWhen"` | 在非空列表完整替换三个 goal 字段，不改变任务状态。 |
| `START "title"` | 选择当前执行的任务。 |
| `EXPLAIN "title" "explanation"` | 替换目标任务的解释。 |
| `DONE target`、`DROP target`、`RM target` | 完成、放弃或删除带引号的任务、`PHASE "name"` 或 `ALL`。 |
| `BLOCK target ["reason"]`、`UNBLOCK target` | 阻塞或解除阻塞带引号的任务或 `PHASE "name"`；二者均不接受 `ALL`。 |
| `VIEW` | 只读列表，必须是文档中唯一的命令。 |

`PHASE` 只作用于紧随的 `ADD`，不限定后续状态命令；每个阶段块至少有一个 `ADD`。`INIT` 后第一个 `ADD` 没有 `PHASE` 时使用 `"Tasks"`。任务 title 与初始化中的 phase 名必须唯一。空 selector 会被拒绝；`"ALL"` 是任务标题，裸 `ALL` 才选择整个列表。

参数生成期间，ANSI 与 native 工具卡片实时显示 goal、命令、explanation 和未完成行，并明确标记为**未提交预览**。部分输入、取消生成或未完成文档都不改变 Todo。执行读取当前分支，验证完整文档并在 working copy 上按顺序应用逻辑操作；任何一条命令无效，整批拒绝。成功且改变状态的批次只追加一条 `mouriya.omp.todo-more` snapshot，并更新一次宿主 TodoTracker 投影。任务操作逐条 normalize，不只在批次末尾 normalize；`GOAL` 与 `VIEW` 不 normalize 状态。

空列表不携带 goal。导入列表缺 goal 时，必须先写 `GOAL` 再写其他 mutation。`RM ALL` 或删除最后一项后，working copy 立即丢弃 goal，后续追加不能继承它；创建下一份列表应使用 `INIT`。

当前会话分支是唯一权威。结果保留 `todoMore: true`、`details.more`、原生兼容 phases、storage 和完成 transitions。`details.op` 为逻辑操作名或 `"batch"`，`details.operations` 按顺序列出操作名。成功 mutation 还返回 `details.changes`，承载实际应用的有序结构化操作，供历史记录消费者使用：同一阶段的新增项是一条 `append` change，初始化全部阶段是一条 `init` change。失败与 `VIEW` 不产生 accepted changes。

reader 按标题联结宿主 `user_todo_edit` 与旧原生工具结果：已知标题保留 explanation，新标题缺 explanation；原生空 snapshot 中断此前 goal/explanation 的继承。自有 marked 工具结果不重复作为状态记录读取。现有 reader 忽略格式无效的记录；本次迁移不更改这项兼容语义。

同步追加确认的是当前分支接受记录，不是磁盘 durable-write 确认。文件写入、flush 和磁盘失败处理属于 OMP SessionManager 生命周期；退出后 resume 是正常持久化路径的验证方式。

## 子会话与提醒

每个会话独立持有列表。插件在 `before_agent_start` 恢复 `task:high/mid/low/free` 被宿主剥离的 todo；tool-restricted 会话通过宿主工具槽安装。保留 stop reminder、mid-run nudge、eager prelude、goal-mode context 与 request-only 用户提醒。人工中断不自动恢复。

planning guard 在真正执行 edit 时读取当前分支，不在工具批次预检时判断；同批次 init/edit 与 rm/edit 因此按执行时列表检查。

## 只读 review 协议

同一会话的 `ExtensionAPI.events` 提供同步 channel `omp-todo-more:read`。请求为 `{agentId, reply(value)}`，owner 从该 agent 当前分支读取并在 emit 返回前回复：

```ts
type TodoMoreReadResponse =
  | {
      kind: "ok";
      goal: { objective: string; measure: string; doneWhen: string } | null;
      openItems: readonly { phase: string; title: string; explanation: string | null }[];
    }
  | { kind: "unavailable" };
```

只返回 pending/in_progress 项；missing goal/explanation 为 null。无会话或读取异常是 unavailable，不是空 Todo。通道不写状态、不提供 watch，不安装 Tern、不导出内部 reader。监听器在实例 session_shutdown 取消，子会话使用自己的 bus。

completion judge 应在构造模型 prompt 前请求一次，并在模型返回后、检查 openItems 前再次请求；不可用时沿用 warning + fail-open。ctx task-log 消费者从成功的 `details.changes` 记录每条已接受逻辑操作及其显式 goal 替换；日志是历史记录，不是当前 Todo 状态。

## 编辑与提交

GUI 编辑意图只有 `set_goal` 和按完整 title 的 `explain`，编辑本身不生成模型工具调用。保存重新读取对应 session 的当前分支：只覆盖目标字段，任务的最新 phase/status/blocker/order 与其他字段全部保留。空列表拒绝编辑，missing goal 必须先设置；删除或改名的任务不因旧草稿恢复。

工具 mutation 与 GUI 保存共同调用 `commitTodoState`。同步追加后重读同一分支确认接受，再更新宿主投影。失败区分 branch acceptance 与 projection：后者不回滚已接受记录，工具返回 error 与最新权威 details，GUI 保留草稿和错误。相同值不追加 snapshot；重投影允许修复此前的部分 projection failure。`view` 保持纯读。

## 原生展示与编辑

Todo More 在 Tern 顶替原生底部 Todo 进度。紧凑卡片显示进度环、当前任务和 closed/total；completed 与 abandoned 都计为 closed。点击卡片向上展开可滚动内容，显示 Objective、Measure、Done when、全部 phase/task、五种 status、explanation 和 blocker。goal 不伪装成任务，不影响进度；blocked 任务同时保留解释与阻塞原因。

原生工具卡片和提醒使用同一套 goal 字段与原生 checklist 展示。历史工具卡片使用当次 `details.more`，提醒保留其发生时的快照；两者不成为编辑源，也不随当前列表编辑而改变。

Tern 中的 `/todo` 与 `/todo edit` 打开富信息 `/todo-more` 编辑器，`/todo expand` 与 `/todo collapse` 控制替代进度卡片。其他宿主 `/todo` 子命令继续可用，任务变更按前述规则按标题联结。普通 ANSI OMP 保留宿主 `/todo` 命令和 HUD；替代 widget 不输出 ANSI 行，不产生重复进度。

在 OMP/Tern 中输入 `/todo-more` 打开当前会话的编辑 overlay。Tab/Shift+Tab 或上下方向键选择动作，当前动作以 accent 标记，Enter 打开它；任务删除后选择位置按当前列表收敛。进度 popover 的编辑按钮进入同一个编辑器，不另建编辑实现。

`Edit goal` 使用三个有标签的宿主 Editor 草稿，Tab/Shift+Tab 切换当前字段。Tern 同时只把当前字段描述为 live editor，其余字段仍可见且可点击激活；编辑与 undo 由原有 Editor/FormField 处理。`Edit explanation` 打开目标标题的 multiline Editor。普通 Enter 保留换行，Ctrl+Enter 或 Save 保存，Escape/Cancel 丢弃草稿；关闭面板不提交。保存错误保留草稿并显示原因，成功重新读当前分支。编辑本身不启动模型 turn。

进度 widget 每次原生渲染读取当前查看会话（含聚焦的 task 子会话及嵌套子会话）的当前分支，在 switch/branch/tree 后重新安装；空列表不显示进度卡片。编辑 overlay 绑定打开时的 session，查看目标改变或 switch/branch/tree/shutdown 会取消旧 UI 与草稿。Save 再次核对目标，将记录追加到该 session 自己的分支，再更新其宿主投影。没有交互 UI 时编辑命令报告不可用，不改变 Todo。

## Tern 资产生命周期

包附带 `tern/plugin.toml`、`todo-more.css`、`window.luau`。实时进度卡片、完整 checklist 和编辑由 OMP native components 提供；Tern window entry 满足 stylesheet 插件的 manifest 契约，不建立第二套状态存储或编辑器。CSS 仅隐藏宿主 dock 中的 `omp.hud.todo`，并用 Tern 主题变量呈现 Todo More 卡片、向上 popover 和富字段。宿主 Todo 投影继续供 `/todo`、会话恢复及其他消费者使用，不修改 OMP 或 Tern 宿主。

Tern 样式插件必须与 OMP 扩展成套启用。Tern 插件启用期间，样式会隐藏原生 HUD，包括没有加载本 OMP 扩展的会话；禁用或移除 Tern 插件会恢复原生 HUD。Tern CSS 不支持 `:has()` 条件，不承诺 OMP 扩展缺失时自动回退原生 HUD。

async 工厂先 await `initializeTernPlugin`，然后注册工具和 UI。资产目录从模块相对路径定位；通过真正的 `tern plugin dir/list/install --json` 请求 owner，校验 catalog 与三文件 normal copy。相同 ready/disabled 副本不重新安装；需要更新时使用 `install --force`，等待后复查身份、版本、destination、catalog 和文件内容。保留用户 disabled 设置，不执行 unlink 或自动 enable。

本加载图只有一个初始化 Promise，prepared 子工厂复用它，但每个 session 仍独立注册工具、hooks 与 read listener。Tern 不在 PATH 时允许 ANSI OMP 使用，不代表 GUI 验收完成。Tern 存在时的 CLI、解析、安装、linked 冲突或复查失败会拒绝工厂初始化；原生 todo 已关闭的机器此时不会得到本插件工具，不能把 warning 当成成功。磁盘安装验收也不替代真实窗口的 CSS 和编辑路径验证。

Tern 的 headless `serve` 不自动加载已安装插件。原生 UI 验证需要通过隔离测试文档的 control endpoint 加载随包 stylesheet，或使用真实 Tern 窗口；必须核对实际进度卡片、popover 和编辑器，不能只检查 catalog。

## 开发

```sh
bun install
bun run format
bun run check
bun test
```

host peer dependencies 使用 `*`，开发依赖使用 `latest`；无需 bundler 或编译产物。运行状态、凭据、开发依赖和 lock 文件不属于交付包。
