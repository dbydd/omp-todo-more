import { type ExtensionAPI, type ExtensionContext, type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { errorText } from "./errors.ts";
import { elapsedTime, readTodoMore, TODO_MORE_ENTRY_TYPE } from "./state.ts";

export const OVERTIME_TYPE = `${TODO_MORE_ENTRY_TYPE}.overtime`;
export const overtimeDetailsSchema = z.object({
	budgetId: z.string(),
	title: z.string(),
	estimatedMinutes: z.number(),
	elapsedMs: z.number(),
});

/** A delivered custom message is the notification fact; todo snapshots never copy it. */
export function hasOvertimeWarning(branch: readonly SessionEntry[], budgetId: string): boolean {
	return branch.some((entry) => {
		if (entry.type !== "custom_message" || entry.customType !== OVERTIME_TYPE) return false;
		const parsed = overtimeDetailsSchema.safeParse(entry.details);
		return parsed.success && parsed.data.budgetId === budgetId;
	});
}

/**
 * Native /todo edits do not emit an extension mutation event. Poll the authority
 * once per second, plus at model/tool boundaries, rather than caching deadlines
 * that those writers can invalidate. No timer state is persisted or projected.
 */
export function registerOvertime(pi: ExtensionAPI): void {
	let observer: { readonly ctx: ExtensionContext; readonly timer: Timer } | undefined;
	// These are queued message intents, not claims that the agent has seen them.
	const pending = new Set<string>();
	const stop = (): void => {
		if (observer !== undefined) observer.ctx.clearTimer(observer.timer);
		observer = undefined;
		pending.clear();
	};
	const check = (ctx: ExtensionContext): void => {
		try {
			if (AgentRegistry.global().get(ctx.agent.id)?.session == null) return;
			const branch = ctx.sessionManager.getBranch();
			// Host message_end and journal persistence have separate async chains.
			// End an intent only after the branch confirms the notification fact.
			for (const budgetId of pending) {
				if (hasOvertimeWarning(branch, budgetId)) pending.delete(budgetId);
			}
			const state = readTodoMore(branch);
			if (state.kind === "empty") return;
			const now = Date.now();
			for (const phase of state.phases) {
				for (const item of phase.items) {
					const time = item.time;
					if (item.status !== "in_progress" || time.kind === "missing" || time.runningSince === null) continue;
					const elapsedMs = elapsedTime(time, now);
					if (elapsedMs < time.minutes * 60_000 || pending.has(time.budgetId) || hasOvertimeWarning(branch, time.budgetId)) continue;
					const details = { budgetId: time.budgetId, title: item.title, estimatedMinutes: time.minutes, elapsedMs };
					const content = `<system-reminder source="todo-more" kind="overtime">
Todo item "${escapeXmlText(item.title)}" has exceeded its estimated time: estimate ${time.minutes} min; elapsed ${(elapsedMs / 60_000).toFixed(2)} min of in_progress wall time.
The estimate is a forecast, not a deadline or permission to reduce scope. Do not lower the expected outcome, acceptance criteria, or quality, and do not stop because of this warning.
Verify why this item is taking longer than estimated. Check the evidence and current blockers, decide whether the approach needs to change, and continue advancing the full task. Consider discussing the cause and next approach with a subagent; if you are a subagent, communicate with your parent where useful.
Keep the todo aligned with actual progress. Do not reset the list or inflate an estimate just to hide an overrun.
</system-reminder>`;
					pending.add(time.budgetId);
					try {
						// Default idle delivery appends context without starting a turn. Busy
						// delivery waits for a safe step boundary, never cancels running tools.
						pi.sendMessage(
							{ customType: OVERTIME_TYPE, content, display: true, details, attribution: "agent" },
							ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "aside" },
						);
					} catch (error) {
						pending.delete(time.budgetId);
						throw error;
					}
				}
			}
		} catch (error) {
			pi.logger.warn("todo-more overtime warning failed", { error: errorText(error) });
		}
	};
	const start = (ctx: ExtensionContext): void => {
		stop();
		observer = { ctx, timer: ctx.setInterval(() => check(ctx), 1_000) };
		check(ctx);
	};
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_switch", (_event, ctx) => start(ctx));
	pi.on("session_branch", (_event, ctx) => start(ctx));
	pi.on("session_tree", (_event, ctx) => start(ctx));
	pi.on("before_agent_start", (_event, ctx) => {
		if (observer === undefined) start(ctx);
		else check(ctx);
	});
	pi.on("message_end", (_event, ctx) => check(ctx));
	pi.on("turn_end", (_event, ctx) => check(ctx));
	pi.on("session_shutdown", stop);
}
