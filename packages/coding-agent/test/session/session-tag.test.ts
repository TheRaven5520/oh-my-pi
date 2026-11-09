import { describe, expect, it } from "bun:test";
import {
	SessionTagTracker,
	TAG_CHECK_EVERY_MS,
	TAG_CHECK_EVERY_PROMPTS,
} from "@oh-my-pi/pi-coding-agent/session/session-tag";

describe("SessionTagTracker", () => {
	const start = 1_000_000;

	it("checks every ten prompts, or after thirty minutes with at least three new prompts", () => {
		const tracker = new SessionTagTracker(start);
		const due: number[] = [];
		for (let i = 1; i <= TAG_CHECK_EVERY_PROMPTS; i++) if (tracker.notePrompt(start + i)) due.push(i);
		expect(due).toEqual([TAG_CHECK_EVERY_PROMPTS]);

		const later = start + TAG_CHECK_EVERY_MS + 100;
		expect(tracker.notePrompt(later)).toBe(false);
		expect(tracker.notePrompt(later)).toBe(false);
		expect(tracker.notePrompt(later)).toBe(true);
		// A long-idle session needs new prompts before the next time-based check.
		expect(tracker.notePrompt(later + 2 * TAG_CHECK_EVERY_MS)).toBe(false);
	});

	it("renames a tag only after two consecutive checks propose a change", () => {
		const tracker = new SessionTagTracker(start);
		expect(tracker.resolve("SPRILICRED", "PI05 EVALS")).toBeUndefined();
		expect(tracker.resolve("SPRILICRED", "PI05 EVALS")).toBe("PI05 EVALS");

		// A kept verdict in between resets the streak.
		expect(tracker.resolve("PI05 EVALS", "MODIFY OMP")).toBeUndefined();
		expect(tracker.resolve("PI05 EVALS", null)).toBeUndefined();
		expect(tracker.resolve("PI05 EVALS", "MODIFY OMP")).toBeUndefined();
	});

});
