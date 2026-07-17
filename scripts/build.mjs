import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const pluginPath = resolve(rootDir, "com.phantas-weng.openstack.sdPlugin");
const manifestPath = resolve(pluginPath, "manifest.json");
const releaseDir = resolve(rootDir, "releases");

const run = (command, args) => {
	const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit", shell: false });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
};

const readCurrentPluginVersion = () => {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	return manifest.Version;
};

// Local packaging: read the current version from manifest.json and package into a .streamDeckPlugin for local install/testing.
const main = async () => {
	run("yarn", ["build:bundle"]);

	const version = readCurrentPluginVersion();
	if (!existsSync(releaseDir)) {
		mkdirSync(releaseDir, { recursive: true });
	}

	run("streamdeck", ["pack", pluginPath, "--version", version, "-o", releaseDir, "-f"]);
	console.log(`Packed plugin v${version} → ${releaseDir}`);
};

await main();
