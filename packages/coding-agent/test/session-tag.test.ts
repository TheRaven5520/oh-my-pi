import { describe, expect, it } from "bun:test";
import { SessionTagTracker, TAG_CHECK_EVERY_PROMPTS } from "@oh-my-pi/pi-coding-agent/session/session-tag";

describe("SessionTagTracker.notePrompt", () => {
	it("checks an over-cap automatic name on the first prompt, then keeps the usual cadence", () => {
		const tracker = new SessionTagTracker(0);
		expect(tracker.notePrompt(1, true)).toBe(true);
		// A due check that could not start (one already in flight) leaves the early check unspent.
		expect(tracker.notePrompt(2, true)).toBe(true);
		tracker.checkStarted(true);
		for (let i = 1; i < TAG_CHECK_EVERY_PROMPTS; i++) expect(tracker.notePrompt(2 + i, true)).toBe(false);
		expect(tracker.notePrompt(100, true)).toBe(true);
	});

});
