import { z } from "@oh-my-pi/pi-coding-agent";
import { estimatedMinutesSchema, type TodoGoal } from "./state.ts";

export const parametersSchema = z.object({ input: z.string().describe("Complete Todo document; batch related changes in one call") });

/** Like OMP edit's customFormat, with the same {input} function-tool representation. */
export const customFormat = {
	syntax: "lark" as const,
	definition: String.raw`start: "*** Begin Todo" LF command+ "*** End Todo" LF?
?command: "INIT" SP string SP string SP string LF
    | "GOAL" SP string SP string SP string LF
    | "PHASE" SP string LF
    | "ADD" SP string SP string SP MINUTES LF
    | "START" SP string LF
    | "EXPLAIN" SP string SP string LF
    | "ESTIMATE" SP string SP MINUTES LF
    | ("DONE" | "DROP" | "RM") SP target LF
    | "UNBLOCK" SP block_target LF
    | "BLOCK" SP block_target (SP string)? LF
    | "VIEW" LF
?target: string | "PHASE" SP string | "ALL"
?block_target: string | "PHASE" SP string
string: /"(?:[^"\\\x00-\x1f]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/
MINUTES: /[1-9][0-9]*/
SP: /[ \t]+/
LF: /\r?\n/`,
};

export type TodoTarget = { kind: "task"; title: string } | { kind: "phase"; name: string } | { kind: "all" };
export type TodoCommand =
	| { kind: "init" | "goal"; goal: TodoGoal }
	| { kind: "phase"; name: string }
	| { kind: "add"; title: string; explanation: string; estimatedMinutes: number }
	| { kind: "start"; title: string }
	| { kind: "explain"; title: string; explanation: string }
	| { kind: "estimate"; title: string; estimatedMinutes: number }
	| { kind: "done" | "drop" | "rm"; target: TodoTarget }
	| { kind: "unblock"; target: Exclude<TodoTarget, { kind: "all" }> }
	| { kind: "block"; target: Exclude<TodoTarget, { kind: "all" }>; reason?: string }
	| { kind: "view" };
export type TodoProgram = { kind: "ok"; commands: TodoCommand[] } | { kind: "invalid"; message: string };
export type TodoPreview = { commands: TodoCommand[]; pending: string; complete: boolean; error?: string };

type Token = { kind: "string"; value: string } | { kind: "word"; value: string } | { kind: "minutes"; value: number };
type Tokens = { kind: "ok"; tokens: Token[] } | { kind: "invalid"; message: string };
type ParsedLine = { kind: "ok"; command: TodoCommand } | { kind: "invalid"; message: string };

function tokenize(line: string): Tokens {
	const tokens: Token[] = [];
	let offset = 0;
	while (offset < line.length) {
		const rest = line.slice(offset);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON strings cannot contain raw control characters.
		const quoted = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(rest);
		const word = quoted ? undefined : /^[A-Z]+/.exec(rest);
		const minutes = quoted || word ? undefined : /^[1-9][0-9]*/.exec(rest);
		if (quoted) {
			const value: unknown = JSON.parse(quoted[0]);
			if (typeof value !== "string") return { kind: "invalid", message: "Expected a quoted JSON string" };
			tokens.push({ kind: "string", value });
			offset += quoted[0].length;
		} else if (word) {
			tokens.push({ kind: "word", value: word[0] });
			offset += word[0].length;
		} else if (minutes) {
			const parsed = estimatedMinutesSchema.safeParse(Number(minutes[0]));
			if (!parsed.success) return { kind: "invalid", message: "Estimate must be a supported positive integer minute value" };
			tokens.push({ kind: "minutes", value: parsed.data });
			offset += minutes[0].length;
		} else return { kind: "invalid", message: "Expected a command, selector, quoted JSON string, or positive integer estimate" };
		if (offset === line.length) break;
		const space = /^[ \t]+/.exec(line.slice(offset));
		if (!space) return { kind: "invalid", message: "Separate arguments with spaces" };
		offset += space[0].length;
		if (offset === line.length) return { kind: "invalid", message: "Unexpected trailing whitespace" };
	}
	return { kind: "ok", tokens };
}

function targetOf(tokens: Token[]): TodoTarget | undefined {
	if (tokens.length === 1) {
		const token = tokens[0];
		if (token?.kind === "string" && token.value.length > 0) return { kind: "task", title: token.value };
		if (token?.kind === "word" && token.value === "ALL") return { kind: "all" };
	}
	if (
		tokens.length === 2 &&
		tokens[0]?.kind === "word" &&
		tokens[0].value === "PHASE" &&
		tokens[1]?.kind === "string" &&
		tokens[1].value.length > 0
	) {
		return { kind: "phase", name: tokens[1].value };
	}
	return undefined;
}

function parseLine(line: string): ParsedLine {
	const parsed = tokenize(line);
	if (parsed.kind === "invalid") return parsed;
	const [head, ...args] = parsed.tokens;
	if (head?.kind !== "word") return { kind: "invalid", message: "Expected an uppercase command" };
	const strings = args.filter((token) => token.kind === "string").map((token) => token.value);
	const onlyStrings = strings.length === args.length;
	switch (head.value) {
		case "INIT":
		case "GOAL":
			if (onlyStrings && strings.length === 3) {
				return {
					kind: "ok",
					command: {
						kind: head.value === "INIT" ? "init" : "goal",
						goal: { objective: strings[0]!, measure: strings[1]!, doneWhen: strings[2]! },
					},
				};
			}
			break;
		case "PHASE":
			if (onlyStrings && strings.length === 1) return { kind: "ok", command: { kind: "phase", name: strings[0]! } };
			break;
		case "ADD":
			if (args.length === 3 && args[0]?.kind === "string" && args[1]?.kind === "string" && args[2]?.kind === "minutes") {
				return { kind: "ok", command: { kind: "add", title: args[0].value, explanation: args[1].value, estimatedMinutes: args[2].value } };
			}
			break;
		case "EXPLAIN":
			if (onlyStrings && strings.length === 2) {
				return { kind: "ok", command: { kind: "explain", title: strings[0]!, explanation: strings[1]! } };
			}
			break;
		case "ESTIMATE":
			if (args.length === 2 && args[0]?.kind === "string" && args[1]?.kind === "minutes") {
				return { kind: "ok", command: { kind: "estimate", title: args[0].value, estimatedMinutes: args[1].value } };
			}
			break;
		case "START":
			if (onlyStrings && strings.length === 1) return { kind: "ok", command: { kind: "start", title: strings[0]! } };
			break;
		case "DONE":
		case "DROP":
		case "RM": {
			const target = targetOf(args);
			if (target) {
				const kind = { DONE: "done", DROP: "drop", RM: "rm" } as const;
				return { kind: "ok", command: { kind: kind[head.value], target } };
			}
			break;
		}
		case "UNBLOCK": {
			const target = targetOf(args);
			if (target && target.kind !== "all") return { kind: "ok", command: { kind: "unblock", target } };
			break;
		}
		case "BLOCK": {
			const width = args[0]?.kind === "word" && args[0].value === "PHASE" ? 2 : 1;
			const target = targetOf(args.slice(0, width));
			const reason = args[width];
			if (target && target.kind !== "all" && (args.length === width || (args.length === width + 1 && reason?.kind === "string"))) {
				return { kind: "ok", command: { kind: "block", target, ...(reason?.kind === "string" ? { reason: reason.value } : {}) } };
			}
			break;
		}
		case "VIEW":
			if (args.length === 0) return { kind: "ok", command: { kind: "view" } };
			break;
	}
	return { kind: "invalid", message: `Invalid ${head.value} command or arguments` };
}

/** Pure display-only intent. Only newline-terminated commands are interpreted while generating. */
export function previewTodo(input: string): TodoPreview {
	const lines = input.split("\n");
	const pending = lines.pop() ?? "";
	const commands: TodoCommand[] = [];
	if (lines.length === 0) return { commands, pending, complete: false };
	if (lines[0]?.replace(/\r$/, "") !== "*** Begin Todo") return { commands, pending, complete: false, error: "Expected *** Begin Todo" };
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index]!.replace(/\r$/, "");
		if (line === "*** End Todo") {
			return index === lines.length - 1 && pending === ""
				? { commands, pending: "", complete: true }
				: { commands, pending, complete: false, error: "Unexpected text after *** End Todo" };
		}
		const parsed = parseLine(line);
		if (parsed.kind === "invalid") return { commands, pending, complete: false, error: `Line ${index + 1}: ${parsed.message}` };
		commands.push(parsed.command);
	}
	return { commands, pending, complete: pending === "*** End Todo" };
}

/** Final execution always reparses; an unfinished or invalid suffix rejects the whole call. */
export function parseTodo(input: string): TodoProgram {
	const preview = previewTodo(input);
	if (preview.error) return { kind: "invalid", message: preview.error };
	if (!preview.complete) return { kind: "invalid", message: "Expected complete *** Begin Todo / *** End Todo document" };
	if (preview.commands.length === 0) return { kind: "invalid", message: "Todo document needs at least one command" };
	if (preview.commands.some((command) => command.kind === "view") && preview.commands.length !== 1) {
		return { kind: "invalid", message: "VIEW must be the only command" };
	}
	if (preview.commands.some((command, index) => command.kind === "init" && index !== 0)) {
		return { kind: "invalid", message: "INIT must be the first command and may appear only once" };
	}
	return { kind: "ok", commands: preview.commands };
}
