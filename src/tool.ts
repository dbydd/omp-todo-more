import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TodoPhase as HostTodoPhase, TodoCompletionTransition } from "@oh-my-pi/pi-tui/tools/todo";
import { commitTodoState } from "./commit.ts";
import {
	type Explanation,
	estimatedMinutesSchema,
	explanationText,
	type GoalState,
	goalLines,
	hostPhases,
	type ItemTime,
	readTodoMore,
	stateOf,
	TODO_MORE_RESULT_MARK,
	type TodoGoal,
	type TodoMoreSnapshot,
	type TodoMoreState,
	type TodoStatus,
	timeEstimateText,
	todoGoalSchema,
	toSnapshot,
	transitionTime,
	unexplainedItems,
} from "./state.ts";

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/prompts/tools/todo.md#*
export const DESCRIPTION = `Tasks identified by verbatim title, NEVER generated IDs (task-1). Unique, stable titles/phase names; lost text: view, NEVER guess.
Every item is {title, explanation, estimatedMinutes}: title is the short name later ops target as \`task\`; explanation says what the item covers and what shows it is finished; estimatedMinutes is your positive integer wall-time estimate in minutes (no fractions). Estimate every item yourself; do not invent a default. An item added outside this tool needs an explanation via \`explain\` {task, explanation} and a time estimate via \`estimate\` {task, estimatedMinutes}. Both operations also revise existing values.
\`goal\` is {objective, measure, doneWhen}: what this work is, how its result is measured, how far it must go to count as done. REQUIRED on init and whenever the list has none; any later mutation may carry a new goal that replaces it; NEVER on view. An emptied list drops its goal.
Before touching anything, init for any multi-step work, requested task sets, or new instructions; every change is logged per context and read back through \`ctx\`. The list tracks the current scope, not the first plan: the moment the work changes — new or revised instructions, a changed plan, findings that add or remove steps — update it (append, rm/drop, or re-init). MUST list EVERY user item separately (phased/numbered/bulleted/N); NEVER omit or remember leftovers.
After successful mutation: no active means earliest pending starts (phase order); multiple active means only earliest stays. Blocked NEVER starts automatically; unblock returns pending. Done out of order may rewind pointer but NEVER reopen completed. Mark done immediately; follow phase order.
External waits (user/agent/service): block with optional reason suppresses stop reminder, starts next pending. Unblock when actionable; append a clearing task for agent-actionable blocker.
Only in_progress time counts; pending/blocked/closed pause it. Repeated start, view and explanation edits do not reset elapsed time. Re-estimating preserves elapsed time and gives the changed budget one new overtime warning; do not re-init or inflate estimates to hide overruns. A time estimate is not a deadline, permission to lower expectations/quality, or a reason to stop. On an overtime system warning, verify the cause, reconsider the approach, consult a subagent (or your parent) where useful, and keep advancing the full task.
NEVER call todo alone: init with first work; done/start with next action.`;
// @upstream-end

export const OPS = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view", "explain", "estimate"] as const;
export type Op = (typeof OPS)[number];

const goalParam = z
	.object({
		objective: z.string().describe("what this work is"),
		measure: z.string().describe("how the result is measured"),
		doneWhen: z.string().describe("how far the work must go to count as done"),
	})
	.describe("required on init and whenever the list has none; replaces the goal on other mutations");

const itemParam = z.object({
	title: z.string().describe("short stable name; the `task` value of later ops"),
	explanation: z.string().describe("what the item covers and what shows it is finished"),
	estimatedMinutes: estimatedMinutesSchema.describe("your estimated in_progress wall time in minutes; positive integer only, no fractions"),
});
type ItemParam = z.infer<typeof itemParam>;

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#todoSchema
const fields = {
	goal: goalParam.optional(),
	list: z
		.array(z.object({ phase: z.string(), items: z.array(itemParam).min(1) }))
		.optional()
		.describe("phases for init"),
	task: z.string().optional().describe("verbatim task title"),
	phase: z.string().optional(),
	items: z.array(itemParam).optional().describe("tasks for flat init or append"),
	reason: z.string().optional().describe("blocker note for block"),
	explanation: z.string().optional().describe("new explanation for explain"),
	estimatedMinutes: estimatedMinutesSchema.optional().describe("new positive integer minute estimate for estimate; preserves elapsed time"),
};
// @upstream-end

/** The schema the model sees. */
export const parametersSchema = z.object({ op: z.enum(OPS), ...fields });

/** What execute accepts: the tool sets `lenientArgValidation`, so a call without `op` arrives raw. */
const inputSchema = z.object({ op: z.enum(OPS).optional(), ...fields });
type Input = z.infer<typeof inputSchema>;
type Params = Input & { readonly op: Op };

/** Mutable working copy of the list while one call applies. */
type WorkItem = { title: string; explanation: Explanation; time: ItemTime; status: TodoStatus; blocker?: string };
type WorkPhase = { name: string; items: WorkItem[] };

/** Details of every result: native-compatible fields for the host, plus the marker and the snapshot for todo-more readers. */
export type TodoMoreDetails = {
	op?: Op;
	phases: HostTodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
	[TODO_MORE_RESULT_MARK]: true;
	more: TodoMoreSnapshot;
};

const working = (state: TodoMoreState): WorkPhase[] =>
	state.kind === "empty" ? [] : state.phases.map((phase) => ({ name: phase.name, items: phase.items.map((item) => ({ ...item })) }));

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#findTaskByContent
function findTask(phases: WorkPhase[], title: string): { item: WorkItem; phase: WorkPhase } | undefined {
	for (const phase of phases) {
		const item = phase.items.find((candidate) => candidate.title === title);
		if (item) return { item, phase };
	}
	return undefined;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#getCompletionTransitions
function completionTransitions(previous: WorkPhase[], updated: WorkPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const item of phase.items) previousStatuses.set(`${phase.name}\u0000${item.title}`, item.status);
	}
	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const item of phase.items) {
			if (item.status !== "completed") continue;
			const previousStatus = previousStatuses.get(`${phase.name}\u0000${item.title}`);
			if (previousStatus && previousStatus !== "completed") transitions.push({ phase: phase.name, content: item.title });
		}
	}
	return transitions;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#normalizeInProgressTask
function normalizeInProgress(phases: WorkPhase[]): void {
	const ordered = phases.flatMap((phase) => phase.items);
	if (ordered.length === 0) return;
	const inProgress = ordered.filter((item) => item.status === "in_progress");
	if (inProgress.length > 1) {
		for (const item of inProgress.slice(1)) item.status = "pending";
	}
	if (inProgress.length > 0) return;
	const firstPending = ordered.find((item) => item.status === "pending");
	if (firstPending) firstPending.status = "in_progress";
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#resolveTaskOrError
function resolveTask(phases: WorkPhase[], title: string | undefined, errors: string[]): { item: WorkItem; phase: WorkPhase } | undefined {
	if (!title) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTask(phases, title);
	if (!hit) {
		if (/^task-\d+$/.test(title)) {
			errors.push(
				`Task "${title}" not found. Tasks are referenced by title, not by IDs — pass the task's full title from the previous result.`,
			);
		} else {
			const total = phases.reduce((sum, phase) => sum + phase.items.length, 0);
			const hint = total === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${title}" not found${hint}`);
		}
	}
	return hit;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#resolvePhaseOrError
function resolvePhase(phases: WorkPhase[], name: string | undefined, errors: string[]): WorkPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = phases.find((candidate) => candidate.name === name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#getTaskTargets
function targets(phases: WorkPhase[], params: Params, errors: string[]): WorkItem[] {
	if (params.task) {
		const hit = resolveTask(phases, params.task, errors);
		return hit ? [hit.item] : [];
	}
	if (params.phase) {
		const phase = resolvePhase(phases, params.phase, errors);
		return phase ? [...phase.items] : [];
	}
	return phases.flatMap((phase) => phase.items);
}
// @upstream-end

const explained = (item: ItemParam): WorkItem => ({
	title: item.title,
	explanation: { kind: "explained", text: item.explanation },
	time: {
		kind: "estimated",
		budgetId: crypto.randomUUID(),
		minutes: item.estimatedMinutes,
		elapsedMs: 0,
		runningSince: null,
	},
	status: "pending",
});

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#initPhases
function initPhases(params: Params, errors: string[]): WorkPhase[] {
	const list =
		params.list ?? (params.items && params.items.length > 0 ? [{ phase: params.phase ?? "Tasks", items: params.items }] : undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const entry of list) {
		if (seenPhases.has(entry.phase)) errors.push(`Duplicate phase "${entry.phase}" in init list`);
		seenPhases.add(entry.phase);
		for (const item of entry.items) {
			if (seenTasks.has(item.title)) errors.push(`Duplicate task "${item.title}" in init list`);
			seenTasks.add(item.title);
		}
	}
	return list.map((entry) => ({ name: entry.phase, items: entry.items.map(explained) }));
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#appendItems
function appendItems(phases: WorkPhase[], params: Params, errors: string[]): WorkPhase[] {
	if (!params.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!params.items || params.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}
	const seen = new Set<string>();
	let duplicate = false;
	for (const item of params.items) {
		if (seen.has(item.title) || findTask(phases, item.title)) {
			errors.push(`Task "${item.title}" already exists`);
			duplicate = true;
		}
		seen.add(item.title);
	}
	if (duplicate) return phases;
	let phase = phases.find((candidate) => candidate.name === params.phase);
	if (!phase) {
		phase = { name: params.phase, items: [] };
		phases.push(phase);
	}
	phase.items.push(...params.items.map(explained));
	return phases;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#removeTasks
function removeTasks(phases: WorkPhase[], params: Params, errors: string[]): WorkPhase[] {
	if (params.task) {
		const hit = resolveTask(phases, params.task, errors);
		if (hit) hit.phase.items = hit.phase.items.filter((candidate) => candidate !== hit.item);
		return phases;
	}
	if (params.phase) {
		const phase = resolvePhase(phases, params.phase, errors);
		if (phase) phase.items = [];
		return phases;
	}
	for (const phase of phases) phase.items = [];
	return phases;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#applyEntry
function applyOp(phases: WorkPhase[], params: Params, errors: string[]): WorkPhase[] {
	switch (params.op) {
		case "init":
			return initPhases(params, errors);
		case "start": {
			const hit = resolveTask(phases, params.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const item of phase.items) if (item.status === "in_progress" && item !== hit.item) item.status = "pending";
			}
			hit.item.status = "in_progress";
			return phases;
		}
		case "done":
			for (const item of targets(phases, params, errors)) item.status = "completed";
			return phases;
		case "drop":
			for (const item of targets(phases, params, errors)) item.status = "abandoned";
			return phases;
		case "block": {
			if (!params.task && !params.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// One line: the note rides on one Markdown checklist line and one HUD/summary line.
			const reason = params.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const item of targets(phases, params, errors)) {
				if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "blocked") continue;
				item.status = "blocked";
				if (reason === undefined) delete item.blocker;
				else item.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
			if (!params.task && !params.phase) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const item of targets(phases, params, errors)) {
				if (item.status !== "blocked") continue;
				item.status = "pending";
				delete item.blocker;
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, params, errors);
		case "append":
			return appendItems(phases, params, errors);
		case "explain": {
			const hit = resolveTask(phases, params.task, errors);
			if (hit && params.explanation !== undefined) hit.item.explanation = { kind: "explained", text: params.explanation };
			return phases;
		}
		case "estimate": {
			const hit = resolveTask(phases, params.task, errors);
			if (!hit || params.estimatedMinutes === undefined) return phases;
			const time = hit.item.time;
			if (time.kind === "estimated" && time.minutes === params.estimatedMinutes) return phases;
			hit.item.time = {
				kind: "estimated",
				budgetId: crypto.randomUUID(),
				minutes: params.estimatedMinutes,
				elapsedMs: time.kind === "estimated" ? time.elapsedMs : 0,
				runningSince: time.kind === "estimated" ? time.runningSince : null,
			};
			return phases;
		}
		case "view":
			return phases;
		default: {
			const unreachable: never = params.op;
			throw new Error(`Unexpected todo operation: ${String(unreachable)}`);
		}
	}
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#inferTodoOp
function inferOp(input: Input, hasItems: boolean): Op | undefined {
	if (input.list !== undefined && input.list.length > 0) return "init";
	if (input.items !== undefined && input.items.length > 0) {
		if (input.phase) return "append";
		if (!hasItems) return "init";
	}
	return undefined;
}
// @upstream-end

type Parsed = { readonly kind: "ok"; readonly params: Params } | { readonly kind: "invalid"; readonly message: string };

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#resolveTodoParams
function parseParams(raw: unknown, hasItems: boolean): Parsed {
	const parsed = inputSchema.safeParse(raw);
	if (!parsed.success) return { kind: "invalid", message: `Invalid todo arguments: ${parsed.error.message}` };
	const op = parsed.data.op ?? inferOp(parsed.data, hasItems);
	if (op === undefined) return { kind: "invalid", message: "Invalid todo arguments: op must be provided" };
	return { kind: "ok", params: { ...parsed.data, op } };
}
// @upstream-end

/** Items this call adds, from `list` (init) or `items` (flat init, append). */
function addedItems(params: Params): ItemParam[] {
	switch (params.op) {
		case "init":
			return params.list?.flatMap((phase) => phase.items) ?? params.items ?? [];
		case "append":
			return params.items ?? [];
		case "start":
		case "done":
		case "rm":
		case "drop":
		case "block":
		case "unblock":
		case "view":
		case "explain":
		case "estimate":
			return [];
		default: {
			const unreachable: never = params.op;
			throw new Error(`Unexpected todo operation: ${String(unreachable)}`);
		}
	}
}

/** todo-more's rules on top of the native ones. */
function ruleErrors(params: Params, previous: TodoMoreState): string[] {
	const errors: string[] = [];
	const hasGoal = previous.kind === "list" && previous.goal.kind === "set";
	if (params.op === "view") {
		if (params.goal !== undefined) errors.push("goal cannot be set on view");
	} else if (params.goal === undefined && (params.op === "init" || !hasGoal)) {
		errors.push(params.op === "init" ? "init requires goal" : "the list has no goal: pass goal with this call");
	}
	if (params.goal !== undefined && !todoGoalSchema.safeParse(params.goal).success) {
		errors.push("goal objective, measure and doneWhen must not be empty");
	}
	for (const item of addedItems(params)) {
		if (item.title.trim().length === 0 || item.explanation.trim().length === 0) {
			errors.push(`Task "${item.title}" needs a non-empty title and explanation`);
		}
	}
	if (params.op === "explain" && (params.explanation === undefined || params.explanation.trim().length === 0)) {
		errors.push("explain requires a non-empty explanation");
	}
	if (params.op === "estimate" && params.estimatedMinutes === undefined) errors.push("estimate requires estimatedMinutes");
	if (params.op !== "estimate" && params.estimatedMinutes !== undefined) errors.push("estimatedMinutes is only valid on estimate");
	return errors;
}

const isOpen = (status: TodoStatus): boolean => status === "pending" || status === "in_progress";

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#formatSummary
function formatSummary(state: TodoMoreState, errors: readonly string[], readOnly: boolean): string {
	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (state.kind === "empty") {
		if (errors.length === 0) lines.push(readOnly ? "Todo list is empty." : "Todo list cleared.");
		return lines.join("\n");
	}
	const { phases } = state;
	if (state.goal.kind === "set") lines.push("Goal:", ...goalLines(state.goal.goal).map((line) => `  ${line}`));
	else lines.push("Goal: none yet — pass goal with the next mutation.");
	const remaining = phases.flatMap((phase) =>
		phase.items.filter((item) => isOpen(item.status)).map((item) => ({ item, phase: phase.name })),
	);
	if (remaining.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remaining.length}):`);
		for (const { item, phase } of remaining) lines.push(`  - ${item.title} [${item.status}] (${phase})`);
	}
	const items = phases.flatMap((phase) => phase.items);
	const closed = (status: TodoStatus): boolean => status === "completed" || status === "abandoned";
	let currentIndex = phases.findIndex((phase) => phase.items.some((item) => isOpen(item.status)));
	if (currentIndex === -1) currentIndex = phases.length - 1;
	const current = phases[currentIndex];
	const closedAll = items.filter((item) => closed(item.status)).length;
	const blockedAll = items.filter((item) => item.status === "blocked").length;
	const workedAhead = phases.some((phase, index) => index > currentIndex && phase.items.some((item) => closed(item.status)));
	lines.push(`Overall: ${closedAll}/${items.length} done, ${remaining.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`);
	if (current !== undefined) {
		const done = current.items.filter((item) => closed(item.status)).length;
		lines.push(
			`Active phase ${currentIndex + 1}/${phases.length} "${current.name}" (${done}/${current.items.length})${
				workedAhead
					? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
					: "."
			}`,
		);
	}
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const item of phase.items) {
			const checkbox = item.status === "completed" ? "[X]" : "[ ]";
			const tag =
				item.status === "in_progress"
					? " (in progress)"
					: item.status === "abandoned"
						? " (dropped)"
						: item.status === "blocked"
							? item.blocker
								? ` (blocked: ${item.blocker})`
								: " (blocked)"
							: "";
			lines.push(`    - ${checkbox} ${item.title}${tag}`);
			if (isOpen(item.status) || item.status === "blocked") lines.push(`        ${explanationText(item)}`);
			lines.push(`        ${timeEstimateText(item.time)}`);
		}
	}
	const unexplained = unexplainedItems(state);
	if (unexplained.length > 0) {
		lines.push(
			`Items without an explanation (${unexplained.length}); add one with op explain: ${unexplained.map((item) => `"${item.title}"`).join(", ")}`,
		);
	}
	return lines.join("\n");
}
// @upstream-end

const storageOf = (session: AgentSession): "session" | "memory" => (session.sessionManager.getSessionFile() ? "session" : "memory");

function result(
	session: AgentSession,
	state: TodoMoreState,
	text: string,
	extra: { op?: Op; completedTasks?: TodoCompletionTransition[]; isError?: true },
): AgentToolResult<TodoMoreDetails> {
	const details: TodoMoreDetails = {
		phases: hostPhases(state),
		storage: storageOf(session),
		[TODO_MORE_RESULT_MARK]: true,
		more: toSnapshot(state),
	};
	if (extra.op !== undefined) details.op = extra.op;
	if (extra.completedTasks !== undefined && extra.completedTasks.length > 0) details.completedTasks = extra.completedTasks;
	return extra.isError ? { content: [{ type: "text", text }], details, isError: true } : { content: [{ type: "text", text }], details };
}

/**
 * One `todo` call on `session`. The list is read from the branch; a successful
 * mutation appends a full snapshot entry at once (the next call of the same
 * batch reads it before this call's tool result reaches the branch) and pushes
 * the host projection into the session's TodoTracker. Expected argument and
 * rule errors discard the whole call; projection failure reports the accepted branch state.
 */
// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#TodoTool.execute
export function runTodo(session: AgentSession, raw: unknown): AgentToolResult<TodoMoreDetails> {
	const previous = readTodoMore(session.sessionManager.getBranch());
	const parsed = parseParams(raw, previous.kind === "list");
	if (parsed.kind === "invalid") return result(session, previous, parsed.message, { isError: true });
	const { params } = parsed;
	const rules = ruleErrors(params, previous);
	if (rules.length > 0) return result(session, previous, formatSummary(previous, rules, true), { op: params.op, isError: true });
	if (params.op === "view") return result(session, previous, formatSummary(previous, [], true), { op: "view" });

	const before = working(previous);
	const errors: string[] = [];
	const updated = applyOp(working(previous), params, errors);
	if (errors.length > 0) return result(session, previous, formatSummary(previous, errors, false), { op: params.op, isError: true });
	normalizeInProgress(updated);
	const now = Date.now();
	for (const phase of updated) {
		for (const item of phase.items) item.time = transitionTime(item.time, item.status, now);
	}

	const goal: GoalState =
		params.goal !== undefined
			? { kind: "set", goal: params.goal satisfies TodoGoal }
			: previous.kind === "list"
				? previous.goal
				: { kind: "missing" };
	const next = stateOf(goal, updated);
	const committed = commitTodoState(session, next);
	if (committed.kind === "failed") {
		const current = readTodoMore(session.sessionManager.getBranch());
		return result(session, current, formatSummary(current, [committed.message], true), { op: params.op, isError: true });
	}
	return result(session, next, formatSummary(next, [], false), { op: params.op, completedTasks: completionTransitions(before, updated) });
}
// @upstream-end
