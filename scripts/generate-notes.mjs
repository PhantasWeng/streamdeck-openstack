import { execFileSync } from "node:child_process";
import { groupCommits, parseCommitLines, renderChangelogSection } from "./release-lib.mjs";

// Usage: node scripts/generate-notes.mjs <tag>
// Finds the previous v* tag along <tag>'s ancestor chain and builds a release-note
// section from the commits between the two tags. Used by CI as the fallback when the
// CHANGELOG.md section for that version can't be extracted (needs full git history and tags).
const tag = process.argv[2];
if (!tag) {
	console.error("Usage: generate-notes.mjs <tag>");
	process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// Walk back from the tag's parent to find the previous v* tag; the first release has
// no previous tag, so it covers the full history instead.
let prevTag = null;
try {
	prevTag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*", `${tag}^`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	prevTag = null;
}

const range = prevTag ? `${prevTag}..${tag}` : tag;
const commits = parseCommitLines(git("log", range, "--no-merges", "--pretty=format:%h%x09%s"));

const version = tag.replace(/^v/, "");
const dateStr = git("log", "-1", "--format=%cd", "--date=format:%Y-%m-%d", tag);
process.stdout.write(renderChangelogSection(version, dateStr, groupCommits(commits)));
