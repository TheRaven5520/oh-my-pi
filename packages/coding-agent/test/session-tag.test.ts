import { describe, expect, it } from "bun:test";
import { SessionTagTracker, TAG_CHECK_EVERY_PROMPTS } from "@oh-my-pi/pi-coding-agent/session/session-tag";

describe("SessionTagTracker.resolve", () => {
	it("names an unnamed session from the first proposal", () => {
		expect(new SessionTagTracker(0).resolve(undefined, "MODIFY OMP")).toBe("MODIFY OMP");
	});

	it("replaces an automatic name over the tag cap with the first proposed tag", () => {
		const tracker = new SessionTagTracker(0);
		const title = "Merge and Update Project Dependencies";
		// A kept answer leaves the old title for the next check.
		expect(tracker.resolve(title, null)).toBeUndefined();
		expect(tracker.resolve(title, "MODIFY OMP")).toBe("MODIFY OMP");
	});

	it("renames a tag only after two consecutive checks propose a change", () => {
		const tracker = new SessionTagTracker(0);
		expect(tracker.resolve("MODIFY OMP", "PI05 EVALS")).toBeUndefined();
		expect(tracker.resolve("MODIFY OMP", "MODIFY OMP")).toBeUndefined();
		expect(tracker.resolve("MODIFY OMP", "PI05 EVALS")).toBeUndefined();
		expect(tracker.resolve("MODIFY OMP", "PI05 EVALS")).toBe("PI05 EVALS");
	});
});

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

	it("waits for the cadence when the name is already a tag", () => {
		const tracker = new SessionTagTracker(0);
		for (let i = 1; i < TAG_CHECK_EVERY_PROMPTS; i++) expect(tracker.notePrompt(i)).toBe(false);
		expect(tracker.notePrompt(TAG_CHECK_EVERY_PROMPTS)).toBe(true);
	});
});
