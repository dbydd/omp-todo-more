import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type Component,
	col,
	Editor,
	FormField,
	getEditorTheme,
	matchesKey,
	type NativeChild,
	type NativeNode,
	type NativeUiEvent,
	node,
	span,
	Text,
	type Theme,
} from "@oh-my-pi/pi-tui";
import { saveTodoEdit, type TodoEdit } from "./edit.ts";
import { errorText } from "./errors.ts";
import { describeSnapshot } from "./native.ts";
import { goalLines, readTodoMore, toSnapshot } from "./state.ts";

const FIELDS = ["objective", "measure", "doneWhen"] as const;
type GoalField = (typeof FIELDS)[number];
const LABELS: Record<GoalField, string> = { objective: "Objective", measure: "Measure", doneWhen: "Done when" };
type DraftField = { editor: Editor; field: FormField };
type Mode =
	| { kind: "panel"; selected: number }
	| { kind: "goal"; fields: Record<GoalField, DraftField>; active: GoalField }
	| { kind: "explanation"; title: string; draft: DraftField };

/** One overlay owns its drafts; neither a historical tool card nor the opening snapshot can be saved. */
class TodoPanel implements Component {
	private mode: Mode = { kind: "panel", selected: 0 };
	private error: string | undefined;
	private described: NativeNode | undefined;
	private leaf: string | undefined;
	private disposed = false;
	focused = true;
	readonly nativeOverlay = { role: "todo-more.panel", size: "lg" as const, anchor: "center" as const };

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly session: AgentSession,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly signal: AbortSignal,
	) {}

	private changed(): void {
		this.described = undefined;
		this.requestRender();
	}

	private makeField(label: string, text: string): DraftField {
		const editor = new Editor(getEditorTheme());
		editor.disableSubmit = true;
		editor.setText(text);
		editor.setMaxHeight(6);
		editor.onChange = () => this.changed();
		const field = new FormField(editor, {
			label,
			theme: {
				label: (value) => this.theme.bold(value),
				description: (value) => this.theme.fg("muted", value),
				error: (value) => this.theme.fg("error", value),
				hint: (value) => this.theme.fg("muted", value),
			},
		});
		return { editor, field };
	}

	private discardDraft(): void {
		switch (this.mode.kind) {
			case "panel":
				break;
			case "goal":
				for (const name of FIELDS) this.mode.fields[name].field.dispose();
				break;
			case "explanation":
				this.mode.draft.field.dispose();
				break;
			default: {
				const unreachable: never = this.mode;
				throw new Error(String(unreachable));
			}
		}
	}

	private openGoal(): void {
		const state = readTodoMore(this.session.sessionManager.getBranch());
		if (state.kind === "empty") {
			this.error = "Todo list is empty.";
			this.changed();
			return;
		}
		const goal = state.goal.kind === "set" ? state.goal.goal : { objective: "", measure: "", doneWhen: "" };
		this.discardDraft();
		this.mode = {
			kind: "goal",
			active: "objective",
			fields: {
				objective: this.makeField("Objective", goal.objective),
				measure: this.makeField("Measure", goal.measure),
				doneWhen: this.makeField("Done when", goal.doneWhen),
			},
		};
		this.error = undefined;
		this.changed();
	}

	private openExplanation(title: string): void {
		const state = readTodoMore(this.session.sessionManager.getBranch());
		if (state.kind === "empty") {
			this.error = "Todo list is empty.";
			this.changed();
			return;
		}
		const item = state.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === title);
		if (!item) {
			this.error = `Task "${title}" not found`;
			this.changed();
			return;
		}
		this.discardDraft();
		this.mode = {
			kind: "explanation",
			title,
			draft: this.makeField(`Explanation: ${title}`, item.explanation.kind === "explained" ? item.explanation.text : ""),
		};
		this.error = undefined;
		this.changed();
	}

	private close(): void {
		if (this.mode.kind === "panel") this.done();
		else {
			this.discardDraft();
			this.mode = { kind: "panel", selected: 0 };
			this.error = undefined;
			this.changed();
		}
	}

	private save(): void {
		if (this.disposed || this.signal.aborted) return;
		let edit: TodoEdit;
		switch (this.mode.kind) {
			case "panel":
				return;
			case "goal":
				edit = {
					kind: "set_goal",
					goal: {
						objective: this.mode.fields.objective.editor.getExpandedText(),
						measure: this.mode.fields.measure.editor.getExpandedText(),
						doneWhen: this.mode.fields.doneWhen.editor.getExpandedText(),
					},
				};
				break;
			case "explanation":
				edit = { kind: "explain", title: this.mode.title, explanation: this.mode.draft.editor.getExpandedText() };
				break;
			default: {
				const unreachable: never = this.mode;
				throw new Error(String(unreachable));
			}
		}
		const result = saveTodoEdit(this.pi, this.session, edit);
		switch (result.kind) {
			case "saved":
				this.discardDraft();
				this.mode = { kind: "panel", selected: 0 };
				this.error = undefined;
				break;
			case "failed":
			case "rejected":
				this.error = result.message;
				break;
			default: {
				const unreachable: never = result;
				throw new Error(String(unreachable));
			}
		}
		this.changed();
	}

	describe(): NativeNode {
		const branch = this.session.sessionManager.getBranch();
		if (this.leaf !== branch.at(-1)?.id) {
			this.leaf = branch.at(-1)?.id;
			this.described = undefined;
		}
		if (this.described) return this.described;
		const body: NativeChild[] = [];
		let role: string;
		let head: string;
		switch (this.mode.kind) {
			case "panel": {
				role = "todo-more.panel";
				head = "Todo More";
				body.push(this.button("Edit goal", "todo-more.goal"), ...describeSnapshot(toSnapshot(readTodoMore(branch)), true));
				break;
			}
			case "goal": {
				role = "todo-more.goal-editor";
				head = "Edit goal";
				for (const name of FIELDS) {
					const draft = this.mode.fields[name];
					draft.field.focused = this.focused && name === this.mode.active;
					body.push(
						name === this.mode.active
							? draft.field
							: node(
									"col",
									{ gap: "xs", actions: { click: `todo-more.field.${name}` } },
									[
										node("text", { spans: [span(LABELS[name], "strong")] }),
										node("text", { text: draft.editor.getExpandedText() || "[empty]", wrap: "word" }),
									],
									name,
								),
					);
				}
				break;
			}
			case "explanation":
				role = "todo-more.explanation-editor";
				head = `Edit explanation: ${this.mode.title}`;
				this.mode.draft.field.focused = this.focused;
				body.push(this.mode.draft.field);
				break;
			default: {
				const unreachable: never = this.mode;
				throw new Error(String(unreachable));
			}
		}
		if (this.error) body.push(node("text", { spans: [span(this.error, "error")], wrap: "word" }, undefined, "error"));
		body.push(
			node("text", {
				text:
					this.mode.kind === "panel"
						? "Tab / arrows select · Enter edit · Escape close"
						: "Enter newline · Tab / Shift+Tab field · Ctrl+Enter save · Escape cancel",
				wrap: "word",
			}),
		);
		body.push(
			col(
				this.mode.kind === "panel"
					? [this.button("Close", "close")]
					: [this.button("Save", "todo-more.save"), this.button("Cancel", "close")],
				{ gap: "xs" },
			),
		);
		this.described = node("card", { role, head }, body);
		return this.described;
	}

	private button(label: string, act: string): NativeNode {
		return node("row", { role: "omp.btn", actions: { click: act }, title: label }, [node("text", { text: label })], act);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.disposed || this.signal.aborted || event.type !== "action") return;
		if (event.act === "todo-more.save") this.save();
		else if (event.act === "close") this.close();
		else if (event.act === "todo-more.goal") this.openGoal();
		else if (event.act.startsWith("todo-more.explain:")) this.openExplanation(event.act.slice("todo-more.explain:".length));
		else if (this.mode.kind === "goal") {
			const name = FIELDS.find((field) => event.act === `todo-more.field.${field}`);
			if (name) {
				this.mode.active = name;
				this.changed();
			}
		}
	}

	handleInput(data: string): void {
		if (this.disposed || this.signal.aborted) return;
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		if (matchesKey(data, "ctrl+enter")) {
			this.save();
			return;
		}
		if (this.mode.kind === "panel") {
			const state = readTodoMore(this.session.sessionManager.getBranch());
			const titles = state.kind === "list" ? state.phases.flatMap((phase) => phase.items.map((item) => item.title)) : [];
			if (matchesKey(data, "tab") || matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % (titles.length + 2);
			else if (matchesKey(data, "shift+tab") || matchesKey(data, "up"))
				this.mode.selected = (this.mode.selected + titles.length + 1) % (titles.length + 2);
			else if (matchesKey(data, "enter")) {
				if (this.mode.selected === 0) this.openGoal();
				else {
					const title = titles[this.mode.selected - 1];
					if (title === undefined) this.close();
					else this.openExplanation(title);
				}
			}
			this.changed();
			return;
		}
		if (this.mode.kind === "goal" && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
			const index = FIELDS.indexOf(this.mode.active);
			this.mode.active = FIELDS[(index + (matchesKey(data, "shift+tab") ? 2 : 1)) % 3]!;
			this.changed();
			return;
		}
		const editor = this.mode.kind === "goal" ? this.mode.fields[this.mode.active].editor : this.mode.draft.editor;
		editor.handleInput(matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" ? "\n" : data);
		this.changed();
	}

	render(width: number): readonly string[] {
		const lines = [
			this.theme.bold(
				this.mode.kind === "panel" ? "Todo More" : this.mode.kind === "goal" ? "Edit goal" : `Edit explanation: ${this.mode.title}`,
			),
		];
		switch (this.mode.kind) {
			case "panel": {
				const state = readTodoMore(this.session.sessionManager.getBranch());
				const labels = ["Edit goal"];
				if (state.kind === "empty") lines.push("Todo list is empty.");
				else {
					lines.push(...(state.goal.kind === "set" ? goalLines(state.goal.goal) : ["Goal: [missing]"]));
					for (const phase of state.phases) {
						lines.push(phase.name);
						for (const item of phase.items) {
							lines.push(
								`${item.title} [${item.status}]`,
								item.explanation.kind === "explained" ? item.explanation.text : "[explanation missing]",
								`Blocker: ${item.blocker ?? "(none)"}`,
							);
							labels.push(`Edit explanation: ${item.title}`);
						}
					}
				}
				labels.push("Close");
				const selected = this.mode.selected;
				lines.push(...labels.map((label, index) => `${index === selected ? ">" : " "} ${label}`));
				break;
			}
			case "goal":
				for (const name of FIELDS) {
					this.mode.fields[name].field.focused = this.focused && name === this.mode.active;
					lines.push(...this.mode.fields[name].field.render(width));
				}
				break;
			case "explanation":
				this.mode.draft.field.focused = this.focused;
				lines.push(...this.mode.draft.field.render(width));
				break;
			default: {
				const unreachable: never = this.mode;
				throw new Error(String(unreachable));
			}
		}
		if (this.error) lines.push(this.theme.fg("error", this.error));
		lines.push("Ctrl+Enter save · Escape cancel/close · Tab next");
		return new Text(lines.join("\n"), 0, 0).render(width);
	}

	invalidate(): void {
		this.described = undefined;
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.discardDraft();
		this.described = undefined;
	}
}

export function registerUi(pi: ExtensionAPI): void {
	let active: { controller: AbortController; session: AgentSession } | undefined;
	const cancel = (): void => {
		active?.controller.abort();
		active = undefined;
	};
	pi.on("session_switch", cancel);
	pi.on("session_branch", cancel);
	pi.on("session_tree", cancel);
	pi.on("session_shutdown", cancel);
	pi.registerCommand("todo-more", {
		description: "Show rich todos and edit the current session's goal and explanations",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				pi.sendMessage({
					customType: "todo-more.ui-unavailable",
					content: "Todo More editor requires an interactive UI.",
					display: true,
					attribution: "agent",
				});
				return;
			}
			const session = AgentRegistry.global().get(ctx.agent.id)?.session;
			if (session == null || active) return;
			const opened = { controller: new AbortController(), session };
			active = opened;
			try {
				await ctx.ui.custom<void>(
					(tui, theme, _keys, done) =>
						new TodoPanel(
							pi,
							session,
							theme,
							() => tui.requestRender(),
							() => done(),
							opened.controller.signal,
						),
					{ overlay: true, signal: opened.controller.signal },
				);
			} catch (error) {
				// Session transitions abort the old overlay and discard its draft normally.
				if (!opened.controller.signal.aborted) {
					pi.logger.warn("todo-more UI failed", { error: errorText(error) });
					ctx.ui.notify(errorText(error), "error");
				}
			} finally {
				if (active === opened) active = undefined;
			}
		},
	});
}
