import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoSession } from "../src/commit.ts";
import { readTodoMore, TODO_MORE_ENTRY_TYPE, type TodoGoal, type TodoMoreSnapshot, toSnapshot } from "../src/state.ts";
import { runTodo, type TodoMoreDetails } from "../src/tool.ts";

const goal: TodoGoal = {
	objective: "Ship atomic streaming todos",
	measure: "Every call publishes one accepted state",
	doneWhen: "Tasks, explanations and goal survive the complete batch",
};
const init = `INIT ${JSON.stringify(goal.objective)} ${JSON.stringify(goal.measure)} ${JSON.stringify(goal.doneWhen)}`;

function document(...lines: string[]): string {
	return ["*** Begin Todo", ...lines, "*** End Todo"].join("\n");
}

type Fixture = {
	session: TodoSession;
	projections: HostTodoPhase[][];
	snapshot: () => TodoMoreSnapshot;
	snapshots: () => SessionEntry[];
	call: (...lines: string[]) => AgentToolResult<TodoMoreDetails>;
};

/** Actual branch persistence, with only the unrelated AgentSession host projection captured. */
function fixture(initial?: TodoMoreSnapshot): Fixture {
	const sessionManager = SessionManager.inMemory("/tmp/todo-more-tool-tests");
	const projections: HostTodoPhase[][] = [];
	const session: TodoSession = {
		sessionManager,
		setTodoPhases: (phases) => {
			projections.push(phases);
		},
	};
	if (initial !== undefined) sessionManager.appendCustomEntry(TODO_MORE_ENTRY_TYPE, initial);
	return {
		session,
		projections,
		snapshot: () => toSnapshot(readTodoMore(sessionManager.getBranch())),
		snapshots: () => sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TODO_MORE_ENTRY_TYPE),
		call: (...lines: string[]) => runTodo(session, { input: document(...lines) }),
	};
}

function expectSaved(
	harness: Fixture,
	result: AgentToolResult<TodoMoreDetails>,
	expected: TodoMoreSnapshot,
	previousSnapshots: number,
	previousProjections: number,
): void {
	expect(result.isError).not.toBe(true);
	expect(harness.snapshot()).toEqual(expected);
	expect(result.details?.more).toEqual(expected);
	expect(harness.snapshots()).toHaveLength(previousSnapshots + 1);
	expect(harness.projections).toHaveLength(previousProjections + 1);
}

function expectRejected(harness: Fixture, invoke: () => AgentToolResult<TodoMoreDetails>): AgentToolResult<TodoMoreDetails> {
	const before = harness.snapshot();
	const entries = harness.session.sessionManager.getBranch();
	const projections = harness.projections.length;
	const result = invoke();
	expect(result.isError).toBe(true);
	expect(result.details?.more).toEqual(before);
	expect(harness.snapshot()).toEqual(before);
	expect(harness.session.sessionManager.getBranch()).toEqual(entries);
	expect(harness.projections).toHaveLength(projections);
	return result;
}

function populated(): TodoMoreSnapshot {
	return {
		goal,
		phases: [
			{
				name: "Delivery",
				items: [
					{ title: "Implement", explanation: "Consume complete commands", status: "in_progress" },
					{ title: "Review", explanation: "Review original behavior", status: "pending" },
				],
			},
			{
				name: "Verification",
				items: [
					{ title: "Runtime", explanation: "Use the real host", status: "blocked", blocker: "Waiting for credentials" },
					{ title: "Already checked", explanation: "Retain earlier evidence", status: "completed" },
					{ title: "Old approach", explanation: "Keep historical scope", status: "abandoned" },
				],
			},
		],
	};
}

describe("atomic Todo document execution", () => {
	test("flat initialization with multiple tasks appends exactly one snapshot and defaults to Tasks", () => {
		const harness = fixture();
		const result = harness.call(init, 'ADD "Implement" "Consume the text document"', 'ADD "Review" "Check all fields"');
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Tasks",
						items: [
							{ title: "Implement", explanation: "Consume the text document", status: "in_progress" },
							{ title: "Review", explanation: "Check all fields", status: "pending" },
						],
					},
				],
			},
			0,
			0,
		);
		expect(result.details?.op).toBe("init");
	});

	test("task identity survives escaped quotes, unicode, newlines and surrounding whitespace across one batch", () => {
		const harness = fixture();
		const title = '  检查 "quoted" \\ path\nnext 🧪  ';
		const quoted = JSON.stringify(title);
		expectSaved(
			harness,
			harness.call(init, `ADD ${quoted} "Original explanation"`, `EXPLAIN ${quoted} "Accepted explanation"`, `DONE ${quoted}`),
			{
				goal,
				phases: [{ name: "Tasks", items: [{ title, explanation: "Accepted explanation", status: "completed" }] }],
			},
			0,
			0,
		);
	});

	for (const commands of [
		[init],
		[init, 'PHASE "Empty phase"'],
		[init, 'ADD "Repeated" "First"', 'ADD "Repeated" "Duplicate"'],
		[init, 'PHASE "Repeated"', 'ADD "First" "First"', 'PHASE "Repeated"', 'ADD "Second" "Second"'],
		[init, 'ADD "" "No title"'],
		[init, 'ADD "No explanation" "  "'],
	]) {
		test(`invalid initialization cannot replace an existing list: ${commands.slice(1).join("; ") || "no tasks"}`, () => {
			const harness = fixture(populated());
			expectRejected(harness, () => harness.call(...commands));
		});
	}

	test("phased initialization normalizes across all tasks only after assembling its phases", () => {
		const harness = fixture();
		expectSaved(
			harness,
			harness.call(
				init,
				'PHASE "Delivery"',
				'ADD "Implement" "Build the behavior"',
				'ADD "Review" "Inspect changes"',
				'PHASE "Verification"',
				'ADD "Runtime" "Exercise the host"',
			),
			{
				goal,
				phases: [
					{
						name: "Delivery",
						items: [
							{ title: "Implement", explanation: "Build the behavior", status: "in_progress" },
							{ title: "Review", explanation: "Inspect changes", status: "pending" },
						],
					},
					{ name: "Verification", items: [{ title: "Runtime", explanation: "Exercise the host", status: "pending" }] },
				],
			},
			0,
			0,
		);
	});

	test("DONE, START, EXPLAIN and phase additions publish one snapshot preserving unrelated rich fields", () => {
		const initial = populated();
		const harness = fixture(initial);
		const result = harness.call(
			'DONE "Implement"',
			'START "Review"',
			'EXPLAIN "Review" "Inspect the final accepted fields"',
			'PHASE "Delivery"',
			'ADD "Polish" "Finish the existing phase"',
			'PHASE "Release"',
			'ADD "Publish" "Deliver the accepted result"',
		);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Delivery",
						items: [
							{ title: "Implement", explanation: "Consume complete commands", status: "completed" },
							{ title: "Review", explanation: "Inspect the final accepted fields", status: "in_progress" },
							{ title: "Polish", explanation: "Finish the existing phase", status: "pending" },
						],
					},
					initial.phases[1]!,
					{ name: "Release", items: [{ title: "Publish", explanation: "Deliver the accepted result", status: "pending" }] },
				],
			},
			1,
			0,
		);
		expect(result.details?.op).toBe("batch");
		expect(result.details?.operations).toEqual(["done", "start", "explain", "append", "append"]);
		expect(result.details?.completedTasks).toEqual([{ phase: "Delivery", content: "Implement" }]);
	});

	for (const lateCommand of [
		'START "Missing task"',
		'EXPLAIN "Review" "  "',
		'GOAL "" "Measured" "Complete"',
		'PHASE "Delivery"\nADD "Review" "Duplicate title"',
	]) {
		test(`late error discards an otherwise valid mutation prefix: ${lateCommand}`, () => {
			const harness = fixture(populated());
			expectRejected(harness, () => harness.call('DONE "Implement"', 'EXPLAIN "Review" "Would be replaced"', lateCommand));
			expect(harness.snapshots()).toHaveLength(1);
		});
	}

	test("a late target error discards goal, append and blocker changes together", () => {
		const harness = fixture(populated());
		expectRejected(harness, () =>
			harness.call(
				'GOAL "Replacement" "New measure" "New boundary"',
				'PHASE "Release"',
				'ADD "Publish" "New scope"',
				'BLOCK "Implement" "New dependency"',
				'UNBLOCK "Runtime"',
				'RM "Missing task"',
			),
		);
		expect(harness.snapshots()).toHaveLength(1);
	});

	test("normalizes each operation rather than only the final batch state", () => {
		const harness = fixture(populated());
		const expected = populated();
		expected.phases[0]!.items[0]!.status = "pending";
		expected.phases[0]!.items[1]!.status = "in_progress";
		expectSaved(harness, harness.call('BLOCK "Implement" "Wait"', 'UNBLOCK "Implement"'), expected, 1, 0);
	});

	test("GOAL replaces only goal fields without normalizing imported task statuses", () => {
		const initial = populated();
		initial.phases[0]!.items[1]!.status = "in_progress";
		const harness = fixture(initial);
		const replacement: TodoGoal = { objective: "New objective", measure: "New measure", doneWhen: "New done boundary" };
		expectSaved(
			harness,
			harness.call('GOAL "New objective" "New measure" "New done boundary"'),
			{ goal: replacement, phases: initial.phases },
			1,
			0,
		);
	});

	test("missing goal must be restored by GOAL before another operation in the same batch", () => {
		const initial = populated();
		initial.goal = null;
		const harness = fixture(initial);
		expectRejected(harness, () => harness.call('EXPLAIN "Review" "Updated"', 'GOAL "New" "Measured" "Complete"'));
		const expected = populated();
		expected.goal = { objective: "New", measure: "Measured", doneWhen: "Complete" };
		expected.phases[0]!.items[1]!.explanation = "Updated";
		expectSaved(harness, harness.call('GOAL "New" "Measured" "Complete"', 'EXPLAIN "Review" "Updated"'), expected, 1, 0);
	});

	test("GOAL on an empty list cannot manufacture a list or a saved goal", () => {
		const harness = fixture();
		expectRejected(harness, () => harness.call('GOAL "New" "Measured" "Complete"'));
		expect(harness.snapshots()).toHaveLength(0);
	});

	test("BLOCK PHASE skips closed tasks, normalizes its reason, and UNBLOCK PHASE removes blockers", () => {
		const harness = fixture(populated());
		const blocked = populated();
		blocked.phases[0]!.items = blocked.phases[0]!.items.map((item) => ({ ...item, status: "blocked", blocker: "Waiting for service" }));
		expectSaved(harness, harness.call('BLOCK PHASE "Delivery" "  Waiting\\n for\\tservice  "'), blocked, 1, 0);
		const restored = populated();
		expectSaved(harness, harness.call('UNBLOCK PHASE "Delivery"'), restored, 2, 1);
		const allBlocked = populated();
		allBlocked.phases[0]!.items = allBlocked.phases[0]!.items.map((item) => ({ ...item, status: "blocked" }));
		expectSaved(harness, harness.call('BLOCK "Implement"', 'BLOCK "Review"'), allBlocked, 3, 2);
	});

	test("BLOCK and UNBLOCK leave completed and abandoned targets unchanged", () => {
		const harness = fixture(populated());
		const result = harness.call(
			'BLOCK "Already checked" "Not a new dependency"',
			'BLOCK "Old approach"',
			'UNBLOCK "Already checked"',
			'UNBLOCK "Old approach"',
		);
		expect(result.isError).not.toBe(true);
		expect(harness.snapshot()).toEqual(populated());
		expect(harness.snapshots()).toHaveLength(1);
		expect(harness.projections).toHaveLength(1);
	});

	test("quoted ALL selects a task, while DONE ALL selects all phases", () => {
		const initial: TodoMoreSnapshot = {
			goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{ title: "ALL", explanation: "A literal task title", status: "in_progress" },
						{ title: "Other", explanation: "Not selected by quoted ALL", status: "pending" },
					],
				},
				{ name: "Verification", items: [{ title: "Last", explanation: "Another phase", status: "blocked", blocker: "Wait" }] },
			],
		};
		const harness = fixture(initial);
		const selected: TodoMoreSnapshot = {
			goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{ title: "ALL", explanation: "A literal task title", status: "completed" },
						{ title: "Other", explanation: "Not selected by quoted ALL", status: "in_progress" },
					],
				},
				initial.phases[1]!,
			],
		};
		expectSaved(harness, harness.call('DONE "ALL"'), selected, 1, 0);
		expectSaved(
			harness,
			harness.call("DONE ALL"),
			{
				goal,
				phases: selected.phases.map((phase) => ({ ...phase, items: phase.items.map((item) => ({ ...item, status: "completed" })) })),
			},
			2,
			1,
		);
	});

	test("DROP PHASE and RM PHASE affect only the selected phase", () => {
		const initial = populated();
		const harness = fixture(initial);
		const dropped: TodoMoreSnapshot = {
			goal,
			phases: [
				{ ...initial.phases[0]!, items: initial.phases[0]!.items.map((item) => ({ ...item, status: "abandoned" })) },
				initial.phases[1]!,
			],
		};
		expectSaved(harness, harness.call('DROP PHASE "Delivery"'), dropped, 1, 0);
		expectSaved(
			harness,
			harness.call('RM PHASE "Delivery"'),
			{
				goal,
				phases: [{ name: "Delivery", items: [] }, initial.phases[1]!],
			},
			2,
			1,
		);
	});

	for (const remove of ["RM ALL", 'RM "Only task"']) {
		test(`${remove} clears the goal when the list becomes empty`, () => {
			const initial: TodoMoreSnapshot = {
				goal,
				phases: [{ name: "Tasks", items: [{ title: "Only task", explanation: "Complete scope", status: "in_progress" }] }],
			};
			const harness = fixture(initial);
			expectRejected(harness, () => harness.call(remove, 'PHASE "Tasks"', 'ADD "Replacement" "Cannot inherit a cleared goal"'));
			expectSaved(harness, harness.call(remove), { goal: null, phases: [] }, 1, 0);
			expectRejected(harness, () => harness.call('PHASE "Tasks"', 'ADD "Replacement" "Still cannot inherit a cleared goal"'));
			expectSaved(
				harness,
				harness.call(init, 'ADD "Replacement" "New list with its own goal"'),
				{
					goal,
					phases: [{ name: "Tasks", items: [{ title: "Replacement", explanation: "New list with its own goal", status: "in_progress" }] }],
				},
				2,
				1,
			);
		});
	}

	test("VIEW reads the current branch without snapshot append, projection, or normalization", () => {
		const initial = populated();
		initial.phases[0]!.items[0]!.status = "pending";
		const harness = fixture(initial);
		const before = harness.session.sessionManager.getBranch();
		const result = harness.call("VIEW");
		expect(result.isError).not.toBe(true);
		expect(result.details?.op).toBe("view");
		expect(result.details?.more).toEqual(initial);
		expect(harness.snapshot()).toEqual(initial);
		expect(harness.session.sessionManager.getBranch()).toEqual(before);
		expect(harness.snapshots()).toHaveLength(1);
		expect(harness.projections).toHaveLength(0);
	});

	test("old JSON single-operation and inferred-operation arguments are rejected explicitly", () => {
		const harness = fixture(populated());
		for (const raw of [
			{ op: "done", task: "Implement" },
			{ op: "view" },
			{ goal, items: [{ title: "Replacement", explanation: "Must not be inferred" }] },
		]) {
			const result = expectRejected(harness, () => runTodo(harness.session, raw));
			expect(result.content.some((part) => part.type === "text" && /input|document|arguments/i.test(part.text))).toBe(true);
		}
	});

	const invalidCommands = [
		'DONE ""',
		'RM PHASE ""',
		"BLOCK ALL",
		"UNBLOCK ALL",
		'PHASE "New phase"',
		'PHASE "New phase"\nDONE "Review"',
		'ADD "No phase" "Append requires explicit phase context"',
	];
	for (const command of invalidCommands) {
		test(`invalid command/context cannot commit a valid mutation prefix: ${command}`, () => {
			const harness = fixture(populated());
			expectRejected(harness, () => harness.call('DONE "Implement"', command));
		});
	}

	test("an incomplete envelope or malformed suffix cannot commit a previewed prefix", () => {
		const harness = fixture(populated());
		for (const input of [
			'*** Begin Todo\nDONE "Implement"\n',
			'*** Begin Todo\nDONE "Implement"\nEXPLAIN "Review" "unfinished',
			`${document('DONE "Implement"')}\nSTART "Review"`,
		])
			expectRejected(harness, () => runTodo(harness.session, { input }));
	});
});
