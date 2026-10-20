import { describe, expect, it, type Mock, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

function createAssistant(): AssistantMessageComponent {
	const assistant = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
	assistant.setHideThinkingBlock = vi.fn();
	return assistant;
}

describe("InputController thinking visibility", () => {
	it("toggles the persisted display preference before reasoning arrives", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: true, // thinking is off → effective is true
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn(), resetStableEmission: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});

	it("allows toggling when thinking is off after reasoning content was received", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetOrder: string[] = [];
		const resetDisplay = vi.fn(() => resetOrder.push("display"));
		const resetStableEmission = vi.fn(() => resetOrder.push("stable emission"));
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: false,
			hasDisplayableThinkingContent: true,
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: {
				children: [assistant],
				clear: vi.fn(),
				addChild: vi.fn(),
				resetStableEmission,
			},
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(resetOrder).toEqual(["stable emission", "display"]);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});

	it("toggles when the focused view session has thinking off", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: true,
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "high" },
			viewSession: { thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn(), resetStableEmission: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});

	it("can show future thinking even when effort is off", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		cfgHideThinkingBlock.set(settings, true);
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: true,
			effectiveHideThinkingBlock: true, // thinking is off → effective is true
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn(), resetStableEmission: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(false);
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(false);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: visible");
	});
});
