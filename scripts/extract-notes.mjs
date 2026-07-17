import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractVersionSection } from "./release-lib.mjs";

// Usage: node scripts/extract-notes.mjs <version>
// Prints the CHANGELOG.md section for that version; when not found, prints
// nothing and exits non-zero (so CI can fall back to generated notes).
const __dirname = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(__dirname, "..", "CHANGELOG.md");

const version = process.argv[2];
if (!version) {
	console.error("Usage: extract-notes.mjs <version>");
	process.exit(2);
}

if (!existsSync(changelogPath)) {
	process.exit(1);
}

const section = extractVersionSection(readFileSync(changelogPath, "utf8"), version);
if (!section) {
	process.exit(1);
}

process.stdout.write(section);
