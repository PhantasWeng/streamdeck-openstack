/**
 * Metric display item definitions and calculations.
 *
 * Presents "meaningful items" to the user (CPU usage, memory usage…) rather than raw
 * Gnocchi metric names. The actual calculations are finalized based on the real data probed by verify:
 *
 *   - cpu: unit=ns, cumulative value; the archive policy provides rate:mean.
 *     usage% = rate:mean value / (granularity seconds × vcpus × 1e9) × 100
 *   - memory / memory.usage: unit=MB. usage% = usage / total × 100
 *   - vcpus: displayed directly (mean)
 *   - disk: disk.root.size + the sizes of all attached Cinder volumes (via Nova/Cinder)
 */
import {
	getAttachedVolumes,
	getDiskIoBytesPerSec,
	getMeasureById,
	getNetworkIoBytesPerSec,
	getServer,
	listInstanceMetrics,
} from "./openstack";
import type { OpenStackConnection } from "./settings";

export type MetricKey = "cpu_percent" | "mem_percent" | "mem_usage" | "vcpus" | "disk" | "disk_io" | "net_io";

type MetricDef = {
	key: MetricKey;
	/** Dropdown menu and default key label */
	label: string;
	/** Display unit (drawn below the value) */
	unit: string;
};

/** Selectable display items (used by the property inspector dropdown and the action) */
export const METRIC_CATALOG: MetricDef[] = [
	{ key: "cpu_percent", label: "CPU", unit: "%" },
	{ key: "mem_percent", label: "Memory %", unit: "%" },
	{ key: "mem_usage", label: "Memory GB", unit: "GB" },
	{ key: "vcpus", label: "vCPU", unit: "" },
	{ key: "disk", label: "Disk", unit: "GB" },
	{ key: "disk_io", label: "Disk I/O", unit: "MB/s" },
	{ key: "net_io", label: "Network I/O", unit: "MB/s" },
];

export const getMetricDef = (key: string | undefined): MetricDef | undefined =>
	METRIC_CATALOG.find((m) => m.key === key);

/** Usage level (used to decide the number's color): low=green, mid=yellow, high=red */
export type MetricLevel = "low" | "mid" | "high";

export type MetricResult = {
	/** The formatted value string (e.g. "6", "20", "6.5") */
	text: string;
	/** Display unit */
	unit: string;
	/** Usage level (only for percentage-type items; other items are undefined = use the default color) */
	level?: MetricLevel;
	/** Dynamic key title (e.g. "3 Disks"); overrides the catalog label, but a user displayName still wins */
	label?: string;
};

const percentText = (pct: number): string => (pct < 10 ? pct.toFixed(1) : String(Math.round(pct)));

/** Format an I/O rate (bytes/sec) as MB/s text */
const ioRateText = (bps: number): string => {
	const mbps = bps / (1024 * 1024);
	return mbps < 10 ? mbps.toFixed(1) : String(Math.round(mbps));
};

/** Usage threshold → level (<50 low, 50~80 mid, >=80 high) */
const percentLevel = (pct: number): MetricLevel => (pct >= 80 ? "high" : pct >= 50 ? "mid" : "low");

/**
 * Compute the latest value of a display item. Returns null when the instance has no corresponding data.
 * @param diskSelection disk / disk_io metrics only: "all" (default), "root", or an attached volume id
 */
export const resolveMetric = async (
	conn: OpenStackConnection,
	serverId: string,
	def: MetricDef,
	diskSelection?: string,
): Promise<MetricResult | null> => {
	// Disk/network I/O comes from child resources (queried via search), no listInstanceMetrics needed
	if (def.key === "net_io") {
		const bps = await getNetworkIoBytesPerSec(conn, serverId);
		return bps == null ? null : { text: ioRateText(bps), unit: def.unit };
	}
	if (def.key === "disk_io") {
		const selection = diskSelection?.trim() || "all";
		let matchDevice: ((name: string) => boolean) | undefined;
		let label: string | undefined;
		if (selection !== "all") {
			// Map the selected disk to a device name and filter instance_disk resources by it.
			// instance_disk names are device names ("vdb"), possibly prefixed with the instance id.
			const volumes = (await getAttachedVolumes(conn, serverId))?.volumes ?? [];
			const deviceTail = (path: string): string => path.split("/").pop() ?? "";
			const matches = (name: string, device: string): boolean =>
				name === device || name.endsWith(`-${device}`);
			if (selection === "root") {
				// Root = every disk that is not an attached volume (boot-from-volume then matches nothing → null)
				const volDevices = volumes.map((v) => deviceTail(v.device)).filter(Boolean);
				matchDevice = (name) => !volDevices.some((d) => matches(name, d));
				label = "Root I/O";
			} else {
				const device = deviceTail(volumes.find((v) => v.id === selection)?.device ?? "");
				if (!device) {
					return null;
				}
				matchDevice = (name) => matches(name, device);
				label = `${device} I/O`;
			}
		}
		const bps = await getDiskIoBytesPerSec(conn, serverId, matchDevice);
		return bps == null ? null : { text: ioRateText(bps), unit: def.unit, label };
	}

	const ids = await listInstanceMetrics(conn, serverId);

	switch (def.key) {
		case "cpu_percent": {
			const cpuId = ids.cpu;
			if (!cpuId) {
				return null;
			}
			const cpu = await getMeasureById(conn, cpuId, "rate:mean");
			if (!cpu) {
				return null;
			}
			// vcpus is used to convert to "whole-machine usage"; falls back to a single-core baseline when the vcpus metric is missing
			let vcpus = 1;
			if (ids.vcpus) {
				const v = await getMeasureById(conn, ids.vcpus);
				if (v && v.value > 0) {
					vcpus = v.value;
				}
			}
			const capacityNs = cpu.granularity * 1e9 * vcpus;
			const pct = Math.max(0, Math.min(100, capacityNs > 0 ? (cpu.value / capacityNs) * 100 : 0));
			return { text: percentText(pct), unit: def.unit, level: percentLevel(pct) };
		}

		case "mem_percent": {
			if (!ids["memory.usage"] || !ids.memory) {
				return null;
			}
			const [usage, total] = await Promise.all([
				getMeasureById(conn, ids["memory.usage"]),
				getMeasureById(conn, ids.memory),
			]);
			if (!usage || !total || total.value <= 0) {
				return null;
			}
			const pct = (usage.value / total.value) * 100;
			return { text: percentText(pct), unit: def.unit, level: percentLevel(pct) };
		}

		case "mem_usage": {
			if (!ids["memory.usage"]) {
				return null;
			}
			const usage = await getMeasureById(conn, ids["memory.usage"]);
			if (!usage) {
				return null;
			}
			// MB → GB
			return { text: (usage.value / 1024).toFixed(1), unit: def.unit };
		}

		case "vcpus": {
			if (!ids.vcpus) {
				return null;
			}
			const v = await getMeasureById(conn, ids.vcpus);
			return v ? { text: String(Math.round(v.value)), unit: def.unit } : null;
		}

		case "disk": {
			// Root disk (Gnocchi disk.root.size) + attached Cinder volumes; which of them
			// is shown depends on diskSelection ("all" / "root" / a volume id).
			// With boot-from-volume the flavor still reports disk.root.size, but that disk does not
			// exist — the boot disk is one of the attached volumes — so the root part is dropped.
			const rootId = ids["disk.root.size"];
			const [rootMeasure, volumes, server] = await Promise.all([
				rootId ? getMeasureById(conn, rootId) : Promise.resolve(null),
				getAttachedVolumes(conn, serverId),
				getServer(conn, serverId),
			]);
			const root = server.bootFromVolume ? null : rootMeasure;

			const selection = diskSelection?.trim() || "all";
			if (selection === "root") {
				return root ? { text: String(Math.round(root.value)), unit: def.unit, label: "Root Disk" } : null;
			}
			if (selection !== "all") {
				// A specific attached volume (returns null when it has been detached since)
				const v = volumes?.volumes.find((x) => x.id === selection);
				if (!v) {
					return null;
				}
				const device = v.device.split("/").pop() ?? "";
				return { text: String(v.sizeGb), unit: def.unit, label: device || v.name || "Volume" };
			}

			if (root == null && volumes == null) {
				return null;
			}
			const total = (root?.value ?? 0) + (volumes?.totalGb ?? 0);
			// The root disk counts as one only when it has real capacity
			const count = (root && root.value > 0 ? 1 : 0) + (volumes?.count ?? 0);
			// The disk count becomes the key title ("3 Disks"); the unit line stays a plain "GB"
			const label = count > 0 ? `${count} Disk${count === 1 ? "" : "s"}` : undefined;
			return { text: String(Math.round(total)), unit: def.unit, label };
		}

		default:
			return null;
	}
};
