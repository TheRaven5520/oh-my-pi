import { beforeAll, describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgDisplayHideToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "../../../../tui/test/terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "../../../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

describe("InputController tool output expansion", () => {
	it("expands children and forces a full repaint when no block has retired rows", () => {
		const expandable = { setExpanded: vi.fn() };
		const pending = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const canRemoveBlock = vi.fn(() => true);
		const requestRender = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert], canRemoveBlock },
			pendingMessagesContainer: { children: [pending] },
			ui: { requestRender, resetDisplay },
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		expect(pending.setExpanded).toHaveBeenCalledWith(true);
		expect(canRemoveBlock).toHaveBeenCalledWith(expandable);
		// Every affected block is still live, so the forced repaint re-renders
		// them at their new heights in the same frame; nothing to replay.
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledWith(true);
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Tool output expansion: enabled");
	});

	it("replays history when an affected block has retired rows", () => {
		const retired = { setExpanded: vi.fn() };
		const live = { setExpanded: vi.fn() };
		const canRemoveBlock = vi.fn((block: unknown) => block === live);
		const requestRender = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			toolOutputExpanded: true,
			chatContainer: { children: [retired, live], canRemoveBlock },
			pendingMessagesContainer: { children: [] },
			ui: { requestRender, resetDisplay },
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(retired.setExpanded).toHaveBeenCalledWith(false);
		expect(live.setExpanded).toHaveBeenCalledWith(false);
		// Collapsing a block already in terminal history must rewrite it there.
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not expand hidden tool activity and explains why", () => {
		const expandable = { setExpanded: vi.fn() };
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: true,
			toolOutputExpanded: false,
			chatContainer: { children: [expandable] },
			keybindings: { getKeys: vi.fn(() => ["alt+h"]) },
			showStatus,
			ui: { requestRender },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(expandable.setExpanded).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
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
				controller.toggleToolOutputExpansion();
				await scheduler.settle(terminal);
				expect(transcript.canRemoveBlock(tool)).toBe(true);
				expect(transcript.canRemoveBlock(prompt)).toBe(false);
				controller.toggleToolOutputExpansion();
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
		const setToolActivityVisible = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: true,
			settings,
			chatContainer: { children, clear, addChild, setToolActivityVisible },
			rebuildChatFromMessages,
			showStatus,
			ui: { clearInlineImages, resetDisplay },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext) as unknown as InputController & {
			toggleToolActivityVisibility(): void;
		};

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(true);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(true);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: hidden");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(false);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(false);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: visible");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(true);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(true);
	});
});
