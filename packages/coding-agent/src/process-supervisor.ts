import path from "node:path";

export const SUPERVISOR_CHILD_ENV = "OMP_SUPERVISOR_CHILD";
export const LAUNCHER_OWNS_CLI_ENV = "OMP_LAUNCHER_OWNS_CLI";
export const SUPERVISOR_SPAWN_CWD_ENV = "OMP_SUPERVISOR_SPAWN_CWD";
export const SUPERVISED_REFRESH_EXIT_CODE = 75;
export const WRAPPER_ALLOW_HOME_ARG = "__omp_wrapper_allow_home";
export const WRAPPER_ALLOW_HOME_KEY = Symbol.for("omp.wrapperAllowsHome");

const REFRESH_MESSAGE_TYPE = "omp-refresh";
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] =
	process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];

type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
const PROCESS_IPC_SEND: IpcSend | undefined = (process as NodeJS.Process & { send?: IpcSend }).send;

export interface SupervisedRefreshRequest {
	type: typeof REFRESH_MESSAGE_TYPE;
	sessionFile: string;
	cwd: string;
}

export interface SupervisorInvocationSource {
	execPath: string;
	execArgv: readonly string[];
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
}

export function isSupervisedChildProcess(
	env: NodeJS.ProcessEnv = process.env,
	sender: IpcSend | undefined = PROCESS_IPC_SEND,
): boolean {
	return env[SUPERVISOR_CHILD_ENV] === "true" && sender !== undefined;
}

export function isSupervisedRefreshRequest(value: unknown): value is SupervisedRefreshRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<SupervisedRefreshRequest>;
	return (
		request.type === REFRESH_MESSAGE_TYPE &&
		typeof request.sessionFile === "string" &&
		path.isAbsolute(request.sessionFile) &&
		typeof request.cwd === "string" &&
		path.isAbsolute(request.cwd)
	);
}

/** Ask the stable launcher parent to replace this child after shutdown. */
export async function requestSupervisedRefresh(sessionFile: string, cwd: string): Promise<boolean> {
	const sender = PROCESS_IPC_SEND;
	if (!sender || !isSupervisedChildProcess(process.env, sender)) return false;
	if (!path.isAbsolute(sessionFile) || !path.isAbsolute(cwd)) return false;

	const { promise, resolve } = Promise.withResolvers<boolean>();
	try {
		sender.call(
			process,
			{ type: REFRESH_MESSAGE_TYPE, sessionFile, cwd } satisfies SupervisedRefreshRequest,
			error => {
				resolve(error == null);
			},
		);
	} catch {
		resolve(false);
	}
	return await promise;
}

/** Re-enter the same source entrypoint, or the same compiled executable. */
export function buildSupervisedChildCommand(source: SupervisorInvocationSource = process): string[] {
	const compiled = source.env.PI_COMPILED === "true";
	const entrypoint = !compiled && source.argv[1] ? [source.argv[1]] : [];
	return [source.execPath, ...(compiled ? [] : source.execArgv), ...entrypoint, ...source.argv.slice(2)];
}

/**
 * Keep one small parent between the interactive shell and the replaceable CLI.
 * The shell waits on this process for the whole session lifetime; every refresh
 * replaces only its child, so process depth and retained memory stay constant.
 */
export async function runProcessSupervisor(source: SupervisorInvocationSource = process): Promise<number> {
	const command = buildSupervisedChildCommand(source);
	let argv = command.slice(command.length - source.argv.slice(2).length);
	const wrapperAllowsHome = argv[0] === WRAPPER_ALLOW_HOME_ARG;
	const commandPrefix = command.slice(0, command.length - argv.length);
	let childCwd = process.cwd();
	let refreshed = source.env.OMP_INTERNAL_REFRESH === "true";
	let child: Bun.Subprocess | undefined;

	const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
	for (const signal of FORWARDED_SIGNALS) {
		const handler = (): void => {
			try {
				child?.kill(signal);
			} catch {}
		};
		signalHandlers.push([signal, handler]);
		process.on(signal, handler);
	}

	try {
		for (;;) {
			let refreshRequest: SupervisedRefreshRequest | undefined;
			const env: NodeJS.ProcessEnv = {
				...source.env,
				[SUPERVISOR_CHILD_ENV]: "true",
				[LAUNCHER_OWNS_CLI_ENV]: "true",
				OMP_LAUNCH_CWD: childCwd,
			};
			if (refreshed) env.OMP_INTERNAL_REFRESH = "true";
			else delete env.OMP_INTERNAL_REFRESH;

			const spawnCwd =
				source.env.PI_COMPILED === "true" ? childCwd : source.env[SUPERVISOR_SPAWN_CWD_ENV] || childCwd;
			child = Bun.spawn({
				cmd: [...commandPrefix, ...argv],
				cwd: spawnCwd,
				env,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
				serialization: "advanced",
				ipc(message) {
					if (!refreshRequest && isSupervisedRefreshRequest(message)) refreshRequest = message;
				},
			});

			const exitCode = await child.exited;
			child = undefined;
			if (exitCode !== SUPERVISED_REFRESH_EXIT_CODE || !refreshRequest) return exitCode;

			argv = [...(wrapperAllowsHome ? [WRAPPER_ALLOW_HOME_ARG] : []), "--resume", refreshRequest.sessionFile];
			childCwd = refreshRequest.cwd;
			refreshed = true;
		}
	} finally {
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
		if (child) {
			try {
				child.kill();
			} catch {}
		}
	}
}
