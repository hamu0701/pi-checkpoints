/**
 * Checkpoints Extension
 *
 * Rewinds the working tree together with /tree navigation.
 * Snapshots live in a shadow git repo under the Pi agent dir, so the
 * project's own repository is never touched and non-git folders work
 * the same. Snapshots of deleted sessions are pruned on startup.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SKIP = [
	"node_modules/",
	".venv/",
	"venv/",
	"__pycache__/",
	".pytest_cache/",
	".mypy_cache/",
	".ruff_cache/",
	".DS_Store",
];

// Only skipped when the project has no .gitignore of its own
const SKIP_NO_IGNORE = [
	"dist/",
	"build/",
	"target/",
	".next/",
	".nuxt/",
	".cache/",
	"coverage/",
	".gradle/",
	".turbo/",
];

const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");

function createStore(pi: ExtensionAPI, cwd: string, sessionId: string, sessionFile?: string) {
	const root = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const dir = join(root, "checkpoints", safe(sessionId));
	const repo = join(dir, "shadow.git");
	const map = new Map<string, string>();
	let queue: Promise<unknown> = Promise.resolve();
	let initialized: Promise<void> | undefined;

	async function run(args: string[]): Promise<string> {
		// env cannot be set through pi.exec, so the shadow repo is passed explicitly
		const r = await pi.exec(
			"git",
			[
				`--git-dir=${repo}`,
				`--work-tree=${cwd}`,
				"-c",
				"user.name=pi",
				"-c",
				"user.email=pi@local",
				...args,
			],
			{ cwd, timeout: 120_000 },
		);

		if (r.code !== 0) {
			throw new Error(`git ${args[0]}: ${(r.stderr || "").trim() || `exit ${r.code}`}`);
		}
		return r.stdout;
	}

	// Handlers can overlap; git must not run twice on the same repo at once
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const p = queue.then(fn, fn);
		queue = p.catch(() => {});
		return p;
	}

	// Snapshots of deleted sessions are dead weight
	function prune(): void {
		const parent = join(root, "checkpoints");
		if (!existsSync(parent)) return;

		for (const name of readdirSync(parent)) {
			const d = join(parent, name);
			const marker = join(d, "session");
			if (d === dir || !existsSync(marker)) continue;

			try {
				if (!existsSync(readFileSync(marker, "utf8"))) {
					rmSync(d, { recursive: true, force: true });
				}
			} catch {
				// Unreadable marker: keep it rather than guess
			}
		}
	}

	async function init(): Promise<void> {
		if (!existsSync(repo)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });

			const r = await pi.exec("git", ["init", "-q", "--bare", repo], { cwd });
			if (r.code !== 0) {
				throw new Error(`git init: ${(r.stderr || "").trim()}`);
			}

			const skip = existsSync(join(cwd, ".gitignore")) ? SKIP : [...SKIP, ...SKIP_NO_IGNORE];
			writeFileSync(join(dir, "excludes"), skip.join("\n") + "\n");
			await run(["config", "core.excludesFile", join(dir, "excludes")]);

			if (sessionFile) {
				writeFileSync(join(dir, "session"), sessionFile);
			}
		}

		prune();

		// refs/pi/<entryId> remembers which commit belongs to which entry
		const refs = await run(["for-each-ref", "--format=%(objectname) %(refname:lstrip=2)", "refs/pi"]);
		for (const line of refs.split("\n")) {
			const [sha, id] = line.trim().split(" ");
			if (sha && id) map.set(id, sha);
		}
	}

	const ready = () => (initialized ??= init());

	async function point(id: string, sha: string): Promise<void> {
		await run(["update-ref", `refs/pi/${safe(id)}`, sha]);
		map.set(id, sha);
	}

	// Commits the current state and points the given entries at it
	async function snapshot(ids: string[]): Promise<string> {
		return serial(async () => {
			await run(["add", "-A"]);
			await run(["commit", "--allow-empty", "-q", "-m", "checkpoint"]);

			const sha = (await run(["rev-parse", "HEAD"])).trim();
			for (const id of ids) await point(id, sha);
			return sha;
		});
	}

	// Same commit, another entry: the user message that started the run.
	// First pin wins, so a retried run cannot move the rewind point forward
	function pin(id: string, sha: string): Promise<void> {
		return serial(() => (map.has(id) ? Promise.resolve() : point(id, sha)));
	}

	async function restore(
		targetId: string,
		parentOf: (id: string) => string | null | undefined,
	): Promise<{ changed: number } | undefined> {
		return serial(async () => {
			// Nearest ancestor with a snapshot: the state that entry was created in
			let sha: string | undefined;
			let id: string | null | undefined = targetId;
			const seen = new Set<string>();

			while (id && !seen.has(id)) {
				sha = map.get(id);
				if (sha) break;
				seen.add(id);
				id = parentOf(id);
			}

			if (!sha) return undefined;

			const names = async (args: string[]) =>
				new Set((await run(args)).split("\0").filter((p) => p !== ""));
			// Against the worktree, not HEAD: uncommitted edits must rewind too
			const changed = [
				...(await names(["diff", "--name-only", "-z", "--no-renames", sha])),
			];
			const target = await names(["ls-tree", "-r", "-z", "--name-only", sha]);

			// Embedded repos are links and empty dirs are untracked: skip, don't fail.
			// lstat, not stat: a symlink is a file to restore, even when it points at a dir
			const isDir = (p: string) => {
				try {
					return lstatSync(join(cwd, p)).isDirectory();
				} catch {
					return false;
				}
			};

			await run(["read-tree", sha]);

			const writes = changed.filter((p) => target.has(p) && !isDir(p));
			for (let i = 0; i < writes.length; i += 200) {
				await run(["checkout-index", "-f", "--", ...writes.slice(i, i + 200)]);
			}

			let removed = 0;
			for (const p of changed) {
				const abs = join(cwd, p);
				if (target.has(p) || !abs.startsWith(cwd + sep) || isDir(p)) continue;

				rmSync(abs, { force: true });
				removed++;
			}

			// HEAD must describe the worktree again, or the next diff would be wrong
			await run(["commit", "--allow-empty", "-q", "-m", "checkpoint"]);
			await point(targetId, (await run(["rev-parse", "HEAD"])).trim());
			return { changed: writes.length + removed };
		});
	}

	return { sessionId, ready, snapshot, restore, pin };
}

function nearestUser(ctx: ExtensionContext, entryId: string): string | undefined {
	const byId = new Map(ctx.sessionManager.getEntries().map((e) => [e.id, e]));

	for (let id: string | null | undefined = entryId; id; id = byId.get(id)?.parentId) {
		const entry = byId.get(id);
		if (entry?.type === "message" && entry.message.role === "user") {
			return entry.id;
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let store: ReturnType<typeof createStore> | undefined;
	let pending: string | undefined;
	let warned = false;

	function warn(ctx: ExtensionContext, stage: string, err: unknown): void {
		if (warned) return;
		warned = true;

		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`checkpoints: ${stage} failed, files may be out of sync (${msg})`, "warning");
	}

	async function get(ctx: ExtensionContext): Promise<ReturnType<typeof createStore> | undefined> {
		const sessionId = ctx.sessionManager.getSessionId();
		if (store?.sessionId === sessionId) return store;

		const w = createStore(pi, ctx.cwd, sessionId, ctx.sessionManager.getSessionFile() ?? undefined);
		try {
			await w.ready();
		} catch (err) {
			warn(ctx, "setup", err);
			return undefined;
		}

		store = w;
		pending = undefined; // the old repo's sha means nothing here
		return w;
	}

	async function snap(ctx: ExtensionContext, ids: (string | null | undefined)[]): Promise<void> {
		const w = await get(ctx);
		if (!w) return;

		try {
			await w.snapshot(ids.filter((id): id is string => !!id));
		} catch (err) {
			warn(ctx, "snapshot", err);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		pending = undefined;
		await snap(ctx, [ctx.sessionManager.getLeafId()]);
	});

	// The user entry is appended after turn_start, so the pre-run state is kept
	// aside and hung on that entry once the turn ends
	pi.on("turn_start", async (_event, ctx) => {
		const w = await get(ctx);
		if (!w || pending) return;

		try {
			pending = await w.snapshot([]);
		} catch (err) {
			warn(ctx, "snapshot", err);
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const w = await get(ctx);
		if (!w) return;

		try {
			await w.snapshot([event.messageEntryId, ...(event.toolResultEntryIds ?? [])]);

			const userId = nearestUser(ctx, event.messageEntryId);
			if (pending && userId) await w.pin(userId, pending);
		} catch (err) {
			warn(ctx, "snapshot", err);
		}
	});

	pi.on("agent_end", () => {
		pending = undefined;
	});

	pi.on("session_before_tree", async (event, ctx) => {
		const ui = ctx.ui; // ctx itself goes stale after a reload; ui stays usable
		const w = await get(ctx);
		if (!w) {
			ui.notify("checkpoints: unavailable, files not restored", "warning");
			return;
		}

		const { oldLeafId, targetId } = event.preparation;

		// Save where we leave from, so navigating back forward restores it. Committing
		// the worktree also makes untracked files visible to the diff below; the target
		// entry is not pointed at here, or it would lose the commit we are restoring
		try {
			await w.snapshot(oldLeafId && oldLeafId !== targetId ? [oldLeafId] : []);
		} catch (err) {
			warn(ctx, "snapshot", err);
			return; // never rewind if the current state could not be saved first
		}

		try {
			const parents = new Map(ctx.sessionManager.getEntries().map((e) => [e.id, e.parentId]));
			const result = await w.restore(targetId, (id) => parents.get(id));
			const note = result
				? `checkpoints: ${result.changed} file(s) restored`
				: "checkpoints: no snapshot, files unchanged";

			// Pi writes "Navigated to selected point" to the same line right after us
			setTimeout(() => ui.notify(note, "info"), 0);
		} catch (err) {
			warn(ctx, "restore", err);
		}
	});
}
