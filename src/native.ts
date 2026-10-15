import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { type NativeChild, type NativeNode, node, span, stableKey } from "@oh-my-pi/pi-tui";
import { detailsSchema, parseCall } from "./render.ts";
import { type TodoMoreSnapshot, type TodoStatus, timeEstimateText } from "./state.ts";
import type { parametersSchema, TodoMoreDetails } from "./tool.ts";

function checklistStatus(status: TodoStatus): "pending" | "active" | "done" | "dropped" | "blocked" {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "active";
		case "completed":
			return "done";
		case "abandoned":
			return "dropped";
		case "blocked":
			return "blocked";
		default: {
			const unreachable: never = status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

/** A presentation of a snapshot only; callers must read the branch before editing. */
export function describeSnapshot(snapshot: TodoMoreSnapshot, editable = false, selectedTitle?: string): NativeChild[] {
	const body: NativeChild[] = [
		node(
			"kv",
			{
				role: "todo-more.goal",
				items: [
					{ k: "Objective", v: snapshot.goal?.objective ?? "[goal missing]" },
					{ k: "Measure", v: snapshot.goal?.measure ?? "[goal missing]" },
					{ k: "Done when", v: snapshot.goal?.doneWhen ?? "[goal missing]" },
				],
			},
			undefined,
			"goal",
		),
		node(
			"checklist",
			{
				role: "todo-more.list",
				mode: "full",
				phases: snapshot.phases.map((phase) => ({
					id: phase.name,
					title: phase.name,
					collapsed: false,
					items: phase.items.map((item) => ({
						id: item.title,
						text: item.title,
						status: checklistStatus(item.status),
						note: `${timeEstimateText(item.time)}\nExplanation: ${item.explanation ?? "[explanation missing]"}${item.blocker === undefined ? "" : `\nBlocker: ${item.blocker}`}`,
					})),
				})),
			},
			undefined,
			"list",
		),
	];
	if (snapshot.phases.every((phase) => phase.items.length === 0)) body.push(node("text", { text: "Todo list is empty." }));
	if (editable) {
		for (const phase of snapshot.phases) {
			for (const item of phase.items) {
				body.push(
					node(
						"row",
						{
							role: "omp.btn",
							actions: { click: `todo-more.explain:${item.title}` },
							title: `Edit explanation: ${item.title}`,
							tone: selectedTitle === item.title ? "accent" : undefined,
						},
						[node("text", { text: `Edit explanation: ${item.title}` })],
						stableKey(item.title),
					),
				);
			}
		}
	}
	return body;
}

/** Compact progress with a complete, non-task goal header in its disclosed body. */
export function describeTodoHud(snapshot: TodoMoreSnapshot, collapsed = true): NativeNode | null {
	let total = 0;
	let closed = 0;
	let active: string | undefined;
	let pending: string | undefined;
	let blocked: string | undefined;
	for (const phase of snapshot.phases) {
		for (const item of phase.items) {
			total++;
			switch (item.status) {
				case "completed":
				case "abandoned":
					closed++;
					break;
				case "in_progress":
					active ??= item.title;
					break;
				case "pending":
					pending ??= item.title;
					break;
				case "blocked":
					blocked ??= item.title;
					break;
				default: {
					const unreachable: never = item.status;
					throw new Error(`Unexpected todo status: ${String(unreachable)}`);
				}
			}
		}
	}
	if (total === 0) return null;
	const current = active ?? pending ?? (blocked === undefined ? "All done" : `Blocked: ${blocked}`);
	return node(
		"card",
		{ role: "todo-more.hud", collapsible: true, collapsed, variant: "bare", aria: `Todo More, ${closed} of ${total} closed` },
		[
			node(
				"row",
				{ gap: "sm", align: "center" },
				[
					node("meter", { style: "ring", size: "sm", value: closed / total }, undefined, "progress"),
					node("text", { text: current, wrap: "none", truncate: "end", grow: 1 }, undefined, "current"),
					node("text", { spans: [span(`${closed}/${total}`, "muted")], wrap: "none" }, undefined, "count"),
				],
				"head",
			),
			node(
				"col",
				{ role: "todo-more.details", gap: "sm" },
				[
					...describeSnapshot(snapshot),
					node(
						"row",
						{ role: "omp.btn", actions: { click: "todo-more.open" } },
						[node("text", { text: "Edit goal / explanations" })],
						"edit",
					),
				],
				"details",
			),
		],
		"todo-more.hud",
	);
}

export const describeTodoCall: NonNullable<ToolDefinition<typeof parametersSchema, TodoMoreDetails>["describeCall"]> = (args) => {
	const call = parseCall(args);
	return {
		tool: {
			title: "Todo More",
			target: [call.op ?? "update", call.task ?? call.phase].filter(Boolean).join(" "),
			meta: call.count > 0 ? [`${call.count} items`] : undefined,
		},
	};
};

export const describeTodoResult: NonNullable<ToolDefinition<typeof parametersSchema, TodoMoreDetails>["describeResult"]> = (result) => {
	const parsed = detailsSchema.safeParse(result.details);
	if (result.isError || !parsed.success) {
		const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		return { tone: "error", body: [node("text", { text: text || "Invalid todo-more result details", wrap: "word" })] };
	}
	return {
		open: true,
		preview: "children",
		body: [node("col", { role: "todo-more.panel", gap: "sm" }, describeSnapshot(parsed.data.more))],
	};
};
