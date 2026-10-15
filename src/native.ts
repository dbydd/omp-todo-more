import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { type NativeChild, node, span, stableKey } from "@oh-my-pi/pi-tui";
import type { parametersSchema } from "./protocol.ts";
import { callPreviewLines, detailsSchema, parseCall } from "./render.ts";
import { type TodoMoreSnapshot, timeEstimateText } from "./state.ts";
import type { TodoMoreDetails } from "./tool.ts";

/** A presentation of a snapshot only; callers must read the branch before editing. */
export function describeSnapshot(snapshot: TodoMoreSnapshot, editable = false, selectedTitle?: string): NativeChild[] {
	const body: NativeChild[] = [
		node(
			"kv",
			{
				items: [
					{ k: "Objective", v: snapshot.goal?.objective ?? "[goal missing]" },
					{ k: "Measure", v: snapshot.goal?.measure ?? "[goal missing]" },
					{ k: "Done when", v: snapshot.goal?.doneWhen ?? "[goal missing]" },
				],
			},
			undefined,
			"goal",
		),
	];
	for (const phase of snapshot.phases) {
		const items: NativeChild[] = [node("text", { spans: [span(phase.name, "strong")], wrap: "word" }, undefined, "name")];
		for (const item of phase.items) {
			items.push(
				node(
					"col",
					{ gap: "xs" },
					[
						node("text", { spans: [span(item.title, "strong"), span(` [${item.status}]`, "muted")], wrap: "word" }, undefined, "title"),
						node("text", { text: timeEstimateText(item.time), wrap: "word" }, undefined, "estimate"),
						node("text", { text: `Explanation: ${item.explanation ?? "[explanation missing]"}`, wrap: "word" }, undefined, "explanation"),
						node("text", { text: `Blocker: ${item.blocker ?? "(none)"}`, wrap: "word" }, undefined, "blocker"),
						...(editable
							? [
									node(
										"row",
										{
											role: "omp.btn",
											actions: { click: `todo-more.explain:${item.title}` },
											title: `Edit explanation: ${item.title}`,
											tone: selectedTitle === item.title ? "accent" : undefined,
										},
										[node("text", { text: "Edit explanation" })],
										"edit",
									),
								]
							: []),
					],
					stableKey(item.title),
				),
			);
		}
		body.push(node("col", { gap: "sm" }, items, stableKey(phase.name)));
	}
	if (snapshot.phases.every((phase) => phase.items.length === 0)) body.push(node("text", { text: "Todo list is empty." }));
	return body;
}

export const describeTodoCall: NonNullable<ToolDefinition<typeof parametersSchema, TodoMoreDetails>["describeCall"]> = (args) => {
	const call = parseCall(args);
	return {
		tool: {
			title: "Todo",
			target: "preview — not committed",
			meta: [`${call.commands.length} complete command${call.commands.length === 1 ? "" : "s"}`],
		},
		open: true,
		preview: "children",
		body: [
			node(
				"col",
				{ role: "todo-more.preview", gap: "sm" },
				callPreviewLines(call).map((text, index) => node("text", { text, wrap: "word" }, undefined, `line-${index}`)),
			),
		],
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
