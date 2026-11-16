// Checks checkpoints.ts three ways: handlers with a fake runtime, a real Pi
// session with real navigation, and a restore after restart.
// Run: node checkpoints.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const sdk = process.env.PI_SDK ?? "@earendil-works/pi-coding-agent";
const { createAgentSession, SessionManager } = await import(sdk);

const sh = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "checkpoints-"));
const realAgent = join(homedir(), ".pi", "agent");
const savedAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const agent = process.env.PI_CODING_AGENT_DIR;
// The real runtime needs the real agent dir (auth.json), so only unit() runs isolated.
const useRealAgent = () => {
  process.env.PI_CODING_AGENT_DIR = savedAgent ?? realAgent;
};
const repoFor = (id) => join(process.env.PI_CODING_AGENT_DIR || realAgent, "checkpoints", id, "shadow.git");
const cleanup = [];

async function unit() {
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const ext = (await import(new URL("./extensions/checkpoints.ts", import.meta.url).href)).default;

  const handlers = new Map();
  const notes = [];
  const pi = {
    on: (type, fn) => handlers.set(type, fn),
    async exec(cmd, args, opts = {}) {
      try {
        const r = await sh(cmd, args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: 64 << 20 });
        return { stdout: r.stdout, stderr: r.stderr, code: 0 };
      } catch (err) {
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(err), code: err.code ?? 1 };
      }
    },
  };
  ext(pi);

  const entries = [];
  let leafId = null;
  const ctx = {
    cwd,
    ui: { notify: (msg, level) => notes.push({ msg, level }) },
    sessionManager: {
      getSessionId: () => "unit",
      getLeafId: () => leafId,
      getEntries: () => entries,
      getSessionFile: () => join(root, "unit.jsonl"),
    },
  };
  const entry = (id, parentId) => {
    entries.push({ id, parentId, type: "message", message: { role: id[0] === "u" ? "user" : "assistant" } });
    leafId = id;
  };
  const fire = (type, event = {}) => handlers.get(type)(event, ctx);
  const read = (p) => (existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), "utf8") : null);
  const uni = "ü dir/フ ァイル.txt";
  const state = () => [read("a.txt"), read("b.txt"), read("c.txt"), read("d.txt"), read(uni)].map((v) => JSON.stringify(v)).join(" ");

  writeFileSync(join(cwd, ".gitignore"), "secret.log\n");
  writeFileSync(join(cwd, "secret.log"), "keep me\n");
  mkdirSync(join(cwd, "nested/.git"), { recursive: true });
  writeFileSync(join(cwd, "nested/.git/config"), "not mine\n");
  mkdirSync(join(cwd, "ü dir"), { recursive: true });
  writeFileSync(join(cwd, uni), "u0");
  writeFileSync(join(cwd, "a.txt"), "1\n");

  entry("sys", null);
  await fire("session_start");

  await fire("turn_start");
  writeFileSync(join(cwd, "a.txt"), "2\n");
  writeFileSync(join(cwd, "b.txt"), "b\n");
  writeFileSync(join(cwd, uni), "u1");
  entry("u1", "sys");
  entry("a1", "u1");
  await fire("turn_end", { messageEntryId: "a1", toolResultEntryIds: [] });
  await fire("agent_end");

  await fire("turn_start");
  rmSync(join(cwd, "b.txt"));
  writeFileSync(join(cwd, "c.txt"), "c\n");
  entry("u2", "a1");
  entry("a2", "u2");
  await fire("turn_end", { messageEntryId: "a2", toolResultEntryIds: [] });
  await fire("agent_end");

  // Turn 3 has two model calls; only the first saw the pre-run state.
  await fire("turn_start");
  writeFileSync(join(cwd, "a.txt"), "3\n");
  entry("u3", "a2");
  entry("m3", "u3");
  await fire("turn_end", { messageEntryId: "m3", toolResultEntryIds: ["t3"] });
  await fire("turn_start");
  writeFileSync(join(cwd, "d.txt"), "d\n");
  entry("a3", "m3");
  await fire("turn_end", { messageEntryId: "a3", toolResultEntryIds: [] });
  await fire("agent_end");

  const back = (targetId, oldLeafId) => fire("session_before_tree", { preparation: { targetId, oldLeafId } });
  await back("u1", "a3");
  assert.equal(state(), '"1\\n" null null null "u0"', `u1: ${state()}`);
  await back("a1", "u1");
  assert.equal(state(), '"2\\n" "b\\n" null null "u1"', `a1: ${state()}`);
  await back("a2", "a1");
  assert.equal(state(), '"2\\n" null "c\\n" null "u1"', `a2: ${state()}`);
  await back("u3", "a2");
  assert.equal(state(), '"2\\n" null "c\\n" null "u1"', `u3: ${state()}`);

  assert.equal(read("secret.log"), "keep me\n", "ignored file untouched");
  assert.equal(read("nested/.git/config"), "not mine\n", "nested .git untouched");
  assert.equal(existsSync(join(cwd, ".git")), false, "project must not become a git repo");

  // A rename must rewind both names, or the old copy lingers
  await fire("turn_start");
  writeFileSync(join(cwd, "ren1.txt"), "r\n");
  entry("u4", "a3");
  entry("a4", "u4");
  await fire("turn_end", { messageEntryId: "a4", toolResultEntryIds: [] });
  renameSync(join(cwd, "ren1.txt"), join(cwd, "ren2.txt"));
  await back("a4", "a4");
  assert.equal(read("ren1.txt"), "r\n", "rename: original name comes back");
  assert.equal(read("ren2.txt"), null, "rename: new name is removed");

	await back("nope", "u3");
  assert.equal(state(), '"2\\n" null "c\\n" null "u1"', "unknown target leaves files alone");
  await new Promise((r) => setTimeout(r, 10)); // toast is deferred past Pi's status line
  assert.ok(notes.some((n) => n.msg.includes("no snapshot")), "user is told when nothing was restored");
  assert.ok(existsSync(repoFor("unit")), "shadow repo lives outside the project");

  // Deleted sessions are pruned on the next start.
  const gone = join(agent, "checkpoints", "gone");
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(gone, "session"), join(root, "deleted-session.jsonl"));
  writeFileSync(join(root, "unit.jsonl"), "");
  const ctx2 = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "unit2" } };
  await handlers.get("session_start")({}, ctx2);
  assert.equal(existsSync(gone), false, "snapshot of a deleted session is removed");
  console.log("unit ok");
}

async function e2e() {
  useRealAgent();
  const cwd = join(root, "e2e");
  mkdirSync(cwd, { recursive: true });
  const read = (p) => (existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), "utf8") : null);
  writeFileSync(join(cwd, "a.txt"), "1\n");

  const { session } = await createAgentSession({
    cwd,
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
    thinkingLevel: "off",
  });
  try {
    const sm = session.sessionManager;
    cleanup.push(sm.getSessionId());
    const users = () => sm.getEntries().filter((e) => e.type === "message" && e.message?.role === "user");
    await session.prompt("Reply with exactly: ok");
    const u1 = users().at(-1).id;

    writeFileSync(join(cwd, "a.txt"), "2\n");
    writeFileSync(join(cwd, "b.txt"), "b\n");
    await session.prompt("Reply with exactly: ok");
    const u2 = users().at(-1).id;
    writeFileSync(join(cwd, "c.txt"), "c\n");
    assert.ok(existsSync(repoFor(sm.getSessionId())), "shadow repo created");

    await session.navigateTree(u1);
    assert.deepEqual([read("a.txt"), read("b.txt"), read("c.txt")], ["1\n", null, null], "rewound");
    await session.navigateTree(u2);
    assert.deepEqual([read("a.txt"), read("b.txt"), read("c.txt")], ["2\n", "b\n", null], "user message keeps the run's start");
    const a2 = sm.getEntries().filter((e) => e.message?.role === "assistant").at(-1).id;
    await session.navigateTree(a2);
    assert.equal(read("c.txt"), "c\n", "end of turn restored");
    console.log("e2e ok");
  } finally {
    session.dispose();
  }
}

async function restart() {
  useRealAgent();
  const cwd = join(root, "restart");
  const sessions = join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const read = (p) => (existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), "utf8") : null);
  writeFileSync(join(cwd, "a.txt"), "1\n");

  const sm1 = SessionManager.create(cwd, sessions);
  cleanup.push(sm1.getSessionId());
  const first = await createAgentSession({ cwd, noTools: "all", thinkingLevel: "off", sessionManager: sm1 });
  await first.session.prompt("Reply with exactly: ok");
  const u1 = sm1.getEntries().filter((e) => e.message?.role === "user").at(-1).id;
  writeFileSync(join(cwd, "a.txt"), "2\n");
  await first.session.prompt("Reply with exactly: ok");
  const u2 = sm1.getEntries().filter((e) => e.message?.role === "user").at(-1).id;
  first.session.dispose();

  const second = await createAgentSession({ cwd, noTools: "all", thinkingLevel: "off", sessionManager: SessionManager.open(sm1.getSessionFile()) });
  await second.session.navigateTree(u1);
  assert.equal(read("a.txt"), "1\n", "rewound after restart");
  await second.session.navigateTree(u2);
  assert.equal(read("a.txt"), "2\n", "forward after restart");
  second.session.dispose();
  console.log("restart ok");
}

try {
  await unit();
  if (!process.env.SKIP_E2E) {
    await e2e();
    await restart();
  }
} finally {
  for (const id of cleanup) rmSync(join(process.env.PI_CODING_AGENT_DIR, "checkpoints", id), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
