import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { MetricAction } from "./actions/metric.js";

streamDeck.logger.setLevel(LogLevel.INFO);

streamDeck.actions.registerAction(new MetricAction());

// Not awaited: the bundle is emitted as CommonJS for the Stream Deck host,
// which has no top-level await.
void streamDeck.connect();
