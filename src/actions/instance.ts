/**
 * OpenStack instance monitoring/control keys.
 *
 * All three actions share a single polling framework (InstanceAction):
 *   - Poll in the background every pollingSeconds and update the key image
 *   - Short press: refresh by default (the power key overrides this to run a power action)
 *   - Long press (0.8s): open the instance's Horizon details page
 *
 * Connection credentials are read from global settings (shared by all keys); the target
 * is read from each key's per-action settings.
 */
import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type KeyUpEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { getCachedConnection } from "../connection";
import { getMetricDef, METRIC_CATALOG, resolveMetric } from "../metrics";
import {
	getAttachedVolumes,
	getMeasureById,
	getServer,
	listInstanceMetrics,
	OpenStackApiError,
	OpenStackAuthError,
	serverAction,
} from "../openstack";
import {
	type PowerActionKind,
	renderMessage,
	renderMetric,
	renderMetricLoading,
	renderMetricWithSparkline,
	renderPower,
	renderPowerConfirm,
	renderSparkline,
	renderStatus,
} from "../rendering";
import {
	type BaseActionSettings,
	getButtonTitle,
	getPollingSeconds,
	hasConnection,
	instanceDashboardUrl,
	isReady,
	type MetricSettings,
	type OpenStackConnection,
	type PowerSettings,
	type StatusSettings,
} from "../settings";

const LONG_PRESS_DURATION = 800;

const UUID_PREFIX = "com.phantas-weng.openstack";

type ButtonRuntime = {
	timer?: ReturnType<typeof setTimeout>;
	pressTimer?: ReturnType<typeof setTimeout>;
	disposed: boolean;
	/** While true, poll() paints nothing — used to hold the power confirmation countdown on screen */
	armed?: boolean;
};

const runtimes = new Map<string, ButtonRuntime>();
/** action.id → immediate re-query function, used to refresh all keys when the global connection settings change */
const refreshers = new Map<string, () => void>();

export const refreshAll = (): void => {
	for (const refresh of refreshers.values()) {
		refresh();
	}
};

const getRuntime = (id: string): ButtonRuntime => {
	let r = runtimes.get(id);
	if (!r) {
		r = { disposed: false };
		runtimes.set(id, r);
	}
	return r;
};

const clearTimer = (r: ButtonRuntime): void => {
	if (r.timer) {
		clearTimeout(r.timer);
		r.timer = undefined;
	}
};
const clearPressTimer = (r: ButtonRuntime): void => {
	if (r.pressTimer) {
		clearTimeout(r.pressTimer);
		r.pressTimer = undefined;
	}
};

/** Read the connection settings (from connection.ts's cache, synchronous; avoids calling getGlobalSettings inside poll to prevent event cascades) */
const getConnection = (): OpenStackConnection => getCachedConnection();

/** label = PI dropdown text; title = short form drawn on the key during a cycle switch */
type DiskItem = { label: string; value: string; title: string };

/**
 * Ordered disk selections for an instance: "All disks", then the root disk (unless boot-from-volume),
 * then each attached volume. Shared by the PI's Disk dropdown and the press-to-cycle behavior, so the
 * cycle order matches the dropdown order exactly. The caller must have a complete connection.
 */
const buildDiskItems = async (conn: OpenStackConnection, serverId: string): Promise<DiskItem[]> => {
	const items: DiskItem[] = [{ label: "All disks", value: "all", title: "All" }];
	const [ids, vols, server] = await Promise.all([
		listInstanceMetrics(conn, serverId).catch(() => ({}) as Record<string, string>),
		getAttachedVolumes(conn, serverId).catch(() => null),
		getServer(conn, serverId).catch(() => null),
	]);
	const rootId = ids["disk.root.size"];
	// Boot-from-volume: the flavor root disk is phantom (the boot disk is a volume) — no Root option
	if (rootId && server && !server.bootFromVolume) {
		const root = await getMeasureById(conn, rootId).catch(() => null);
		if (root && root.value > 0) {
			items.push({ label: `Root disk · ${Math.round(root.value)} GB`, value: "root", title: "Root" });
		}
	}
	for (const v of vols?.volumes ?? []) {
		const device = v.device.split("/").pop() ?? "";
		const name = device || v.name || v.id.slice(0, 8);
		items.push({ label: `${name} · ${v.sizeGb} GB`, value: v.id, title: name });
	}
	return items;
};

/**
 * Disk list cache, keyed by instance id. Populated on appear and after each cycle so that pressing
 * can pick the next disk instantly (no network) — the press-to-cycle latency is what made switching
 * feel laggy. Disks change rarely; a stale entry at worst mis-picks once and self-corrects next press.
 */
const diskItemsCache = new Map<string, DiskItem[]>();

/** Rebuild and cache an instance's disk list in the background (best-effort; failures are ignored) */
const refreshDiskCache = async (serverId: string): Promise<void> => {
	const conn = getConnection();
	if (!hasConnection(conn)) {
		return;
	}
	try {
		diskItemsCache.set(serverId, await buildDiskItems(conn, serverId));
	} catch {
		// keep whatever is cached
	}
};

/**
 * Authoritative current disk selection per key (action.id). Advanced synchronously on every cycle
 * press so rapid taps continue from the last tap rather than re-reading the not-yet-persisted
 * settings (which would keep resolving to the same "next" and get stuck). Kept in sync with
 * property-inspector changes via onDidReceiveSettings.
 */
const diskSelectionState = new Map<string, string>();

/**
 * Debounce timers (per key) for the post-cycle data load. Rapid taps update the loading frame
 * instantly but only fire one poll for the final disk once tapping settles — so intermediate
 * fetches never race and leave the key stuck on a disk the user tapped past.
 */
const cycleFetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CYCLE_FETCH_DEBOUNCE_MS = 300;

type AnyEvent<S extends BaseActionSettings> =
	| WillAppearEvent<S>
	| DidReceiveSettingsEvent<S>
	| KeyDownEvent<S>
	| KeyUpEvent<S>;

/**
 * Shared base for instance keys: polling + long-press-to-open + error handling.
 * Subclasses implement fetchImage() (query and return the key image dataURL).
 */
abstract class InstanceAction<S extends BaseActionSettings> extends SingletonAction<S> {
	/** Default label used when this action has no target */
	protected abstract readonly defaultLabel: string;

	/** Query and produce the key image. conn is already validated as complete, serverId is the validated target instance. */
	protected abstract fetchImage(conn: OpenStackConnection, settings: S, serverId: string): Promise<string>;

	override onWillAppear(ev: WillAppearEvent<S>): void {
		this.startMonitoring(ev);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): void {
		this.startMonitoring(ev);
	}

	override onWillDisappear(ev: WillDisappearEvent<S>): void {
		const r = getRuntime(ev.action.id);
		r.disposed = true;
		clearTimer(r);
		clearPressTimer(r);
		runtimes.delete(ev.action.id);
		refreshers.delete(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<S>): void {
		const r = getRuntime(ev.action.id);
		clearPressTimer(r);
		r.pressTimer = setTimeout(() => {
			r.pressTimer = undefined;
			void this.onLongPress(ev);
		}, LONG_PRESS_DURATION);
	}

	override async onKeyUp(ev: KeyUpEvent<S>): Promise<void> {
		const r = getRuntime(ev.action.id);
		// pressTimer still set = long-press threshold not reached = short press; already cleared = long press already fired
		if (r.pressTimer) {
			clearPressTimer(r);
			await this.onShortPress(ev);
		}
	}

	/** Default short-press behavior: refresh. Subclasses (power) may override. */
	protected async onShortPress(ev: KeyUpEvent<S>): Promise<void> {
		await this.poll(ev);
	}

	/** Default long-press behavior: open the Horizon page. The power key overrides this to arm a confirmation. */
	protected async onLongPress(ev: KeyDownEvent<S>): Promise<void> {
		await this.openDashboard(ev.payload.settings);
	}

	protected async openDashboard(settings: S): Promise<void> {
		if (!settings.serverId?.trim()) {
			return;
		}
		const conn = getConnection();
		const url = instanceDashboardUrl(conn, settings.serverId.trim());
		if (!url) {
			return;
		}
		await streamDeck.system.openUrl(url);
	}

	protected startMonitoring(ev: AnyEvent<S>): void {
		const r = getRuntime(ev.action.id);
		r.disposed = false;
		clearTimer(r);
		refreshers.set(ev.action.id, () => void this.poll(ev));
		void ev.action.setTitle("");
		void this.poll(ev);
	}

	protected async poll(ev: AnyEvent<S>): Promise<void> {
		const r = getRuntime(ev.action.id);
		const settings = ev.payload.settings;
		// Armed = a power confirmation countdown owns the screen; don't let a poll overwrite it
		if (r.armed) {
			return;
		}
		try {
			const conn = getConnection();
			if (r.disposed) {
				return;
			}
			const serverId = settings.serverId?.trim();
			if (!isReady(conn, settings) || !serverId) {
				await ev.action.setImage(renderMessage(hasConnection(conn) ? ["Select", "instance"] : ["Set up", "connection"]));
				return;
			}
			const img = await this.fetchImage(conn, settings, serverId);
			if (r.disposed) {
				return;
			}
			await ev.action.setImage(img);
		} catch (error) {
			if (r.disposed) {
				return;
			}
			if (error instanceof OpenStackAuthError) {
				streamDeck.logger.warn("OpenStack authentication failed", error.message);
				await ev.action.setImage(renderMessage(["Auth", "failed"]));
			} else if (error instanceof OpenStackApiError) {
				streamDeck.logger.warn("OpenStack API error", error.message);
				await ev.action.setImage(renderMessage(["Connection", "failed"]));
			} else {
				streamDeck.logger.error("Unexpected error", error);
				await ev.action.setImage(renderMessage(["Error", "occurred"]));
			}
			await ev.action.showAlert();
		} finally {
			this.scheduleNext(ev, r);
		}
	}

	private scheduleNext(ev: AnyEvent<S>, r: ButtonRuntime): void {
		if (r.disposed) {
			return;
		}
		clearTimer(r);
		r.timer = setTimeout(() => {
			r.timer = undefined;
			void this.poll(ev);
		}, getPollingSeconds(ev.payload.settings) * 1000);
	}
}

/** Status key: displays the instance's status (running / stopped / error…) */
@action({ UUID: `${UUID_PREFIX}.status` })
export class InstanceStatus extends InstanceAction<StatusSettings> {
	protected readonly defaultLabel = "Status";

	protected async fetchImage(conn: OpenStackConnection, settings: StatusSettings, serverId: string): Promise<string> {
		const server = await getServer(conn, serverId);
		const label = getButtonTitle(settings, server.name || this.defaultLabel);
		return renderStatus(label, server.status);
	}
}

/** metric key: displays the latest value of a resource usage metric */
@action({ UUID: `${UUID_PREFIX}.metric` })
export class InstanceMetric extends InstanceAction<MetricSettings> {
	protected readonly defaultLabel = "Usage";

	protected async fetchImage(conn: OpenStackConnection, settings: MetricSettings, serverId: string): Promise<string> {
		// When nothing is selected, default to the first catalog entry (cpu_percent), matching the PI dropdown default
		const def = getMetricDef(settings.metric) ?? METRIC_CATALOG[0];
		// Warm the disk-cycle cache on the first successful poll (connection is ready here), so the
		// first cycle press is a cache hit and switches instantly rather than falling back to a fetch.
		if ((def.key === "disk" || def.key === "disk_io") && !diskItemsCache.has(serverId)) {
			void refreshDiskCache(serverId);
		}
		const result = await resolveMetric(conn, serverId, def, settings.diskSelection);
		if (!result) {
			return renderMessage(["No", "data"]);
		}
		const label = getButtonTitle(settings, result.label ?? def.label);
		// A trend line needs at least two history points; without them (or when the user picked "number"),
		// fall back to the plain value. Items with no series never have one, so they stay numeric.
		const style = settings.displayStyle ?? "chart";
		if (result.series && result.series.length >= 2 && style !== "number") {
			return style === "combo"
				? renderMetricWithSparkline(label, result.text, result.unit, result.series, result.level)
				: renderSparkline(label, result.text, result.unit, result.series, result.level);
		}
		return renderMetric(label, result.text, result.unit, result.level);
	}

	/** Keep the cycle's current-selection state in sync with property-inspector changes */
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<MetricSettings>): void {
		super.onDidReceiveSettings(ev);
		diskSelectionState.set(ev.action.id, ev.payload.settings.diskSelection?.trim() || "all");
	}

	/** Drop this key's cycle state and any pending debounced load when it goes away */
	override onWillDisappear(ev: WillDisappearEvent<MetricSettings>): void {
		super.onWillDisappear(ev);
		const id = ev.action.id;
		const pending = cycleFetchTimers.get(id);
		if (pending) {
			clearTimeout(pending);
			cycleFetchTimers.delete(id);
		}
		diskSelectionState.delete(id);
	}

	/**
	 * Disk / Disk I/O keys with more than one disk cycle the selection on a short press
	 * (All disks → Root → each volume → back to All), matching the PI dropdown order.
	 * Other metrics (and single-disk instances) keep the default refresh-on-press behavior.
	 *
	 * Switching feels instant and stays correct under rapid taps: the next disk is picked from an
	 * in-memory state (advanced synchronously, so back-to-back taps keep moving forward) and the new
	 * label is painted immediately, while the actual data load is debounced to a single poll for the
	 * disk the user lands on — no racing fetches, so it never sticks on one they tapped past.
	 */
	protected override async onShortPress(ev: KeyUpEvent<MetricSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const conn = getConnection();
		const serverId = settings.serverId?.trim();
		if ((settings.metric !== "disk" && settings.metric !== "disk_io") || !hasConnection(conn) || !serverId) {
			await this.poll(ev);
			return;
		}

		// Prefer the cached list (instant); only hit the network the very first time it is missing.
		// Even then, use the same dots frame (with a generic title) so the loading look never differs.
		let items = diskItemsCache.get(serverId);
		if (!items) {
			await ev.action.setImage(renderMetricLoading(getMetricDef(settings.metric)?.label ?? "Disk"));
			try {
				items = await buildDiskItems(conn, serverId);
				diskItemsCache.set(serverId, items);
			} catch {
				await this.poll(ev);
				return;
			}
		}

		// values[0] is always "all"; cycling is only meaningful with ≥2 real disks (length > 2),
		// otherwise "all" and the single disk show the same thing.
		if (items.length <= 2) {
			await this.poll(ev);
			return;
		}

		const id = ev.action.id;
		// State wins over settings (which may lag a rapid tap); findIndex === -1 wraps to 0 = "all"
		const current = (diskSelectionState.get(id) ?? settings.diskSelection?.trim()) || "all";
		const next = items[(items.findIndex((i) => i.value === current) + 1) % items.length];
		diskSelectionState.set(id, next.value); // advance now so the next rapid tap continues from here
		settings.diskSelection = next.value; // the debounced poll reads this ev's settings

		// Instant per-tap feedback; the (single) data load waits until tapping settles.
		await ev.action.setImage(renderMetricLoading(next.title));
		const pending = cycleFetchTimers.get(id);
		if (pending) {
			clearTimeout(pending);
		}
		cycleFetchTimers.set(
			id,
			setTimeout(() => {
				cycleFetchTimers.delete(id);
				void ev.action.setSettings(ev.payload.settings); // persist the final selection once
				this.startMonitoring(ev); // one poll for the landed disk; also re-arms recurring polling
			}, CYCLE_FETCH_DEBOUNCE_MS),
		);
		// keep the cached list fresh for the next press in case disks were attached/detached
		void refreshDiskCache(serverId);
	}

	/**
	 * sdpi-components datasource: the PI's Disk dropdown asks for { event: "getDisks" }
	 * and expects { event: "getDisks", items: [{label, value}] } back.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, MetricSettings>): Promise<void> {
		const payload = ev.payload as { event?: string } | undefined;
		if (payload?.event !== "getDisks") {
			return;
		}
		let items: DiskItem[] = [{ label: "All disks", value: "all", title: "All" }];
		try {
			const conn = getConnection();
			const settings = await ev.action.getSettings();
			const serverId = settings.serverId?.trim();
			if (hasConnection(conn) && serverId) {
				items = await buildDiskItems(conn, serverId);
				diskItemsCache.set(serverId, items); // opportunistically warm the cycle cache
			}
		} catch {
			// Fall back to the "All disks" item only; the dropdown stays usable
		}
		// The dropdown only needs label + value; `title` is internal to the cycle behavior
		const options = items.map(({ label, value }) => ({ label, value }));
		await streamDeck.ui.sendToPropertyInspector({ event: "getDisks", items: options });
	}
}

/** Running confirmation countdown per power key (action.id → interval), so the arm can be cancelled/replaced */
const powerArms = new Map<string, ReturnType<typeof setInterval>>();
/** Last action the power key displayed, keyed by instance id — lets arming show it without a fresh fetch */
const lastPowerAction = new Map<string, PowerActionKind>();
/** Confirmation window: press to confirm within this many seconds, or it auto-cancels */
const POWER_CONFIRM_SECONDS = 5;

/**
 * Power key: because a power action is destructive, it is guarded by a two-step confirmation.
 *   - short press (idle): a reminder to hold, so a stray tap never runs anything
 *   - long press (0.8s): arm — start a 5s countdown showing the pending action
 *   - short press (armed): confirm — actually send the command
 *   - countdown elapses: auto-cancel back to the normal display
 */
@action({ UUID: `${UUID_PREFIX}.power` })
export class InstancePower extends InstanceAction<PowerSettings> {
	protected readonly defaultLabel = "Power";

	protected async fetchImage(conn: OpenStackConnection, settings: PowerSettings, serverId: string): Promise<string> {
		const server = await getServer(conn, serverId);
		const label = getButtonTitle(settings, server.name || this.defaultLabel);
		const running = server.powerState === 1;
		// A task in progress → busy; otherwise show the action a confirm would run
		const displayed: PowerActionKind =
			server.taskState !== null
				? "busy"
				: (resolvePowerAction(settings.powerAction ?? "toggle", running) ?? (running ? "stop" : "start"));
		lastPowerAction.set(serverId, displayed); // cache so arming can label the countdown without refetching
		return renderPower(label, displayed);
	}

	/** Long press arms the confirmation instead of opening the dashboard (overrides the base) */
	protected override async onLongPress(ev: KeyDownEvent<PowerSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const conn = getConnection();
		const serverId = settings.serverId?.trim();
		if (!isReady(conn, settings) || !serverId) {
			return; // nothing configured to run; the idle poll already shows the setup hint
		}
		const id = ev.action.id;
		const r = getRuntime(id);
		r.armed = true; // poll() now paints nothing, so the countdown stays on screen
		clearTimer(r); // pause the recurring poll for the duration of the countdown
		const existing = powerArms.get(id);
		if (existing) {
			clearInterval(existing);
		}
		const action = powerConfirmAction(settings, lastPowerAction.get(serverId));
		let seconds = POWER_CONFIRM_SECONDS;
		await ev.action.setImage(renderPowerConfirm(action, seconds, POWER_CONFIRM_SECONDS));
		const interval = setInterval(() => {
			seconds -= 1;
			if (seconds <= 0) {
				this.clearArm(id);
				this.startMonitoring(ev); // window elapsed → cancel and resume the normal display
				return;
			}
			void ev.action.setImage(renderPowerConfirm(action, seconds, POWER_CONFIRM_SECONDS));
		}, 1000);
		powerArms.set(id, interval);
	}

	protected override async onShortPress(ev: KeyUpEvent<PowerSettings>): Promise<void> {
		const id = ev.action.id;
		if (powerArms.has(id)) {
			// Armed → this tap confirms and sends the command
			this.clearArm(id);
			await this.runPowerAction(ev);
			return;
		}
		// Not armed → a plain tap must never run a destructive action; remind the user to hold
		await ev.action.setImage(renderMessage(["Hold", "to run"]));
		setTimeout(() => void this.poll(ev), 1500);
	}

	override onWillDisappear(ev: WillDisappearEvent<PowerSettings>): void {
		const interval = powerArms.get(ev.action.id);
		if (interval) {
			clearInterval(interval);
			powerArms.delete(ev.action.id);
		}
		super.onWillDisappear(ev);
	}

	/** Stop the confirmation countdown and let poll() paint again */
	private clearArm(id: string): void {
		const interval = powerArms.get(id);
		if (interval) {
			clearInterval(interval);
			powerArms.delete(id);
		}
		getRuntime(id).armed = false;
	}

	/** Resolve the action against the live state and send it (used once the user confirms) */
	private async runPowerAction(ev: KeyUpEvent<PowerSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const conn = getConnection();
		const serverId = settings.serverId?.trim();
		if (!isReady(conn, settings) || !serverId) {
			await this.poll(ev);
			return;
		}
		try {
			// Re-check the current state at confirm time (for toggle, start/stop based on power_state)
			const server = await getServer(conn, serverId);
			const running = server.powerState === 1;
			const action = resolvePowerAction(settings.powerAction ?? "toggle", running);
			if (!action) {
				await this.poll(ev);
				return;
			}
			await ev.action.setImage(renderMessage(["Running"]));
			await serverAction(conn, serverId, action);
			await ev.action.showOk();
			// The action is asynchronous; refresh a bit later to reflect the new state
			setTimeout(() => void this.poll(ev), 3000);
		} catch (error) {
			streamDeck.logger.error("Power action failed", error);
			await ev.action.showAlert();
			await this.poll(ev);
		}
	}
}

/** toggle → resolves to start/stop based on the current state; the rest map directly */
const resolvePowerAction = (
	pref: PowerSettings["powerAction"],
	running: boolean,
): "start" | "stop" | "reboot" | null => {
	switch (pref) {
		case "start":
			return "start";
		case "stop":
			return "stop";
		case "reboot":
			return "reboot";
		default:
			return running ? "stop" : "start";
	}
};

/**
 * The action to show during the confirmation countdown. Explicit preferences map directly; "toggle"
 * uses the last displayed action when known (start/stop), falling back to "stop" when unknown (e.g.
 * the key was armed before its first poll). The command actually sent is re-resolved at confirm time.
 */
const powerConfirmAction = (
	settings: PowerSettings,
	last: PowerActionKind | undefined,
): "start" | "stop" | "reboot" => {
	const pref = settings.powerAction ?? "toggle";
	if (pref === "start" || pref === "stop" || pref === "reboot") {
		return pref;
	}
	return last === "start" || last === "stop" || last === "reboot" ? last : "stop";
};
