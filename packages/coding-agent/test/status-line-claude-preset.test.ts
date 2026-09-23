import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { StatusLineTestComponents } from "./helpers/status-line";

const statusLines = new StatusLineTestComponents();
beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	statusLines.dispose();
	resetSettingsForTest();
});

function makeClaudeComponent(reports: unknown, modelId: string): StatusLineComponent {
	const model = { id: modelId, name: modelId, contextWindow: 1000, provider: "anthropic" };
	const component = statusLines.track(
		new StatusLineComponent(
			{
				state: { messages: [], model },
				model,
				sessionManager: {
					getUsageStatistics: () => ({
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						orchestrationInput: 0,
						orchestrationOutput: 0,
						orchestrationCacheRead: 0,
						premiumRequests: 0,
						cost: 0,
					}),
				},
				fetchUsageReports: async () => reports,
				modelRegistry: { authStorage: { getOAuthAccountIdentity: () => undefined } },
				getAsyncJobSnapshot: () => ({ running: [] }),
				getContextUsage: () => ({ tokens: 380, contextWindow: 1000, percent: 38 }),
			} as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
			statusLineHost,
		),
	);
	component.updateSettings({ preset: "claude", sessionAccent: false });
	return component;
}

async function flushUsageRefresh(): Promise<void> {
	const timer = Promise.withResolvers<void>();
	setTimeout(timer.resolve, 0);
	await timer.promise;
	await Promise.resolve();
	await Promise.resolve();
}

async function renderClaudeLine(reports: unknown, modelId: string): Promise<string> {
	const component = makeClaudeComponent(reports, modelId);
	component.refreshUsageInBackground();
	await flushUsageRefresh();
	return stripVTControlCharacters(component.getTopBorder(300).content);
}

const anthropicReports = [
	{
		provider: "anthropic",
		limits: [
			{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } },
			{ scope: { windowId: "7d" }, amount: { usedFraction: 0.4 } },
			{ scope: { windowId: "7d", tier: "fable" }, amount: { usedFraction: 0.7 } },
		],
	},
];

describe("claude status-line preset", () => {
	it("renders remaining-share gauges with ASCII pipes and no omp icons or tier label", async () => {
		const content = await renderClaudeLine(anthropicReports, "claude-opus-5-5");

		expect(content).toContain("ctx 62% | 5h 76% | wk 60%");
		// The fable-scoped weekly belongs to a different model family.
		expect(content).not.toContain("fable");
	});

	it("appends the model-scoped weekly as the tighter of shared and scoped caps", async () => {
		const content = await renderClaudeLine(anthropicReports, "claude-fable-5");

		expect(content).toContain("5h 76% | wk 60% | fable 30%");
	});

	it("prints a dash for windows the provider does not report", async () => {
		const content = await renderClaudeLine([], "claude-opus-5-5");

		expect(content).toContain("5h — | wk —");
	});
});
