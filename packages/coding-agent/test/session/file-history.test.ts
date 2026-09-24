import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileHistory } from "@oh-my-pi/pi-coding-agent/session/file-history";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("FileHistory", () => {
	let root: string;
	let work: string;
	const owner = () => ({ getArtifactsDir: () => path.join(root, "artifacts"), getSessionId: () => "s1" });
	const file = (name: string) => path.join(work, name);
	const read = (name: string) => fs.readFileSync(file(name), "utf8");

	beforeEach(() => {
		root = path.join(os.tmpdir(), `omp-file-history-${Snowflake.next()}`);
		work = path.join(root, "work");
		fs.mkdirSync(work, { recursive: true });
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	/** Mimics a file editing tool: snapshot first, then write. */
	async function edit(history: FileHistory, name: string, content: string): Promise<void> {
		await history.recordBeforeMutation(file(name));
		fs.writeFileSync(file(name), content);
	}

	it("restores each checkpoint to the files as they were when its prompt was sent, across a resume", async () => {
		fs.writeFileSync(file("a.txt"), "v0");
		const history = new FileHistory(owner());

		await history.beginCheckpoint("A");
		await edit(history, "a.txt", "v1");
		await edit(history, "a.txt", "v1b");
		await edit(history, "new.txt", "created");
		await history.beginCheckpoint("B");
		await edit(history, "a.txt", "v2");
		await history.beginCheckpoint("C");

		expect(await history.planRestore("C")).toEqual([]);
		expect((await history.planRestore("B")).map(t => t.path)).toEqual([file("a.txt")]);

		// A fresh instance reads the persisted index, as after `--resume`.
		const resumed = new FileHistory(owner());
		expect((await resumed.restore("B")).restored).toEqual([file("a.txt")]);
		expect(read("a.txt")).toBe("v1b");

		const result = await resumed.restore("A");
		expect(result.restored.sort()).toEqual([file("a.txt"), file("new.txt")].sort());
		expect(read("a.txt")).toBe("v0");
		expect(fs.existsSync(file("new.txt"))).toBe(false);
		expect(await resumed.planRestore("A")).toEqual([]);
	});

	it("snapshots a file once per checkpoint even when parallel edits race on it", async () => {
		fs.writeFileSync(file("a.txt"), "original");
		const history = new FileHistory(owner());
		await history.beginCheckpoint("A");

		await Promise.all([edit(history, "a.txt", "first"), edit(history, "a.txt", "second")]);
		await history.restore("A");

		expect(read("a.txt")).toBe("original");
	});

	it("does not track edits made before any prompt started a run", async () => {
		fs.writeFileSync(file("a.txt"), "v0");
		const history = new FileHistory(owner());
		await edit(history, "a.txt", "v1");
		await history.beginCheckpoint("A");

		expect(await history.planRestore("A")).toEqual([]);
		expect(await history.planRestore("unknown")).toEqual([]);
	});

	it("skips symlinked paths instead of writing through them", async () => {
		fs.writeFileSync(file("target.txt"), "v0");
		fs.symlinkSync(file("target.txt"), file("link.txt"));
		const history = new FileHistory(owner());
		await history.beginCheckpoint("A");
		await edit(history, "link.txt", "v1");

		const result = await history.restore("A");

		expect(result.skipped).toEqual([file("link.txt")]);
		expect(result.restored).toEqual([]);
		expect(fs.lstatSync(file("link.txt")).isSymbolicLink()).toBe(true);
		expect(read("target.txt")).toBe("v1");
	});

	it("drops checkpoints beyond the cap together with their snapshots", async () => {
		fs.writeFileSync(file("a.txt"), "v0");
		const history = new FileHistory(owner(), { maxCheckpoints: 2 });
		for (const [id, content] of [
			["A", "v1"],
			["B", "v2"],
			["C", "v3"],
		] as const) {
			await history.beginCheckpoint(id);
			await edit(history, "a.txt", content);
		}

		expect(await history.planRestore("A")).toEqual([]);
		await history.restore("B");
		expect(read("a.txt")).toBe("v1");
		const snapshots = fs.readdirSync(path.join(root, "artifacts", "file-history")).filter(n => n !== "index.jsonl");
		expect(snapshots).toHaveLength(2);
	});

	it("keeps snapshots in memory for sessions without an artifacts directory", async () => {
		fs.writeFileSync(file("a.txt"), "v0");
		const history = new FileHistory({ getArtifactsDir: () => null, getSessionId: () => "mem" });
		await history.beginCheckpoint("A");
		await edit(history, "a.txt", "v1");

		await history.restore("A");

		expect(read("a.txt")).toBe("v0");
		expect(fs.existsSync(path.join(root, "artifacts"))).toBe(false);
	});
	it("undoes the last restore, including recreating files it deleted, until dropped", async () => {
		fs.writeFileSync(file("a.txt"), "v0");
		const history = new FileHistory(owner());
		await history.beginCheckpoint("A");
		await edit(history, "a.txt", "v1");
		await edit(history, "new.txt", "created");

		expect(history.canUndoRestore).toBe(false);
		await history.restore("A");
		expect(read("a.txt")).toBe("v0");
		expect(fs.existsSync(file("new.txt"))).toBe(false);

		expect((await history.undoRestore()).restored.sort()).toEqual([file("a.txt"), file("new.txt")].sort());
		expect(read("a.txt")).toBe("v1");
		expect(read("new.txt")).toBe("created");
		// One undo per restore.
		expect((await history.undoRestore()).restored).toEqual([]);

		await history.restore("A");
		history.dropUndo();
		expect(history.canUndoRestore).toBe(false);
		expect((await history.undoRestore()).restored).toEqual([]);
		expect(read("a.txt")).toBe("v0");
	});
});
