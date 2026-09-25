import { describe, expect, it } from "bun:test";
import { SessionTagTracker } from "@oh-my-pi/pi-coding-agent/session/session-tag";

describe("SessionTagTracker.resolve", () => {
	it("names an unnamed session from the first proposal", () => {
		expect(new SessionTagTracker(0).resolve(undefined, "MODIFY OMP")).toBe("MODIFY OMP");
	});

	it("replaces a sentence title only after two consecutive checks propose a change", () => {
		const tracker = new SessionTagTracker(0);
		const title = "Merge and Update Project Dependencies";
		// One check reading only status questions must not rename a descriptive title.
		expect(tracker.resolve(title, "PROJECT STATUS")).toBeUndefined();
		// A kept answer in between resets the pending change.
		expect(tracker.resolve(title, null)).toBeUndefined();
		expect(tracker.resolve(title, "MODIFY OMP")).toBeUndefined();
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
