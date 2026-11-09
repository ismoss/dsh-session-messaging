/**
 * Drives `apply()` through a mocked Harness context: tool registration, delivery to live, idle,
 * and stored sessions, opening new sessions, every refusal path, listing filters, and the subagent
 * tool restriction.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ARCHIVE_TOOL, CREATE_TOOL, LIST_TOOL, SEND_TOOL, TASK_TOOL, TOOL_NAMES, apply, normalizeConfig, relayContent, watchdogTick } from "../lib/index.js";
import { DEFAULT_DUP_WINDOW_MINUTES, deriveState, recordDispatch, stateOf } from "../lib/tasks.js";

const WORKSPACE = "/work/main";
const T0 = Date.parse("2026-11-09T03:00:00.000Z");

function tempDir() {
	return mkdtempSync(join(tmpdir(), "dsh-session-messaging-"));
}

function makeAgent(id, { cwd = WORKSPACE, status = "idle", origin, title } = {}) {
	const agent = {
		id,
		status,
		received: [],
		restrictions: [],
		session: { id, header: { id, cwd, ...(origin === undefined ? {} : { origin }) }, title },
		steer(message) {
			this.received.push({ via: "steer", message, titled: this.session.title });
		},
		followup(message) {
			this.received.push({ via: "followup", message, titled: this.session.title });
		}
	};
	agent.ctx = {
		tools: {
			restrict(filter) {
				agent.restrictions.push(filter);
				return () => {
					agent.restrictions = agent.restrictions.filter((entry) => entry !== filter);
				};
			}
		}
	};
	return agent;
}

/** Minimal stand-in for the Harness services the plugin injects. */
function harness({ live = [], stored = [], summaries = [], archived = [], titles = {}, workspaces = [] } = {}) {
	const tools = new Map();
	const listeners = new Map();
	const disposers = [];
	const agents = new Map(live.map((agent) => [agent.id, agent]));
	const resumed = [];
	const flushed = [];
	const initiatorFree = [];
	const createRequests = [];
	let createFailure;
	let inWithout = false;
	const sessionTitle = {
		get: (session) => (session.title === undefined ? undefined : { title: session.title }),
		rename(session, title) {
			session.title = title.trim();
			return { title: session.title };
		}
	};
	const archiveCalls = [];
	const workspaceRegistry = {
		archivedSessionIds: archived,
		// Like the real registry: a missing path rejects, an existing unowned directory is undefined.
		resolveByPath: async (path) => {
			if (path.startsWith("/missing")) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return workspaces.find((workspace) => workspace.path === path);
		},
		archiveSession: async (id, options) => {
			archiveCalls.push({ action: "archive", id, options });
		},
		unarchiveSession: async (id) => {
			archiveCalls.push({ action: "unarchive", id });
		}
	};
	const ctx = {
		logger: { warn() {} },
		get(name) {
			if (name === "sessionTitle") return sessionTitle;
			if (name === "workspaceRegistry") return workspaceRegistry;
			return undefined;
		},
		effect(fn) {
			disposers.push(fn());
		},
		on(event, fn) {
			listeners.set(event, fn);
		},
		tools: { register: (definition) => tools.set(definition.name, definition) },
		agents: {
			get: (id) => agents.get(id),
			list: () => [...agents.values()],
			withoutInitiator(operation) {
				inWithout = true;
				try {
					return operation();
				} finally {
					inWithout = false;
				}
			}
		},
		sessions: {
			get: (id) => agents.get(id)?.session,
			flush: async (session) => {
				flushed.push(session.id);
				return true;
			}
		},
		sessionQuery: {
			filterSessions: async (filters) => {
				const ids = filters.find((filter) => filter.kind === "id")?.values ?? [];
				return stored.filter((header) => ids.includes(header.id)).map((header) => ({ header }));
			},
			readTitleSnapshots: async (ids) =>
				ids.map((sessionId) => ({
					sessionId,
					status: "fulfilled",
					value: { session: { id: sessionId }, ...(titles[sessionId] === undefined ? {} : { title: { title: titles[sessionId] } }) }
				}))
		},
		sessionController: {
			resolveAgent: async (id) => {
				initiatorFree.push(inWithout);
				const existing = agents.get(id);
				if (existing !== undefined) return { agent: existing };
				const header = stored.find((entry) => entry.id === id);
				if (header === undefined) return { error: { code: "session/not-found", message: `session "${id}" not found` } };
				const agent = makeAgent(id, { cwd: header.cwd, title: header.title });
				agents.set(id, agent);
				resumed.push(id);
				return { agent };
			},
			create: async (request) => {
				createRequests.push({ request, initiatorFree: inWithout });
				if (createFailure !== undefined) throw createFailure;
				const workspace = workspaces.find((entry) => entry.id === request.workspaceId);
				const id = `session-new-${createRequests.length}`;
				agents.set(id, makeAgent(id, { cwd: workspace.path }));
				return { sessionId: id };
			},
			list: async () => ({ items: summaries })
		}
	};
	const failCreate = (error) => {
		createFailure = error;
	};
	return { ctx, tools, listeners, disposers, agents, resumed, flushed, initiatorFree, createRequests, failCreate, archiveCalls };
}

function exec(agent) {
	return { agent, signal: new AbortController().signal };
}

test("registers every tool with the supported schema subset", () => {
	const h = harness();
	apply(h.ctx, {});
	assert.deepEqual([...h.tools.keys()].sort(), [...TOOL_NAMES].sort());
	const allowed = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"]);
	const walk = (node, path) => {
		for (const key of Object.keys(node)) assert.ok(allowed.has(key), `${path}.${key} is outside the supported subset`);
		for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${key}`);
		if (node.items) walk(node.items, `${path}.items`);
	};
	for (const tool of h.tools.values()) {
		walk(tool.parameters, `${tool.name}.parameters`);
		walk(tool.output.schema, `${tool.name}.output`);
	}
});

test("the send card names a loaded target by its title and a stored one by its id", () => {
	const target = makeAgent("session-b", { title: "Fix login timeout" });
	const h = harness({ live: [target] });
	apply(h.ctx, {});
	const present = h.tools.get(SEND_TOOL).presentCall;
	assert.deepEqual(present({ session_id: "session-b", message: "hi" }), {
		card: "generic",
		kind: "other",
		title: 'Message session "Fix login timeout"',
		rawInput: "hi"
	});
	assert.equal(present({ session_id: "session-stored" }).title, "Message session session-stored");
	assert.equal(present({}).title, "Message session");
});

test("steers an attributed relay message into an idle live session", async () => {
	const sender = makeAgent("session-a", { title: "Sender work" });
	const target = makeAgent("session-b", { title: "Target work" });
	const h = harness({ live: [sender, target] });
	apply(h.ctx, {});
	const value = await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "Please rebase." }, exec(sender));
	assert.equal(value.sessionId, "session-b");
	assert.equal(value.state, "idle");
	assert.equal(value.delivery, "steer");
	assert.equal(value.title, "Target work");
	assert.equal(target.received.length, 1);
	const { via, message } = target.received[0];
	assert.equal(via, "steer");
	assert.equal(message.id, value.messageId);
	assert.equal(message.role, "user");
	assert.deepEqual(message.source, { kind: "agent-message", form: "relay", senderSessionId: "session-a" });
	assert.match(message.content[0].text, /^Message from session "session-a" \("Sender work"\)\. /);
	assert.match(message.content[0].text, /not by your user/);
	assert.match(message.content[0].text, /call session_send_message with session_id "session-a"; do not reply only to acknowledge it\.\n\n$/);
	assert.equal(message.content[1].text, "Please rebase.");
	assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content[0]));
	assert.deepEqual(h.initiatorFree, [true]);
	assert.deepEqual(h.flushed, ["session-b"]);
	assert.match(h.tools.get(SEND_TOOL).output.render({}, value)[0].text, /was idle and is starting a turn/);
});

test("resumes a stored session and names the sender workspace when it differs", async () => {
	const sender = makeAgent("session-a");
	const h = harness({ live: [sender], stored: [{ id: "session-c", cwd: "/work/other" }] });
	apply(h.ctx, {});
	const value = await h.tools.get(SEND_TOOL).execute({ session_id: "session-c", message: "hi" }, exec(sender));
	assert.equal(value.state, "stored");
	assert.deepEqual(h.resumed, ["session-c"]);
	const message = h.agents.get("session-c").received[0].message;
	assert.match(message.content[0].text, /^Message from session "session-a" in workspace \/work\/main\. /);
	assert.match(h.tools.get(SEND_TOOL).output.render({}, value)[0].text, /resumed from storage/);
});

test("queue delivery uses followup for a running session", async () => {
	const sender = makeAgent("session-a");
	const target = makeAgent("session-b", { status: "running" });
	const h = harness({ live: [sender, target] });
	apply(h.ctx, {});
	const value = await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "later", delivery: "queue" }, exec(sender));
	assert.equal(value.state, "running");
	assert.equal(target.received[0].via, "followup");
	assert.match(h.tools.get(SEND_TOOL).output.render({}, value)[0].text, /after the current one ends/);
});

test("refuses invalid senders, targets, and oversized messages without delivering", async () => {
	const sender = makeAgent("session-a");
	const child = makeAgent("session-child", { origin: "subagent" });
	const target = makeAgent("session-b");
	const h = harness({
		live: [sender, child, target],
		stored: [{ id: "session-arch", cwd: WORKSPACE }, { id: "session-far", cwd: "/elsewhere" }],
		archived: ["session-arch"]
	});
	apply(h.ctx, { maxMessageBytes: 300 });
	const send = (args, caller = sender) => h.tools.get(SEND_TOOL).execute(args, exec(caller));
	await assert.rejects(send({ session_id: "session-a", message: "x" }), /cannot message itself/);
	await assert.rejects(send({ session_id: "session-b", message: "   " }), /non-whitespace/);
	await assert.rejects(send({ session_id: "session-b", message: "x", delivery: "now" }), /delivery must be/);
	await assert.rejects(send({ session_id: "nope", message: "x" }), /was not found/);
	await assert.rejects(send({ session_id: "session-child", message: "x" }), /subagent session/);
	await assert.rejects(send({ session_id: "session-arch", message: "x" }), /archived/);
	await assert.rejects(send({ session_id: "session-b", message: "x".repeat(400) }), /exceeds the 300-byte limit/);
	await assert.rejects(send({ session_id: "session-b", message: "x" }, child), /only available to top-level sessions/);
	await assert.rejects(h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "x" }, { signal: new AbortController().signal }), /requires a calling session/);
	assert.equal(target.received.length, 0);
	assert.deepEqual(h.resumed, []);

	const closed = harness({ live: [sender], stored: [{ id: "session-far", cwd: "/elsewhere" }] });
	apply(closed.ctx, { crossWorkspace: false });
	await assert.rejects(closed.tools.get(SEND_TOOL).execute({ session_id: "session-far", message: "x" }, exec(sender)), /crossWorkspace: false/);
	assert.deepEqual(closed.resumed, []);
});

test("reports a resolve failure as an undelivered message", async () => {
	const sender = makeAgent("session-a");
	const h = harness({ live: [sender], stored: [{ id: "session-x", cwd: WORKSPACE }] });
	h.ctx.sessionController.resolveAgent = async () => ({ error: { code: "session/writer-held", message: "writer held by another process" } });
	apply(h.ctx, {});
	await assert.rejects(h.tools.get(SEND_TOOL).execute({ session_id: "session-x", message: "x" }, exec(sender)), /message not delivered: writer held/);
});

test("lists messageable sessions in this workspace by default", async () => {
	const caller = makeAgent("session-a");
	const summaries = [
		{ sessionId: "session-a", updatedAt: 9, running: true, blank: false, cwd: WORKSPACE },
		{ sessionId: "session-run", updatedAt: 8, running: true, blank: false, cwd: WORKSPACE, projections: { values: { title: "Refactor auth" } } },
		{ sessionId: "session-blank", updatedAt: 7, running: false, blank: true, cwd: WORKSPACE },
		{ sessionId: "session-sub", updatedAt: 6, running: false, blank: false, cwd: WORKSPACE, origin: "subagent" },
		{ sessionId: "session-arch", updatedAt: 5, running: false, blank: false, cwd: WORKSPACE },
		{ sessionId: "session-far", updatedAt: 4, running: false, blank: false, cwd: "/elsewhere", projections: { values: { title: "Other repo" } } },
		{ sessionId: "session-cold", updatedAt: 3, running: false, blank: false, cwd: WORKSPACE }
	];
	const h = harness({ live: [caller], summaries, archived: ["session-arch"], titles: { "session-cold": "Write docs" } });
	apply(h.ctx, {});
	const list = (args) => h.tools.get(LIST_TOOL).execute(args, exec(caller));

	const local = await list({});
	assert.equal(local.workspace, WORKSPACE);
	assert.deepEqual(local.sessions.map((row) => [row.sessionId, row.status, row.title]), [
		["session-run", "running", "Refactor auth"],
		["session-cold", "inactive", "Write docs"]
	]);
	assert.ok(local.sessions.every((row) => row.workspace === undefined));
	const text = h.tools.get(LIST_TOOL).output.render({}, local)[0].text;
	assert.match(text, /^Sessions in workspace \/work\/main, most recently active first \(2 of 2; this session excluded\):/);
	assert.match(text, /- session-run \[running\] "Refactor auth" \| active /);

	const everywhere = await list({ all_workspaces: true, limit: 2 });
	assert.equal(everywhere.workspace, undefined);
	assert.equal(everywhere.total, 3);
	assert.deepEqual(everywhere.sessions.map((row) => [row.sessionId, row.workspace]), [
		["session-run", WORKSPACE],
		["session-far", "/elsewhere"]
	]);

	const byReadTitle = await list({ query: "DOCS" });
	assert.deepEqual(byReadTitle.sessions.map((row) => [row.sessionId, row.title]), [["session-cold", "Write docs"]]);
	const byTitleHint = await list({ query: "auth" });
	assert.deepEqual(byTitleHint.sessions.map((row) => row.sessionId), ["session-run"]);
	const byId = await list({ query: "SESSION-COLD" });
	assert.deepEqual(byId.sessions.map((row) => row.sessionId), ["session-cold"]);

	const none = harness({ live: [caller], summaries: [summaries[0]] });
	apply(none.ctx, {});
	const empty = await none.tools.get(LIST_TOOL).execute({}, exec(caller));
	assert.match(none.tools.get(LIST_TOOL).output.render({}, empty)[0].text, /Set all_workspaces to true/);

	const closed = harness({ live: [caller], summaries });
	apply(closed.ctx, { crossWorkspace: false });
	await assert.rejects(closed.tools.get(LIST_TOOL).execute({ all_workspaces: true }, exec(caller)), /crossWorkspace: false/);
});

const WORKSPACES = [
	{ id: "ws-main", path: WORKSPACE },
	{ id: "ws-other", path: "/work/other" }
];

test("opens a titled session in this workspace and starts it with an attributed message", async () => {
	const creator = makeAgent("session-a", { title: "Planner" });
	const h = harness({ live: [creator], workspaces: WORKSPACES });
	apply(h.ctx, {});
	const value = await h.tools.get(CREATE_TOOL).execute({ title: "  Write release notes ", message: "Draft notes for v2." }, exec(creator));
	assert.deepEqual(h.createRequests, [{ request: { workspaceId: "ws-main" }, initiatorFree: true }]);
	assert.deepEqual(h.initiatorFree, [true]);
	assert.equal(value.sessionId, "session-new-1");
	assert.equal(value.title, "Write release notes");
	assert.equal(value.workspace, WORKSPACE);
	const opened = h.agents.get("session-new-1");
	assert.equal(opened.received.length, 1);
	const { via, message, titled } = opened.received[0];
	assert.equal(via, "followup");
	assert.equal(titled, "Write release notes", "the title is set before the first turn starts");
	assert.equal(message.id, value.messageId);
	assert.deepEqual(message.source, { kind: "agent-message", form: "relay", senderSessionId: "session-a" });
	assert.match(message.content[0].text, /^Message from session "session-a" \("Planner"\)\. .*\n\n$/s);
	assert.equal(message.content[1].text, "Draft notes for v2.");
	assert.deepEqual(h.flushed, ["session-new-1"]);
	assert.equal(
		h.tools.get(CREATE_TOOL).output.render({}, value)[0].text,
		'Opened session session-new-1 ("Write release notes") in workspace /work/main. It is starting a turn with your message.'
	);
});

test("opens a session in another registered workspace and names the creator's workspace", async () => {
	const creator = makeAgent("session-a");
	const h = harness({ live: [creator], workspaces: WORKSPACES });
	apply(h.ctx, {});
	const value = await h.tools.get(CREATE_TOOL).execute({ title: "Other", message: "hi", workspace: "/work/other" }, exec(creator));
	assert.equal(value.workspace, "/work/other");
	assert.deepEqual(h.createRequests.map((entry) => entry.request), [{ workspaceId: "ws-other" }]);
	const { message } = h.agents.get(value.sessionId).received[0];
	assert.match(message.content[0].text, /^Message from session "session-a" in workspace \/work\/main\. /);
});

test("refuses to open a session without a title, a message, or a registered workspace", async () => {
	const creator = makeAgent("session-a");
	const child = makeAgent("session-child", { origin: "subagent" });
	const stray = makeAgent("session-stray", { cwd: "/tmp/unregistered" });
	const h = harness({ live: [creator, child, stray], workspaces: WORKSPACES });
	apply(h.ctx, { maxMessageBytes: 300 });
	const create = (args, caller = creator) => h.tools.get(CREATE_TOOL).execute(args, exec(caller));
	await assert.rejects(create({ title: "  ", message: "x" }), /title must contain/);
	await assert.rejects(create({ title: "t", message: "" }), /message must contain/);
	await assert.rejects(create({ title: "t", message: "x", workspace: "work/main" }), /absolute directory path/);
	await assert.rejects(create({ title: "t", message: "x", workspace: "/missing/dir" }), /not a registered workspace/);
	await assert.rejects(create({ title: "t", message: "x", workspace: "/work/unowned" }), /not a registered workspace/);
	await assert.rejects(create({ title: "t", message: "x".repeat(400) }), /over the 300-byte limit/);
	await assert.rejects(create({ title: "t", message: "x" }, child), /only available to top-level sessions/);
	await assert.rejects(create({ title: "t", message: "x" }, stray), /not in a registered workspace/);
	assert.deepEqual(h.createRequests, []);

	const closed = harness({ live: [creator], workspaces: WORKSPACES });
	apply(closed.ctx, { crossWorkspace: false });
	await assert.rejects(
		closed.tools.get(CREATE_TOOL).execute({ title: "t", message: "x", workspace: "/work/other" }, exec(creator)),
		/crossWorkspace: false/
	);
	assert.deepEqual(closed.createRequests, []);
});

test("stops at createLimit, and a failed creation gives its slot back", async () => {
	const creator = makeAgent("session-a");
	const h = harness({ live: [creator], workspaces: WORKSPACES });
	apply(h.ctx, { createLimit: 2 });
	const create = () => h.tools.get(CREATE_TOOL).execute({ title: "t", message: "x" }, exec(creator));
	h.failCreate(new Error("disk full"));
	await assert.rejects(create(), /^Error: session not opened: disk full$/);
	h.failCreate(undefined);
	await create();
	await create();
	await assert.rejects(create(), /limit of 2 new sessions per Harness run/);
	assert.equal(h.createRequests.length, 3);
});

test("reports a session that opened but could not take its message", async () => {
	const creator = makeAgent("session-a");
	const h = harness({ live: [creator], workspaces: WORKSPACES });
	h.ctx.sessionController.resolveAgent = async () => ({ error: { code: "session/agent-busy", message: "agent busy" } });
	apply(h.ctx, {});
	await assert.rejects(
		h.tools.get(CREATE_TOOL).execute({ title: "t", message: "x" }, exec(creator)),
		/session session-new-1 was opened but did not receive the message: agent busy/
	);
});

test("hides the tools from subagents, including ones live before activation", () => {
	const early = makeAgent("session-early-child", { origin: "subagent" });
	const root = makeAgent("session-root");
	const h = harness({ live: [early, root] });
	apply(h.ctx, {});
	assert.deepEqual(early.restrictions, [{ deny: TOOL_NAMES }]);
	assert.deepEqual(root.restrictions, []);

	const late = makeAgent("session-late-child", { origin: "subagent" });
	h.listeners.get("agent/created")({ agent: late });
	h.listeners.get("agent/created")({ agent: makeAgent("session-root-2") });
	assert.deepEqual(late.restrictions, [{ deny: TOOL_NAMES }]);

	for (const dispose of h.disposers) dispose?.();
	assert.deepEqual(early.restrictions, []);
	assert.deepEqual(late.restrictions, []);
});

test("normalizes config and builds attribution text", () => {
	assert.deepEqual(normalizeConfig(undefined), {
		crossWorkspace: true,
		maxMessageBytes: 65536,
		listLimit: 20,
		createLimit: 10,
		taskDir: undefined,
		dupWindowMinutes: DEFAULT_DUP_WINDOW_MINUTES,
		watchdog: true,
		watchdogMinutes: 25,
		autoRetry: true,
		maxRetries: 2,
		watchdogTickSeconds: 60
	});
	assert.deepEqual(normalizeConfig({ crossWorkspace: false, maxMessageBytes: -1, listLimit: 500, createLimit: 0 }), {
		crossWorkspace: false,
		maxMessageBytes: 65536,
		listLimit: 100,
		createLimit: 10,
		taskDir: undefined,
		dupWindowMinutes: DEFAULT_DUP_WINDOW_MINUTES,
		watchdog: true,
		watchdogMinutes: 25,
		autoRetry: true,
		maxRetries: 2,
		watchdogTickSeconds: 60
	});
	assert.deepEqual(normalizeConfig({ taskDir: "  E:/tasks  ", dupWindowMinutes: 0, watchdog: false, watchdogMinutes: 0, maxRetries: -1 }), {
		crossWorkspace: true,
		maxMessageBytes: 65536,
		listLimit: 20,
		createLimit: 10,
		taskDir: "E:/tasks",
		dupWindowMinutes: 0,
		watchdog: false,
		watchdogMinutes: 25,
		autoRetry: true,
		maxRetries: 2,
		watchdogTickSeconds: 60
	});
	const [head, body] = relayContent({ id: 'say "hi"', title: 'a "b"' }, "text");
	assert.equal(head.text.startsWith('Message from session "say \\"hi\\"" ("a \\"b\\""). '), true);
	assert.equal(body.text, "text");
});

test("a dispatch carrying task_id injects the ledger context and takes the lock", async () => {
	const dir = tempDir();
	const sender = makeAgent("session-a");
	const target = makeAgent("session-b", { title: "Login refactor" });
	const h = harness({ live: [sender, target] });
	apply(h.ctx, { taskDir: dir });
	const value = await h.tools
		.get(SEND_TOOL)
		.execute({ session_id: "session-b", message: "把登录页接到 AuthService", task_id: "login", this_round: ["接到 AuthService"] }, exec(sender));
	assert.deepEqual(value.task, { id: "login", round: 1, status: "dispatched" });
	const message = target.received[0].message;
	assert.equal(message.content.length, 3);
	assert.equal(message.content[2].text, "把登录页接到 AuthService");
	const context = message.content[1].text;
	assert.match(context, /^【任务 login · 第 1 轮 · 进行中】/);
	assert.match(context, /项目：Login refactor/);
	assert.match(context, /- （无，这是第一轮）/);
	assert.match(context, /本次只做：\n- 接到 AuthService/);
	assert.match(context, /session_id="session-a", task_id="login", status="done"/);
	assert.match(h.tools.get(SEND_TOOL).output.render({}, value)[0].text, /Task "login" round 1 is now held by that session\./);
	assert.equal(stateOf(dir, "login").owner, "session-b");
	assert.equal(stateOf(dir, "login").rounds, 1);
});

test("a plain message stays three-part-free", async () => {
	const sender = makeAgent("session-a");
	const target = makeAgent("session-b");
	const h = harness({ live: [sender, target] });
	apply(h.ctx, { taskDir: tempDir() });
	const value = await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "hi" }, exec(sender));
	assert.equal(value.task, undefined);
	assert.equal(target.received[0].message.content.length, 2);
});

test("one task has one writer: a second session is refused until it forces a takeover", async () => {
	const dir = tempDir();
	const sender = makeAgent("session-a");
	const first = makeAgent("session-b", { title: "Builder" });
	const second = makeAgent("session-c", { title: "Other" });
	const h = harness({ live: [sender, first, second] });
	apply(h.ctx, { taskDir: dir });
	const send = (args) => h.tools.get(SEND_TOOL).execute({ task_id: "login", message: "go", ...args }, exec(sender));
	await send({ session_id: "session-b", this_round: ["step 1"] });
	await assert.rejects(send({ session_id: "session-c", this_round: ["step 2"] }), /is held by session session-b \("Builder"\)/);
	assert.equal(second.received.length, 0);

	const forced = await send({ session_id: "session-c", this_round: ["step 2"], force: true });
	assert.deepEqual(forced.task, { id: "login", round: 2, status: "dispatched", tookOver: true });
	assert.match(h.tools.get(SEND_TOOL).output.render({}, forced)[0].text, /taken over from its previous owner/);
	const context = second.received[0].message.content[1].text;
	assert.match(context, /第 2 轮/);
	assert.equal(stateOf(dir, "login").owner, "session-c");
});

test("a report releases the lock and lands in the next round's history", async () => {
	const dir = tempDir();
	const a = makeAgent("session-a");
	const b = makeAgent("session-b", { title: "Builder" });
	const c = makeAgent("session-c");
	const h = harness({ live: [a, b, c] });
	apply(h.ctx, { taskDir: dir });
	const send = (caller, args) => h.tools.get(SEND_TOOL).execute({ task_id: "login", ...args }, exec(caller));

	await send(a, { session_id: "session-b", message: "go", this_round: ["接到 AuthService"] });
	const reported = await send(b, {
		session_id: "session-a",
		message: "接好了，单测也过了",
		status: "done",
		done: ["拆出 AuthService", "登录页已接上"]
	});
	assert.deepEqual(reported.task, { id: "login", round: 1, status: "done" });
	assert.match(h.tools.get(SEND_TOOL).output.render({}, reported)[0].text, /Recorded task "login" as done\./);
	const after = stateOf(dir, "login");
	assert.equal(after.status, "done");
	assert.deepEqual(after.done, ["拆出 AuthService", "登录页已接上"]);
	assert.equal(after.summary, "接好了，单测也过了");

	// done releases the task: another session may pick it up, and sees what is already finished.
	const next = await send(a, { session_id: "session-c", message: "接着做", this_round: ["补 E2E"] });
	assert.equal(next.task.round, 2);
	const context = c.received[0].message.content[1].text;
	assert.match(context, /- 拆出 AuthService\n- 登录页已接上/);
	assert.match(context, /- 补 E2E/);
});

test("reporting needs a task, and an unknown status is refused", async () => {
	const sender = makeAgent("session-a");
	const target = makeAgent("session-b");
	const h = harness({ live: [sender, target] });
	apply(h.ctx, { taskDir: tempDir() });
	const send = (args) => h.tools.get(SEND_TOOL).execute(args, exec(sender));
	await assert.rejects(send({ session_id: "session-b", message: "x", status: "done" }), /status requires task_id/);
	await assert.rejects(send({ session_id: "session-b", message: "x", task_id: "t", status: "finished" }), /status must be/);
	assert.equal(target.received.length, 0);
});

test("repeating the same instruction inside the window is refused unless forced", async () => {
	const dir = tempDir();
	const sender = makeAgent("session-a");
	const target = makeAgent("session-b");
	const h = harness({ live: [sender, target] });
	apply(h.ctx, { taskDir: dir, dupWindowMinutes: 60 });
	const send = (args) => h.tools.get(SEND_TOOL).execute({ session_id: "session-b", task_id: "login", message: "go", ...args }, exec(sender));
	await send({ this_round: ["same"] });
	await assert.rejects(send({ this_round: ["same"] }), /already dispatched this exact instruction/);
	await send({ this_round: ["different"] });
	await send({ this_round: ["same"], force: true });
	assert.equal(target.received.length, 3);
});

test("session_create with task_id makes the new session the single writer", async () => {
	const dir = tempDir();
	const creator = makeAgent("session-a");
	const h = harness({ live: [creator], workspaces: WORKSPACES });
	apply(h.ctx, { taskDir: dir });
	const value = await h.tools.get(CREATE_TOOL).execute(
		{ title: "Login refactor", message: "开工", task_id: "login", this_round: ["先拆服务"], note: 3 },
		exec(creator)
	);
	assert.deepEqual(value.task, { id: "login", round: 1, status: "dispatched" });
	const opened = h.agents.get(value.sessionId);
	const context = opened.received[0].message.content[1].text;
	assert.match(context, /项目：Login refactor/);
	assert.match(context, /便签：#3/);
	const state = stateOf(dir, "login");
	assert.equal(state.owner, value.sessionId);
	assert.equal(state.note, 3);
	assert.equal(state.title, "Login refactor");

	// A second create for the same held task is refused; reporting done frees it.
	await assert.rejects(
		h.tools.get(CREATE_TOOL).execute({ title: "Another", message: "x", task_id: "login" }, exec(creator)),
		/is held by session/
	);
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-a", message: "done", task_id: "login", status: "done" }, exec(opened));
	assert.equal(stateOf(dir, "login").status, "done");
});

test("session_create cannot report a status", async () => {
	const creator = makeAgent("session-a");
	const h = harness({ live: [creator], workspaces: WORKSPACES });
	apply(h.ctx, { taskDir: tempDir() });
	await assert.rejects(
		h.tools.get(CREATE_TOOL).execute({ title: "t", message: "x", task_id: "login", status: "done" }, exec(creator)),
		/cannot report a task status/
	);
	assert.deepEqual(h.createRequests, []);
});

test("session_tasks shows the board, one task, and refuses unknown ids", async () => {
	const dir = tempDir();
	const sender = makeAgent("session-a");
	const target = makeAgent("session-b", { title: "Builder" });
	const h = harness({ live: [sender, target] });
	apply(h.ctx, { taskDir: dir });
	const tasks = (args) => h.tools.get(TASK_TOOL).execute(args, exec(sender));

	const empty = await tasks({});
	assert.equal(empty.total, 0);
	assert.match(h.tools.get(TASK_TOOL).output.render({}, empty)[0].text, /No task ledger under/);
	await assert.rejects(tasks({ task_id: "ghost" }), /no ledger for task "ghost"/);

	await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "go", task_id: "login", this_round: ["step"], note: 2 }, exec(sender));
	const board = await tasks({});
	assert.equal(board.total, 1);
	assert.equal(board.tasks[0].owner, "session-b");
	assert.equal(board.tasks[0].ownerTitle, "Builder");
	assert.deepEqual(board.tasks[0].next, ["step"]);
	assert.equal(board.tasks[0].note, 2);
	const text = h.tools.get(TASK_TOOL).output.render({}, board)[0].text;
	assert.match(text, /- login \[doing\] round 1 owner session-b \("Builder"\) \| this round: step/);

	const one = await tasks({ task_id: "login" });
	assert.equal(one.total, 1);
});

test("session_list marks the task each session holds", async () => {
	const dir = tempDir();
	const caller = makeAgent("session-b");
	const summaries = [
		{ sessionId: "session-a", updatedAt: 9, running: false, blank: false, cwd: WORKSPACE, projections: { values: { title: "Planner" } } },
		{ sessionId: "session-b", updatedAt: 8, running: true, blank: false, cwd: WORKSPACE },
		{ sessionId: "session-c", updatedAt: 7, running: false, blank: false, cwd: WORKSPACE }
	];
	const h = harness({ live: [caller], stored: [{ id: "session-c", cwd: WORKSPACE }], summaries });
	apply(h.ctx, { taskDir: dir });
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-c", message: "go", task_id: "login" }, exec(makeAgent("session-a")));
	const list = await h.tools.get(LIST_TOOL).execute({}, exec(caller));
	const byId = new Map(list.sessions.map((row) => [row.sessionId, row]));
	assert.equal(byId.get("session-c").task, "login");
	assert.equal(byId.get("session-a").task, undefined);
	assert.match(h.tools.get(LIST_TOOL).output.render({}, list)[0].text, /- session-c \[inactive\] untitled \| active \S+ \| task "login"/);
});


test("the watchdog re-dispatches a silent round and tells the hub", async () => {
	const dir = tempDir();
	const hub = makeAgent("session-hub", { title: "Hub" });
	const worker = makeAgent("session-b", { title: "Builder" });
	const h = harness({ live: [hub, worker] });
	const raw = { taskDir: dir, watchdog: false, watchdogMinutes: 25 };
	apply(h.ctx, raw);
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "go", task_id: "login", this_round: ["step one"] }, exec(hub));

	const acted = await watchdogTick(h.ctx, normalizeConfig(raw), { now: Date.now() + 26 * 60_000 });
	assert.deepEqual(acted, [{ id: "login", action: "redispatch", round: 1 }]);

	const retry = worker.received.at(-1).message;
	assert.match(retry.content[0].text, /^【看门狗重派】/);
	assert.match(retry.content[0].text, /session "session-hub"/);
	assert.match(retry.content[1].text, /【任务 login · 第 2 轮 · 进行中】/);
	assert.deepEqual(retry.source, { kind: "agent-message", form: "watchdog", task: "login" });

	const notice = hub.received.at(-1).message;
	assert.match(notice.content[0].text, /【看门狗】任务 login · 第 1 轮/);
	assert.match(notice.content[0].text, /已自动重派为第 2 轮/);
	assert.equal(stateOf(dir, "login").rounds, 2);
	assert.equal(stateOf(dir, "login").status, "doing");
});

test("a running session is never treated as lost", async () => {
	const dir = tempDir();
	const hub = makeAgent("session-hub");
	const worker = makeAgent("session-b", { status: "running" });
	const h = harness({ live: [hub, worker] });
	const raw = { taskDir: dir, watchdog: false };
	apply(h.ctx, raw);
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "go", task_id: "login", this_round: ["x"] }, exec(hub));
	const acted = await watchdogTick(h.ctx, normalizeConfig(raw), { now: Date.now() + 60 * 60_000 });
	assert.deepEqual(acted, []);
	assert.equal(worker.received.length, 1, "no second message was pushed into a live turn");
});

test("a round inside the window is untouched", async () => {
	const dir = tempDir();
	const hub = makeAgent("session-hub");
	const worker = makeAgent("session-b");
	const h = harness({ live: [hub, worker] });
	const raw = { taskDir: dir, watchdog: false, watchdogMinutes: 25 };
	apply(h.ctx, raw);
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "go", task_id: "login" }, exec(hub));
	const acted = await watchdogTick(h.ctx, normalizeConfig(raw), { now: Date.now() + 10 * 60_000 });
	assert.deepEqual(acted, []);
});

test("with autoRetry off the watchdog only reports, and stops at maxRetries", async () => {
	const dir = tempDir();
	const hub = makeAgent("session-hub");
	const worker = makeAgent("session-b");
	const h = harness({ live: [hub, worker] });
	const off = normalizeConfig({ taskDir: dir, watchdog: false, autoRetry: false });
	apply(h.ctx, { taskDir: dir, watchdog: false, autoRetry: false });
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "go", task_id: "login", this_round: ["x"] }, exec(hub));
	const first = await watchdogTick(h.ctx, off, { now: Date.now() + 26 * 60_000 });
	assert.deepEqual(first, [{ id: "login", action: "exhausted", round: 1 }]);
	assert.equal(worker.received.length, 1, "nothing was pushed to the worker");
	assert.match(hub.received.at(-1).message.content[0].text, /停手等你决定/);

	const limited = tempDir();
	const h2 = harness({ live: [makeAgent("session-hub2"), makeAgent("session-b2")] });
	const raw = { taskDir: limited, watchdog: false, maxRetries: 1 };
	apply(h2.ctx, raw);
	const hub2 = h2.agents.get("session-hub2");
	const worker2 = h2.agents.get("session-b2");
	await h2.tools.get(SEND_TOOL).execute({ session_id: "session-b2", message: "go", task_id: "t2", this_round: ["y"] }, exec(hub2));
	const config = normalizeConfig(raw);
	await watchdogTick(h2.ctx, config, { now: Date.now() + 26 * 60_000 });
	const again = await watchdogTick(h2.ctx, config, { now: Date.now() + 52 * 60_000 });
	assert.deepEqual(again, [{ id: "t2", action: "exhausted", round: 2 }]);
	assert.equal(worker2.received.length, 2, "exactly one retry reached the worker");
	assert.equal(stateOf(limited, "t2").attempts, 1);
});

test("a report resets the retry budget", () => {
	const events = [
		{ at: new Date(T0).toISOString(), kind: "alert", task: "t", round: 1, action: "redispatch" },
		{ at: new Date(T0 + 1000).toISOString(), kind: "alert", task: "t", round: 2, action: "redispatch" },
		{ at: new Date(T0 + 2000).toISOString(), kind: "report", task: "t", by: "s-a", status: "blocked" }
	];
	const state = deriveState("t", events);
	assert.equal(state.attempts, 0);
	assert.equal(state.status, "blocked");
});

test("a progress report does not redirect the watchdog's notice to the worker", async () => {
	const dir = tempDir();
	const hub = makeAgent("session-hub", { title: "Hub" });
	const worker = makeAgent("session-b", { title: "Builder" });
	const h = harness({ live: [hub, worker] });
	const raw = { taskDir: dir, watchdog: false };
	apply(h.ctx, raw);
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "go", task_id: "login", this_round: ["x"] }, exec(hub));
	// The worker reports progress; the dispatcher is still the hub.
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-hub", message: "半程", task_id: "login", status: "doing" }, exec(worker));
	assert.equal(stateOf(dir, "login").by, "session-hub");
	const before = hub.received.length;
	await watchdogTick(h.ctx, normalizeConfig(raw), { now: Date.now() + 26 * 60_000 });
	assert.equal(hub.received.length, before + 1, "the hub hears about the timeout");
	assert.match(hub.received.at(-1).message.content[0].text, /【看门狗】/);
});

test("an unwritable ledger does not turn a delivered message into an error", async () => {
	const file = join(tempDir(), "not-a-dir");
	writeFileSync(file, "x");
	const sender = makeAgent("session-a");
	const target = makeAgent("session-b");
	const h = harness({ live: [sender, target] });
	const warnings = [];
	h.ctx.logger.warn = (message) => warnings.push(message);
	apply(h.ctx, { taskDir: file, watchdog: false });
	const value = await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "go", task_id: "login" }, exec(sender));
	assert.equal(value.sessionId, "session-b");
	assert.equal(target.received.length, 1, "the message was delivered");
	assert.match(warnings.join("\n"), /ledger write for task login failed/);
});

test("hostile task ids land in one safe file per id", () => {
	const dir = tempDir();
	recordDispatch(dir, { task: "../../etc/passwd", by: "s-a", to: "s-b", round: 1, next: ["x"] });
	recordDispatch(dir, { task: "..\\..\\windows\\system32", by: "s-a", to: "s-b", round: 1, next: ["x"] });
	recordDispatch(dir, { task: "a/b", by: "s-a", to: "s-b" });
	recordDispatch(dir, { task: "a b", by: "s-a", to: "s-b" });
	const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	assert.equal(files.length, 4);
	// Every ledger stays a single file directly inside the ledger directory, whatever the id says.
	for (const name of files) {
		assert.equal(name.includes("/") || name.includes("\\"), false);
		assert.equal(resolve(dir, name).startsWith(resolve(dir)), true);
	}
	assert.equal(stateOf(dir, "../../etc/passwd").rounds, 1);
});

test("session_archive checks first and archives only with confirm", async () => {
	const caller = makeAgent("session-hub", { title: "Hub" });
	const worker = makeAgent("session-b", { title: "Builder" });
	const h = harness({ live: [caller, worker] });
	apply(h.ctx, { taskDir: tempDir(), watchdog: false });
	const archive = h.tools.get(ARCHIVE_TOOL);

	const check = await archive.execute({ session_id: "session-b" }, exec(caller));
	assert.equal(check.archived, false);
	assert.equal(check.dryRun, true);
	assert.equal(check.ready, true);
	assert.deepEqual(h.archiveCalls, [], "a check archives nothing");
	assert.match(archive.output.render({}, check)[0].text, /Ready to retire/);

	const value = await archive.execute({ session_id: "session-b", confirm: true }, exec(caller));
	assert.equal(value.archived, true);
	assert.equal(value.dryRun, false);
	assert.deepEqual(h.archiveCalls, [{ action: "archive", id: "session-b", options: { stopActivity: true } }]);
	assert.match(archive.output.render({}, value)[0].text, /nothing was deleted/);

	const restored = await archive.execute({ session_id: "session-b", unarchive: true }, exec(caller));
	assert.equal(restored.archived, false);
	assert.deepEqual(h.archiveCalls.at(-1), { action: "unarchive", id: "session-b" });
	assert.equal(archive.presentCall({ session_id: "session-b" }).title, 'Archive session "Builder"');
	assert.equal(archive.presentCall({ session_id: "session-b", unarchive: true }).title, 'Restore session "Builder"');
});

test("a session still holding a live task cannot be retired", async () => {
	const dir = tempDir();
	const hub = makeAgent("session-hub", { title: "Hub" });
	const worker = makeAgent("session-b", { title: "Builder" });
	const h = harness({ live: [hub, worker] });
	apply(h.ctx, { taskDir: dir, watchdog: false });
	const archive = h.tools.get(ARCHIVE_TOOL);
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "go", task_id: "login", this_round: ["x"] }, exec(hub));

	const check = await archive.execute({ session_id: "session-b" }, exec(hub));
	assert.equal(check.ready, false);
	assert.match(check.blockers[0], /still in round 1/);
	assert.equal(check.tasks[0].id, "login");
	assert.match(archive.output.render({}, check)[0].text, /Not ready to retire/);
	await assert.rejects(archive.execute({ session_id: "session-b", confirm: true }, exec(hub)), /cannot be retired yet/);
	assert.deepEqual(h.archiveCalls, []);

	// A running turn is also a blocker.
	worker.status = "running";
	const busy = await archive.execute({ session_id: "session-b" }, exec(hub));
	assert.match(busy.blockers.join(" "), /still running a turn/);
	worker.status = "idle";

	// Reporting done clears it.
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-hub", message: "done", task_id: "login", status: "done" }, exec(worker));
	const after = await archive.execute({ session_id: "session-b" }, exec(hub));
	assert.equal(after.ready, true);
	assert.equal(after.tasks[0].status, "done");

	// A task waiting for a decision blocks too.
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "again", task_id: "login", this_round: ["y"] }, exec(hub));
	await h.tools.get(SEND_TOOL).execute({ session_id: "session-hub", message: "? key?", task_id: "login", status: "blocked" }, exec(worker));
	const blocked = await archive.execute({ session_id: "session-b" }, exec(hub));
	assert.match(blocked.blockers.join(" "), /waiting for your decision/);
});


test("session_archive refuses itself, subagents, unknown ids and a missing registry", async () => {
	const caller = makeAgent("session-hub");
	const child = makeAgent("session-child", { origin: "subagent" });
	const h = harness({ live: [caller, child] });
	apply(h.ctx, { watchdog: false });
	const archive = (args, who = caller) => h.tools.get(ARCHIVE_TOOL).execute(args, exec(who));
	await assert.rejects(archive({ session_id: "session-hub" }), /cannot archive itself/);
	await assert.rejects(archive({ session_id: "session-child" }), /goes away with its parent/);
	await assert.rejects(archive({ session_id: "ghost" }), /was not found/);
	assert.deepEqual(h.archiveCalls, []);

	const bare = harness({ live: [caller, makeAgent("session-target")] });
	bare.ctx.get = () => undefined;
	apply(bare.ctx, { watchdog: false });
	await assert.rejects(
		bare.tools.get(ARCHIVE_TOOL).execute({ session_id: "session-target" }, exec(caller)),
		/does not expose archiveSession/
	);
});
