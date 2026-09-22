import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	WRAPPER_ALLOW_HOME_ARG,
	buildSupervisedChildCommand,
	isSupervisedRefreshRequest,
} from "../src/process-supervisor";

const PROBE = path.join(import.meta.dir, "fixtures", "process-supervisor-probe.ts");

describe("process supervisor", () => {
	test("re-enters source and compiled launchers with the original arguments", () => {
		expect(
			buildSupervisedChildCommand({
				execPath: "/usr/bin/bun",
				execArgv: ["--preload", "/repo/preload.ts"],
				argv: ["bun", "/repo/launcher.ts", "--model", "test"],
				env: {},
			}),
		).toEqual(["/usr/bin/bun", "--preload", "/repo/preload.ts", "/repo/launcher.ts", "--model", "test"]);

		expect(
			buildSupervisedChildCommand({
				execPath: "/opt/omp",
				execArgv: ["--user-agent=omp/18.2.9"],
				argv: ["/opt/omp", "ignored-placeholder", "--help"],
				env: { PI_COMPILED: "true" },
			}),
		).toEqual(["/opt/omp", "--help"]);
	});

	test("accepts only absolute refresh handoffs", () => {
		expect(isSupervisedRefreshRequest({ type: "omp-refresh", sessionFile: "/tmp/session.jsonl", cwd: "/repo" })).toBe(
			true,
		);
		expect(isSupervisedRefreshRequest({ type: "omp-refresh", sessionFile: "session.jsonl", cwd: "/repo" })).toBe(
			false,
		);
		expect(isSupervisedRefreshRequest({ type: "other", sessionFile: "/tmp/session.jsonl", cwd: "/repo" })).toBe(
			false,
		);
	});

	test("replaces children under one stable parent and preserves wrapper cwd intent", async () => {
		// The probe models a fresh top-level launch. When this suite itself runs
		// inside a compiled, supervised omp session, the parent's markers would
		// otherwise make the probe skip the supervisor or drop its entrypoint.
		const env = { ...process.env };
		delete env.PI_COMPILED;
		delete env.OMP_SUPERVISOR_CHILD;
		delete env.OMP_LAUNCHER_OWNS_CLI;
		delete env.OMP_INTERNAL_REFRESH;
		for (const wrapperAllowsHome of [false, true]) {
			const args = wrapperAllowsHome ? [WRAPPER_ALLOW_HOME_ARG, "initial"] : ["initial"];
			const proc = Bun.spawn([process.execPath, PROBE, ...args], {
				cwd: path.resolve(import.meta.dir, ".."),
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			const records = stdout
				.trim()
				.split("\n")
				.map(
					line =>
						JSON.parse(line) as {
							phase: string;
							pid: number;
							ppid: number;
							args?: string[];
							internalRefresh?: string;
						},
				);
			expect(records).toHaveLength(2);
			expect(records[0]?.phase).toBe("initial");
			expect(records[1]?.phase).toBe("refreshed");
			expect(records[0]?.pid).not.toBe(records[1]?.pid);
			expect(records[0]?.ppid).toBe(records[1]?.ppid);
			expect(records[1]?.args).toEqual([
				...(wrapperAllowsHome ? [WRAPPER_ALLOW_HOME_ARG] : []),
				"--resume",
				"/tmp/omp-supervisor-probe.jsonl",
			]);
			expect(records[1]?.internalRefresh).toBe("true");
		}
	});
});
