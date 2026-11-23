import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { selectorModel } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const fast = getBundledModel("google", "gemini-2.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-2.5-flash")!;
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and resolves the chosen role", () => {
		const settings = Settings.isolated({});
		settings.setModelRole("smol", key(fast));
		expect(selectorModel("@commit,@smol", settings, registry)).toEqual(fast);
	});

	it("stops at the first resolvable entry", () => {
		expect(selectorModel(`${key(mini)},${key(fast)}`, Settings.isolated({}), registry)).toEqual(mini);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorModel("@commit", Settings.isolated({}), registry)).toBeUndefined();
	});
});
