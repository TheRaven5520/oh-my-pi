import { plainText } from "../native/spans";

const COMMAND_ACTIONS: Readonly<Record<string, string>> = {
	"git.sync": "Syncing git repo",
	test: "Running tests",
	build: "Building project",
	inspect: "Inspecting state",
	run: "Running command",
};

/** Explicit display labels never change execution or approval arguments. */
export function resolveCommandTitle(title: unknown): string | undefined {
	if (typeof title !== "string") return undefined;
	const text = plainText(title).trim().replace(/\s+/gu, " ");
	return text ? (Object.hasOwn(COMMAND_ACTIONS, text) ? COMMAND_ACTIONS[text] : text) : undefined;
}

/** Recognize only a bounded, single literal invocation, not shell programs or wrappers. */
export function inferCommandTitle(command: string | undefined): string | undefined {
	if (!command || command.length > 4096 || /[$`\\\n\r;&|<>()*?{}[\]~]/u.test(command)) return undefined;
	if (!/^[ \t]*(?:[^\s"']+|"[^"\n]*"|'[^'\n]*')(?:[ \t]+(?:[^\s"']+|"[^"\n]*"|'[^'\n]*'))*[ \t]*$/u.test(command)) {
		return undefined;
	}
	const words = command.trim().match(/[^\s"']+|"[^"]*"|'[^']*'/gu)!;
	const [program, action, script] = words;
	if (program === "git") {
		if (action === "push" || action === "pull" || action === "commit") return COMMAND_ACTIONS["git.sync"];
		if (action === "status" || action === "diff" || action === "log") return "Inspecting repo";
	}
	if (
		program === "pytest" ||
		((program === "python" || program === "python3") && action === "-m" && script === "pytest")
	) {
		return COMMAND_ACTIONS.test;
	}
	if (program === "bun" || program === "npm" || program === "pnpm" || program === "yarn" || program === "cargo") {
		const operation = action === "run" && program !== "cargo" ? script : action;
		if (operation === "test" || (program === "npm" && operation === "t")) return COMMAND_ACTIONS.test;
		if (operation === "build") return COMMAND_ACTIONS.build;
	}
	return undefined;
}
