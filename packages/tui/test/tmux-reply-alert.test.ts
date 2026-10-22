import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveReplyAlert } from "../src/tmux-reply-alert";

afterEach(() => vi.useRealTimers());

describe("tmux question reply alerts", () => {
	it("sets and clears only this pane in order, with process ownership for abrupt exit cleanup", () => {
		const emitted: string[] = [];
		const commands: string[][] = [];
		const alert = resolveReplyAlert(
			bytes => emitted.push(bytes),
			{ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%42" },
			args => commands.push(args),
		)!;
		alert.set();
		alert.ack();
		expect(commands).toEqual([
			["run-shell", "-t", "%42", `python3 ~/.config/tmux/reply-alert.py set #{pane_id} ${process.pid}`],
			["run-shell", "-t", "%42", "python3 ~/.config/tmux/reply-alert.py ack #{pane_id}"],
		]);
		expect(emitted).toEqual([]);
	});

	it("renews the same SSH question owner and stops renewing immediately on close", () => {
		vi.useFakeTimers();
		const emitted: string[] = [];
		const commands: string[][] = [];
		const alert = resolveReplyAlert(
			bytes => emitted.push(bytes),
			{ TERM: "tmux-256color" },
			args => commands.push(args),
		)!;
		alert.set();
		vi.advanceTimersByTime(4_000);
		alert.ack();
		vi.advanceTimersByTime(10_000);
		expect(commands).toEqual([]);
		const tokens = emitted.map((frame, index) => {
			const key = index === 3 ? "omp_reply_ack" : "omp_reply_alert";
			const match = new RegExp(`^\\x1b\\]1337;SetUserVar=${key}=([A-Za-z0-9+/=]+)\\x07$`).exec(frame);
			expect(match).not.toBeNull();
			return Buffer.from(match![1]!, "base64").toString();
		});
		expect(tokens).toHaveLength(4);
		for (const token of tokens) expect(token).toMatch(new RegExp(`^${process.pid}-[0-9a-f-]{36}$`));
		expect(new Set(tokens).size).toBe(1);
		const next = resolveReplyAlert(bytes => emitted.push(bytes), { TERM: "tmux-256color" })!;
		next.set();
		next.ack();
		expect(emitted[4]).not.toBe(emitted[0]);
	});

	it("does nothing outside tmux or for an untrusted local pane id", () => {
		for (const env of [
			{},
			{ TERM: "xterm-kitty" },
			{ STY: "1.screen" },
			{ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "invalid" },
			{ TMUX: "/tmp/tmux-1000/default,1,0", TERM: "tmux-256color" },
		]) {
			expect(resolveReplyAlert(() => {}, env, () => {})).toBeUndefined();
		}
	});

	it("does not strand question settlement when the terminal or helper throws", () => {
		const fail = () => { throw new Error("closed"); };
		for (const env of [{ TERM: "tmux-256color" }, { TMUX: "server", TMUX_PANE: "%42" }]) {
			const alert = resolveReplyAlert(fail, env, fail)!;
			expect(() => { alert.set(); alert.ack(); }).not.toThrow();
		}
	});
});
