import { describe, expect, it } from "bun:test";
import { resolveReplyAlertAck } from "../src/tmux-reply-alert";

describe("tmux reply-alert acknowledgment", () => {
	it("runs the alert helper against this chat's own pane on its own server", () => {
		const emitted: string[] = [];
		const commands: string[][] = [];
		const acknowledge = resolveReplyAlertAck(
			bytes => emitted.push(bytes),
			{ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%42" },
			args => commands.push(args),
		)!;
		acknowledge();
		expect(commands).toEqual([
			["run-shell", "-b", "-t", "%42", "python3 ~/.config/tmux/reply-alert.py ack #{window_id}"],
		]);
		expect(emitted).toEqual([]);
	});

	it("over SSH emits a fresh pid-uuid frame for the outer pane observer instead of running tmux", () => {
		const emitted: string[] = [];
		const commands: string[][] = [];
		const acknowledge = resolveReplyAlertAck(
			bytes => emitted.push(bytes),
			{ TERM: "tmux-256color" },
			args => commands.push(args),
		)!;
		acknowledge();
		acknowledge();
		expect(commands).toEqual([]);
		expect(emitted).toHaveLength(2);
		const tokens = emitted.map(frame => {
			const match = /^\x1b\]1337;SetUserVar=omp_reply_ack=([A-Za-z0-9+/=]+)\x07$/.exec(frame);
			expect(match).not.toBeNull();
			return Buffer.from(match![1]!, "base64").toString();
		});
		// omp-watermark.py's observer accepts only this PID-UUID shape.
		for (const token of tokens) expect(token).toMatch(new RegExp(`^${process.pid}-[0-9a-f-]{36}$`));
		expect(tokens[0]).not.toBe(tokens[1]);
	});

	it("does nothing outside tmux or for a pane id it cannot trust", () => {
		for (const env of [
			{},
			{ TERM: "xterm-kitty" },
			{ STY: "1.screen" },
			{ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "invalid" },
		]) {
			expect(
				resolveReplyAlertAck(
					() => {},
					env,
					() => {},
				),
			).toBeUndefined();
		}
	});
});
