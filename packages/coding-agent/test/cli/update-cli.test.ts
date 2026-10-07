import { describe, expect, it } from "bun:test";
import { resolveReleaseBinaryAsset, getBinaryName } from "../../src/cli/update-cli";

describe("Spring-Silicon release assets", () => {
	const release = (tag: string) => ({
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: [
			{
				name: "omp-linux-x64",
				state: "uploaded",
				size: 3,
				digest: "sha256:" + "a".repeat(64),
				browser_download_url: `https://github.com/Spring-Silicon/oh-my-pi/releases/download/${tag}/omp-linux-x64`,
				url: "https://api.github.com/repos/Spring-Silicon/oh-my-pi/releases/assets/1",
			},
		],
	});
	it("parses spring tags and rejects upstream tags", () => {
		expect(resolveReleaseBinaryAsset(release("v18.6.1-spring.2"), "v18.6.1-spring.2", "omp-linux-x64").version).toBe(
			"18.6.1",
		);
		expect(() => resolveReleaseBinaryAsset(release("v18.6.1"), "v18.6.1", "omp-linux-x64")).toThrow();
		expect(() => resolveReleaseBinaryAsset(release("v18.6.2"), "v18.6.2", "omp-linux-x64")).toThrow();
	});
	it("publishes the exact tag and digest", () => {
		const asset = resolveReleaseBinaryAsset(release("v18.6.1-spring.2"), "v18.6.1-spring.2", "omp-linux-x64");
		expect(asset.tag).toBe("v18.6.1-spring.2");
		expect(asset.digest).toBe("sha256:" + "a".repeat(64));
	});
	it("allows only published platform names", () => {
		expect(["omp-linux-x64", "omp-darwin-arm64"]).toContain(getBinaryName());
	});
});
