import type { Component } from "../index";
import { isRecord } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { NativeToolHead, NativeToolView, RenderResultOptions } from "./renderer";
import { ansi } from "../native/describe";
import { noteText } from "./native-view";
import type { Theme } from "../theme/theme";
import { formatOutputPaneLines, styleToolOutputLine } from "../render/output-pane";
import { renderStatusLine, type StatusLineOptions } from "../render/status-line";
import { plainToolCard, type ToolCardPhase } from "../render/tool-card";
import { truncateToWidth } from "../render/render-utils";
import {
	describeJsonTree,
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { formatExpandHint } from "../render/render-utils";

/** Bounded semantic fields only; arbitrary payloads belong in the expanded body. */
export function defaultToolActivityDetail(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const operation = [value.op, value.operation, value.action].find(
		item =>
			typeof item === "string" &&
			/^(?:get|list|search|read|write|create|update|delete|run|start|stop|status|inspect|open|close|select|rename|query|set|remove|add|check|connect|disconnect)$/.test(
				item,
			),
	);
	let target: string | undefined;
	for (const key of [
		"file",
		"path",
		"url",
		"query",
		"symbol",
		"name",
		"id",
		"session",
		"host",
		"repo",
		"pattern",
	] as const) {
		const item = value[key];
		if (typeof item === "string" && item.trim()) {
			target = item.split("\n", 1)[0];
			break;
		}
	}
	if (operation || target) return [operation, target].filter(Boolean).join(" · ");
	for (const key of ["title", INTENT_FIELD, "command"] as const) {
		const item = value[key];
		if (typeof item === "string" && item.trim()) return item.split("\n", 1)[0];
	}
	return undefined;
}

/** Inputs rendered by the fallback card used when a tool has no bespoke renderer. */
export interface DefaultToolRenderInput {
	/** Human-readable tool label. */
	label: string;
	/** Tool arguments, shown inline when collapsed and as a tree when expanded. */
	args: unknown;
	/** Settled or streaming result; omitted while only the call is available. */
	result?: {
		output: string;
		isError?: boolean;
		/** Synthetic placeholder for a call skipped mid-batch to service steering/peer
		 * input — the tool never ran, so it renders neutral (info) rather than as an error. */
		skipped?: boolean;
	};
	/** Current expansion and lifecycle state. */
	options: RenderResultOptions;
}

/** Header/body assembly shared by the string and Component APIs. */
interface DefaultToolSnapshot {
	status: StatusLineOptions;
	phase: ToolCardPhase;
	body: readonly string[];
}

/** Compute the single header/body assembly behind both default-tool entry points. */
function buildDefaultToolSnapshot(
	input: DefaultToolRenderInput,
	uiTheme: Theme,
	contentWidth: number,
): DefaultToolSnapshot {
	const { options, result } = input;
	const status: StatusLineOptions = {
		icon: options.isPartial
			? options.spinnerFrame !== undefined
				? "running"
				: "pending"
			: result?.skipped
				? "info"
				: result?.isError
					? "error"
					: "done",
		spinnerFrame: options.spinnerFrame,
		title: input.label,
	};
	if (result?.skipped) status.titleColor = "muted";
	const phase: ToolCardPhase = options.isPartial
		? options.spinnerFrame !== undefined
			? "running"
			: "partial"
		: result?.skipped
			? "info"
			: result?.isError
				? "error"
				: "success";

	const body: string[] = [];
	const args = isRecord(input.args) ? input.args : undefined;
	if (!options.expanded && args && Object.keys(args).length > 0) {
		const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(uiTheme.tree.last) - 2);
		const preview = formatArgsInline(args, inlineBudget);
		if (preview) {
			body.push(` ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("dim", preview)}`);
		}
	}

	if (options.expanded && input.args !== undefined) {
		body.push("");
		body.push(uiTheme.fg("dim", "Args"));
		const tree = renderJsonTreeLines(
			input.args,
			uiTheme,
			JSON_TREE_MAX_DEPTH_EXPANDED,
			JSON_TREE_MAX_LINES_EXPANDED,
			JSON_TREE_SCALAR_LEN_EXPANDED,
		);
		body.push(...tree.lines);
		if (tree.truncated) {
			body.push(uiTheme.fg("dim", "…"));
		}
		body.push("");
	}

	if (result) {
		const textContent = result.output.trimEnd();
		if (!textContent) {
			body.push(uiTheme.fg("dim", "(no output)"));
		} else {
			let renderedAsJson = false;
			if (textContent.startsWith("{") || textContent.startsWith("[")) {
				try {
					const parsed = JSON.parse(textContent);
					const maxDepth = options.expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
					const maxLines = options.expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
					const maxScalarLen = options.expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
					const tree = renderJsonTreeLines(parsed, uiTheme, maxDepth, maxLines, maxScalarLen);

					if (tree.lines.length > 0) {
						body.push(...tree.lines);
						if (!options.expanded) {
							body.push(formatExpandHint(uiTheme, options.expanded, true));
						} else if (tree.truncated) {
							body.push(uiTheme.fg("dim", "…"));
						}
						renderedAsJson = true;
					}
				} catch {
					// Non-JSON output that starts with a bracket is rendered as plain text.
				}
			}
			if (!renderedAsJson) {
				body.push(
					...formatOutputPaneLines(
						{
							lines: textContent.split("\n"),
							expanded: options.expanded,
							collapsedMaxLines: 4,
							expandedMaxLines: 12,
							styleLine: line => truncateToWidth(styleToolOutputLine(line, uiTheme), contentWidth),
							showExpandHintWhenUncapped: true,
						},
						uiTheme,
					).lines,
				);
			}
		}
	}

	return { status, phase, body };
}

/** Format one generic tool call/result card at the available content width. */
export function formatDefaultToolExecution(
	input: DefaultToolRenderInput,
	contentWidth: number,
	uiTheme: Theme,
): string {
	const snapshot = buildDefaultToolSnapshot(input, uiTheme, Math.max(1, contentWidth - 2));
	return [
		truncateToWidth(renderStatusLine(snapshot.status, uiTheme), contentWidth),
		...snapshot.body.map(line => `  ${line}`),
	].join("\n");
}

/** Result text kept for the native card body. */
const NATIVE_RESULT_MAX_CHARS = 64 * 1024;

/**
 * TSP view of the generic fallback card: the tool label with a semantic
 * operation/target; the result as a JSON tree or raw `ansi` output.
 */
export function describeDefaultToolExecution(input: DefaultToolRenderInput): NativeToolView {
	const { result } = input;
	const summary = defaultToolActivityDetail(input.args);
	const tool: NativeToolHead = { title: input.label, target: summary, targetKind: "text" };
	const argsBody =
		isRecord(input.args) && Object.keys(input.args).length ? [noteText("Args"), describeJsonTree(input.args)] : [];
	if (!result) return { tool, body: argsBody, preview: "none" };
	const output = result.output.trimEnd().slice(0, NATIVE_RESULT_MAX_CHARS);
	const tone = result.skipped ? "info" : result.isError ? "error" : undefined;
	if (!output) return { tool, tone, body: [noteText("(no output)"), ...argsBody] };
	if (output.startsWith("{") || output.startsWith("[")) {
		try {
			return { tool, tone, body: [describeJsonTree(JSON.parse(output)), ...argsBody] };
		} catch {
			// Not JSON: shown as raw output below.
		}
	}
	return { tool, tone, body: [ansi(output), ...argsBody] };
}

/** Render the generic fallback as the state-tinted card used by direct custom tools. */
export function renderDefaultToolExecution(input: DefaultToolRenderInput, uiTheme: Theme): Component {
	return plainToolCard(
		uiTheme,
		({ contentWidth }) => {
			const snapshot = buildDefaultToolSnapshot(input, uiTheme, contentWidth);
			return { status: snapshot.status, phase: snapshot.phase, body: snapshot.body };
		},
		{ paddingX: 1, paddingY: 1, ignoreTight: true },
	);
}
