import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

function model(provider: string, id: string, contextWindow: number): Model {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
	} as Model;
}

describe("compaction model candidates", () => {
	const primary = model("routed-anthropic", "primary", 1_000_000);
	const fallback = model("routed-openai", "fallback", 500_000);
	const routedLarge = model("routed-anthropic", "primary-large", 1_200_000);
	const personal = model("personal-openai", "decoy", 2_000_000);
	const ambient = model("amazon-bedrock", "ambient", 10_000_000);

	function candidates(available: Model[]): string[] {
		const settings = Settings.isolated({});
		settings.setModelRole("default", "routed-anthropic/primary");
		settings.setModelRole("slow", "routed-openai/fallback");
		const maintenance = new SessionMaintenance({ settings } as unknown as SessionMaintenanceHost);
		return maintenance
			.resolveCompactionModelCandidates(primary, available)
			.map(candidate => `${candidate.provider}/${candidate.id}`);
	}

	it("never widens onto a larger-window provider that no role or preferred model routes to", () => {
		const result = candidates([primary, fallback, personal, ambient]);
		expect(result).toContain("routed-anthropic/primary");
		expect(result).toContain("routed-openai/fallback");
		expect(result).not.toContain("personal-openai/decoy");
		expect(result).not.toContain("amazon-bedrock/ambient");
	});

	it("still widens to the largest window within a routed provider", () => {
		expect(candidates([primary, fallback, routedLarge, personal, ambient])).toContain(
			"routed-anthropic/primary-large",
		);
	});
});
