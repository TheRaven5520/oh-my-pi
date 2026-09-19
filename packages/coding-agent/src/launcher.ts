#!/usr/bin/env bun

import { isSupervisedChildProcess, LAUNCHER_OWNS_CLI_ENV, runProcessSupervisor } from "./process-supervisor";

const isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true";

async function runLauncher(): Promise<void> {
	if (process.env.PI_COMPILED === "true") {
		// Expose the build-time flag to helpers that receive an environment object.
		Bun.env["PI_COMPILED"] = "true";
	}
	if (isSupervisedChildProcess()) {
		// Suppress cli.ts's compiled-entry auto-run: this launcher owns the main
		// thread call, while worker threads retain cli.ts's worker dispatch.
		// Intentional lazy process boundary: a static import would retain the
		// complete CLI module graph in the permanent supervisor process.
		process.env[LAUNCHER_OWNS_CLI_ENV] = "true";
		const cli = await import("./cli");
		if (Bun.isMainThread) await cli.runCli(process.argv.slice(2));
		return;
	}

	if (!Bun.isMainThread) {
		// A source-mode Worker may target the launcher directly without an IPC
		// supervisor. cli.ts owns worker-thread dispatch in that case.
		// Same lazy boundary for source Workers that enter through this file.
		await import("./cli");
		return;
	}

	process.title = "omp-supervisor";
	process.exitCode = await runProcessSupervisor();
}

if (isProcessEntry || !Bun.isMainThread) {
	runLauncher().catch((error: unknown) => {
		process.stderr.write(`${Bun.inspect(error, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	});
}
