import { expect, it } from "bun:test";
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
	for (const env of [{ STY: "session" }, { ZELLIJ: "1" }, { TERM: "screen-256color" }]) {
		const emitted: string[] = [];
		expect(resolveOmpWatermark(bytes => emitted.push(bytes), env)).toBeUndefined();
		expect(emitted).toEqual([]);
	}
});
