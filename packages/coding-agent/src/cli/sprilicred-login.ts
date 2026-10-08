import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as readline from "node:readline";
import { getAuthBrokerTokenFilePath } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { advertisesAnthropicFastMode } from "../config/model-discovery";
import { cfgAuthBrokerToken, cfgAuthBrokerUrl, cfgCycleModels, cfgModelRoles } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { promptLine } from "./oauth-terminal";

const DEFAULT_URL = "https://sprilicred.taila2d385.ts.net";
const MODEL_STATE = ".sprilicred/omp-models.json";
const ROLES_STATE = ".sprilicred/omp-roles.json";
const CYCLE_STATE = ".sprilicred/omp-cycle.before-sprilicred.json";
const BROKER_STATE = ".sprilicred/omp-broker.before-sprilicred.json";
const CYCLE_MODELS = ["sprilicred-anthropic/*", "sprilicred-openai/*"];
const KEY_FILE = ".sprilicred/user.key";

type CatalogModel = {
	id: string;
	context_window?: number;
	context_length?: number;
	max_output_tokens?: number;
	supports_reasoning?: boolean;
	input_modalities?: string[];
	pricing?: Record<string, unknown>;
};

type ModelConfig = Record<string, unknown> & { id: string };
type ModelState = Record<string, { present: boolean; before: unknown; applied: unknown }>;

type WrittenModels = {
	defaultModel: string;
	anthropic: string[];
	openai: string[];
};

/**
 * `keyPath` is the single source of truth for the Sprilicred key, shared with
 * the Sprilicred installer and `sprilicred-connect`. omp never stores a copy:
 * models.yml reads it with `!cat`, and the auth-broker token is a symlink to it.
 */
export type SprilicredLoginPaths = { home: string; agentDir: string; tokenPath: string; keyPath: string };

function resolvePaths(overrides?: Partial<SprilicredLoginPaths>): SprilicredLoginPaths {
	const home = overrides?.home ?? os.homedir();
	return {
		home,
		agentDir: overrides?.agentDir ?? getAgentDir(),
		tokenPath:
			overrides?.tokenPath ??
			(overrides?.home ? path.join(home, ".omp/auth-broker.token") : getAuthBrokerTokenFilePath()),
		keyPath: path.resolve(overrides?.keyPath ?? path.join(home, KEY_FILE)),
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
	const models = (payload.data ?? []).filter(model => typeof model?.id === "string" && model.id.length > 0);
	if (models.length === 0) throw new Error(`${route} returned no models`);
	return models;
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
	if (family === "anthropic" && advertisesAnthropicFastMode(model)) {
		fields.compat = { supportsFastMode: true };
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
	models: { anthropic: CatalogModel[]; openai: CatalogModel[] },
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
	if (models.anthropic.length === 0 || models.openai.length === 0) {
		throw new Error("Sprilicred returned an empty model catalog");
	}

	const providers = existing.providers ? { ...existing.providers } : {};
	const keyCommand = `!cat ${shellQuote(paths.keyPath)}`;
	const statePath = path.join(paths.home, MODEL_STATE);
	const state = (await readJson(statePath, {})) as ModelState;
	const discovery = {
		anthropic: { type: "openai-models-list" },
		openai: { type: "openai-models-list", injectV1: false },
	};
	const written: Record<string, string[]> = {};

	for (const [family, api, suffix, catalog] of [
		["anthropic", "anthropic-messages", "/anthropic", models.anthropic],
		["openai", "openai-responses", "/v1", models.openai],
	] as const) {
		const provider = `sprilicred-${family}`;
		const previous = (providers[provider]?.models ?? []) as ModelConfig[];
		const previousById = new Map(
			previous.filter(model => typeof model?.id === "string").map(model => [model.id, model]),
		);
		const entries: ModelConfig[] = [];
		for (const catalogModel of catalog) {
			const previousModel = previousById.get(catalogModel.id);
			const defaultName = `${catalogModel.id} via Sprilicred`;
			const entry = previousModel
				? {
						...previousModel,
						name: typeof previousModel.name === "string" ? previousModel.name : defaultName,
						id: catalogModel.id,
					}
				: { id: catalogModel.id, name: defaultName };
			for (const [field, value] of Object.entries(modelFields(catalogModel, family))) {
				applyOwnedField(state, `${provider}/${catalogModel.id}.${field}`, entry, field, value);
			}
			entries.push(entry);
		}
		providers[provider] = {
			baseUrl: `${endpoint()}${suffix}`,
			apiKey: keyCommand,
			auth: family === "anthropic" ? "oauth" : "apiKey",
			authHeader: true,
			api,
			discovery: family === "anthropic" ? discovery.anthropic : discovery.openai,
			models: entries,
		};
		written[family] = entries.map(entry => entry.id);
	}

	const currentDefault = typeof existing.defaultModel === "string" ? existing.defaultModel : undefined;
	const fallbackDefault = `sprilicred-anthropic/${written.anthropic[0]}`;
	if (!currentDefault) existing.defaultModel = fallbackDefault;
	else if (
		currentDefault.startsWith("sprilicred-") &&
		![...written.anthropic, ...written.openai].some(model => currentDefault.endsWith(`/${model}`))
	) {
		existing.defaultModel = fallbackDefault;
	}
	existing.providers = providers;
	await privateWrite(modelsPath, `${JSON.stringify(existing, null, 2)}\n`);
	await privateWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
	return { defaultModel: existing.defaultModel, anthropic: written.anthropic, openai: written.openai };
}

function wantedRoles(models: WrittenModels): Record<string, string> {
	const claude = models.anthropic.find(model => model.includes("haiku")) ?? models.anthropic.at(-1);
	const gpt = models.openai.find(model => model.includes("sol")) ?? models.openai.at(0);
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

/** Save the key as the single 0600 line in `keyPath`, inside a 0700 directory. */
async function writeKeyFile(keyPath: string, key: string): Promise<void> {
	await privateWrite(keyPath, `${key}\n`);
	await fs.chmod(path.dirname(keyPath), 0o700);
}

/**
 * Point the auth-broker token path at the key file. The broker reads the token
 * with readFile, which follows the link, so key rotation needs no omp write.
 * The link is swapped in with rename, replacing a regular-file copy left by an
 * older login atomically.
 */
async function linkBrokerToken(tokenPath: string, keyPath: string): Promise<void> {
	const current = await fs.readlink(tokenPath).catch(() => undefined);
	if (current !== undefined && path.resolve(path.dirname(tokenPath), current) === keyPath) return;
	await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
	const temporary = `${tokenPath}.tmp-${process.pid}`;
	await fs.rm(temporary, { force: true });
	await fs.symlink(keyPath, temporary);
	await fs.rename(temporary, tokenPath);
}

async function prepareBroker(settings: Settings, key: string, paths: SprilicredLoginPaths): Promise<void> {
	const statePath = path.join(paths.home, BROKER_STATE);
	if (!(await exists(statePath))) {
		const currentUrl = cfgAuthBrokerUrl.get(settings);
		const before = currentUrl && !currentUrl.includes("sprilicred") ? currentUrl : undefined;
		const backup = `${paths.tokenPath}.before-sprilicred`;
		const isRegularFile = await fs
			.lstat(paths.tokenPath)
			.then(stat => stat.isFile())
			.catch(() => false);
		if (isRegularFile && !(await exists(backup))) await fs.copyFile(paths.tokenPath, backup);
		await privateWrite(statePath, `${JSON.stringify({ url: before })}\n`);
	}
	await writeKeyFile(paths.keyPath, key);
	await linkBrokerToken(paths.tokenPath, paths.keyPath);
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

	const currentCycle = cfgCycleModels.get(settings);
	if (currentCycle.length === 0) {
		const cycleState = path.join(paths.home, CYCLE_STATE);
		if (!(await exists(cycleState))) await privateWrite(cycleState, `${JSON.stringify({ before: currentCycle })}\n`);
		cfgCycleModels.set(settings, CYCLE_MODELS);
	}

	const currentRoles = cfgModelRoles.get(settings);
	const rolesStatePath = path.join(paths.home, ROLES_STATE);
	const rolesState = (await readJson(rolesStatePath, { roles: {} })) as { roles: Record<string, string> };
	const desired = wantedRoles(models);
	const nextRoles = { ...currentRoles };
	const written: Record<string, string> = {};
	for (const [role, value] of Object.entries(desired)) {
		if (currentRoles[role] === undefined || currentRoles[role] === rolesState.roles?.[role]) {
			nextRoles[role] = value;
			written[role] = value;
		}
	}
	if (Object.keys(written).length > 0) cfgModelRoles.set(settings, nextRoles);
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
	if (/\s/.test(key)) throw new Error("Sprilicred API key must be a single token without whitespace");
	const baseUrl = endpoint();
	const [openai, anthropic] = await Promise.all([
		fetchCatalog(baseUrl, "/v1/models", key),
		fetchCatalog(baseUrl, "/anthropic/v1/models", key),
	]);
	const paths = resolvePaths(pathOverrides);
	await prepareBroker(settings, key, paths);
	const models = await writeModels({ anthropic, openai }, paths);
	await writeOwnedSettings(settings, models, paths);
	process.stdout.write(
		`\nLogged in to Sprilicred; key saved to ${paths.keyPath}; configured ${models.anthropic.length + models.openai.length} models\n`,
	);
}
