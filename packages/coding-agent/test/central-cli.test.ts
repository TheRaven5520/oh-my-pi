import { describe, expect, it } from "bun:test";
import { centralRestartCommand } from "../src/commands/central";

describe("Central CLI dispatch", () => {
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
