import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { OmpWatermark, resolveOmpWatermark } from "../src/omp-watermark";

it("emits one direct uservar per transition and reuses its identity after resume", () => {
	const emitted: string[] = [];
	const watermark = new OmpWatermark(bytes => emitted.push(bytes));
	watermark.stop();
	watermark.start();
	watermark.start();
	expect(emitted).toHaveLength(1);
	const start = emitted[0]!;
	expect(start).toMatch(/^\x1b\]1337;SetUserVar=omp_watermark_instance=[A-Za-z0-9+/=]+\x07$/);
	watermark.stop();
	watermark.stop();
	expect(emitted[1]).toBe("\x1b]1337;SetUserVar=omp_watermark_instance=\x07");
	watermark.start();
	expect(emitted).toEqual([start, emitted[1]!, start]);
});

it("publishes pane ownership and atomically guards cleanup against a replacement owner", () => {
	const commands: string[][] = [];
	const emitted: string[] = [];
	const watermark = new OmpWatermark(bytes => emitted.push(bytes), {
		pane: "%42",
		run: args => {
			commands.push(args);
			return true;
		},
	});
	watermark.start();
	watermark.start();
	expect(commands).toHaveLength(1);
	const owner = commands[0]![5]!;
	expect(owner).toMatch(new RegExp(`^${process.pid}-[0-9a-f-]{36}$`));
	expect(commands[0]).toEqual([
		"set-option",
		"-p",
		"-t",
		"%42",
		"@omp-watermark-owner",
		owner,
		";",
		"run-shell",
		"-b",
		"-t",
		"%42",
		"python3 ~/.config/tmux/omp-watermark.py refresh #{q:session_id}",
	]);
	watermark.stop();
	watermark.stop();
	expect(commands[1]).toEqual([
		"if-shell",
		"-F",
		"-t",
		"%42",
		`#{==:#{@omp-watermark-owner},${owner}}`,
		"set-option -pu -t %42 @omp-watermark-owner ; run-shell -b -t %42 'python3 ~/.config/tmux/omp-watermark.py refresh #{q:session_id}'",
	]);
	expect(commands).toHaveLength(2);
	watermark.start();
	expect(commands[2]).toEqual(commands[0]);
	expect(emitted).toEqual([]);
});

it("does not clear unclaimed panes or retry failed commands without a lifecycle transition", () => {
	const commands: string[][] = [];
	const watermark = new OmpWatermark(() => {}, {
		pane: "%42",
		run: args => {
			commands.push(args);
			return false;
		},
	});
	watermark.start();
	watermark.start();
	watermark.stop();
	expect(commands).toHaveLength(1);
	watermark.start();
	expect(commands).toHaveLength(2);
});

it("does not emit direct ownership through unsupported multiplexers", () => {
	for (const env of [
		{ STY: "session" },
		{ ZELLIJ: "1" },
		{ TERM: "screen-256color" },
		{ TERM: "tmux-256color", STY: "session" },
		{ TERM: "tmux-256color", ZELLIJ: "1" },
		{ TERM: "tmux-256color", HERDR_ENV: "1" },
		{ TERM: "tmux-256color", CMUX_SURFACE_ID: "surface" },
		{ TERM: "tmux-256color", WMUX: "1" },
	]) {
		const emitted: string[] = [];
		expect(resolveOmpWatermark(bytes => emitted.push(bytes), env)).toBeUndefined();
		expect(emitted).toEqual([]);
	}
});

describe("remote watermark lease", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("emits plain ownership immediately and renews one lease until stop, then restarts cleanly", () => {
		const emitted: string[] = [];
		const watermark = resolveOmpWatermark(bytes => emitted.push(bytes), { TERM: "tmux-256color", PATH: "" })!;
		expect(watermark).toBeDefined();
		watermark.stop();
		expect(emitted).toEqual([]);
		watermark.start();
		watermark.start();
		const start = emitted[0]!;
		expect(start).toMatch(/^\x1b\]1337;SetUserVar=omp_watermark_remote=[A-Za-z0-9+/=]+\x07$/);
		const owner = Buffer.from(
			start.slice("\x1b]1337;SetUserVar=omp_watermark_remote=".length, -1),
			"base64",
		).toString();
		expect(owner).toMatch(new RegExp(`^${process.pid}-[0-9a-f-]{36}$`));
		const stop = `\x1b]1337;SetUserVar=omp_watermark_remote=${Buffer.from(`-${owner}`).toString("base64")}\x07`;
		expect(emitted).toEqual([start]);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1999);
		expect(emitted).toEqual([start]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([start, start]);
		vi.advanceTimersByTime(4000);
		expect(emitted).toEqual([start, start, start, start]);
		watermark.stop();
		watermark.stop();
		expect(emitted).toEqual([start, start, start, start, stop]);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(500);
		watermark.start();
		watermark.start();
		expect(emitted).toEqual([start, start, start, start, stop, start]);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1999);
		expect(emitted).toHaveLength(6);
		vi.advanceTimersByTime(1);
		expect(emitted.at(-1)).toBe(start);
		expect(emitted).toHaveLength(7);
		watermark.stop();
		expect(emitted.at(-1)).toBe(stop);
		vi.advanceTimersByTime(10000);
		expect(emitted).toHaveLength(8);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("renews independent remote outputs without focus input or rendering", () => {
		const first: string[] = [];
		const second: string[] = [];
		const a = resolveOmpWatermark(bytes => first.push(bytes), { TERM: "tmux-256color" })!;
		const b = resolveOmpWatermark(bytes => second.push(bytes), {
			TERM: "tmux-256color",
			TMUX_PANE: "invalid",
		})!;
		a.start();
		vi.advanceTimersByTime(1000);
		b.start();
		expect(first[0]).not.toBe(second[0]);
		vi.advanceTimersByTime(1000);
		expect(first).toEqual([first[0]!, first[0]!]);
		expect(second).toHaveLength(1);
		a.stop();
		vi.advanceTimersByTime(5000);
		expect(first).toHaveLength(3);
		expect(second).toEqual([second[0]!, second[0]!, second[0]!, second[0]!]);
		b.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not reinterpret partial local identity as a remote lease", () => {
		for (const env of [
			{ TERM: "tmux-256color", TMUX_PANE: "%42" },
			{ TERM: "tmux-256color", TMUX: "/tmp/tmux-unrelated,1,0" },
			{ TERM: "tmux-256color", TMUX: "/tmp/tmux-unrelated,1,0", TMUX_PANE: "invalid" },
		]) {
			const emitted: string[] = [];
			expect(resolveOmpWatermark(bytes => emitted.push(bytes), env)).toBeUndefined();
			expect(emitted).toEqual([]);
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaves direct and local pane lifecycles without heartbeat timers", () => {
		const emitted: string[] = [];
		const direct = new OmpWatermark(bytes => emitted.push(bytes));
		const local = new OmpWatermark(bytes => emitted.push(bytes), { pane: "%42", run: () => true });
		direct.start();
		local.start();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10000);
		expect(emitted).toHaveLength(1);
		direct.stop();
		local.stop();
		expect(emitted).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
	});
});
