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
import { renderMessage, renderMetric, renderPower, renderStatus } from "../rendering";
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

type AnyEvent<S extends BaseActionSettings> =
	| WillAppearEvent<S>
	| DidReceiveSettingsEvent<S>
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
			void this.openDashboard(ev.payload.settings);
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
		const result = await resolveMetric(conn, serverId, def, settings.diskSelection);
		if (!result) {
			return renderMessage(["No", "data"]);
		}
		const label = getButtonTitle(settings, result.label ?? def.label);
		return renderMetric(label, result.text, result.unit, result.level);
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
		const items: Array<{ label: string; value: string }> = [{ label: "All disks", value: "all" }];
		try {
			const conn = getConnection();
			const settings = await ev.action.getSettings();
			const serverId = settings.serverId?.trim();
			if (hasConnection(conn) && serverId) {
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
						items.push({ label: `Root disk · ${Math.round(root.value)} GB`, value: "root" });
					}
				}
				for (const v of vols?.volumes ?? []) {
					const device = v.device.split("/").pop() ?? "";
					const name = device || v.name || v.id.slice(0, 8);
					items.push({ label: `${name} · ${v.sizeGb} GB`, value: v.id });
				}
			}
		} catch {
			// Fall back to the "All disks" item only; the dropdown stays usable
		}
		await streamDeck.ui.sendToPropertyInspector({ event: "getDisks", items });
	}
}

/** Power key: displays the power state; a short press runs a power action */
@action({ UUID: `${UUID_PREFIX}.power` })
export class InstancePower extends InstanceAction<PowerSettings> {
	protected readonly defaultLabel = "Power";

	protected async fetchImage(conn: OpenStackConnection, settings: PowerSettings, serverId: string): Promise<string> {
		const server = await getServer(conn, serverId);
		const label = getButtonTitle(settings, server.name || this.defaultLabel);
		// A task in progress → busy; otherwise show the action that a press would run
		if (server.taskState !== null) {
			return renderPower(label, "busy");
		}
		const running = server.powerState === 1;
		const action = resolvePowerAction(settings.powerAction ?? "toggle", running);
		return renderPower(label, action ?? (running ? "stop" : "start"));
	}

	protected override async onShortPress(ev: KeyUpEvent<PowerSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const conn = getConnection();
		const serverId = settings.serverId?.trim();
		if (!isReady(conn, settings) || !serverId) {
			await this.poll(ev);
			return;
		}
		try {
			// Check the current state first to decide the action (for toggle, start/stop based on power_state)
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
