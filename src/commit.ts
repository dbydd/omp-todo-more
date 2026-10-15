import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { errorText } from "./errors.ts";
import { hostPhases, readTodoMore, TODO_MORE_ENTRY_TYPE, type TodoMoreState, toSnapshot } from "./state.ts";

export type TodoSession = Pick<AgentSession, "sessionManager" | "setTodoPhases">;

/** `persist` means acceptance by the authority branch, not a durable disk-write acknowledgement. */
export type TodoCommitResult =
	| { kind: "saved"; state: TodoMoreState }
	| { kind: "failed"; stage: "persist" | "projection"; message: string };

/** No await between reading the branch, appending its record and projecting it. */
export function commitTodoState(session: TodoSession, next: TodoMoreState): TodoCommitResult {
	try {
		const current = readTodoMore(session.sessionManager.getBranch());
		if (!Bun.deepEquals(current, next)) {
			session.sessionManager.appendCustomEntry(TODO_MORE_ENTRY_TYPE, toSnapshot(next));
			if (!Bun.deepEquals(readTodoMore(session.sessionManager.getBranch()), next)) {
				return { kind: "failed", stage: "persist", message: "Authority branch did not accept the todo snapshot." };
			}
		}
	} catch (error) {
		return { kind: "failed", stage: "persist", message: `Todo branch snapshot was not accepted: ${errorText(error)}` };
	}
	try {
		// Also repairs a prior partial projection on a no-op Save, without another snapshot.
		session.setTodoPhases(hostPhases(next));
	} catch (error) {
		return { kind: "failed", stage: "projection", message: `Todo branch state accepted, but host projection failed: ${errorText(error)}` };
	}
	return { kind: "saved", state: next };
}
