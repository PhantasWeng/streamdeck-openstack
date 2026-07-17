/**
 * OpenStack connection settings (global settings) — manually get/set via the
 * property inspector lifecycle, without using sdpi-components' `global` auto-binding.
 *
 * Usage: place a placeholder element <div id="openstack-connection"></div> in the PI,
 * and include this file after sdpi-components.js. The script will:
 *   1. Inject the connection fields (authUrl / credential / region / dashboard) and styles
 *   2. Backfill the fields via getGlobalSettings() when the PI loads
 *   3. Write back via setGlobalSettings() when fields change (debounced)
 *   4. Subscribe to didReceiveGlobalSettings to sync fields when another PI changes them
 *
 * Connection settings are shared across all buttons, so they are stored in global settings.
 */
(() => {
	/** Field definitions for global settings (keys map to OpenStackConnection in src/settings.ts) */
	const FIELDS = [
		{ key: "authUrl", label: "Keystone URL", type: "text", placeholder: "http://<keystone-host>:5000/v3" },
		{ key: "applicationCredentialId", label: "Credential ID", type: "text", placeholder: "application credential id" },
		{ key: "applicationCredentialSecret", label: "Credential Secret", type: "password", placeholder: "application credential secret" },
		{ key: "regionName", label: "Region", type: "text", placeholder: "RegionOne (optional)" },
		{ key: "dashboardBase", label: "Dashboard URL", type: "text", placeholder: "https://<horizon-host>/dashboard" },
	];

	const SAVE_DEBOUNCE_MS = 400;

	const client = () => window.SDPIComponents && window.SDPIComponents.streamDeckClient;
	const fieldEl = (key) => document.getElementById(`osg-${key}`);

	/** Inject styles + field HTML into the placeholder element */
	const render = (mount) => {
		const style = document.createElement("style");
		style.textContent = `
			.osg-item { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; font-family: var(--font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif); }
			.osg-item > label { flex: 0 0 108px; text-align: right; color: #a8a8a8; }
			.osg-item > input {
				flex: 1 1 auto; min-width: 0; padding: 5px 7px; border-radius: 4px;
				border: 1px solid #3a3a3a; background: #2d2d2d; color: #fff; font-size: 13px;
				font-family: inherit;
			}
			.osg-item > input::placeholder { color: #6a6a6a; }
			.osg-item > input:focus { outline: none; border-color: #5aa0f2; }
			.osg-note { color: #888; font-size: 12px; line-height: 1.5; margin: 4px 0 2px 116px; font-family: var(--font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif); }
			.osg-emoji { font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }
		`;
		mount.appendChild(style);

		for (const f of FIELDS) {
			const item = document.createElement("div");
			item.className = "osg-item";
			const label = document.createElement("label");
			label.textContent = f.label;
			label.setAttribute("for", `osg-${f.key}`);
			const input = document.createElement("input");
			input.id = `osg-${f.key}`;
			input.type = f.type;
			input.placeholder = f.placeholder;
			if (f.type === "password") {
				input.autocomplete = "off";
			}
			item.appendChild(label);
			item.appendChild(input);
			mount.appendChild(item);
		}

		const note = document.createElement("div");
		note.className = "osg-note";
		const noteIcon = document.createElement("span");
		noteIcon.className = "osg-emoji";
		noteIcon.textContent = "⚠️";
		note.appendChild(noteIcon);
		note.appendChild(
			document.createTextNode(
				" Credentials are stored in plain text in the Stream Deck settings. Connection settings are shared across all three buttons, so you only need to fill them in once.",
			),
		);
		mount.appendChild(note);
	};

	/** Backfill fields from settings (without overwriting the field the user is editing) */
	const fill = (settings) => {
		const s = settings || {};
		for (const f of FIELDS) {
			const el = fieldEl(f.key);
			if (el && document.activeElement !== el) {
				el.value = s[f.key] != null ? s[f.key] : "";
			}
		}
	};

	/** lifecycle: read global settings and backfill */
	const load = async () => {
		const c = client();
		if (!c) {
			return;
		}
		try {
			fill(await c.getGlobalSettings());
		} catch (e) {
			console.error("[openstack-global] getGlobalSettings failed", e);
		}
	};

	/** lifecycle: write field contents back to global settings (preserving other existing keys) */
	const save = async () => {
		const c = client();
		if (!c) {
			return;
		}
		let current = {};
		try {
			current = (await c.getGlobalSettings()) || {};
		} catch {
			current = {};
		}
		for (const f of FIELDS) {
			const el = fieldEl(f.key);
			if (el) {
				current[f.key] = el.value.trim();
			}
		}
		c.setGlobalSettings(current);
	};

	let saveTimer;
	const scheduleSave = () => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
	};

	const init = () => {
		const mount = document.getElementById("openstack-connection");
		if (!mount) {
			return;
		}
		render(mount);

		for (const f of FIELDS) {
			const el = fieldEl(f.key);
			if (!el) {
				continue;
			}
			el.addEventListener("input", scheduleSave);
			el.addEventListener("change", save);
		}

		const c = client();
		if (c && c.didReceiveGlobalSettings && typeof c.didReceiveGlobalSettings.subscribe === "function") {
			// Sync fields when another PI changes the global settings
			c.didReceiveGlobalSettings.subscribe((e) => fill(e && e.payload && e.payload.settings));
		}
		load();
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
