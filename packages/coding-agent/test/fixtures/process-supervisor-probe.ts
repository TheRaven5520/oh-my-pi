import {
	isSupervisedChildProcess,
	requestSupervisedRefresh,
	runProcessSupervisor,
	SUPERVISED_REFRESH_EXIT_CODE,
	WRAPPER_ALLOW_HOME_ARG,
} from "../../src/process-supervisor";

const args = process.argv.slice(2);
const commandArgs = args[0] === WRAPPER_ALLOW_HOME_ARG ? args.slice(1) : args;

if (!isSupervisedChildProcess()) {
	process.exitCode = await runProcessSupervisor();
} else if (commandArgs[0] === "initial") {
	process.stdout.write(`${JSON.stringify({ phase: "initial", pid: process.pid, ppid: process.ppid })}\n`);
	const sent = await requestSupervisedRefresh("/tmp/omp-supervisor-probe.jsonl", process.cwd());
	process.exit(sent ? SUPERVISED_REFRESH_EXIT_CODE : 2);
} else {
	process.stdout.write(
		`${JSON.stringify({
			phase: "refreshed",
			pid: process.pid,
			ppid: process.ppid,
			args,
			internalRefresh: process.env.OMP_INTERNAL_REFRESH,
		})}\n`,
	);
}
