import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type * as readline from "node:readline";
import { getAuthBrokerTokenFilePath } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { getAgentDir, isRecord } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	cfgAuthBrokerToken,
	cfgAuthBrokerUrl,
	cfgCycleModels,
	cfgEnabledModels,
	cfgModelPresets,
	cfgModelProviderOrder,
	cfgModelRoles,
	type ModelPreset,
} from "../config/model-settings";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains, cfgRetryUsageLimitFallbackChains } from "../session/settings";
import { promptLine } from "./oauth-terminal";

const DEFAULT_URL = "https://sprilicred.taila2d385.ts.net";
// The installer's omp default (connect.py DEFAULT_MODELS["omp"]), used when it is listed.
const DEFAULT_MODEL = "claude-sonnet-5";
const MODEL_STATE = ".sprilicred/omp-models.json";
const ROLES_STATE = ".sprilicred/omp-roles.json";
const CYCLE_STATE = ".sprilicred/omp-cycle.before-sprilicred.json";
const BROKER_STATE = ".sprilicred/omp-broker.before-sprilicred.json";

type ProviderGroup = {
	provider: string;
	/** Route that lists exactly this provider's models. */
	listing: string;
	/** Path appended to the SpriliCred URL for the provider's baseUrl. */
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
// Same layout as the SpriliCred installer (deploy/connect.py install_omp): models
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
const MUSE_OPENROUTER_ID = "meta/muse-wonder";
const MUSE_REF = `${OPENROUTER_PROVIDER}/${MUSE_OPENROUTER_ID}`;
// The search /model runs on the OpenRouter provider (`<baseUrl>/models?search=<q>&limit=25`).
const OPENROUTER_SEARCH = { type: "openai-models-list", param: "search", limit: 25, label: "OpenRouter" };
// Muse Wonder's DEDICATED row in pricing.rs (connect.py MODEL_LIMITS, BUILT_IN_CAPABILITIES,
// OPENROUTER_EFFORTS), for the entry a moved Muse reference gets when the listing can't be read.
const MUSE_BUILT_IN = {
	contextWindow: 1_048_576,
	maxTokens: 128_000,
	reasoning: true,
	efforts: ["low", "medium", "high", "xhigh", "max"],
	input: ["text", "image"],
};
// Providers SpriliCred no longer offers anyone: removed with every reference to them.
const RETIRED_PROVIDERS = ["sprilicred-glm", MUSE_PROVIDER];
// Retired models once listed under sprilicred-openai (GLM 5.3 Abliterated, Muse Wonder).
const RETIRED_OPENAI_MODELS: Record<string, true> = { "abliterated-model-large-v2": true, [MUSE_ID]: true };
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
	/**
	 * Muse Wonder moves to OpenRouter, only in a login that writes the OpenRouter provider and
	 * whose OpenRouter listing (when known) still names it.
	 */
	muse: boolean;
	/** Set when a setting's Muse reference moved to OpenRouter: the provider then needs its entry. */
	museMoved: boolean;
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
	/** models.yml as written, rewritten once more when a setting's Muse reference needs its entry. */
	document: Record<string, any>;
	modelsPath: string;
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
			throw new Error(`could not reach SpriliCred at ${baseUrl}`);
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
 * Where an old reference goes now (connect.py move_omp_selector); undefined when it names a
 * withdrawn provider or a retired model. Bare ids (`muse-wonder:high`) count as their provider's.
 * Muse Wonder (`sprilicred-muse/`, the older `sprilicred-openai/`, or bare) moves to its OpenRouter
 * id, level kept, when OpenRouter is written, except in a cycle: OpenRouter never joins Ctrl+P.
 * A `sprilicred-openai/<dedicated id>[:level]` moves to its own provider.
 */
function migrateRef(ref: string, migration: Migration, cycle = false): string | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0) {
		const colon = ref.indexOf(":");
		const id = colon < 0 ? ref : ref.slice(0, colon);
		if (id === MUSE_ID) return cycle || !migration.muse ? undefined : `${MUSE_REF}${ref.slice(id.length)}`;
		if (Object.hasOwn(RETIRED_OPENAI_MODELS, id)) return undefined;
		if (Object.hasOwn(DEDICATED_MODELS, id) && migration.withdrawn.has(DEEPSEEK_PROVIDER)) return undefined;
		// modelProviderOrder names providers bare.
		return migration.withdrawn.has(ref) ? undefined : ref;
	}
	const provider = ref.slice(0, slash);
	const rest = ref.slice(slash + 1);
	const id = rest.split(":")[0];
	if (provider === MUSE_PROVIDER || (provider === OPENAI_PROVIDER && id === MUSE_ID)) {
		if (cycle || !migration.muse || id !== MUSE_ID) return undefined;
		return `${MUSE_REF}${rest.slice(MUSE_ID.length)}`;
	}
	if (migration.withdrawn.has(provider)) return undefined;
	if (provider !== OPENAI_PROVIDER) return ref;
	if (Object.hasOwn(RETIRED_OPENAI_MODELS, id)) return undefined;
	if (Object.hasOwn(DEDICATED_MODELS, id) && migration.withdrawn.has(DEEPSEEK_PROVIDER)) return undefined;
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
	const cost = listedCost(model.pricing);
	if (cost) fields.cost = cost;
	const pricing = model.pricing;
	if (family === "anthropic" && pricing?.fast_mode !== null && typeof pricing?.fast_mode === "object") {
		fields.compat = { supportsFastMode: true };
	}
	if (family !== "anthropic" && Object.hasOwn(NONE_EFFORT_MODELS, model.id)) {
		fields.compat = { reasoningDisableMode: "none-effort" };
	}
	return fields;
}

/** A listing's price as omp's cost ($/MTok), or undefined when any part is missing. */
function listedCost(pricing: Record<string, unknown> | undefined): Record<string, number> | undefined {
	if (pricing?.unit !== "microcredits_per_token") return undefined;
	const cost = {
		input: perMillion(pricing.input),
		output: perMillion(pricing.output),
		cacheRead: perMillion(pricing.cache_read || 0),
		cacheWrite: perMillion(pricing.cache_write || pricing.cache_write_5m || 0),
	};
	return Object.values(cost).every(value => value !== undefined) ? (cost as Record<string, number>) : undefined;
}

/**
 * The sprilicred-openrouter entry for `id` (connect.py add_omp_openrouter_entry/model_fields): from
 * its listing row, else Muse Wonder's built-in one, else just its id. Effort stays selectable only
 * with `thinking`: the listed levels omp knows, in omp's order (`none` is not one).
 */
function openRouterEntry(listing: CatalogModel[] | null, id: string): ModelConfig {
	const row: CatalogModel | undefined = listing?.find(model => model.id === id);
	const builtIn = id === MUSE_OPENROUTER_ID ? MUSE_BUILT_IN : undefined;
	const listedName = row?.display_name?.trim() && row.display_name !== id ? row.display_name : undefined;
	const entry: ModelConfig = { id, name: `${listedName ?? (builtIn ? "Muse Wonder" : id)} via SpriliCred` };
	const window = row?.context_window ?? row?.context_length;
	const output = row?.max_output_tokens;
	if (Number.isInteger(window) && Number.isInteger(output) && window! > 0 && output! > 0) {
		entry.contextWindow = window;
		entry.maxTokens = output;
	} else if (builtIn) {
		entry.contextWindow = builtIn.contextWindow;
		entry.maxTokens = builtIn.maxTokens;
	}
	if (typeof row?.supports_reasoning === "boolean") entry.reasoning = row.supports_reasoning;
	else if (builtIn) entry.reasoning = builtIn.reasoning;
	if (entry.reasoning === true) {
		// A listed key wins, even null; the built-in ladder only when the row does not say.
		const listed = row && "reasoning_efforts" in row ? row.reasoning_efforts : builtIn?.efforts;
		const efforts = THINKING_EFFORTS.filter(effort => Array.isArray(listed) && listed.includes(effort));
		if (efforts.length > 0) entry.thinking = { mode: "effort", efforts };
	}
	const modalities = row?.input_modalities;
	if (Array.isArray(modalities) && modalities.includes("text")) {
		entry.input = modalities.includes("image") ? ["text", "image"] : ["text"];
	} else if (builtIn) entry.input = builtIn.input;
	const cost = listedCost(row?.pricing);
	if (cost) entry.cost = cost;
	return entry;
}

/** A name an older login or installer wrote (the " via Sprilicred" spelling) becomes `generated`; any other stays. */
function renamedOldName(stored: string, generated: string): string {
	return stored.endsWith(" via Sprilicred") ? generated : stored;
}
/**
 * Adds `id`'s entry to sprilicred-openrouter's models unless the person already has one; an existing
 * entry only has an old-spelling name renamed (connect.py add_omp_openrouter_entry).
 */
function addOpenRouterEntry(providers: Record<string, any>, listing: CatalogModel[] | null, id: string): boolean {
	const models: unknown[] = providers[OPENROUTER_PROVIDER].models;
	const existing = models.find(entry => isRecord(entry) && entry.id === id) as ModelConfig | undefined;
	if (existing) {
		if (typeof existing.name === "string") {
			existing.name = renamedOldName(existing.name, openRouterEntry(listing, id).name as string);
		}
		return false;
	}
	models.push(openRouterEntry(listing, id));
	return true;
}

/** connect.py's ownership rule: a field is ours to move only while it still holds what we wrote. */
function applyOwnedField(state: ModelState, key: string, entry: ModelConfig, field: string, value: unknown): void {
	const current = entry[field];
	const saved = state[key];
	if (current === undefined || Bun.deepEquals(current, value) || (saved && Bun.deepEquals(saved.applied, current))) {
		if (saved && Bun.deepEquals(saved.applied, current)) saved.applied = value;
		else state[key] = { present: Object.hasOwn(entry, field), before: current ?? null, applied: value };
		entry[field] = value;
	}
}

// Provider keys the login writes; anything else on a SpriliCred provider is the person's and stays first.
const MANAGED_PROVIDER_KEYS: Record<string, true> = {
	baseUrl: true,
	apiKey: true,
	auth: true,
	authHeader: true,
	api: true,
	discovery: true,
	modelSearch: true,
	models: true,
};

function personFields(provider: unknown): Record<string, unknown> {
	if (provider === null || typeof provider !== "object") return {};
	return Object.fromEntries(Object.entries(provider).filter(([key]) => !Object.hasOwn(MANAGED_PROVIDER_KEYS, key)));
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
			const defaultName = `${catalogModel.display_name || catalogModel.id} via SpriliCred`;
			const entry = previousModel
				? {
						...previousModel,
						name:
							typeof previousModel.name === "string"
								? renamedOldName(previousModel.name, defaultName)
								: defaultName,
						id: catalogModel.id,
					}
				: { id: catalogModel.id, name: defaultName };
			for (const [field, value] of Object.entries(modelFields(catalogModel, group.family))) {
				applyOwnedField(state, `${provider}/${catalogModel.id}.${field}`, entry, field, value);
			}
			state[`${provider}/${catalogModel.id}.listed`] = { present: false, before: null, applied: true };
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
			...personFields(original[provider]),
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
	// The OpenRouter provider is a search in /model: its models are the ones the person picked
	// there, plus the entries a moved reference needs. Not offered to this key: removed with its
	// references. Not reachable: written anyway.
	const offersOpenRouter = openrouter === null || openrouter.length > 0;
	if (offersOpenRouter) {
		const before = original[OPENROUTER_PROVIDER];
		providers[OPENROUTER_PROVIDER] = {
			...personFields(before),
			baseUrl: `${endpoint()}/openrouter/v1`,
			apiKey: tokenCommand,
			auth: "apiKey",
			authHeader: true,
			api: "openai-responses",
			modelSearch: OPENROUTER_SEARCH,
			models: Array.isArray(before?.models) ? before.models : [],
		};
	} else withdrawn.add(OPENROUTER_PROVIDER);
	// Withdrawn providers go even when the person added models under them, and so do the
	// ownership records of retired or withdrawn models once listed under sprilicred-openai.
	const goneOpenai = Object.keys({
		...RETIRED_OPENAI_MODELS,
		...(withdrawn.has(DEEPSEEK_PROVIDER) ? DEDICATED_MODELS : {}),
	}).map(id => `${OPENAI_PROVIDER}/${id}.`);
	for (const provider of withdrawn) delete providers[provider];
	for (const key of Object.keys(state)) {
		if ([...withdrawn].some(provider => key.startsWith(`${provider}/`)) || goneOpenai.some(p => key.startsWith(p))) {
			delete state[key];
		}
	}
	// A listing that names models but not Muse Wonder: Muse is not offered, so its references go.
	const museListed = !openrouter?.length || openrouter.some(model => model.id === MUSE_OPENROUTER_ID);
	const migration: Migration = { moved, withdrawn, muse: offersOpenRouter && museListed, museMoved: false };

	existing.providers = providers;
	const anthropicIds = byProvider["sprilicred-anthropic"];
	const fallbackDefault = `sprilicred-anthropic/${anthropicIds.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : anthropicIds[0]}`;
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
	// An OpenRouter default (moved from Muse, or the person's) needs its entry.
	if (existing.defaultModel.startsWith(`${OPENROUTER_PROVIDER}/`) && OPENROUTER_PROVIDER in providers) {
		addOpenRouterEntry(
			providers,
			openrouter,
			existing.defaultModel.slice(OPENROUTER_PROVIDER.length + 1).split(":")[0],
		);
	}
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
		document: existing,
		modelsPath,
	};
}

/**
 * Adds newly written providers to a non-empty scoped list (cycleModels, enabledModels,
 * modelProviderOrder), like the installer's scope migration: DeepSeek joins a list that holds
 * the sprilicred-openai scope, OpenRouter joins any list the person set (or /model would hide
 * it) but never a cycle. They go after the SpriliCred group, else after the last `sprilicred-`
 * entry, else at the end (connect.py move_omp_settings).
 */
function addScopes(list: string[], added: string[], providerOnly: boolean, cycle = false): string[] {
	if (list.length === 0) return list;
	const scope = (provider: string) =>
		providerOnly ? provider : provider === OPENROUTER_PROVIDER ? OPENROUTER_SCOPE : `${provider}/*`;
	const anchored = list.includes(scope(OPENAI_PROVIDER));
	const additions = added
		.filter(provider => (provider === OPENROUTER_PROVIDER ? !cycle : anchored))
		.map(scope)
		.filter(item => !list.includes(item));
	const ours = new Set(
		[OPENAI_PROVIDER, ...DEDICATED_ROUTES.map(route => `sprilicred-${route}`), OPENROUTER_PROVIDER].map(scope),
	);
	let last = list.findLastIndex(item => ours.has(item));
	if (last < 0) last = list.findLastIndex(item => item.startsWith("sprilicred-"));
	const index = last < 0 ? list.length : last + 1;
	return [...list.slice(0, index), ...additions, ...list.slice(index)];
}

/** {@link migrateRef} for a setting's reference; notes when it moved a Muse reference to OpenRouter. */
function migrateSettingRef(ref: string, migration: Migration, cycle = false): string | undefined {
	const migrated = migrateRef(ref, migration, cycle);
	if (migrated !== ref && migrated?.startsWith(MUSE_REF)) migration.museMoved = true;
	return migrated;
}

/**
 * Moves a scoped list's references to where their models live now ({@link migrateRef}). A moved
 * reference already in the list is not repeated; duplicates the person wrote stay, as the
 * installer leaves them. Dropped references are recorded in `removed` as `setting=value`.
 */
function migrateScopes(
	setting: string,
	list: string[],
	migration: Migration,
	removed: string[],
	cycle = false,
): string[] {
	const next: string[] = [];
	for (const item of list) {
		const migrated = migrateSettingRef(item, migration, cycle);
		if (migrated === undefined) removed.push(`${setting}=${item}`);
		else if (migrated === item || !next.includes(migrated)) next.push(migrated);
	}
	return next;
}

/**
 * Migrates fallback-chain keys and entries (`retry.fallbackChains`, `retry.usageLimitFallbackChains`):
 * withdrawn references go, and so does a chain whose key or every entry went. A chain whose key
 * moved never replaces one the person already keeps under the new key.
 */
function migrateChains(
	setting: string,
	chains: Record<string, string[]>,
	migration: Migration,
	removed: string[],
): Record<string, string[]> | undefined {
	let changed = false;
	const next: Record<string, string[]> = {};
	const movedKeys: [string, string[]][] = [];
	for (const [key, chain] of Object.entries(chains)) {
		const migratedKey = migrateSettingRef(key, migration);
		const migrated = migrateScopes(`${setting}.${key}`, chain, migration, removed);
		if (migratedKey !== key || !Bun.deepEquals(migrated, chain)) changed = true;
		if (migratedKey === undefined) removed.push(`${setting}=${key}`);
		else if (migrated.length === 0) continue;
		else if (migratedKey === key) next[key] = migrated;
		else movedKeys.push([migratedKey, migrated]);
	}
	for (const [key, chain] of movedKeys) {
		if (!Object.hasOwn(next, key)) next[key] = chain;
	}
	return changed ? next : undefined;
}

/**
 * Migrates the role maps of the presets saved in the global config (`modelPresets.<name>.modelRoles`);
 * project presets are never copied into the global file. Other preset fields stay as they are.
 */
function migratePresets(settings: Settings, migration: Migration, removed: string[]): void {
	const presets: unknown = settings.getGlobalSettings().modelPresets;
	if (!isRecord(presets)) return;
	for (const [name, preset] of Object.entries(presets)) {
		if (!isRecord(preset) || !isRecord(preset.modelRoles)) continue;
		const nextRoles: Record<string, unknown> = {};
		let changed = false;
		for (const [role, value] of Object.entries(preset.modelRoles)) {
			const migrated = typeof value === "string" ? migrateSettingRef(value, migration) : value;
			if (migrated !== value) changed = true;
			if (migrated === undefined) removed.push(`modelPresets.${name}.modelRoles.${role}=${value}`);
			else nextRoles[role] = migrated;
		}
		// Written back as it was read, only the role map changed: omp validates presets when it applies them.
		const next = { ...preset, modelRoles: nextRoles } as unknown as ModelPreset;
		if (changed) cfgModelPresets.setEntry(settings, name, next);
	}
}

/** Writes a migrated list; one that withdrawal emptied goes back to omp's default (unset). */
function writeList(
	setting: typeof cfgEnabledModels | typeof cfgModelProviderOrder,
	settings: Settings,
	current: string[],
	next: string[],
): void {
	if (current.length > 0 && next.length === 0) setting.unset(settings);
	else if (!Bun.deepEquals(current, next)) setting.set(settings, next);
}

function wantedRoles(models: WrittenModels): Record<string, string> {
	const anthropic = models.byProvider["sprilicred-anthropic"];
	const openai = models.byProvider[OPENAI_PROVIDER];
	const claude = anthropic.find(model => model.includes("haiku")) ?? anthropic.at(-1);
	const gpt = openai.find(model => model.includes("sol")) ?? openai.at(0);
	if (!claude || !gpt) throw new Error("SpriliCred returned no models for helper roles");
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

/** Writes the settings the installer owns; returns the references it removed (`setting=value`). */
async function writeOwnedSettings(
	settings: Settings,
	models: WrittenModels,
	paths: SprilicredLoginPaths,
): Promise<string[]> {
	const stateRoot = path.join(paths.home, ".sprilicred");
	await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
	const { migration } = models;
	const removed: string[] = [];

	// Only the installer's exact old or current defaults are ours to replace; a cycle that
	// withdrawal empties counts as unset. Nothing OpenRouter joins the cycle, Muse Wonder
	// included: its models are picked in the model browser.
	const currentCycle = cfgCycleModels.get(settings);
	const ownCycle = OWNED_CYCLES.some(owned => Bun.deepEquals(currentCycle, owned));
	const migratedCycle = ownCycle ? [] : migrateScopes("cycleModels", currentCycle, migration, removed, true);
	if (currentCycle.length === 0 || (!ownCycle && migratedCycle.length === 0)) {
		const cycleState = path.join(paths.home, CYCLE_STATE);
		if (!(await exists(cycleState))) await privateWrite(cycleState, `${JSON.stringify({ before: [] })}\n`);
	}
	const defaultCycle = models.deepseek ? [...BASE_CYCLE, `${DEEPSEEK_PROVIDER}/*`] : BASE_CYCLE;
	const nextCycle = migratedCycle.length === 0 ? defaultCycle : addScopes(migratedCycle, models.added, false, true);
	if (!Bun.deepEquals(currentCycle, nextCycle)) cfgCycleModels.set(settings, nextCycle);

	const currentEnabled = cfgEnabledModels.get(settings);
	const nextEnabled = addScopes(
		migrateScopes("enabledModels", currentEnabled, migration, removed),
		models.added,
		false,
	);
	writeList(cfgEnabledModels, settings, currentEnabled, nextEnabled);
	const currentOrder = cfgModelProviderOrder.get(settings);
	const nextOrder = addScopes(
		migrateScopes("modelProviderOrder", currentOrder, migration, removed),
		models.added,
		true,
	);
	writeList(cfgModelProviderOrder, settings, currentOrder, nextOrder);
	for (const [name, chains] of [
		["retry.fallbackChains", cfgRetryFallbackChains],
		["retry.usageLimitFallbackChains", cfgRetryUsageLimitFallbackChains],
	] as const) {
		const next = migrateChains(name, chains.get(settings), migration, removed);
		if (next) chains.set(settings, next);
	}
	migratePresets(settings, migration, removed);

	const currentRoles = cfgModelRoles.get(settings);
	const rolesStatePath = path.join(paths.home, ROLES_STATE);
	const rolesState = (await readJson(rolesStatePath, { roles: {} })) as { roles: Record<string, string> };
	const desired = wantedRoles(models);
	const nextRoles: Record<string, string> = {};
	let changed = false;
	for (const [role, value] of Object.entries(currentRoles)) {
		const migrated = migrateSettingRef(value, migration);
		if (migrated !== value) changed = true;
		if (migrated !== undefined) nextRoles[role] = migrated;
		else if (rolesState.roles?.[role] !== value) removed.push(`modelRoles.${role}=${value}`);
	}
	const written: Record<string, string> = {};
	for (const [role, value] of Object.entries(desired)) {
		// Ours while it holds what the last login wrote. A role this login's migration emptied
		// is filled now, so one run reaches the final state.
		const owned = rolesState.roles?.[role];
		const isOwned =
			owned !== undefined &&
			(currentRoles[role] === owned ||
				(nextRoles[role] !== undefined && nextRoles[role] === migrateRef(owned, migration)));
		if (nextRoles[role] === undefined || isOwned) {
			nextRoles[role] = value;
			written[role] = value;
		}
	}
	if (changed || Object.keys(written).length > 0) cfgModelRoles.set(settings, nextRoles);
	await privateWrite(rolesStatePath, `${JSON.stringify({ roles: written })}\n`);
	await settings.flush();
	return removed;
}

export async function runSprilicredLogin(
	rl: readline.Interface,
	settings: Settings,
	suppliedKey?: string,
	pathOverrides?: Partial<SprilicredLoginPaths>,
): Promise<void> {
	const key = (suppliedKey ?? (await promptLine(rl, "Paste your SpriliCred API key: "))).trim();
	if (!key) throw new Error("SpriliCred API key is empty");
	const baseUrl = endpoint();
	const [listings, openrouter] = await Promise.all([
		Promise.all(PROVIDER_GROUPS.map(group => fetchListing(baseUrl, group.listing, key, group.required))),
		fetchListing(baseUrl, OPENROUTER_LISTING, key, false),
	]);
	const catalogs = new Map(PROVIDER_GROUPS.map((group, index) => [group.provider, listings[index]]));
	const paths = resolvePaths(pathOverrides);
	await prepareBroker(settings, key, paths);
	const models = await writeModels(catalogs, openrouter, paths);
	const removed = await writeOwnedSettings(settings, models, paths);
	// Roles, chains or presets on Muse now name the OpenRouter model: give it its entry.
	const { providers } = models.document;
	if (
		models.migration.museMoved &&
		OPENROUTER_PROVIDER in providers &&
		addOpenRouterEntry(providers, openrouter, MUSE_OPENROUTER_ID)
	) {
		await privateWrite(models.modelsPath, `${JSON.stringify(models.document, null, 2)}\n`);
	}
	const count = Object.values(models.byProvider).reduce((total, ids) => total + ids.length, 0);
	const browse = openrouter?.length ? "; search OpenRouter models in /model" : "";
	process.stdout.write(`\nLogged in to SpriliCred; configured ${count} models${browse}\n`);
	if (models.replacedDefault) {
		process.stdout.write(
			`Your default model ${models.replacedDefault} is no longer offered to you; it is now ${models.defaultModel}\n`,
		);
	}
	if (removed.length > 0) {
		process.stdout.write(`Removed settings that named models no longer offered to you: ${removed.join(", ")}\n`);
	}
}
