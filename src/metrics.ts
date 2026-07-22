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
	getDiskIoSeriesBytesPerSec,
	getMeasureById,
	getMeasureSeries,
	getNetworkIoSeriesBytesPerSec,
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

/**
 * Selectable display items. `label` is the default button title; it deliberately omits the unit
 * (GB / % / I/O) because the unit already shows on the key — "Memory" + "GB" reads cleaner than
 * "Memory GB" + "GB". The PI dropdown uses its own descriptive option text, so picking is still clear.
 */
export const METRIC_CATALOG: MetricDef[] = [
	{ key: "cpu_percent", label: "CPU", unit: "%" },
	{ key: "mem_percent", label: "Memory", unit: "%" },
	{ key: "mem_usage", label: "Memory", unit: "GB" },
	{ key: "vcpus", label: "vCPU", unit: "" },
	{ key: "disk", label: "Disk", unit: "GB" },
	{ key: "disk_io", label: "Disk", unit: "MB/s" },
	{ key: "net_io", label: "Network", unit: "MB/s" },
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
	/**
	 * Recent history (oldest → newest) in the metric's own display scale, used to draw a sparkline.
	 * Present for time-varying items (cpu%, memory%, memory GB, disk I/O, network I/O); undefined for
	 * items where a trend line is meaningless (disk size, vCPU).
	 */
	series?: number[];
};

const percentText = (pct: number): string => (pct < 10 ? pct.toFixed(1) : String(Math.round(pct)));

/** Clamp a percentage into 0–100 */
const clampPct = (pct: number): number => Math.max(0, Math.min(100, pct));

/** Bytes/sec → MB/s (the scale used for the I/O sparkline series) */
const bpsToMbps = (bps: number): number => bps / (1024 * 1024);

/** Format an I/O rate (bytes/sec) as MB/s text */
const ioRateText = (bps: number): string => {
	const mbps = bpsToMbps(bps);
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
		const seriesBps = await getNetworkIoSeriesBytesPerSec(conn, serverId);
		if (!seriesBps?.length) {
			return null;
		}
		const currentBps = seriesBps[seriesBps.length - 1];
		return { text: ioRateText(currentBps), unit: def.unit, series: seriesBps.map(bpsToMbps) };
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
				label = "Root";
			} else {
				const device = deviceTail(volumes.find((v) => v.id === selection)?.device ?? "");
				if (!device) {
					return null;
				}
				matchDevice = (name) => matches(name, device);
				label = device;
			}
		}
		const seriesBps = await getDiskIoSeriesBytesPerSec(conn, serverId, matchDevice);
		if (!seriesBps?.length) {
			return null;
		}
		const currentBps = seriesBps[seriesBps.length - 1];
		return { text: ioRateText(currentBps), unit: def.unit, label, series: seriesBps.map(bpsToMbps) };
	}

	const ids = await listInstanceMetrics(conn, serverId);

	switch (def.key) {
		case "cpu_percent": {
			const cpuId = ids.cpu;
			if (!cpuId) {
				return null;
			}
			const cpuSeries = await getMeasureSeries(conn, cpuId, "rate:mean");
			if (!cpuSeries.length) {
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
			// Each sample carries its own granularity; capacity = granularity(s) × vcpus × 1e9 ns
			const series = cpuSeries.map((s) => {
				const capacityNs = s.granularity * 1e9 * vcpus;
				return clampPct(capacityNs > 0 ? (s.value / capacityNs) * 100 : 0);
			});
			const pct = series[series.length - 1];
			return { text: percentText(pct), unit: def.unit, level: percentLevel(pct), series };
		}

		case "mem_percent": {
			if (!ids["memory.usage"] || !ids.memory) {
				return null;
			}
			// Total RAM (flavor memory) is effectively constant, so only the usage series varies:
			// pct[i] = usage[i] / total × 100
			const [usageSeries, total] = await Promise.all([
				getMeasureSeries(conn, ids["memory.usage"]),
				getMeasureById(conn, ids.memory),
			]);
			if (!usageSeries.length || !total || total.value <= 0) {
				return null;
			}
			const series = usageSeries.map((s) => clampPct((s.value / total.value) * 100));
			const pct = series[series.length - 1];
			return { text: percentText(pct), unit: def.unit, level: percentLevel(pct), series };
		}

		case "mem_usage": {
			if (!ids["memory.usage"]) {
				return null;
			}
			const usageSeries = await getMeasureSeries(conn, ids["memory.usage"]);
			if (!usageSeries.length) {
				return null;
			}
			// MB → GB
			const series = usageSeries.map((s) => s.value / 1024);
			const current = series[series.length - 1];
			return { text: current.toFixed(1), unit: def.unit, series };
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
				return root ? { text: String(Math.round(root.value)), unit: def.unit, label: "Root" } : null;
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
