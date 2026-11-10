/**
 * Host entry for `dsh-session-messaging`: messages between top-level sessions.
 *
 * Shipped messaging follows an authority edge: `send_message` reaches a direct parent or child
 * (`ctx.subagents`), and Agent Teams reaches members of one Team. Two unrelated top-level sessions
 * have no such edge, so they cannot talk. This plugin adds that channel as three model tools:
 *
 * - `session_list` lists the top-level sessions the caller can message.
 * - `session_send_message` resolves the target through `ctx.sessionController.resolveAgent`, the
 *   path a Web UI prompt takes (cold-resuming a stored session), and steers or queues one
 *   user-role message carrying the shipped relay attribution
 *   `{ kind: 'agent-message', form: 'relay', senderSessionId }`. The message lives in the target's
 *   session log, the Web UI shows it as a received task message naming the sender session, and
 *   the recipient answers with the same tool.
 * - `session_create` opens a session in a registered workspace through
 *   `ctx.sessionController.create`, the Web UI's new-chat path, titles it, and starts its first
 *   turn with the same relay message.
 *
 * Subagent sessions keep their adjacency-only routing: the tools are hidden from them and they
 * are never targets.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
	DEFAULT_DUP_WINDOW_MINUTES,
	checkDispatch,
	isValidStatus,
	listStates,
	normalizeItems,
	normalizeTaskId,
	recordAlert,
	recordDispatch,
	recordReport,
	recordTakeover,
	resolveTaskDir,
	stateOf
} from "./tasks.js";

export const name = "session-messaging";
export const inject = ["agents", "sessions", "sessionController", "sessionQuery", "tools"];

export const SEND_TOOL = "session_send_message";
export const LIST_TOOL = "session_list";
export const CREATE_TOOL = "session_create";
export const TASK_TOOL = "session_tasks";
export const ARCHIVE_TOOL = "session_archive";
export const TOOL_NAMES = [SEND_TOOL, LIST_TOOL, CREATE_TOOL, TASK_TOOL, ARCHIVE_TOOL];

const DEFAULT_MAX_MESSAGE_BYTES = 65_536;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_TITLE_READS = 200;
const DEFAULT_CREATE_LIMIT = 10;
export const DEFAULT_WATCHDOG_MINUTES = 25;
export const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_WATCHDOG_TICK_SECONDS = 60;

// Serialize task operations within this Host process across all plugin instances. This does not
// provide a cross-process lock; multiple Host processes must not share the same task directory.
const taskQueues = new Map();
function withTaskQueue(dir, operation) {
	const previous = taskQueues.get(dir) ?? Promise.resolve();
	const current = previous.then(operation, operation);
	const settled = current.then(() => undefined, () => undefined);
	taskQueues.set(dir, settled);
	void settled.then(() => {
		if (taskQueues.get(dir) === settled) taskQueues.delete(dir);
	});
	return current;
}

/** Validate the patch row's config, falling back to defaults field by field. */
export function normalizeConfig(raw) {
	const config = raw ?? {};
	return {
		crossWorkspace: config.crossWorkspace !== false,
		maxMessageBytes:
			Number.isSafeInteger(config.maxMessageBytes) && config.maxMessageBytes > 0
				? config.maxMessageBytes
				: DEFAULT_MAX_MESSAGE_BYTES,
		listLimit:
			Number.isSafeInteger(config.listLimit) && config.listLimit > 0
				? Math.min(config.listLimit, MAX_LIST_LIMIT)
				: DEFAULT_LIST_LIMIT,
		createLimit:
			Number.isSafeInteger(config.createLimit) && config.createLimit > 0
				? config.createLimit
				: DEFAULT_CREATE_LIMIT,
		taskDir: typeof config.taskDir === "string" && config.taskDir.trim() !== "" ? config.taskDir.trim() : undefined,
		dupWindowMinutes:
			Number.isSafeInteger(config.dupWindowMinutes) && config.dupWindowMinutes >= 0
				? config.dupWindowMinutes
				: DEFAULT_DUP_WINDOW_MINUTES,
		watchdog: config.watchdog !== false,
		watchdogMinutes:
			Number.isSafeInteger(config.watchdogMinutes) && config.watchdogMinutes > 0
				? config.watchdogMinutes
				: DEFAULT_WATCHDOG_MINUTES,
		autoRetry: config.autoRetry !== false,
		maxRetries: Number.isSafeInteger(config.maxRetries) && config.maxRetries >= 0 ? config.maxRetries : DEFAULT_MAX_RETRIES,
		watchdogTickSeconds:
			Number.isSafeInteger(config.watchdogTickSeconds) && config.watchdogTickSeconds > 0
				? Math.min(config.watchdogTickSeconds, 3600)
				: DEFAULT_WATCHDOG_TICK_SECONDS
	};
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

function isSubagentHeader(header) {
	return header?.origin === "subagent" || (header?.delegationDepth ?? 0) > 0;
}

function nonEmpty(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function liveTitle(ctx, session) {
	try {
		return nonEmpty(ctx.get("sessionTitle")?.get(session)?.title);
	} catch {
		return undefined;
	}
}

function archivedSessionIds(ctx) {
	try {
		const ids = ctx.get("workspaceRegistry")?.archivedSessionIds;
		return Array.isArray(ids) ? ids : [];
	} catch {
		return [];
	}
}

/** The exact live calling Agent, which must own a top-level session. */
function callerOf(exec) {
	const agent = exec?.agent;
	if (agent?.session === undefined) throw new Error("session messaging requires a calling session");
	if (isSubagentHeader(agent.session.header)) {
		throw new Error("session messaging is only available to top-level sessions; a subagent reaches its parent with send_message");
	}
	return agent;
}

/** Header of an attached or stored session, without resuming it. */
async function readHeader(ctx, sessionId, signal) {
	const attached = ctx.sessions.get(sessionId);
	if (attached !== undefined) return attached.header;
	const records = await ctx.sessionQuery.filterSessions([{ kind: "id", values: [sessionId] }], signal);
	return records.find((record) => record.header.id === sessionId)?.header;
}

/** Title of a target session without resuming it: live first, then the stored title snapshot. */
async function titleOf(ctx, sessionId) {
	const live = ctx.sessions.get(sessionId);
	if (live !== undefined) return liveTitle(ctx, live);
	try {
		const [first] = await ctx.sessionQuery.readTitleSnapshots([sessionId], undefined);
		return first?.status === "fulfilled" ? nonEmpty(first.value?.title?.title) : undefined;
	} catch {
		return undefined;
	}
}

/** Task-ledger arguments shared by send and create. */
function readTaskArgs(config, args) {
	const taskId = normalizeTaskId(args?.task_id);
	const reported = args?.status;
	if (reported !== undefined && !isValidStatus(reported)) throw new Error('status must be "doing", "done" or "blocked"');
	if (reported !== undefined && taskId === undefined) throw new Error("status requires task_id: a report belongs to one task");
	if (args?.round !== undefined && (!Number.isSafeInteger(args.round) || args.round < 1)) {
		throw new Error("round must be a positive integer");
	}
	return {
		taskId,
		reported,
		store: taskId === undefined ? undefined : resolveTaskDir(config.taskDir),
		next: normalizeItems(args?.this_round),
		alreadyDone: normalizeItems(args?.already_done),
		note: Number.isSafeInteger(args?.note) && args.note > 0 ? args.note : undefined,
		force: args?.force === true,
		round: Number.isSafeInteger(args?.round) && args.round > 0 ? args.round : undefined,
		done: normalizeItems(args?.done)
	};
}

/** The registered Workspace that owns an absolute directory path, without creating one. */
async function workspaceAt(ctx, path) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === undefined) throw new Error(`${CREATE_TOOL} requires the workspace registry`);
	try {
		return await registry.resolveByPath(path);
	} catch {
		// A path that does not exist rejects in realpath; it is not a workspace either.
		return undefined;
	}
}

const TASK_STATUS_LABEL = { doing: "进行中", done: "已完成", blocked: "等你拍板", idle: "未开始" };

/**
 * The block a dispatched message carries before its body: which task, which round, what is
 * already done (folded from the ledger, so the sender never has to restate it), what this round
 * is for, and the receipt the worker must leave when it stops.
 */
export function taskContext(state, { round, next, done, note, senderId, status }) {
	const phase = status ?? state.status;
	const lines = [`【任务 ${state.id} · 第 ${round} 轮 · ${TASK_STATUS_LABEL[phase] ?? phase}】`];
	if (state.title !== undefined) lines.push(`项目：${state.title}`);
	if (note !== undefined) lines.push(`便签：#${note}`);
	lines.push("", "已完成：");
	if (done.length === 0) lines.push("- （无，这是第一轮）");
	else for (const item of done) lines.push(`- ${item}`);
	lines.push("", "本次只做：");
	if (next.length === 0) lines.push("- （发送方没指定，见下面这条消息）");
	else for (const item of next) lines.push(`- ${item}`);
	lines.push(
		"",
		"回执契约（这一轮收尾时必须照做）：",
		"1. 结论写在最后一条回复里，不要只说「收到」。",
		`2. 同时调用 ${SEND_TOOL}：session_id="${senderId}", task_id="${state.id}", round=${round}, status="done", done=[这一轮真正做完的事]。`,
		'3. 需要我拍板时 status="blocked"，在结论里写清有哪几个选项；不要自己往下做。',
		"4. 只做「本次只做」里的事；范围外的问题写进结论，不要顺手改。",
		""
	);
	return lines.join("\n");
}

/**
 * Build the model-visible content of one relayed message: an attribution line naming the sender
 * and how to answer, an optional task-context block, then the sender's text.
 * @param sender - sender session id, optional title, and workspace when it differs from the target's.
 * @param text - message text authored by the sender's agent.
 * @param task - task ledger state plus this round's framing; omitted for a plain message.
 */
export function relayContent(sender, text, task) {
	const id = JSON.stringify(sender.id);
	const label = sender.title === undefined ? "" : ` (${JSON.stringify(sender.title)})`;
	const workspace = sender.workspace === undefined ? "" : ` in workspace ${sender.workspace}`;
	const blocks = [
		{
			type: "text",
			// Adjacent text blocks reach the model concatenated; the blank line keeps the sender's text apart.
			text:
				`Message from session ${id}${label}${workspace}. It was written by that session's agent, not by your user. ` +
				`To answer, call ${SEND_TOOL} with session_id ${id}; do not reply only to acknowledge it.\n\n`
		}
	];
	if (task !== undefined) blocks.push({ type: "text", text: taskContext(task.state, { ...task, senderId: sender.id }) });
	blocks.push({ type: "text", text });
	return blocks;
}

/** Run a ledger write without letting it change the outcome of an already-delivered message. */
function ledgerWrite(ctx, taskId, write) {
	try {
		write();
	} catch (error) {
		ctx.logger?.warn?.(`session-messaging: ledger write for task ${taskId} failed: ${error?.message ?? error}`);
	}
}

/** One identified, frozen user-role message with the shipped relay attribution. */
function relayMessage(senderId, content) {
	return deepFreeze({
		id: randomUUID(),
		role: "user",
		content,
		source: { kind: "agent-message", form: "relay", senderSessionId: senderId }
	});
}

async function sendMessage(ctx, config, args, exec) {
	const taskId = normalizeTaskId(args?.task_id);
	if (taskId === undefined) return sendMessageUnlocked(ctx, config, args, exec);
	const dir = resolveTaskDir(config.taskDir);
	return withTaskQueue(dir.dir, () => sendMessageUnlocked(ctx, config, args, exec));
}

async function sendMessageUnlocked(ctx, config, args, exec) {
	const sender = callerOf(exec);
	const targetId = nonEmpty(args?.session_id);
	if (targetId === undefined) throw new Error("session_id must name a session; use session_list to find one");
	const text = typeof args?.message === "string" ? args.message : "";
	if (text.trim() === "") throw new Error("message must contain non-whitespace text");
	const delivery = args?.delivery ?? "steer";
	if (delivery !== "steer" && delivery !== "queue") throw new Error('delivery must be "steer" or "queue"');
	if (targetId === sender.id) throw new Error("a session cannot message itself");

	const header = await readHeader(ctx, targetId, exec.signal);
	if (header?.cwd === undefined) throw new Error(`session ${targetId} was not found; use session_list to find a session id`);
	if (isSubagentHeader(header)) {
		throw new Error(`session ${targetId} is a subagent session; only its parent can message it, with send_message`);
	}
	if (archivedSessionIds(ctx).includes(targetId)) {
		throw new Error(`session ${targetId} is archived and cannot receive messages until it is restored`);
	}
	const senderWorkspace = sender.session.header.cwd;
	if (!config.crossWorkspace && header.cwd !== senderWorkspace) {
		throw new Error(`session ${targetId} belongs to workspace ${header.cwd}; messaging other workspaces is disabled (crossWorkspace: false)`);
	}

	const plan = readTaskArgs(config, args);
	let taskState;
	let taskRound;
	let takeover = false;
	let dispatchedDone = [];
	let projectTitle;
	if (plan.taskId !== undefined) {
		taskState = stateOf(plan.store.dir, plan.taskId);
		projectTitle = nonEmpty(args?.task_title) ?? taskState.title;
		if (plan.reported !== undefined) {
			if (taskState.rounds === 0) throw new Error(`cannot report task ${JSON.stringify(plan.taskId)} before it is dispatched`);
			if (taskState.status !== "doing") {
				throw new Error(`task ${JSON.stringify(plan.taskId)} is not accepting a report while status is ${taskState.status}`);
			}
			if (taskState.owner !== sender.id) {
				throw new Error(`task ${JSON.stringify(plan.taskId)} is held by session ${taskState.owner ?? "nobody"}; only the current holder may report`);
			}
			if (plan.round !== undefined && plan.round !== taskState.rounds) {
				throw new Error(`task ${JSON.stringify(plan.taskId)} report is for round ${plan.round}, but the current round is ${taskState.rounds}`);
			}
		} else {
			// One task, one writer: a second session may only take over with force.
			const decision = checkDispatch(taskState, targetId, {
				force: plan.force,
				next: plan.next,
				windowMs: config.dupWindowMinutes * 60_000
			});
			takeover = decision.takeover;
			taskRound = taskState.rounds + 1;
			dispatchedDone = normalizeItems([...taskState.done, ...plan.alreadyDone]);
			if (projectTitle === undefined) projectTitle = await titleOf(ctx, targetId);
		}
	}

	const content = relayContent(
		{
			id: sender.id,
			title: liveTitle(ctx, sender.session),
			workspace: senderWorkspace !== undefined && senderWorkspace !== header.cwd ? senderWorkspace : undefined
		},
		text,
		plan.taskId !== undefined && plan.reported === undefined
			? {
					state: { ...taskState, title: projectTitle },
					status: "doing",
					round: taskRound,
					next: plan.next,
					done: dispatchedDone,
					note: plan.note ?? taskState.note
				}
			: undefined
	);
	const bytes = Buffer.byteLength(JSON.stringify(content), "utf8");
	if (bytes > config.maxMessageBytes) {
		throw new Error(`message not delivered: ${bytes} bytes exceeds the ${config.maxMessageBytes}-byte limit`);
	}
	exec.signal.throwIfAborted();

	const before = ctx.agents.get(targetId);
	const state = before === undefined ? "stored" : before.status === "running" ? "running" : "idle";
	// Resume as an unattributed Host operation, like a Web UI prompt: the target stays a runtime
	// root and is not recorded as work initiated by the sender's turn.
	const resolved = await ctx.agents.withoutInitiator(() => ctx.sessionController.resolveAgent(targetId));
	if ("error" in resolved) throw new Error(`message not delivered: ${resolved.error?.message ?? String(resolved.error)}`);
	const target = resolved.agent;
	exec.signal.throwIfAborted();
	if (ctx.agents.get(target.id) !== target) throw new Error(`message not delivered: session ${targetId} was unloaded during delivery`);

	const message = relayMessage(sender.id, content);
	ctx.agents.withoutInitiator(() => (delivery === "queue" ? target.followup(message) : target.steer(message)));
	// Acceptance is the inbox splice above; the flush only shortens the window before it reaches disk.
	try {
		await ctx.sessions.flush(target.session);
	} catch {}

	const title = liveTitle(ctx, target.session);
	const stampedTitle = title ?? projectTitle;
	if (plan.taskId !== undefined) {
		// Only a delivered message changes the ledger; a failure above leaves it untouched. The
		// reverse must hold too: a ledger that cannot be written must not turn a delivered message
		// into an error, or the sender would retry and deliver the same round twice.
		ledgerWrite(ctx, plan.taskId, () => {
			if (plan.reported !== undefined) {
				recordReport(plan.store.dir, {
					task: plan.taskId,
					by: sender.id,
					status: plan.reported,
					summary: text.trim().slice(0, 500),
					done: plan.done
				});
				return;
			}
			if (takeover) recordTakeover(plan.store.dir, { task: plan.taskId, by: sender.id, to: targetId, toTitle: stampedTitle });
			recordDispatch(plan.store.dir, {
				task: plan.taskId,
				by: sender.id,
				to: targetId,
				toTitle: stampedTitle,
				round: taskRound,
				next: plan.next,
				message: text,
				done: dispatchedDone,
				note: plan.note ?? taskState.note,
				title: stampedTitle
			});
		});
	}
	return {
		messageId: message.id,
		sessionId: target.id,
		...(title === undefined ? {} : { title }),
		state,
		delivery,
		...(plan.taskId === undefined
			? {}
			: {
					task: {
						id: plan.taskId,
						round: plan.reported === undefined ? taskRound : taskState.rounds,
						status: plan.reported ?? "dispatched",
						...(takeover ? { tookOver: true } : {})
					}
				})
	};
}

function renderSend(value) {
	const label = value.title === undefined ? "" : ` (${JSON.stringify(value.title)})`;
	const outcome =
		value.state === "running"
			? value.delivery === "queue"
				? "It is busy; the message starts its next turn after the current one ends."
				: "It is busy and reads the message at its next step."
			: value.state === "idle"
				? "It was idle and is starting a turn with the message."
				: "It was resumed from storage and is starting a turn with the message.";
	const task =
		value.task === undefined
			? ""
			: value.task.status === "dispatched"
				? ` Task ${JSON.stringify(value.task.id)} round ${value.task.round} is now held by that session${value.task.tookOver === true ? " (taken over from its previous owner)" : ""}.`
				: ` Recorded task ${JSON.stringify(value.task.id)} as ${value.task.status}.`;
	return `Message delivered to session ${value.sessionId}${label}. ${outcome}${task}`;
}

async function createSession(ctx, config, opened, args, exec) {
	const taskId = normalizeTaskId(args?.task_id);
	if (taskId === undefined) return createSessionUnlocked(ctx, config, opened, args, exec);
	const dir = resolveTaskDir(config.taskDir);
	return withTaskQueue(dir.dir, () => createSessionUnlocked(ctx, config, opened, args, exec));
}

async function createSessionUnlocked(ctx, config, opened, args, exec) {
	const creator = callerOf(exec);
	const title = nonEmpty(args?.title);
	if (title === undefined) throw new Error("title must contain non-whitespace text");
	const text = typeof args?.message === "string" ? args.message : "";
	if (text.trim() === "") throw new Error("message must contain non-whitespace text");

	const creatorCwd = creator.session.header.cwd;
	const home = creatorCwd === undefined ? undefined : await workspaceAt(ctx, creatorCwd);
	const requested = nonEmpty(args?.workspace);
	let workspace = home;
	if (requested !== undefined) {
		if (!isAbsolute(requested)) throw new Error("workspace must be an absolute directory path, as session_list shows it");
		workspace = await workspaceAt(ctx, requested);
		if (workspace === undefined) {
			throw new Error(`${requested} is not a registered workspace; session_list with all_workspaces shows the workspaces in use`);
		}
	} else if (workspace === undefined) {
		throw new Error("this session is not in a registered workspace; pass workspace with a path from session_list");
	}
	if (!config.crossWorkspace && workspace.id !== home?.id) {
		throw new Error(`${workspace.path} is not this session's workspace; opening sessions in other workspaces is disabled (crossWorkspace: false)`);
	}

	const plan = readTaskArgs(config, args);
	if (plan.reported !== undefined) throw new Error("session_create cannot report a task status; report with session_send_message instead");
	let taskState;
	let taskRound;
	let takeover = false;
	let dispatchedDone = [];
	if (plan.taskId !== undefined) {
		taskState = stateOf(plan.store.dir, plan.taskId);
		const decision = checkDispatch(taskState, undefined, {
			force: plan.force,
			next: plan.next,
			windowMs: config.dupWindowMinutes * 60_000
		});
		takeover = decision.takeover;
		taskRound = taskState.rounds + 1;
		dispatchedDone = normalizeItems([...taskState.done, ...plan.alreadyDone]);
	}

	const content = relayContent(
		{
			id: creator.id,
			title: liveTitle(ctx, creator.session),
			workspace: workspace.id === home?.id ? undefined : (home?.path ?? creatorCwd)
		},
		text,
		plan.taskId === undefined
			? undefined
			: {
					state: { ...taskState, title },
					status: "doing",
					round: taskRound,
					next: plan.next,
					done: dispatchedDone,
					note: plan.note ?? taskState.note
				}
	);
	const bytes = Buffer.byteLength(JSON.stringify(content), "utf8");
	if (bytes > config.maxMessageBytes) {
		throw new Error(`session not opened: the message is ${bytes} bytes, over the ${config.maxMessageBytes}-byte limit`);
	}
	const count = opened.get(creator.id) ?? 0;
	if (count >= config.createLimit) {
		throw new Error(`session not opened: this session has reached its limit of ${config.createLimit} new sessions per Harness run (createLimit)`);
	}
	exec.signal.throwIfAborted();

	// Count the attempt before awaiting; a failed creation gives the slot back.
	opened.set(creator.id, count + 1);
	let sessionId;
	try {
		// Open as an unattributed Host operation, like the Web UI's new-chat button: the new session
		// is a runtime root, not work initiated by the creator's turn.
		({ sessionId } = await ctx.agents.withoutInitiator(() => ctx.sessionController.create({ workspaceId: workspace.id })));
	} catch (error) {
		opened.set(creator.id, (opened.get(creator.id) ?? 1) - 1);
		throw new Error(`session not opened: ${error?.message ?? String(error)}`);
	}
	const resolved = await ctx.agents.withoutInitiator(() => ctx.sessionController.resolveAgent(sessionId));
	if ("error" in resolved) {
		throw new Error(`session ${sessionId} was opened but did not receive the message: ${resolved.error?.message ?? String(resolved.error)}`);
	}
	const target = resolved.agent;

	// Relayed messages never trigger automatic titling, so name the session before its turn starts.
	let accepted;
	try {
		accepted = nonEmpty(ctx.get("sessionTitle")?.rename(target.session, title)?.title);
	} catch (error) {
		ctx.logger?.warn?.(`session-messaging: could not title session ${sessionId}: ${error?.message ?? error}`);
	}
	const message = relayMessage(creator.id, content);
	ctx.agents.withoutInitiator(() => target.followup(message));
	try {
		await ctx.sessions.flush(target.session);
	} catch {}

	if (plan.taskId !== undefined) {
		const ownerTitle = accepted ?? title;
		ledgerWrite(ctx, plan.taskId, () => {
			if (takeover) recordTakeover(plan.store.dir, { task: plan.taskId, by: creator.id, to: sessionId, toTitle: ownerTitle });
			recordDispatch(plan.store.dir, {
				task: plan.taskId,
				by: creator.id,
				to: sessionId,
				toTitle: ownerTitle,
				round: taskRound,
				next: plan.next,
				message: text,
				done: dispatchedDone,
				note: plan.note ?? taskState.note,
				title: ownerTitle
			});
		});
	}
	return {
		sessionId,
		...(accepted === undefined ? {} : { title: accepted }),
		workspace: workspace.path,
		messageId: message.id,
		...(plan.taskId === undefined
			? {}
			: { task: { id: plan.taskId, round: taskRound, status: "dispatched", ...(takeover ? { tookOver: true } : {}) } })
	};
}

function renderCreate(value) {
	const label = value.title === undefined ? "" : ` (${JSON.stringify(value.title)})`;
	return `Opened session ${value.sessionId}${label} in workspace ${value.workspace}. It is starting a turn with your message.`;
}

function taskSummary(state) {
	return {
		id: state.id,
		status: state.status,
		rounds: state.rounds,
		updatedAt: Number.isFinite(state.updatedAt) && state.updatedAt > 0 ? new Date(state.updatedAt).toISOString() : "unknown",
		...(state.owner === undefined ? {} : { owner: state.owner }),
		...(state.ownerTitle === undefined ? {} : { ownerTitle: state.ownerTitle }),
		...(state.title === undefined ? {} : { title: state.title }),
		...(state.note === undefined ? {} : { note: state.note }),
		...(state.next === undefined ? {} : { next: state.next }),
		...(state.summary === undefined ? {} : { lastSummary: state.summary }),
		...(state.lastAlert === undefined ? {} : { lastAlert: state.lastAlert }),
		done: state.done
	};
}

async function tasksOverview(config, args, exec) {
	const dir = resolveTaskDir(config.taskDir);
	const id = normalizeTaskId(args?.task_id);
	exec.signal.throwIfAborted();
	if (id !== undefined) {
		const state = stateOf(dir.dir, id);
		if (state.rounds === 0) {
			throw new Error(`no ledger for task ${JSON.stringify(id)}; a task appears after one dispatch carrying its task_id`);
		}
		return { dir: dir.displayDir, total: 1, tasks: [taskSummary(state)] };
	}
	const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20;
	const states = listStates(dir.dir, { limit });
	return { dir: dir.displayDir, total: states.length, tasks: states.map(taskSummary) };
}

function renderTasks(value) {
	if (value.total === 0) {
		return `No task ledger under ${value.dir} yet. Dispatch a message with task_id to open the first one; board.md appears next to the ledgers.`;
	}
	const lines = [`Task board (${value.dir}, ${value.total} task(s), most recently active first):`];
	for (const task of value.tasks) {
		const owner =
			task.owner === undefined ? "" : ` owner ${task.owner}${task.ownerTitle === undefined ? "" : ` (${JSON.stringify(task.ownerTitle)})`}`;
		const next = task.next === undefined || task.next.length === 0 ? "" : ` | this round: ${task.next.join("; ")}`;
		const last = task.lastSummary === undefined ? "" : ` | last: ${task.lastSummary}`;
		const alert = task.lastAlert === undefined || task.lastAlert.round !== task.rounds ? "" : ` | watchdog: round ${task.rounds} timed out`;
		lines.push(`- ${task.id} [${task.status}] round ${task.rounds}${owner}${next}${last}${alert}`);
	}
	return lines.join("\n");
}

/**
 * What must be true before a session may be retired: it is not mid-turn, and no task it holds is
 * still running or waiting for the user. These are facts from the ledger and the agent registry,
 * not a self-report — that is the closeout this tool enforces.
 */
function retireReport(ctx, config, sessionId) {
	const blockers = [];
	const tasks = [];
	const states = listStates(resolveTaskDir(config.taskDir).dir, { limit: 0 });
	for (const state of states) {
		if (state.owner !== sessionId) continue;
		tasks.push({
			id: state.id,
			status: state.status,
			rounds: state.rounds,
			...(state.summary === undefined ? {} : { lastSummary: state.summary })
		});
		if (state.status === "doing") blockers.push(`task ${JSON.stringify(state.id)} is still in round ${state.rounds}`);
		else if (state.status === "blocked") blockers.push(`task ${JSON.stringify(state.id)} is waiting for your decision`);
	}
	const live = ctx.agents.get(sessionId);
	if (live?.status === "running") blockers.push("the session is still running a turn");
	return { blockers, tasks };
}

/**
 * Archive or restore one top-level session through the workspace registry. Archiving is
 * reversible and deletes nothing. Without `confirm` it only reports whether the session is fit to
 * retire, so a session is never archived with work still open on it.
 */
async function archiveSession(ctx, config, args, exec) {
	const dir = resolveTaskDir(config.taskDir);
	return withTaskQueue(dir.dir, () => archiveSessionUnlocked(ctx, config, args, exec));
}

async function archiveSessionUnlocked(ctx, config, args, exec) {
	const caller = callerOf(exec);
	const targetId = nonEmpty(args?.session_id);
	if (targetId === undefined) throw new Error("session_id must name a session; use session_list to find one");
	if (targetId === caller.id) throw new Error("a session cannot archive itself; ask another session, or use the session menu");
	const header = await readHeader(ctx, targetId, exec.signal);
	if (header?.cwd === undefined) throw new Error(`session ${targetId} was not found; use session_list to find a session id`);
	if (isSubagentHeader(header)) throw new Error(`session ${targetId} is a subagent session; it goes away with its parent`);
	const registry = ctx.get("workspaceRegistry");
	const unarchive = args?.unarchive === true;
	const method = unarchive ? "unarchiveSession" : "archiveSession";
	if (registry === undefined || typeof registry[method] !== "function") {
		throw new Error(`this Harness does not expose ${method}; archive from the session menu instead`);
	}
	const title = await titleOf(ctx, targetId);
	const titled = title === undefined ? {} : { title };

	if (unarchive) {
		exec.signal.throwIfAborted();
		try {
			await registry.unarchiveSession(targetId);
		} catch (error) {
			throw new Error(`session ${targetId} was not restored: ${error?.message ?? error}`);
		}
		return { sessionId: targetId, archived: false, ready: true, dryRun: false, blockers: [], tasks: [], ...titled };
	}

	const report = retireReport(ctx, config, targetId);
	const ready = report.blockers.length === 0;
	if (args?.confirm !== true) {
		return { sessionId: targetId, archived: false, ready, dryRun: true, blockers: report.blockers, tasks: report.tasks, ...titled };
	}
	if (!ready) {
		throw new Error(
			`session ${targetId} cannot be retired yet: ${report.blockers.join("; ")}. ` +
				`Close the round or take the task over first (session_tasks shows it), then archive.`
		);
	}
	exec.signal.throwIfAborted();
	try {
		await registry.archiveSession(targetId, { stopActivity: true });
	} catch (error) {
		throw new Error(`session ${targetId} was not archived: ${error?.message ?? error}`);
	}
	return { sessionId: targetId, archived: true, ready, dryRun: false, blockers: [], tasks: report.tasks, ...titled };
}

function renderArchive(value) {
	const label = value.title === undefined ? "" : ` (${JSON.stringify(value.title)})`;
	if (value.archived) {
		return `Archived session ${value.sessionId}${label}. It left the sidebar and takes no messages until it is restored; nothing was deleted.`;
	}
	if (value.dryRun === true) {
		const head = value.ready
			? `Ready to retire: session ${value.sessionId}${label} holds no live task and is not running. Nothing was archived; call again with confirm: true.`
			: `Not ready to retire: session ${value.sessionId}${label}. Nothing was archived.`;
		const lines = [head];
		for (const blocker of value.blockers) lines.push(`- ${blocker}`);
		if (value.tasks.length > 0) lines.push(`Tasks: ${value.tasks.map((task) => `${task.id} [${task.status}] round ${task.rounds}`).join("; ")}`);
		return lines.join("\n");
	}
	return `Restored session ${value.sessionId}${label} from the archive.`;
}

/**
 * Deliver a plugin-authored message (no turn behind it). `followup` starts a turn for an idle or
 * stored session and queues behind the current one for a running session, which is what a notice
 * and a retry both want.
 */
async function deliverPluginMessage(ctx, targetId, content, source, { idleOnly = false } = {}) {
	const resolved = await ctx.agents.withoutInitiator(() => ctx.sessionController.resolveAgent(targetId));
	if ("error" in resolved) return undefined;
	const target = resolved.agent;
	if (idleOnly && target.status === "running") return undefined;
	const message = deepFreeze({ id: randomUUID(), role: "user", content, source });
	ctx.agents.withoutInitiator(() => target.followup(message));
	try {
		await ctx.sessions.flush(target.session);
	} catch {}
	return message;
}

/** The blocks of one watchdog notice: what timed out, what the watchdog already did. */
function watchdogNotice({ state, ageMinutes, action, attempts, maxRetries }) {
	const who = state.ownerTitle === undefined ? state.owner : `${state.owner} (${JSON.stringify(state.ownerTitle)})`;
	const head =
		`【看门狗】任务 ${state.id} · 第 ${state.rounds} 轮派出后 ${ageMinutes} 分钟没有回执，` +
		`目标会话 ${who} 当时不在运行（running 的会话不会被判定超时）。\n`;
	if (action === "redispatch") {
		return [
			{
				type: "text",
				text:
					head +
					`已自动重派为第 ${state.rounds + 1} 轮，仍是同一个会话。` +
					`你不需要再派这个任务，等回执即可；它要是也超时，我会继续告诉你（累计 ${maxRetries} 次后停止自动重派）。\n`
			}
		];
	}
	if (action === "exhausted") {
		const redone = state.message === undefined
			? "旧账本没有保存原始派活消息，无法保证重派携带不变量"
			: attempts > 0 ? `已连续自动重派 ${attempts} 次仍没有回执` : "自动重派没有开启（或次数已用尽）";
		return [
			{
				type: "text",
				text:
					head +
					`${redone}，现在停手等你决定：` +
					`换个会话接手（派活时带 force: true）、先查一下模型网关，还是放弃这个任务。\n`
			}
		];
	}
	return [{ type: "text", text: head + "自动重派没有送达（目标会话可能已被删除），需要你看一下。\n" }];
}

/**
 * One watchdog pass: a round with no report long enough, and whose session is not running, is a
 * lost round. Re-dispatch it (when autoRetry is on and attempts remain) and tell the dispatcher.
 * Never touches a running session: that would double-run work the lock is there to keep single.
 * @returns the tasks this pass acted on, for tests and logging.
 */
export async function watchdogTick(ctx, config, options = {}) {
	const dir = resolveTaskDir(config.taskDir);
	return withTaskQueue(dir.dir, () => watchdogTickUnlocked(ctx, config, { ...options, dir }));
}

async function watchdogTickUnlocked(ctx, config, { now = Date.now(), dir }) {
	const states = listStates(dir.dir, { limit: 0 });
	const acted = [];
	for (const state of states) {
		if (state.status !== "doing" || state.owner === undefined || state.lastDispatch === undefined) continue;
		const age = now - Math.max(state.lastDispatch.at, state.lastReport ?? 0);
		if (!(age >= config.watchdogMinutes * 60_000)) continue;
		if (state.lastAlert !== undefined && state.lastAlert.round === state.rounds) continue;
		const live = ctx.agents.get(state.owner);
		if (live?.status === "running") continue;

		const ageMinutes = Math.max(1, Math.round(age / 60_000));
		// Older ledgers did not retain the original message (including its invariants).
		// Retrying those instructions without that context could undo already-correct work.
		const tries = config.autoRetry && state.attempts < config.maxRetries && state.message !== undefined;
		const action = tries ? "redispatch" : "exhausted";
		const hub = state.by !== undefined && state.by !== state.owner ? state.by : undefined;
		let delivered = false;
		let retried = false;

		if (action === "redispatch") {
			const round = state.rounds + 1;
			const content = [
				{
					type: "text",
					text:
						`【看门狗重派】第 ${state.rounds} 轮派出后 ${ageMinutes} 分钟没有回执，判定失联；这是自动重试，不是新任务。\n` +
						`完成后把回执发给 session ${JSON.stringify(hub ?? state.by)}，带上 task_id ${JSON.stringify(state.id)}。\n\n`
				},
				{
					type: "text",
					text: taskContext(state, {
						round,
						next: state.next ?? [],
						done: state.done,
						note: state.note,
						senderId: state.by ?? state.owner,
						status: "doing"
					})
				},
				{
					type: "text",
					text: state.message === undefined
						? "按上面「本次只做」继续；原始派活没有入账，请先核对原消息中的不变量再动手。"
						: `原始派活消息（保持不动项及验收条件仍有效）：\n${state.message}`
				}
			];
			try {
				// A resume can overlap another caller; do not queue a retry behind a newly running turn.
				if (ctx.agents.get(state.owner)?.status === "running") continue;
				delivered = (await deliverPluginMessage(ctx, state.owner, content, { kind: "agent-message", form: "watchdog", task: state.id }, { idleOnly: true })) !== undefined;
				if (!delivered && ctx.agents.get(state.owner)?.status === "running") continue;
				retried = delivered;
			} catch {
				delivered = false;
			}
		}

		// An unwritable ledger must not stop the sweep or make the message look undelivered.
		ledgerWrite(ctx, state.id, () => {
			recordAlert(dir.dir, {
				task: state.id,
				round: state.rounds,
				action: retried ? "redispatch" : action === "exhausted" ? "exhausted" : "failed",
				by: state.by,
				to: state.owner,
				ageMinutes
			});
			if (!retried) return;
			recordDispatch(dir.dir, {
				task: state.id,
				by: state.by,
				to: state.owner,
				toTitle: state.ownerTitle,
				round: state.rounds + 1,
				next: state.next ?? [],
				message: state.message,
				done: state.done,
				note: state.note,
				title: state.title,
				auto: true
			});
		});

		if (hub !== undefined) {
			try {
				await deliverPluginMessage(
					ctx,
					hub,
					watchdogNotice({
						state,
						ageMinutes,
						action: retried ? "redispatch" : action === "exhausted" ? "exhausted" : "failed",
						attempts: state.attempts,
						maxRetries: config.maxRetries
					}),
					{ kind: "agent-message", form: "watchdog", task: state.id }
				);
			} catch {}
		}
		acted.push({ id: state.id, action: retried ? "redispatch" : "exhausted", round: state.rounds });
	}
	return acted;
}

function summaryTitle(item) {
	return nonEmpty(item.projections?.values?.title);
}

/** Fill titles the listing hints lack, for the rows actually returned. */
async function fillMissingTitles(ctx, rows, signal) {
	const missing = rows.filter((row) => row.title === undefined).map((row) => row.sessionId);
	if (missing.length === 0) return;
	let observations;
	try {
		observations = await ctx.sessionQuery.readTitleSnapshots(missing, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		return;
	}
	const titles = new Map();
	for (const observation of observations) {
		const title = observation.status === "fulfilled" ? nonEmpty(observation.value?.title?.title) : undefined;
		if (title !== undefined) titles.set(observation.sessionId, title);
	}
	for (const row of rows) if (row.title === undefined && titles.has(row.sessionId)) row.title = titles.get(row.sessionId);
}

/** Task id held by each session, so a listing row says what that session is working on. */
function taskHolders(config) {
	const holders = new Map();
	const states = listStates(resolveTaskDir(config.taskDir).dir, { limit: 0 });
	for (const state of states) if (state.status === "doing" && state.owner !== undefined) holders.set(state.owner, state.id);
	return holders;
}

async function listSessions(ctx, config, args, exec) {
	const caller = callerOf(exec);
	const workspace = caller.session.header.cwd;
	const allWorkspaces = args?.all_workspaces === true;
	if (allWorkspaces && !config.crossWorkspace) {
		throw new Error("listing other workspaces is disabled (crossWorkspace: false)");
	}
	if (!allWorkspaces && workspace === undefined) {
		throw new Error("this session has no workspace; set all_workspaces to true");
	}
	const requested = Number.isSafeInteger(args?.limit) && args.limit > 0 ? args.limit : config.listLimit;
	const limit = Math.min(requested, MAX_LIST_LIMIT);
	const query = nonEmpty(args?.query)?.toLowerCase();

	const { items } = await ctx.sessionController.list({}, exec.signal);
	const archived = new Set(archivedSessionIds(ctx));
	const candidates = [];
	for (const item of items) {
		if (item.sessionId === caller.id || item.blank || item.cwd === undefined) continue;
		if (item.origin === "subagent" || archived.has(item.sessionId)) continue;
		if (!allWorkspaces && item.cwd !== workspace) continue;
		candidates.push({
			sessionId: item.sessionId,
			status: item.running ? "running" : "inactive",
			updatedAt: Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : "unknown",
			title: summaryTitle(item),
			workspace: item.cwd
		});
	}
	let matches = candidates;
	if (query !== undefined) {
		// Listing hints usually carry titles; read the rest so a title query does not miss them.
		await fillMissingTitles(ctx, candidates.filter((row) => row.title === undefined).slice(0, MAX_TITLE_READS), exec.signal);
		matches = candidates.filter((row) => row.sessionId.toLowerCase().includes(query) || (row.title ?? "").toLowerCase().includes(query));
	}
	const sessions = matches.slice(0, limit);
	await fillMissingTitles(ctx, sessions, exec.signal);
	const holders = taskHolders(config);
	return {
		...(allWorkspaces ? {} : { workspace }),
		total: matches.length,
		sessions: sessions.map(({ title, workspace: rowWorkspace, ...row }) => ({
			...row,
			...(title === undefined ? {} : { title }),
			...(allWorkspaces ? { workspace: rowWorkspace } : {}),
			...(holders.get(row.sessionId) === undefined ? {} : { task: holders.get(row.sessionId) })
		}))
	};
}

function renderList(value) {
	const scope = value.workspace === undefined ? "all workspaces" : `workspace ${value.workspace}`;
	if (value.sessions.length === 0) {
		return value.workspace === undefined
			? "No other top-level sessions found."
			: `No other top-level sessions found in ${scope}. Set all_workspaces to true to include other workspaces.`;
	}
	const lines = [
		`Sessions in ${scope}, most recently active first (${value.sessions.length} of ${value.total}; this session excluded):`
	];
	for (const row of value.sessions) {
		const title = row.title === undefined ? "untitled" : JSON.stringify(row.title);
		const where = row.workspace === undefined ? "" : ` | workspace ${row.workspace}`;
		const task = row.task === undefined ? "" : ` | task ${JSON.stringify(row.task)}`;
		lines.push(`- ${row.sessionId} [${row.status}] ${title} | active ${row.updatedAt}${where}${task}`);
	}
	return lines.join("\n");
}

const sendOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["messageId", "sessionId", "state", "delivery"],
	properties: {
		messageId: { type: "string" },
		sessionId: { type: "string" },
		title: { type: "string" },
		state: { type: "string", enum: ["running", "idle", "stored"] },
		delivery: { type: "string", enum: ["steer", "queue"] },
		task: {
			type: "object",
			additionalProperties: false,
			required: ["id", "round", "status"],
			properties: {
				id: { type: "string" },
				round: { type: "integer" },
				status: { type: "string", enum: ["dispatched", "doing", "done", "blocked"] },
				tookOver: { type: "boolean" }
			}
		}
	}
};

const listOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["total", "sessions"],
	properties: {
		workspace: { type: "string" },
		total: { type: "integer" },
		sessions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["sessionId", "status", "updatedAt"],
				properties: {
					sessionId: { type: "string" },
					status: { type: "string", enum: ["running", "inactive"] },
					updatedAt: { type: "string" },
					title: { type: "string" },
					workspace: { type: "string" },
					task: { type: "string" }
				}
			}
		}
	}
};

const createOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["sessionId", "workspace", "messageId"],
	properties: {
		sessionId: { type: "string" },
		title: { type: "string" },
		workspace: { type: "string" },
		messageId: { type: "string" },
		task: {
			type: "object",
			additionalProperties: false,
			required: ["id", "round", "status"],
			properties: {
				id: { type: "string" },
				round: { type: "integer" },
				status: { type: "string", enum: ["dispatched"] },
				tookOver: { type: "boolean" }
			}
		}
	}
};

const archiveOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["sessionId", "archived", "ready", "dryRun", "blockers", "tasks"],
	properties: {
		sessionId: { type: "string" },
		archived: { type: "boolean" },
		ready: { type: "boolean" },
		dryRun: { type: "boolean" },
		title: { type: "string" },
		blockers: { type: "array", items: { type: "string" } },
		tasks: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "status", "rounds"],
				properties: {
					id: { type: "string" },
					status: { type: "string" },
					rounds: { type: "integer" },
					lastSummary: { type: "string" }
				}
			}
		}
	}
};

const tasksOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["dir", "total", "tasks"],
	properties: {
		dir: { type: "string" },
		total: { type: "integer" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "status", "rounds", "updatedAt", "done"],
				properties: {
					id: { type: "string" },
					status: { type: "string", enum: ["idle", "doing", "done", "blocked"] },
					rounds: { type: "integer" },
					updatedAt: { type: "string" },
					owner: { type: "string" },
					ownerTitle: { type: "string" },
					title: { type: "string" },
					note: { type: "integer" },
					next: { type: "array", items: { type: "string" } },
					lastSummary: { type: "string" },
					lastAlert: {
						type: "object",
						additionalProperties: false,
						required: ["at", "round", "action"],
						properties: {
							at: { type: "number" },
							round: { type: "integer" },
							action: { type: "string" }
						}
					},
					done: { type: "array", items: { type: "string" } }
				}
			}
		}
	}
};

/** Register the tools and hide them from subagent sessions. */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);

	ctx.tools.register({
		name: SEND_TOOL,
		description:
			"Send a message to another top-level session (a conversation in the session sidebar), such as one found with session_list. " +
			"A busy session reads it at its next step; an idle or stored session is resumed and starts a turn with it. " +
			"The recipient sees your session id and can answer with this tool. Returns delivery confirmation, not the answer; an answer arrives later as a new message. " +
			"Pass task_id to run the message as one round of a named task: it then takes a one-writer lock on that task, carries what is already done, and tells the recipient how to report back.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["session_id", "message"],
			properties: {
				session_id: {
					type: "string",
					description: "Id of the target top-level session, from session_list or from a message you received."
				},
				message: {
					type: "string",
					description: "Self-contained message text; the recipient cannot see your conversation."
				},
				delivery: {
					type: "string",
					enum: ["steer", "queue"],
					description: "steer (default) delivers at the recipient's next step, even mid-turn; queue waits until its current turn ends."
				},
				task_id: {
					type: "string",
					description:
						"Task this message belongs to, such as `login-refactor`. The message then carries the task context and takes the one-writer lock; the recipient reports back with the same id."
				},
				task_title: {
					type: "string",
					description: "Project name shown in the task context; defaults to the target session's title."
				},
				this_round: {
					type: "array",
					items: { type: "string" },
					description: "What this round should do, one item per line. The recipient is told to stay inside these items."
				},
				already_done: {
					type: "array",
					items: { type: "string" },
					description: "Work finished before this round, appended to the ledger's history in the context."
				},
				status: {
					type: "string",
					enum: ["doing", "done", "blocked"],
					description:
						"Report the task's state instead of dispatching a round: done when finished, blocked when the dispatcher must decide, doing for progress. Requires task_id; the sender must be the current task holder."
				},
				round: {
					type: "integer",
					description: "Current task round being reported; include the round shown in the task context."
				},
				done: {
					type: "array",
					items: { type: "string" },
					description: "With status, what this round actually finished."
				},
				note: {
					type: "integer",
					description: "Sticky-note number this task maps to in the workspace; shown as 便签：#N in the context."
				},
				force: {
					type: "boolean",
					description:
						"Take the task over from its current holder, or re-send an identical instruction inside the duplicate window. Use only when you know the holder is not working on it."
				}
			}
		},
		output: {
			schema: sendOutputSchema,
			render: (_args, value) => [{ type: "text", text: renderSend(value) }]
		},
		presentCall: (args) => {
			const id = nonEmpty(args?.session_id);
			// Name a loaded target by its title; a stored one keeps its id.
			const session = id === undefined ? undefined : ctx.sessions.get(id);
			const title = session === undefined ? undefined : liveTitle(ctx, session);
			return {
				card: "generic",
				kind: "other",
				title: title !== undefined ? `Message session ${JSON.stringify(title)}` : `Message session ${id ?? ""}`.trim(),
				...(typeof args?.message === "string" ? { rawInput: args.message } : {})
			};
		},
		execute: (args, exec) => sendMessage(ctx, config, args, exec)
	});

	ctx.tools.register({
		name: LIST_TOOL,
		description:
			"List top-level sessions you can message with session_send_message, most recently active first, with id, status (running or inactive), and title.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: {
					type: "string",
					description: "Case-insensitive text to match against session titles and ids."
				},
				all_workspaces: {
					type: "boolean",
					description: "Include sessions from other workspaces; by default only sessions in this session's workspace are listed."
				},
				limit: {
					type: "integer",
					description: `Maximum sessions to return, from 1 to ${MAX_LIST_LIMIT}; defaults to ${config.listLimit}.`
				}
			}
		},
		output: {
			schema: listOutputSchema,
			render: (_args, value) => [{ type: "text", text: renderList(value) }]
		},
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: "generic",
			kind: "search",
			title: "List sessions",
			...(typeof args?.query === "string" && args.query.trim() !== "" ? { rawInput: args.query } : {})
		}),
		execute: (args, exec) => listSessions(ctx, config, args, exec)
	});

	const opened = new Map();
	ctx.tools.register({
		name: CREATE_TOOL,
		description:
			"Open a new top-level session (a new conversation in the session sidebar) and start it with a message. " +
			"The new session runs independently with default settings and reports back only if your message asks it to reply with session_send_message. " +
			"Returns the new session id.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["title", "message"],
			properties: {
				title: {
					type: "string",
					description: "Short title shown in the session sidebar."
				},
				message: {
					type: "string",
					description: "Self-contained first message; the new session cannot see your conversation."
				},
				workspace: {
					type: "string",
					description: "Absolute path of the workspace to open it in, as session_list shows it; defaults to this session's workspace."
				},
				task_id: {
					type: "string",
					description:
						"Task this new session takes over. The session becomes the task's single writer and receives the task context instead of a bare message."
				},
				this_round: {
					type: "array",
					items: { type: "string" },
					description: "What this round should do, one item per line."
				},
				already_done: {
					type: "array",
					items: { type: "string" },
					description: "Work finished before this round, appended to the ledger's history in the context."
				},
				note: {
					type: "integer",
					description: "Sticky-note number this task maps to in the workspace; shown as 便签：#N in the context."
				},
				force: {
					type: "boolean",
					description: "Take the task over from its current holder. Use only when you know that holder is stuck."
				}
			}
		},
		output: {
			schema: createOutputSchema,
			render: (_args, value) => [{ type: "text", text: renderCreate(value) }]
		},
		presentCall: (args) => ({
			card: "generic",
			kind: "other",
			title: typeof args?.title === "string" && args.title.trim() !== "" ? `Open session ${JSON.stringify(args.title.trim())}` : "Open session",
			...(typeof args?.message === "string" ? { rawInput: args.message } : {})
		}),
		execute: (args, exec) => createSession(ctx, config, opened, args, exec)
	});

	ctx.tools.register({
		name: TASK_TOOL,
		description:
			"Show the task ledger: which session holds which task, how many rounds it ran, what is already done, and what the current round is for. " +
			"A task opens the first time a message carries its task_id. Pass task_id for one task, omit it for the whole board.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				task_id: {
					type: "string",
					description: "Task id to show in detail; omit to list every task, most recently active first."
				},
				limit: {
					type: "integer",
					description: "Maximum tasks to list, from 1 to 100; defaults to 20."
				}
			}
		},
		output: {
			schema: tasksOutputSchema,
			render: (_args, value) => [{ type: "text", text: renderTasks(value) }]
		},
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: "generic",
			kind: "search",
			title: "Task board",
			...(typeof args?.task_id === "string" && args.task_id.trim() !== "" ? { rawInput: args.task_id.trim() } : {})
		}),
		execute: (args, exec) => tasksOverview(config, args, exec)
	});

	ctx.tools.register({
		name: ARCHIVE_TOOL,
		description:
			"Archive a top-level session so it leaves the sidebar without deleting anything, or restore one with unarchive: true. " +
			"Without confirm it only reports whether that session is fit to retire: a session still running a turn, or still holding a task that is in progress or waiting for a decision, is not. " +
			"Pass confirm: true to archive once the report is clean. Its log stays on disk and messaging it is refused until it is restored. " +
			"Deleting is not offered because it cannot be undone.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["session_id"],
			properties: {
				session_id: {
					type: "string",
					description: "Id of the session to archive or restore, from session_list or from a message you received."
				},
				unarchive: {
					type: "boolean",
					description: "Restore an archived session instead of archiving one."
				},
				confirm: {
					type: "boolean",
					description:
						"Archive for real. Omit it to get the retirement check instead: what the session is still holding, and whether it is safe to retire."
				}
			}
		},
		output: {
			schema: archiveOutputSchema,
			render: (_args, value) => [{ type: "text", text: renderArchive(value) }]
		},
		presentCall: (args) => {
			const id = nonEmpty(args?.session_id);
			const session = id === undefined ? undefined : ctx.sessions.get(id);
			const title = session === undefined ? undefined : liveTitle(ctx, session);
			const verb = args?.unarchive === true ? "Restore" : "Archive";
			return {
				card: "generic",
				kind: "other",
				title: title === undefined ? `${verb} session ${id ?? ""}`.trim() : `${verb} session ${JSON.stringify(title)}`
			};
		},
		execute: (args, exec) => archiveSession(ctx, config, args, exec)
	});

	// A subagent cannot be answered through this channel, so it does not see the tools. The
	// restriction lives on `agent.ctx` and in this plugin's effect, so either teardown lifts it.
	const lifts = new Map();
	const hide = (agent) => {
		if (lifts.has(agent) || !isSubagentHeader(agent?.session?.header)) return;
		try {
			lifts.set(agent, agent.ctx.tools.restrict({ deny: TOOL_NAMES }));
		} catch (error) {
			ctx.logger?.warn?.(`session-messaging: could not hide tools from subagent ${agent.id}: ${error?.message ?? error}`);
		}
	};
	ctx.on("agent/created", ({ agent }) => {
		hide(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		lifts.delete(agent);
	});
	ctx.effect(() => {
		for (const agent of ctx.agents.list()) hide(agent);
		return () => {
			for (const lift of lifts.values()) {
				try {
					lift();
				} catch {}
			}
			lifts.clear();
		};
	}, "session-messaging: subagent tool restrictions");

	// A round that stops reporting is the one failure nothing else notices: no tool errors, no
	// stuck turn, just silence. The watchdog turns "no report for long enough" into a retry.
	if (config.watchdog) {
		ctx.effect(() => {
			const timer = setInterval(() => {
				watchdogTick(ctx, config).catch((error) => {
					ctx.logger?.warn?.(`session-messaging: watchdog pass failed: ${error?.message ?? error}`);
				});
			}, config.watchdogTickSeconds * 1000);
			timer.unref?.();
			return () => clearInterval(timer);
		}, "session-messaging: task watchdog");
	}
}
