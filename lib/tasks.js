/**
 * Task ledger for `dsh-session-messaging` (Host side, no dependencies).
 *
 * 一个任务一份只追加的 JSONL，当前状态永远由事件重放算出来；再顺带渲染一份人看的
 * `board.md`。它只解决三件事：
 *
 *   1. **单写者**：同一个 `task_id` 同时只允许一个会话持有。第二个会话想接，得显式
 *      `force`（记一条 takeover 事件），默认拦下并告诉它现在谁在干。
 *   2. **已做过什么**：下一次派活自动带上历史结论，发送方不用重新交代一遍。
 *   3. **重复派活**：同一句「本次只做」在 `dupWindowMinutes` 内又发给同一个会话，
 *      当作重发拦下（同样可以用 `force` 越过）——这是事件溯源那套幂等的最小版本。
 *
 * 存储位置（按优先级）：
 *   `DSH_SESSION_TASKS_DIR` → 原样使用（支持 `~`）
 *   `$DSH_HOME/session-tasks` → 默认
 *   `~/.dsh/session-tasks`
 *
 * 写入都走「整文件 append + 同目录临时文件 rename」，进程被杀也不会留下半条记录。
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TASK_DIR_ENV = "DSH_SESSION_TASKS_DIR";
export const DEFAULT_DUP_WINDOW_MINUTES = 30;

const FILE_SUFFIX = ".jsonl";
const MAX_ID_LENGTH = 64;
const MAX_DONE_ITEMS = 40;
const MAX_NEXT_ITEMS = 20;
const MAX_BOARD_TASKS = 30;

function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

/** Where task ledgers live; `displayDir` is the short form shown to the model. */
export function resolveTaskDir(configured) {
	const trimmed = typeof configured === "string" ? configured.trim() : "";
	if (trimmed !== "") return { dir: resolve(expandHome(trimmed)), displayDir: trimmed };
	const override = (process.env[TASK_DIR_ENV] ?? "").trim();
	if (override !== "") return { dir: resolve(expandHome(override)), displayDir: override };
	const home = (process.env.DSH_HOME ?? "").trim();
	if (home !== "") return { dir: join(resolve(expandHome(home)), "session-tasks"), displayDir: "$DSH_HOME/session-tasks" };
	return { dir: join(homedir(), ".dsh", "session-tasks"), displayDir: "~/.dsh/session-tasks" };
}

/** A task id: trimmed, no control characters, at most 64 chars. */
export function normalizeTaskId(value) {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text === "") return undefined;
	if (text.length > MAX_ID_LENGTH) throw new Error(`task_id is longer than ${MAX_ID_LENGTH} characters`);
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f]/.test(text)) throw new Error("task_id must not contain control characters");
	return text;
}

function slugOf(value) {
	const text = String(value)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return text === "" ? "task" : text;
}

/** File name is slug + short hash of the exact id, so two ids never share a file. */
export function fileForTask(dir, id) {
	const hash = createHash("sha1").update(id, "utf8").digest("hex").slice(0, 8);
	return join(dir, `${slugOf(id)}-${hash}${FILE_SUFFIX}`);
}

function boardFile(dir) {
	return join(dir, "board.md");
}

/** Keep only string items, trimmed and de-duplicated, in first-seen order. */
export function normalizeItems(value) {
	if (value === undefined || value === null) return [];
	const list = Array.isArray(value) ? value : [value];
	const seen = new Set();
	const items = [];
	for (const entry of list) {
		if (typeof entry !== "string") continue;
		const text = entry.trim();
		if (text === "" || seen.has(text)) continue;
		seen.add(text);
		items.push(text);
		if (items.length >= MAX_DONE_ITEMS) break;
	}
	return items;
}

function mergeItems(base, added) {
	if (added === undefined || added.length === 0) return base;
	const seen = new Set(base);
	for (const item of added) seen.add(item);
	const merged = [...seen];
	return merged.length > MAX_DONE_ITEMS ? merged.slice(merged.length - MAX_DONE_ITEMS) : merged;
}

/** Stable key for "the same instruction", used by the duplicate-dispatch guard. */
function instructionKey(next) {
	return Array.isArray(next) ? next.join("\u0000") : "";
}

function readEvents(dir, id) {
	const file = fileForTask(dir, id);
	if (!existsSync(file)) return [];
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`cannot read task ledger ${file}: ${error?.message ?? error}`);
	}
	return parseEvents(raw, file);
}

function parseEvents(raw, file) {
	const events = [];
	for (const [index, line] of raw.split(/\r?\n/).entries()) {
		const text = line.trim();
		if (text === "") continue;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			throw new Error(`invalid task ledger ${file} at line ${index + 1}; inspect it before dispatching again`);
		}
		if (event === null || typeof event !== "object" || Array.isArray(event)) {
			throw new Error(`invalid task ledger ${file} at line ${index + 1}; expected an event object`);
		}
		events.push(event);
	}
	return events;
}

function appendEvent(dir, event) {
	mkdirSync(dir, { recursive: true });
	appendFileSync(fileForTask(dir, event.task), `${JSON.stringify(event)}\n`, "utf8");
}

/** Fold one task's events into its current state.
 * dispatch 记「派给谁、第几轮、本次做什么」；report 记「干到哪了」；takeover 记强占；
 * alert 记看门狗「这一轮超时了、重派没重派」。
 */
export function deriveState(id, events) {
	const state = {
		id,
		status: "idle",
		owner: undefined,
		ownerTitle: undefined,
		by: undefined,
		rounds: 0,
		attempts: 0,
		done: [],
		next: undefined,
		message: undefined,
		note: undefined,
		title: undefined,
		summary: undefined,
		updatedAt: 0,
		lastDispatch: undefined,
		lastReport: undefined,
		lastAlert: undefined
	};
	for (const event of events) {
		if (event.task !== id) continue;
		const at = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
		if (Number.isFinite(at)) state.updatedAt = Math.max(state.updatedAt, at);
		if (typeof event.title === "string" && event.title.trim() !== "") state.title = event.title.trim();
		if (event.kind === "dispatch") {
			state.rounds += 1;
			state.status = "doing";
			// `by` is who dispatched, not who wrote the last event: a report is written by the
			// worker, and must not redirect the watchdog's notices to the worker itself.
			if (typeof event.by === "string") state.by = event.by;
			state.owner = typeof event.to === "string" ? event.to : undefined;
			state.ownerTitle = typeof event.toTitle === "string" ? event.toTitle : undefined;
			state.next = Array.isArray(event.next) ? event.next : undefined;
			state.message = typeof event.message === "string" ? event.message : undefined;
			state.lastReport = undefined;
			if (Number.isSafeInteger(event.note) && event.note > 0) state.note = event.note;
			state.done = mergeItems(state.done, normalizeItems(event.done));
			state.summary = undefined;
			state.lastAlert = undefined;
			state.lastDispatch = {
				to: state.owner,
				key: instructionKey(state.next),
				at: Number.isFinite(at) ? at : 0
			};
		} else if (event.kind === "report") {
			state.status = event.status === "done" || event.status === "blocked" ? event.status : "doing";
			state.done = mergeItems(state.done, normalizeItems(event.done));
			if (typeof event.summary === "string" && event.summary.trim() !== "") state.summary = event.summary.trim();
			// A report resets the retry budget and is also activity for the current round.
			state.attempts = 0;
			const reportAt = Number.isFinite(at) ? at : 0;
			state.lastReport = reportAt;
		} else if (event.kind === "takeover") {
			state.owner = typeof event.to === "string" ? event.to : state.owner;
			state.ownerTitle = typeof event.toTitle === "string" ? event.toTitle : state.ownerTitle;
			state.status = "doing";
			if (typeof event.by === "string") state.by = event.by;
		} else if (event.kind === "alert") {
			state.lastAlert = {
				at: Number.isFinite(at) ? at : 0,
				round: Number.isSafeInteger(event.round) ? event.round : state.rounds,
				action: typeof event.action === "string" ? event.action : "notified"
			};
			if (event.action === "redispatch") state.attempts += 1;
		}
	}
	return state;
}

function readIds(dir) {
	if (!existsSync(dir)) return [];
	let names;
	try {
		names = readdirSync(dir);
	} catch (error) {
		throw new Error(`cannot list task ledgers in ${dir}: ${error?.message ?? error}`);
	}
	const ids = [];
	for (const name of names) {
		if (!name.endsWith(FILE_SUFFIX)) continue;
		const events = readEventsByFile(join(dir, name));
		const first = events[0];
		if (first === undefined || typeof first.task !== "string") {
			throw new Error(`invalid task ledger ${join(dir, name)}: no task identifier`);
		}
		ids.push(first.task);
	}
	return ids;
}

function readEventsByFile(file) {
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`cannot read task ledger ${file}: ${error?.message ?? error}`);
	}
	return parseEvents(raw, file);
}

export function stateOf(dir, id) {
	return deriveState(id, readEvents(dir, id));
}

/** Every task that has a ledger, most recently active first. */
export function listStates(dir, { limit = MAX_BOARD_TASKS } = {}) {
	const states = [];
	for (const id of readIds(dir)) {
		const state = stateOf(dir, id);
		if (state.rounds === 0) continue;
		states.push(state);
	}
	states.sort((a, b) => b.updatedAt - a.updatedAt);
	return Number.isSafeInteger(limit) && limit > 0 ? states.slice(0, limit) : states;
}

/**
 * Decide whether `targetId` may take `taskId` now.
 * Throws with a message that names the current holder; `force` records a takeover instead.
 */
export function checkDispatch(state, targetId, { force = false, next, now = Date.now(), windowMs } = {}) {
	if (state.status === "doing" && state.owner !== undefined && state.owner !== targetId) {
		if (!force) {
			const holder = state.ownerTitle === undefined ? state.owner : `${state.owner} (${JSON.stringify(state.ownerTitle)})`;
			throw new Error(
				`task ${JSON.stringify(state.id)} is held by session ${holder}; ` +
					`one task has one writer at a time. Message that session instead, or pass force: true to take it over`
			);
		}
		return { takeover: true };
	}
	const last = state.lastDispatch;
	if (
		!force &&
		last !== undefined &&
		last.to === targetId &&
		Number.isFinite(windowMs) &&
		windowMs > 0 &&
		last.key === instructionKey(next) &&
		now - last.at >= 0 &&
		now - last.at < windowMs
	) {
		throw new Error(
			`task ${JSON.stringify(state.id)} already dispatched this exact instruction to session ${targetId} ` +
				`${Math.round((now - last.at) / 60000)} minute(s) ago and no report came back; ` +
				`pass force: true if it really did nothing`
		);
	}
	return { takeover: false };
}

const STATUS_LABEL = { doing: "进行中", done: "已完成", blocked: "等你拍板", idle: "未开始" };

function stamp(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return "-";
	const date = new Date(ms);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ownerLabel(state) {
	if (state.owner === undefined) return "-";
	return state.ownerTitle === undefined ? `\`${state.owner}\`` : `\`${state.owner}\`（${state.ownerTitle}）`;
}

/** The status cell, marking a round the watchdog gave up on. */
function statusCell(state) {
	const label = STATUS_LABEL[state.status] ?? state.status;
	if (state.status !== "doing" || state.lastAlert === undefined || state.lastAlert.round !== state.rounds) return label;
	return `${label}（第 ${state.rounds} 轮超时，已重试 ${state.attempts} 次）`;
}

/** Render the whole board as plain Markdown, so it can be opened, diffed and synced. */
export function renderBoard(states, { displayDir = "$DSH_HOME/session-tasks" } = {}) {
	const lines = [
		"# 任务看板",
		"",
		`> 由 dsh-session-messaging 自动生成，只读：改这里不会改变任务状态，下一次派活会被覆盖。`,
		`> 账本目录：\`${displayDir}\`（一个任务一份 JSONL，只追加）`,
		""
	];
	if (states.length === 0) {
		lines.push("还没有任何任务记录。第一次带 `task_id` 派活后，这里会出现第一行。");
		lines.push("");
		return lines.join("\n");
	}
	lines.push("| 任务 | 状态 | 持有会话 | 轮次 | 最近活动 |");
	lines.push("| --- | --- | --- | --- | --- |");
	for (const state of states) {
		lines.push(`| \`${state.id}\` | ${statusCell(state)} | ${ownerLabel(state)} | ${state.rounds} | ${stamp(state.updatedAt)} |`);
	}
	lines.push("");
	for (const state of states) {
		lines.push(`## ${state.id}`);
		lines.push("");
		if (state.title !== undefined) lines.push(`- 项目：${state.title}`);
		if (state.note !== undefined) lines.push(`- 便签：#${state.note}`);
		lines.push(`- 状态：${statusCell(state)}（第 ${state.rounds} 轮）`);
		if (state.lastAlert !== undefined && state.lastAlert.round === state.rounds) {
			const action = state.lastAlert.action === "redispatch" ? "已自动重派" : state.lastAlert.action === "exhausted" ? "重试次数用尽" : "已通知中枢";
			lines.push(`- 看门狗：第 ${state.rounds} 轮 ${stamp(state.lastAlert.at)} 判定超时，${action}`);
		}
		if (state.next !== undefined && state.next.length > 0) {
			lines.push("- 本次只做：");
			for (const item of state.next) lines.push(`  - ${item}`);
		}
		if (state.done.length > 0) {
			lines.push("- 已完成：");
			for (const item of state.done.slice(-MAX_DONE_ITEMS)) lines.push(`  - ${item}`);
		}
		if (state.summary !== undefined) lines.push(`- 最近结论：${state.summary}`);
		lines.push("");
	}
	return lines.join("\n");
}

function writeAtomic(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, content, "utf8");
	renameSync(temporary, file);
}

/** Refresh board.md from the ledgers; never throws (a read-only dir must not break delivery). */
export function refreshBoard(dir, { displayDir } = {}) {
	try {
		writeAtomic(boardFile(dir), renderBoard(listStates(dir), { displayDir }));
	} catch {
		/* 看板是附带产物：写不了也得先把消息送到 */
	}
}

/** Record one dispatch and refresh the board. */
export function recordDispatch(dir, event) {
	appendEvent(dir, { at: new Date().toISOString(), kind: "dispatch", ...event });
	refreshBoard(dir);
}

/** Record one report (the working session telling the dispatcher how it went). */
export function recordReport(dir, event) {
	appendEvent(dir, { at: new Date().toISOString(), kind: "report", ...event });
	refreshBoard(dir);
}

/** Record that someone took the task away from its previous holder. */
export function recordTakeover(dir, event) {
	appendEvent(dir, { at: new Date().toISOString(), kind: "takeover", ...event });
	refreshBoard(dir);
}

/** Record one watchdog decision for a round: notified, redispatched, or exhausted. */
export function recordAlert(dir, event) {
	appendEvent(dir, { at: new Date().toISOString(), kind: "alert", ...event });
	refreshBoard(dir);
}

export const TASK_STATUSES = ["doing", "done", "blocked"];

export function isValidStatus(value) {
	return value === "doing" || value === "done" || value === "blocked";
}

export { MAX_NEXT_ITEMS };