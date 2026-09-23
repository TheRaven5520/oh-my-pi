import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Real transcript rendering with the same dim-until-received bookkeeping InteractiveMode keeps. */
function createFixture() {
	const ctx = createInteractiveModeContext();
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	const awaiting = new Set<UserMessageComponent>();
	ctx.markAwaitingModel = (components: readonly Component[]) => {
		for (const component of components) {
			if (!(component instanceof UserMessageComponent)) continue;
			component.setAwaitingModel(true);
			awaiting.add(component);
		}
	};
	ctx.markUserMessagesReceived = () => {
		for (const component of awaiting) component.setAwaitingModel(false);
		awaiting.clear();
	};
	const controller = new EventController(ctx);
	ctx.eventController = controller;
	const userRow = () => ctx.chatContainer.children.find(child => child instanceof UserMessageComponent);
	return { controller, userRow };
}

const send = (controller: EventController, event: unknown) => controller.handleEvent(event as AgentSessionEvent);

describe("user prompt dimmed until the model receives it", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stays dim through the request and brightens on the model's first delta", async () => {
		const { controller, userRow } = createFixture();
		const prompt = { role: "user", content: "hello", attribution: "user", timestamp: Date.now() } as AgentMessage;

		await send(controller, { type: "message_start", message: prompt });
		expect(userRow()?.awaitingModel).toBe(true);

		// The provider's `start` fires before the request goes out: not a reply yet.
		const partial = assistant("");
		await send(controller, { type: "message_start", message: partial });
		await send(controller, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "start", partial },
		});
		expect(userRow()?.awaitingModel).toBe(true);

		const replying = assistant("hi");
		await send(controller, {
			type: "message_update",
			message: replying,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: replying },
		});
		expect(userRow()?.awaitingModel).toBe(false);
	});

	it("brightens when the request fails before any reply", async () => {
		const { controller, userRow } = createFixture();
		const prompt = { role: "user", content: "hello", attribution: "user", timestamp: Date.now() } as AgentMessage;

		await send(controller, { type: "message_start", message: prompt });
		await send(controller, { type: "message_end", message: { ...assistant(""), stopReason: "error" } });

		expect(userRow()?.awaitingModel).toBe(false);
	});

	it("never dims agent-attributed prompts", async () => {
		const { controller, userRow } = createFixture();
		const redirect = {
			role: "user",
			content: "redirect",
			attribution: "agent",
			timestamp: Date.now(),
		} as AgentMessage;

		await send(controller, { type: "message_start", message: redirect });

		expect(userRow()?.awaitingModel).toBe(false);
	});
});
