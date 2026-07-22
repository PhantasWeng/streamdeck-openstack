/**
 * Settings types and pure-function utilities.
 *
 * Design: connection credentials (auth_url / application credential / region) are shared across
 * all keys and stored in Stream Deck's **global settings**; each key only stores per-action settings
 * for "which instance to monitor and what to display". This way multiple machines share a single
 * application credential, and the credential only needs to be configured once.
 */

/** Global connection settings (shared by all keys, stored in global settings) */
export type OpenStackConnection = {
	/** Keystone v3 base, e.g. http://keystone.example.com:5000/v3 */
	authUrl?: string;
	/** application credential id */
	applicationCredentialId?: string;
	/**
	 * application credential secret.
	 * ⚠️ Stream Deck settings are stored in plaintext; use a revocable, role-limited credential.
	 */
	applicationCredentialSecret?: string;
	/** region name (optional; if omitted, the first public endpoint in the catalog is used) */
	regionName?: string;
	/**
	 * Horizon dashboard base (used to open the instance page on long press).
	 * The API is on the internal network while the dashboard is public, so their hosts differ and this is configured separately.
	 */
	dashboardBase?: string;
};

/** Per-action settings common to every key */
export type BaseActionSettings = {
	/** Target instance (server) UUID */
	serverId?: string;
	/** Key title (shown on the image); if empty, the instance name or the action default is used */
	displayName?: string;
	/** Polling interval (seconds), default 60 */
	pollingSeconds?: number | string;
};

/** Status key settings */
export type StatusSettings = BaseActionSettings;

/** How the metric key draws its value; only affects items that provide a history series */
export type MetricDisplayStyle = "chart" | "number" | "combo";

/** metric key settings */
export type MetricSettings = BaseActionSettings & {
	/** The item to display, corresponding to a METRIC_CATALOG key in metrics.ts (cpu_percent / mem_percent / …) */
	metric?: string;
	/** Disk / Disk I/O metrics only: which disk to show — "all" (default), "root", or an attached volume id */
	diskSelection?: string;
	/**
	 * Layout for items that have a history series (cpu% / memory% / memory GB):
	 *   "chart"  — trend line filling the key, value in the corner (default)
	 *   "combo"  — large value with a mini trend strip below
	 *   "number" — value only (no chart)
	 * Ignored by items without a series (always shown as a number).
	 */
	displayStyle?: MetricDisplayStyle;
};

/** Power key action type */
export type PowerAction = "toggle" | "start" | "stop" | "reboot";

/** Power key settings */
export type PowerSettings = BaseActionSettings & {
	/** The action to run on press, default toggle (start/stop based on the current state) */
	powerAction?: PowerAction;
};

export const DEFAULT_POLLING_SECONDS = 60;
const MIN_POLLING_SECONDS = 15;

/** Whether the connection settings are complete (sufficient to authenticate) */
export const hasConnection = (conn: OpenStackConnection | undefined): conn is OpenStackConnection =>
	!!conn?.authUrl?.trim() &&
	!!conn.applicationCredentialId?.trim() &&
	!!conn.applicationCredentialSecret?.trim();

/** Whether the per-action settings specify a target instance */
export const hasTarget = (settings: BaseActionSettings): boolean => !!settings.serverId?.trim();

/** Both the connection and the target must be complete before querying */
export const isReady = (conn: OpenStackConnection | undefined, settings: BaseActionSettings): boolean =>
	hasConnection(conn) && hasTarget(settings);

export const getPollingSeconds = (settings: BaseActionSettings): number => {
	const parsed = Number(settings.pollingSeconds);
	if (Number.isFinite(parsed) && parsed >= MIN_POLLING_SECONDS) {
		return parsed;
	}
	return DEFAULT_POLLING_SECONDS;
};

export const getButtonTitle = (settings: BaseActionSettings, fallback: string): string =>
	settings.displayName?.trim() || fallback;

/** Build the Keystone v3 base (ensures it ends with /v3 and has no trailing slash) */
export const normalizeAuthUrl = (url: string): string => {
	let u = url.trim().replace(/\/+$/, "");
	if (!/\/v3$/.test(u)) {
		u += "/v3";
	}
	return u;
};

/**
 * Build the Horizon details page URL for an instance.
 * Returns null when dashboardBase is not set (the caller should skip the open action).
 */
export const instanceDashboardUrl = (conn: OpenStackConnection | undefined, serverId: string): string | null => {
	const base = conn?.dashboardBase?.trim().replace(/\/+$/, "");
	if (!base) {
		return null;
	}
	return `${base}/project/instances/${serverId}/`;
};
