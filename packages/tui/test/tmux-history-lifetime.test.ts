import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { promisify } from "node:util";
import * as environment from "@oh-my-pi/pi-utils/env";
import { TmuxHistoryBridge, type TmuxHistoryHost, type TmuxHistorySnapshot } from "../src/tmux-history";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = performance.now() + 3000;
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
		`set -pF -t ${pane} @omp-history-generation '#{e|+:#{@omp-history-generation},1}'`,
	);
	await until(async () => Number(await tmux("display", "-p", "-t", pane, "#{history_size}")) > 30);
	const [columns, rows] = (await tmux("display", "-p", "-t", pane, "#{pane_width},#{pane_height}"))
		.split(",")
		.map(Number) as [number, number];
	const owner = {};
	let released = 0;
	const snapshot = (): TmuxHistorySnapshot => ({
		owners: Array.from({ length: 200 }, () => owner),
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
});
