import { describe, expect, spyOn, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoSession, TodoWriter } from "../src/commit.ts";
import {
	elapsedTime,
	type ItemTime,
	readTodoMore,
	TODO_MORE_ENTRY_TYPE,
	type TodoGoal,
	type TodoMoreSnapshot,
	toSnapshot,
} from "../src/state.ts";
import { runTodo, type TodoMoreDetails } from "../src/tool.ts";

const epoch = Date.parse("2026-10-15T12:00:00.000Z");
const goal: TodoGoal = {
	objective: "Ship atomic streaming todos",
	measure: "Every call publishes one accepted state",
	doneWhen: "Tasks, explanations and goal survive the complete batch",
};
const init = `INIT ${JSON.stringify(goal.objective)} ${JSON.stringify(goal.measure)} ${JSON.stringify(goal.doneWhen)}`;
type SnapshotItem = TodoMoreSnapshot["phases"][number]["items"][number];
type EstimatedTime = Extract<ItemTime, { kind: "estimated" }>;

function document(...lines: string[]): string {
	return ["*** Begin Todo", ...lines, "*** End Todo"].join("\n");
}

/** Advance on every clock read to expose per-operation rather than per-batch anchors. */
function at<T>(time: number, invoke: () => T, tick = 0): T {
	let reads = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => time + tick * reads++);
	try {
		return invoke();
	} finally {
		clock.mockRestore();
	}
}

type Fixture = {
	pi: TodoWriter;
	session: TodoSession;
	projections: HostTodoPhase[][];
	snapshot: () => TodoMoreSnapshot;
	snapshots: () => SessionEntry[];
	call: (...lines: string[]) => AgentToolResult<TodoMoreDetails>;
	callAt: (time: number, ...lines: string[]) => AgentToolResult<TodoMoreDetails>;
};

/** Real authority-branch persistence; only the unrelated AgentSession projection is captured. */
function fixture(initial?: TodoMoreSnapshot): Fixture {
	const sessionManager = SessionManager.inMemory("/tmp/todo-more-tool-tests");
	const projections: HostTodoPhase[][] = [];
	const pi: TodoWriter = {
		appendEntry: (customType, data) => {
			sessionManager.appendCustomEntry(customType, data);
		},
	};
	const session: TodoSession = {
		sessionManager,
		setTodoPhases: (phases) => {
			projections.push(phases);
		},
	};
	if (initial !== undefined) sessionManager.appendCustomEntry(TODO_MORE_ENTRY_TYPE, initial);
	const callAt = (time: number, ...lines: string[]): AgentToolResult<TodoMoreDetails> =>
		at(time, () => runTodo(pi, session, { input: document(...lines) }));
	return {
		pi,
		session,
		projections,
		snapshot: () => toSnapshot(readTodoMore(sessionManager.getBranch())),
		snapshots: () => sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TODO_MORE_ENTRY_TYPE),
		call: (...lines: string[]) => callAt(epoch, ...lines),
		callAt,
	};
}

function projected(snapshot: TodoMoreSnapshot): HostTodoPhase[] {
	return snapshot.phases.map((phase) => ({
		name: phase.name,
		tasks: phase.items.map((item) => ({
			content: item.title,
			status: item.status,
			...(item.blocker === undefined ? {} : { blocker: item.blocker }),
		})),
	}));
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
	expect(result.details?.phases).toEqual(projected(expected));
	expect(harness.snapshots()).toHaveLength(previousSnapshots + 1);
	const entry = harness.snapshots().at(-1);
	if (entry?.type !== "custom") throw new Error("Expected a persisted todo snapshot");
	expect(entry.data).toEqual(expected);
	expect(harness.projections).toHaveLength(previousProjections + 1);
	expect(harness.projections.at(-1)).toEqual(projected(expected));
}

function expectRejected(harness: Fixture, invoke: () => AgentToolResult<TodoMoreDetails>): AgentToolResult<TodoMoreDetails> {
	const before = harness.snapshot();
	const entries = structuredClone(harness.session.sessionManager.getBranch());
	const projections = structuredClone(harness.projections);
	const result = invoke();
	expect(result.isError).toBe(true);
	expect(result.details?.more).toEqual(before);
	expect(result.details?.phases).toEqual(projected(before));
	expect(result.details).not.toHaveProperty("changes");
	expect(harness.snapshot()).toEqual(before);
	expect(harness.session.sessionManager.getBranch()).toEqual(entries);
	expect(harness.projections).toEqual(projections);
	return result;
}

function itemOf(snapshot: TodoMoreSnapshot, title: string): SnapshotItem {
	const item = snapshot.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === title);
	if (item === undefined) throw new Error(`Expected task ${title}`);
	return item;
}

function estimateOf(snapshot: TodoMoreSnapshot, title: string): EstimatedTime {
	const time = itemOf(snapshot, title).time;
	if (time.kind !== "estimated") throw new Error(`Expected estimate for ${title}`);
	return time;
}

function time(budgetId: string, minutes: number, elapsedMs = 0, runningSince: number | null = null): EstimatedTime {
	return { kind: "estimated", budgetId, minutes, elapsedMs, runningSince };
}

/** Only the nondeterministic identity is taken from the branch; every other field is explicit. */
function createdTime(harness: Fixture, title: string, minutes: number, runningSince: number | null, elapsedMs = 0): EstimatedTime {
	const budgetId = estimateOf(harness.snapshot(), title).budgetId;
	expect(budgetId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	return time(budgetId, minutes, elapsedMs, runningSince);
}

function populated(): TodoMoreSnapshot {
	return {
		goal,
		phases: [
			{
				name: "Delivery",
				items: [
					{ title: "Implement", explanation: "Consume complete commands", status: "in_progress", time: { kind: "missing" } },
					{ title: "Review", explanation: "Review original behavior", status: "pending", time: { kind: "missing" } },
				],
			},
			{
				name: "Verification",
				items: [
					{
						title: "Runtime",
						explanation: "Use the real host",
						status: "blocked",
						blocker: "Waiting for credentials",
						time: { kind: "missing" },
					},
					{ title: "Already checked", explanation: "Retain earlier evidence", status: "completed", time: { kind: "missing" } },
					{ title: "Old approach", explanation: "Keep historical scope", status: "abandoned", time: { kind: "missing" } },
				],
			},
		],
	};
}

function timed(): TodoMoreSnapshot {
	const snapshot = populated();
	itemOf(snapshot, "Implement").time = time("implement-budget", 10, 1_250, epoch);
	itemOf(snapshot, "Review").time = time("review-budget", 20, 500);
	itemOf(snapshot, "Runtime").time = time("runtime-budget", 30, 750);
	return snapshot;
}

describe("atomic Todo document execution", () => {
	test("flat initialization with multiple estimates appends one snapshot and defaults to Tasks", () => {
		const harness = fixture();
		const result = harness.call(init, 'ADD "Implement" "Consume the text document" 10', 'ADD "Review" "Check all fields" 20');
		const implement = createdTime(harness, "Implement", 10, epoch);
		const review = createdTime(harness, "Review", 20, null);
		expect(implement.budgetId).not.toBe(review.budgetId);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Tasks",
						items: [
							{ title: "Implement", explanation: "Consume the text document", status: "in_progress", time: implement },
							{ title: "Review", explanation: "Check all fields", status: "pending", time: review },
						],
					},
				],
			},
			0,
			0,
		);
		expect(result.details?.op).toBe("init");
		expect(result.details?.operations).toEqual(["init"]);
		expect(result.details?.changes).toEqual([
			{
				op: "init",
				goal,
				list: [
					{
						phase: "Tasks",
						items: [
							{ title: "Implement", explanation: "Consume the text document", estimatedMinutes: 10 },
							{ title: "Review", explanation: "Check all fields", estimatedMinutes: 20 },
						],
					},
				],
			},
		]);
	});

	test("task identity survives escaped quotes, unicode, newlines and surrounding whitespace across one batch", () => {
		const harness = fixture();
		const title = '  检查 "quoted" \\ path\nnext 🧪  ';
		const quoted = JSON.stringify(title);
		const result = harness.call(
			init,
			`ADD ${quoted} "Original explanation" 10`,
			`EXPLAIN ${quoted} "Accepted explanation"`,
			`DONE ${quoted}`,
		);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Tasks",
						items: [{ title, explanation: "Accepted explanation", status: "completed", time: createdTime(harness, title, 10, null) }],
					},
				],
			},
			0,
			0,
		);
	});

	for (const commands of [
		[init],
		[init, 'PHASE "Empty phase"'],
		[init, 'ADD "Repeated" "First" 10', 'ADD "Repeated" "Duplicate" 20'],
		[init, 'PHASE "Repeated"', 'ADD "First" "First" 10', 'PHASE "Repeated"', 'ADD "Second" "Second" 20'],
		[init, 'ADD "" "No title" 10'],
		[init, 'ADD "No explanation" "  " 10'],
	]) {
		test(`invalid initialization cannot replace an existing list: ${commands.slice(1).join("; ") || "no tasks"}`, () => {
			const harness = fixture(populated());
			expectRejected(harness, () => harness.call(...commands));
		});
	}

	test("phased initialization normalizes across all tasks after assembling its phases", () => {
		const harness = fixture();
		const result = harness.call(
			init,
			'PHASE "Delivery"',
			'ADD "Implement" "Build the behavior" 10',
			'ADD "Review" "Inspect changes" 20',
			'PHASE "Verification"',
			'ADD "Runtime" "Exercise the host" 30',
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
							{
								title: "Implement",
								explanation: "Build the behavior",
								status: "in_progress",
								time: createdTime(harness, "Implement", 10, epoch),
							},
							{ title: "Review", explanation: "Inspect changes", status: "pending", time: createdTime(harness, "Review", 20, null) },
						],
					},
					{
						name: "Verification",
						items: [
							{ title: "Runtime", explanation: "Exercise the host", status: "pending", time: createdTime(harness, "Runtime", 30, null) },
						],
					},
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
			'ADD "Polish" "Finish the existing phase" 7',
			'PHASE "Release"',
			'ADD "Publish" "Deliver the accepted result" 12',
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
							{ title: "Implement", explanation: "Consume complete commands", status: "completed", time: { kind: "missing" } },
							{ title: "Review", explanation: "Inspect the final accepted fields", status: "in_progress", time: { kind: "missing" } },
							{
								title: "Polish",
								explanation: "Finish the existing phase",
								status: "pending",
								time: createdTime(harness, "Polish", 7, null),
							},
						],
					},
					initial.phases[1]!,
					{
						name: "Release",
						items: [
							{
								title: "Publish",
								explanation: "Deliver the accepted result",
								status: "pending",
								time: createdTime(harness, "Publish", 12, null),
							},
						],
					},
				],
			},
			1,
			0,
		);
		expect(result.details?.op).toBe("batch");
		expect(result.details?.operations).toEqual(["done", "start", "explain", "append", "append"]);
		expect(result.details?.changes).toEqual([
			{ op: "done", task: "Implement" },
			{ op: "start", task: "Review" },
			{ op: "explain", task: "Review", explanation: "Inspect the final accepted fields" },
			{ op: "append", phase: "Delivery", items: [{ title: "Polish", explanation: "Finish the existing phase", estimatedMinutes: 7 }] },
			{ op: "append", phase: "Release", items: [{ title: "Publish", explanation: "Deliver the accepted result", estimatedMinutes: 12 }] },
		]);
		expect(result.details?.completedTasks).toEqual([{ phase: "Delivery", content: "Implement" }]);
	});

	for (const lateCommand of [
		'START "Missing task"',
		'EXPLAIN "Review" "  "',
		'GOAL "" "Measured" "Complete"',
		'PHASE "Delivery"\nADD "Review" "Duplicate title" 10',
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
				'ADD "Publish" "New scope" 10',
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
		itemOf(expected, "Implement").status = "pending";
		itemOf(expected, "Review").status = "in_progress";
		expectSaved(harness, harness.call('BLOCK "Implement" "Wait"', 'UNBLOCK "Implement"'), expected, 1, 0);
	});

	test("GOAL replaces only goal fields without normalizing imported statuses or clocks", () => {
		const initial = timed();
		itemOf(initial, "Review").status = "in_progress";
		itemOf(initial, "Review").time = time("review-budget", 20, 500, epoch + 1_000);
		const harness = fixture(initial);
		const replacement: TodoGoal = { objective: "New objective", measure: "New measure", doneWhen: "New done boundary" };
		expectSaved(
			harness,
			harness.callAt(epoch + 50_000, 'GOAL "New objective" "New measure" "New done boundary"'),
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
		itemOf(expected, "Review").explanation = "Updated";
		expectSaved(harness, harness.call('GOAL "New" "Measured" "Complete"', 'EXPLAIN "Review" "Updated"'), expected, 1, 0);
	});

	test("GOAL on an empty list cannot manufacture a list or a saved goal", () => {
		const harness = fixture();
		expectRejected(harness, () => harness.call('GOAL "New" "Measured" "Complete"'));
		expect(harness.snapshots()).toHaveLength(0);
	});

	test("BLOCK PHASE normalizes its reason and UNBLOCK PHASE removes blockers", () => {
		const harness = fixture(populated());
		const blocked = populated();
		blocked.phases[0]!.items = blocked.phases[0]!.items.map((item) => ({ ...item, status: "blocked", blocker: "Waiting for service" }));
		expectSaved(harness, harness.call('BLOCK PHASE "Delivery" "  Waiting\\n for\\tservice  "'), blocked, 1, 0);
		expectSaved(harness, harness.call('UNBLOCK PHASE "Delivery"'), populated(), 2, 1);
		const allBlocked = populated();
		allBlocked.phases[0]!.items = allBlocked.phases[0]!.items.map((item) => ({ ...item, status: "blocked" }));
		expectSaved(harness, harness.call('BLOCK "Implement"', 'BLOCK "Review"'), allBlocked, 3, 2);
	});

	test("BLOCK and UNBLOCK leave completed and abandoned targets unchanged without an extra snapshot", () => {
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
		expect(harness.projections).toEqual([projected(populated())]);
	});

	test("quoted ALL selects a task, while DONE ALL selects all phases", () => {
		const initial: TodoMoreSnapshot = {
			goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{ title: "ALL", explanation: "A literal task title", status: "in_progress", time: { kind: "missing" } },
						{ title: "Other", explanation: "Not selected by quoted ALL", status: "pending", time: { kind: "missing" } },
					],
				},
				{
					name: "Verification",
					items: [{ title: "Last", explanation: "Another phase", status: "blocked", blocker: "Wait", time: { kind: "missing" } }],
				},
			],
		};
		const harness = fixture(initial);
		const selected = structuredClone(initial);
		itemOf(selected, "ALL").status = "completed";
		itemOf(selected, "Other").status = "in_progress";
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
			{ goal, phases: [{ name: "Delivery", items: [] }, initial.phases[1]!] },
			2,
			1,
		);
	});

	for (const remove of ["RM ALL", 'RM "Only task"']) {
		test(`${remove} clears the goal when the list becomes empty`, () => {
			const initial: TodoMoreSnapshot = {
				goal,
				phases: [
					{
						name: "Tasks",
						items: [{ title: "Only task", explanation: "Complete scope", status: "in_progress", time: { kind: "missing" } }],
					},
				],
			};
			const harness = fixture(initial);
			expectRejected(harness, () => harness.call(remove, 'PHASE "Tasks"', 'ADD "Replacement" "Cannot inherit a cleared goal" 10'));
			expectSaved(harness, harness.call(remove), { goal: null, phases: [] }, 1, 0);
			expectRejected(harness, () => harness.call('PHASE "Tasks"', 'ADD "Replacement" "Still cannot inherit a cleared goal" 10'));
			const result = harness.call(init, 'ADD "Replacement" "New list with its own goal" 10');
			expectSaved(
				harness,
				result,
				{
					goal,
					phases: [
						{
							name: "Tasks",
							items: [
								{
									title: "Replacement",
									explanation: "New list with its own goal",
									status: "in_progress",
									time: createdTime(harness, "Replacement", 10, epoch),
								},
							],
						},
					],
				},
				2,
				1,
			);
		});
	}

	test("VIEW reads the branch without append, projection, normalization, or clock changes", () => {
		const initial = timed();
		itemOf(initial, "Implement").status = "pending";
		const harness = fixture(initial);
		const before = structuredClone(harness.session.sessionManager.getBranch());
		const result = harness.callAt(epoch + 90_000, "VIEW");
		expect(result.isError).not.toBe(true);
		expect(result.details?.op).toBe("view");
		expect(result.details).not.toHaveProperty("changes");
		expect(result.details?.more).toEqual(initial);
		expect(result.details?.phases).toEqual(projected(initial));
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
			{ goal, items: [{ title: "Replacement", explanation: "Must not be inferred", estimatedMinutes: 10 }] },
		]) {
			const result = expectRejected(harness, () => runTodo(harness.pi, harness.session, raw));
			expect(result.content.some((part) => part.type === "text" && /input|document|arguments/i.test(part.text))).toBe(true);
		}
	});

	for (const command of [
		'DONE ""',
		'RM PHASE ""',
		"BLOCK ALL",
		"UNBLOCK ALL",
		'PHASE "New phase"',
		'PHASE "New phase"\nDONE "Review"',
		'ADD "No phase" "Append requires explicit phase context" 10',
	]) {
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
			expectRejected(harness, () => runTodo(harness.pi, harness.session, { input }));
	});
});

describe("atomic batch timing through the authority branch", () => {
	test("all transitions share T and transient active ADD tasks gain no command-execution time", () => {
		const harness = fixture();
		const anchor = epoch + 10_000;
		const result = at(
			anchor,
			() =>
				runTodo(harness.pi, harness.session, {
					input: document(
						init,
						'ADD "First" "Complete within the batch" 2',
						'ADD "Second" "Pause within the batch" 3',
						'ADD "Third" "Remain active" 4',
						'DONE "First"',
						'BLOCK "Second" "Wait"',
						'EXPLAIN "Third" "Accepted active explanation"',
					),
				}),
			1_000,
		);
		const first = createdTime(harness, "First", 2, null);
		const second = createdTime(harness, "Second", 3, null);
		const third = createdTime(harness, "Third", 4, anchor);
		expect(new Set([first.budgetId, second.budgetId, third.budgetId]).size).toBe(3);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Tasks",
						items: [
							{ title: "First", explanation: "Complete within the batch", status: "completed", time: first },
							{ title: "Second", explanation: "Pause within the batch", status: "blocked", blocker: "Wait", time: second },
							{ title: "Third", explanation: "Accepted active explanation", status: "in_progress", time: third },
						],
					},
				],
			},
			0,
			0,
		);
		expect(result.details?.operations).toEqual(["init", "done", "block", "explain"]);
	});

	test("existing active time is settled at the same T as its successor starts", () => {
		const initial = timed();
		const harness = fixture(initial);
		const anchor = epoch + 6_000;
		const result = at(
			anchor,
			() =>
				runTodo(harness.pi, harness.session, {
					input: document('BLOCK "Implement" "Wait"', 'UNBLOCK "Implement"', 'EXPLAIN "Review" "Continue with review"'),
				}),
			1_000,
		);
		const expected = timed();
		Object.assign(itemOf(expected, "Implement"), { status: "pending", time: time("implement-budget", 10, 7_250) });
		Object.assign(itemOf(expected, "Review"), {
			status: "in_progress",
			explanation: "Continue with review",
			time: time("review-budget", 20, 500, anchor),
		});
		expectSaved(harness, result, expected, 1, 0);
	});

	test("BLOCK, paused ESTIMATE, UNBLOCK, active ESTIMATE and DONE preserve only active elapsed time", () => {
		const initial = timed();
		initial.phases = [{ name: "Delivery", items: [itemOf(initial, "Implement")] }];
		const harness = fixture(initial);
		const blocked: TodoMoreSnapshot = {
			goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{
							title: "Implement",
							explanation: "Consume complete commands",
							status: "blocked",
							blocker: "Wait",
							time: time("implement-budget", 10, 7_250),
						},
					],
				},
			],
		};
		expectSaved(harness, harness.callAt(epoch + 6_000, 'BLOCK "Implement" "Wait"'), blocked, 1, 0);
		const reestimated = harness.callAt(epoch + 20_000, 'ESTIMATE "Implement" 12');
		const changedBudget = createdTime(harness, "Implement", 12, null, 7_250);
		expect(changedBudget.budgetId).not.toBe("implement-budget");
		const changed = structuredClone(blocked);
		itemOf(changed, "Implement").time = changedBudget;
		expectSaved(harness, reestimated, changed, 2, 1);
		expect(reestimated.details?.changes).toEqual([{ op: "estimate", task: "Implement", estimatedMinutes: 12 }]);
		expect(elapsedTime(estimateOf(harness.snapshot(), "Implement"), epoch + 29_000)).toBe(7_250);

		const sameEstimate = harness.callAt(epoch + 25_000, 'ESTIMATE "Implement" 12');
		expect(sameEstimate.isError).not.toBe(true);
		expect(harness.snapshot()).toEqual(changed);
		expect(sameEstimate.details?.more).toEqual(changed);
		expect(harness.snapshots()).toHaveLength(3);
		expect(harness.projections).toHaveLength(3);
		expect(harness.projections.at(-1)).toEqual(projected(changed));

		const resumed = structuredClone(changed);
		Object.assign(itemOf(resumed, "Implement"), { status: "in_progress", time: time(changedBudget.budgetId, 12, 7_250, epoch + 30_000) });
		delete itemOf(resumed, "Implement").blocker;
		expectSaved(harness, harness.callAt(epoch + 30_000, 'UNBLOCK "Implement"'), resumed, 3, 3);
		expect(elapsedTime(estimateOf(harness.snapshot(), "Implement"), epoch + 35_000)).toBe(12_250);

		const activeEstimate = harness.callAt(epoch + 32_000, 'ESTIMATE "Implement" 15');
		const activeBudget = createdTime(harness, "Implement", 15, epoch + 30_000, 7_250);
		expect(activeBudget.budgetId).not.toBe(changedBudget.budgetId);
		expect(activeBudget.budgetId).not.toBe("implement-budget");
		const active = structuredClone(resumed);
		itemOf(active, "Implement").time = activeBudget;
		expectSaved(harness, activeEstimate, active, 4, 4);

		const final = structuredClone(active);
		Object.assign(itemOf(final, "Implement"), { status: "completed", time: time(activeBudget.budgetId, 15, 12_250) });
		expectSaved(harness, harness.callAt(epoch + 35_000, 'DONE "Implement"'), final, 5, 5);
	});

	test("repeated START, EXPLAIN, same-budget ESTIMATE and VIEW never reset a running interval", () => {
		const harness = fixture(timed());
		const before = timed();
		const repeated = harness.callAt(epoch + 2_000, 'START "Implement"', 'START "Implement"', 'ESTIMATE "Implement" 10');
		expect(repeated.isError).not.toBe(true);
		expect(harness.snapshot()).toEqual(before);
		expect(repeated.details?.more).toEqual(before);
		expect(harness.snapshots()).toHaveLength(1);
		expect(harness.projections).toEqual([projected(before)]);
		const explained = timed();
		itemOf(explained, "Implement").explanation = "Accepted explanation";
		expectSaved(harness, harness.callAt(epoch + 4_000, 'EXPLAIN "Implement" "Accepted explanation"'), explained, 1, 1);
		const branch = structuredClone(harness.session.sessionManager.getBranch());
		const view = harness.callAt(epoch + 8_000, "VIEW");
		expect(view.details?.more).toEqual(explained);
		expect(view.details).not.toHaveProperty("changes");
		expect(harness.session.sessionManager.getBranch()).toEqual(branch);
		expect(harness.projections).toHaveLength(2);
		expect(estimateOf(harness.snapshot(), "Implement")).toEqual(time("implement-budget", 10, 1_250, epoch));
		expect(elapsedTime(estimateOf(harness.snapshot(), "Implement"), epoch + 8_000)).toBe(9_250);
	});

	test("ESTIMATE supplies missing imported time without inventing historical elapsed time", () => {
		const harness = fixture(populated());
		const anchor = epoch + 40_000;
		const result = harness.callAt(anchor, 'ESTIMATE "Implement" 5', 'ESTIMATE "Review" 6');
		const expected = populated();
		const implement = createdTime(harness, "Implement", 5, anchor);
		const review = createdTime(harness, "Review", 6, null);
		expect(implement.budgetId).not.toBe(review.budgetId);
		itemOf(expected, "Implement").time = implement;
		itemOf(expected, "Review").time = review;
		expectSaved(harness, result, expected, 1, 0);
		expect(result.details?.changes).toEqual([
			{ op: "estimate", task: "Implement", estimatedMinutes: 5 },
			{ op: "estimate", task: "Review", estimatedMinutes: 6 },
		]);
	});

	const maximumMinutes = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
	for (const invalid of ["", "0", "-1", "1.5", String(maximumMinutes + 1)]) {
		for (const command of [
			`ESTIMATE "Implement"${invalid === "" ? "" : ` ${invalid}`}`,
			`PHASE "Delivery"\nADD "Invalid estimate" "Cannot commit"${invalid === "" ? "" : ` ${invalid}`}`,
		]) {
			test(`invalid required minute budget rejects the entire batch: ${command}`, () => {
				const harness = fixture(timed());
				expectRejected(harness, () =>
					harness.callAt(epoch + 6_000, 'GOAL "Changed" "Measured" "Complete"', 'BLOCK "Implement" "Wait"', command),
				);
				expect(harness.snapshot()).toEqual(timed());
			});
		}
	}

	test("maximum safe minute estimate is accepted without rounding in ADD and ESTIMATE", () => {
		const harness = fixture();
		const initialized = harness.call(init, `ADD "Boundary" "Safe millisecond conversion" ${maximumMinutes}`);
		const original = createdTime(harness, "Boundary", maximumMinutes, epoch);
		expectSaved(
			harness,
			initialized,
			{
				goal,
				phases: [
					{
						name: "Tasks",
						items: [
							{
								title: "Boundary",
								explanation: "Safe millisecond conversion",
								status: "in_progress",
								time: original,
							},
						],
					},
				],
			},
			0,
			0,
		);
		const same = harness.callAt(epoch + 1_000, `ESTIMATE "Boundary" ${maximumMinutes}`);
		expect(same.isError).not.toBe(true);
		expect(estimateOf(harness.snapshot(), "Boundary")).toEqual(original);
		expect(same.details?.changes).toEqual([{ op: "estimate", task: "Boundary", estimatedMinutes: maximumMinutes }]);
		expect(harness.snapshots()).toHaveLength(1);
	});

	for (const lateCommand of ['ESTIMATE "Missing task" 20', 'RM "Missing task"', 'GOAL "" "Measured" "Complete"']) {
		test(`late failure preserves all original time, goal, status, branch and projection: ${lateCommand}`, () => {
			const harness = fixture(timed());
			expectRejected(harness, () =>
				harness.callAt(
					epoch + 6_000,
					'GOAL "Replacement" "New measure" "New boundary"',
					'ESTIMATE "Implement" 11',
					'BLOCK "Implement" "Would pause"',
					'UNBLOCK "Runtime"',
					'ESTIMATE "Review" 21',
					lateCommand,
				),
			);
			expect(harness.snapshot()).toEqual(timed());
			expect(harness.snapshots()).toHaveLength(1);
			expect(harness.projections).toHaveLength(0);
		});
	}
});
