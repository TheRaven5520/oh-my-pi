import { describe, expect, it } from "bun:test";
import { resolveCliArgv } from "../src/cli-commands";

describe("Central CLI dispatch", () => {
	it("routes the top-level --central spelling to the Central command", () => {
		expect(resolveCliArgv(["--central"])).toEqual({ argv: ["central"] });
	});
});
