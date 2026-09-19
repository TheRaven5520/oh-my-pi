import { describe, expect, test } from "bun:test";
import { buildRefreshInvocation } from "../src/process-refresh";

describe("buildRefreshInvocation", () => {
	test("relaunches a compiled binary with its exact durable session path", () => {
		const invocation = buildRefreshInvocation("/tmp/a session.jsonl", {
			execPath: "/home/user/.local/bin/omp",
			execArgv: [],
			argv: ["/home/user/.local/bin/omp", "initial prompt"],
			env: { PI_COMPILED: "true", OMP_PROFILE: "work" },
		});
		expect(invocation.command).toBe("/home/user/.local/bin/omp");
		expect(invocation.args).toEqual(["--resume", "/tmp/a session.jsonl"]);
		expect(invocation.env.OMP_PROFILE).toBe("work");
		expect(invocation.env.OMP_INTERNAL_REFRESH).toBe("true");
		expect(invocation.sessionFile).toBe("/tmp/a session.jsonl");
	});

	test("retains the Bun entrypoint for source and npm launches", () => {
		const invocation = buildRefreshInvocation("/tmp/session.jsonl", {
			execPath: "/home/user/.bun/bin/bun",
			execArgv: ["--preload", "/repo/scripts/omp.ts"],
			argv: ["bun", "/repo/packages/coding-agent/src/cli.ts", "--model", "ignored"],
			env: {},
		});
		expect(invocation.args).toEqual([
			"--preload",
			"/repo/scripts/omp.ts",
			"/repo/packages/coding-agent/src/cli.ts",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});

	test("uses the development launcher when supplied", () => {
		const invocation = buildRefreshInvocation("/tmp/session.jsonl", {
			execPath: "/home/user/.bun/bin/bun",
			execArgv: ["--preload", "/repo/scripts/omp.ts"],
			argv: ["bun", "/repo/packages/coding-agent/src/cli.ts"],
			env: { OMP_REFRESH_COMMAND: "/repo/packages/coding-agent/scripts/omp" },
		});
		expect(invocation.command).toBe("/repo/packages/coding-agent/scripts/omp");
		expect(invocation.args).toEqual(["--resume", "/tmp/session.jsonl"]);
	});

	test("rejects an in-memory session", () => {
		expect(() => buildRefreshInvocation("relative.jsonl")).toThrow("Cannot refresh an in-memory session");
	});
});
