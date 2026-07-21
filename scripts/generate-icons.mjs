/**
 * Generate the PNG icons the Stream Deck plugin needs, using canvas.
 * The style matches the actual buttons (src/rendering.ts): dark background #1f2937 + top label + divider + a bright central glyph.
 *
 *   - key (default button image, 72/144): full layout (dark background + label + divider + glyph)
 *   - icon (action list thumbnail, 20/40): a monochrome white glyph for Stream Deck to tint per theme
 *   - category-icon (28/56): monochrome white OpenStack logomark (Stream Deck tints it per theme)
 *   - marketplace (256/512): dark background + official OpenStack logomark
 *
 * Run: yarn icons
 */
import { createCanvas, loadImage } from "canvas";
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
};
const LABEL = { status: "Status", metric: "Usage", power: "Power" };

// Official OpenStack red + logomark path (single-path mark, viewBox 0 0 24 24).
const OPENSTACK_RED = "#ed1844";
const OPENSTACK_MARK =
	"M18.575 9.29h5.418v5.42h-5.418zM0 9.29h5.419v5.42H0zm18.575 7.827a1.207 1.207 0 0 1-1.206 1.206H6.623a1.207 1.207 0 0 1-1.205-1.206v-.858H0v5.252a2.236 2.236 0 0 0 2.229 2.23h19.53A2.237 2.237 0 0 0 24 21.512V16.26h-5.425zM21.763.258H2.233a2.236 2.236 0 0 0-2.23 2.23V7.74h5.419v-.858a1.206 1.206 0 0 1 1.205-1.206h10.746a1.206 1.206 0 0 1 1.205 1.206v.858H24V2.487A2.237 2.237 0 0 0 21.763.258Z";
// Rasterize at `px` (librsvg needs an explicit intrinsic size); use a large value so drawImage only ever downscales, staying crisp.
const openstackMarkSvg = (color, px = 512) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="${OPENSTACK_MARK}" fill="${color}"/></svg>`;

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
	}
	ctx.restore();
};

/**
 * @param variant "key" (dark background + label + glyph) | "mono" (transparent white glyph, for Stream Deck to tint)
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
		} else {
			// mono: transparent background + white glyph (for Stream Deck to tint)
			drawGlyph(ctx, s, type, "#ffffff", 0.5);
		}

		const outBase = resolve(pluginDir, base);
		if (!existsSync(dirname(outBase))) {
			mkdirSync(dirname(outBase), { recursive: true });
		}
		writeFileSync(`${outBase}${i === 0 ? "" : "@2x"}.png`, canvas.toBuffer("image/png"));
	}
	console.log(`✓ ${base}  (${sizes.join(" / ")})`);
};

/**
 * Render the official OpenStack logomark centered on a tile.
 * @param bg true → dark rounded background; false → transparent (monochrome, for Stream Deck to tint)
 */
const renderMark = async (base, sizes, { color, bg, ratio }) => {
	const mark = await loadImage(Buffer.from(openstackMarkSvg(color)));
	for (let i = 0; i < sizes.length; i++) {
		const s = sizes[i];
		const canvas = createCanvas(s, s);
		const ctx = canvas.getContext("2d");
		if (bg) drawBg(ctx, s);
		const m = s * ratio;
		const off = (s - m) / 2;
		ctx.drawImage(mark, off, off, m, m);
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
// category-icon: white logomark on transparent; marketplace: red logomark on the dark tile
await renderMark("imgs/plugin/category-icon", [28, 56], { color: "#ffffff", bg: false, ratio: 0.9 });
await renderMark("imgs/plugin/marketplace", [256, 512], { color: OPENSTACK_RED, bg: true, ratio: 0.586 });

console.log("Icon generation complete.");
