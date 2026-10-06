import { register } from "../config/registry";

export const cfgGoalEnabled = register({
	id: "goal.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Mode",
		description: "Enable per-session goal mode and the hidden goal tool",
	},
});

export const cfgGoalStatusInFooter = register({
	id: "goal.statusInFooter",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Status in Footer",
		description: "Show token budget alongside the goal indicator in the status line",
	},
});

const GOAL_CONTINUATION_MODES_DEFAULT: string[] = ["interactive"];

export const cfgGoalContinuationModes = register({
	id: "goal.continuationModes",
	type: "array",
	default: GOAL_CONTINUATION_MODES_DEFAULT,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Continuation Modes",
		description: 'Run modes where active goals may auto-continue between turns ("interactive", "rpc")',
	},
});

export const cfgTitleStyle = register({
	id: "title.style",
	type: "enum",
	values: ["tag", "sentence"] as const,
	default: "sentence",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Session Title Style",
		description:
			"tag: a one- or two-word ALL-CAPS label (e.g. SPRILICRED) renamed only when the work lastingly changes. sentence: a ~5-word title from the first message, refreshed on replans.",
	},
});

export const cfgTitleRefreshOnReplan = register({
	id: "title.refreshOnReplan",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Refresh Title on Replan",
		description:
			"Refresh generated sentence-style titles after todo init replans unless the title was set by the user (tag titles use their own sparse checks)",
	},
});
