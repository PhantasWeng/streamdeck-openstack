import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	buildChangelog,
	computeNextVersion,
	groupCommits,
	renderChangelogSection,
	replaceManifestVersion,
} from "./release-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const manifestPath = resolve(rootDir, "com.phantas-weng.openstack.sdPlugin", "manifest.json");
const changelogPath = resolve(rootDir, "CHANGELOG.md");

const run = (command, args) => {
	const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit", shell: false });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
};

const capture = (command, args) => {
	const result = spawnSync(command, args, {
		cwd: rootDir,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		shell: false,
	});
	if (result.status !== 0) {
		console.error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr ?? ""}`);
		process.exit(result.status ?? 1);
	}
	return result.stdout;
};

const readManifestVersion = () => JSON.parse(readFileSync(manifestPath, "utf8")).Version;

// Replace only the Version line, preserving the rest of the file's formatting (tab indentation etc.)
const writeManifestVersion = (nextVersion) => {
	const text = readFileSync(manifestPath, "utf8");
	writeFileSync(manifestPath, replaceManifestVersion(text, nextVersion));
};

const localDate = () => {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Latest v* tag (by creation time); null when none exist (covers the full history)
const lastVersionTag = () => {
	const out = capture("git", ["tag", "--list", "v*", "--sort=-creatordate"]).trim();
	return out ? out.split("\n")[0].trim() : null;
};

const commitsSince = (tag) => {
	const range = tag ? [`${tag}..HEAD`] : ["HEAD"];
	const out = capture("git", ["log", ...range, "--no-merges", "--pretty=format:%h%x09%s"]);
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [hash, ...rest] = line.split("\t");
			return { hash, subject: rest.join("\t") };
		});
};

const askBump = async (currentVersion) => {
	if (!input.isTTY || !output.isTTY) {
		console.error("Provide a bump argument (major|minor|patch|build or x.y.z.w) in non-interactive mode.");
		process.exit(1);
	}
	const rl = createInterface({ input, output });
	try {
		console.log(`Current version: ${currentVersion}`);
		const answer = (await rl.question("Bump to (major|minor|patch|build or explicit x.y.z.w)? ")).trim();
		if (!answer) {
			console.error("Bump cannot be empty.");
			process.exit(1);
		}
		return answer;
	} finally {
		rl.close();
	}
};

const main = async () => {
	const argv = process.argv.slice(2);
	const dryRun = argv.includes("--dry-run");
	const positional = argv.filter((a) => !a.startsWith("--"));

	const currentVersion = readManifestVersion();
	const bumpArg = positional[0] ?? (await askBump(currentVersion));
	const nextVersion = computeNextVersion(currentVersion, bumpArg);
	const tagName = `v${nextVersion}`;

	if (capture("git", ["tag", "--list", tagName]).trim() === tagName) {
		console.error(`Git tag already exists: ${tagName}`);
		process.exit(1);
	}

	const lastTag = lastVersionTag();
	const groups = groupCommits(commitsSince(lastTag));
	const section = renderChangelogSection(nextVersion, localDate(), groups);

	if (dryRun) {
		console.log(`[dry-run] ${currentVersion} → ${nextVersion} (tag ${tagName})`);
		console.log(`[dry-run] release note range: ${lastTag ?? "(full history)"}..HEAD\n`);
		console.log(section);
		console.log("[dry-run] No files written, no commit, no tag.");
		return;
	}

	const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
	writeFileSync(changelogPath, buildChangelog(existingChangelog, section));
	writeManifestVersion(nextVersion);

	run("git", ["add", manifestPath, changelogPath]);
	run("git", ["commit", "-m", `chore: release ${tagName}`]);
	run("git", ["tag", "-a", tagName, "-m", section]);

	console.log(`\n✓ Bumped ${currentVersion} → ${nextVersion}`);
	console.log("✓ Updated manifest.json and CHANGELOG.md");
	console.log(`✓ Committed and created annotated tag ${tagName}`);
	console.log("\nNext step (push to trigger the CI release once you are happy):");
	console.log(`  git push && git push origin ${tagName}`);
};

await main();
