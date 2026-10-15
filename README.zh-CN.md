# omp-todo-more

[English](README.md) | 简体中文

OMP 的富信息 Todo 插件。替代原生 `todo`，保留标题寻址、阶段进度、提醒、planning 检查与 `task:*` 子会话行为；列表包含 goal，以及每项 explanation 和模型预估耗时。

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

`todo` 操作包括 `init/start/done/rm/drop/block/unblock/append/view/explain/estimate`。任务身份是完整 title；goal 为 `{objective, measure, doneWhen}`，新增任务为 `{title, explanation, estimatedMinutes}`。模型必须对 `init` 或 `append` 创建的每一项自行估时，系统不提供默认估计。`estimatedMinutes` 必须为正整数，不允许小数，也不会自动取整；最大为 `Math.floor(Number.MAX_SAFE_INTEGER / 60_000)`，确保转换为毫秒后安全。缺失或非法估计会拒绝整次调用。空列表不携带 goal。已有列表缺 goal 时，下一次 mutation 必须提供 goal。

当前会话分支是唯一权威。改变状态的成功 mutation 追加完整 `mouriya.omp.todo-more` snapshot，并更新宿主 TodoTracker 投影。结果保留 `todoMore: true`、`details.more`、原生兼容 phases、storage 和完成 transitions。

reader 按标题联结宿主 `user_todo_edit` 与旧原生工具结果：已知标题保留 explanation 和计时元数据，新标题缺少两者；原生空 snapshot 中断此前 goal、explanation 和计时元数据的继承。自有 marked 工具结果不重复作为状态记录读取。现有 reader 忽略格式无效的记录；本次迁移不更改这项兼容语义。

同步追加确认的是当前分支接受记录，不是磁盘 durable-write 确认。文件写入、flush 和磁盘失败处理属于 OMP SessionManager 生命周期；退出后 resume 是正常持久化路径的验证方式。

### 估时与超时警告

`estimate {task, estimatedMinutes}` 用于补齐或修订任务的总时间预算。旧 snapshot 和原生入口创建的项为 `time.kind: "missing"`；模型必须显式估时，系统不倒推未知历史耗时。首次补估计时，已经 active 的项从这次 estimate 调用开始计时。

|任务变化|计时行为|
|---|---|
|进入 `in_progress`|开始一个墙钟区间。|
|离开 `in_progress`，变为 pending、blocked 或关闭状态|累计当前区间并暂停。|
|恢复或显式重新开始同一项|保留累计时间，开始下一个区间。|
|重复 `start`、执行 `view`、编辑 explanation/goal|保留原有计时。|
|修订估计|保留累计时间及正在运行的区间；数值变化会创建新的预算身份，同值是 no-op。|
|删除后重新创建|新预算不继承被删除项的耗时。|

只要持久状态仍为 `in_progress`，会话 idle 或进程停止期间也继续累计墙钟时间；这不是 CPU 时间统计。原生状态变化使用对应 session entry 的 timestamp 结算。

插件只保留距离最近的 active 预算 deadline 的一个单次 timeout；todo 相关 journal 写入或 session/branch 变化时重新调度，不进行周期轮询，也不在 end hook 检查 deadline。原生 `/todo`、延后持久化的 native 工具结果以及已接受的 rich commit 都在 journal 写入方法上被观察，即使宿主投影失败也不会漏掉变更。普通消息不触发分支读取，collaboration 所有的 append callback 保持不变。到点 callback 重新读取当前分支后请求注入；超长等待仅按平台 timeout 上限分段。

每个超时 active 预算在正常投递路径收到一次系统警告。修订后的新预算也有一次警告机会；如果保留的累计时间已经超过新预算，会再次告警。排队消息只是投递意图；实际 `mouriya.omp.todo-more.overtime` custom-message entry 才是通知事实，普通 compaction 保留分支 journal 中的这些记录。警告不复制进 item snapshot，重新加载时按分支重建 timeout。

到点时，运行中的会话立即收到 aside 注入请求；宿主在下一个安全 step boundary 将警告提供给模型，不取消工具批次。检测和排队不等待 step 结束。idle 时警告立即追加到 transcript 和 context，但不启动模型 turn，因此不会撤销人工停止。shutdown 取消 timeout 并恢复被观察的 journal 方法；重新打开已超时的 active 项时重新检查。

警告指出任务、预计时间与已耗时间，并要求 agent 保持预期结果、验收标准和质量，核实超时原因、判断是否改变方针、继续推进完整任务。警告推荐与 subagent 讨论原因和方针；子会话可与 parent 沟通。插件不自动创建 agent、不改变任务 status、不降低 goal。估计是预测而非硬 deadline，agent 不得仅为掩盖超时而重建列表或抬高预算。


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

completion judge 应在构造模型 prompt 前请求一次，并在模型返回后、检查 openItems 前再次请求；不可用时沿用 warning + fail-open。ctx 日志仅从成功工具结果的 input.goal 记录历史 goal-set，不是当前 Todo 的权威。

## 编辑与提交

GUI 编辑意图只有 `set_goal` 和按完整 title 的 `explain`，不增加模型工具操作。保存重新读取对应 session 的当前分支：只覆盖目标字段，任务的最新 phase/status/blocker/order、时间预算、计时和其他字段全部保留。空列表拒绝编辑，missing goal 必须先设置；删除或改名的任务不因旧草稿恢复。

工具 mutation 与 GUI 保存共同调用 `commitTodoState`。同步追加后重读同一分支确认接受，再更新宿主投影。失败区分 branch acceptance 与 projection：后者不回滚已接受记录，工具返回 error 与最新权威 details，GUI 保留草稿和错误。相同值不追加 snapshot；重投影允许修复此前的部分 projection failure。`view` 保持纯读。

## 原生展示与编辑

Todo More 在 Tern 顶替原生底部 Todo 进度。紧凑卡片显示进度环、当前任务和 closed/total；completed 与 abandoned 都计为 closed。点击卡片向上展开可滚动内容，显示 Objective、Measure、Done when、全部 phase/task、五种 status、预估耗时、explanation 和 blocker。goal 不伪装成任务，不影响进度；blocked 任务同时保留解释与阻塞原因。

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
bunx tsc --noEmit
bun test
```

host peer dependencies 使用 `*`，开发依赖使用 `latest`；无需 bundler 或编译产物。运行状态、凭据、开发依赖和 lock 文件不属于交付包。
