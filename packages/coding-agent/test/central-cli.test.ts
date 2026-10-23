import { describe, expect, it } from "bun:test";
import { resolveCliArgv } from "../src/cli-commands";
import { centralRestartCommand } from "../src/commands/central";

describe("Central CLI dispatch", () => {
	it("routes the top-level --central spelling to the Central command", () => {
		expect(resolveCliArgv(["--central"])).toEqual({ argv: ["central"] });
	});

	it("routes both top-level --focus spellings to the Central command with the target intact", () => {
		expect(resolveCliArgv(["--central", "--focus", "TMUX ORCHESTRATION"])).toEqual({
			argv: ["central", "--focus", "TMUX ORCHESTRATION"],
		});
		expect(resolveCliArgv(["--central", "--focus=01a16520"])).toEqual({ argv: ["central", "--focus=01a16520"] });
		expect(resolveCliArgv(["central", "--focus", "HQ"])).toEqual({ argv: ["central", "--focus", "HQ"] });
	});

	it("restarts onto a new build with the same --focus target", () => {
		const command = centralRestartCommand([
			"/bin/omp",
			"/$bunfs/root/omp",
			"--central",
			"--focus",
			"TMUX ORCHESTRATION",
		]);
		expect(command.slice(-3)).toEqual(["--central", "--focus", "TMUX ORCHESTRATION"]);
	});
});
