/**
 * Generate the PNG icons the Stream Deck plugin needs, using canvas.
 * The style matches the actual buttons (src/rendering.ts): dark background #1f2937 + top label + divider + a bright central glyph.
 *
 *   - key (default button image, 72/144): full layout (dark background + label + divider + glyph)
 *   - icon (action list thumbnail, 20/40): a monochrome white glyph for Stream Deck to tint per theme
 *   - category-icon (28/56): monochrome white glyph
 *   - marketplace (144/288): dark background + brand glyph
 *
 * Run: yarn icons
 */
import { createCanvas } from "canvas";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, "..", "com.phantas-weng.openstack.sdPlugin");

// Matches the color scheme in rendering.ts
const BG = "#1f2937";
const ACCENT = {
	status: "#34d399", // green
	metric: "#60a5fa", // blue
	power: "#34d399", // green
	brand: "#e8663c", // brand orange
};
const LABEL = { status: "Status", metric: "Usage", power: "Power" };

/** Dark rounded-corner background */
const drawBg = (ctx, s) => {
	const r = s * 0.153;
	ctx.fillStyle = BG;
	ctx.beginPath();
	ctx.moveTo(r, 0);
	ctx.arcTo(s, 0, s, s, r);
	ctx.arcTo(s, s, 0, s, r);
	ctx.arcTo(0, s, 0, 0, r);
	ctx.arcTo(0, 0, s, 0, r);
	ctx.fill();
};

/** Top label + divider */
const drawTopLabel = (ctx, s, label) => {
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = "rgba(255,255,255,0.92)";
	ctx.font = `600 ${Math.round(s * 0.16)}px sans-serif`;
	ctx.fillText(label, s / 2, s * 0.2, s * 0.86);
	ctx.strokeStyle = "rgba(255,255,255,0.24)";
	ctx.lineWidth = Math.max(1, s * 0.014);
	ctx.beginPath();
	ctx.moveTo(s * 0.2, s * 0.34);
	ctx.lineTo(s * 0.8, s * 0.34);
	ctx.stroke();
};

/**
 * Draw the glyph in unit-coordinate (0..1) space, using cyRatio as the vertical center.
 */
const drawGlyph = (ctx, s, type, color, cyRatio = 0.5) => {
	ctx.save();
	ctx.translate(0, (cyRatio - 0.5) * s);
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	const u = (v) => v * s;

	if (type === "status") {
		// heartbeat line
		ctx.lineWidth = s * 0.06;
		ctx.beginPath();
		ctx.moveTo(u(0.2), u(0.5));
		ctx.lineTo(u(0.37), u(0.5));
		ctx.lineTo(u(0.45), u(0.34));
		ctx.lineTo(u(0.56), u(0.66));
		ctx.lineTo(u(0.63), u(0.5));
		ctx.lineTo(u(0.8), u(0.5));
		ctx.stroke();
	} else if (type === "metric") {
		// bar chart
		const bars = [
			[0.26, 0.56],
			[0.44, 0.4],
			[0.62, 0.26],
		];
		const w = s * 0.1;
		for (const [x, top] of bars) {
			ctx.fillRect(u(x), u(top), w, u(0.72) - u(top));
		}
	} else if (type === "power") {
		// power symbol (ring + gap + vertical line)
		ctx.lineWidth = s * 0.06;
		ctx.beginPath();
		ctx.arc(u(0.5), u(0.52), u(0.2), -Math.PI / 2 + 0.5, -Math.PI / 2 - 0.5 + Math.PI * 2, false);
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(u(0.5), u(0.28));
		ctx.lineTo(u(0.5), u(0.52));
		ctx.stroke();
	} else if (type === "brand") {
		// cloud + server bars
		ctx.beginPath();
		ctx.arc(u(0.4), u(0.42), u(0.13), 0, Math.PI * 2);
		ctx.arc(u(0.58), u(0.4), u(0.16), 0, Math.PI * 2);
		ctx.fill();
		ctx.fillRect(u(0.3), u(0.48), u(0.4), u(0.06));
		ctx.fillRect(u(0.28), u(0.6), u(0.44), u(0.1));
		ctx.fillRect(u(0.28), u(0.74), u(0.44), u(0.1));
	}
	ctx.restore();
};

/**
 * @param variant "key" (dark background + label + glyph) | "mono" (transparent white glyph) | "brand" (dark background + brand glyph)
 */
const renderPng = (base, sizes, type, variant) => {
	for (let i = 0; i < sizes.length; i++) {
		const s = sizes[i];
		const canvas = createCanvas(s, s);
		const ctx = canvas.getContext("2d");

		if (variant === "key") {
			drawBg(ctx, s);
			drawTopLabel(ctx, s, LABEL[type]);
			drawGlyph(ctx, s, type, ACCENT[type], 0.64);
		} else if (variant === "brand") {
			drawBg(ctx, s);
			drawGlyph(ctx, s, "brand", ACCENT.brand, 0.5);
		} else {
			// mono: transparent background + white glyph (for Stream Deck to tint)
			drawGlyph(ctx, s, type === "category" ? "brand" : type, "#ffffff", 0.5);
		}

		const outBase = resolve(pluginDir, base);
		if (!existsSync(dirname(outBase))) {
			mkdirSync(dirname(outBase), { recursive: true });
		}
		writeFileSync(`${outBase}${i === 0 ? "" : "@2x"}.png`, canvas.toBuffer("image/png"));
	}
	console.log(`✓ ${base}  (${sizes.join(" / ")})`);
};

for (const type of ["status", "metric", "power"]) {
	renderPng(`imgs/actions/${type}/icon`, [20, 40], type, "mono"); // action list thumbnail
	renderPng(`imgs/actions/${type}/key`, [72, 144], type, "key"); // default button image
}
renderPng("imgs/plugin/category-icon", [28, 56], "category", "mono");
renderPng("imgs/plugin/marketplace", [144, 288], "brand", "brand");

console.log("Icon generation complete.");
