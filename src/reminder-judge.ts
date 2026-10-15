/**
 * Decider gates in front of the todo reminders.
 *
 * Two reminders exist and each asks a different question:
 *
 * - `shouldSendStopReminder` guards the "you stopped with incomplete items"
 *   nudge. It costs another turn, so the judge is asked whether the last
 *   assistant message leaves work the open items still describe unfinished — a
 *   merely stale list, a question to the human and a reported blocker are not
 *   worth a turn.
 * - `shouldRemindPlan` guards the per-request plan-check reminder. A session
 *   that cannot act on the list is skipped without a model call (the harness's
 *   own `session_init.readOnly` verdict); the rest go to a judge that keeps
 *   the reminder for multi-step work and drops it for one-shot deliveries.
 *
 * Both judges are the session's `modelRoles.judge` model, asked through its
 * native judgment API. Neither throws: a judge that is not configured, is not
 * a judgment API, cannot resolve a credential, fails, or exceeds its deadline
 * leaves the reminder silent. A broken gate must not nag.
 */
import { type Api, isJudgmentApi, type JsonValue, type JudgmentApi, type JudgmentState, type Model, NativeJudge } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { errorText } from "./errors.ts";
import { actionableItems, elapsedTime, explanationText, goalLines, type TodoItem, type TodoMoreState } from "./state.ts";

/** A judge call slower than this is dropped without a reminder. */
const JUDGE_TIMEOUT_MS = 8_000;
/** Probability the judge must reach to spend a turn on the stop reminder. */
const STOP_THRESHOLD = 0.5;
/**
 * Probability the judge must reach before a request carries the plan-check
 * reminder. Measured on 28 labelled agent profiles against the local decision
 * model: at 0.5 four one-shot/review profiles were nudged anyway (85.7%
 * agreement), at 0.75 two remained (92.9%), and at 0.8 none did (100%) while
 * 0.85 dropped a genuine worker (96.4%). The observed split runs from 0.773
 * (highest skip) to 0.834 (lowest send).
 */
const PLAN_THRESHOLD = 0.8;
/** Tail of the assistant's last message sent to the judge; the answer or the question sits there. */
const LAST_MESSAGE_CHARS = 2_000;
/** Assignment characters sent to the planning judge. */
const ASSIGNMENT_CHARS = 1_500;
/** Explanation characters kept per open item. */
const ITEM_CHARS = 300;
/** Wall-clock reading of one item's budget: the estimate, and how much of it has run. */
function itemTimeText(time: TodoItem["time"], now: number): JsonValue {
	if (time.kind === "missing") return null;
	return {
		minutes: time.minutes,
		elapsedMinutes: Math.round(elapsedTime(time, now) / 60_000),
	};
}

/** `provider/modelId` as configured in `modelRoles.judge`; the id may hold slashes. */
type JudgeRef = { readonly provider: string; readonly modelId: string };

/** The judge model with its API narrowed to a judgment dialect, or nothing. */
type JudgeTarget = { readonly model: Model<Api>; readonly api: JudgmentApi };

/** One `noul` decision: the state, the question, and the probability it must reach. */
type JudgeAsk = {
	readonly state: JudgmentState;
	readonly instructions: string;
	readonly criteria: { readonly true: string; readonly false: string };
	readonly threshold: number;
};

/**
 * The stop-reminder question, as verified against the local decision model: a
 * finished-but-unmarked list, a question back to the human and a reported
 * blocker all score low, a genuinely unfinished list scores high.
 */
const STOP_ASK = {
	instructions:
		"The assistant ended its turn while the todo list still has open items. Answer true only if the last assistant message leaves work that the open items still describe as unfinished — a next action the assistant could take now. Answer false when the last message already delivered the requested result, when it ends by asking the human a question or reporting a blocker, when the open items describe work that is finished in substance but not marked, or when they cannot be advanced without a new instruction.",
	criteria: {
		true: "work remains and the assistant could continue it in the same session",
		false: "the message already delivered the result, asks the human, reports a blocker, or describes a list that is merely stale",
	},
} as const;

/**
 * The plan-check question. Its disagreement with the read-only verdict is the
 * case a capability check cannot see: a read-only agent handed an assignment
 * that says "fix", and a one-shot delivery that needs no list of steps.
 */
const PLAN_ASK = {
	instructions:
		"A coding harness session carries a todo list that tracks planned steps. Decide whether the model should be reminded to keep that list aligned before it answers. Answer true only when the session's own work is multi-step implementation or authoring it will carry out — it can change the repository (write or edit files) and delivers a result built over several steps. Answer false when the session only inspects, reviews, diagnoses or advises: a read-only review, a question answered from evidence, a design opinion, or a single delivery that no list of steps tracks.",
	criteria: {
		true: "the session writes or edits files, or otherwise carries out multi-step authoring/implementation work whose progress a list of steps tracks",
		false: "the session only reads, reviews, diagnoses or advises; it produces an answer or a verdict, not a multi-step change",
	},
} as const;

function readJudgeRef(settings: AgentSession["settings"]): JudgeRef | undefined {
	let configured: string | undefined;
	try {
		configured = cfgModelRoles.get(settings).judge;
	} catch (error) {
		// A settings layer that cannot answer is the same as no judge configured.
		void error;
		return undefined;
	}
	if (configured === undefined) return undefined;
	const slash = configured.indexOf("/");
	if (slash <= 0 || slash === configured.length - 1) return undefined;
	return { provider: configured.slice(0, slash), modelId: configured.slice(slash + 1) };
}

function judgeTarget(ctx: ExtensionContext, ref: JudgeRef): JudgeTarget | undefined {
	const model = ctx.modelRegistry
		.getAvailable("all")
		.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.modelId);
	if (model === undefined || !isJudgmentApi(model.api)) return undefined;
	return { model, api: model.api };
}

/** Answer one `noul` question; `false` on every failure, including the deadline. */
async function askJudge(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	session: AgentSession,
	ask: JudgeAsk,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const ref = readJudgeRef(session.settings);
		if (ref === undefined) return false;
		const target = judgeTarget(ctx, ref);
		if (target === undefined) return false;
		const { model, api } = target;
		const sessionId = ctx.sessionManager.getSessionId();
		const judge = new NativeJudge({
			apiKey: ctx.modelRegistry.resolver(model, sessionId),
			api,
			provider: model.provider,
			model: model.id,
			baseUrl: model.baseUrl,
			headers: await ctx.modelRegistry.resolveModelHeaders(model, signal),
			timeoutMs: JUDGE_TIMEOUT_MS,
		});
		const result = await judge.judge(
			{
				state: ask.state,
				questions: { send: { type: "noul", instructions: ask.instructions, criteria: ask.criteria } },
			},
			{ signal },
		);
		return result.answers.send.noul >= ask.threshold;
	} catch (error) {
		// A gate that cannot answer stays quiet; the reason is one log line, not a reminder.
		pi.logger.warn("todo-more reminder judge failed", { error: errorText(error) });
		return false;
	}
}

/** The judged state: the goal, the open items, and the tail of the last answer. */
function judgingState(state: TodoMoreState, lastMessage: string | undefined, now = Date.now()): JudgmentState {
	const open = actionableItems(state).map(({ phase, item }) => ({
		phase,
		title: item.title,
		explanation: explanationText(item).slice(0, ITEM_CHARS),
		time: itemTimeText(item.time, now),
	}));
	const payload: Record<string, JsonValue> = {
		goal: state.kind === "list" && state.goal.kind === "set" ? goalLines(state.goal.goal) : null,
		openItems: open,
		lastMessage: (lastMessage ?? "").slice(-LAST_MESSAGE_CHARS),
	};
	return payload;
}

/** Message text as one string, whichever form its content takes. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (typeof block !== "object" || block === null || !("type" in block) || !("text" in block)) return [];
			if (block.type !== "text" || typeof block.text !== "string") return [];
			return [block.text];
		})
		.join("\n");
}

/**
 * What this session was handed: its `session_init` task, or the first human
 * message of a main session. The planning judge reads it to tell a multi-step
 * assignment from a single question.
 */
export function assignmentOf(branch: readonly SessionEntry[]): string | undefined {
	for (const entry of branch) {
		if (entry.type === "session_init") return entry.task.slice(0, ASSIGNMENT_CHARS);
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" || message.attribution === "agent" || message.synthetic) continue;
		const text = messageText(message.content).trim();
		if (text !== "") return text.slice(0, ASSIGNMENT_CHARS);
	}
	return undefined;
}

/**
 * The harness's own read-only verdict for this session (`task/read-only-policy.ts`):
 * an agent definition whose declared tools are a non-empty read-only subset.
 * Exact and free, so the planning gate never spends a model call on it.
 */
function sessionIsReadOnly(branch: readonly SessionEntry[]): boolean {
	for (const entry of branch) {
		if (entry.type === "session_init") return entry.readOnly === true;
	}
	return false;
}

/**
 * Whether the stop reminder is worth sending: `true` only when the judge scores
 * the stop question at or above {@link STOP_THRESHOLD}. Every failure path — no
 * judge role, a role that is not a judgment model, no credential, a transport
 * error, the deadline — returns `false`.
 */
export async function shouldSendStopReminder(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	session: AgentSession,
	state: TodoMoreState,
	lastMessage: string | undefined,
	signal?: AbortSignal,
): Promise<boolean> {
	return askJudge(ctx, pi, session, { state: judgingState(state, lastMessage), ...STOP_ASK, threshold: STOP_THRESHOLD }, signal);
}

/**
 * Whether this request should carry the plan-check reminder. A read-only
 * session never does; every other session is judged on its agent name, tool set
 * and assignment. Failure is silence.
 */
export async function shouldRemindPlan(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	session: AgentSession,
	signal?: AbortSignal,
): Promise<boolean> {
	const branch = ctx.sessionManager.getBranch();
	if (sessionIsReadOnly(branch)) return false;
	const state: Record<string, JsonValue> = {
		agent: AgentRegistry.global().get(ctx.agent.id)?.displayName ?? ctx.agent.id,
		tools: [...session.getActiveToolNames()],
		assignment: assignmentOf(branch) ?? null,
	};
	return askJudge(ctx, pi, session, { state, ...PLAN_ASK, threshold: PLAN_THRESHOLD }, signal);
}
