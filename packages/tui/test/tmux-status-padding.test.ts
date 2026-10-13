import { describe, expect, it } from "bun:test";
import { TmuxStatusPadding } from "../src/tmux-status-padding";

describe("tmux status padding receipts", () => {
	it("publishes only transitions, waits for OSC 11, and clears only its owner", () => {
		const commands: string[][] = [];
		const transport = new TmuxStatusPadding("tmux", "%12", {}, args => {
			commands.push(args);
			return true;
		});
		transport.publish(true, undefined);
		expect(commands[0]!.at(-1)).toContain("@omp-status-at-bottom 0");
		transport.publish(true, undefined);
		expect(commands).toHaveLength(1);
		transport.publish(true, "#112233");
		expect(commands[1]!.at(-1)).toContain("@omp-status-at-bottom 1");
		expect(commands[1]!.at(-1)).toContain("@omp-status-padding-bg '#112233'");
		expect(commands[1]!.at(-1)).toContain("status-padding.py refresh #{q:session_id}");
		const ownerGuard = commands[1]![4]!;
		expect(ownerGuard).toMatch(/^#\{==:#\{@omp-status-padding-owner\},[0-9]+-[a-f0-9-]+\}$/);
		transport.publish(true, "#112233");
		expect(commands).toHaveLength(2);
		transport.publish(false, "#112233");
		expect(commands[2]!.at(-1)).toContain("@omp-status-at-bottom 0");
		transport.stop();
		expect(commands[3]![4]).toBe(ownerGuard);
		expect(commands[3]!.at(-1)).toContain("set-option -pu -t %12 @omp-status-padding-owner");
		transport.stop();
		transport.publish(true, "#445566");
		expect(commands).toHaveLength(4);
	});

	it("rejects unsafe metadata and does not retry failures on every frame", () => {
		const commands: string[][] = [];
		const run = (args: string[]): boolean => {
			commands.push(args);
			return false;
		};
		const unsafePane = new TmuxStatusPadding("tmux", "%1;run-shell bad", {}, run);
		unsafePane.publish(true, "#ffffff");
		unsafePane.stop();
		expect(commands).toHaveLength(0);
		const transport = new TmuxStatusPadding("tmux", "%1", {}, run);
		transport.publish(true, "#000000';run-shell bad");
		transport.publish(true, "#000000';run-shell bad");
		expect(commands).toHaveLength(1);
		expect(commands[0]!.at(-1)).not.toContain("run-shell bad");
		expect(commands[0]!.at(-1)).toContain("@omp-status-at-bottom 0");
		transport.stop();
		expect(commands).toHaveLength(1);
	});
});
