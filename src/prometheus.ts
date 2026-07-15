/**
 * Minimal Prometheus HTTP API client.
 *
 * Only the two endpoints the plugin needs are implemented: instant queries for
 * the headline number, and range queries for the sparkline.
 */

export type Sample = { t: number; v: number };

export class PrometheusError extends Error {}

/** Distinguishes "Prometheus is unreachable" from "the query returned nothing". */
export class PrometheusUnreachable extends PrometheusError {}

type InstantResponse = {
  status: string;
  error?: string;
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; value: [number, string] }>;
  };
};

type RangeResponse = {
  status: string;
  error?: string;
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
  };
};

async function call<T>(baseUrl: string, path: string, params: URLSearchParams, timeoutMs: number): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // Connection refused, DNS failure, timeout: the tunnel or Prometheus is down.
    throw new PrometheusUnreachable(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    throw new PrometheusError(`HTTP ${res.status}`);
  }

  const body = (await res.json()) as T & { status: string; error?: string };
  if (body.status !== "success") {
    throw new PrometheusError(body.error ?? "query failed");
  }
  return body;
}

/**
 * Runs an instant query and returns the first sample's value.
 * Returns `null` when the query is valid but matches no series — that is a
 * meaningful state (e.g. the target disappeared), not an error.
 */
export async function instant(baseUrl: string, query: string, timeoutMs = 4000): Promise<number | null> {
  const body = await call<InstantResponse>(baseUrl, "/api/v1/query", new URLSearchParams({ query }), timeoutMs);

  const first = body.data?.result?.[0];
  if (!first) {
    return null;
  }

  const value = Number(first.value[1]);
  return Number.isNaN(value) ? null : value;
}

/**
 * Runs a range query over the trailing `rangeSec` window for the sparkline.
 * `step` is derived so the series stays near `points` samples regardless of
 * the window, keeping the payload small.
 */
export async function range(
  baseUrl: string,
  query: string,
  rangeSec: number,
  points = 32,
  timeoutMs = 4000,
): Promise<Sample[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - rangeSec;
  const step = Math.max(1, Math.floor(rangeSec / points));

  const body = await call<RangeResponse>(
    baseUrl,
    "/api/v1/query_range",
    new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      step: String(step),
    }),
    timeoutMs,
  );

  const first = body.data?.result?.[0];
  if (!first) {
    return [];
  }

  return first.values
    .map(([t, v]) => ({ t, v: Number(v) }))
    .filter((s) => !Number.isNaN(s.v));
}

/** Parses a Prometheus-style duration ("30m", "2h", "90s") into seconds. */
export function parseDuration(input: string, fallbackSec: number): number {
  const match = /^(\d+)([smhd])$/.exec(input.trim());
  if (!match) {
    return fallbackSec;
  }

  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]] ?? 1;
  return amount * multiplier;
}
