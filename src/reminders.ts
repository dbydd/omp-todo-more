/**
 * The native TodoTracker lifecycle that `todo.enabled: false` switches off
 * (`session/todo-tracker.ts` and its `agent-session.ts` call sites), rebuilt on
 * extension hooks over the todo-more list:
 *
 * - Stop reminder (`checkCompletion`). Main session: `session_stop` returns the
 *   reminder as continuation context; the budget chain follows the event's
 *   `stop_hook_active` (a stop that is not part of a continuation chain starts
 *   at 0). Subagent (no `session_stop`): after a terminal `agent_end`, a hidden
 *   next-turn message that triggers a turn; its budget is the number of this
 *   module's reminder messages since the latest real user message on the
 *   branch. Guards run in native order, minus the `user-force` label: the
 *   disabled native tracker consumes it before any extension hook runs.
 *   The text is the native reminder plus the goal, each listed item's
 *   explanation and the items that still lack one. Native also skips stop
 *   reminders in print mode (`omp -p`) through a private session flag no hook
 *   can read; these fire there too.
 *   A settle the host routes past both its own reminder and `session_stop` — a
 *   provider error, a run that ended with tool calls still outstanding, or an
 *   abort nobody asked for (`agent-session.ts`, settle routing) — is nudged from
 *   `agent_end` instead, deferred by a grace window: the reminder is sent only
 *   when no turn, no queued message and no editor draft appeared meanwhile. A stop
 *   the human asked for (Esc/Ctrl+C/Enter, or a silent abort) never resumes, and a
 *   stalled chain is nudged once: it is armed again only after the run produces a
 *   successful tool result or another prompt starts a new cycle.
 * - Mid-run nudge (`takeMidRunNudge`): after 12 successful
 *   bash/eval/edit/write/ast_edit results without a todo call, at most twice
 *   per cycle, a hidden aside at the step boundary.
 * - Eager prelude (`createEagerTodoPrelude`, `todo.eager` preferred|always) on
 *   the first eligible prompt; `always` forces the named todo tool choice
 *   through the session's tool-choice queue, as native does. After an
 *   auto-compaction, the next prompt start re-asserts it (reminder only) when
 *   the list is empty.
 * - Native goal mode (`#buildGoalTodoContext`): the todo snapshot is appended
 *   to the latest `goal-mode-context` message of every model request.
 * - A transcript renderer for the reminder messages (`TodoReminderComponent`).
 *
 * Cycle: native resets its per-cycle budgets on every admitted prompt
 * (`#promptWithMessage`), while its own reminder continuation does not pass
 * through there. The nearest hook is `before_agent_start`; a start whose
 * prompt is this module's own reminder continuation is not a new cycle. It
 * also fires for dequeued user batches, which native does not reset on.
 *
 * Main reminder display: the host's `session-stop-continuation` message is
 * hidden, so the continuation's `before_agent_start` adds a displayed notice
 * message; the `context` hook strips it from model input.
 *
 * State: the todo list is read from the session branch on every use. The
 * per-cycle budgets and the pending own-continuation are this session's
 * ephemeral counters (the extension factory runs once per session), as native
 * keeps them on its tracker.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent, ToolChoice } from "@oh-my-pi/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type MessageRenderer, type SessionEntry, Text, z } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgTodoEager, cfgTodoReminders, cfgTodoRemindersMax } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { errorText } from "./errors.ts";
import {
	actionableItems,
	explanationText,
	goalLines,
	readTodoMore,
	TODO_MORE_ENTRY_TYPE,
	type TodoItem,
	type TodoMoreState,
	unexplainedItems,
} from "./state.ts";

/** Subagent stop reminder: model input and transcript notice in one message. */
const REMINDER_TYPE = `${TODO_MORE_ENTRY_TYPE}.reminder`;
/** Main stop reminder notice: transcript only, stripped from model input (the reminder itself is the host's continuation message). */
const REMINDER_NOTICE_TYPE = `${TODO_MORE_ENTRY_TYPE}.reminder-notice`;
const MID_RUN_NUDGE_TYPE = `${TODO_MORE_ENTRY_TYPE}.mid-run-nudge`;
const EAGER_PRELUDE_TYPE = `${TODO_MORE_ENTRY_TYPE}.eager-prelude`;
/** Native goal mode's per-prompt context message (`agent-session.ts#buildGoalModeMessage`). */
const GOAL_MODE_CONTEXT_TYPE = "goal-mode-context";
const TODO_TOOL = "todo";
/**
 * Grace before a cut-off settle is nudged. Long enough for a human who
 * interrupted to say something — a submitted message starts a turn, a draft
 * shows in the editor — and short enough that a session that stalled on its own
 * resumes while the human is still looking at it.
 */
const CUT_OFF_GRACE_MS = 10_000;

// @upstream verbatim @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#MID_RUN_NUDGE_MUTATION_THRESHOLD
const MID_RUN_NUDGE_MUTATION_THRESHOLD = 12;
const MID_RUN_NUDGE_MAX_PER_CYCLE = 2;
const MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#MARKDOWN_PROMPT_PREFIX_RE
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const INLINE_EMPHASIS_RE = /(\*\*|__)(.*?)\1/g;
const OPTION_LINE_RE = /^(?:[-*+]|\d+[.)])\s+\S/;
const RECOMMENDATION_RE = /^(?:i(?:'d| would)?\s+recommend|(?:my\s+)?recommendation)\b/i;
const CHOICE_CONFIRMATION_RE = /^(?:go|proceed|continue|stick)\s+with\b/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
/**
 * A trailing question mark is the universal signal that a line is a question, but
 * the English word/pronoun gates above exist to filter incidental "?" out of prose
 * (e.g. a TypeScript `foo?: string` tail). Non-English text has no cheap word list,
 * yet any non-ASCII character in a "?"/"？"-terminated line reliably marks it as
 * genuine prose — CJK/Japanese/Korean, Spanish `¿…?`, accented Latin — so treat it
 * as a real user-directed question. Fixes non-Latin prompts going undetected (#7803).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: upstream's ASCII range test.
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

// A question wrapped whole in italics (`*…*`, `_…_`) — or the `*…*` that
// INLINE_EMPHASIS_RE leaves of `***…***` — must still match the ^-anchored
// QUESTION_PROMPT_RE. Strikethrough is deliberately absent: `~~…~~` marks the
// author as having discarded the span, so unwrapping it would promote a retracted
// question back to a live one and idle the session waiting for an answer nobody is going to give.
const WRAPPED_EMPHASIS_RE = /^(\*\*\*|\*\*|\*|___|__|_)([\s\S]+)\1$/;

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}
// @upstream-end

type ListState = Extract<TodoMoreState, { kind: "list" }>;
type OpenItem = { readonly phase: string; readonly item: TodoItem };

/** What the reminder renderer reads off a reminder message. */
const reminderDetailsSchema = z.object({
	items: z.array(z.object({ phase: z.string(), title: z.string() })),
	attempt: z.number(),
	max: z.number(),
});
type ReminderDetails = z.infer<typeof reminderDetailsSchema>;

/** The native tracker's per-cycle fields, minus `#phases` (the branch is the list's authority). */
type Cycle = {
	/** Main session only: reminders sent in the current `session_stop` chain. Subagents count on the branch. */
	reminderCount: number;
	/** A reminder went out and no tool result has settled since. */
	awaitingProgress: boolean;
	mutationsSinceLastTouch: number;
	midRunNudgeCount: number;
};

/** A reminder sent whose continuation turn has not started yet. */
type PendingContinuation =
	| { readonly kind: "none" }
	| { readonly kind: "main"; readonly text: string; readonly details: ReminderDetails; readonly countBefore: number }
	| { readonly kind: "sub"; readonly text: string };

const NO_PENDING: PendingContinuation = { kind: "none" };

/** The stop-time decision, in native terms. */
type Completion =
	| { readonly kind: "silent" }
	/** Silent, and the reminder budget and latch start over (native: reminders off, no list, nothing open). */
	| { readonly kind: "reset" }
	| { readonly kind: "remind"; readonly attempt: number; readonly text: string; readonly details: ReminderDetails };

const SILENT: Completion = { kind: "silent" };
const RESET: Completion = { kind: "reset" };

const ownSession = (ctx: ExtensionContext): AgentSession | undefined => AgentRegistry.global().get(ctx.agent.id)?.session ?? undefined;

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#TodoTracker.resetCycle
/** Starts a new cycle; the main reminder count follows the `session_stop` chain instead. */
function resetCycle(cycle: Cycle): void {
	cycle.awaitingProgress = false;
	cycle.mutationsSinceLastTouch = 0;
	cycle.midRunNudgeCount = 0;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#TodoTracker.onToolResult
function onToolResult(cycle: Cycle, toolName: string, isError: boolean): void {
	if (toolName === TODO_TOOL) {
		cycle.mutationsSinceLastTouch = 0;
	} else if (!isError && MUTATING_TOOLS[toolName]) {
		cycle.mutationsSinceLastTouch++;
	}
	cycle.awaitingProgress = false;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#TodoTracker.buildEagerPreludeContext
/** The name the model calls the todo tool by. */
function todoToolRef(session: AgentSession): string {
	const tool = session.getToolByName(TODO_TOOL);
	return typeof tool?.customWireName === "string" ? tool.customWireName : TODO_TOOL;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#assistantText
function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#promptLine
function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line.trim().replace(INLINE_EMPHASIS_RE, "$2").replace(MARKDOWN_PROMPT_PREFIX_RE, "").trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	const withoutEmphasis = withoutPromptLabel.replace(WRAPPED_EMPHASIS_RE, "$2").trim();
	return {
		text: withoutEmphasis,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}
// @upstream-end

// @upstream verbatim @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#isQuestionPromptLine
function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		CHOICE_CONFIRMATION_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#isAwaitingUserAnswer
function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	const lines = text.split(/\r?\n/);
	const lastLine = lines.at(-1)?.trim();
	if (lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine))) return true;

	// Options and a recommendation do not answer the question on the user's behalf.
	// Stop at other prose so self-answered questions still allow unfinished work to resume.
	let optionCount = 0;
	let hasRecommendation = false;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]?.trim();
		if (!line) continue;
		if (OPTION_LINE_RE.test(line)) {
			optionCount++;
			continue;
		}
		const candidate = promptLine(line);
		if (optionCount > 0) {
			return (
				optionCount >= 2 &&
				isQuestionPromptLine(line) &&
				(hasRecommendation ||
					candidate.hadPromptLabel ||
					USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
					CHOICE_CONFIRMATION_RE.test(candidate.text))
			);
		}
		if (RECOMMENDATION_RE.test(candidate.text)) {
			hasRecommendation = true;
			continue;
		}
		return false;
	}
	return false;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/utils/tool-choice.ts#buildNamedToolChoice
/**
 * Build a provider-aware tool choice that targets one specific tool when supported.
 * Providers that only expose required/any forcing may still honor named choices by
 * narrowing their request tool list before transport.
 */
function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	if (!model) return undefined;

	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
		return { type: "tool", name: toolName };
	}

	// openrouter streams through the openai-responses or openai-completions path
	// (stream.ts), both of which map a named function choice onto the wire.
	if (
		model.api === "openai-codex-responses" ||
		model.api === "openai-responses" ||
		model.api === "openai-completions" ||
		model.api === "azure-openai-responses" ||
		model.api === "openrouter"
	) {
		// Both OpenAI transports drop tool_choice when the model has none and turn a
		// forced choice into "auto" when forcing is unsupported. Such a choice never
		// reaches the wire, so it must not be reported as a forced one.
		const compat = model.compat as { supportsToolChoice?: boolean; supportsForcedToolChoice?: boolean };
		if (compat?.supportsToolChoice === false || compat?.supportsForcedToolChoice === false) return undefined;
		return { type: "function", name: toolName };
	}

	if (model.api === "ollama-chat") {
		return { type: "function", name: toolName };
	}

	if (model.api === "google-generative-ai" || model.api === "google-gemini-cli" || model.api === "google-vertex") {
		return "required";
	}

	return undefined;
}
// @upstream-end

/** The goal block shared by every reminder text. */
function goalBlock(state: ListState): string[] {
	switch (state.goal.kind) {
		case "set":
			return ["Goal:", ...goalLines(state.goal.goal).map((line) => `  ${line}`)];
		case "missing":
			return ["Goal: none yet — pass goal with the next todo mutation."];
		default: {
			const unreachable: never = state.goal;
			throw new Error(`Unexpected goal state: ${String(unreachable)}`);
		}
	}
}

/** The line asking for missing explanations, or nothing. */
function unexplainedLines(state: ListState): string[] {
	const unexplained = unexplainedItems(state);
	if (unexplained.length === 0) return [];
	return [
		`Items without an explanation (${unexplained.length}); add one with op explain: ${unexplained.map((item) => `"${item.title}"`).join(", ")}`,
	];
}

/** Open items grouped by consecutive phase, list order kept. */
function byPhase(open: readonly OpenItem[]): { readonly name: string; readonly items: TodoItem[] }[] {
	const groups: { name: string; items: TodoItem[] }[] = [];
	for (const { phase, item } of open) {
		const last = groups.at(-1);
		if (last !== undefined && last.name === phase) last.items.push(item);
		else groups.push({ name: phase, items: [item] });
	}
	return groups;
}

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#TodoTracker.checkCompletion
function reminderText(state: ListState, open: readonly OpenItem[], attempt: number, max: number): string {
	const todoList = byPhase(open)
		.map(
			(phase) =>
				`- ${phase.name}\n${phase.items.map((item) => `  - ${item.title}\n    ${explanationText(item).replaceAll("\n", "\n    ")}`).join("\n")}`,
		)
		.join("\n");
	return (
		`<system-reminder>\n` +
		`You stopped with ${open.length} incomplete todo item(s):\n${todoList}\n\n` +
		`${[...goalBlock(state), ...unexplainedLines(state)].join("\n")}\n\n` +
		`Please continue working on these tasks or mark them complete if finished.\n` +
		`(Reminder ${attempt}/${max})\n` +
		`</system-reminder>`
	);
}

/**
 * The native guards after the user-force label, in native order. `count` is the
 * reminders already sent in this budget; the caller applies the outcome to it.
 */
function checkCompletion(session: AgentSession, cycle: Cycle, count: number, message: AssistantMessage, state: TodoMoreState): Completion {
	if (session.getPlanModeState()?.enabled === true) return SILENT;
	if (cycle.awaitingProgress) return SILENT;
	if (!cfgTodoReminders.get(session.settings)) return RESET;
	const max = cfgTodoRemindersMax.get(session.settings);
	if (count >= max) return SILENT;
	if (state.kind === "empty") return RESET;
	const open = actionableItems(state);
	if (open.length === 0) return RESET;
	if (isAwaitingUserAnswer(message)) return SILENT;
	if (session.hasPendingAsyncWork()) return SILENT;
	const attempt = count + 1;
	return {
		kind: "remind",
		attempt,
		text: reminderText(state, open, attempt, max),
		details: { items: open.map(({ phase, item }) => ({ phase, title: item.title })), attempt, max },
	};
}
// @upstream-end

/**
 * The final assistant message when the stop is a text-only terminal answer.
 * Native skips the reminder at tool-call tails, error stops and capped empty
 * output (`agent-session.ts`, stop routing); aborted runs never reach it.
 */
function terminalAnswer(message: AgentMessage | undefined): AssistantMessage | undefined {
	if (message?.role !== "assistant") return undefined;
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	if (message.content.some((content) => content.type === "toolCall")) return undefined;
	return assistantText(message) === "" ? undefined : message;
}

/** Stop reasons where the run was cut off rather than ended on a text answer (see `cutOffAnswer`). */
const CUT_OFF_STOP_REASONS: Record<string, true> = { error: true, toolUse: true };

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/chat/messages.ts#isUserInterruptAbort
// plus #isSilentAbort, inlined because an extension may not import the pi-tui chat
// subpath: both markers only ever ride the aborted assistant message, as a flag on
// `errorId` with the legacy `errorMessage` string as fallback.
const USER_INTERRUPT_LABEL = "Interrupted by user";
const SILENT_ABORT_MARKER = "__omp.silent_abort__";
/** `AIError.Flag.UserInterrupt` | `Flag.SilentAbort` (pi-ai error flags), as bits. */
const HUMAN_ABORT_FLAGS = 0x0400_0000 | 0x0200_0000;

/** The human asked for this stop: Esc/Ctrl+C/Enter, or a silent abort. */
function isHumanAbort(message: AssistantMessage): boolean {
	const errorId = message.errorId;
	return (
		(typeof errorId === "number" && (errorId & HUMAN_ABORT_FLAGS) !== 0) ||
		message.errorMessage === USER_INTERRUPT_LABEL ||
		message.errorMessage === SILENT_ABORT_MARKER
	);
}
// @upstream-end

/**
 * The settled turn the host routes past its own reminder and past `session_stop`
 * (`agent-session.ts`, settle routing): a provider error, a run that ended with tool
 * calls still outstanding, or an abort nobody asked for. The model never produced
 * the text answer `terminalAnswer` describes, yet the session is now idle with the
 * list still open — exactly the stop the reminder exists to catch. A stop the human
 * asked for stays stopped, and a capped empty stop stays out too: the host's own
 * recovery declared that turn terminal.
 */
function cutOffAnswer(message: AgentMessage | undefined): AssistantMessage | undefined {
	if (message?.role !== "assistant") return undefined;
	if (message.stopReason === "aborted") return isHumanAbort(message) ? undefined : message;
	return CUT_OFF_STOP_REASONS[message.stopReason] === true ? message : undefined;
}

/** Subagent budget: this module's reminders on the branch since the latest real user message. */
function remindersSinceUserMessage(branch: readonly SessionEntry[]): number {
	let count = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type === "message" && entry.message.role === "user" && entry.message.synthetic !== true) break;
		if (entry.type === "custom_message" && entry.customType === REMINDER_TYPE) count++;
	}
	return count;
}

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/prompts/system/eager-todo.md#*
function eagerTodoText(todo: string, forced: boolean): string {
	const body = forced
		? `Before substantive work, create a phased todo.

You MUST call \`${todo}\` first in this turn.
You MUST initialize the todo list with a single \`init\` op that carries the \`goal\` {objective, measure, doneWhen}: what this work is, how its result is measured, how far it must go to count as done.
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
Each item is {title, explanation}: the title MUST be a concise, specific 5-10 word label; the explanation says what the item covers and what shows it is finished.
The \`init\` op only accepts the goal, phase names and {title, explanation} items; do not invent other fields.

After \`${todo}\` succeeds, continue the request in the same turn.
NEVER call \`${todo}\` again unless task state has materially changed.`
		: `Consider calling \`${todo}\` first to lay out a phased plan with a single \`init\` op. A good list covers the whole request — investigation through implementation and verification — not just the next step, with specific items a future turn could execute without re-planning.
The \`init\` op carries the \`goal\` {objective, measure, doneWhen} and items of {title, explanation}: a concise, specific 5-10 word title, and an explanation of what the item covers and what shows it is finished; don't invent other fields.
If you create the list, continue the request in the same turn and avoid re-calling \`${todo}\` unless task state materially changes.`;
	return `<system-reminder>\n${body}\n</system-reminder>\n`;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#TodoTracker.createEagerTodoPrelude
/**
 * The eager todo prelude for a prompt start (`promptText`), or for the turn
 * after an auto-compaction (`undefined`: reminder only, no forced choice).
 * Prewalk handoff is approximated by an armed prewalk (`willHandoff` is private).
 */
function eagerTodoPrelude(
	pi: ExtensionAPI,
	session: AgentSession,
	state: TodoMoreState,
	promptText: string | undefined,
): { customType: string; content: string; display: false; attribution: "agent" } | undefined {
	const mode = cfgTodoEager.get(session.settings);
	if (mode === "default") return undefined;
	if (session.getPlanModeState()?.enabled === true || state.kind !== "empty") return undefined;
	// An actionable prewalk drives todo creation in a plan-first-then-todo order;
	// the forced eager prelude's "call todo first this turn" contradicts it (#10510).
	if (session.getPrewalkState() !== undefined) return undefined;
	if (promptText !== undefined) {
		// Native skips eager preludes when the user has already queued a directive.
		if (session.toolChoiceQueue.inspect().includes("user-force")) return undefined;
		if (session.agent.state.messages.some((message) => message.role === "user")) return undefined;
		const trimmedPromptText = promptText.trimEnd();
		if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) return undefined;
	}
	const activeToolNames = session.getActiveToolNames();
	if (!activeToolNames.includes(TODO_TOOL)) {
		pi.logger.warn("Eager todo enforcement skipped because todo is not active", { activeToolNames });
		return undefined;
	}
	const message = {
		customType: EAGER_PRELUDE_TYPE,
		content: eagerTodoText(todoToolRef(session), mode === "always"),
		display: false as const,
		attribution: "agent" as const,
	};
	if (promptText === undefined || mode === "preferred") return message;
	const model = session.model;
	const toolChoice = buildNamedToolChoice(TODO_TOOL, model);
	if (!toolChoice) {
		pi.logger.warn("Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice", {
			modelApi: model?.api,
			modelId: model?.id,
		});
		return message;
	}
	session.toolChoiceQueue.pushOnce(toolChoice, { label: "eager-todo" });
	return message;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/todo-tracker.ts#TodoTracker.takeMidRunNudge
function takeMidRunNudge(
	session: AgentSession,
	cycle: Cycle,
	state: TodoMoreState,
): { customType: string; content: string; display: false; attribution: "agent" } | undefined {
	if (cycle.mutationsSinceLastTouch < MID_RUN_NUDGE_MUTATION_THRESHOLD) return undefined;
	if (cycle.midRunNudgeCount >= MID_RUN_NUDGE_MAX_PER_CYCLE) return undefined;
	if (!cfgTodoReminders.get(session.settings)) return undefined;
	if (session.getPlanModeState()?.enabled === true || !session.getActiveToolNames().includes(TODO_TOOL)) return undefined;
	if (state.kind === "empty") return undefined;
	const incomplete = actionableItems(state);
	if (incomplete.length === 0) return undefined;
	cycle.mutationsSinceLastTouch = 0;
	cycle.midRunNudgeCount++;
	return {
		customType: MID_RUN_NUDGE_TYPE,
		content: midRunNudgeText(todoToolRef(session), incomplete.length, state),
		display: false,
		attribution: "agent",
	};
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/prompts/system/mid-run-todo-nudge.md#*
function midRunNudgeText(todo: string, incompleteCount: number, state: ListState): string {
	const goal =
		state.goal.kind === "set"
			? `Goal objective: ${state.goal.goal.objective}`
			: `The list has no goal yet: pass goal with the next \`${todo}\` mutation.`;
	return `<system-reminder>
${incompleteCount} todo item${incompleteCount !== 1 ? "s" : ""} still open. If you finished a task since last \`${todo}\` update, mark it done now so progress stays visible; otherwise keep working.
${goal}
</system-reminder>
`;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/agent-session.ts#sanitizeGoalTodoText
function sanitizeGoalTodoText(text: string): string {
	return (
		escapeXmlText(text)
			.replace(/\r\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: upstream flattens control characters.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
	);
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/session/agent-session.ts#buildGoalTodoContext
/** Native goal mode's todo snapshot over the todo-more list, or nothing when there is none to show. */
function goalTodoContext(session: AgentSession, state: TodoMoreState): string | undefined {
	const canCallTodoTool = session.getActiveToolNames().includes(TODO_TOOL);
	if (!canCallTodoTool) return undefined;
	if (state.kind === "empty") return undefined;
	const phases = state.phases.filter((phase) => phase.items.length > 0);
	if (phases.length === 0) return undefined;

	let total = 0;
	let closed = 0;
	let open = 0;
	const phaseLines = phases.flatMap((phase) => [
		`- ${sanitizeGoalTodoText(phase.name)}`,
		...phase.items.map((item) => {
			total++;
			if (item.status === "completed" || item.status === "abandoned") {
				closed++;
			} else {
				open++;
			}
			return `  - [${item.status}] ${sanitizeGoalTodoText(item.title)}: ${sanitizeGoalTodoText(explanationText(item))}`;
		}),
	]);
	const goal =
		state.goal.kind === "set"
			? goalLines(state.goal.goal).map((line) => sanitizeGoalTodoText(line))
			: [`Goal: none yet — pass goal with the next \`${todoToolRef(session)}\` mutation.`];

	// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/prompts/goals/goal-todo-context.md#*
	return `<todo_context>
Persisted todos: live progress state for current goal, not old transcript decoration; goal continuations lack visible user nudge → treat as live state.
Before substantial work: compare next action with todos. If item stale, already finished, or no longer active pointer, call \`${todoToolRef(session)}\` first: mark done or rewrite list. Do not leave stale in_progress while working on later phases.

Todo list goal:
${goal.join("\n")}

Overall: ${closed}/${total} done, ${open} open.
${phaseLines.join("\n")}
</todo_context>
`;
	// @upstream-end
}
// @upstream-end

/** `message` with `text` appended as its last text. */
function withAppendedText(message: AgentMessage, text: string): AgentMessage {
	if (message.role !== "custom") return message;
	const content =
		typeof message.content === "string" ? `${message.content}\n${text}` : [...message.content, { type: "text" as const, text }];
	return { ...message, content };
}

/** Model input for one request: main reminder notices dropped, the goal-mode message carrying the todo snapshot. */
function contextMessages(
	messages: AgentMessage[],
	session: AgentSession | undefined,
	branch: () => readonly SessionEntry[],
): AgentMessage[] | undefined {
	const kept = messages.filter((message) => !(message.role === "custom" && message.customType === REMINDER_NOTICE_TYPE));
	let changed = kept.length !== messages.length;
	if (session?.getGoalModeState()?.enabled === true) {
		const goalIndex = kept.findLastIndex((message) => message.role === "custom" && message.customType === GOAL_MODE_CONTEXT_TYPE);
		const goalMessage = kept[goalIndex];
		if (goalMessage !== undefined) {
			const todoContext = goalTodoContext(session, readTodoMore(branch()));
			if (todoContext !== undefined) {
				kept[goalIndex] = withAppendedText(goalMessage, todoContext);
				changed = true;
			}
		}
	}
	return changed ? kept : undefined;
}

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/chat/todo-reminder.ts#TodoReminderComponent
const renderReminder: MessageRenderer = (message, _options, theme) => {
	const parsed = reminderDetailsSchema.safeParse(message.details);
	if (!parsed.success) return undefined;
	const { items, attempt, max } = parsed.data;
	const count = items.length;
	const header = `${count} incomplete ${count === 1 ? "todo" : "todos"} - reminder ${attempt}/${max}`;
	const todoList = items.map((todo) => `  ${theme.checkbox.unchecked} ${todo.title}`).join("\n");
	return new Text(`${theme.fg("warning", `${theme.icon.warning} ${header}`)}\n\n${theme.italic(todoList)}`, 0, 0);
};
// @upstream-end

export function registerReminders(pi: ExtensionAPI): void {
	const cycle: Cycle = { reminderCount: 0, awaitingProgress: false, mutationsSinceLastTouch: 0, midRunNudgeCount: 0 };
	let pending: PendingContinuation = NO_PENDING;
	/** An auto-compaction finished; the next prompt start re-asserts the eager prelude. */
	let compacted = false;

	pi.registerMessageRenderer(REMINDER_TYPE, renderReminder);
	pi.registerMessageRenderer(REMINDER_NOTICE_TYPE, renderReminder);

	pi.on("session_stop", (event, ctx) => {
		try {
			if (ctx.agent.kind !== "main") return undefined;
			if (!event.stop_hook_active) cycle.reminderCount = 0;
			const session = ownSession(ctx);
			const message = terminalAnswer(event.last_assistant_message);
			if (session === undefined || message === undefined) return undefined;
			const completion = checkCompletion(session, cycle, cycle.reminderCount, message, readTodoMore(ctx.sessionManager.getBranch()));
			switch (completion.kind) {
				case "silent":
					return undefined;
				case "reset":
					cycle.reminderCount = 0;
					cycle.awaitingProgress = false;
					return undefined;
				case "remind":
					pending = { kind: "main", text: completion.text, details: completion.details, countBefore: cycle.reminderCount };
					cycle.reminderCount = completion.attempt;
					cycle.mutationsSinceLastTouch = 0;
					cycle.awaitingProgress = true;
					return { continue: true, additionalContext: completion.text };
				default: {
					const unreachable: never = completion;
					throw new Error(`Unexpected completion: ${String(unreachable)}`);
				}
			}
		} catch (error) {
			pi.logger.warn("todo-more stop reminder failed", { error: errorText(error) });
			return undefined;
		}
	});

	/**
	 * A deferred reminder for a cut-off settle: armed at `agent_end`, cancelled the
	 * moment a turn takes over (a scheduled continuation, the human's own reply).
	 * The grace window is the only reason it is not sent from the settle itself.
	 */
	let cutOff: { readonly ctx: ExtensionContext; readonly timer: Timer } | undefined;
	/**
	 * The reminder text of the cut-off nudge this stalled chain already got, held
	 * until the run moves again (a successful tool result) or another prompt starts
	 * a new cycle. One nudge per chain: a human who stops the run it started is not
	 * fought twice, and a stall that follows real progress is nudged again.
	 */
	let cutOffNudge: string | undefined;
	const cancelCutOff = (): void => {
		if (cutOff === undefined) return;
		cutOff.ctx.clearTimer(cutOff.timer);
		cutOff = undefined;
	};
	const armCutOff = (ctx: ExtensionContext, session: AgentSession, message: AssistantMessage): void => {
		cancelCutOff();
		cutOff = {
			ctx,
			timer: ctx.setTimeout(() => {
				cutOff = undefined;
				try {
					if (ownSession(ctx) !== session) return;
					// A chain that already got its nudge waits for progress or a new cycle.
					if (cutOffNudge !== undefined) return;
					// The human owns the stop once a turn runs, a message waits, or a draft is being typed.
					if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
					if (ctx.hasUI && ctx.ui.getEditorText().trim() !== "") return;
					const completion = checkCompletion(session, cycle, cycle.reminderCount, message, readTodoMore(ctx.sessionManager.getBranch()));
					if (completion.kind !== "remind") return;
					// The message itself is this turn's prompt and its own visible reminder, so
					// there is no host continuation to hand a notice to: `pending` stays clear and
					// `before_agent_start` leaves the reminder count alone (only `resetCycle` runs),
					// which is what keeps the budget counting nudges across settles.
					cutOffNudge = completion.text;
					cycle.reminderCount = completion.attempt;
					cycle.awaitingProgress = true;
					cycle.mutationsSinceLastTouch = 0;
					pi.sendMessage<ReminderDetails>(
						{ customType: REMINDER_TYPE, content: completion.text, display: true, details: completion.details, attribution: "agent" },
						{ deliverAs: "nextTurn", triggerTurn: true },
					);
				} catch (error) {
					pi.logger.warn("todo-more cut-off reminder failed", { error: errorText(error) });
				}
			}, CUT_OFF_GRACE_MS),
		};
	};
	pi.on("agent_start", () => cancelCutOff());
	pi.on("session_shutdown", () => cancelCutOff());

	pi.on("agent_end", (event, ctx) => {
		try {
			if (event.willContinue === true) return;
			const session = ownSession(ctx);
			if (session === undefined) return;
			const last = event.messages.at(-1);
			if (ctx.agent.kind === "sub") {
				const message = terminalAnswer(last);
				if (message === undefined) return;
				const branch = ctx.sessionManager.getBranch();
				const completion = checkCompletion(session, cycle, remindersSinceUserMessage(branch), message, readTodoMore(branch));
				switch (completion.kind) {
					case "silent":
						return;
					case "reset":
						cycle.awaitingProgress = false;
						return;
					case "remind":
						pending = { kind: "sub", text: completion.text };
						cycle.mutationsSinceLastTouch = 0;
						cycle.awaitingProgress = true;
						pi.sendMessage<ReminderDetails>(
							{ customType: REMINDER_TYPE, content: completion.text, display: true, details: completion.details, attribution: "agent" },
							{ deliverAs: "nextTurn", triggerTurn: true },
						);
						return;
					default: {
						const unreachable: never = completion;
						throw new Error(`Unexpected completion: ${String(unreachable)}`);
					}
				}
			}
			// Main session cut off mid-work: no `session_stop` reaches this settle, so a
			// deferred reminder is all that stands between the open list and an idle
			// session — the stop the reminder exists to catch.
			const cutOff = cutOffAnswer(last);
			if (cutOff === undefined) return;
			const completion = checkCompletion(session, cycle, cycle.reminderCount, cutOff, readTodoMore(ctx.sessionManager.getBranch()));
			switch (completion.kind) {
				case "silent":
					return;
				case "reset":
					cycle.reminderCount = 0;
					cycle.awaitingProgress = false;
					return;
				case "remind":
					armCutOff(ctx, session, cutOff);
					return;
				default: {
					const unreachable: never = completion;
					throw new Error(`Unexpected completion: ${String(unreachable)}`);
				}
			}
		} catch (error) {
			pi.logger.warn("todo-more stop reminder failed", { error: errorText(error) });
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		try {
			const own = pending;
			pending = NO_PENDING;
			// This module's own cut-off nudge keeps its latch; any other prompt is a new
			// cycle where the human or another continuation is driving.
			if (event.prompt !== cutOffNudge) cutOffNudge = undefined;
			switch (own.kind) {
				case "none":
					break;
				case "main":
					if (event.prompt === own.text) {
						return {
							message: {
								customType: REMINDER_NOTICE_TYPE,
								content: `Todo reminder ${own.details.attempt}/${own.details.max}: ${own.details.items.length} incomplete item(s): ${own.details.items.map((item) => item.title).join("; ")}`,
								display: true,
								details: own.details,
								attribution: "agent",
							},
						};
					}
					// The reminder never started its own turn: it does not count.
					cycle.reminderCount = own.countBefore;
					break;
				case "sub":
					if (event.prompt === own.text) return undefined;
					break;
				default: {
					const unreachable: never = own;
					throw new Error(`Unexpected pending continuation: ${String(unreachable)}`);
				}
			}
			resetCycle(cycle);
			const afterCompaction = compacted;
			compacted = false;
			const session = ownSession(ctx);
			if (session === undefined) return undefined;
			const prelude = eagerTodoPrelude(
				pi,
				session,
				readTodoMore(ctx.sessionManager.getBranch()),
				afterCompaction ? undefined : event.prompt,
			);
			return prelude === undefined ? undefined : { message: prelude };
		} catch (error) {
			pi.logger.warn("todo-more prompt start failed", { error: errorText(error) });
			return undefined;
		}
	});

	pi.on("auto_compaction_end", (event) => {
		if (!event.aborted && event.result !== undefined) compacted = true;
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "toolResult") return;
		onToolResult(cycle, message.toolName, message.isError);
		// A cancelled or failed result is not progress: only a successful one settles the
		// chain's nudge, so interrupting a running tool cannot re-arm it.
		if (!message.isError) cutOffNudge = undefined;
	});

	pi.on("turn_end", (event, ctx) => {
		try {
			// Only a turn that ran tools moves the counters, and only then does the loop take another step.
			if (event.toolResults.length === 0) return;
			const session = ownSession(ctx);
			if (session === undefined) return;
			const nudge = takeMidRunNudge(session, cycle, readTodoMore(ctx.sessionManager.getBranch()));
			if (nudge !== undefined) pi.sendMessage(nudge, { deliverAs: "aside" });
		} catch (error) {
			pi.logger.warn("todo-more mid-run nudge failed", { error: errorText(error) });
		}
	});

	pi.on("context", (event, ctx) => {
		try {
			const messages = contextMessages(event.messages, ownSession(ctx), () => ctx.sessionManager.getBranch());
			return messages === undefined ? undefined : { messages };
		} catch (error) {
			pi.logger.warn("todo-more context failed", { error: errorText(error) });
			return undefined;
		}
	});
}
