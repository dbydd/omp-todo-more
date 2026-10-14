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

`todo` 操作保持为 `init/start/done/rm/drop/block/unblock/append/view/explain`。任务身份是完整 title；goal 为 `{objective, measure, doneWhen}`，新增任务为 `{title, explanation}`。空列表不携带 goal。已有列表缺 goal 时，下一次 mutation 必须提供 goal。

当前会话分支是唯一权威。改变状态的成功 mutation 追加完整 `mouriya.omp.todo-more` snapshot，并更新宿主 TodoTracker 投影。结果保留 `todoMore: true`、`details.more`、原生兼容 phases、storage 和完成 transitions。

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

completion judge 应在构造模型 prompt 前请求一次，并在模型返回后、检查 openItems 前再次请求；不可用时沿用 warning + fail-open。ctx 日志仅从成功工具结果的 input.goal 记录历史 goal-set，不是当前 Todo 的权威。

## 编辑与提交

GUI 编辑意图只有 `set_goal` 和按完整 title 的 `explain`，不增加模型工具操作。保存重新读取对应 session 的当前分支：只覆盖目标字段，任务的最新 phase/status/blocker/order 与其他字段全部保留。空列表拒绝编辑，missing goal 必须先设置；删除或改名的任务不因旧草稿恢复。

工具 mutation 与 GUI 保存共同调用 `commitTodoState`。同步追加后重读同一分支确认接受，再更新宿主投影。失败区分 branch acceptance 与 projection：后者不回滚已接受记录，工具返回 error 与最新权威 details，GUI 保留草稿和错误。相同值不追加 snapshot；重投影允许修复此前的部分 projection failure。`view` 保持纯读。

## 原生展示与编辑

在 OMP/Tern 中输入 `/todo-more` 打开当前会话的独立 overlay，不替换宿主 `/todo`。面板显示三项 goal、全部 phase/task、五种 status、explanation 和 blocker；历史工具卡片从当次 `details.more` 展示，不成为编辑源。面板中 Tab/Shift+Tab 或上下方向键选择动作，当前动作以 accent 标记，Enter 打开它；任务删除后选择位置按当前列表收敛。

`Edit goal` 使用三个有标签的宿主 Editor 草稿，Tab/Shift+Tab 切换当前字段。Tern 同时只把当前字段描述为 live editor，其余字段仍可见且可点击激活；编辑与 undo 由原有 Editor/FormField 处理。`Edit explanation` 打开目标标题的 multiline Editor。普通 Enter 保留换行，Ctrl+Enter 或 Save 保存，Escape/Cancel 丢弃草稿；关闭面板不提交。保存错误保留草稿并显示原因，成功重新读当前分支。编辑本身不启动模型 turn。

overlay 绑定打开时的 session；switch/branch/tree/shutdown 取消旧 UI 与草稿。没有交互 UI 时命令报告不可用，不改变 Todo。

## Tern 资产生命周期

包附带 `tern/plugin.toml`、`todo-more.css`、`window.luau`。交互由 OMP native components 提供；Tern window entry 仅满足 stylesheet 插件的 manifest 契约，不建立另一套编辑器或数据库。CSS 只作用于本插件的 panel/goal-editor/explanation-editor 角色。

async 工厂先 await `initializeTernPlugin`，然后注册工具和 UI。资产目录从模块相对路径定位；通过真正的 `tern plugin dir/list/install --json` 请求 owner，校验 catalog 与三文件 normal copy。相同 ready/disabled 副本不重新安装；需要更新时使用 `install --force`，等待后复查身份、版本、destination、catalog 和文件内容。保留用户 disabled 设置，不执行 unlink 或自动 enable。

本加载图只有一个初始化 Promise，prepared 子工厂复用它，但每个 session 仍独立注册工具、hooks 与 read listener。Tern 不在 PATH 时允许 ANSI OMP 使用，不代表 GUI 验收完成。Tern 存在时的 CLI、解析、安装、linked 冲突或复查失败会拒绝工厂初始化；原生 todo 已关闭的机器此时不会得到本插件工具，不能把 warning 当成成功。磁盘安装验收也不替代真实窗口的 CSS 和编辑路径验证。

## 开发

```sh
bun install
bun run format
bun run check
bun test
```

host peer dependencies 使用 `*`，开发依赖使用 `latest`；无需 bundler 或编译产物。运行状态、凭据、开发依赖和 lock 文件不属于交付包。
