/**
 * OpenStack connectivity verification script (zero dependencies, plain Node fetch).
 *
 * Purpose: before starting work on the Stream Deck plugin, confirm that this machine can:
 *   1. Obtain a token from Keystone using an Application Credential (i.e. successfully bypass Google SSO)
 *   2. Locate the real Nova (compute) / Gnocchi (metric) endpoints from the token's service catalog
 *   3. Query the target instance's status
 *   4. Check whether telemetry (metrics) is available
 *
 * Credential sources (pick one, priority: environment variables > clouds.yaml):
 *   A. Environment variables:
 *        OS_AUTH_URL, OS_APPLICATION_CREDENTIAL_ID, OS_APPLICATION_CREDENTIAL_SECRET
 *        OS_REGION_NAME (optional), OS_SERVER_ID (required, the instance UUID to verify)
 *   B. clouds.yaml: place the clouds.yaml downloaded from Horizon in the project root,
 *        and the script parses the clouds.<name>.auth block (name defaults to openstack, override with OS_CLOUD).
 *        Note: clouds.yaml usually does not include application_credential_secret,
 *        so provide the secret separately via OS_APPLICATION_CREDENTIAL_SECRET.
 *
 * Run:
 *   OS_APPLICATION_CREDENTIAL_SECRET=xxxxx yarn verify
 *   (or set all values via environment variables / clouds.yaml, then run yarn verify)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());

const c = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	bold: "\x1b[1m",
};
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const fail = (m) => console.log(`${c.red}✗${c.reset} ${m}`);
const info = (m) => console.log(`${c.cyan}ℹ${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}⚠${c.reset} ${m}`);
const step = (m) => console.log(`\n${c.bold}${m}${c.reset}`);

/**
 * Minimal clouds.yaml parser: only reads single-line scalars under clouds.<cloud>.auth plus region_name.
 * Not a full YAML parser, but sufficient for the standard clouds.yaml that OpenStack generates.
 */
const parseCloudsYaml = (path, cloudName) => {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const lines = text.split(/\r?\n/);
	const result = {};
	let inClouds = false;
	let inTarget = false;
	let inAuth = false;
	const indentOf = (l) => l.length - l.trimStart().length;

	for (const raw of lines) {
		if (!raw.trim() || raw.trim().startsWith("#")) continue;
		const indent = indentOf(raw);
		const line = raw.trim();

		if (indent === 0) {
			inClouds = line.startsWith("clouds:");
			inTarget = inAuth = false;
			continue;
		}
		if (inClouds && indent === 2 && line.endsWith(":")) {
			const name = line.slice(0, -1).trim();
			inTarget = name === cloudName;
			inAuth = false;
			continue;
		}
		if (inTarget && indent === 4) {
			if (line.startsWith("auth:")) {
				inAuth = true;
				continue;
			}
			inAuth = false;
			const m = line.match(/^([\w-]+):\s*(.+)$/);
			if (m) result[m[1]] = stripQuotes(m[2]);
			continue;
		}
		if (inTarget && inAuth && indent === 6) {
			const m = line.match(/^([\w-]+):\s*(.+)$/);
			if (m) result[m[1]] = stripQuotes(m[2]);
		}
	}
	return Object.keys(result).length ? result : null;
};

const stripQuotes = (v) => v.replace(/^["']|["']$/g, "").trim();

/** Build the Keystone v3 base (ensure it ends with /v3 and has no trailing slash) */
const normalizeAuthUrl = (url) => {
	let u = url.trim().replace(/\/+$/, "");
	if (!/\/v3$/.test(u)) u += "/v3";
	return u;
};

const loadConfig = () => {
	const cloudName = process.env.OS_CLOUD || "openstack";
	const fromYaml = parseCloudsYaml(resolve(ROOT, "clouds.yaml"), cloudName) || {};

	const authUrl = process.env.OS_AUTH_URL || fromYaml.auth_url;
	const id = process.env.OS_APPLICATION_CREDENTIAL_ID || fromYaml.application_credential_id;
	const secret =
		process.env.OS_APPLICATION_CREDENTIAL_SECRET || fromYaml.application_credential_secret;
	const region = process.env.OS_REGION_NAME || fromYaml.region_name || null;
	const serverId = process.env.OS_SERVER_ID || fromYaml.server_id || null;

	return { authUrl, id, secret, region, serverId };
};

/** Obtain a token using an application credential; returns { token, catalog } */
const authenticate = async (authBase, id, secret) => {
	const url = `${authBase}/auth/tokens`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			auth: {
				identity: {
					methods: ["application_credential"],
					application_credential: { id, secret },
				},
			},
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Keystone authentication failed HTTP ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
	}

	const token = res.headers.get("x-subject-token");
	if (!token) throw new Error("Authentication response is missing the X-Subject-Token header");

	const data = await res.json();
	const catalog = data?.token?.catalog ?? [];
	const project = data?.token?.project;
	const expires = data?.token?.expires_at;
	return { token, catalog, project, expires };
};

/** Find the endpoint for a given service type in the catalog (prefer public, and matching region first) */
const findEndpoint = (catalog, types, region) => {
	for (const svc of catalog) {
		if (!types.includes(svc.type)) continue;
		const eps = svc.endpoints ?? [];
		const pick =
			eps.find((e) => e.interface === "public" && (!region || e.region === region)) ||
			eps.find((e) => e.interface === "public") ||
			eps[0];
		if (pick) return { url: pick.url.replace(/\/+$/, ""), type: svc.type, region: pick.region };
	}
	return null;
};

const authGet = async (url, token) => {
	const res = await fetch(url, {
		headers: { "X-Auth-Token": token, Accept: "application/json" },
	});
	return res;
};

const main = async () => {
	console.log(`${c.bold}OpenStack connectivity verification${c.reset}\n${c.dim}${new Date().toISOString?.() ?? ""}${c.reset}`);

	const cfg = loadConfig();

	step("Step 0: Check configuration");
	const missing = [];
	if (!cfg.authUrl) missing.push("auth_url (OS_AUTH_URL or clouds.yaml)");
	if (!cfg.id) missing.push("application_credential_id (OS_APPLICATION_CREDENTIAL_ID)");
	if (!cfg.secret) missing.push("application_credential_secret (OS_APPLICATION_CREDENTIAL_SECRET)");
	if (!cfg.serverId) missing.push("server_id (OS_SERVER_ID, the instance UUID to verify)");
	if (missing.length) {
		fail("Missing required configuration:");
		for (const m of missing) console.log(`    - ${m}`);
		console.log(
			`\n${c.dim}Tip: place the clouds.yaml downloaded from Horizon in the project root, then supply the secret via an environment variable:${c.reset}\n` +
				`  OS_APPLICATION_CREDENTIAL_SECRET=your_secret yarn verify`,
		);
		process.exit(1);
	}
	const authBase = normalizeAuthUrl(cfg.authUrl);
	ok(`auth_url  = ${authBase}`);
	ok(`cred id   = ${cfg.id.slice(0, 6)}… (hidden)`);
	ok(`region    = ${cfg.region ?? "(not specified, using the first public endpoint in the catalog)"}`);
	ok(`server id = ${cfg.serverId}`);

	// Step 1: obtain a token
	step("Step 1: Obtain a Keystone token using the Application Credential");
	let auth;
	try {
		auth = await authenticate(authBase, cfg.id, cfg.secret);
	} catch (e) {
		fail(String(e.message ?? e));
		console.log(
			`\n${c.yellow}A failure here means this machine cannot reach Keystone, or the credential is incorrect.${c.reset}\n` +
				`Common causes:\n` +
				`  1. The API endpoint is only reachable on the internal network / behind a VPN (connect to the VPN first)\n` +
				`  2. auth_url is wrong (use the value from clouds.yaml)\n` +
				`  3. The application credential has expired or the secret was pasted incorrectly`,
		);
		process.exit(1);
	}
	ok("Successfully obtained a token (Google SSO bypassed successfully ✅)");
	if (auth.project) info(`project: ${auth.project.name ?? auth.project.id}`);
	if (auth.expires) info(`token expires: ${auth.expires}`);
	info(`services in catalog: ${auth.catalog.map((s) => s.type).sort().join(", ")}`);

	// Step 2: find the Nova endpoint
	step("Step 2: Locate the Nova (compute) endpoint");
	const nova = findEndpoint(auth.catalog, ["compute"], cfg.region);
	if (!nova) {
		fail("compute service not found in the catalog; cannot query the instance");
		process.exit(1);
	}
	ok(`compute endpoint = ${nova.url}${nova.region ? `  (region ${nova.region})` : ""}`);

	// Step 3: query the instance status
	step("Step 3: Query the instance status");
	const serverRes = await authGet(`${nova.url}/servers/${cfg.serverId}`, auth.token);
	if (serverRes.status === 404) {
		fail(`instance ${cfg.serverId} not found (it may not be in this project, or the id is wrong)`);
	} else if (!serverRes.ok) {
		fail(`Query failed HTTP ${serverRes.status} ${serverRes.statusText}`);
		console.log((await serverRes.text()).slice(0, 400));
	} else {
		const { server } = await serverRes.json();
		ok(`instance "${server.name}"`);
		info(`status        = ${server.status}`);
		info(`power_state   = ${powerStateName(server["OS-EXT-STS:power_state"])}`);
		info(`task_state    = ${server["OS-EXT-STS:task_state"] ?? "-"}`);
		const flavor = server.flavor?.original_name ?? server.flavor?.id ?? "-";
		info(`flavor        = ${flavor}`);
		const addrs = Object.entries(server.addresses ?? {})
			.map(([net, list]) => `${net}: ${(list ?? []).map((a) => a.addr).join(", ")}`)
			.join(" | ");
		if (addrs) info(`addresses     = ${addrs}`);
	}

	// Step 4: telemetry / metrics availability
	step("Step 4: Check metrics (telemetry) availability");
	const gnocchi = findEndpoint(auth.catalog, ["metric"], cfg.region);
	const ceilometer = findEndpoint(auth.catalog, ["metering"], cfg.region);
	if (gnocchi) {
		ok(`Gnocchi (metric) endpoint = ${gnocchi.url}`);
		const rRes = await authGet(
			`${gnocchi.url}/v1/resource/instance/${cfg.serverId}`,
			auth.token,
		);
		if (rRes.ok) {
			const resource = await rRes.json();
			const metrics = Object.keys(resource.metrics ?? {});
			if (metrics.length) {
				ok(`${metrics.length} metric(s) available`);
				info(`available metrics: ${metrics.slice(0, 20).join(", ")}${metrics.length > 20 ? " …" : ""}`);
			} else {
				warn("The instance resource exists but has no metrics yet (telemetry may have just been enabled or is not collecting this instance)");
			}
		} else if (rRes.status === 404) {
			warn(`No resource for this instance in Gnocchi (this instance is not being collected by telemetry)`);
		} else {
			warn(`Failed to query the Gnocchi resource HTTP ${rRes.status}`);
		}
	} else if (ceilometer) {
		warn(`Only the legacy Ceilometer (metering) endpoint = ${ceilometer.url} is available; metrics must use the Ceilometer API instead`);
	} else {
		warn("No metric / metering service in the catalog → this OpenStack has no telemetry installed");
		console.log(
			`    ${c.dim}→ Metrics such as CPU/memory/network cannot be retrieved via the API,${c.reset}\n` +
				`    ${c.dim}  monitoring can only show the instance status (ACTIVE/SHUTOFF, etc.), or fall back to Nova diagnostics.${c.reset}`,
		);
		// Additionally try Nova diagnostics (requires admin; a regular credential usually lacks permission, but worth a look)
		const diagRes = await authGet(`${nova.url}/servers/${cfg.serverId}/diagnostics`, auth.token);
		if (diagRes.ok) {
			ok("Nova diagnostics available (can serve as a fallback metrics source)");
			const diag = await diagRes.json();
			info(`sample diagnostics fields: ${Object.keys(diag).slice(0, 10).join(", ")}`);
		} else {
			info(`Nova diagnostics unavailable HTTP ${diagRes.status} (usually requires admin privileges)`);
		}
	}

	step("Verification complete");
	console.log(
		`${c.green}If Steps 1-3 all passed, the approach is viable and you can move on to plugin implementation.${c.reset}\n` +
			`Paste the compute endpoint and the list of available metrics above to me, and I can align the features with the actual API.`,
	);
};

const powerStateName = (code) => {
	const map = { 0: "NOSTATE", 1: "RUNNING", 3: "PAUSED", 4: "SHUTDOWN", 6: "CRASHED", 7: "SUSPENDED" };
	return `${map[code] ?? "?"} (${code})`;
};

main().catch((e) => {
	fail(`Unexpected error: ${e?.stack ?? e}`);
	process.exit(1);
});
