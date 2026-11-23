import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolverRegistry } from "../config/api-key-resolver";
import { getModelMatchPreferences, type ModelLookupRegistry, resolveModelRoleValue } from "../config/model-resolver";
import { CHAT_MODEL_ROLE_IDS } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { concreteThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

export interface ResolvedCommitModel {
	model: Model<Api>;
	/**
	 * Resolver for the model's bearer: re-resolves on 401 / usage-limit so the
	 * whole commit pipeline (analysis, map/reduce, changelog) inherits the
	 * central force-refresh + account-rotation policy.
	 */
	apiKey: ApiKey;
	/**
	 * Commit-time inference is stateless: session-level auto classification
	 * isn't available, so an explicit `:auto` selector collapses to "no
	 * override" and the model's own default level fills in.
	 */
	thinkingLevel?: ThinkingLevel;
}

type CommitModelRegistry = ModelLookupRegistry &
	ApiKeyResolverRegistry & {
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	};

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
): Promise<ResolvedCommitModel> {
	const selector =
		override ?? ["commit", "smol", ...CHAT_MODEL_ROLE_IDS].map(role => settings.getModelRole(role)).find(Boolean);
	const resolved = resolveModelRoleValue(selector, modelRegistry.getAvailable(), {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	const model = resolved?.model;
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return {
		model,
		apiKey: modelRegistry.resolver(model),
		thinkingLevel: concreteThinkingLevel(resolved?.thinkingLevel),
	};
}

export async function resolveSmolModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	primary: ResolvedCommitModel,
): Promise<ResolvedCommitModel> {
	const resolved = resolveModelRoleValue("@smol", modelRegistry.getAvailable(), { settings });
	if (!resolved.model) {
		if (!settings.getModelRole("smol")) return primary;
		throw new Error("Configured smol model is unavailable for commit generation");
	}
	if (!(await modelRegistry.getApiKey(resolved.model))) {
		throw new Error(`No API key available for model ${resolved.model.provider}/${resolved.model.id}`);
	}
	return {
		model: resolved.model,
		apiKey: modelRegistry.resolver(resolved.model),
		thinkingLevel: concreteThinkingLevel(resolved.thinkingLevel),
	};
}
