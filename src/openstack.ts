/**
 * OpenStack API client (Node side, plain fetch).
 *
 * Authentication: obtain a token from Keystone using an Application Credential (bypass Google SSO).
 * The token and service catalog are cached together and refreshed automatically before expiry.
 *
 * Services:
 *   - Nova (compute): query instance status, send power actions (start/stop/reboot)
 *   - Gnocchi (metric): query the instance's resource usage metrics (if the deployment has telemetry installed)
 *
 * ⚠️ Some metric-related details (actual metric names, granularity) are pending confirmation
 *    by the verify script against a real environment; for now they are implemented with
 *    reasonable defaults and marked with TODO.
 */

import {
	normalizeAuthUrl,
	type OpenStackConnection,
} from "./settings";

export class OpenStackAuthError extends Error {}
export class OpenStackApiError extends Error {}

/** Mapping of Nova's power_state codes */
export const POWER_STATE = {
	0: "NOSTATE",
	1: "RUNNING",
	3: "PAUSED",
	4: "SHUTDOWN",
	6: "CRASHED",
	7: "SUSPENDED",
} as const;

export type ServerInfo = {
	id: string;
	name: string;
	/** High-level status derived from vm_state: ACTIVE / SHUTOFF / ERROR / BUILD / … */
	status: string;
	/** OS-EXT-STS:power_state code */
	powerState: number;
	/** OS-EXT-STS:task_state, a task in progress (e.g. powering-on), null if none */
	taskState: string | null;
	flavor: string;
	addresses: string[];
	/** true when the instance boots from a volume (Nova reports an empty image); the flavor root disk is phantom then */
	bootFromVolume: boolean;
};

type CatalogEntry = {
	type: string;
	endpoints: Array<{ interface: string; region: string; url: string }>;
};

/** The fields we use from the Nova GET /servers/{id} response */
type NovaServer = {
	id: string;
	name: string;
	status: string;
	"OS-EXT-STS:power_state"?: number;
	"OS-EXT-STS:task_state"?: string | null;
	flavor?: { original_name?: string; id?: string };
	addresses?: Record<string, Array<{ addr?: string }>>;
	/** {id} when image-backed; "" when booting from a volume */
	image?: { id?: string } | "";
};

type TokenBundle = {
	token: string;
	catalog: CatalogEntry[];
	/** Expiry time (epoch ms) */
	expiresAt: number;
};

/** Cache tokens keyed by authUrl + credential id (avoids re-authenticating on every poll) */
const tokenCache = new Map<string, TokenBundle>();

const cacheKey = (conn: OpenStackConnection): string =>
	`${conn.authUrl}::${conn.applicationCredentialId}`;

/** If a token's remaining lifetime is below this value (ms), treat it as expired and refresh early */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Obtain a token + catalog using the application credential */
const authenticate = async (conn: OpenStackConnection): Promise<TokenBundle> => {
	const authBase = normalizeAuthUrl(conn.authUrl ?? "");
	const res = await safeFetch(`${authBase}/auth/tokens`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			auth: {
				identity: {
					methods: ["application_credential"],
					application_credential: {
						id: conn.applicationCredentialId,
						secret: conn.applicationCredentialSecret,
					},
				},
			},
		}),
	});

	if (res.status === 401) {
		const body = await res.text().catch(() => "");
		throw new OpenStackAuthError(
			body.includes("unsupported method")
				? "Keystone does not have the application_credential auth method enabled (requires an administrator change)"
				: "Authentication failed; please verify the application credential id / secret",
		);
	}
	if (!res.ok) {
		throw new OpenStackApiError(`Keystone returned an unexpected status HTTP ${res.status}`);
	}

	const token = res.headers.get("x-subject-token");
	if (!token) {
		throw new OpenStackApiError("Auth response is missing X-Subject-Token");
	}
	const data = (await res.json()) as {
		token?: { catalog?: CatalogEntry[]; expires_at?: string };
	};
	const catalog = data.token?.catalog ?? [];
	const expiresAt = data.token?.expires_at ? Date.parse(data.token.expires_at) : Date.now() + 3_600_000;
	return { token, catalog, expiresAt };
};

/** Get a valid token (reuse the cache if it hits and is not near expiry, otherwise re-authenticate) */
const getToken = async (conn: OpenStackConnection, forceRefresh = false): Promise<TokenBundle> => {
	const key = cacheKey(conn);
	const cached = tokenCache.get(key);
	if (!forceRefresh && cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
		return cached;
	}
	const fresh = await authenticate(conn);
	tokenCache.set(key, fresh);
	return fresh;
};

/** Find the endpoint for a service type from the catalog (prefer public, and prefer matching region) */
const findEndpoint = (
	catalog: CatalogEntry[],
	types: string[],
	region: string | undefined,
): string | null => {
	for (const svc of catalog) {
		if (!types.includes(svc.type)) {
			continue;
		}
		const eps = svc.endpoints ?? [];
		const pick =
			eps.find((e) => e.interface === "public" && (!region || e.region === region)) ||
			eps.find((e) => e.interface === "public") ||
			eps[0];
		if (pick) {
			return pick.url.replace(/\/+$/, "");
		}
	}
	return null;
};

/**
 * Run an API call with a valid token; on 401, clear the cache, re-authenticate, and retry once.
 * @param op the operation that returns a Promise given (token, catalog)
 */
const withToken = async <T>(
	conn: OpenStackConnection,
	op: (bundle: TokenBundle) => Promise<T>,
): Promise<T> => {
	const bundle = await getToken(conn);
	try {
		return await op(bundle);
	} catch (error) {
		if (error instanceof OpenStackAuthError) {
			const fresh = await getToken(conn, true);
			return await op(fresh);
		}
		throw error;
	}
};

/** Wrap a connection-level error handler: turn fetch failures (unreachable/timeout) into OpenStackApiError */
const safeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
	try {
		return await fetch(url, init);
	} catch (e) {
		let host = url;
		try {
			host = new URL(url).host;
		} catch {}
		throw new OpenStackApiError(`Could not connect to ${host}: ${(e as Error).message}`);
	}
};

const apiGet = async (url: string, token: string): Promise<Response> =>
	safeFetch(url, { headers: { "X-Auth-Token": token, Accept: "application/json" } });

const requireCompute = (bundle: TokenBundle, region: string | undefined): string => {
	const nova = findEndpoint(bundle.catalog, ["compute"], region);
	if (!nova) {
		throw new OpenStackApiError("Could not find the compute (Nova) service in the service catalog");
	}
	return nova;
};

/** Query instance status */
export const getServer = async (conn: OpenStackConnection, serverId: string): Promise<ServerInfo> =>
	withToken(conn, async (bundle) => {
		const nova = requireCompute(bundle, conn.regionName);
		const res = await apiGet(`${nova}/servers/${serverId}`, bundle.token);
		if (res.status === 401) {
			throw new OpenStackAuthError("Token has expired");
		}
		if (res.status === 404) {
			throw new OpenStackApiError(`Instance ${serverId} not found`);
		}
		if (!res.ok) {
			throw new OpenStackApiError(`Failed to query instance HTTP ${res.status}`);
		}
		const { server } = (await res.json()) as { server: NovaServer };
		return {
			id: server.id,
			name: server.name,
			status: server.status,
			powerState: server["OS-EXT-STS:power_state"] ?? 0,
			taskState: server["OS-EXT-STS:task_state"] ?? null,
			flavor: server.flavor?.original_name ?? server.flavor?.id ?? "-",
			addresses: Object.values(server.addresses ?? {})
				.flat()
				.map((a) => a?.addr)
				.filter((addr): addr is string => Boolean(addr)),
			bootFromVolume:
				server.image === "" || (typeof server.image === "object" && server.image !== null && !server.image.id),
		} satisfies ServerInfo;
	});

/** Send a power action. type: start / stop / reboot(SOFT) / reboot-hard(HARD) */
export const serverAction = async (
	conn: OpenStackConnection,
	serverId: string,
	type: "start" | "stop" | "reboot" | "reboot-hard",
): Promise<void> =>
	withToken(conn, async (bundle) => {
		const nova = requireCompute(bundle, conn.regionName);
		const body =
			type === "start"
				? { "os-start": null }
				: type === "stop"
					? { "os-stop": null }
					: { reboot: { type: type === "reboot-hard" ? "HARD" : "SOFT" } };
		const res = await safeFetch(`${nova}/servers/${serverId}/action`, {
			method: "POST",
			headers: {
				"X-Auth-Token": bundle.token,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(body),
		});
		if (res.status === 401) {
			throw new OpenStackAuthError("Token has expired");
		}
		// A successful power action typically returns 202 Accepted
		if (res.status === 409) {
			throw new OpenStackApiError("The instance's current state does not allow this action (e.g. it is already in that power state)");
		}
		if (!res.ok && res.status !== 202) {
			throw new OpenStackApiError(`Power action failed HTTP ${res.status}`);
		}
	});

export type AttachedVolume = {
	/** Cinder volume id */
	id: string;
	/** Volume size (GB) */
	sizeGb: number;
	/** Volume name ("" when unnamed) */
	name: string;
	/** Device path on the instance (e.g. /dev/vdb, "" when unknown) */
	device: string;
};

export type AttachedVolumes = {
	/** Combined size of all attached volumes (GB) */
	totalGb: number;
	/** Number of attached volumes */
	count: number;
	/** Per-volume details */
	volumes: AttachedVolume[];
};

/**
 * The Cinder volumes attached to an instance (combined size + per-volume details).
 * Returns an empty result when nothing is attached, or null when the volume service is unavailable.
 */
export const getAttachedVolumes = async (
	conn: OpenStackConnection,
	serverId: string,
): Promise<AttachedVolumes | null> =>
	withToken(conn, async (bundle) => {
		const nova = requireCompute(bundle, conn.regionName);
		const res = await apiGet(`${nova}/servers/${serverId}/os-volume_attachments`, bundle.token);
		if (res.status === 401) {
			throw new OpenStackAuthError("Token has expired");
		}
		if (!res.ok) {
			throw new OpenStackApiError(`Failed to query volume attachments HTTP ${res.status}`);
		}
		const { volumeAttachments } = (await res.json()) as {
			volumeAttachments?: Array<{ volumeId?: string; device?: string }>;
		};
		const attachments = (volumeAttachments ?? []).filter(
			(a): a is { volumeId: string; device?: string } => Boolean(a.volumeId),
		);
		if (!attachments.length) {
			return { totalGb: 0, count: 0, volumes: [] };
		}
		const cinder = findEndpoint(bundle.catalog, ["volumev3", "block-storage", "volume"], conn.regionName);
		if (!cinder) {
			return null;
		}
		const volumes = await Promise.all(
			attachments.map(async (a): Promise<AttachedVolume> => {
				const r = await apiGet(`${cinder}/volumes/${a.volumeId}`, bundle.token);
				if (r.status === 401) {
					throw new OpenStackAuthError("Token has expired");
				}
				const volume = r.ok
					? ((await r.json()) as { volume?: { size?: number; name?: string } }).volume
					: undefined;
				return {
					id: a.volumeId,
					sizeGb: volume?.size ?? 0,
					name: volume?.name ?? "",
					device: a.device ?? "",
				};
			}),
		);
		return {
			totalGb: volumes.reduce((sum, v) => sum + v.sizeGb, 0),
			count: volumes.length,
			volumes,
		};
	});

// ───────────────────────── Gnocchi metrics ─────────────────────────
// ⚠️ The following is a skeleton: the actual metric names, granularity, and aggregation are pending confirmation by verify.

export type MetricSample = {
	/** The latest measurement value */
	value: number;
	/** Measurement time (ISO string) */
	timestamp: string;
	/** This measurement's granularity (seconds), needed when converting a rate into a usage percentage */
	granularity: number;
};

/** Query which metrics are available for an instance (returns metric name → metric id) */
export const listInstanceMetrics = async (
	conn: OpenStackConnection,
	serverId: string,
): Promise<Record<string, string>> =>
	withToken(conn, async (bundle) => {
		const gnocchi = findEndpoint(bundle.catalog, ["metric"], conn.regionName);
		if (!gnocchi) {
			throw new OpenStackApiError("This deployment does not provide the metric (Gnocchi) service");
		}
		const res = await apiGet(`${gnocchi}/v1/resource/instance/${serverId}`, bundle.token);
		if (res.status === 401) {
			throw new OpenStackAuthError("Token has expired");
		}
		if (res.status === 404) {
			throw new OpenStackApiError("Gnocchi has no resource for this instance (not collected by telemetry)");
		}
		if (!res.ok) {
			throw new OpenStackApiError(`Failed to query the metric list HTTP ${res.status}`);
		}
		const resource = (await res.json()) as { metrics?: Record<string, string> };
		return resource.metrics ?? {};
	});

/**
 * Get the latest measurement value by metric id.
 * @param aggregation Gnocchi aggregation method (e.g. "rate:mean"); defaults to the archive policy's default aggregation
 */
export const getMeasureById = async (
	conn: OpenStackConnection,
	metricId: string,
	aggregation?: string,
): Promise<MetricSample | null> =>
	withToken(conn, async (bundle) => {
		const gnocchi = findEndpoint(bundle.catalog, ["metric"], conn.regionName);
		if (!gnocchi) {
			throw new OpenStackApiError("This deployment does not provide the metric (Gnocchi) service");
		}
		// refresh=true ensures we get the latest aggregation result
		const query = `refresh=true${aggregation ? `&aggregation=${encodeURIComponent(aggregation)}` : ""}`;
		const res = await apiGet(`${gnocchi}/v1/metric/${metricId}/measures?${query}`, bundle.token);
		if (res.status === 401) {
			throw new OpenStackAuthError("Token has expired");
		}
		if (!res.ok) {
			throw new OpenStackApiError(`Failed to query metric measures HTTP ${res.status}`);
		}
		// Response format: [[timestamp, granularity, value], …]; take the last entry
		const measures = (await res.json()) as Array<[string, number, number]>;
		if (!measures.length) {
			return null;
		}
		const [timestamp, granularity, value] = measures[measures.length - 1];
		return { value, timestamp, granularity } satisfies MetricSample;
	});

/**
 * From raw Gnocchi measures ([[timestamp, granularity, value], …]), keep a single clean series:
 * the endpoint mixes granularities when the archive policy defines several, so we group by
 * granularity and keep the group with the most points (the finest resolution over its retention),
 * sorted oldest → newest and capped at `maxPoints`.
 */
const pickFinestSeries = (measures: Array<[string, number, number]>, maxPoints: number): MetricSample[] => {
	if (!measures.length) {
		return [];
	}
	const byGranularity = new Map<number, MetricSample[]>();
	for (const [timestamp, granularity, value] of measures) {
		const group = byGranularity.get(granularity) ?? [];
		group.push({ value, timestamp, granularity });
		byGranularity.set(granularity, group);
	}
	let best: MetricSample[] = [];
	for (const group of byGranularity.values()) {
		if (group.length > best.length) {
			best = group;
		}
	}
	best.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
	return best.slice(-maxPoints);
};

/**
 * Get a metric's full time series (for drawing a sparkline), by metric id. Returns [] when there is no data.
 *
 * @param aggregation Gnocchi aggregation method (e.g. "rate:mean"); defaults to the archive policy's default
 * @param maxPoints   cap on returned points (a 144px key only shows so many); defaults to 48
 */
export const getMeasureSeries = async (
	conn: OpenStackConnection,
	metricId: string,
	aggregation?: string,
	maxPoints = 48,
): Promise<MetricSample[]> =>
	withToken(conn, async (bundle) => {
		const gnocchi = findEndpoint(bundle.catalog, ["metric"], conn.regionName);
		if (!gnocchi) {
			throw new OpenStackApiError("This deployment does not provide the metric (Gnocchi) service");
		}
		const query = `refresh=true${aggregation ? `&aggregation=${encodeURIComponent(aggregation)}` : ""}`;
		const res = await apiGet(`${gnocchi}/v1/metric/${metricId}/measures?${query}`, bundle.token);
		if (res.status === 401) {
			throw new OpenStackAuthError("Token has expired");
		}
		if (!res.ok) {
			throw new OpenStackApiError(`Failed to query metric measures HTTP ${res.status}`);
		}
		return pickFinestSeries((await res.json()) as Array<[string, number, number]>, maxPoints);
	});

/**
 * Generic: the total I/O rate history (bytes/sec, oldest → newest) of a class of child resources
 * under an instance. Returns null if there is no data; the latest value is simply the last element.
 *
 * Disk/network I/O is attached to child resources (instance_disk / instance_network_interface, not instance),
 * and each instance may have several (multiple disks, multiple NICs); the corresponding metric is cumulative bytes.
 * Per child metric we take the rate:mean series, divide each point by its granularity to get bytes/sec, then
 * sum across all children/metrics per timestamp so a point represents the whole instance at that moment.
 *
 * @param resourceType Gnocchi resource type (instance_disk / instance_network_interface)
 * @param metricNames  the cumulative-bytes metric names to sum (e.g. read+write, in+out)
 * @param matchName    optional filter on the child resource name (e.g. only the "vdb" disk); all resources when omitted
 * @param maxPoints    cap on returned points; defaults to 48
 */
const getResourceIoSeriesBytesPerSec = async (
	conn: OpenStackConnection,
	serverId: string,
	resourceType: string,
	metricNames: string[],
	matchName?: (name: string) => boolean,
	maxPoints = 48,
): Promise<number[] | null> =>
	withToken(conn, async (bundle) => {
		const gnocchi = findEndpoint(bundle.catalog, ["metric"], conn.regionName);
		if (!gnocchi) {
			throw new OpenStackApiError("This deployment does not provide the metric (Gnocchi) service");
		}
		// Find all child resources attached to this instance (disks / NICs)
		const res = await safeFetch(`${gnocchi}/v1/search/resource/${resourceType}`, {
			method: "POST",
			headers: {
				"X-Auth-Token": bundle.token,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ "=": { instance_id: serverId } }),
		});
		if (res.status === 401) {
			throw new OpenStackAuthError("Token has expired");
		}
		if (!res.ok) {
			throw new OpenStackApiError(`Failed to query ${resourceType} resources HTTP ${res.status}`);
		}
		const all = (await res.json()) as Array<{
			metrics?: Record<string, string>;
			/** instance_disk's name is the device (e.g. "vda"); some deployments prefix it with the instance id */
			name?: string;
			original_resource_id?: string;
		}>;
		const resources = matchName ? all.filter((r) => matchName(r.name ?? r.original_resource_id ?? "")) : all;

		/** A metric's rate:mean series, each point converted to bytes/sec */
		const ratePerSecSeries = async (metricId: string): Promise<MetricSample[]> => {
			const r = await apiGet(
				`${gnocchi}/v1/metric/${metricId}/measures?refresh=true&aggregation=rate:mean`,
				bundle.token,
			);
			if (r.status === 401) {
				throw new OpenStackAuthError("Token has expired");
			}
			if (!r.ok) {
				return [];
			}
			return pickFinestSeries((await r.json()) as Array<[string, number, number]>, maxPoints);
		};

		// Sum bytes/sec across every child resource + metric, keyed by timestamp so the series stays aligned
		const byTimestamp = new Map<string, number>();
		let got = false;
		for (const resource of resources) {
			for (const name of metricNames) {
				const mid = resource.metrics?.[name];
				if (!mid) {
					continue;
				}
				for (const sample of await ratePerSecSeries(mid)) {
					if (sample.granularity <= 0) {
						continue;
					}
					byTimestamp.set(sample.timestamp, (byTimestamp.get(sample.timestamp) ?? 0) + sample.value / sample.granularity);
					got = true;
				}
			}
		}
		if (!got) {
			return null;
		}
		const sorted = [...byTimestamp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
		return sorted.slice(-maxPoints).map(([, bps]) => bps);
	});

/**
 * Disk I/O rate history (read+write, bytes/sec, oldest → newest). Sums all virtual disks by default;
 * pass matchName to restrict to specific devices. Returns null if there is no data.
 */
export const getDiskIoSeriesBytesPerSec = (
	conn: OpenStackConnection,
	serverId: string,
	matchName?: (name: string) => boolean,
): Promise<number[] | null> =>
	getResourceIoSeriesBytesPerSec(
		conn,
		serverId,
		"instance_disk",
		["disk.device.read.bytes", "disk.device.write.bytes"],
		matchName,
	);

/** Network I/O rate history (in+out across all NICs, bytes/sec, oldest → newest). Returns null if there is no data. */
export const getNetworkIoSeriesBytesPerSec = (conn: OpenStackConnection, serverId: string): Promise<number[] | null> =>
	getResourceIoSeriesBytesPerSec(conn, serverId, "instance_network_interface", [
		"network.incoming.bytes",
		"network.outgoing.bytes",
	]);
