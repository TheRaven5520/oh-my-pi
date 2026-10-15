import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { CentralAnswer, CentralRequestDraft } from "@oh-my-pi/pi-tui/apps/central/types";
import type { ExtensionAskDialogSubmitResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import {
	answerCentralQuestion,
	CENTRAL_MAX_FRAME_BYTES,
	type CentralHost,
	listCentralChats,
	parseCentralChat,
	startCentralHost,
} from "../src/central/bridge";

const dirs: string[] = [];
const hosts = new Set<CentralHost>();
const children = new Set<Bun.Subprocess<"ignore", "pipe", "pipe">>();
const sockets = new Set<net.Socket>();

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	for (const child of children) {
		child.kill();
		await child.exited;
	}
	children.clear();
	for (const host of hosts) await host.close();
	hosts.clear();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const ask: CentralRequestDraft = {
	kind: "ask",
	questions: [
		{
			id: "choose",
			question: "Which deployment?",
			header: "Deployment",
			options: [{ label: "Blue", description: "Current", preview: "# Blue preview" }, { label: "Green" }],
			recommended: 0,
		},
	],
};

function submitted(selectedOptions = ["Blue"]): ExtensionAskDialogSubmitResult {
	return {
		kind: "submit",
		results: [
			{ id: "choose", question: "Which deployment?", options: ["Blue", "Green"], multi: false, selectedOptions },
		],
	};
}

async function fixture(longPath = false) {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-test-"));
	dirs.push(base);
	const dir = longPath ? path.join(base, "nested-".repeat(20), "central-hosts") : path.join(base, "hosts");
	const state = { sessionId: "session-one", name: "First chat", cwd: "/workspace", busy: true };
	const host = await startCentralHost(() => state, { dir });
	hosts.add(host);
	return { dir, state, host };
}

function pendingLocal(signal: AbortSignal): Promise<CentralAnswer | undefined> {
	const { promise, resolve } = Promise.withResolvers<CentralAnswer | undefined>();
	if (signal.aborted) resolve(undefined);
	else signal.addEventListener("abort", () => resolve(undefined), { once: true });
	return promise;
}

function controlledLocal(): {
	promise: Promise<CentralAnswer | undefined>;
	resolve(value: CentralAnswer | undefined): void;
} {
	const result = Promise.withResolvers<CentralAnswer | undefined>();
	return { promise: result.promise, resolve: result.resolve };
}

describe("private Central host IPC", () => {
	it("publishes full rich questions and accepts a central answer exactly once", async () => {
		const { dir, host } = await fixture();
		let localSignal: AbortSignal | undefined;
		const result = host.race(ask, undefined, signal => {
			localSignal = signal;
			return pendingLocal(signal);
		});
		const [chat] = await listCentralChats({ dir });
		expect(chat!.requests).toHaveLength(1);
		expect(chat!.requests[0]).toMatchObject(ask);
		const answer = submitted();
		answer.results[0]!.note = "Ship the current version";
		answer.results[0]!.noteImages = [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }];
		await answerCentralQuestion(chat!.id, chat!.requests[0]!.id, answer, { dir });
		expect(await result).toEqual(answer);
		expect(localSignal!.aborted).toBe(true);
		expect((await listCentralChats({ dir }))[0]!.requests).toEqual([]);
		await expect(answerCentralQuestion(chat!.id, chat!.requests[0]!.id, answer, { dir })).rejects.toThrow(
			"stale_request",
		);
	});

	it("withdraws a local answer and never replaces it with a late remote answer", async () => {
		const { dir, host } = await fixture();
		const local = Promise.withResolvers<CentralAnswer | undefined>();
		const result = host.race(ask, undefined, () => local.promise);
		const [chat] = await listCentralChats({ dir });
		local.resolve(submitted(["Green"]));
		expect(await result).toEqual(submitted(["Green"]));
		expect((await listCentralChats({ dir }))[0]!.requests).toEqual([]);
		await expect(answerCentralQuestion(chat!.id, chat!.requests[0]!.id, submitted(), { dir })).rejects.toThrow(
			"stale_request",
		);
	});

	it("never publishes an already-aborted dialog or swallows a local failure", async () => {
		const { dir, host } = await fixture();
		let called = false;
		const result = await host.race(ask, AbortSignal.abort(), signal => {
			called = true;
			return pendingLocal(signal);
		});
		expect(result).toBeUndefined();
		expect(called).toBe(false);
		const failure = new Error("local renderer failed");
		await expect(host.race(ask, undefined, () => Promise.reject(failure))).rejects.toBe(failure);
		expect((await listCentralChats({ dir }))[0]!.requests).toEqual([]);
	});

	it("rejects wrong options, ids, multi flags, and forged answer metadata without settling", async () => {
		const { dir, host } = await fixture();
		const result = host.race(ask, undefined, pendingLocal);
		const [chat] = await listCentralChats({ dir });
		const invalid: ExtensionAskDialogSubmitResult[] = [submitted(["Magenta"]), submitted(["Blue", "Green"])];
		for (const patch of [
			{ id: "some-other-question" },
			{ question: "A forged question" },
			{ options: ["Magenta"] },
			{ multi: true },
			{ timedOut: true },
			{ customInput: "custom while selected" },
			{ extra: "forged" },
		]) {
			const answer = submitted();
			Object.assign(answer.results[0]!, patch);
			invalid.push(answer);
		}
		for (const answer of invalid) {
			await expect(answerCentralQuestion(chat!.id, chat!.requests[0]!.id, answer, { dir })).rejects.toThrow(
				"invalid_answer",
			);
		}
		expect((await listCentralChats({ dir }))[0]!.requests).toHaveLength(1);
		await answerCentralQuestion(chat!.id, chat!.requests[0]!.id, submitted(), { dir });
		expect(await result).toEqual(submitted());
	});

	it("preserves multi-select custom input and pasted images", async () => {
		const { dir, host } = await fixture();
		const multi = structuredClone(ask);
		if (multi.kind !== "ask") throw new Error("invalid fixture");
		multi.questions[0]!.multi = true;
		const result = host.race(multi, undefined, pendingLocal);
		const [chat] = await listCentralChats({ dir });
		const answer = submitted(["Blue", "Green"]);
		Object.assign(answer.results[0]!, {
			multi: true,
			customInput: "Also staging",
			customInputImages: [{ type: "image", mimeType: "image/jpeg", data: "aGVsbG8=", detail: "original" }],
		});
		await answerCentralQuestion(chat!.id, chat!.requests[0]!.id, answer, { dir });
		expect(await result).toEqual(answer);
	});

	it("keeps simultaneous continued asks independent and allows a chat answer", async () => {
		const { dir, host } = await fixture();
		const first = host.race(ask, undefined, pendingLocal);
		const second = host.race(ask, undefined, pendingLocal);
		const [chat] = await listCentralChats({ dir });
		expect(chat!.requests).toHaveLength(2);
		await answerCentralQuestion(chat!.id, chat!.requests[1]!.id, { kind: "chat" }, { dir });
		expect(await second).toEqual({ kind: "chat" });
		expect((await listCentralChats({ dir }))[0]!.requests.map(request => request.id)).toEqual([
			chat!.requests[0]!.id,
		]);
		await answerCentralQuestion(chat!.id, chat!.requests[0]!.id, submitted(), { dir });
		expect(await first).toEqual(submitted());
	});

	it("keeps a local dialog alive when transport closes and falls back locally afterward", async () => {
		const { host } = await fixture();
		const first = controlledLocal();
		const pending = host.race(ask, undefined, () => first.promise);
		await host.close();
		first.resolve(submitted(["Green"]));
		expect(await pending).toEqual(submitted(["Green"]));
		let called = false;
		const later = host.race(ask, undefined, () => {
			called = true;
			return Promise.resolve(submitted());
		});
		expect(await later).toEqual(submitted());
		expect(called).toBe(true);
	});

	it("removes an aborted request without aborting unrelated work", async () => {
		const { dir, host } = await fixture();
		const abort = new AbortController();
		const secondLocal = controlledLocal();
		const first = host.race(ask, abort.signal, pendingLocal);
		const second = host.race(ask, undefined, () => secondLocal.promise);
		const [chat] = await listCentralChats({ dir });
		abort.abort();
		expect(await first).toBeUndefined();
		expect((await listCentralChats({ dir }))[0]!.requests.map(request => request.id)).toEqual([
			chat!.requests[1]!.id,
		]);
		await expect(answerCentralQuestion(chat!.id, chat!.requests[0]!.id, submitted(), { dir })).rejects.toThrow(
			"stale_request",
		);
		await host.close();
		secondLocal.resolve(submitted());
		expect(await second).toEqual(submitted());
	});

	it("cancels old-session requests before returning the new session and rejects stale ids", async () => {
		const { dir, host, state } = await fixture();
		const oldResult = host.race(ask, undefined, pendingLocal);
		const [oldChat] = await listCentralChats({ dir });
		state.sessionId = "session-two";
		state.name = "Second chat";
		state.cwd = "/next-workspace";
		state.busy = false;
		await expect(answerCentralQuestion(oldChat!.id, oldChat!.requests[0]!.id, submitted(), { dir })).rejects.toThrow(
			"stale_request",
		);
		expect(await oldResult).toBeUndefined();
		const nextLocal = controlledLocal();
		const nextResult = host.race(ask, undefined, () => nextLocal.promise);
		const [nextChat] = await listCentralChats({ dir });
		expect(nextChat).toMatchObject(state);
		expect(nextChat!.id).toBe(oldChat!.id);
		expect(nextChat!.requests).toHaveLength(1);
		expect(nextChat!.requests[0]!.id).not.toBe(oldChat!.requests[0]!.id);
		await host.close();
		nextLocal.resolve(submitted());
		expect(await nextResult).toEqual(submitted());
	});

	it("validates selector choices and preserves empty editor strings", async () => {
		const { dir, host } = await fixture();
		const selection = host.race(
			{
				kind: "select",
				title: "Proceed?",
				options: ["Yes", { label: "No", description: "Wait" }],
				disabledIndices: [0],
			},
			undefined,
			pendingLocal,
		);
		let [chat] = await listCentralChats({ dir });
		await expect(answerCentralQuestion(chat!.id, chat!.requests[0]!.id, "Maybe", { dir })).rejects.toThrow(
			"invalid_answer",
		);
		await expect(answerCentralQuestion(chat!.id, chat!.requests[0]!.id, "Yes", { dir })).rejects.toThrow(
			"invalid_answer",
		);
		expect(chat!.requests[0]).toMatchObject({ disabledIndices: [0] });
		await answerCentralQuestion(chat!.id, chat!.requests[0]!.id, "No", { dir });
		expect(await selection).toBe("No");
		const editing = host.race({ kind: "editor", title: "Details", prefill: "draft" }, undefined, pendingLocal);
		[chat] = await listCentralChats({ dir });
		await answerCentralQuestion(chat!.id, chat!.requests[0]!.id, "", { dir });
		expect(await editing).toBe("");
	});

	it("publishes once, keeps metadata private, and removes every owned artifact on close", async () => {
		const { dir, host } = await fixture();
		const same = await startCentralHost(() => ({ sessionId: "ignored", name: "ignored", cwd: "/", busy: false }), {
			dir,
		});
		expect(same).toBe(host);
		const files = (await fs.readdir(dir)).filter(file => file.endsWith(".json"));
		expect(files).toHaveLength(1);
		const text = await fs.readFile(path.join(dir, files[0]!), "utf8");
		const meta = JSON.parse(text) as { endpoint: string; token: string };
		expect(text).not.toContain("Which deployment?");
		expect(text).not.toContain("First chat");
		if (process.platform !== "win32") {
			expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(dir, files[0]!))).mode & 0o777).toBe(0o600);
			expect((await fs.stat(meta.endpoint)).mode & 0o777).toBe(0o600);
		}
		expect(JSON.stringify(await listCentralChats({ dir }))).not.toContain(meta.token);
		const waitingLocal = controlledLocal();
		const waiting = host.race(ask, undefined, () => waitingLocal.promise);
		await host.close();
		await host.close();
		waitingLocal.resolve(submitted());
		expect(await waiting).toEqual(submitted());
		expect(await fs.readdir(dir)).toEqual([]);
		expect(await listCentralChats({ dir })).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"uses a private short socket directory for long registry paths",
		async () => {
			const { dir, host } = await fixture(true);
			const [file] = (await fs.readdir(dir)).filter(name => name.endsWith(".json"));
			const meta = JSON.parse(await fs.readFile(path.join(dir, file!), "utf8")) as { endpoint: string };
			expect(Buffer.byteLength(meta.endpoint)).toBeLessThan(104);
			expect(meta.endpoint.startsWith(dir)).toBe(false);
			expect((await fs.stat(path.dirname(meta.endpoint))).mode & 0o777).toBe(0o700);
			expect(await listCentralChats({ dir })).toHaveLength(1);
			await host.close();
			await expect(fs.stat(path.dirname(meta.endpoint))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("rejects malformed nested snapshots before they reach a remote UI", async () => {
		const { dir, host } = await fixture();
		const waitingLocal = controlledLocal();
		const waiting = host.race(ask, undefined, () => waitingLocal.promise);
		const [chat] = await listCentralChats({ dir });
		expect(parseCentralChat(chat)).toEqual(chat);
		const malformed = structuredClone(chat!);
		Object.assign(malformed.requests[0]!, { questions: [{ id: "choose", question: "q", options: [{ label: 3 }] }] });
		expect(parseCentralChat(malformed)).toBeNull();
		expect(parseCentralChat({ ...chat, requests: [{ ...chat!.requests[0], createdAt: "now" }] })).toBeNull();
		await host.close();
		waitingLocal.resolve(submitted());
		expect(await waiting).toEqual(submitted());
	});

	it("closes oversized or unauthenticated IPC frames without leaking a token", async () => {
		const { dir } = await fixture();
		const [file] = (await fs.readdir(dir)).filter(name => name.endsWith(".json"));
		const meta = JSON.parse(await fs.readFile(path.join(dir, file!), "utf8")) as { endpoint: string; token: string };
		for (const frame of [
			JSON.stringify({ v: 1, op: "snapshot", token: "wrong" }) + "\n",
			"x".repeat(CENTRAL_MAX_FRAME_BYTES + 1),
		]) {
			const socket = net.createConnection(meta.endpoint);
			sockets.add(socket);
			const done = Promise.withResolvers<void>();
			let response = "";
			socket.setEncoding("utf8");
			socket.once("connect", () => socket.end(frame));
			socket.on("data", chunk => {
				response += chunk;
			});
			socket.on("error", () => {});
			socket.once("close", () => done.resolve());
			await done.promise;
			expect(response).not.toContain(meta.token);
			expect(response).not.toContain("First chat");
		}
		expect(await listCentralChats({ dir })).toHaveLength(1);
	});

	it("does not keep a process alive and withdraws metadata on natural exit", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-exit-"));
		dirs.push(base);
		const dir = path.join(base, "hosts");
		const modulePath = path.resolve(import.meta.dir, "../src/central/bridge.ts");
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
			import { startCentralHost } from ${JSON.stringify(modulePath)};
			await startCentralHost(() => ({ sessionId: "child", name: "child", cwd: "/", busy: false }), { dir: ${JSON.stringify(dir)} });
			console.log("published");
		`,
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		children.add(child);
		expect(await child.exited).toBe(0);
		expect(await new Response(child.stdout).text()).toContain("published");
		expect(await fs.readdir(dir)).toEqual([]);
		children.delete(child);
	});

	it("surfaces malformed discovery metadata instead of reporting no active chats", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-invalid-"));
		dirs.push(dir);
		await fs.writeFile(path.join(dir, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json"), "not json", { mode: 0o600 });
		await expect(listCentralChats({ dir })).rejects.toThrow("invalid_metadata");
	});
});
