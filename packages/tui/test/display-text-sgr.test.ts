import { describe, expect, it } from "bun:test";
import { sanitizeDisplaySgrLine } from "../src/overlays/extensions/display-text";

describe("styled display lines", () => {
	it("preserves gradient and truecolor SGR only", () => {
		const sgr = "\x1b[38;5;211mweekly\x1b[39m \x1b[38;2;1;2;3m50%\x1b[0m";
		expect(sanitizeDisplaySgrLine(sgr)).toBe(sgr);
		expect(sanitizeDisplaySgrLine("\x1b[2Jtitle\r\nnext\x07\x00")).toBe("title next");
	});

	it("discards OSC and DCS payloads even when they contain SGR", () => {
		expect(sanitizeDisplaySgrLine("a\x1b]52;c;secret\x1b[31mhidden\x07b")).toBe("ab");
		expect(sanitizeDisplaySgrLine("a\x1bPprivate\x1b[32msecret\x1b\\b")).toBe("ab");
		expect(sanitizeDisplaySgrLine("a\x1b]unfinished-secret")).toBe("a");
	});

	it("does not preserve malformed escapes or C1 controls", () => {
		const result = sanitizeDisplaySgrLine("hello\x1b[38;broken\x9b2J\ud800");
		expect(result).not.toMatch(/[\x00-\x1f\x7f-\x9f\ud800]/);
	});
});
