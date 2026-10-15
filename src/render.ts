import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type ToolRenderResultOptions, z } from "@oh-my-pi/pi-coding-agent";
import { type Component, replaceTabs, Text, type Theme, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import {
	goalLines,
	itemSnapshotSchema,
	TODO_STATUSES,
	type TodoMoreSnapshot,
	type TodoStatus,
	timeEstimateText,
	todoGoalSchema,
} from "./state.ts";
import { OPS, type TodoMoreDetails } from "./tool.ts";

/** Result snapshots are display copies, not a second source of todo state. */
export const detailsSchema = z.object({
	op: z.enum(OPS).optional(),
	phases: z.array(
		z.object({
			name: z.string(),
			tasks: z.array(z.object({ content: z.string(), status: z.enum(TODO_STATUSES), blocker: z.string().optional() }).passthrough()),
		}),
	),
	storage: z.enum(["session", "memory"]),
	completedTasks: z.array(z.object({ phase: z.string(), content: z.string() })).optional(),
	todoMore: z.literal(true),
	more: z.object({ goal: todoGoalSchema.nullable(), phases: z.array(z.object({ name: z.string(), items: z.array(itemSnapshotSchema) })) }),
});
type Item = TodoMoreSnapshot["phases"][number]["items"][number];
type Phase = TodoMoreSnapshot["phases"][number];

// Streaming fields are parsed independently: a half-written item need not hide an already-known op.
const callSchema = z.object({
	op: z.unknown().optional(),
	task: z.unknown().optional(),
	phase: z.unknown().optional(),
	items: z.unknown().optional(),
	list: z.unknown().optional(),
});
const stringSchema = z.string();
const callItemsSchema = z.array(z.object({ title: z.unknown().optional(), explanation: z.unknown().optional() }));
const callListSchema = z.array(z.object({ phase: z.unknown().optional(), items: callItemsSchema }));
type Call = { op?: string; task?: string; phase?: string; count: number };
export function parseCall(args: unknown): Call {
	const parsed = callSchema.safeParse(args);
	if (!parsed.success) return { count: 0 };
	const { data } = parsed;
	const op = stringSchema.safeParse(data.op);
	const task = stringSchema.safeParse(data.task);
	const phase = stringSchema.safeParse(data.phase);
	const list = callListSchema.safeParse(data.list);
	const items = callItemsSchema.safeParse(data.items);
	return {
		op: op.success ? op.data : undefined,
		task: task.success ? task.data : undefined,
		phase: phase.success ? phase.data : undefined,
		count: list.success ? list.data.reduce((sum, entry) => sum + entry.items.length, 0) : items.success ? items.data.length : 0,
	};
}

// @upstream adapted @oh-my-pi/pi-utils@18.10.1 src/sanitize-text.ts#sanitizeText
const ESC_CHAR = "\x1b";
// biome-ignore lint/suspicious/noControlCharactersInRegex: render boundaries must strip terminal control characters.
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
const REPLACEMENT_CHAR = "\ufffd";
function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}
function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}
// @upstream-end

// @upstream verbatim @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#forDisplay
function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#phaseRomanNumeral
const ROMAN_PAIRS: readonly (readonly [number, string])[] = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];
function phaseRomanNumeral(index: number): string {
	let text = "";
	for (const [value, symbol] of ROMAN_PAIRS) {
		while (index >= value) {
			text += symbol;
			index -= value;
		}
	}
	return text;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#isClosedTodo
function isClosed(item: { status: TodoStatus }): boolean {
	return item.status === "completed" || item.status === "abandoned";
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#selectWithinCap
const COLLAPSED_ITEMS = 8;
function selectWithinCap(items: Item[]): { items: Item[]; summary: string } {
	if (items.length <= COLLAPSED_ITEMS + 1) return { items, summary: "" };
	const active = items.filter((item) => item.status === "in_progress");
	if (active.length > COLLAPSED_ITEMS) {
		const hidden = active.length - COLLAPSED_ITEMS;
		return { items: active.slice(0, COLLAPSED_ITEMS), summary: `… ${hidden} more active todo${hidden === 1 ? "" : "s"}` };
	}
	const firstActive = active[0];
	const start = firstActive === undefined ? 0 : items.indexOf(firstActive);
	const fill: Item[] = [];
	for (let index = start; index < items.length && active.length + fill.length < COLLAPSED_ITEMS; index++) {
		const item = items[index];
		if (item !== undefined && item.status !== "in_progress") fill.push(item);
	}
	const selected = [...active, ...fill];
	const hidden = items.length - selected.length;
	return { items: selected, summary: hidden > 0 ? `… ${hidden} more todo${hidden === 1 ? "" : "s"}` : "" };
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#selectCollapsedTodos
function selectCollapsed(items: Item[]): { items: Item[]; summary: string } {
	const open = items.filter((item) => !isClosed(item));
	if (open.length === 0) return selectWithinCap(items);
	const lead = items.filter(isClosed).slice(-1);
	const selected = selectWithinCap(open);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#computeTouchedPhases
function touchedPhases(call: Call, phases: Phase[], completed: NonNullable<TodoMoreDetails["completedTasks"]>): Set<string> | null {
	const touched = new Set<string>();
	for (const phase of phases) if (phase.items.some((item) => item.status === "in_progress")) touched.add(phase.name);
	for (const transition of completed) touched.add(transition.phase);
	if (call.op === "init") for (const phase of phases) touched.add(phase.name);
	if (call.phase && phases.some((phase) => phase.name === call.phase)) touched.add(call.phase);
	if (call.task) {
		const phase = phases.find((phase) => phase.items.some((item) => item.title === call.task));
		if (phase) touched.add(phase.name);
	}
	return touched.size > 0 ? touched : null;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#partialStrikethrough
function strike(text: string): string {
	return `\x1b[9m${text}\x1b[29m`;
}
function completionLabel(text: string, transitioned: boolean, frame: number | undefined): string {
	// Extensions do not always receive animation frames; without one leave the checked label plain.
	if (frame === undefined || !transitioned) return text;
	if (frame <= 2) return text;
	const chars = [...text];
	const count = Math.ceil((chars.length * Math.min(frame - 2, 12)) / 12);
	if (count >= chars.length) return strike(text);
	return `${strike(chars.slice(0, count).join(""))}${chars.slice(count).join("")}`;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#formatTodoLine
function formatItem(item: Item, theme: Theme, transitioned: boolean, frame: number | undefined): string {
	const text = forDisplay(item.title);
	let line: string;
	switch (item.status) {
		case "completed":
			line = theme.fg("success", `${theme.checkbox.checked} ${completionLabel(text, transitioned, frame)}`);
			break;
		case "in_progress":
			line = theme.fg("accent", `${theme.checkbox.unchecked} ${text}`);
			break;
		case "abandoned":
			line = theme.fg("error", `${theme.checkbox.unchecked} ${strike(text)}`);
			break;
		case "blocked": {
			const note = item.blocker ? `blocked: ${forDisplay(item.blocker)}` : "blocked";
			line = theme.fg("warning", `${theme.checkbox.unchecked} ${text} (${note})`);
			break;
		}
		case "pending":
			line = theme.fg("dim", `${theme.checkbox.unchecked} ${text}`);
			break;
		default: {
			const unreachable: never = item.status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
	const title = item.explanation === null ? `${line} ${theme.fg("warning", "[explanation missing]")}` : line;
	return `${title}\n${theme.fg(item.time.kind === "missing" ? "warning" : "dim", timeEstimateText(item.time))}`;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/render/status-line.ts#renderStatusLine
function statusLine(theme: Theme, icon: string, meta: string): string {
	return `${icon} ${theme.fg("accent", "Todo")}${meta ? ` ${theme.fg("dim", forDisplay(meta).replace(/\r\n?|\n/g, " "))}` : ""}`;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/render/output-block.ts#renderOutputBlock
/** Single-section, background-free frame using only public TUI primitives. */
function framedCard(theme: Theme, header: string, build: () => string[], error = false): Component {
	return {
		invalidate() {},
		render(width) {
			const box = theme.boxRound;
			const border = (text: string): string => theme.fg(error ? "error" : "borderMuted", text);
			const safeWidth = Math.max(1, width);
			const contentWidth = Math.max(1, safeWidth - 4);
			const left = `${box.topLeft}${box.horizontal.repeat(3)}`;
			const label = truncateToWidth(` ${header} `, Math.max(0, safeWidth - visibleWidth(left) - visibleWidth(box.topRight)));
			const fill = Math.max(0, safeWidth - visibleWidth(left) - visibleWidth(label) - visibleWidth(box.topRight));
			const lines = [`${border(left)}${label}${border(box.horizontal.repeat(fill) + box.topRight)}`];
			for (const line of build()) {
				for (const part of line.split("\n"))
					for (const wrapped of wrapTextWithAnsi(part.trimEnd(), contentWidth)) {
						lines.push(
							`${border(box.vertical)} ${wrapped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(wrapped)))} ${border(box.vertical)}`,
						);
					}
			}
			lines.push(border(`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, safeWidth - 2))}${box.bottomRight}`));
			return lines.map((line) => truncateToWidth(line, safeWidth, ""));
		},
	};
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#todoToolRenderer.renderCall
export function renderTodoCall(args: unknown, _options: ToolRenderResultOptions, theme: Theme): Component {
	const call = parseCall(args);
	const parts = [call.op ?? "update"];
	if (call.task) parts.push(call.task);
	if (call.phase) parts.push(call.phase);
	if (call.count > 0) parts.push(`${call.count} item${call.count === 1 ? "" : "s"}`);
	return new Text(statusLine(theme, theme.styledSymbol("status.pending", "muted"), parts.join(" ")), 0, 0);
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#todoToolRenderer.renderResult
export function renderTodoResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	args?: unknown,
): Component {
	const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const parsed = detailsSchema.safeParse(result.details);
	if (result.isError || !parsed.success) {
		const detail = forDisplay(text || (result.isError ? "Todo operation failed" : "Invalid todo-more result details"))
			.replace(/^Error:\s*/, "")
			.trim();
		return framedCard(theme, statusLine(theme, theme.styledSymbol("status.error", "error"), ""), () => [theme.fg("error", detail)], true);
	}
	const details: TodoMoreDetails = parsed.data;
	const phases = details.more.phases.filter((phase) => phase.items.length > 0);
	const completed = details.completedTasks ?? [];
	const completionKeys = new Set(completed.map((item) => `${item.phase}\u0000${item.content}`));
	const total = phases.reduce((sum, phase) => sum + phase.items.length, 0);
	const closed = phases.reduce((sum, phase) => sum + phase.items.filter(isClosed).length, 0);
	const header = statusLine(theme, theme.styledSymbol("tool.todo", "accent"), `${closed}/${total}`);
	if (total === 0) return new Text(`${header}\n  ${theme.fg("dim", "No todos")}`, 0, 0);
	const call = parseCall(args);
	const touched = touchedPhases({ ...call, op: call.op ?? details.op }, phases, completed);
	return framedCard(theme, header, () => {
		const lines: string[] = [];
		const { expanded, spinnerFrame } = options;
		if (details.more.goal === null) lines.push(theme.fg("warning", "Objective: [goal missing]"));
		else {
			const goal = goalLines(details.more.goal);
			for (const line of expanded ? goal : goal.slice(0, 1)) lines.push(theme.fg("dim", forDisplay(line)));
		}
		const multiPhase = phases.length > 1;
		for (let index = 0; index < phases.length; index++) {
			const phase = phases[index];
			if (phase === undefined) continue;
			const collapsed = !expanded && multiPhase && touched !== null && !touched.has(phase.name);
			const name = `${phaseRomanNumeral(index + 1)}. ${forDisplay(phase.name)}`;
			const progress = `${phase.items.filter(isClosed).length}/${phase.items.length}`;
			lines.push(`${theme.fg(collapsed ? "dim" : "accent", theme.bold(name))}${theme.fg("dim", `  ${progress}`)}`);
			if (collapsed) continue;
			const selection = expanded ? { items: phase.items, summary: "" } : selectCollapsed(phase.items);
			for (let row = 0; row < selection.items.length; row++) {
				const item = selection.items[row];
				if (item === undefined) continue;
				const last = row === selection.items.length - 1 && selection.summary === "";
				const branch = theme.fg("dim", last ? theme.tree.last : theme.tree.branch);
				const continued = last ? "   " : `${theme.tree.vertical}  `;
				const rendered = formatItem(item, theme, completionKeys.has(`${phase.name}\u0000${item.title}`), spinnerFrame).split("\n");
				for (let line = 0; line < rendered.length; line++)
					lines.push(`  ${line === 0 ? `${branch} ` : theme.fg("dim", continued)}${rendered[line] ?? ""}`);
				if (expanded && !isClosed(item)) {
					const explanation = forDisplay(item.explanation ?? "(no explanation yet: add one with op explain)");
					for (const line of explanation.split("\n")) lines.push(`  ${theme.fg("dim", continued)}  ${theme.fg("dim", line)}`);
				}
			}
			if (selection.summary) lines.push(`  ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", selection.summary)}`);
		}
		return lines;
	});
}
// @upstream-end
