import { z } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { commitTodoState, type TodoCommitResult } from "./commit.ts";
import { errorText } from "./errors.ts";
import { readTodoMore, stateOf, type TodoGoal, type TodoMoreState, todoGoalSchema } from "./state.ts";

export type TodoEdit = { kind: "set_goal"; goal: TodoGoal } | { kind: "explain"; title: string; explanation: string };
export type TodoEditResult = TodoCommitResult | { kind: "rejected"; message: string };
type AppliedEdit = { kind: "ok"; state: TodoMoreState } | { kind: "rejected"; message: string };
const nonEmpty = z.string().refine((value) => value.trim().length > 0, "must not be empty");
const editSchema = z.union([
	z.object({ kind: z.literal("set_goal"), goal: todoGoalSchema }),
	z.object({ kind: z.literal("explain"), title: nonEmpty, explanation: nonEmpty }),
]);

/** Edits only its target field; all other fields belong to the latest branch, not the draft. */
export function applyTodoEdit(state: TodoMoreState, edit: TodoEdit): AppliedEdit {
	if (state.kind === "empty") return { kind: "rejected", message: "Todo list is empty." };
	const parsed = editSchema.safeParse(edit);
	if (!parsed.success) return { kind: "rejected", message: "Goal fields, task title and explanation must not be empty." };
	const intent = parsed.data;
	switch (intent.kind) {
		case "set_goal": {
			if (state.goal.kind === "set" && Bun.deepEquals(state.goal.goal, intent.goal)) return { kind: "ok", state };
			return { kind: "ok", state: stateOf({ kind: "set", goal: intent.goal }, state.phases) };
		}
		case "explain": {
			const item = state.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === intent.title);
			if (item === undefined) return { kind: "rejected", message: `Task "${intent.title}" not found` };
			if (state.goal.kind === "missing")
				return { kind: "rejected", message: "The list has no goal: set goal before editing explanations." };
			if (item.explanation.kind === "explained" && item.explanation.text === intent.explanation) return { kind: "ok", state };
			const phases = state.phases.map((phase) => ({
				...phase,
				items: phase.items.map((candidate) =>
					candidate === item ? { ...candidate, explanation: { kind: "explained" as const, text: intent.explanation } } : candidate,
				),
			}));
			return { kind: "ok", state: stateOf(state.goal, phases) };
		}
		default: {
			const unreachable: never = intent;
			throw new Error(`Unexpected todo edit: ${String(unreachable)}`);
		}
	}
}

export function saveTodoEdit(session: AgentSession, edit: TodoEdit): TodoEditResult {
	try {
		const current = readTodoMore(session.sessionManager.getBranch());
		const applied = applyTodoEdit(current, edit);
		return applied.kind === "rejected" ? applied : commitTodoState(session, applied.state);
	} catch (error) {
		return { kind: "failed", stage: "persist", message: `Cannot read the authority todo branch: ${errorText(error)}` };
	}
}
