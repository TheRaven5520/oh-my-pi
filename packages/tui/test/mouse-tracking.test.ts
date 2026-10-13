import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

const TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;
	#onResize: (() => void) | undefined;
	output = "";

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}

	stop(): void {
		this.#onInput = undefined;
		this.#onResize = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	sendInput(data: string): void {
		this.#onInput?.(data);
	}

	emitResize(): void {
		this.#onResize?.();
	}
	write(data: string): void {
		this.output += data;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
}

class StaticOverlay implements Component {
	render(_width: number): readonly string[] {
		return ["overlay"];
	}
}

function makeInlineTui(enabled: { current: boolean }): { terminal: MinimalTerminal; tui: TUI } {
	const terminal = new MinimalTerminal();
	const tui = new TUI(terminal);
	tui.setInlineMouseTrackingProvider(() => enabled.current);
	return { terminal, tui };
}

describe("inline mouse tracking", () => {
	it("changes the input generation only when capture actually transitions", () => {
		const enabled = { current: true };
		const { tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			const captured = tui.getMouseInputGeneration();
			tui.renderNow();
			expect(tui.getMouseInputGeneration()).toBe(captured);
			enabled.current = false;
			tui.renderNow();
			expect(tui.getMouseInputGeneration()).toBe(captured + 1);
			tui.renderNow();
			expect(tui.getMouseInputGeneration()).toBe(captured + 1);
			enabled.current = true;
			tui.renderNow();
			expect(tui.getMouseInputGeneration()).toBe(captured + 2);
		} finally {
			tui.stop();
		}
	});

	it("records visible overlay open/close even without a paint or input between them", () => {
		const { tui } = makeInlineTui({ current: true });
		const initial = tui.getMouseInputGeneration();
		const overlay = tui.showOverlay(new StaticOverlay());
		expect(tui.getMouseInputGeneration()).toBe(initial + 1);
		overlay.hide();
		expect(tui.getMouseInputGeneration()).toBe(initial + 2);
		overlay.hide();
		expect(tui.getMouseInputGeneration()).toBe(initial + 2);
	});

	it("records overlay visibility transitions but not nested or redundant changes", () => {
		const { tui } = makeInlineTui({ current: true });
		const overlay = tui.showOverlay(new StaticOverlay());
		const visible = tui.getMouseInputGeneration();
		tui.showOverlay(new StaticOverlay());
		expect(tui.getMouseInputGeneration()).toBe(visible);
		tui.hideOverlay();
		expect(tui.getMouseInputGeneration()).toBe(visible);
		overlay.setHidden(true);
		expect(tui.getMouseInputGeneration()).toBe(visible + 1);
		overlay.setHidden(true);
		expect(tui.getMouseInputGeneration()).toBe(visible + 1);
		overlay.setHidden(false);
		expect(tui.getMouseInputGeneration()).toBe(visible + 2);
		tui.hideOverlay();
		expect(tui.getMouseInputGeneration()).toBe(visible + 3);
	});

	it("enables capture on the normal buffer and releases it on stop", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			tui.stop();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(-1);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));
		} finally {
			tui.stop();
		}
	});

	it("yields to any visible overlay and restores after it closes", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			const overlay = tui.showOverlay(new StaticOverlay(), {});
			tui.renderNow();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(-1);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));

			overlay.hide();
			tui.renderNow();
			expect(terminal.output.lastIndexOf(TRACKING_ON)).toBeGreaterThan(offAt);
		} finally {
			tui.stop();
		}
	});

	it("restores inline capture after a mouse-disabled fullscreen overlay closes", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true, mouseTracking: false });
			tui.renderNow();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(-1);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));

			overlay.hide();
			tui.renderNow();
			expect(terminal.output.lastIndexOf(TRACKING_ON)).toBeGreaterThan(offAt);
		} finally {
			tui.stop();
		}
	});

	it("releases capture on stop even with a pending alt exit", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true });
			tui.renderNow();

			// Destructive repaint + overlay close fuses the alt exit without an
			// OFF write so capture would continue; quitting first must still
			// release the terminal.
			tui.requestRender(true, { clearScrollback: true });
			overlay.hide();
			tui.renderNow();
			tui.stop();

			expect(terminal.output.includes(TRACKING_OFF)).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("leaves tracking off when stopping after a fused restore exit", () => {
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true, mouseTracking: false });
			tui.renderNow();

			// Destructive repaint + overlay close fuses the alt exit including
			// the inline restore; quitting first must still leave the final
			// OFF after any re-enable or the shell keeps reporting.
			tui.requestRender(true, { clearScrollback: true });
			overlay.hide();
			tui.renderNow();
			tui.stop();

			expect(terminal.output.includes(TRACKING_OFF)).toBe(true);
			expect(terminal.output.lastIndexOf(TRACKING_OFF)).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));
		} finally {
			tui.stop();
		}
	});

	it("stays off by default", () => {
		const enabled = { current: false };
		const { terminal, tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(false);
		} finally {
			tui.stop();
		}
	});
});

describe("mutable viewport geometry", () => {
	it("exposes the painted window and hides it behind the alt screen", () => {
		const enabled = { current: true };
		const { tui } = makeInlineTui(enabled);
		try {
			tui.start();
			tui.addChild({ render: () => ["line"] });
			tui.renderNow();
			expect(tui.getMutableViewport().length).toBe(1);

			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true });
			tui.renderNow();
			expect(tui.getMutableViewport()).toEqual({ top: 0, length: 0 });
			overlay.hide();
		} finally {
			tui.stop();
		}
	});
});

describe("confirmed native tool click adapter", () => {
	it("replaces only inline capture, links history and mutable tools, and acknowledges after replay", () => {
		const keys = [
			"TMUX",
			"STY",
			"ZELLIJ",
			"HERDR_ENV",
			"HERDR_PANE_ID",
			"HERDR_TAB_ID",
			"HERDR_WORKSPACE_ID",
			"CMUX_WORKSPACE_ID",
			"CMUX_SURFACE_ID",
			"CMUX_REMOTE_TRANSPORT",
			"WMUX",
			"WMUX_SURFACE_ID",
			"TERM",
		];
		const environment = keys.map(key => [key, process.env[key]] as const);
		for (const key of keys) delete process.env[key];
		process.env.TERM = "xterm-kitty";
		const enabled = { current: true };
		const { terminal, tui } = makeInlineTui(enabled);
		const historyOwner = {};
		const mutableOwner = {};
		let retained = true;
		let pending = true;
		let replay = false;
		let batch = 1;
		let toggles = 0;
		const input: string[] = [];
		tui.setFocus({ render: () => [], handleInput: data => input.push(data) });
		tui.setFrameProvider({
			renderFrame: () => ({
				history: pending
					? {
							id: batch,
							rows: ["history tool"],
							owners: [historyOwner],
							kind: replay ? "replay" : "append",
						}
					: undefined,
				viewport: ["mutable tool", "editor"],
			}),
			acknowledgeHistory: () => {
				pending = false;
			},
			beginHistoryReplay: () => {
				pending = true;
				replay = true;
				batch++;
			},
			viewportHistoryOwner: index => (index === 0 ? mutableOwner : undefined),
			isHistoryTool: owner => owner === historyOwner || owner === mutableOwner,
			toggleHistoryOwner: owner => {
				if (!retained || (owner !== historyOwner && owner !== mutableOwner)) return false;
				toggles++;
				tui.resetDisplay();
				return true;
			},
		});
		try {
			expect(terminal.output).not.toContain("SetUserVar=omp_tool_instance");
			tui.start();
			tui.renderNow();
			expect(terminal.output).toContain(TRACKING_ON);
			expect(terminal.output).not.toContain("omp-tool://");
			expect(terminal.output).not.toContain("\x1b]22;>default\x1b\\");
			const encoded = terminal.output.match(/SetUserVar=omp_tool_instance=([^\x07]+)/)![1]!;
			const nonce = Buffer.from(encoded, "base64").toString();
			const wrong = `${nonce[0] === "9" ? "8" : "9"}${nonce.slice(1)}`;
			const offBefore = terminal.output.lastIndexOf(TRACKING_OFF);
			terminal.sendInput(`\x1b[>997;1;${wrong}u`);
			tui.renderNow();
			expect(terminal.output.lastIndexOf(TRACKING_OFF)).toBe(offBefore);
			terminal.sendInput(`\x1b[>997;1;${nonce}u`);
			expect(terminal.output.lastIndexOf(TRACKING_OFF)).toBeGreaterThan(offBefore);
			expect(terminal.output.match(/\x1b\]22;>default\x1b\\/g)).toHaveLength(1);
			const ids = [...terminal.output.matchAll(new RegExp(`omp-tool://${nonce}/([0-9]+)`, "g"))].map(
				match => match[1]!,
			);
			expect(new Set(ids).size).toBe(2);
			const id = ids[0]!;
			terminal.output = "";
			terminal.sendInput(`\x1b[>997;2;${nonce};${id};1u`);
			expect(toggles).toBe(1);
			const ack = `SetUserVar=omp_tool_ack=${Buffer.from(`${nonce}:${id}:1`).toString("base64")}`;
			expect(terminal.output.indexOf(ack)).toBeGreaterThan(terminal.output.indexOf("mutable tool"));
			expect(terminal.output).toContain(`omp-tool://${nonce}/${id}`);
			expect(input).toEqual([]);
			expect(terminal.output).not.toContain("\x1b]22;"); // Replay retains the pointer, not pop/push.

			const overlay = tui.showOverlay(new StaticOverlay(), { fullscreen: true });
			tui.renderNow();
			expect(terminal.output).toContain(TRACKING_ON);
			terminal.sendInput(`\x1b[>997;2;${nonce};${id};2u`);
			expect(toggles).toBe(1);
			overlay.hide();
			tui.renderNow();
			expect(terminal.output.lastIndexOf(TRACKING_OFF)).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));
			expect(terminal.output).not.toContain("\x1b]22;"); // Alternate buffer has its own pointer stack.
			enabled.current = false;
			tui.renderNow();
			expect(terminal.output).toContain("\x1b]22;<\x1b\\");
			const beforeEnable = batch;
			enabled.current = true;
			tui.renderNow();
			expect(batch).toBe(beforeEnable + 1);
			tui.renderNow();
			expect(batch).toBe(beforeEnable + 1);
			retained = false;
			terminal.sendInput(`\x1b[>997;2;${nonce};${id};3u`);
			expect(toggles).toBe(1);
			expect(input).toEqual([]);
			tui.showOverlay(new StaticOverlay(), { fullscreen: true });
			tui.renderNow();
			terminal.output = "";
			tui.stop();
			expect(terminal.output).toContain("SetUserVar=omp_tool_instance=\x07");
			expect(terminal.output.lastIndexOf("\x1b]22;<\x1b\\")).toBeGreaterThan(
				terminal.output.lastIndexOf("\x1b[?1049l"),
			);
		} finally {
			tui.stop();
			for (const [key, value] of environment) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

it("does not advertise the native adapter through a terminal multiplexer", () => {
	const previous = process.env.STY;
	process.env.STY = "native-links-test";
	const { terminal, tui } = makeInlineTui({ current: true });
	tui.setFrameProvider({
		renderFrame: () => ({ viewport: ["tool"] }),
		acknowledgeHistory: () => {},
		isHistoryTool: () => true,
		toggleHistoryOwner: () => true,
	});
	try {
		tui.start();
		tui.renderNow();
		expect(terminal.output).not.toContain("SetUserVar=omp_tool_instance");
		expect(terminal.output).toContain(TRACKING_ON);
	} finally {
		tui.stop();
		if (previous === undefined) delete process.env.STY;
		else process.env.STY = previous;
	}
});
