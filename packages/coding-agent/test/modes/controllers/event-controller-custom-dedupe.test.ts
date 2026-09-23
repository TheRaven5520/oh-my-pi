import { afterEach, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

type MessageStart = Extract<AgentSessionEvent, { type: "message_start" }>;

function advisorCard(note: string, timestamp: number): CustomMessage {
	return {
		role: "custom",
		customType: "advisor",
		content: `<advisory severity="nit">\n${note}\n</advisory>`,
		display: true,
		attribution: "agent",
		details: { notes: [{ note, severity: "nit" }] },
		timestamp,
	};
}

function start(message: CustomMessage): MessageStart {
	return { type: "message_start", message } as MessageStart;
}

describe("EventController custom message rendering", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders every advisor card flushed in the same millisecond, not just the first", async () => {
		// The end-of-turn flush routes each withheld advisor note as its own card
		// within one tick, so distinct cards share a timestamp.
		const ctx = createInteractiveModeContext();
		const addMessageToChat = vi.spyOn(ctx, "addMessageToChat");
		const controller = new EventController(ctx);
		const at = Date.UTC(2026, 8, 23, 3, 10, 29, 260);

		for (const note of ["first note", "second note", "third note"]) {
			await controller.handleEvent(start(advisorCard(note, at)));
		}

		expect(addMessageToChat.mock.calls.map(([message]) => (message as CustomMessage).content)).toEqual([
			expect.stringContaining("first note"),
			expect.stringContaining("second note"),
			expect.stringContaining("third note"),
		]);
	});

	it("still renders a re-emitted card only once", async () => {
		const ctx = createInteractiveModeContext();
		const addMessageToChat = vi.spyOn(ctx, "addMessageToChat");
		const controller = new EventController(ctx);
		const card = advisorCard("only note", 1_000);

		await controller.handleEvent(start(card));
		await controller.handleEvent(start({ ...card }));

		expect(addMessageToChat).toHaveBeenCalledTimes(1);
	});
});
