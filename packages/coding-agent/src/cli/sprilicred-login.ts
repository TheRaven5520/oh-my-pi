import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as readline from "node:readline";
import { getAuthBrokerTokenFilePath } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	cfgAuthBrokerToken,
	cfgAuthBrokerUrl,
	cfgCycleModels,
	cfgEnabledModels,
	cfgModelProviderOrder,
	cfgModelRoles,
} from "../config/model-settings";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains, cfgRetryUsageLimitFallbackChains } from "../session/settings";
import { promptLine } from "./oauth-terminal";

const DEFAULT_URL = "https://sprilicred.taila2d385.ts.net";
const MODEL_STATE = ".sprilicred/omp-models.json";
const ROLES_STATE = ".sprilicred/omp-roles.json";
const CYCLE_STATE = ".sprilicred/omp-cycle.before-sprilicred.json";
const BROKER_STATE = ".sprilicred/omp-broker.before-sprilicred.json";

type ProviderGroup = {
	provider: string;
	/** Route that lists exactly this provider's models. */
	listing: string;
	/** Path appended to the Sprilicred URL for the provider's baseUrl. */
	suffix: string;
	api: "anthropic-messages" | "openai-responses";
	auth: "oauth" | "apiKey";
	discovery: Record<string, unknown>;
	family: "anthropic" | "openai";
	/** Required groups fail login when unlisted; dedicated groups are optional. */
	required: boolean;
};

const OPENAI_DISCOVERY = { type: "openai-models-list", injectV1: false };
const OPENAI_PROVIDER = "sprilicred-openai";
// Same layout as the Sprilicred installer (deploy/connect.py install_omp): models
// with a dedicated route (`/<route>/v1`) live under their own `sprilicred-<route>`.
// DeepSeek is listed only to keys with an API-key grant; others get an empty listing.
const DEEPSEEK_PROVIDER = "sprilicred-deepseek";
const DEDICATED_ROUTES = ["deepseek"];
// The installer's built-in dedicated IDs remain managed even without an ownership file.
const DEDICATED_MODELS: Record<string, true> = { "deepseek-v4.1-flash": true };
// Any OpenRouter model, listed at `/openrouter/v1/models` to keys with an API-key grant. omp
// discovers them for the model browser; models.yml holds no list, and they never join Ctrl+P.
const OPENROUTER_PROVIDER = "sprilicred-openrouter";
const OPENROUTER_LISTING = "/openrouter/v1/models";
// `*` stops at `/`, and OpenRouter ids are `vendor/model`.
const OPENROUTER_SCOPE = `${OPENROUTER_PROVIDER}/**`;
// Muse Wonder had its own provider (`sprilicred-muse`, `/muse/v1`); it is now an OpenRouter model.
const MUSE_PROVIDER = "sprilicred-muse";
const MUSE_ID = "muse-wonder";
const MUSE_REF = `${OPENROUTER_PROVIDER}/meta/muse-wonder`;
// Providers Sprilicred no longer offers anyone: removed with every reference to them.
const RETIRED_PROVIDERS = ["sprilicred-glm", MUSE_PROVIDER];
// Models that accept the real `none` effort tier (connect.py model_fields): the Codex-backed
// GPT models plus the dedicated ones. Do not guess for future IDs.
const NONE_EFFORT_MODELS: Record<string, true> = {
	"gpt-6-astra": true,
	"gpt-6.1-sol": true,
	"gpt-6-luna": true,
	...DEDICATED_MODELS,
};
// Offline copy of pricing.rs CLAUDE_EFFORTS (connect.py), used when a listing names no efforts;
// Haiku has token budgets, not effort.
const CLAUDE_EFFORTS: Record<string, string[]> = {
	"claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
	"claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
	"claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
};
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const PROVIDER_GROUPS: ProviderGroup[] = [
	{
		provider: "sprilicred-anthropic",
		listing: "/anthropic/v1/models",
		suffix: "/anthropic",
		api: "anthropic-messages",
		auth: "oauth",
		discovery: { type: "openai-models-list" },
		family: "anthropic",
		required: true,
	},
	{
		provider: OPENAI_PROVIDER,
		listing: "/v1/models",
		suffix: "/v1",
		api: "openai-responses",
		auth: "apiKey",
		discovery: OPENAI_DISCOVERY,
		family: "openai",
		required: true,
	},
	...DEDICATED_ROUTES.map((route): ProviderGroup => ({
		provider: `sprilicred-${route}`,
		listing: `/${route}/v1/models`,
		suffix: `/${route}/v1`,
		api: "openai-responses",
		auth: "apiKey",
		discovery: OPENAI_DISCOVERY,
		family: "openai",
		required: false,
	})),
];
const BASE_CYCLE = ["sprilicred-anthropic/*", "sprilicred-openai/*"];
// Installer default cycles, old and new: replaced by the current default on every login.
const OLD_CYCLE = [...BASE_CYCLE, "sprilicred-glm/*", `${DEEPSEEK_PROVIDER}/*`, `${MUSE_PROVIDER}/*`];
const OWNED_CYCLES = [
	...OLD_CYCLE.slice(1).map((_, index) => OLD_CYCLE.slice(0, index + 2)),
	[...BASE_CYCLE, `${DEEPSEEK_PROVIDER}/*`],
];

type CatalogModel = {
	id: string;
	display_name?: string;
	context_window?: number;
	context_length?: number;
	max_output_tokens?: number;
	supports_reasoning?: boolean;
	reasoning_efforts?: unknown;
	input_modalities?: string[];
	pricing?: Record<string, unknown>;
};

type ModelConfig = Record<string, unknown> & { id: string };
type ModelState = Record<string, { present: boolean; before: unknown; applied: unknown }>;

/** Where old references go in this login. */
type Migration = {
	/** Dedicated model id -> provider it moved to from sprilicred-openai. */
	moved: Map<string, string>;
	/** Providers removed this login; references to them are removed too. */
	withdrawn: Set<string>;
	/** Muse Wonder moves to OpenRouter, only in a login that writes the OpenRouter provider. */
	muse: boolean;
};

type WrittenModels = {
	defaultModel: string;
	/** The previous default when this login replaced it because its model is gone. */
	replacedDefault?: string;
	/** Model ids per provider that models.yml now holds. */
	byProvider: Record<string, string[]>;
	/** Whether models.yml now holds the DeepSeek provider (it joins the default cycle). */
	deepseek: boolean;
	migration: Migration;
	/** Dedicated and OpenRouter providers this login wrote that models.yml did not hold before. */
	added: string[];
};

export type SprilicredLoginPaths = { home: string; agentDir: string; tokenPath: string };

function resolvePaths(overrides?: Partial<SprilicredLoginPaths>): SprilicredLoginPaths {
	const home = overrides?.home ?? os.homedir();
	return {
		home,
		agentDir: overrides?.agentDir ?? getAgentDir(),
		tokenPath:
			overrides?.tokenPath ??
			(overrides?.home ? path.join(home, ".omp/auth-broker.token") : getAuthBrokerTokenFilePath()),
	};
}

function endpoint(): string {
	return (process.env.SPRILICRED_URL || DEFAULT_URL).replace(/\/+$/, "");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function privateWrite(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp-${process.pid}`;
	await fs.writeFile(temporary, content, { mode: 0o600 });
	await fs.rename(temporary, file);
	await fs.chmod(file, 0o600);
}

async function readJson(file: string, fallback: unknown): Promise<any> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}

async function exists(file: string): Promise<boolean> {
	return fs
		.stat(file)
		.then(() => true)
		.catch(() => false);
}

class CatalogHttpError extends Error {
	constructor(
		readonly status: number,
		route: string,
	) {
		super(`${route} returned HTTP ${status}`);
	}
}

async function fetchCatalog(baseUrl: string, route: string, key: string): Promise<CatalogModel[]> {
	let response: Response;
	try {
		response = await fetch(`${baseUrl}${route}`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new Error(`could not reach Sprilicred at ${baseUrl}`);
		}
		throw error;
	}
	if (!response.ok) throw new CatalogHttpError(response.status, route);
	const payload = (await response.json()) as { data?: CatalogModel[] };
	return (payload.data ?? []).filter(model => typeof model?.id === "string" && model.id.length > 0);
}

/**
 * A listing. Required groups fail login when unlisted or unreachable. Other listings are `[]`
 * when the server does not offer them to this key (nothing listed, or 403/404), and null when
 * they could not be asked (network, 5xx, timeout), so what was written before is kept.
 */
async function fetchListing(
	baseUrl: string,
	route: string,
	key: string,
	required: boolean,
): Promise<CatalogModel[] | null> {
	if (required) {
		const models = await fetchCatalog(baseUrl, route, key);
		if (models.length === 0) throw new Error(`${route} returned no models`);
		return models;
	}
	try {
		return await fetchCatalog(baseUrl, route, key);
	} catch (error) {
		return error instanceof CatalogHttpError && (error.status === 403 || error.status === 404) ? [] : null;
	}
}

/**
 * Where an old reference goes now; undefined when it points at a withdrawn provider. Muse
 * Wonder (`sprilicred-muse/` or the older `sprilicred-openai/`) moves to its OpenRouter id when
 * OpenRouter is written, and a `sprilicred-openai/<dedicated id>[:level]` to its own provider.
 */
function migrateRef(ref: string, migration: Migration): string | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0) return ref;
	const provider = ref.slice(0, slash);
	const rest = ref.slice(slash + 1);
	const id = rest.split(":")[0];
	if ((provider === MUSE_PROVIDER || provider === OPENAI_PROVIDER) && id === MUSE_ID) {
		return migration.muse ? `${MUSE_REF}${rest.slice(MUSE_ID.length)}` : undefined;
	}
	if (migration.withdrawn.has(provider)) return undefined;
	if (provider !== OPENAI_PROVIDER) return ref;
	const target = migration.moved.get(id);
	return target ? `${target}/${rest}` : ref;
}

function perMillion(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value / 1000 : undefined;
}

function modelFields(model: CatalogModel, family: "anthropic" | "openai"): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	const contextWindow = model.context_window ?? model.context_length;
	if (typeof contextWindow === "number" && contextWindow > 0) fields.contextWindow = contextWindow;
	if (typeof model.max_output_tokens === "number" && model.max_output_tokens > 0)
		fields.maxTokens = model.max_output_tokens;
	if (typeof model.supports_reasoning === "boolean") fields.reasoning = model.supports_reasoning;
	if (family === "anthropic" && model.supports_reasoning !== false) {
		// A listed (even empty) effort list wins over the built-in ladder: empty is a budget model.
		const efforts = "reasoning_efforts" in model ? model.reasoning_efforts : CLAUDE_EFFORTS[model.id];
		if (
			Array.isArray(efforts) &&
			efforts.length > 0 &&
			efforts.every(effort => CLAUDE_EFFORT_LEVELS.includes(effort))
		) {
			fields.thinking = { mode: "anthropic-adaptive", efforts };
		}
	}
	if (Array.isArray(model.input_modalities) && model.input_modalities.includes("text")) {
		fields.input = model.input_modalities.includes("image") ? ["text", "image"] : ["text"];
	}
	const pricing = model.pricing;
	if (pricing?.unit === "microcredits_per_token") {
		const cost = {
			input: perMillion(pricing.input),
			output: perMillion(pricing.output),
			cacheRead: perMillion(pricing.cache_read ?? 0),
			cacheWrite: perMillion(pricing.cache_write ?? pricing.cache_write_5m ?? 0),
		};
		if (Object.values(cost).every(value => value !== undefined)) fields.cost = cost;
	}
	if (family === "anthropic" && pricing?.fast_mode !== null && typeof pricing?.fast_mode === "object") {
		fields.compat = { supportsFastMode: true };
	}
	if (family !== "anthropic" && Object.hasOwn(NONE_EFFORT_MODELS, model.id)) {
		fields.compat = { reasoningDisableMode: "none-effort" };
	}
	return fields;
}

function applyOwnedField(state: ModelState, key: string, entry: ModelConfig, field: string, value: unknown): void {
	const current = entry[field];
	const saved = state[key];
	if (current === undefined || Bun.deepEquals(current, value) || (saved && Bun.deepEquals(saved.applied, current))) {
		state[key] = {
			present: saved?.present ?? current !== undefined,
			before: saved?.before ?? current,
			applied: value,
		};
		entry[field] = value;
	}
}

async function writeModels(
	catalogs: Map<string, CatalogModel[] | null>,
	openrouter: CatalogModel[] | null,
	paths: SprilicredLoginPaths,
): Promise<WrittenModels> {
	const modelsPath = path.join(paths.agentDir, "models.yml");
	let existing: Record<string, any> = {};
	try {
		existing = (YAML.parse(await fs.readFile(modelsPath, "utf8")) as Record<string, any>) ?? {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`${modelsPath} could not be read: ${String(error)}`);
		}
	}
	if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
		throw new Error(`${modelsPath} must contain a mapping`);
	}

	const original = (existing.providers ?? {}) as Record<string, any>;
	const providers = { ...original };
	const tokenCommand = `!cat ${shellQuote(paths.tokenPath)}`;
	const statePath = path.join(paths.home, MODEL_STATE);
	const state = (await readJson(statePath, {})) as ModelState;
	const previousOpenai = new Map(
		((original[OPENAI_PROVIDER]?.models ?? []) as ModelConfig[])
			.filter(model => typeof model?.id === "string")
			.map(model => [model.id, model]),
	);
	const byProvider: Record<string, string[]> = {};
	const moved = new Map<string, string>();
	const withdrawn = new Set(RETIRED_PROVIDERS);

	for (const group of PROVIDER_GROUPS) {
		const { provider } = group;
		let catalog = catalogs.get(provider) ?? null;
		if (provider === OPENAI_PROVIDER && catalog) {
			// A model with its own listed route lives only under its own provider.
			const dedicatedIds = new Set(
				PROVIDER_GROUPS.filter(other => !other.required).flatMap(
					other => catalogs.get(other.provider)?.map(model => model.id) ?? [],
				),
			);
			catalog = catalog.filter(model => !dedicatedIds.has(model.id));
		}
		if (!group.required && catalog?.length === 0) {
			// Not offered to this key (no API-key grant, or withdrawn): removed with its references.
			withdrawn.add(provider);
			continue;
		}
		if (catalog === null) {
			// Optional route could not be asked: keep whatever was written before.
			const kept = ((providers[provider]?.models ?? []) as ModelConfig[]).map(model => model.id);
			if (kept.length > 0) byProvider[provider] = kept;
			for (const id of kept) moved.set(id, provider);
			continue;
		}
		const previousById = new Map(
			((original[provider]?.models ?? []) as ModelConfig[])
				.filter(model => typeof model?.id === "string")
				.map(model => [model.id, model]),
		);
		const entries: ModelConfig[] = [];
		for (const catalogModel of catalog) {
			let previousModel = previousById.get(catalogModel.id);
			if (!group.required) {
				moved.set(catalogModel.id, provider);
				const fromOpenai = previousOpenai.get(catalogModel.id);
				if (!previousModel && fromOpenai) {
					// Moved out of sprilicred-openai: keep the person's fields and ownership.
					previousModel = fromOpenai;
					const oldPrefix = `${OPENAI_PROVIDER}/${catalogModel.id}.`;
					for (const key of Object.keys(state)) {
						if (!key.startsWith(oldPrefix)) continue;
						state[`${provider}/${catalogModel.id}.${key.slice(oldPrefix.length)}`] = state[key];
						delete state[key];
					}
				}
			}
			const defaultName = `${catalogModel.display_name || catalogModel.id} via Sprilicred`;
			const entry = previousModel
				? {
						...previousModel,
						name: typeof previousModel.name === "string" ? previousModel.name : defaultName,
						id: catalogModel.id,
					}
				: { id: catalogModel.id, name: defaultName };
			for (const [field, value] of Object.entries(modelFields(catalogModel, group.family))) {
				applyOwnedField(state, `${provider}/${catalogModel.id}.${field}`, entry, field, value);
			}
			if (!group.required) {
				state[`${provider}/${catalogModel.id}.listed`] = { present: false, before: null, applied: true };
			}
			entries.push(entry);
		}
		if (!group.required) {
			const listedIds = new Set(entries.map(entry => entry.id));
			const ownedFields = Object.keys(state);
			for (const [id, entry] of previousById) {
				if (
					!listedIds.has(id) &&
					!Object.hasOwn(DEDICATED_MODELS, id) &&
					!ownedFields.some(key => key.startsWith(`${provider}/${id}.`))
				) {
					entries.push(entry);
				}
			}
		}
		if (entries.length === 0) {
			delete providers[provider];
			continue;
		}
		providers[provider] = {
			...(!group.required ? original[provider] : {}),
			baseUrl: `${endpoint()}${group.suffix}`,
			apiKey: tokenCommand,
			auth: group.auth,
			authHeader: true,
			api: group.api,
			discovery: group.discovery,
			models: entries,
		};
		byProvider[provider] = entries.map(entry => entry.id);
	}
	// The OpenRouter provider carries no model list of ours: discovery reads the listing.
	// Not offered to this key: removed with its references. Not reachable: written anyway.
	const offersOpenRouter = openrouter === null || openrouter.length > 0;
	if (offersOpenRouter) {
		providers[OPENROUTER_PROVIDER] = {
			...original[OPENROUTER_PROVIDER],
			baseUrl: `${endpoint()}/openrouter/v1`,
			apiKey: tokenCommand,
			auth: "apiKey",
			authHeader: true,
			api: "openai-responses",
			discovery: OPENAI_DISCOVERY,
		};
	} else withdrawn.add(OPENROUTER_PROVIDER);
	// Withdrawn providers go even when the person added models under them.
	for (const provider of withdrawn) {
		delete providers[provider];
		for (const key of Object.keys(state)) {
			if (key.startsWith(`${provider}/`)) delete state[key];
		}
	}
	const migration: Migration = { moved, withdrawn, muse: offersOpenRouter };

	const fallbackDefault = `sprilicred-anthropic/${byProvider["sprilicred-anthropic"][0]}`;
	const previousDefault = typeof existing.defaultModel === "string" ? existing.defaultModel : undefined;
	const currentDefault = previousDefault === undefined ? undefined : migrateRef(previousDefault, migration);
	const written = Object.entries(byProvider).flatMap(([provider, ids]) => ids.map(id => `${provider}/${id}`));
	// A chosen OpenRouter model stays the default while it is listed, or while the listing is unknown.
	const openrouterDefault = currentDefault?.startsWith(`${OPENROUTER_PROVIDER}/`)
		? currentDefault.slice(OPENROUTER_PROVIDER.length + 1).split(":")[0]
		: undefined;
	const keptOpenRouterDefault =
		openrouterDefault !== undefined &&
		(openrouter === null || openrouter.some(model => model.id === openrouterDefault));
	let replacedDefault: string | undefined;
	if (!currentDefault) {
		existing.defaultModel = fallbackDefault;
		replacedDefault = previousDefault;
	} else if (
		currentDefault.startsWith("sprilicred-") &&
		!keptOpenRouterDefault &&
		!written.some(model => currentDefault === model || currentDefault.startsWith(`${model}:`))
	) {
		existing.defaultModel = fallbackDefault;
		replacedDefault = previousDefault;
	} else existing.defaultModel = currentDefault;
	existing.providers = providers;
	await privateWrite(modelsPath, `${JSON.stringify(existing, null, 2)}\n`);
	await privateWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
	const added = [
		...PROVIDER_GROUPS.filter(group => !group.required).map(group => group.provider),
		OPENROUTER_PROVIDER,
	].filter(provider => !(provider in original) && provider in providers);
	return {
		defaultModel: existing.defaultModel,
		replacedDefault,
		byProvider,
		deepseek: DEEPSEEK_PROVIDER in providers,
		migration,
		added,
	};
}

/**
 * Adds newly written dedicated providers to a scoped list (cycleModels, enabledModels,
 * modelProviderOrder) after the Sprilicred group, like the installer's scope migration.
 * Lists without the sprilicred-openai scope are left alone.
 */
function addScopes(list: string[], added: string[], providerOnly: boolean): string[] {
	const scope = (provider: string) =>
		providerOnly ? provider : provider === OPENROUTER_PROVIDER ? OPENROUTER_SCOPE : `${provider}/*`;
	if (!list.includes(scope(OPENAI_PROVIDER))) return list;
	const ours = new Set(
		[OPENAI_PROVIDER, ...DEDICATED_ROUTES.map(route => `sprilicred-${route}`), OPENROUTER_PROVIDER].map(scope),
	);
	const index = list.findLastIndex(item => ours.has(item)) + 1;
	const additions = added.map(scope).filter(item => !list.includes(item));
	return [...list.slice(0, index), ...additions, ...list.slice(index)];
}

/**
 * Moves a scoped list's references to where their models live now. When Muse Wonder moves,
 * its retired provider scope is dropped (or, in a cycle the person chose, becomes Muse
 * Wonder's exact OpenRouter id); other refs go through {@link migrateRef}. Duplicates keep the first.
 */
function migrateScopes(list: string[], migration: Migration, museScope: "drop" | "exact"): string[] {
	const next: string[] = [];
	for (const item of list) {
		const isMuseScope = migration.muse && (item === MUSE_PROVIDER || item === `${MUSE_PROVIDER}/*`);
		if (isMuseScope && museScope === "drop") continue;
		const migrated = isMuseScope ? MUSE_REF : migrateRef(item, migration);
		if (!next.includes(migrated)) next.push(migrated);
	}
	return next;
}

/** Migrates fallback-chain keys and entries (`retry.fallbackChains`, `retry.usageLimitFallbackChains`). */
function migrateChains(chains: Record<string, string[]>, migration: Migration): Record<string, string[]> | undefined {
	let changed = false;
	const next: Record<string, string[]> = {};
	for (const [key, chain] of Object.entries(chains)) {
		const migratedKey = migrateRef(key, migration);
		const migrated = chain.map(ref => migrateRef(ref, migration));
		if (migratedKey !== key || migrated.some((ref, index) => ref !== chain[index])) changed = true;
		next[migratedKey] = migrated;
	}
	return changed ? next : undefined;
}

function wantedRoles(models: WrittenModels): Record<string, string> {
	const anthropic = models.byProvider["sprilicred-anthropic"];
	const openai = models.byProvider[OPENAI_PROVIDER];
	const claude = anthropic.find(model => model.includes("haiku")) ?? anthropic.at(-1);
	const gpt = openai.find(model => model.includes("sol")) ?? openai.at(0);
	if (!claude || !gpt) throw new Error("Sprilicred returned no models for helper roles");
	return {
		default: models.defaultModel,
		smol: `sprilicred-anthropic/${claude}`,
		tiny: `sprilicred-anthropic/${claude}`,
		judge: `sprilicred-anthropic/${claude}`,
		slow: `sprilicred-openai/${gpt}`,
		web: `sprilicred-anthropic/${claude}`,
	};
}

async function prepareBroker(settings: Settings, key: string, paths: SprilicredLoginPaths): Promise<void> {
	const statePath = path.join(paths.home, BROKER_STATE);
	if (!(await exists(statePath))) {
		const currentUrl = cfgAuthBrokerUrl.get(settings);
		const before = currentUrl && !currentUrl.includes("sprilicred") ? currentUrl : undefined;
		const backup = `${paths.tokenPath}.before-sprilicred`;
		if ((await exists(paths.tokenPath)) && !(await exists(backup))) await fs.copyFile(paths.tokenPath, backup);
		await privateWrite(statePath, `${JSON.stringify({ url: before })}\n`);
	}
	await privateWrite(paths.tokenPath, key);
	cfgAuthBrokerUrl.set(settings, endpoint());
	cfgAuthBrokerToken.unset(settings);
	await settings.flush();
}

async function writeOwnedSettings(
	settings: Settings,
	models: WrittenModels,
	paths: SprilicredLoginPaths,
): Promise<void> {
	const stateRoot = path.join(paths.home, ".sprilicred");
	await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });

	// Only the installer's exact old or current defaults are ours to replace (the old ones still
	// listed Muse Wonder's provider, retired once OpenRouter is written). The OpenRouter
	// provider never joins the cycle: its models are picked in the model browser.
	const { migration } = models;
	const currentCycle = cfgCycleModels.get(settings);
	const ownCycle = (migration.muse ? OWNED_CYCLES : OWNED_CYCLES.slice(0, -1)).some(owned =>
		Bun.deepEquals(currentCycle, owned),
	);
	if (currentCycle.length === 0) {
		const cycleState = path.join(paths.home, CYCLE_STATE);
		if (!(await exists(cycleState))) await privateWrite(cycleState, `${JSON.stringify({ before: currentCycle })}\n`);
	}
	const nextCycle =
		currentCycle.length === 0 || ownCycle
			? CYCLE_MODELS
			: addScopes(
					migrateScopes(currentCycle, migration, "exact"),
					models.added.filter(provider => provider !== OPENROUTER_PROVIDER),
					false,
				);
	if (!Bun.deepEquals(currentCycle, nextCycle)) cfgCycleModels.set(settings, nextCycle);

	const currentEnabled = cfgEnabledModels.get(settings);
	const nextEnabled = addScopes(migrateScopes(currentEnabled, migration, "drop"), models.added, false);
	if (!Bun.deepEquals(currentEnabled, nextEnabled)) cfgEnabledModels.set(settings, nextEnabled);
	const currentOrder = cfgModelProviderOrder.get(settings);
	const nextOrder = addScopes(migrateScopes(currentOrder, migration, "drop"), models.added, true);
	if (!Bun.deepEquals(currentOrder, nextOrder)) cfgModelProviderOrder.set(settings, nextOrder);
	for (const chains of [cfgRetryFallbackChains, cfgRetryUsageLimitFallbackChains]) {
		const next = migrateChains(chains.get(settings), migration);
		if (next) chains.set(settings, next);
	}

	const currentRoles = cfgModelRoles.get(settings);
	const rolesStatePath = path.join(paths.home, ROLES_STATE);
	const rolesState = (await readJson(rolesStatePath, { roles: {} })) as { roles: Record<string, string> };
	const desired = wantedRoles(models);
	const nextRoles: Record<string, string> = {};
	let changed = false;
	for (const [role, value] of Object.entries(currentRoles)) {
		nextRoles[role] = migrateRef(value, migration);
		if (nextRoles[role] !== value) changed = true;
	}
	const written: Record<string, string> = {};
	for (const [role, value] of Object.entries(desired)) {
		const ownedRole = migrateRef(rolesState.roles?.[role] ?? "", migration);
		if (currentRoles[role] === undefined || nextRoles[role] === ownedRole) {
			nextRoles[role] = value;
			written[role] = value;
		}
	}
	if (changed || Object.keys(written).length > 0) cfgModelRoles.set(settings, nextRoles);
	await privateWrite(rolesStatePath, `${JSON.stringify({ roles: written })}\n`);
	await settings.flush();
}

export async function runSprilicredLogin(
	rl: readline.Interface,
	settings: Settings,
	suppliedKey?: string,
	pathOverrides?: Partial<SprilicredLoginPaths>,
): Promise<void> {
	const key = (suppliedKey ?? (await promptLine(rl, "Paste your Sprilicred API key: "))).trim();
	if (!key) throw new Error("Sprilicred API key is empty");
	const baseUrl = endpoint();
	const [listings, openrouter] = await Promise.all([
		Promise.all(PROVIDER_GROUPS.map(group => fetchGroup(baseUrl, group, key))),
		fetchOpenRouter(baseUrl, key),
	]);
	const catalogs = new Map(PROVIDER_GROUPS.map((group, index) => [group.provider, listings[index]]));
	const paths = resolvePaths(pathOverrides);
	await prepareBroker(settings, key, paths);
	const models = await writeModels(catalogs, openrouter, paths);
	await writeOwnedSettings(settings, models, paths);
	const count = Object.values(models.byProvider).reduce((total, ids) => total + ids.length, 0);
	const browse = openrouter?.length ? `; ${openrouter.length} OpenRouter models are in /model` : "";
	process.stdout.write(`\nLogged in to Sprilicred; configured ${count} models${browse}\n`);
}
