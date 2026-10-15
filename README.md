# omp-todo-more

English | [简体中文](README.zh-CN.md)

A rich Todo plugin for OMP. It replaces the native `todo` while keeping
title-based addressing, phase progress, reminders, planning checks and
`task:*` subagent behavior; the list carries a goal and an explanation per item.

## Install and enable

```sh
omp install https://github.com/oh-my-omp/omp-todo-more
```

The plugin entry is the package-root `index.ts`, declared by `omp.extensions`
in `package.json`. Turn off the native Todo in the OMP config before using the
plugin:

```yaml
todo:
  enabled: false
```

Do not load the old local `extensions/todo-more/` at the same time. Existing
omp-config machines retire the old modules through the gated retirement in
omp-config's updater, after the independent plugin is installed and verified
at runtime.

For local development use `omp plugin link <package-directory>`. Runtime
verification should use a source copy under `/tmp` with no development
`node_modules`; type-checking cannot prove that the OMP binary can load the
host imports.

## Tool and state

The model sends one Todo document per call. On providers supporting OMP's
custom-tool wire, `todo` exposes a Lark grammar just like the built-in `edit`;
other providers send `{input: "<the same document>"}`. The tool accepts only
this document input.

Initialize all phases and tasks together:

```text
*** Begin Todo
INIT "Deliver streaming todos" "The real user path passes" "Implementation and runtime verification are complete"
PHASE "Implementation"
ADD "Implement the parser" "Accept complete documents and preserve exact task titles"
ADD "Render the preview" "Display generated commands without changing saved state"
PHASE "Verification"
ADD "Exercise the installed tool" "Check the registered tool and the persisted result"
*** End Todo
```

Combine related edits in one subsequent call rather than calling for each
task or field:

```text
*** Begin Todo
DONE "Implement the parser"
START "Render the preview"
EXPLAIN "Render the preview" "Check both the ANSI and native preview surfaces"
PHASE "Verification"
ADD "Inspect task history" "Confirm that the accepted batch retains its operation history"
*** End Todo
```

Commands are uppercase and occupy one physical line. String arguments use
JSON quoting; `\"`, `\\` and `\n` preserve quotes, backslashes and multiline
text without trimming the complete title.

| Command | Meaning |
| --- | --- |
| `INIT "objective" "measure" "doneWhen"` | Replace the list and goal; first command only, at most once. Following `PHASE`/`ADD` lines form one initialization. |
| `PHASE "name"` followed by `ADD "title" "explanation"` | Add one or more tasks to that phase, creating it if needed. Outside initialization, every append block requires its own `PHASE`. |
| `GOAL "objective" "measure" "doneWhen"` | Replace all goal fields on an existing nonempty list, without changing task statuses. |
| `START "title"` | Select the task to work on. |
| `EXPLAIN "title" "explanation"` | Replace that task's explanation. |
| `DONE target`, `DROP target`, `RM target` | Complete, abandon or remove the quoted task, `PHASE "name"`, or `ALL`. |
| `BLOCK target ["reason"]`, `UNBLOCK target` | Block or unblock the quoted task or `PHASE "name"`; neither accepts `ALL`. |
| `VIEW` | Read the list; it must be the document's sole command. |

`PHASE` scopes only its immediately following `ADD` lines, never subsequent
status selectors. Every phase block needs at least one `ADD`. An `INIT`
whose first `ADD` has no `PHASE` uses `"Tasks"`. Titles and initialization
phase names must be unique. Empty selectors are rejected; `"ALL"` names a
task, whereas bare `ALL` selects the whole list.

As arguments stream, ANSI and native tool cards show the generated goal,
commands, explanations and unfinished line as **preview only**. Partial
input, canceled generation and an incomplete document never change Todo
state. Execution reads the current branch, validates the complete document
and applies logical operations in order to a working copy. One invalid
command rejects the entire batch; a successful changing batch appends one
`mouriya.omp.todo-more` snapshot and updates the host TodoTracker projection
once. Normalization happens after each logical task operation, not only at
the end. `GOAL` and `VIEW` do not normalize task status.

An empty list carries no goal. When an imported list lacks a goal, put
`GOAL` before other mutations. `RM ALL` or removing the last task drops the
goal immediately within the working copy; later additions cannot inherit it.
Use `INIT` to create the next list.

The current session branch is the only authority. Results retain
`todoMore: true`, `details.more`, native-compatible phases, storage and
completion transitions. `details.op` identifies the logical operation or
`"batch"`; `details.operations` lists operation names in order. Successful
mutations also return `details.changes`, the ordered structured operations
actually applied, for history consumers. A phase's additions form one
`append` change; all initialization phases form one `init` change.
Rejected calls and `VIEW` do not emit accepted changes.

The reader joins the host's `user_todo_edit` entries and old native tool
results by title: known titles keep their explanation, new titles lack one. A
native empty snapshot breaks inheritance of any earlier goal/explanation. The
plugin's own marked tool results are not read again as state records. The
existing reader ignores malformed records; this migration does not change that
compatibility behavior.

A synchronous append confirms that the current branch accepted the record, not
that it was durably written to disk. File writes, flushes and disk-failure
handling belong to the OMP SessionManager lifecycle; resuming after an exit is
how the normal persistence path is verified.

## Subagents and reminders

Every session holds its own list. In `before_agent_start` the plugin restores
the todo tool that the host strips from `task:high/mid/low/free`;
tool-restricted sessions get it through the host tool slot. Stop reminders,
mid-run nudges, the eager prelude, goal-mode context and request-only user
reminders are kept. A human interruption is not resumed automatically.

The planning guard reads the current branch when an edit actually executes,
not when the tool batch is pre-checked; an `init`/edit or `rm`/edit in the
same batch is therefore checked against the list at execution time.

## Read-only review protocol

The same session's `ExtensionAPI.events` offers the synchronous channel
`omp-todo-more:read`. A request is `{agentId, reply(value)}`; the owner reads
that agent's current branch and replies before `emit` returns:

```ts
type TodoMoreReadResponse =
  | {
      kind: "ok";
      goal: { objective: string; measure: string; doneWhen: string } | null;
      openItems: readonly { phase: string; title: string; explanation: string | null }[];
    }
  | { kind: "unavailable" };
```

Only pending/in_progress items are returned; a missing goal or explanation is
`null`. No session or a read error is `unavailable`, not an empty Todo. The
channel writes no state, offers no watch, installs nothing into Tern and
exports no internal reader. The listener is removed on the instance's
`session_shutdown`; subagents use their own bus.

A completion judge should request once before building the model prompt and
again after the model returns, before checking `openItems`; when unavailable
it keeps its warning + fail-open behavior. The ctx task-log consumer reads
successful `details.changes` to record each accepted logical operation and
its explicit goal replacement. The log is historical, not the current Todo.

## Editing and commits

The GUI has only two edit intents, `set_goal` and `explain` by complete title;
it does not generate model tool calls. Saving re-reads the target session's current
branch and overwrites only the target field; the task's latest
phase/status/blocker/order and every other field are kept. An empty list
rejects edits, a missing goal must be set first, and a deleted or renamed task
is not brought back by an old draft.

Tool mutations and GUI saves both call `commitTodoState`. After the
synchronous append it re-reads the same branch to confirm acceptance, then
updates the host projection. Failures distinguish branch acceptance from
projection: a projection failure does not roll back the accepted record; the
tool returns an error with the latest authoritative details, and the GUI keeps
the draft and the error. Equal values append no snapshot; re-projecting can
repair an earlier partial projection failure. `view` stays a pure read.

## Native display and editing

In Tern, Todo More replaces the built-in bottom Todo progress display. Its
compact card shows a progress ring, the current task and the closed/total
count; completed and abandoned tasks count as closed. Click the card to open
an upward, scrollable popover containing Objective, Measure, Done when, every
phase/task, all five statuses, explanations and blockers. Goal fields are not
fake tasks and do not affect progress. A blocked task shows both its
explanation and blocker.

Native tool cards and reminder notices use the same goal fields and native
checklist presentation. Historical tool cards render their own `details.more`;
reminders keep the snapshot from their own event. Neither becomes an edit
source or changes when the current list is edited.

In Tern, `/todo` and `/todo edit` open the rich `/todo-more` editor;
`/todo expand` and `/todo collapse` control the replacement progress card.
Other host `/todo` subcommands remain available, and their task changes are
joined by title as described above. Plain ANSI OMP keeps the host `/todo`
command and HUD; the replacement widget emits no ANSI rows, so it adds no
duplicate progress display.

`/todo-more` opens the current session's editing overlay in OMP or Tern.
Tab/Shift+Tab or the up/down arrows select an action, the current action is
marked in the accent color, and Enter opens it. When a task is deleted, the
selection settles on the current list. The progress popover's edit button
opens this same editor rather than another editing implementation.

`Edit goal` uses three labeled host Editor drafts; Tab/Shift+Tab switches the
current field. Tern describes only the current field as a live editor at a
time; the other fields stay visible and can be clicked to activate, and
editing and undo are handled by the existing Editor/FormField. `Edit
explanation` opens a multiline Editor for the target title. Plain Enter keeps
the newline, Ctrl+Enter or Save saves, Escape/Cancel discards the draft;
closing the panel commits nothing. A save error keeps the draft and shows the
reason; a successful save re-reads the current branch. Editing itself starts
no model turn.

The progress widget follows the session being viewed, including focused task
subagents and nested subagents, and reads that session's current branch on
each native render. Session switch, branch and tree transitions reinstall
the widget. The editor is bound to the session it was opened in: changing
the viewed session, switching, branching, navigating the tree or shutting
down cancels its old draft. Save checks that owner again and appends to the
target session's own branch before updating its host projection. An empty
list has no progress card. Without an interactive UI, the edit command
reports that it is unavailable and leaves the Todo unchanged.

## Tern asset lifecycle

The package ships `tern/plugin.toml`, `todo-more.css` and `window.luau`.
OMP native components provide the live progress card, full checklist and
editing; the window entry satisfies the stylesheet-plugin manifest contract
and does not create a second state store or editor. The stylesheet hides
only the host dock's `omp.hud.todo` and styles Todo More's card, upward
popover and rich fields with Tern's theme tokens. The host Todo projection
is still maintained for `/todo`, session restoration and other consumers;
neither OMP nor Tern needs to be patched.

The Tern stylesheet and OMP extension must be enabled together. The
stylesheet hides the native HUD while the Tern plugin is enabled, including
in an OMP session that did not load this extension. Disabling or removing
the Tern plugin restores the original HUD. Tern's supported CSS has no
`:has()` conditional, so there is no automatic native-HUD fallback when the
OMP extension is absent.

The async factory first awaits `initializeTernPlugin`, then registers the tool
and UI. The asset directory is located relative to the module; the owner is
asked through the real `tern plugin dir/list/install --json`, and the catalog
and the three-file normal copy are checked. A matching ready/disabled copy is
not reinstalled; an update uses `install --force`, then re-checks identity,
version, destination, catalog and file contents. A user's disabled setting is
kept; nothing is unlinked or enabled automatically.

This module graph has a single initialization promise that prepared child
factories reuse, while every session still registers its own tool, hooks and
read listener. When Tern is not on PATH, ANSI OMP may use the plugin, which
does not mean the GUI is accepted. When Tern is present, a CLI, parse, install,
linked-conflict or re-check failure rejects factory initialization; a machine
with native todo turned off then gets no tool from this plugin, so a warning
must not be taken as success. An on-disk install check also does not replace
verifying the CSS and edit paths in a real window.

For headless native UI verification, Tern's `serve` does not automatically
load installed plugins. Load the bundled stylesheet into that isolated test
document through its control endpoint, or use a real Tern window; verify
the actual progress card, popover and editor, not just the plugin catalog.

## Development

```sh
bun install
bun run format
bun run check
bun test
```

Host peer dependencies use `*` and development dependencies use `latest`; no
bundler or build output is needed. Runtime state, credentials, development
dependencies and lock files are not part of the shipped package.
