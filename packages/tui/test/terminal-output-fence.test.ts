import { describe, expect, it } from "bun:test";
import { TerminalOutputFence } from "../src/terminal-output-fence";
import { StdinBuffer } from "../src/stdin-buffer";

describe("terminal output fence", () => {
	it("drains a late reply before rearming without acknowledging a later paint", async () => {
		const writes: string[] = [];
		const fence = new TerminalOutputFence(data => writes.push(data), 5);
		expect(await fence.wait()).toBe(false);
		expect(await fence.wait()).toBe(false);
		expect(writes).toEqual(["\x1b[5n"]);
		expect(fence.consume("\x1b[0n")).toBe("");
		const second = fence.wait();
		expect(fence.consume("before\x1b[0nafter")).toBe("beforeafter");
		expect(await second).toBe(true);
		expect(writes).toEqual(["\x1b[5n", "\x1b[5n"]);
		expect(fence.consume("\x1b[0n")).toBe("\x1b[0n");
	});

	it("cancels pending work and does not treat pasted replies as terminal acknowledgements", async () => {
		const fence = new TerminalOutputFence(() => {}, 100);
		const controller = new AbortController();
		const pending = fence.wait(controller.signal);
		const paste = "\x1b[200~\x1b[0n\x1b[201~";
		expect(fence.consume(paste)).toBe(paste);
		controller.abort();
		expect(await pending).toBe(false);
		expect(fence.consume("\x1b[0n")).toBe("");
		const next = fence.wait();
		fence.consume("\x1b[0n");
		expect(await next).toBe(true);
	});

	it("accepts CSI replies split across stdin reads through the production framing layer", async () => {
		const fence = new TerminalOutputFence(() => {}, 100);
		const buffer = new StdinBuffer();
		const delivered: string[] = [];
		buffer.on("data", data => delivered.push(fence.consume(data)));
		try {
			const pending = fence.wait();
			buffer.process("\x1b[");
			buffer.process("0");
			buffer.process("n");
			expect(await pending).toBe(true);
			expect(delivered).toEqual([""]);
		} finally {
			buffer.destroy();
		}
	});
});
