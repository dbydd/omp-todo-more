/**
 * todo-more: independent replacement for OMP's native todo, which the host
 * configuration must switch off (`todo.enabled: false`). Built on the native implementation:
 * the tool, its reminders and its rendering are copies of OMP code, adapted to
 * a list that carries a goal ({objective, measure, doneWhen}) and items that
 * carry a title and an explanation. Copied code is marked
 * `// @upstream <verbatim|adapted> …` … `// @upstream-end` (see
 * `src/state.ts`).
 *
 * Registers the tool `todo` (tool.ts, rendered by render.ts) and the hooks of
 * reminders.ts (stop reminder, mid-run nudge, eager prelude, goal-mode
 * context), plus `before_agent_start` to give `task:*` subagents the tool.
 * planning.ts wraps the registered `edit` execution so an empty list blocks
 * it (installed on session_start, before_agent_start and edit tool_call), and
 * appends a complete plan-check reminder to each real user message (`context`,
 * request-only; agent-attributed and synthetic messages are excluded).
 * Adds rich native tool descriptions, the session-bound `/todo-more` editor,
 * and synchronous `omp-todo-more:read` review requests. The async factory first
 * awaits Tern owner-CLI asset initialization once per module graph.
 *
 * State: the session branch is the authority (`src/state.ts`,
 * `readTodoMore`): each changing mutation appends a full snapshot entry
 * `mouriya.omp.todo-more`; host writers that bypass the tool (`/todo`,
 * finished-subagent auto-complete) append `user_todo_edit`, which the reader
 * joins by title, marking new titles as lacking an explanation. Every mutation
 * also pushes the host projection (title as content, status, blocker) into the
 * session's TodoTracker, and the result details carry the same projection, so
 * the host HUD, `/todo`, branch rehydration and eval persistence keep working.
 *
 * OMP drops `todo` from subagents that are not prewalk-armed: the executor
 * strips it at spawn and filters it out of extension-driven active-tool
 * changes (`task/executor.ts`, `isParentOwnedTool`). At every
 * `before_agent_start` of a `task:*` subagent the hook puts the tool back on
 * that session: it re-activates the registered `todo`, or, in a
 * tool-restricted session whose registry holds no extension tools, installs it
 * as a host tool. Each session owns its own list.
 *
 * Reads the agent registry and the session branch; writes session entries and
 * the TodoTracker projection. No config files. Hook failures are logged and
 * never reach omp.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { errorText } from "./src/errors.ts";
import { describeTodoCall, describeTodoResult } from "./src/native.ts";
import { registerPlanning } from "./src/planning.ts";
import { registerReminders } from "./src/reminders.ts";
import { renderTodoCall, renderTodoResult } from "./src/render.ts";
import { registerReviewApi } from "./src/review-api.ts";
import { initializeTernPlugin } from "./src/tern-plugin-install.ts";
import { DESCRIPTION, parametersSchema, runTodo } from "./src/tool.ts";
import { registerUi } from "./src/ui.ts";

const TOOL_NAME = "todo";

const TODO_AGENTS: Record<string, true> = {
	"task:high": true,
	"task:mid": true,
	"task:low": true,
	"task:free": true,
};

/** Fields shared by the registered tool and the host-tool install, matching the native tool's. */
const TOOL_FIELDS = {
	name: TOOL_NAME,
	label: "Todo",
	summary: "Write a structured todo list with a goal to track progress within a session",
	description: DESCRIPTION,
	parameters: parametersSchema,
	approval: "read" as const,
	loadMode: "discoverable" as const,
	strict: true,
	// Read off the definition by the host (extensibility/tool-proxy.ts): calls run one at a time,
	// and a call without `op` reaches execute raw so the tool can infer it as native todo does.
	concurrency: "exclusive" as const,
	lenientArgValidation: true,
	describeCall: describeTodoCall,
	describeResult: describeTodoResult,
};

/** The AgentSession this extension instance serves, through the registry entry of its agent id. */
const ownSession = (ctx: ExtensionContext): AgentSession | undefined => AgentRegistry.global().get(ctx.agent.id)?.session ?? undefined;

const isTaskAgent = (ctx: ExtensionContext): boolean => {
	if (ctx.agent.kind !== "sub") return false;
	const ref = AgentRegistry.global().get(ctx.agent.id);
	return ref !== undefined && Object.hasOwn(TODO_AGENTS, ref.displayName);
};

/** `task:*` subagent: put the tool back after the executor stripped `todo`. */
async function installForTask(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!isTaskAgent(ctx)) return;
	const session = ownSession(ctx);
	if (session === undefined) return;
	if (session.getAllToolNames().includes(TOOL_NAME)) {
		const enabled = session.getEnabledToolNames();
		if (enabled.includes(TOOL_NAME)) return;
		// Direct on the session: the executor's filter strips `todo` from extension-driven changes.
		await session.setActiveToolsByName([...enabled, TOOL_NAME]);
		return;
	}
	// A tool-restricted session registers no extension tools; the RPC host-tool slot still takes one.
	const hostTool = { ...TOOL_FIELDS, execute: async (_toolCallId: string, params: unknown) => runTodo(pi, session, params) };
	// The host registry erases each tool's parameter schema; the tool validates its input itself.
	await session.refreshRpcHostTools([hostTool as unknown as AgentTool]);
}

export default async function todoMore(pi: ExtensionAPI): Promise<void> {
	await initializeTernPlugin();
	pi.registerTool({
		...TOOL_FIELDS,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const session = ownSession(ctx);
			if (session === undefined) throw new Error(`todo: no session registered for agent ${ctx.agent.id}`);
			return runTodo(pi, session, params);
		},
		renderCall: renderTodoCall,
		renderResult: renderTodoResult,
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			await installForTask(pi, ctx);
		} catch (error) {
			pi.logger.warn("todo-more could not install todo", { error: errorText(error) });
		}
	});

	registerReminders(pi);
	registerPlanning(pi);
	registerReviewApi(pi);
	registerUi(pi);
}
