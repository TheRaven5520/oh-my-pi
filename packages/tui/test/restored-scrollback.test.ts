import { expect, it } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class Provider implements TerminalFrameProvider {
	plan: TerminalFramePlan = { viewport: ["initial"] };
	acknowledged: number[] = [];
	renderFrame(): TerminalFramePlan {
		return this.plan;
	}
	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
		this.plan = { viewport: this.plan.viewport };
	}
}

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
	getTransientScrollToBottomSequences(): { before: string; after: string } {
		return { before: "\x1b[?1010h", after: "\x1b[?1010l" };
	}
}

it("coalesces partial frames but immediately paints input and committed history", async () => {
	const terminal = new RecordingTerminal(40, 8);
	const scheduler = new VirtualRenderScheduler();
	const provider = new Provider();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler, outerScrollbackStreamingCoalesce: true });
	tui.setFrameProvider(provider);
	try {
		tui.start();
		await scheduler.settle(terminal);
		terminal.writes = [];
		provider.plan = { viewport: ["partial"] };
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.writes.join("")).not.toContain("partial");
		await scheduler.advance(terminal, 260);
		expect(terminal.writes.join("")).toContain("partial");

		terminal.writes = [];
		provider.plan = { viewport: ["after input"] };
		terminal.sendInput("x");
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.writes.join("")).toContain("after input");

		terminal.writes = [];
		provider.plan = { history: { id: 1, rows: ["completed row"] }, viewport: ["next partial"] };
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(provider.acknowledged).toEqual([1]);
		expect(terminal.writes.join("")).toContain("completed row");
	} finally {
		tui.stop();
	}
});

it("temporarily follows the replacement transcript tail only for the requested paint", async () => {
	const terminal = new RecordingTerminal(40, 8);
	const scheduler = new VirtualRenderScheduler();
	const provider = new Provider();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.setFrameProvider(provider);
	try {
		tui.start();
		await scheduler.settle(terminal);
		terminal.writes = [];
		provider.plan = { viewport: ["replacement"] };
		tui.requestRender(true, { followTail: true });
		await scheduler.settle(terminal);
		const followed = terminal.writes.find(write => write.includes("replacement"));
		expect(followed?.startsWith("\x1b[?1010h")).toBe(true);
		expect(followed?.endsWith("\x1b[?1010l")).toBe(true);
		terminal.writes = [];
		provider.plan = { viewport: ["ordinary"] };
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.writes.join("")).toContain("ordinary");
		expect(terminal.writes.join("")).not.toContain("\x1b[?1010h");
	} finally {
		tui.stop();
	}
});
