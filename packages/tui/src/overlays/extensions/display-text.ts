/**
 * Untrusted display strings for `/extensions`.
 *
 * MCP `serverInfo`, tool/resource/prompt catalogs, custom-tool schemas, and
 * discovered file content can carry ANSI, OSC/BEL, C0/C1 controls, or tabs.
 * Theme helpers wrap whatever they are given, so those sequences must be
 * stripped *before* SGR is applied.
 */
import { replaceTabs } from "../../utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Strip ANSI/C0/C1/malformed unicode, then expand tabs. Call before theming. */
export function sanitizeDisplayText(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** Collapse newlines to spaces so a hostile title cannot inject extra TUI rows (no trimming). */
export function sanitizeDisplaySingleLine(text: string): string {
	return sanitizeDisplayText(text).replace(/[\r\n]+/g, " ");
}

/** Single-line terminal text retaining only SGR styling, never OSC links or terminal commands. */
export function sanitizeDisplaySgrLine(text: string): string {
	// Remove string controls as a unit, including SGR-looking text inside their payloads.
	const withoutStrings = text.replace(/(?:\x1b[\]P^_X]|[\x90\x98\x9d-\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "");
	let result = "";
	let offset = 0;
	for (const match of withoutStrings.matchAll(/\x1b\[[0-9;:]*m/g)) {
		result += sanitizeDisplaySingleLine(withoutStrings.slice(offset, match.index)) + match[0];
		offset = match.index + match[0].length;
	}
	return result + sanitizeDisplaySingleLine(withoutStrings.slice(offset));
}

/** Collapse newlines so a hostile title cannot inject extra TUI rows. */
export function sanitizeDisplayLine(text: string): string {
	return sanitizeDisplaySingleLine(text).trim();
}

/** Like {@link sanitizeDisplayText}, dropping empty results. */
export function sanitizeDisplayField(text: string | undefined | null): string | undefined {
	if (typeof text !== "string" || text.length === 0) return undefined;
	const cleaned = sanitizeDisplayText(text);
	return cleaned.length > 0 ? cleaned : undefined;
}

/** Like {@link sanitizeDisplayLine}, dropping empty results. */
export function sanitizeDisplayLineField(text: string | undefined | null): string | undefined {
	if (typeof text !== "string" || text.length === 0) return undefined;
	const cleaned = sanitizeDisplayLine(text);
	return cleaned.length > 0 ? cleaned : undefined;
}
