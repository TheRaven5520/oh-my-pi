import { describe, expect, it } from "bun:test";
import { formatModelLabel, formatModelName, splitModelSelector } from "@oh-my-pi/pi-tui/render/model-names";

describe("formatModelName", () => {


	it("shows unfamiliar ids whole, keeping an id's own namespace and colons that are not thinking levels", () => {
		expect(formatModelName("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
		expect(formatModelName("openrouter/z-ai/glm-5.2", { ref: "identity" })).toBe("z-ai/glm-5.2");
		expect(formatModelName("ollama/qwen3:14b", { ref: "selector" })).toBe("qwen3:14b");
		expect(formatModelName("fireworks/kimi-k2", { ref: "identity" })).toBe("kimi-k2");
		expect(formatModelName("o3-mini")).toBe("o3-mini");
	});

	it("returns a long non-matching gemini id unchanged without catastrophic backtracking", () => {
		const id = "google/gemini-2.5-flash-preview-native-audio-dialog:free";
		const start = performance.now();
		expect(formatModelName(`openrouter/${id}`, { ref: "identity" })).toBe(id);
		expect(performance.now() - start).toBeLessThan(50);
	});

	it("keeps an effort-like tail that is part of a model id or identity", () => {
		expect(formatModelName("model:max")).toBe("model:max");
		expect(formatModelName("p/model:high", { ref: "identity" })).toBe("model:high");
		expect(formatModelName("p/model:high", { ref: "selector" })).toBe("model");
	});
});

describe("raw selectors and configured notes", () => {
	it("reads a known family behind a provider and level suffix, wherever it arrives", () => {
		const raw = "sprilicred-anthropic/claude-opus-5-5:xhigh";
		expect(formatModelName(raw)).toBe("Opus 5.5");
		expect(formatModelLabel(raw)).toBe("Opus 5.5 (xhigh)");
		expect(formatModelLabel(raw, "xhigh", { ref: "identity" })).toBe("Opus 5.5 (xhigh)");
		expect(formatModelLabel("sprilicred-openai/gpt-6.1-sol:high")).toBe("GPT-6.1 Sol (high)");
	});

});

describe("formatModelLabel", () => {

	it("prefers an explicit level over a selector suffix and reads none off an id or identity", () => {
		expect(formatModelLabel("a/claude-opus-5-5:low", "high", { ref: "selector" })).toBe("Opus 5.5 (high)");
		expect(formatModelLabel("p/model:high", undefined, { ref: "identity" })).toBe("model:high");
		expect(formatModelLabel("model:high")).toBe("model:high");
	});

	it("leaves out off, inherit and unknown levels", () => {
		for (const level of ["off", "inherit", "future-level", "toString"]) {
			expect(formatModelLabel("claude-opus-5-5", level)).toBe("Opus 5.5");
		}
		expect(formatModelLabel("a/claude-opus-5-5:off", undefined, { ref: "selector" })).toBe("Opus 5.5");
	});
});

describe("splitModelSelector", () => {
	it("splits only an exact thinking-level suffix", () => {
		expect(splitModelSelector("anthropic/claude-opus-5-5:max")).toEqual({
			model: "anthropic/claude-opus-5-5",
			level: "max",
		});
		expect(splitModelSelector("ollama/qwen3:14b")).toEqual({ model: "ollama/qwen3:14b" });
		expect(splitModelSelector("claude-opus-5-5")).toEqual({ model: "claude-opus-5-5" });
	});
});
