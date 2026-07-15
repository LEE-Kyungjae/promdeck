import { readFileSync } from "node:fs";

import { num } from "../coerce.js";
import type { ButtonSpec } from "../evaluate.js";

/**
 * One key on the deck.
 *
 * `key` is the physical index: 0 is top-left, increasing left-to-right then
 * down. Keys with no entry here are left blank.
 */
export type ButtonConfig = ButtonSpec & {
  key: number;
  refreshSec?: number;
};

export type Config = {
  promUrl: string;
  /** Applied to any button that does not set its own. */
  refreshSec: number;
  /** Deck brightness, 0-100. */
  brightness: number;
  buttons: ButtonConfig[];
};

const DEFAULTS = {
  promUrl: "http://127.0.0.1:9090",
  refreshSec: 10,
  brightness: 60,
};

export class ConfigError extends Error {}

/**
 * Loads and validates the config.
 *
 * Validation is strict and fails the whole process rather than skipping bad
 * entries. A daemon that silently drops a misconfigured key would leave a blank
 * button, and a blank button is indistinguishable from one that is simply
 * unassigned -- you would never notice the mistake.
 */
export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }

  const root = parsed as Record<string, unknown>;
  const promUrl = typeof root.promUrl === "string" && root.promUrl.trim() ? root.promUrl.trim() : DEFAULTS.promUrl;

  if (!/^https?:\/\//.test(promUrl)) {
    throw new ConfigError(`promUrl must start with http:// or https://, got "${promUrl}"`);
  }

  if (!Array.isArray(root.buttons)) {
    throw new ConfigError(`${path} must define a "buttons" array`);
  }

  const seen = new Map<number, string>();
  const buttons = root.buttons.map((entry, i) => parseButton(entry, i, seen));

  return {
    promUrl,
    refreshSec: num(root.refreshSec) ?? DEFAULTS.refreshSec,
    brightness: num(root.brightness) ?? DEFAULTS.brightness,
    buttons,
  };
}

function parseButton(entry: unknown, index: number, seen: Map<number, string>): ButtonConfig {
  const where = `buttons[${index}]`;

  if (typeof entry !== "object" || entry === null) {
    throw new ConfigError(`${where} must be an object`);
  }

  const b = entry as Record<string, unknown>;
  const key = num(b.key);

  if (key === undefined || !Number.isInteger(key) || key < 0) {
    throw new ConfigError(`${where}.key must be a non-negative integer`);
  }

  // Two entries on one key means one silently wins the race; that is a config
  // bug the user should hear about, not a coin flip.
  const clash = seen.get(key);
  if (clash !== undefined) {
    throw new ConfigError(`${where} and "${clash}" both target key ${key}`);
  }

  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) {
    throw new ConfigError(`${where}.title is required`);
  }
  seen.set(key, title);

  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (!query) {
    throw new ConfigError(`${where} ("${title}") needs a query`);
  }

  return {
    key,
    title,
    query,
    healthQuery: typeof b.healthQuery === "string" ? b.healthQuery.trim() : undefined,
    downText: typeof b.downText === "string" ? b.downText.trim() : undefined,
    unit: typeof b.unit === "string" ? b.unit : "",
    decimals: num(b.decimals),
    warn: num(b.warn),
    crit: num(b.crit),
    invert: b.invert === true,
    sparkQuery: typeof b.sparkQuery === "string" ? b.sparkQuery.trim() : undefined,
    sparkRange: typeof b.sparkRange === "string" ? b.sparkRange.trim() : undefined,
    refreshSec: num(b.refreshSec),
  };
}
