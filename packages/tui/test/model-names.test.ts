import { describe, expect, it } from "bun:test";
import { formatModelLabel, formatModelName, splitModelSelector } from "@oh-my-pi/pi-tui/render/model-names";

describe("formatModelName", () => {
	it("names claude, gpt and gemini ids the way their vendors do", () => {
		const cases: Array<[string, string]> = [
			["claude-opus-5-5", "Opus 5.5"],
			["claude-sonnet-5", "Sonnet 5"],
			["claude-haiku-4-5-20251001", "Haiku 4.5"],
			["claude-3-5-sonnet-latest", "Sonnet 3.5"],
			["gpt-6-astra", "GPT-6 Astra"],
			["gpt-5.1-codex-max", "GPT-5.1 Codex Max"],
			["gpt-4o-mini", "GPT-4o Mini"],
			["gemini-2.5-pro", "Gemini 2.5 Pro"],
			["google/gemini-2.5-pro", "Gemini 2.5 Pro"],
		];
		for (const [id, name] of cases) expect(formatModelName(id)).toBe(name);
	});

	it("drops the provider of a reference, a selector's thinking suffix, and a `via` unless asked to keep it", () => {
		expect(formatModelName("sprilicred-anthropic/claude-opus-5-5:low", { ref: "selector" })).toBe("Opus 5.5");
		expect(formatModelName("openrouter/google/gemini-2.5-pro", { ref: "identity" })).toBe("Gemini 2.5 Pro");
		expect(formatModelName("claude-opus-5-5 via Sprilicred")).toBe("Opus 5.5");
		expect(formatModelName("claude-opus-5-5 via Sprilicred", { keepVia: true })).toBe("Opus 5.5 via Sprilicred");
		expect(formatModelName("Claude Opus 4.5")).toBe("Opus 4.5");
	});

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

describe("formatModelLabel", () => {
	it("puts a shown thinking level in parentheses", () => {
		expect(formatModelLabel("sprilicred-anthropic/claude-opus-5-5:low", undefined, { ref: "selector" })).toBe(
			"Opus 5.5 (low)",
		);
		expect(formatModelLabel("claude-opus-5-5", "xhigh")).toBe("Opus 5.5 (xhigh)");
		expect(formatModelLabel("gpt-6-astra", "auto")).toBe("GPT-6 Astra (auto)");
	});

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
