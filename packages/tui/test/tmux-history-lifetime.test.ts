import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as environment from "@oh-my-pi/pi-utils/env";
import { TmuxHistoryBridge, type TmuxHistoryHost, type TmuxHistorySnapshot } from "../src/tmux-history";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function until(check: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
	const deadline = performance.now() + timeout;
	while (!(await check())) {
		if (performance.now() >= deadline) throw new Error("Bridge state did not settle");
		await nextTurn();
	}
}

async function rig() {
	const directory = await mkdtemp(join(tmpdir(), "tui-history-test-"));
	const server = join(directory, "tmux");
	const tmux = async (...args: string[]) => {
		const result = await execute("tmux", ["-S", server, "-f", "/dev/null", ...args], {
			timeout: 2000,
			env: { ...process.env, TERM: "xterm-256color" },
		});
		return result.stdout.trim();
	};
	let bridge: TmuxHistoryBridge | undefined;
	const clients = new Set<Socket>();
	cleanups.push(async () => {
		bridge?.stop();
		for (const client of clients) client.destroy();
		await tmux("kill-server").catch(() => {});
		await rm(directory, { recursive: true, force: true });
	});
	await tmux("new-session", "-d", "-s", "probe", "-x", "80", "-y", "24", "seq 1 100; sleep 120");
	const pane = await tmux("display", "-p", "#{pane_id}");
	await tmux("set", "-p", "-t", pane, "@omp-history-generation", "0");
	await tmux(
		"set-hook",
		"-p",
		"-t",
		pane,
		"pane-mode-changed",
		`set -pF -t ${pane} @omp-history-generation '#{e|+:#{@omp-history-generation},1}' ; ` +
			`if -F -t ${pane} '#{pane_in_mode}' 'set -pF -t ${pane} @omp-history-size "#{history_size}"' ` +
			`'set -pu -t ${pane} @omp-history-size ; set -pu -t ${pane} @omp-history-snapshot'`,
	);
	await until(async () => Number(await tmux("display", "-p", "-t", pane, "#{history_size}")) > 30);
	const [columns, rows] = (await tmux("display", "-p", "-t", pane, "#{pane_width},#{pane_height}"))
		.split(",")
		.map(Number) as [number, number];
	const owner = {};
	let released = 0;
	const snapshot = (): TmuxHistorySnapshot => ({
		owners: Array.from({ length: 200 }, () => owner),
		anchors: Array.from({ length: 200 }, () => owner),
		historyOffset: 0,
		epoch: 0,
		screenTop: 100,
		columns,
		rows,
		release: () => {
			released++;
		},
		valid: () => true,
	});
	const captures: { owner?: object; signal?: AbortSignal }[] = [];
	let capture: TmuxHistoryHost["capture"] = async () => snapshot();
	spyOn(environment, "isBunTestRuntime").mockReturnValue(false);
	const oldTmux = process.env.TMUX;
	const oldPane = process.env.TMUX_PANE;
	try {
		process.env.TMUX = `${server},1,0`;
		process.env.TMUX_PANE = pane;
		bridge = await TmuxHistoryBridge.create({
			capture: (value, signal) => {
				captures.push({ owner: value, signal });
				return capture(value, signal);
			},
			setHistoryLimit: () => {},
		});
	} finally {
		if (oldTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = oldTmux;
		if (oldPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = oldPane;
	}
	if (!bridge) throw new Error("Bridge did not start");
	const socketPath = await tmux("show", "-pv", "-t", pane, "@omp-history-socket");
	const state = async () => {
		const values = (
			await tmux(
				"display",
				"-p",
				"-t",
				pane,
				"#{pane_in_mode}\t#{@omp-history-generation}\t#{@omp-history-snapshot}\t#{scroll_position}",
			)
		).split("\t");
		return {
			mode: values[0] === "1",
			generation: Number(values[1]),
			token: values[2] ?? "",
			scroll: Number(values[3] || 0),
		};
	};
	const request = (payload: object) => {
		const socket = createConnection(socketPath);
		clients.add(socket);
		const response = new Promise<string>((resolve, reject) => {
			let data = "";
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				data += chunk;
			});
			socket.on("error", reject);
			socket.on("close", () => {
				clients.delete(socket);
				resolve(data);
			});
		});
		socket.on("connect", () => socket.write(`${JSON.stringify({ pane, ...payload })}\n`));
		return { socket, response };
	};
	return {
		bridge,
		directory,
		socketPath,
		captures,
		snapshot,
		state,
		request,
		tmux,
		pane,
		owner,
		get released() {
			return released;
		},
		setCapture(value: TmuxHistoryHost["capture"]) {
			capture = value;
		},
		async enter() {
			const current = await state();
			expect(await request({ op: "wheel", generation: current.generation }).response).toContain('"ok":true');
			expect((await state()).mode).toBe(true);
		},
		async click() {
			const current = await state();
			return request({
				op: "click",
				generation: current.generation,
				token: current.token,
				x: 1,
				y: 1,
				scroll: current.scroll,
				columns,
				rows,
			});
		},
	};
}

// Real, private tmux servers exercise the atomic guards without replacing process
// execution globally or changing the developer's tmux configuration/server.
describe.skipIf(!Bun.which("tmux"))("tmux history request lifetime", () => {
	it("releases successful captures without cancelling native copy mode", async () => {
		const r = await rig();
		await r.enter();
		const original = await r.state();
		expect(await (await r.click()).response).toContain('"ok":true');
		const current = await r.state();
		expect(current.mode).toBe(true);
		expect(current.generation).toBe(original.generation);
		expect(current.token).not.toBe(original.token);
		expect(r.captures[1]?.owner).toBe(r.owner);
		expect(r.released).toBe(2);
	});

	it("keeps the clicked anchor in native history across real expanded and collapsed replays", async () => {
		const r = await rig();
		const tty = await r.tmux("display", "-p", "-t", r.pane, "#{pane_tty}");
		const anchor = 20;
		const mouseY = 1;
		let expanded = false;
		let revision = 0;
		const replay = async (): Promise<TmuxHistorySnapshot> => {
			const toolRows = expanded ? 284 : 4;
			const suffix = `REPLAY_${++revision}`;
			const lines = [
				...Array.from({ length: anchor }, (_, index) => `PREFIX_${index}`),
				"TOOL_ANCHOR",
				...Array.from({ length: toolRows - 1 }, (_, index) => `TOOL_BODY_${index}`),
				...Array.from({ length: 76 }, (_, index) => `${suffix}_SUFFIX_${index}`),
			];
			// Write through this private pane's real PTY, including the destructive
			// reset used by Composer. Merely changing snapshot metadata misses the
			// native refresh/reanchor behavior that failed in the full application.
			await writeFile(tty, `\x1b[2J\x1b[3J\x1b[H${lines.join("\r\n")}`);
			await until(async () => (await r.tmux("capture-pane", "-p", "-t", r.pane)).includes(`${suffix}_SUFFIX_75`));
			const historySize = Number(await r.tmux("display", "-p", "-t", r.pane, "#{history_size}"));
			return {
				...r.snapshot(),
				owners: lines.map((_, index) => (index >= anchor && index < anchor + toolRows ? r.owner : undefined)),
				screenTop: historySize,
			};
		};
		let snapshot = await replay();
		let mutation: Promise<TmuxHistorySnapshot> | undefined;
		r.setCapture(async owner => {
			if (owner !== undefined) {
				expect(owner).toBe(r.owner);
				expanded = !expanded;
				mutation = replay();
				snapshot = await mutation;
			}
			return snapshot;
		});
		await r.enter();
		const initialScroll = snapshot.screenTop + mouseY - anchor;
		await r.tmux("send", "-t", r.pane, "-X", "history-bottom");
		await r.tmux("send", "-t", r.pane, "-X", "-N", String(initialScroll), "scroll-up");
		expect(String(initialScroll)).toHaveLength(2);
		for (const shouldExpand of [true, false]) {
			const before = await r.state();
			const response = await (await r.click()).response;
			await mutation;
			expect(response).toContain('"ok":true');
			const after = await r.state();
			const desired = snapshot.screenTop + mouseY - anchor;
			expect(expanded).toBe(shouldExpand);
			expect(after.mode).toBe(true);
			expect(after.generation).toBe(before.generation);
			expect(after.token).not.toBe(before.token);
			expect(after.scroll).toBe(desired);
			expect(snapshot.owners[snapshot.screenTop + mouseY - after.scroll]).toBe(r.owner);
			// Two-to-three digit offsets exposed lexicographic tmux comparisons:
			// "58" > "338" selected a negative scroll-down repeat count.
			expect(String(desired)).toHaveLength(shouldExpand ? 3 : 2);
		}
	});

	for (const failure of [
		"undefined",
		"throw",
		"invalid",
		"missing-owner",
		"resize",
		"scroll",
		"after-refresh",
	] as const) {
		it(`cancels the original frozen grid after capture ${failure}`, async () => {
			const r = await rig();
			await r.enter();
			r.setCapture(async () => {
				if (failure === "undefined") return undefined;
				if (failure === "throw") throw new Error("Replay failed after toggle");
				if (failure === "invalid") return { ...r.snapshot(), valid: () => false };
				if (failure === "missing-owner") return { ...r.snapshot(), owners: [] };
				if (failure === "resize") return { ...r.snapshot(), columns: 90 };
				if (failure === "after-refresh") {
					let checks = 0;
					return { ...r.snapshot(), valid: () => ++checks < 3 };
				}
				await r.tmux("send", "-t", r.pane, "-X", "scroll-up");
				return r.snapshot();
			});
			await (
				await r.click()
			).response;
			expect((await r.state()).mode).toBe(false);
		});
	}

	it("does not cancel a user's newly entered mode after a failed toggle", async () => {
		const r = await rig();
		await r.enter();
		const original = await r.state();
		r.setCapture(async () => {
			await r.tmux("send", "-t", r.pane, "-X", "cancel");
			await r.tmux("copy-mode", "-t", r.pane);
			await r.tmux("set", "-p", "-t", r.pane, "@omp-history-snapshot", "user-mode");
			return undefined;
		});
		await (
			await r.click()
		).response;
		const current = await r.state();
		expect(current.mode).toBe(true);
		expect(current.generation).toBeGreaterThan(original.generation);
		expect(current.token).toBe("user-mode");
	});

	for (const close of ["destroy", "end", "stop"] as const) {
		it(`aborts capture and cancels a failed toggle on ${close}`, async () => {
			const r = await rig();
			await r.enter();
			let signal: AbortSignal | undefined;
			r.setCapture(async (_owner, value) => {
				signal = value;
				await new Promise<void>(resolve => value!.addEventListener("abort", () => resolve(), { once: true }));
				return undefined;
			});
			const click = await r.click();
			await until(() => signal !== undefined);
			if (close === "stop") r.bridge.stop();
			else click.socket[close]();
			await click.response;
			expect(signal!.aborted).toBe(true);
			await until(async () => !(await r.state()).mode);
		});
	}

	it("skips disconnected queued work and never enters history after a cancelled capture", async () => {
		const r = await rig();
		let finish!: () => void;
		r.setCapture(async () => {
			await new Promise<void>(resolve => {
				finish = resolve;
			});
			return r.snapshot();
		});
		const first = r.request({ op: "wheel", generation: 0 });
		await until(() => r.captures.length === 1);
		const queued = r.request({ op: "wheel", generation: 0 });
		await new Promise<void>(resolve => queued.socket.once("connect", resolve));
		queued.socket.end();
		await queued.response;
		first.socket.end();
		await first.response;
		await until(() => r.captures[0]!.signal!.aborted);
		finish();
		await until(() => r.released === 1);
		await r.request({ op: "click", generation: 999 }).response;
		expect(r.captures).toHaveLength(1);
		expect((await r.state()).mode).toBe(false);
	});

	it("aborts a request before the helper's five-second timeout", async () => {
		// This integration checks the real socket deadline against the Python
		// helper's wall-clock limit; fake timers cannot drive tmux/socket I/O.
		const r = await rig();
		let signal: AbortSignal | undefined;
		r.setCapture(async (_owner, value) => {
			signal = value;
			await new Promise<void>(resolve => value!.addEventListener("abort", () => resolve(), { once: true }));
			return r.snapshot();
		});
		const started = performance.now();
		await r.request({ op: "wheel", generation: 0 }).response;
		expect(signal?.aborted).toBe(true);
		expect(performance.now() - started).toBeLessThan(5000);
		await until(() => r.released === 1);
		expect((await r.state()).mode).toBe(false);
	}, 10000);

	it("adopts a native drag snapshot after the prepare socket closes", async () => {
		const r = await rig();
		expect(await r.request({ op: "drag-prepare", generation: 0 }).response).toContain('"ok":true');
		const prepared = await r.state();
		expect(prepared.token).not.toBe("");
		expect(r.released).toBe(0);
		expect(r.captures[0]?.signal?.aborted).toBe(false);
		await r.tmux("set", "-p", "-t", r.pane, "@scrollback", "1");
		await r.tmux("copy-mode", "-t", r.pane);
		const entered = await r.state();
		expect(
			await r.request({ op: "drag-commit", generation: entered.generation, token: prepared.token }).response,
		).toContain('"ok":true');
		expect(r.released).toBe(1);
		expect(await (await r.click()).response).toContain('"ok":true');
		expect(r.captures[1]?.owner).toBe(r.owner);
	});

	it("adopts a blocking drag commit before the queued mode-entry hook runs", async () => {
		const r = await rig();
		await r.request({ op: "drag-prepare", generation: 0 }).response;
		const helper = join(r.directory, "commit.js");
		await writeFile(
			helper,
			`
			const { createConnection } = require("node:net");
			const [path, pane, generation, token] = process.argv.slice(2);
			const socket = createConnection(path);
			socket.on("connect", () => socket.write(JSON.stringify({
				op: "drag-commit", pane, generation: Number(generation), token
			}) + "\\n"));
			socket.on("data", () => socket.end());
			socket.on("error", () => process.exit(1));
		`,
		);
		await r.tmux("set", "-p", "-t", r.pane, "@scrollback", "1");
		// The real root binding commits on this same command queue: tmux delays
		// pane-mode-changed until the blocking run-shell has returned.
		await r.tmux(
			"copy-mode",
			"-t",
			r.pane,
			";",
			"run-shell",
			`${JSON.stringify(process.execPath)} ${JSON.stringify(helper)} ` +
				`${JSON.stringify(r.socketPath)} ${JSON.stringify(r.pane)} ` +
				`'#{@omp-history-generation}' '#{@omp-history-snapshot}'`,
		);
		expect((await r.state()).generation).toBe(1);
		expect(r.released).toBe(1);
		expect(await (await r.click()).response).toContain('"ok":true');
		expect(r.captures[1]?.owner).toBe(r.owner);
	});

	it("expires an uncommitted drag without cancelling its native selection", async () => {
		const r = await rig();
		await r.request({ op: "drag-prepare", generation: 0 }).response;
		await r.tmux("copy-mode", "-t", r.pane);
		await r.tmux("send", "-t", r.pane, "-X", "begin-selection");
		await until(() => r.released === 1, 5000);
		expect((await r.state()).mode).toBe(true);
		expect(await r.tmux("display", "-p", "-t", r.pane, "#{selection_present}")).toBe("1");
	}, 6000);

	it("coalesces live output and keeps the same top row instead of following bottom", async () => {
		const r = await rig();
		await r.enter();
		const before = await r.state();
		r.setCapture(async () => ({ ...r.snapshot(), screenTop: 108 }));
		for (let i = 0; i < 20; i++) r.bridge.notifyOutput();
		await until(async () => (await r.state()).token !== before.token);
		expect((await r.state()).scroll).toBe(before.scroll + 8);
		expect(r.captures).toHaveLength(2);
		expect(r.captures[1]?.owner).toBeUndefined();
		expect(r.released).toBe(2);
	});

	it("makes appended PTY output available in the same native copy mode", async () => {
		const r = await rig();
		const tty = await r.tmux("display", "-p", "-t", r.pane, "#{pane_tty}");
		r.setCapture(async () => {
			const screenTop = Number(await r.tmux("display", "-p", "-t", r.pane, "#{history_size}"));
			return { ...r.snapshot(), screenTop };
		});
		await r.enter();
		const before = await r.state();
		await writeFile(tty, "\r\nLIVE_COPY_OUTPUT_NEW_LINE\r\n");
		await until(async () => (await r.tmux("capture-pane", "-p", "-t", r.pane)).includes("LIVE_COPY_OUTPUT_NEW_LINE"));
		r.bridge.notifyOutput();
		await until(async () => (await r.state()).token !== before.token);
		const after = await r.state();
		expect(after.generation).toBe(before.generation);
		expect(after.scroll).toBeGreaterThan(before.scroll);
		for (const action of ["history-top", "begin-selection", "history-bottom"]) {
			await r.tmux("send", "-t", r.pane, "-X", action);
		}
		expect(await r.tmux("display", "-p", "-t", r.pane, "#{selection_present}")).toBe("1");
		await r.tmux("send", "-t", r.pane, "-X", "copy-selection");
		// copy-selection's optional argument is a generated-name prefix, not -b.
		// This isolated server's newest native buffer is the selection just copied.
		expect(await r.tmux("show-buffer")).toContain("LIVE_COPY_OUTPUT_NEW_LINE");
	});

	it("reserves a pressed click token until the click helper completes", async () => {
		const r = await rig();
		await r.enter();
		const before = await r.state();
		await r.tmux("set", "-p", "-t", r.pane, "@omp-history-press", "pending-click");
		r.bridge.notifyOutput();
		// Real timer tick verifies the cross-process press guard, not a mock state.
		await delay(350);
		expect((await r.state()).token).toBe(before.token);
		expect(await (await r.click()).response).toContain('"ok":true');
		expect(r.captures[1]?.owner).toBe(r.owner);
		await r.tmux("set", "-pu", "-t", r.pane, "@omp-history-press");
	});

	it("clears residual selection on output without moving the visible anchor", async () => {
		const r = await rig();
		await r.enter();
		await r.tmux("send", "-t", r.pane, "-X", "begin-selection");
		await r.tmux("send", "-t", r.pane, "-X", "cursor-right");
		const before = await r.state();
		expect(await r.tmux("display", "-p", "-t", r.pane, "#{selection_present}")).toBe("1");
		r.bridge.notifyOutput();
		await until(async () => (await r.state()).token !== before.token);
		expect(await r.tmux("display", "-p", "-t", r.pane, "#{selection_present}")).toBe("0");
		expect((await r.state()).scroll).toBe(before.scroll);
		expect(r.captures).toHaveLength(2);
	});

	it("refreshes even when a residual selection starts during an output fence", async () => {
		const r = await rig();
		await r.enter();
		const before = await r.state();
		r.setCapture(async () => {
			await r.tmux("send", "-t", r.pane, "-X", "begin-selection");
			return r.snapshot();
		});
		r.bridge.notifyOutput();
		await until(() => r.released === 2);
		expect((await r.state()).token).not.toBe(before.token);
		expect(await r.tmux("display", "-p", "-t", r.pane, "#{selection_present}")).toBe("0");
	});

	it("retains the frozen token when output arrives in a replacement mode", async () => {
		const r = await rig();
		await r.enter();
		await r.tmux("send", "-t", r.pane, "-X", "cancel");
		await r.tmux("copy-mode", "-t", r.pane);
		await r.tmux("set", "-p", "-t", r.pane, "@omp-history-snapshot", "replacement");
		r.bridge.notifyOutput();
		await delay(600);
		expect((await r.state()).token).toBe("replacement");
		expect(r.captures).toHaveLength(1);
	});

	it("stops a pending coalesced output refresh with the bridge", async () => {
		const r = await rig();
		await r.enter();
		r.bridge.notifyOutput();
		r.bridge.stop();
		// A real tick establishes no late native mutation escapes lifecycle cleanup.
		await delay(350);
		expect(r.captures).toHaveLength(1);
	});

	it("refreshes short explicit copy mode into unused screen rows without leaving native navigation", async () => {
		const r = await rig();
		const tty = await r.tmux("display", "-p", "-t", r.pane, "#{pane_tty}");
		await writeFile(tty, "\x1b[2J\x1b[3J\x1b[HNEW_CHAT_FIRST\r\n");
		await until(async () => Number(await r.tmux("display", "-p", "-t", r.pane, "#{history_size}")) === 0);
		r.setCapture(async () => ({ ...r.snapshot(), screenTop: 0, owners: [], anchors: [] }));
		await r.tmux("copy-mode", "-t", r.pane);
		await r.tmux("send", "-t", r.pane, "-X", "scroll-up");
		await r.tmux("send", "-t", r.pane, "-X", "begin-selection");
		const before = await r.state();
		await writeFile(tty, "NEW_CHAT_SECOND\r\n");
		await until(async () => (await r.tmux("capture-pane", "-p", "-t", r.pane)).includes("NEW_CHAT_SECOND"));
		r.bridge.notifyOutput();
		await until(async () => (await r.state()).token !== before.token);
		const after = await r.state();
		expect(after.mode).toBe(true);
		expect(after.generation).toBe(before.generation);
		expect(after.scroll).toBe(0);
		expect(await r.tmux("display", "-p", "-t", r.pane, "#{@scrollback}")).not.toBe("1");
		expect(await r.tmux("display", "-p", "-t", r.pane, "#{selection_present}")).toBe("0");
		for (const action of ["history-top", "begin-selection", "history-bottom"]) {
			await r.tmux("send", "-t", r.pane, "-X", action);
		}
		expect(await r.tmux("display", "-p", "-t", r.pane, "#{selection_present}")).toBe("1");
		await r.tmux("send", "-t", r.pane, "-X", "copy-selection");
		expect(await r.tmux("show-buffer")).toContain("NEW_CHAT_SECOND");
	});

	it("refreshes an ownerless replay rather than leaving an obsolete frozen grid", async () => {
		const r = await rig();
		r.setCapture(async () => ({ ...r.snapshot(), owners: [], anchors: [] }));
		await r.enter();
		const before = await r.state();
		r.setCapture(async () => ({ ...r.snapshot(), owners: [], anchors: [], epoch: 1 }));
		r.bridge.notifyOutput();
		await until(async () => (await r.state()).token !== before.token);
		expect((await r.state()).scroll).toBe(before.scroll);
	});
});
