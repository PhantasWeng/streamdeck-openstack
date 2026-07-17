import { describe, expect, it } from "vitest";
import {
	buildChangelog,
	classifyCommit,
	computeNextVersion,
	extractVersionSection,
	groupCommits,
	parseCommitLines,
	renderChangelogSection,
	replaceManifestVersion,
} from "../scripts/release-lib.mjs";

describe("computeNextVersion", () => {
	it("major bump carries and zeroes the segments to its right", () => {
		expect(computeNextVersion("1.1.2.3", "major")).toBe("2.0.0.0");
	});
	it("minor bump", () => {
		expect(computeNextVersion("1.1.0.0", "minor")).toBe("1.2.0.0");
	});
	it("patch bump", () => {
		expect(computeNextVersion("1.1.0.0", "patch")).toBe("1.1.1.0");
	});
	it("build bump", () => {
		expect(computeNextVersion("1.1.0.0", "build")).toBe("1.1.0.1");
	});
	it("an explicit version string is used as-is", () => {
		expect(computeNextVersion("1.1.0.0", "1.5.2.0")).toBe("1.5.2.0");
	});
	it("throws on an invalid current version format", () => {
		expect(() => computeNextVersion("1.0.0", "minor")).toThrow();
	});
	it("throws on an invalid bump keyword", () => {
		expect(() => computeNextVersion("1.0.0.0", "nope")).toThrow();
	});
});

describe("classifyCommit", () => {
	it("feat → Features with the prefix stripped", () => {
		expect(classifyCommit("feat: add thing")).toEqual({ group: "Features", description: "add thing" });
	});
	it("parses a scope and the breaking (!) marker", () => {
		expect(classifyCommit("feat(polling)!: rework")).toEqual({ group: "Features", description: "rework" });
	});
	it("fix → Bug Fixes", () => {
		expect(classifyCommit("fix: y").group).toBe("Bug Fixes");
	});
	it("ci/chore → Chores", () => {
		expect(classifyCommit("ci: bump actions").group).toBe("Chores");
		expect(classifyCommit("chore: tidy").group).toBe("Chores");
	});
	it("no conventional prefix → Other, subject kept as-is", () => {
		expect(classifyCommit("random subject")).toEqual({ group: "Other", description: "random subject" });
	});
});

describe("groupCommits", () => {
	it("groups in fixed order, skips empty groups and release-noise commits", () => {
		const groups = groupCommits([
			{ hash: "aaa", subject: "feat: A" },
			{ hash: "bbb", subject: "fix: B" },
			{ hash: "ccc", subject: "feat: C" },
			{ hash: "ddd", subject: "chore: release v1.1.0.0" },
			{ hash: "eee", subject: "chore: bump version to 1.1.0.0" },
		]);
		expect(groups).toEqual([
			{
				title: "Features",
				entries: [
					{ description: "A", hash: "aaa" },
					{ description: "C", hash: "ccc" },
				],
			},
			{
				title: "Bug Fixes",
				entries: [{ description: "B", hash: "bbb" }],
			},
		]);
	});
});

describe("parseCommitLines", () => {
	it("parses hash-tab-subject lines into {hash, subject}", () => {
		expect(parseCommitLines("aaa\tfeat: A\nbbb\tfix: B")).toEqual([
			{ hash: "aaa", subject: "feat: A" },
			{ hash: "bbb", subject: "fix: B" },
		]);
	});
	it("empty or blank input yields an empty array", () => {
		expect(parseCommitLines("")).toEqual([]);
		expect(parseCommitLines("\n\n")).toEqual([]);
	});
	it("preserves a tab inside the subject", () => {
		expect(parseCommitLines("aaa\tfeat: A\tB")).toEqual([{ hash: "aaa", subject: "feat: A\tB" }]);
	});
});

describe("renderChangelogSection", () => {
	it("renders a Keep a Changelog section", () => {
		const section = renderChangelogSection("1.2.0.0", "2026-07-08", [
			{ title: "Features", entries: [{ description: "auto-detect", hash: "2870e3e" }] },
		]);
		expect(section).toBe("## [1.2.0.0] - 2026-07-08\n\n### Features\n\n- auto-detect (2870e3e)\n");
	});
	it("renders a placeholder line when there are no changes", () => {
		const section = renderChangelogSection("1.2.0.0", "2026-07-08", []);
		expect(section).toBe("## [1.2.0.0] - 2026-07-08\n\n- No notable changes.\n");
	});
});

describe("buildChangelog", () => {
	it("empty file → header plus the section", () => {
		const out = buildChangelog("", "## [1.0.0.0] - 2026-07-08\n\n- x\n");
		expect(out.startsWith("# Changelog")).toBe(true);
		expect(out).toContain("## [1.0.0.0] - 2026-07-08");
	});
	it("existing content → the new section goes after the header, before old sections", () => {
		const existing = "# Changelog\n\nintro\n\n## [1.0.0.0] - 2026-01-01\n\n- old\n";
		const out = buildChangelog(existing, "## [1.1.0.0] - 2026-07-08\n\n- new\n");
		expect(out.indexOf("## [1.1.0.0]")).toBeLessThan(out.indexOf("## [1.0.0.0]"));
		expect(out).toContain("intro");
	});
});

describe("replaceManifestVersion", () => {
	const manifest = [
		"{",
		'\t"Name": "OpenStack Monitor",',
		'\t"Version": "1.1.0.0",',
		'\t"Nodejs": {',
		'\t\t"Version": "20"',
		"\t}",
		"}",
		"",
	].join("\n");

	it('replaces only the first (plugin) Version, leaving Nodejs\'s "20" alone', () => {
		const out = replaceManifestVersion(manifest, "1.2.0.0");
		expect(out).toContain('"Version": "1.2.0.0"');
		expect(out).toContain('"Version": "20"');
	});

	it("treats writing the same version as success (idempotent), no throw", () => {
		expect(replaceManifestVersion(manifest, "1.1.0.0")).toBe(manifest);
	});

	it("throws when the Version field is missing", () => {
		expect(() => replaceManifestVersion('{"Name":"x"}', "1.2.0.0")).toThrow();
	});
});

describe("extractVersionSection", () => {
	const changelog = [
		"# Changelog",
		"",
		"## [1.1.0.0] - 2026-07-08",
		"",
		"### Features",
		"",
		"- new (aaa)",
		"",
		"## [1.0.0.0] - 2026-01-01",
		"",
		"- old (bbb)",
		"",
	].join("\n");

	it("extracts the requested version's section (without the next version header)", () => {
		expect(extractVersionSection(changelog, "1.1.0.0")).toBe(
			"## [1.1.0.0] - 2026-07-08\n\n### Features\n\n- new (aaa)",
		);
	});
	it("the last version extends to the end of file", () => {
		expect(extractVersionSection(changelog, "1.0.0.0")).toBe("## [1.0.0.0] - 2026-01-01\n\n- old (bbb)");
	});
	it("returns null when the version is not found", () => {
		expect(extractVersionSection(changelog, "9.9.9.9")).toBeNull();
	});
});
