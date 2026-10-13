import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { errorText } from "./errors.ts";
import { actionableItems, readTodoMore, type TodoGoal } from "./state.ts";

/** Public wire projection; never exposes the plugin's domain representation. */
type TodoMoreReadResponse =
	| { kind: "ok"; goal: TodoGoal | null; openItems: readonly { phase: string; title: string; explanation: string | null }[] }
	| { kind: "unavailable" };
type ReadRequest = { agentId: string; reply: (value: unknown) => void };

function isReadRequest(value: unknown): value is ReadRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"agentId" in value &&
		typeof value.agentId === "string" &&
		value.agentId.trim().length > 0 &&
		"reply" in value &&
		typeof value.reply === "function"
	);
}

/** Synchronous request/reply only: branch reads, no IO, cache, timers or writes. */
export function registerReviewApi(pi: ExtensionAPI): void {
	const unsubscribe = pi.events.on("omp-todo-more:read", (request) => {
		if (!isReadRequest(request)) return;
		let response: TodoMoreReadResponse;
		try {
			const session = AgentRegistry.global().get(request.agentId)?.session;
			if (session == null) response = { kind: "unavailable" };
			else {
				const state = readTodoMore(session.sessionManager.getBranch());
				response = {
					kind: "ok",
					goal: state.kind === "list" && state.goal.kind === "set" ? state.goal.goal : null,
					openItems: actionableItems(state).map(({ phase, item }) => ({
						phase,
						title: item.title,
						explanation: item.explanation.kind === "explained" ? item.explanation.text : null,
					})),
				};
			}
		} catch (error) {
			pi.logger.warn("todo-more review read failed", { error: errorText(error) });
			response = { kind: "unavailable" };
		}
		request.reply(response);
	});
	pi.on("session_shutdown", () => unsubscribe());
}
