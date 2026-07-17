/**
 * Cache of the global connection settings (global settings).
 *
 * ⚠️ Important: do not call streamDeck.settings.getGlobalSettings() inside polling.
 * getGlobalSettings() responds via the didReceiveGlobalSettings event, which also triggers
 * the onDidReceiveGlobalSettings listener; if that listener indirectly triggers getGlobalSettings()
 * again, it causes an infinite cascade (the key images flicker wildly).
 *
 * So instead: the module maintains a single connection cache, updated only by the
 * onDidReceiveGlobalSettings event (using the settings carried by the event, without calling get again),
 * and poll simply reads the cache synchronously.
 */
import streamDeck from "@elgato/streamdeck";

import type { OpenStackConnection } from "./settings";

let cached: OpenStackConnection = {};

/** Synchronously get the current connection settings cache */
export const getCachedConnection = (): OpenStackConnection => cached;

/**
 * Subscribe to global settings changes (must be called before streamDeck.connect()).
 * @param onChange callback invoked when the connection settings change (used to refresh all keys)
 */
export const initConnection = (onChange: () => void): void => {
	streamDeck.settings.onDidReceiveGlobalSettings<OpenStackConnection>((ev) => {
		cached = ev.settings ?? {};
		onChange();
	});
};

/**
 * Actively fetch the initial connection settings once (must be called after streamDeck.connect()).
 * This triggers the onDidReceiveGlobalSettings listener once (setting the cache + refreshing).
 */
export const primeConnection = (): void => {
	void streamDeck.settings.getGlobalSettings<OpenStackConnection>();
};
