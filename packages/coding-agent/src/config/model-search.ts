/**
 * Provider `modelSearch` (models.yml): the /model browser queries a gateway's
 * `{baseUrl}/models?{param}=<query>&limit={limit}` and the person adds the rows
 * they pick to that provider's `models`. Rows parse exactly like
 * `openai-models-list` discovery; picked entries are written from an explicit
 * allow-list so no resolved credential ever reaches models.yml.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { JSONC, YAML } from "bun";
import { advertisedEfforts, type DiscoveryContext, discoverOpenAIModelsList } from "./model-discovery";
import type { ProviderAuthMode, ProviderModelSearch } from "./models-config-schema";

/** A models.yml provider that offers in-picker search. */
export interface ModelSearchProviderConfig {
	provider: string;
	api: Api;
	baseUrl: string;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	auth?: ProviderAuthMode;
	modelSearch: ProviderModelSearch;
}

/** USD per million tokens from a SpriliCred integer microcredits-per-token price, as the installer writes it. */
function microcreditsPerMillion(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value / 1000 : undefined;
}

/**
 * The agreed models.yml entry for a listing row (same keys, order and values
 * as the installer and `omp login sprilicred` write): id; name
 * "<display_name> via SpriliCred"; contextWindow; maxTokens; reasoning (only
 * when the row says); thinking {mode "effort", the row's known efforts in
 * omp's order} when it reasons and lists some; input; cost in $/MTok. No compat.
 */
function rowEntry(id: string, row: Record<string, unknown>): Record<string, unknown> {
	const displayName = typeof row.display_name === "string" ? row.display_name.trim() : "";
	const entry: Record<string, unknown> = { id, name: `${displayName || id} via SpriliCred` };
	const contextWindow = row.context_window ?? row.context_length;
	if (typeof contextWindow === "number" && contextWindow > 0) entry.contextWindow = contextWindow;
	if (typeof row.max_output_tokens === "number" && row.max_output_tokens > 0) entry.maxTokens = row.max_output_tokens;
	if (typeof row.supports_reasoning === "boolean") entry.reasoning = row.supports_reasoning;
	const efforts = row.supports_reasoning === true ? advertisedEfforts(row.reasoning_efforts) : undefined;
	if (efforts) entry.thinking = { mode: "effort", efforts };
	const modalities = row.input_modalities;
	if (Array.isArray(modalities) && modalities.includes("text")) {
		entry.input = modalities.includes("image") ? ["text", "image"] : ["text"];
	}
	const pricing = row.pricing;
	if (isRecord(pricing) && pricing.unit === "microcredits_per_token") {
		const cost = {
			input: microcreditsPerMillion(pricing.input),
			output: microcreditsPerMillion(pricing.output),
			cacheRead: microcreditsPerMillion(pricing.cache_read ?? 0),
			cacheWrite: microcreditsPerMillion(pricing.cache_write ?? pricing.cache_write_5m ?? 0),
		};
		if (Object.values(cost).every(value => value !== undefined)) entry.cost = cost;
	}
	return entry;
}

/** A search hit: the parsed model (for display and selection) and the exact models.yml entry a pick writes. */
export interface ModelSearchResult {
	model: Model<Api>;
	entry: Record<string, unknown>;
}

/**
 * Query a provider's search listing; rows parse with the `openai-models-list`
 * discovery parser. Rows the listing marks as non-chat tasks (embeddings,
 * images) come back on another API and are dropped: they cannot serve as chat
 * models of this provider. Each model is named as its models.yml entry. The
 * entry is built from the row's own fields, never from the parsed Model, whose
 * request headers include the resolved bearer.
 */
export async function searchProviderModels(
	config: ModelSearchProviderConfig,
	ctx: DiscoveryContext,
	query: string,
	signal?: AbortSignal,
): Promise<ModelSearchResult[]> {
	const entries = new Map<string, Record<string, unknown>>();
	const models = await discoverOpenAIModelsList(
		{
			provider: config.provider,
			api: config.api,
			baseUrl: config.baseUrl,
			headers: config.headers,
			compat: config.compat,
			auth: config.auth,
			// The listing lives at `<baseUrl>/models` verbatim (no `/v1` injection).
			discovery: { type: "openai-models-list", injectV1: false },
		},
		ctx,
		{
			searchParams: { [config.modelSearch.param]: query, limit: String(config.modelSearch.limit) },
			signal,
			onRow: (id, row) => entries.set(id, rowEntry(id, row)),
		},
	);
	const results: ModelSearchResult[] = [];
	for (const model of models) {
		const entry = entries.get(model.id);
		if (model.api !== config.api || !entry) continue;
		results.push({ model: { ...model, name: entry.name as string }, entry });
	}
	return results;
}

/**
 * Append `entry` to `providers[provider].models` in the models config at
 * `configPath`. The file is re-read and rewritten under the same `withFileLock`
 * other omp config writers use, so another omp process's change in between is
 * kept (writers that skip the lock, such as the installer, are not covered).
 * Resolves false (and writes nothing) when the id is already listed. The file
 * is rewritten from its parsed form: a file holding JSON stays JSON, and YAML
 * comments are not kept. The write is atomic (temp file + rename).
 */
export async function appendSearchedModel(
	configPath: string,
	provider: string,
	entry: Record<string, unknown>,
): Promise<boolean> {
	const targetPath = fs.realpathSync(configPath);
	return withFileLock(targetPath, async () => {
		const raw = fs.readFileSync(targetPath, "utf-8");
		const isJson = raw.trimStart().startsWith("{");
		const config = (isJson ? JSONC.parse(raw) : YAML.parse(raw)) as {
			providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
		} | null;
		const providerConfig = config?.providers?.[provider];
		if (!config || !providerConfig) {
			throw new Error(`Provider ${provider} is no longer configured in ${configPath}`);
		}
		const models = providerConfig.models ?? [];
		if (models.some(existing => existing.id === entry.id)) return false;
		providerConfig.models = [...models, entry];
		const content = isJson ? `${JSON.stringify(config, null, 2)}\n` : `${YAML.stringify(config, null, 2)}\n`;
		const tmpPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.tmp`);
		const mode = fs.statSync(targetPath).mode & 0o777;
		fs.writeFileSync(tmpPath, content, { mode });
		fs.renameSync(tmpPath, targetPath);
		return true;
	});
}
