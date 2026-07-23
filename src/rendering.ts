/**
 * Draw key images with canvas: status badge, metric value, power key, message.
 * The entire key is drawn into the image (including text), rather than relying on Stream Deck's title rendering.
 */
import { type CanvasRenderingContext2D, createCanvas } from "canvas";

import type { MetricLevel } from "./metrics";

const SIZE = 144;
const RADIUS = 22;

const COLOR = {
	idleBg: "#2f333c",
	label: "rgba(255,255,255,0.92)",
	idleLabel: "#8b95a3",
	valueText: "#ffffff",
	messageBg: "#2f333c",
	messageText: "#e6ebf2",
	messageAccent: "#e8663c",
};

/** Unified semantic bright colors (for a dark background, used to tint the central text/icon) */
const ACCENT = {
	green: "#34d399",
	yellow: "#fbbf24",
	red: "#f87171",
	gray: "#8b95a3",
	purple: "#a78bfa",
	blue: "#60a5fa",
};

/** instance status → primary color (drawn on the central text, not a full background fill). Unlisted values use neutral gray. */
const STATUS_COLOR: Record<string, string> = {
	ACTIVE: ACCENT.green, // running
	SHUTOFF: ACCENT.gray, // stopped
	ERROR: ACCENT.red, // error
	BUILD: ACCENT.yellow, // building
	REBOOT: ACCENT.yellow,
	HARD_REBOOT: ACCENT.yellow,
	PAUSED: ACCENT.purple, // paused
	SUSPENDED: ACCENT.purple,
	SHELVED: ACCENT.gray,
	SHELVED_OFFLOADED: ACCENT.gray,
	MIGRATING: ACCENT.yellow,
	RESIZE: ACCENT.yellow,
	VERIFY_RESIZE: ACCENT.yellow,
};

/** Short display text for statuses; unlisted values are shown as-is */
const STATUS_LABEL: Record<string, string> = {
	ACTIVE: "Running",
	SHUTOFF: "Stopped",
	ERROR: "Error",
	BUILD: "Building",
	REBOOT: "Rebooting",
	HARD_REBOOT: "Rebooting",
	PAUSED: "Paused",
	SUSPENDED: "Suspended",
	MIGRATING: "Migrating",
};

const roundRectPath = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
};

const newCanvas = (): { canvas: ReturnType<typeof createCanvas>; ctx: CanvasRenderingContext2D } => {
	const canvas = createCanvas(SIZE, SIZE);
	const ctx = canvas.getContext("2d");
	return { canvas, ctx };
};

const drawBackground = (ctx: CanvasRenderingContext2D, color: string): void => {
	ctx.fillStyle = color;
	roundRectPath(ctx, 0, 0, SIZE, SIZE, RADIUS);
	ctx.fill();
};

const drawTopLabel = (ctx: CanvasRenderingContext2D, label: string, active: boolean): void => {
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = active ? COLOR.label : COLOR.idleLabel;
	ctx.font = "600 22px sans-serif";
	ctx.fillText(label, SIZE / 2, 30, SIZE - 16);
	ctx.strokeStyle = active ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.10)";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(28, 50);
	ctx.lineTo(SIZE - 28, 50);
	ctx.stroke();
};

/** Font size by text length: more characters means smaller, to avoid overflow */
const cjkFontSize = (text: string): number => (text.length <= 2 ? 40 : text.length === 3 ? 34 : 28);

/**
 * Status key: dark background + top label + divider + central status text (tinted by status).
 * Shares the same skeleton as the metric/power keys.
 */
export const renderStatus = (label: string, status: string): string => {
	const { canvas, ctx } = newCanvas();
	drawBackground(ctx, "#1f2937");
	drawTopLabel(ctx, label, true);

	const text = STATUS_LABEL[status] ?? status;
	ctx.fillStyle = STATUS_COLOR[status] ?? COLOR.valueText;
	ctx.font = `700 ${cjkFontSize(text)}px sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, SIZE / 2, 100, SIZE - 24);
	return canvas.toDataURL();
};

/** Usage level → value color (low=green, mid=yellow, high=red) */
const LEVEL_COLOR: Record<MetricLevel, string> = {
	low: ACCENT.green,
	mid: ACCENT.yellow,
	high: ACCENT.red,
};

/**
 * metric key: top label + large value + unit.
 * @param valueText the formatted value string (e.g. "37", "1.2G")
 * @param unit the unit (e.g. "%", "MB/s"), placed below the value
 * @param level usage level; when present, the number is tinted by low/mid/high (green/yellow/red); without it, the default white is used
 */
export const renderMetric = (label: string, valueText: string, unit: string, level?: MetricLevel): string => {
	const { canvas, ctx } = newCanvas();
	drawBackground(ctx, "#1f2937");
	drawTopLabel(ctx, label, true);

	// The number uses a fixed font size (consistent across keys); when too long, maxWidth compresses the glyph width without changing height
	ctx.fillStyle = level ? LEVEL_COLOR[level] : COLOR.valueText;
	ctx.font = "700 48px sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	// The number is placed slightly below center, keeping distance from the top label
	ctx.fillText(valueText, SIZE / 2, unit ? 88 : 98, SIZE - 20);

	if (unit) {
		// The unit sits below the number but keeps a margin from the bottom edge (not flush)
		ctx.fillStyle = COLOR.idleLabel;
		ctx.font = "600 18px sans-serif";
		ctx.fillText(unit, SIZE / 2, 126, SIZE - 16);
	}
	return canvas.toDataURL();
};

/** Power icon (circle + vertical line with a gap at the top), centered at (cx, cy) */
const drawPowerIcon = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void => {
	ctx.strokeStyle = color;
	ctx.lineWidth = 6;
	ctx.lineCap = "round";
	// Ring (with a gap at the top)
	ctx.beginPath();
	ctx.arc(cx, cy, r, -Math.PI / 2 + 0.5, -Math.PI / 2 - 0.5 + Math.PI * 2, false);
	ctx.stroke();
	// Vertical line
	ctx.beginPath();
	ctx.moveTo(cx, cy - r - 4);
	ctx.lineTo(cx, cy);
	ctx.stroke();
};

/** The "action a press would run" that the power key displays */
export type PowerActionKind = "start" | "stop" | "reboot" | "busy";

/** action → bottom text and color (conveys the effect of a click) */
const POWER_ACTION: Record<PowerActionKind, { text: string; color: string }> = {
	start: { text: "Start", color: ACCENT.green },
	stop: { text: "Stop", color: ACCENT.red },
	reboot: { text: "Reboot", color: ACCENT.yellow },
	busy: { text: "Busy", color: ACCENT.gray },
};

/**
 * Power key: dark background + top label + divider + central power icon + bottom "action a press would run".
 * The text conveys the effect of a click (start/stop/reboot), with matching colors (green/red/yellow); shows "busy" while in progress.
 * Shares the same skeleton as the metric/status keys.
 */
export const renderPower = (label: string, action: PowerActionKind): string => {
	const { canvas, ctx } = newCanvas();
	drawBackground(ctx, "#1f2937");
	drawTopLabel(ctx, label, true);

	const { text, color } = POWER_ACTION[action];
	drawPowerIcon(ctx, SIZE / 2, 88, 15, color);

	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = color;
	ctx.font = "600 18px sans-serif";
	ctx.fillText(text, SIZE / 2, 126, SIZE - 16);
	return canvas.toDataURL();
};

/** Usage level → sparkline color; series without a level (e.g. Memory GB) fall back to blue */
const sparklineColor = (level?: MetricLevel): string => (level ? LEVEL_COLOR[level] : ACCENT.blue);

/** Trim text with a trailing ellipsis so it fits within maxWidth under the current ctx.font */
const truncateToWidth = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string => {
	if (maxWidth <= 0) {
		return "";
	}
	if (ctx.measureText(text).width <= maxWidth) {
		return text;
	}
	let t = text;
	while (t.length > 0 && ctx.measureText(`${t}…`).width > maxWidth) {
		t = t.slice(0, -1);
	}
	return t.length ? `${t}…` : "";
};

/**
 * Draw the trend line (with faint area fill and an emphasized latest point) into the given plot box.
 * Shared by the chart-dominant key and the number+mini-chart key.
 */
const drawSparkPath = (
	ctx: CanvasRenderingContext2D,
	series: number[],
	color: string,
	box: { x0: number; x1: number; yTop: number; yBot: number },
	lineWidth: number,
): void => {
	const { x0, x1, yTop, yBot } = box;
	const min = Math.min(...series);
	const max = Math.max(...series);
	const flat = max === min;
	const n = series.length;
	const px = (i: number): number => (n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
	// Flat series sit on a centered line; otherwise map min→bottom, max→top
	const py = (v: number): number => (flat ? (yTop + yBot) / 2 : yBot - (yBot - yTop) * ((v - min) / (max - min)));

	const trace = (): void => {
		ctx.beginPath();
		series.forEach((v, i) => {
			const x = px(i);
			const y = py(v);
			if (i === 0) {
				ctx.moveTo(x, y);
			} else {
				ctx.lineTo(x, y);
			}
		});
	};

	// Filled area under the line (faint)
	trace();
	ctx.save();
	ctx.lineTo(px(n - 1), yBot);
	ctx.lineTo(px(0), yBot);
	ctx.closePath();
	ctx.globalAlpha = 0.16;
	ctx.fillStyle = color;
	ctx.fill();
	ctx.restore();

	// The line itself
	trace();
	ctx.strokeStyle = color;
	ctx.lineWidth = lineWidth;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	ctx.stroke();

	// Emphasize the latest point
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(px(n - 1), py(series[n - 1]), lineWidth + 0.5, 0, Math.PI * 2);
	ctx.fill();
};

/**
 * Chart-dominant metric key: a trend line filling the key, with a compact label (top-left) and the
 * current value (top-right). The value is measured first and the label is truncated to the space
 * that remains, so the two never overlap regardless of label length.
 *
 * @param label     metric label drawn top-left (truncated with an ellipsis when too long)
 * @param valueText the current formatted value (top-right)
 * @param unit      unit appended to the current value (e.g. "%", "GB")
 * @param series    recent values, oldest → newest (needs at least 2 points to form a line)
 * @param level     usage level; tints the line/value (low/mid/high → green/yellow/red), else blue
 */
export const renderSparkline = (
	label: string,
	valueText: string,
	unit: string,
	series: number[],
	level?: MetricLevel,
): string => {
	const { canvas, ctx } = newCanvas();
	drawBackground(ctx, "#1f2937");
	const color = sparklineColor(level);

	// Header: current value (right) is laid out first; its width reserves space so the label can
	// take the rest and be truncated if needed — this is what prevents the two from overlapping.
	const LEFT = 12;
	const RIGHT = SIZE - 12;
	const GAP = 8;
	const HEADER_Y = 22;
	ctx.textBaseline = "middle";

	// Value block (right-aligned): the number in the accent color, the unit smaller and muted beside it.
	// A smaller unit keeps the block narrow so wide units (e.g. "MB/s") don't crowd out the label.
	ctx.textAlign = "right";
	let valueBlockWidth = 0;
	if (unit) {
		ctx.font = "600 12px sans-serif";
		ctx.fillStyle = COLOR.idleLabel;
		ctx.fillText(unit, RIGHT, HEADER_Y + 1);
		valueBlockWidth += ctx.measureText(unit).width + 3;
	}
	ctx.font = "700 18px sans-serif";
	ctx.fillStyle = color;
	ctx.fillText(valueText, RIGHT - valueBlockWidth, HEADER_Y);
	valueBlockWidth += ctx.measureText(valueText).width;

	ctx.font = "600 14px sans-serif";
	ctx.fillStyle = COLOR.idleLabel;
	ctx.textAlign = "left";
	ctx.fillText(truncateToWidth(ctx, label, RIGHT - valueBlockWidth - GAP - LEFT), LEFT, HEADER_Y);

	drawSparkPath(ctx, series, color, { x0: LEFT, x1: RIGHT, yTop: 50, yBot: SIZE - 14 }, 3);
	return canvas.toDataURL();
};

/**
 * Number + mini-chart metric key: the top label and a large value (as in renderMetric), plus a small
 * trend strip along the bottom. A middle ground between the plain number and the chart-dominant key.
 */
export const renderMetricWithSparkline = (
	label: string,
	valueText: string,
	unit: string,
	series: number[],
	level?: MetricLevel,
): string => {
	const { canvas, ctx } = newCanvas();
	drawBackground(ctx, "#1f2937");
	drawTopLabel(ctx, label, true);
	const color = sparklineColor(level);

	// Value + inline unit, sitting above the trend strip
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = level ? LEVEL_COLOR[level] : COLOR.valueText;
	ctx.font = "700 40px sans-serif";
	ctx.fillText(valueText, SIZE / 2, 82, SIZE - 20);
	if (unit) {
		ctx.fillStyle = COLOR.idleLabel;
		ctx.font = "600 15px sans-serif";
		ctx.fillText(unit, SIZE / 2, 108, SIZE - 16);
	}

	// Mini trend strip along the bottom
	drawSparkPath(ctx, series, color, { x0: 12, x1: SIZE - 12, yTop: 118, yBot: SIZE - 12 }, 2);
	return canvas.toDataURL();
};

/**
 * Transitional metric key: the (new) label on top plus three dots, shown the instant a disk-cycle
 * press switches the selection — so the switch reads as immediate while the real value loads.
 */
export const renderMetricLoading = (label: string): string => {
	const { canvas, ctx } = newCanvas();
	drawBackground(ctx, "#1f2937");
	drawTopLabel(ctx, label, true);

	const cy = 96;
	const r = 5;
	const gap = 18;
	for (let i = -1; i <= 1; i++) {
		ctx.beginPath();
		ctx.arc(SIZE / 2 + i * gap, cy, r, 0, Math.PI * 2);
		ctx.fillStyle = i === 0 ? COLOR.label : COLOR.idleLabel;
		ctx.fill();
	}
	return canvas.toDataURL();
};

/**
 * Status message key (e.g. "Set up connection", "Auth failed"), centered multi-line text.
 */
export const renderMessage = (lines: string[]): string => {
	const { canvas, ctx } = newCanvas();
	drawBackground(ctx, COLOR.messageBg);

	ctx.fillStyle = COLOR.messageAccent;
	ctx.beginPath();
	ctx.arc(SIZE / 2, 40, 6, 0, Math.PI * 2);
	ctx.fill();

	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = COLOR.messageText;
	ctx.font = "600 24px sans-serif";
	const lineHeight = 36;
	const startY = SIZE / 2 + 16 - ((lines.length - 1) * lineHeight) / 2;
	lines.forEach((line, i) => {
		ctx.fillText(line, SIZE / 2, startY + i * lineHeight, SIZE - 16);
	});
	return canvas.toDataURL();
};
