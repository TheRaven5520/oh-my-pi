import { Markdown } from "../components/markdown";
import { md, text } from "../native/describe";
import type { NativeChild } from "../native/node";
import { renderStatusLine, truncateToWidth } from "../render";
import { createCachedComponent } from "../render/render-utils";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import { resultText, toolHead } from "./native-view";
import type {
	NativeToolView,
	RenderResultOptions,
	ToolActivityContext,
	ToolActivitySummary,
	ToolRenderer,
	ToolRenderResult,
} from "./renderer";

/** Storage facts returned only after the memory backend accepts a lesson. */
export interface LearnDetails {
	skill: string | null;
	shadowed?: boolean;
	memory: {
		status: "stored" | "queued";
		backend: "local" | "mnemopi" | "hindsight";
		scope: "project" | "global";
	};
	skillOperation?: {
		action: "create" | "update";
		name: string;
		outcome: "created" | "updated" | "failed";
		path?: string;
		error?: string;
	};
}

interface LearnRenderArgs {
	memory?: string;
	context?: string;
	scope?: string;
	skill?: { action?: string; name?: string; description?: string; body?: string };
}

function firstLine(value: unknown): string {
	return typeof value === "string"
		? (value.split(/\r?\n/).find(line => line.trim()) ?? "").trim().replace(/^#{1,6}\s+/, "")
		: "";
}

function storageDetails(result: ToolRenderResult | undefined): LearnDetails | undefined {
	const details = result?.details as LearnDetails | undefined;
	const memory = details?.memory;
	return memory &&
		(memory.status === "stored" || memory.status === "queued") &&
		["local", "mnemopi", "hindsight"].includes(memory.backend) &&
		(memory.scope === "project" || memory.scope === "global")
		? details
		: undefined;
}

function skillRow(args: LearnRenderArgs | undefined, details?: LearnDetails): string | undefined {
	if (details) {
		const skill = details.skillOperation;
		return skill ? `Skill ${skill.outcome} · ${skill.name}` : undefined;
	}
	if (!args?.skill) return undefined;
	const action = firstLine(args.skill.action);
	const name = firstLine(args.skill.name);
	return `Skill requested${action ? ` · ${action}` : ""}${name ? ` · ${name}` : ""}`;
}

function learnActivity(
	args: LearnRenderArgs | undefined,
	context: Pick<ToolActivityContext, "result">,
): ToolActivitySummary {
	const result = context.result;
	const details = storageDetails(result);
	const error = result?.isError || details?.skillOperation?.outcome === "failed";
	const lesson = firstLine(args?.memory);
	const skill = skillRow(args, details);
	return {
		label: "Learn",
		detail: details ? details.memory.status : undefined,
		meta: details ? `${details.memory.backend} · ${details.memory.scope}` : undefined,
		// Historical results retain their raw text: a requested skill is not an observed outcome.
		preview: !error && (!result || details) ? [lesson, skill].filter((row): row is string => !!row) : undefined,
		error: error ? resultText(result!).trim() || details?.skillOperation?.error || "Learn failed" : undefined,
	};
}

interface Section {
	title: string;
	body: string;
	markdown?: boolean;
}

function expandedSections(args: LearnRenderArgs | undefined, result?: ToolRenderResult): Section[] {
	const sections: Section[] = [];
	const output = result && resultText(result).trim();
	if (output) sections.push({ title: "Outcome", body: output });
	if (typeof args?.memory === "string" && args.memory)
		sections.push({ title: "Lesson", body: args.memory, markdown: true });
	if (typeof args?.context === "string" && args.context)
		sections.push({ title: "Context", body: args.context, markdown: true });
	if (args?.scope) sections.push({ title: "Requested scope", body: args.scope });
	const skill = args?.skill;
	if (skill) {
		sections.push({ title: "Requested skill", body: [skill.action, skill.name].filter(Boolean).join(" · ") });
		if (typeof skill.description === "string" && skill.description)
			sections.push({ title: "Description", body: skill.description });
		if (typeof skill.body === "string" && skill.body)
			sections.push({ title: "Skill body", body: skill.body, markdown: true });
	}
	const path = storageDetails(result)?.skillOperation?.path;
	if (path) sections.push({ title: "Skill path", body: path });
	return sections;
}

function describeLearn(
	args: LearnRenderArgs | undefined,
	options: RenderResultOptions,
	result?: ToolRenderResult,
): NativeToolView {
	const summary = learnActivity(args, { result });
	const body: NativeChild[] = [];
	if (options.expanded) {
		for (const section of expandedSections(args, result)) {
			body.push(text(section.title, { tone: "muted" }), section.markdown ? md(section.body) : text(section.body));
		}
	} else {
		const rows = summary.error ? [summary.error] : (summary.preview ?? (result ? [resultText(result)] : []));
		for (const row of rows) body.push(text(row));
	}
	return {
		head: toolHead("Learn", summary.detail, summary.meta),
		body,
		inline: true,
		tone: summary.error ? "error" : undefined,
	};
}

function renderLearn(
	args: LearnRenderArgs | undefined,
	options: RenderResultOptions,
	theme: Theme,
	result?: ToolRenderResult,
) {
	const summary = learnActivity(args, { result });
	let sections: { title: string; content: Markdown }[] | undefined;
	return createCachedComponent(
		() => options.expanded,
		width => {
			const header = renderStatusLine(
				{
					icon: summary.error ? "error" : result ? "success" : "pending",
					title: "Learn",
					meta: [summary.detail, summary.meta].filter((value): value is string => !!value),
				},
				theme,
			);
			const lines = [truncateToWidth(header, width)];
			if (options.expanded) {
				sections ??= expandedSections(args, result).map(section => ({
					title: section.title,
					content: new Markdown(section.body, 0, 0, getMarkdownTheme()),
				}));
				for (const section of sections) {
					lines.push(theme.fg("muted", section.title));
					lines.push(...section.content.render(width));
				}
			} else {
				const rows = summary.error ? [summary.error] : (summary.preview ?? (result ? [resultText(result)] : []));
				for (const row of rows) lines.push(...row.split("\n").map(line => truncateToWidth(line, width)));
			}
			return lines;
		},
	);
}

/** Lesson previews stay compact; expanding preserves all submitted Markdown and actual outcomes. */
export const learnToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	activitySummary: learnActivity,
	renderCall: (args, options, theme) => renderLearn(args, options, theme),
	renderResult: (result, options, theme, args) => renderLearn(args, options, theme, result),
	describeCall: (args, options) => describeLearn(args, options),
	describeResult: (result, options, args) => describeLearn(args, options, result),
} satisfies ToolRenderer<LearnRenderArgs, LearnDetails>;
