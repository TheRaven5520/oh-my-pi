import path from "node:path";
import { isCompiledSource } from "./process-supervisor";

/** Inputs kept injectable so the refresh handoff can be tested without spawning. */
export interface RefreshInvocationSource {
	execPath: string;
	execArgv: readonly string[];
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
}

export interface RefreshInvocation {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	sessionFile: string;
}

/**
 * Relaunch the exact CLI runtime against the current durable session.
 *
 * The compiled binary has no script argument, whereas source/npm Bun launches
 * do. `PI_COMPILED` is define-folded into release binaries, so it is the
 * reliable distinction; guessing from argv would mistake a positional prompt
 * for a source entrypoint. Profile and configuration environment selected
 * during bootstrap remain in the inherited environment.
 */
export function buildRefreshInvocation(
	sessionFile: string,
	source: RefreshInvocationSource = process,
): RefreshInvocation {
	if (!path.isAbsolute(sessionFile)) {
		throw new Error("Cannot refresh an in-memory session");
	}
	const compiled = isCompiledSource(source);
	const launcher = source.env.OMP_REFRESH_COMMAND;
	const entrypoint = !compiled && source.argv[1] ? [source.argv[1]] : [];
	return {
		sessionFile,
		// The source-development launcher deliberately starts Bun from a clean
		// directory before its preload restores the user cwd. Re-enter it when
		// available instead of bypassing that safety boundary with bare Bun.
		command: launcher || source.execPath,
		args: launcher
			? ["--resume", sessionFile]
			: [...(compiled ? [] : source.execArgv), ...entrypoint, "--resume", sessionFile],
		// Mark this purely for diagnostics and future handoff-safe subsystems;
		// it deliberately carries no secret or session payload.
		env: { ...source.env, OMP_INTERNAL_REFRESH: "true" },
	};
}
