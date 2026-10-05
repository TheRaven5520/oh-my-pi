/**
 * Friendly model names for display: `claude-opus-5-5`,
 * `sprilicred-anthropic/claude-opus-5-5:low`, `claude-opus-5-5 via Sprilicred`
 * and `Claude Opus 5.5` all read `Opus 5.5`. Only the claude/gpt/gemini id
 * families are rewritten; any other id is shown as-is rather than guessed at.
 */
import { parseThinkingLevel } from "../thinking";

export interface ModelNameOptions {
	/** Keep a trailing `via <provider>` (the model picker names where a model comes from). */
	keepVia?: boolean;
	/**
	 * What the text is. Default: a bare `Model.name` or `Model.id`, where a `/`
	 * belongs to the id (`z-ai/glm-5.2` on OpenRouter) and a `:max` tail is part
	 * of it. `identity`: a `provider/id` reference; the provider (up to the first
	 * `/`) is dropped. `selector`: a `provider/id[:level]` selector; the provider
	 * and an exact thinking-level suffix are dropped.
	 */
	ref?: "identity" | "selector";
}

/** `provider/id:level` → the model part and, when the suffix is exactly a thinking level, that level. */
export function splitModelSelector(selector: string): { model: string; level?: string } {
	const colon = selector.lastIndexOf(":");
	if (colon < 0) return { model: selector };
	const suffix = selector.slice(colon + 1).toLowerCase();
	// Model ids can contain colons (`qwen3:14b`): only an exact level name counts.
	return parseThinkingLevel(suffix) === suffix
		? { model: selector.slice(0, colon), level: suffix }
		: { model: selector };
}

const capitalize = (word: string): string => (word ? word[0]!.toUpperCase() + word.slice(1) : word);

/** Dated snapshot suffixes (`-20250929`, `-2024-05-13`) and `-latest` carry no display meaning. */
const SNAPSHOT_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

/** The vendor name for a claude/gpt/gemini id (its last `/` segment), or the whole id unchanged. */
function prettifyId(id: string): string {
	const base = id
		.slice(id.lastIndexOf("/") + 1)
		.toLowerCase()
		.replace(SNAPSHOT_SUFFIX, "");
	// claude-opus-5-5, claude-sonnet-4, claude-haiku-4-5
	let match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(base);
	if (match) return `${capitalize(match[1]!)} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
	// claude-3-5-sonnet (older ordering)
	match = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)$/.exec(base);
	if (match) return `${capitalize(match[3]!)} ${match[1]}${match[2] ? `.${match[2]}` : ""}`;
	// gpt-6-astra, gpt-5.6-sol, gpt-5.1-codex-max, gpt-4o-mini
	match = /^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-[a-z0-9.]+)*)$/.exec(base);
	if (match) {
		const rest = match[2]!.split("-").filter(Boolean).map(capitalize).join(" ");
		return `GPT-${match[1]}${rest ? ` ${rest}` : ""}`;
	}
	// gemini-2.5-pro, gemini-3-pro-preview. Each repetition needs its `-`, so a
	// non-matching id (`…:free`) fails in linear time instead of backtracking.
	match = /^gemini-([a-z0-9.]+(?:-[a-z0-9.]+)*)$/.exec(base);
	if (match) return `Gemini ${match[1]!.split("-").filter(Boolean).map(capitalize).join(" ")}`;
	return id;
}

/**
 * The display name and, when one was read off the text, its thinking level.
 * A selector-shaped text (`provider/claude-opus-5-5:xhigh`) of a known family
 * reads as that family's name whatever `ref` says, so a raw selector reaching
 * any caller still shows `Opus 5.5`; an unfamiliar id keeps its rules below.
 */
function parseModelName(text: string, options: ModelNameOptions): { name: string; level?: string } {
	let name = text.trim();
	const via = /\s+via\s+(\S.*)$/i.exec(name);
	if (via) name = name.slice(0, via.index).trim();
	let suffix = options.keepVia && via ? ` via ${via[1]}` : "";
	// `claude-opus-5-5 (personal)`: a configured name's own note on where the model comes from.
	const note = !via ? /^(\S+)\s+\(([^()]+)\)$/.exec(name) : null;
	if (note && prettifyId(note[1]!) !== note[1]) {
		name = note[1]!;
		if (options.keepVia) suffix = ` (${note[2]!.trim()})`;
	}
	// Already a display name (`Claude Opus 4.5`, `Gemini 2.5 Pro`): only drop the vendor word.
	if (/\s/.test(name)) return { name: `${name.replace(/^Claude\s+/, "")}${suffix}` };
	const selector = splitModelSelector(name);
	if (options.ref === "selector") name = selector.model;
	if (options.ref) name = name.slice(name.indexOf("/") + 1);
	const pretty = prettifyId(name);
	if (pretty !== name || !selector.level) return { name: `${pretty}${suffix}` };
	// A known family behind a provider and/or a level suffix the caller did not say to expect.
	const family = prettifyId(selector.model);
	return family !== selector.model
		? { name: `${family}${suffix}`, level: selector.level }
		: { name: `${pretty}${suffix}` };
}

/** The display name for a model name or id, or a `provider/id[:level]` reference (see {@link ModelNameOptions.ref}). */
export function formatModelName(text: string, options: ModelNameOptions = {}): string {
	return parseModelName(text, options).name;
}

/** A thinking level worth showing: a known level other than `off`/`inherit`, or `auto`. */
export function shownThinkingLevel(level: string | undefined): string | undefined {
	if (!level || level === "off" || level === "inherit") return undefined;
	return level === "auto" || parseThinkingLevel(level) === level ? level : undefined;
}

/**
 * `Opus 5.5 (low)`: the display name plus the thinking level. The level comes
 * from `level`, or else (for a `selector` reference) its `:level` suffix;
 * unknown levels and `off`/`inherit` are left out.
 */
export function formatModelLabel(text: string, level?: string, options: ModelNameOptions = {}): string {
	const parsed = parseModelName(text, options);
	const shown = shownThinkingLevel(
		level ?? (options.ref === "selector" ? splitModelSelector(text.trim()).level : parsed.level),
	);
	return shown ? `${parsed.name} (${shown})` : parsed.name;
}
