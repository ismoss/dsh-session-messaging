/**
 * Pure ledger logic: folding events into a task state, the one-writer rule, the duplicate guard,
 * the board rendering, and where the ledgers live.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
	DEFAULT_DUP_WINDOW_MINUTES,
	checkDispatch,
	deriveState,
	fileForTask,
	listStates,
	normalizeItems,
	normalizeTaskId,
	recordAlert,
	recordDispatch,
	recordReport,
	recordTakeover,
	refreshBoard,
	renderBoard,
	resolveTaskDir,
	stateOf
} from "../lib/tasks.js";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "dsh-session-tasks-"));
}

const T0 = Date.parse("2026-11-09T03:00:00.000Z");

test("normalizes task ids and item lists", () => {
	assert.equal(normalizeTaskId("  login-refactor "), "login-refactor");
	assert.equal(normalizeTaskId("   "), undefined);
	assert.equal(normalizeTaskId(undefined), undefined);
	assert.equal(normalizeTaskId(42), undefined);
	assert.throws(() => normalizeTaskId("x".repeat(65)), /longer than 64/);
	assert.throws(() => normalizeTaskId("a\u0000b"), /control characters/);

	assert.deepEqual(normalizeItems([" a ", "b", "a", "", 3, null]), ["a", "b"]);
	assert.deepEqual(normalizeItems("solo"), ["solo"]);
	assert.deepEqual(normalizeItems(undefined), []);
});

test("folds dispatch, report and takeover events into one state", () => {
	const events = [
		{ at: new Date(T0).toISOString(), kind: "dispatch", task: "t", to: "s-a", toTitle: "A", round: 1, next: ["step 1"], done: ["x"], title: "Proj" },
		{ at: new Date(T0 + 1000).toISOString(), kind: "report", task: "t", by: "s-a", status: "doing", done: ["y"], summary: "half way" },
		{ at: new Date(T0 + 2000).toISOString(), kind: "operation", task: "other" },
		{ at: new Date(T0 + 3000).toISOString(), kind: "report", task: "t", by: "s-a", status: "blocked", summary: "need a key" }
	];
	const state = deriveState("t", events);
	assert.equal(state.rounds, 1);
	assert.equal(state.owner, "s-a");
	assert.equal(state.ownerTitle, "A");
	assert.equal(state.status, "blocked");
	assert.equal(state.title, "Proj");
	assert.equal(state.summary, "need a key");
	assert.deepEqual(state.done, ["x", "y"]);
	assert.deepEqual(state.next, ["step 1"]);
	assert.equal(state.updatedAt, T0 + 3000);

	const empty = deriveState("nope", []);
	assert.equal(empty.status, "idle");
	assert.equal(empty.rounds, 0);
	assert.deepEqual(empty.done, []);
});

test("one task has one writer; force records a takeover instead", () => {
	const state = deriveState("t", [
		{ at: new Date(T0).toISOString(), kind: "dispatch", task: "t", to: "s-a", toTitle: "A", next: ["step"] }
	]);
	assert.throws(
		() => checkDispatch(state, "s-b", { next: ["other"], now: T0 + 1000, windowMs: 60_000 }),
		/is held by session s-a \("A"\).*one task has one writer at a time/s
	);
	assert.deepEqual(checkDispatch(state, "s-a", { next: ["other"], now: T0 + 1000, windowMs: 60_000 }), { takeover: false });
	assert.deepEqual(checkDispatch(state, "s-b", { force: true, next: ["other"], now: T0 + 1000, windowMs: 60_000 }), {
		takeover: true
	});

	const closed = deriveState("t", [
		{ at: new Date(T0).toISOString(), kind: "dispatch", task: "t", to: "s-a" },
		{ at: new Date(T0 + 1000).toISOString(), kind: "report", task: "t", by: "s-a", status: "done" }
	]);
	assert.deepEqual(checkDispatch(closed, "s-b", { next: [], now: T0 + 2000, windowMs: 60_000 }), { takeover: false });
});

test("the same instruction to the same session inside the window is refused", () => {
	const state = deriveState("t", [
		{ at: new Date(T0).toISOString(), kind: "dispatch", task: "t", to: "s-a", next: ["a", "b"] }
	]);
	assert.throws(
		() => checkDispatch(state, "s-a", { next: ["a", "b"], now: T0 + 5 * 60_000, windowMs: 30 * 60_000 }),
		/already dispatched this exact instruction to session s-a 5 minute\(s\) ago/
	);
	// A different instruction, a later retry, or force all get through.
	assert.deepEqual(checkDispatch(state, "s-a", { next: ["c"], now: T0 + 5 * 60_000, windowMs: 30 * 60_000 }), { takeover: false });
	assert.deepEqual(checkDispatch(state, "s-a", { next: ["a", "b"], now: T0 + 45 * 60_000, windowMs: 30 * 60_000 }), {
		takeover: false
	});
	assert.deepEqual(checkDispatch(state, "s-a", { next: ["a", "b"], now: T0 + 60_000, windowMs: 30 * 60_000, force: true }), {
		takeover: false
	});
});

test("ledgers append, list newest first, and render a readable board", () => {
	const dir = tempDir();
	recordDispatch(dir, { task: "alpha", by: "s-a", to: "s-b", toTitle: "Builder", round: 1, next: ["do it"], title: "Alpha" });
	recordReport(dir, { task: "alpha", by: "s-b", status: "done", summary: "done it", done: ["did it"] });
	recordDispatch(dir, { task: "beta", by: "s-a", to: "s-c", round: 1, next: ["later"], title: "Beta" });
	recordTakeover(dir, { task: "beta", by: "s-a", to: "s-d", toTitle: "Dee" });

	const alpha = stateOf(dir, "alpha");
	assert.equal(alpha.status, "done");
	assert.deepEqual(alpha.done, ["did it"]);
	const beta = stateOf(dir, "beta");
	assert.equal(beta.owner, "s-d");
	assert.equal(beta.rounds, 1);

	const listed = listStates(dir);
	assert.deepEqual(listed.map((state) => state.id), ["beta", "alpha"]);

	// Two ids that would collide as a plain slug still get separate files.
	const file = fileForTask(dir, "alpha");
	assert.match(file, /alpha-[0-9a-f]{8}\.jsonl$/);
	assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);

	const board = readFileSync(join(dir, "board.md"), "utf8");
	assert.match(board, /# 任务看板/);
	assert.match(board, /\| `alpha` \| 已完成 \|/);
	assert.match(board, /\| `beta` \| 进行中 \| `s-d`（Dee） \| 1 \|/);
	assert.match(board, /## alpha[\s\S]*- 已完成：[\s\S]*- did it/);
});

test("an empty directory renders an invitation instead of a table", () => {
	const dir = tempDir();
	refreshBoard(dir, { displayDir: "~/.dsh/session-tasks" });
	const board = readFileSync(join(dir, "board.md"), "utf8");
	assert.match(board, /还没有任何任务记录/);
	assert.doesNotMatch(board, /\| 任务 \|/);
	assert.equal(renderBoard([], { displayDir: "x" }).includes("| 任务 |"), false);
});

test("the ledger directory honours the override, then DSH_HOME, then the home default", () => {
	const saved = { DSH_SESSION_TASKS_DIR: process.env.DSH_SESSION_TASKS_DIR, DSH_HOME: process.env.DSH_HOME };
	try {
		assert.deepEqual(resolveTaskDir("E:/explicit"), { dir: resolve("E:/explicit"), displayDir: "E:/explicit" });
		process.env.DSH_SESSION_TASKS_DIR = "E:/from-env";
		assert.equal(resolveTaskDir(undefined).dir, resolve("E:/from-env"));
		delete process.env.DSH_SESSION_TASKS_DIR;
		process.env.DSH_HOME = "E:/dsh-home";
		assert.deepEqual(resolveTaskDir(undefined), { dir: join(resolve("E:/dsh-home"), "session-tasks"), displayDir: "$DSH_HOME/session-tasks" });
		delete process.env.DSH_HOME;
		const fallback = resolveTaskDir(undefined);
		assert.match(fallback.dir, /session-tasks$/);
		assert.equal(fallback.displayDir, "~/.dsh/session-tasks");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	assert.equal(DEFAULT_DUP_WINDOW_MINUTES, 30);
});
test("a timed-out round is marked on the board", () => {
	const dir = tempDir();
	recordDispatch(dir, { task: "slow", by: "s-a", to: "s-b", toTitle: "Builder", round: 1, next: ["x"], title: "Slow" });
	recordAlert(dir, { task: "slow", round: 1, action: "redispatch", ageMinutes: 26 });
	const state = stateOf(dir, "slow");
	assert.equal(state.attempts, 1);
	assert.equal(state.lastAlert.round, 1);
	const board = readFileSync(join(dir, "board.md"), "utf8");
	assert.match(board, /进行中（第 1 轮超时，已重试 1 次）/);
	assert.match(board, /已自动重派/);
	// The next dispatch clears the marker: the task is running again.
	recordDispatch(dir, { task: "slow", by: "s-a", to: "s-b", toTitle: "Builder", round: 2, next: ["x"] });
	assert.equal(stateOf(dir, "slow").lastAlert, undefined);
	assert.doesNotMatch(readFileSync(join(dir, "board.md"), "utf8"), /超时/);
});
