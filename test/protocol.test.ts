import { describe, expect, test } from "bun:test";
import { parseTodo, previewTodo, type TodoCommand } from "../src/protocol.ts";

const init = 'INIT "Ship streaming todos" "One accepted snapshot" "All requested tasks are represented"';
const goal = {
	objective: "Ship streaming todos",
	measure: "One accepted snapshot",
	doneWhen: "All requested tasks are represented",
};

function document(...lines: string[]): string {
	return ["*** Begin Todo", ...lines, "*** End Todo"].join("\n");
}

function expectInvalid(input: string): void {
	const parsed = parseTodo(input);
	expect(parsed.kind).toBe("invalid");
	if (parsed.kind !== "invalid") throw new Error("Expected the complete document to be rejected");
}

describe("Todo document consumption", () => {
	test("parses a complete phased initialization in task and phase order", () => {
		expect(
			parseTodo(
				document(
					init,
					'PHASE "Delivery"',
					'ADD "Implement" "Consume the document"',
					'ADD "Review" "Inspect saved fields"',
					'PHASE "Verification"',
					'ADD "Exercise" "Use the real tool"',
				),
			),
		).toEqual({
			kind: "ok",
			commands: [
				{ kind: "init", goal },
				{ kind: "phase", name: "Delivery" },
				{ kind: "add", title: "Implement", explanation: "Consume the document" },
				{ kind: "add", title: "Review", explanation: "Inspect saved fields" },
				{ kind: "phase", name: "Verification" },
				{ kind: "add", title: "Exercise", explanation: "Use the real tool" },
			],
		});
	});

	test("parses flat initialization without inventing a phase command for default Tasks", () => {
		expect(parseTodo(`${document(init, 'ADD "First" "First acceptance"', 'ADD "Second" "Second acceptance"')}\n`)).toEqual({
			kind: "ok",
			commands: [
				{ kind: "init", goal },
				{ kind: "add", title: "First", explanation: "First acceptance" },
				{ kind: "add", title: "Second", explanation: "Second acceptance" },
			],
		});
	});

	test("decodes JSON escapes without trimming, splitting, or changing complete task identity", () => {
		const title = '  检查 "quoted" \\ path\nnext\tline 🧪  ';
		const explanation = 'Measure\r\nall fields: "yes" \\ done';
		expect(parseTodo(document(`EXPLAIN ${JSON.stringify(title)} ${JSON.stringify(explanation)}`))).toEqual({
			kind: "ok",
			commands: [{ kind: "explain", title, explanation }],
		});
		expect(parseTodo(document(String.raw`START "\u68c0\u67e5 \ud83e\uddea\nline"`))).toEqual({
			kind: "ok",
			commands: [{ kind: "start", title: "检查 🧪\nline" }],
		});
	});

	test("accepts CRLF documents and distinguishes title, phase, and ALL selectors", () => {
		const input = document(
			'DONE "ALL"',
			'DROP PHASE "Delivery"',
			"RM ALL",
			'BLOCK "Wait" "Waiting for service"',
			'UNBLOCK PHASE "Verification"',
		).replaceAll("\n", "\r\n");
		expect(parseTodo(input)).toEqual({
			kind: "ok",
			commands: [
				{ kind: "done", target: { kind: "task", title: "ALL" } },
				{ kind: "drop", target: { kind: "phase", name: "Delivery" } },
				{ kind: "rm", target: { kind: "all" } },
				{ kind: "block", target: { kind: "task", title: "Wait" }, reason: "Waiting for service" },
				{ kind: "unblock", target: { kind: "phase", name: "Verification" } },
			],
		});
	});

	const invalidDocuments = [
		{ label: "empty command list", input: document() },
		{ label: "missing begin envelope", input: "VIEW\n*** End Todo" },
		{ label: "missing end envelope", input: "*** Begin Todo\nVIEW\n" },
		{ label: "unfinished final command", input: '*** Begin Todo\nSTART "Task' },
		{ label: "unfinished end envelope", input: "*** Begin Todo\nVIEW\n*** End Tod" },
		{ label: "trailing command", input: `${document("VIEW")}\nSTART "Task"\n` },
		{ label: "trailing text without newline", input: `${document("VIEW")}garbage` },
		{ label: "extra blank line after envelope", input: `${document("VIEW")}\n\n` },
		{ label: "unquoted task identity", input: document("START Task") },
		{ label: "unterminated quote", input: document('START "Task') },
		{ label: "unsupported JSON escape", input: document(String.raw`START "bad\q"`) },
		{ label: "malformed unicode escape", input: document(String.raw`START "bad\u123"`) },
		{ label: "literal newline inside quoted title", input: document('START "Task\nnext"') },
		{ label: "adjacent quoted arguments", input: document('EXPLAIN "Task""Reason"') },
		{ label: "extra argument", input: document('START "Task" "extra"') },
		{ label: "unknown command", input: document('APPEND "Task" "Reason"') },
		{ label: "lowercase command", input: document('start "Task"') },
		{ label: "duplicate INIT", input: document(init, 'ADD "Task" "Reason"', init) },
		{ label: "INIT after another command", input: document('START "Task"', init) },
		{ label: "VIEW mixed with mutations", input: document("VIEW", 'DONE "Task"') },
		{ label: "VIEW following mutations", input: document('DONE "Task"', "VIEW") },
		{ label: "BLOCK ALL", input: document("BLOCK ALL") },
		{ label: "UNBLOCK ALL", input: document("UNBLOCK ALL") },
		{ label: "empty task selector", input: document('DONE ""') },
		{ label: "empty phase selector", input: document('RM PHASE ""') },
	];
	for (const { label, input } of invalidDocuments) {
		test(`rejects ${label} instead of accepting its valid prefix`, () => expectInvalid(input));
	}
});

describe("streamed Todo intent preview", () => {
	test("only newline-complete commands become preview intent", () => {
		const prefix = `*** Begin Todo\n${init}\n`;
		const addition = 'ADD "Task with \\"quotes\\"" "Acceptance"';
		const expected: TodoCommand[] = [{ kind: "init", goal }];
		for (let length = 0; length <= addition.length; length++) {
			expect(previewTodo(prefix + addition.slice(0, length))).toEqual({
				commands: expected,
				pending: addition.slice(0, length),
				complete: false,
			});
		}
		expect(previewTodo(`${prefix}${addition}\n`)).toEqual({
			commands: [...expected, { kind: "add", title: 'Task with "quotes"', explanation: "Acceptance" }],
			pending: "",
			complete: false,
		});
	});

	test("an incomplete malformed suffix stays pending until its line is complete", () => {
		const prefix = `*** Begin Todo\n${init}\n`;
		expect(previewTodo(`${prefix}START not-quoted`)).toEqual({
			commands: [{ kind: "init", goal }],
			pending: "START not-quoted",
			complete: false,
		});
		const invalid = previewTodo(`${prefix}START not-quoted\n`);
		expect(invalid.commands).toEqual([{ kind: "init", goal }]);
		expect(invalid.complete).toBe(false);
		expect(invalid.error).toContain("Line 3");
		expectInvalid(`${prefix}START not-quoted\n*** End Todo`);
	});

	test("completion requires the end envelope, with or without its final newline", () => {
		const input = document(init, 'ADD "Task" "Acceptance"');
		for (const suffix of ["", "\n"]) {
			const preview = previewTodo(input + suffix);
			expect(preview.complete).toBe(true);
			expect(preview.error).toBeUndefined();
			expect(preview.commands).toHaveLength(2);
			expect(parseTodo(input + suffix)).toEqual({ kind: "ok", commands: preview.commands });
		}
		expect(previewTodo(input.replace("*** End Todo", "*** End To")).complete).toBe(false);
	});
});
