/**
 * Shared helpers for tool-rendered UI components.
 */
import { TERMINAL } from "../terminal-capabilities";
import type { Theme, ThemeBg } from "../theme/theme";
import { padding, truncateToWidth, visibleWidth } from "../utils";
import type { State } from "./types";

const SGR = /\x1b\[([0-9;:]*)m/g;

/** Preserve combined PTY foreground/style parameters while removing nested fills. */
function withoutBackground(sequence: string, parameters: string): string {
	const tokens = parameters.split(";");
	const retained: string[] = [];
	let changed = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		const colon = token.indexOf(":");
		const code = Number(colon < 0 ? token : token.slice(0, colon));
		let end = index;
		// Semicolon extended colors consume their channels, which may themselves
		// equal background opcodes. Colon forms are already one complete token.
		if (colon < 0 && (code === 38 || code === 48 || code === 58)) {
			const mode = tokens[index + 1];
			if (mode !== "2" && mode !== "5") return sequence;
			end += mode === "2" ? 4 : 2;
			if (end >= tokens.length) return sequence;
		}
		if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107)) {
			changed = true;
		} else {
			for (let keep = index; keep <= end; keep++) retained.push(tokens[keep]!);
		}
		index = end;
	}
	return changed ? (retained.length > 0 ? `\x1b[${retained.join(";")}m` : "") : sequence;
}

/** Paint one expanded tool surface, discarding outer renderer padding first. */
export function expandedToolRows(
	theme: Theme,
	rows: readonly string[],
	width: number,
	allocation = Number.POSITIVE_INFINITY,
): string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && !rows[start]!.trim()) start++;
	while (end > start && !rows[end - 1]!.trim()) end--;
	const painted: string[] = [];
	for (let index = start; index < end; index++) {
		const row = rows[index]!;
		// Image.render reserves height with reset-only rows. Painting those or
		// padding a placement line can overwrite direct-placement graphics.
		painted.push(
			row === "\x1b[0m" || TERMINAL.isImageLine(row)
				? row
				: theme.bgFill("toolExpandedBg", padToWidth(row.replace(SGR, withoutBackground), width)),
		);
	}
	if (painted.length > 0 && painted.length < allocation) painted.push(theme.bgFill("toolExpandedBg", padding(width)));
	return painted;
}

/** Cached typed-array scratch space for hashing non-string primitives. */
const hashBuf = new ArrayBuffer(8);
const hashView = new DataView(hashBuf);
const hashBytes1 = new Uint8Array(hashBuf, 0, 1);
const hashBytes4 = new Uint8Array(hashBuf, 0, 4);
const hashBytes8 = new Uint8Array(hashBuf, 0, 8);

/**
 * Incremental xxHash64 key builder.
 *
 * Chains `Bun.hash.xxHash64` calls via seeding — each fed value
 * mixes into the running hash without intermediate string allocations.
 * Accepts strings, numbers (u32), booleans, bigints, and `undefined`/`null`
 * (hashed as a sentinel byte) natively.
 */
export class Hasher {
	#h = 0n;

	/** Feed a string. */
	str(s: string): this {
		hashView.setUint32(0, s.length);
		this.#h = Bun.hash.xxHash64(hashBytes4, this.#h);
		this.#h = Bun.hash.xxHash64(s, this.#h);
		return this;
	}

	/** Feed an unsigned 32-bit integer. */
	u32(n: number): this {
		hashView.setUint32(0, n);
		this.#h = Bun.hash.xxHash64(hashBytes4, this.#h);
		return this;
	}

	/** Feed a 64-bit bigint. */
	u64(n: bigint): this {
		hashView.setBigUint64(0, n);
		this.#h = Bun.hash.xxHash64(hashBytes8, this.#h);
		return this;
	}

	/** Feed a boolean (single byte: 1 = true, 0 = false). */
	bool(b: boolean): this {
		hashView.setUint8(0, b ? 1 : 0);
		this.#h = Bun.hash.xxHash64(hashBytes1, this.#h);
		return this;
	}

	/** Feed a value that may be `undefined` or `null` (hashed as a 0xFF sentinel byte). */
	optional(v: string | undefined | null): this {
		if (v == null) {
			hashView.setUint8(0, 0xff);
			this.#h = Bun.hash.xxHash64(hashBytes1, this.#h);
		} else {
			this.#h = Bun.hash.xxHash64(v, this.#h);
		}
		return this;
	}

	/** Return the final hash digest. */
	digest(): bigint {
		return this.#h;
	}
}

/** Render-cache entry used by tool renderers. */
export interface RenderCache {
	key: bigint;
	lines: string[];
}

/** Build indentation and continuing branches for ancestor levels. */
export function buildTreePrefix(ancestors: boolean[], theme: Theme): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

/** Return the branch glyph for a final or continuing tree item. */
export function getTreeBranch(isLast: boolean, theme: Theme): string {
	return isLast ? theme.tree.last : theme.tree.branch;
}

/** Return the continuation prefix for subsequent lines of a tree item. */
export function getTreeContinuePrefix(isLast: boolean, theme: Theme): string {
	return isLast ? "   " : `${theme.tree.vertical}  `;
}

/** Pad or truncate visible text to exactly `width` columns and optionally apply a background. */
export function padToWidth(text: string, width: number, bgFn?: (s: string) => string): string {
	if (width <= 0) return bgFn ? bgFn(text) : text;
	const w = visibleWidth(text);
	if (w === width) return bgFn ? bgFn(text) : text;
	const fitted = w < width ? text + padding(width - w) : truncateToWidth(text, width);
	const drift = width - visibleWidth(fitted);
	const padded = drift > 0 ? fitted + padding(drift) : fitted;
	return bgFn ? bgFn(padded) : padded;
}

/** Resolve a tool output state to its background color token. */
export function getStateBgColor(state: State): ThemeBg {
	if (state === "success") return "toolSuccessBg";
	if (state === "error") return "toolErrorBg";
	return "toolPendingBg";
}
