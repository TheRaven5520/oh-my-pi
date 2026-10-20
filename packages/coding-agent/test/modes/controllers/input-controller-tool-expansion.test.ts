import { beforeAll, describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgDisplayToolState } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "../../../../tui/test/terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "../../../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

describe("InputController tool display state", () => {
	it("cycles hidden, claude, verbose and persists each state without changing thinking", () => {
		const expandable = { setExpanded: vi.fn() };
		const pending = { setExpanded: vi.fn() };
		const resetDisplay = vi.fn();
		const ctx = {
			toolDisplayState: "hidden",
			toolOutputExpanded: false,
			hideThinkingBlock: true,
			settings: Settings.isolated(),
			chatContainer: { children: [expandable], setToolDisplayState: vi.fn(), resetStableEmission: vi.fn() },
			pendingMessagesContainer: { children: [pending] },
			ui: { resetDisplay, clearInlineImages: vi.fn() },
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);
		for (const state of ["claude", "verbose", "hidden"] as const) {
			controller.cycleToolDisplayState();
			expect(ctx.toolDisplayState).toBe(state);
			expect(cfgDisplayToolState.get(ctx.settings)).toBe(state);
			expect(ctx.toolOutputExpanded).toBe(state === "verbose");
			expect(expandable.setExpanded).toHaveBeenLastCalledWith(state === "verbose");
			expect(pending.setExpanded).toHaveBeenLastCalledWith(state === "verbose");
			expect(ctx.hideThinkingBlock).toBe(true);
		}
		expect(resetDisplay).toHaveBeenCalledTimes(3);
	});
});

describe("global tool expansion history refill", () => {
	withoutTerminalMultiplexer();
	beforeAll(() => initTheme());

	it.each([0, 100])("restores the viewport and native history with %i earlier rows", async earlierRows => {
		const terminal = new VirtualTerminal(100, 40, 10_000);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		let expanded = false;
		const tool = {
			setExpanded: (value: boolean) => {
				expanded = value;
			},
			isTranscriptBlockFinalized: () => false,
			render: () =>
				expanded
					? ["live header", ...Array.from({ length: 60 }, (_, row) => `live line ${row}`)]
					: ["live header", "live summary"],
		};
		const transcript = new TranscriptContainer();
		for (let row = 0; row < earlierRows; row++) transcript.addChild(new Text(`earlier unique row ${row}`, 0, 0));
		const prompt = new Text("user prompt", 0, 0);
		transcript.addChild(prompt);
		transcript.addChild(tool);
		transcript.addChild(new Text("assistant reply", 0, 0));
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		const controller = new InputController({
			toolOutputExpanded: false,
			toolDisplayState: "claude",
			settings: Settings.isolated(),
			chatContainer: transcript,
			pendingMessagesContainer: new Container(),
			ui: composer.ui,
			showStatus: () => {},
		} as unknown as InteractiveModeContext);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const initialViewport = terminal.getViewport();
			const initialBuffer = terminal.getScrollBuffer();
			const initialPosition = terminal.getBufferPosition();
			for (let cycle = 0; cycle < 2; cycle++) {
				controller.setToolDisplayState("verbose");
				await scheduler.settle(terminal);
				expect(transcript.canRemoveBlock(tool)).toBe(true);
				expect(transcript.canRemoveBlock(prompt)).toBe(false);
				controller.setToolDisplayState("claude");
				await scheduler.settle(terminal);
				expect(terminal.getViewport()).toEqual(initialViewport);
				expect(terminal.getScrollBuffer()).toEqual(initialBuffer);
				expect(terminal.getBufferPosition()).toEqual(initialPosition);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				expect(terminal.getViewport()).toEqual(initialViewport);
				expect(terminal.getScrollBuffer()).toEqual(initialBuffer);
			}
		} finally {
			composer.stop();
		}
	});
});

describe("InputController tool activity visibility", () => {
	it("persists the toggle, preserves transient children, and reveals tools collapsed", () => {
		const pendingUserMessage = { kind: "pending-user" };
		const loadingIndicator = { kind: "loading" };
		const assistant = new AssistantMessageComponent();
		const setToolResultImagesVisible = vi.spyOn(assistant, "setToolResultImagesVisible");
		const children = [pendingUserMessage, assistant, loadingIndicator];
		const clear = vi.fn();
		const addChild = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const settings = Settings.isolated();
		const clearInlineImages = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const setToolDisplayState = vi.fn();
		const ctx = {
			toolDisplayState: "verbose",
			toolOutputExpanded: true,
			settings,
			chatContainer: { children, clear, addChild, setToolDisplayState, resetStableEmission: vi.fn() },
			pendingMessagesContainer: new Container(),
			rebuildChatFromMessages,
			showStatus,
			ui: { clearInlineImages, resetDisplay },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext) as unknown as InputController & {
			toggleToolActivityVisibility(): void;
		};

		controller.toggleToolActivityVisibility();

		expect(ctx.toolDisplayState).toBe("hidden");
		expect(cfgDisplayToolState.get(settings)).toBe("hidden");
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(showStatus).toHaveBeenLastCalledWith("Tool display: hidden");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);
		expect(setToolDisplayState).toHaveBeenLastCalledWith("hidden");

		controller.toggleToolActivityVisibility();

		expect(ctx.toolDisplayState).toBe("claude");
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(cfgDisplayToolState.get(settings)).toBe("claude");
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(2);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(showStatus).toHaveBeenLastCalledWith("Tool display: claude");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);
		expect(setToolDisplayState).toHaveBeenLastCalledWith("claude");
	});
});
