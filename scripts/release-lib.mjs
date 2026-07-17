/**
 * Pure functions (no I/O) for the bump/release flow, used by bump.mjs and
 * covered by tests/release-lib.test.ts.
 */

const VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;
const BUMP_SEGMENTS = { major: 0, minor: 1, patch: 2, build: 3 };

/**
 * Compute the next 4-part version (major.minor.patch.build).
 * bump is either a keyword (major/minor/patch/build) or an explicit version string.
 * Bumping a segment resets every segment to its right to zero.
 */
export const computeNextVersion = (current, bump) => {
	if (!VERSION_RE.test(current)) {
		throw new Error(`Invalid current version: ${current}`);
	}
	if (VERSION_RE.test(bump)) {
		return bump;
	}
	const idx = BUMP_SEGMENTS[bump];
	if (idx === undefined) {
		throw new Error(`Invalid bump keyword: ${bump} (expected major|minor|patch|build or x.y.z.w)`);
	}
	const parts = current.split(".").map(Number);
	parts[idx] += 1;
	for (let i = idx + 1; i < parts.length; i += 1) {
		parts[i] = 0;
	}
	return parts.join(".");
};

const MANIFEST_VERSION_RE = /("Version":\s*")[^"]*(")/;

/**
 * Replace only the first (plugin) Version value in manifest.json, preserving the rest
 * of the formatting. Success is judged by whether the pattern exists (not whether the
 * text changed), so writing the same version stays idempotent. Throws when the
 * Version field is missing.
 */
export const replaceManifestVersion = (text, nextVersion) => {
	if (!MANIFEST_VERSION_RE.test(text)) {
		throw new Error("Version field not found in manifest.json");
	}
	return text.replace(MANIFEST_VERSION_RE, `$1${nextVersion}$2`);
};

// conventional commit prefix → CHANGELOG group
const TYPE_TO_GROUP = {
	feat: "Features",
	fix: "Bug Fixes",
	perf: "Performance",
	refactor: "Refactoring",
	docs: "Documentation",
	chore: "Chores",
	ci: "Chores",
	build: "Chores",
	test: "Chores",
	style: "Chores",
};

// Fixed display order of the groups in the CHANGELOG
const GROUP_ORDER = ["Features", "Bug Fixes", "Performance", "Refactoring", "Documentation", "Chores", "Other"];

const CONVENTIONAL_RE = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/;
// Commits produced by the release flow itself, excluded from the notes
const RELEASE_NOISE_RE = /^chore: (release|bump version)\b/;

/**
 * Classify a single commit subject into a group and extract the description
 * with the prefix stripped.
 */
export const classifyCommit = (subject) => {
	const match = CONVENTIONAL_RE.exec(subject);
	if (!match) {
		return { group: "Other", description: subject };
	}
	const [, type, description] = match;
	return { group: TYPE_TO_GROUP[type] ?? "Other", description };
};

/**
 * Group an array of commits ({hash, subject}) ordered by GROUP_ORDER,
 * skipping empty groups and release-noise commits.
 */
export const groupCommits = (commits) => {
	const buckets = new Map();
	for (const { hash, subject } of commits) {
		if (RELEASE_NOISE_RE.test(subject)) {
			continue;
		}
		const { group, description } = classifyCommit(subject);
		if (!buckets.has(group)) {
			buckets.set(group, []);
		}
		buckets.get(group).push({ description, hash });
	}
	return GROUP_ORDER.filter((title) => buckets.has(title)).map((title) => ({ title, entries: buckets.get(title) }));
};

/**
 * Parse `git log --pretty=format:%h%x09%s` output into an array of {hash, subject}.
 * Empty input yields an empty array; a tab inside the subject is preserved verbatim.
 */
export const parseCommitLines = (text) => {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [hash, ...rest] = line.split("\t");
			return { hash, subject: rest.join("\t") };
		});
};

/**
 * Render a single version's Keep a Changelog section (ends with a single newline).
 */
export const renderChangelogSection = (version, dateStr, groups) => {
	const lines = [`## [${version}] - ${dateStr}`, ""];
	if (groups.length === 0) {
		lines.push("- No notable changes.");
		return `${lines.join("\n")}\n`;
	}
	groups.forEach((group, index) => {
		lines.push(`### ${group.title}`, "");
		for (const entry of group.entries) {
			lines.push(`- ${entry.description} (${entry.hash})`);
		}
		if (index < groups.length - 1) {
			lines.push("");
		}
	});
	return `${lines.join("\n")}\n`;
};

const CHANGELOG_HEADER = "# Changelog\n\nAll notable changes to this project are documented in this file.\n";

/**
 * Insert the new version section into the CHANGELOG: add the header for an empty
 * file, otherwise insert it after the header and before the first existing section.
 */
export const buildChangelog = (existing, section) => {
	const trimmed = existing.trim();
	if (!trimmed) {
		return `${CHANGELOG_HEADER}\n${section}`;
	}
	const firstEntryIdx = existing.indexOf("## [");
	if (firstEntryIdx === -1) {
		// A header exists but no version section yet
		return `${existing.replace(/\s*$/, "")}\n\n${section}`;
	}
	const header = existing.slice(0, firstEntryIdx).replace(/\s*$/, "");
	const rest = existing.slice(firstEntryIdx);
	return `${header}\n\n${section}\n${rest}`;
};

/**
 * Extract the section for a specific version from the CHANGELOG text (up to the
 * next `## [` or end of file), trimmed; returns null when not found.
 */
export const extractVersionSection = (changelog, version) => {
	const lines = changelog.split("\n");
	const startIdx = lines.findIndex((line) => line.startsWith(`## [${version}]`));
	if (startIdx === -1) {
		return null;
	}
	let endIdx = lines.length;
	for (let i = startIdx + 1; i < lines.length; i += 1) {
		if (lines[i].startsWith("## [")) {
			endIdx = i;
			break;
		}
	}
	return lines.slice(startIdx, endIdx).join("\n").trim();
};
