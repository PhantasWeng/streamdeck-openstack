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
