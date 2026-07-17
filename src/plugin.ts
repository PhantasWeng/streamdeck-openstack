import streamDeck from "@elgato/streamdeck";

import { InstanceMetric, InstancePower, InstanceStatus, refreshAll } from "./actions/instance";
import { initConnection, primeConnection } from "./connection";

// Use info in production to prevent logs from growing over long-running polling; for debugging, switch to "debug" / "trace"
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new InstanceStatus());
streamDeck.actions.registerAction(new InstanceMetric());
streamDeck.actions.registerAction(new InstancePower());

// Initialize the connection cache: subscribe to global settings changes → update the cache and refresh all keys.
// Note: poll does not call getGlobalSettings directly (to avoid a didReceiveGlobalSettings event cascade causing wild flicker).
initConnection(refreshAll);

streamDeck.connect();

// After the connection is established, fetch the initial global settings once
primeConnection();
