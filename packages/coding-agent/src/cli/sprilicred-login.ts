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
const DEDICATED_ROUTES = ["glm", "deepseek", "muse"];
// The installer's built-in dedicated IDs remain managed even without an ownership file.
const DEDICATED_MODELS: Record<string, true> = {
	"abliterated-model-large-v2": true,
	"deepseek-v4.1-flash": true,
	"muse-wonder": true,
};
// Dedicated models whose reasoning cannot be turned off (Muse Wonder rejects effort none).
const ALWAYS_REASONING_MODELS: Record<string, true> = { "muse-wonder": true };
// Models that accept the real `none` effort tier (connect.py model_fields): the Codex-backed
// GPT models plus the dedicated ones, minus ALWAYS_REASONING_MODELS. Do not guess for future IDs.
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
const CYCLE_MODELS = PROVIDER_GROUPS.map(group => `${group.provider}/*`);

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

type WrittenModels = {
	defaultModel: string;
	/** Model ids per provider that models.yml now holds. */
	byProvider: Record<string, string[]>;
	/** Dedicated model id -> provider it moved to from sprilicred-openai. */
	moved: Map<string, string>;
	/** Dedicated providers this login wrote that models.yml did not hold before. */
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
	if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`);
	const payload = (await response.json()) as { data?: CatalogModel[] };
	return (payload.data ?? []).filter(model => typeof model?.id === "string" && model.id.length > 0);
}

/** A group's listing; null when an optional route could not be asked (keep what was written before). */
async function fetchGroup(baseUrl: string, group: ProviderGroup, key: string): Promise<CatalogModel[] | null> {
	if (!group.required) return fetchCatalog(baseUrl, group.listing, key).catch(() => null);
	const models = await fetchCatalog(baseUrl, group.listing, key);
	if (models.length === 0) throw new Error(`${group.listing} returned no models`);
	return models;
}

/** Rewrites an old `sprilicred-openai/<dedicated id>[:level]` reference to the model's own provider. */
function migrateRef(ref: string, moved: Map<string, string>): string {
	if (!ref.startsWith(`${OPENAI_PROVIDER}/`)) return ref;
	const rest = ref.slice(OPENAI_PROVIDER.length + 1);
	const provider = moved.get(rest.split(":")[0]);
	return provider ? `${provider}/${rest}` : ref;
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
	if (
		family !== "anthropic" &&
		Object.hasOwn(NONE_EFFORT_MODELS, model.id) &&
		!Object.hasOwn(ALWAYS_REASONING_MODELS, model.id)
	) {
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

	const fallbackDefault = `sprilicred-anthropic/${byProvider["sprilicred-anthropic"][0]}`;
	const currentDefault =
		typeof existing.defaultModel === "string" ? migrateRef(existing.defaultModel, moved) : undefined;
	const written = Object.entries(byProvider).flatMap(([provider, ids]) => ids.map(id => `${provider}/${id}`));
	if (!currentDefault) existing.defaultModel = fallbackDefault;
	else if (
		currentDefault.startsWith("sprilicred-") &&
		!written.some(model => currentDefault === model || currentDefault.startsWith(`${model}:`))
	) {
		existing.defaultModel = fallbackDefault;
	} else existing.defaultModel = currentDefault;
	existing.providers = providers;
	await privateWrite(modelsPath, `${JSON.stringify(existing, null, 2)}\n`);
	await privateWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
	const added = PROVIDER_GROUPS.filter(
		group => !group.required && !(group.provider in original) && group.provider in providers,
	).map(group => group.provider);
	return { defaultModel: existing.defaultModel, byProvider, moved, added };
}

/**
 * Adds newly written dedicated providers to a scoped list (cycleModels, enabledModels,
 * modelProviderOrder) after the Sprilicred group, like the installer's scope migration.
 * Lists without the sprilicred-openai scope are left alone.
 */
function addScopes(list: string[], added: string[], providerOnly: boolean): string[] {
	const scope = (provider: string) => (providerOnly ? provider : `${provider}/*`);
	if (!list.includes(scope(OPENAI_PROVIDER))) return list;
	const ours = new Set([OPENAI_PROVIDER, ...DEDICATED_ROUTES.map(route => `sprilicred-${route}`)].map(scope));
	const index = list.findLastIndex(item => ours.has(item)) + 1;
	const additions = added.map(scope).filter(item => !list.includes(item));
	return [...list.slice(0, index), ...additions, ...list.slice(index)];
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

	// Only the installer's exact old or current defaults are ours to replace.
	const currentCycle = cfgCycleModels.get(settings);
	const ownCycle =
		Bun.deepEquals(currentCycle, CYCLE_MODELS) || Bun.deepEquals(currentCycle, CYCLE_MODELS.slice(0, 2));
	if (currentCycle.length === 0) {
		const cycleState = path.join(paths.home, CYCLE_STATE);
		if (!(await exists(cycleState))) await privateWrite(cycleState, `${JSON.stringify({ before: currentCycle })}\n`);
	}
	const nextCycle =
		currentCycle.length === 0 || ownCycle
			? CYCLE_MODELS
			: addScopes(
					currentCycle.map(ref => migrateRef(ref, models.moved)),
					models.added,
					false,
				);
	if (!Bun.deepEquals(currentCycle, nextCycle)) cfgCycleModels.set(settings, nextCycle);

	const currentEnabled = cfgEnabledModels.get(settings);
	const nextEnabled = addScopes(
		currentEnabled.map(ref => migrateRef(ref, models.moved)),
		models.added,
		false,
	);
	if (!Bun.deepEquals(currentEnabled, nextEnabled)) cfgEnabledModels.set(settings, nextEnabled);
	const currentOrder = cfgModelProviderOrder.get(settings);
	const nextOrder = addScopes(currentOrder, models.added, true);
	if (!Bun.deepEquals(currentOrder, nextOrder)) cfgModelProviderOrder.set(settings, nextOrder);

	const currentRoles = cfgModelRoles.get(settings);
	const rolesStatePath = path.join(paths.home, ROLES_STATE);
	const rolesState = (await readJson(rolesStatePath, { roles: {} })) as { roles: Record<string, string> };
	const desired = wantedRoles(models);
	const nextRoles: Record<string, string> = {};
	let changed = false;
	for (const [role, value] of Object.entries(currentRoles)) {
		nextRoles[role] = migrateRef(value, models.moved);
		if (nextRoles[role] !== value) changed = true;
	}
	const written: Record<string, string> = {};
	for (const [role, value] of Object.entries(desired)) {
		if (currentRoles[role] === undefined || currentRoles[role] === rolesState.roles?.[role]) {
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
	const listings = await Promise.all(PROVIDER_GROUPS.map(group => fetchGroup(baseUrl, group, key)));
	const catalogs = new Map(PROVIDER_GROUPS.map((group, index) => [group.provider, listings[index]]));
	const paths = resolvePaths(pathOverrides);
	await prepareBroker(settings, key, paths);
	const models = await writeModels(catalogs, paths);
	await writeOwnedSettings(settings, models, paths);
	const count = Object.values(models.byProvider).reduce((total, ids) => total + ids.length, 0);
	process.stdout.write(`\nLogged in to Sprilicred; configured ${count} models\n`);
}
