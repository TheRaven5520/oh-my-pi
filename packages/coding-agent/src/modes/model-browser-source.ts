import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";
import type { ModelHubSearch, ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import type { ModelRegistry } from "../config/model-registry";
import type { ModelSearchResult } from "../config/model-search";
import { findActiveModelPreset, getModelPresetNames } from "../config/model-presets";
import { resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";

import {
	cfgCycleOrder,
	cfgDisabledProviders,
	cfgModelProviderOrder,
	cfgModelRoleStorage,
} from "../config/model-settings";
import { cfgDefaultThinkingLevel, cfgRetryFallbackChains } from "../session/settings";

/** Supply live model-overlay preferences and runtime resolution from the host. */
export function createModelBrowserSource(settings: Settings): ModelHubSource {
	return {
		get revision() {
			return settings.revision;
		},
		get defaultThinkingLevel() {
			return cfgDefaultThinkingLevel.get(settings);
		},
		get modelProviderOrder() {
			return cfgModelProviderOrder.get(settings);
		},
		get knownRoleIds() {
			return getKnownRoleIds(settings);
		},
		get mruOrder() {
			return settings.getStorage()?.getModelUsageOrder() ?? [];
		},
		get modelPerf() {
			return settings.getStorage()?.getModelPerf() ?? new Map();
		},
		get disabledProviders() {
			return cfgDisabledProviders.get(settings);
		},
		get fallbackChains() {
			return cfgRetryFallbackChains.get(settings);
		},
		get modelRoleStorage() {
			return cfgModelRoleStorage.get(settings);
		},
		get cycleOrder() {
			return cfgCycleOrder.get(settings);
		},
		getModelRole: role => settings.getModelRole(role),
		getProjectModelRole: role => settings.getProjectModelRole(role),
		getGlobalModelRole: role => settings.getGlobalModelRole(role),
		getModelRoleSource: role => settings.getModelRoleSource(role),
		getRoleInfo: role => getRoleInfo(role, settings),
		defaultRoleChain: role => rolePriorityDefaults(role),
		resolveRoleValue: (value, models, roleLookup) => resolveModelRoleValue(value, models, { settings, roleLookup }),
		getModelPresets: () => ({ names: getModelPresetNames(settings), active: findActiveModelPreset(settings) }),
	};
}

/** Session surface the model search adapter updates after a pick. */
export interface ModelSearchScopeSink {
	readonly scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void;
}

/**
 * The /model hub's remote search for providers with `modelSearch`: queries go
 * through the registry (provider auth as discovery uses it); a pick is written
 * to models.yml, reloaded, and joins a non-empty session scope so it lists in
 * /model. The Ctrl+P cycle (cycleModels patterns or the role cycle) is not touched.
 */
export function createModelHubSearch(
	registry: Pick<ModelRegistry, "getModelSearchProviders" | "searchModels" | "addSearchedModel">,
	scope: ModelSearchScopeSink,
	report: { showStatus(message: string): void; showError(message: string): void },
): ModelHubSearch | undefined {
	const providers = registry.getModelSearchProviders();
	if (providers.length === 0) return undefined;
	return {
		providers: providers.map(({ provider, label }) => ({
			providerId: provider,
			label: label?.trim() || formatProviderName(provider),
		})),
		search: (providerId, query, signal) => registry.searchModels(providerId, query, signal),
		onPick: async hit => {
			try {
				const model = await registry.addSearchedModel(hit as ModelSearchResult);
				if (
					scope.scopedModels.length > 0 &&
					!scope.scopedModels.some(
						scoped => scoped.model.provider === model.provider && scoped.model.id === model.id,
					)
				) {
					scope.setScopedModels([...scope.scopedModels, { model }]);
				}
				report.showStatus(`Added ${model.provider}/${model.id} to models.yml`);
				return model;
			} catch (error) {
				report.showError(error instanceof Error ? error.message : String(error));
				return undefined;
			}
		},
	};
}
