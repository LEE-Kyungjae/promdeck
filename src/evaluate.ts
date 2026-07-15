/**
 * Turning a button's queries into a drawable face.
 *
 * Shared by both hosts: the Elgato plugin and the headless daemon differ only
 * in how they talk to the device, not in what a button means.
 */

import { instant, parseDuration, PrometheusUnreachable, range, type Sample } from "./prometheus.js";
import { classify, type ButtonModel, type Status } from "./render.js";

export type ButtonSpec = {
  title: string;
  query: string;
  /**
   * Optional gate. When it resolves to 0 the button renders as down,
   * whatever `query` says.
   *
   * One query cannot express both "is it reachable" and "how fast is it".
   * A failed blackbox probe still reports a `probe_duration_seconds` -- how
   * long the failure took -- so a latency button alone would show a confident
   * number for a site that is off the air. Pair the latency with
   * `probe_success` here and the number stays honest.
   */
  healthQuery?: string;
  /** Shown instead of the value when `healthQuery` says down. */
  downText?: string;
  unit?: string;
  decimals?: number;
  warn?: number;
  crit?: number;
  invert?: boolean;
  sparkQuery?: string;
  sparkRange?: string;
};

const DEFAULT_SPARK_RANGE = "30m";
const DEFAULT_DOWN_TEXT = "DOWN";

/** Evaluates a button and returns the face to draw. Never throws. */
export async function evaluate(promUrl: string, spec: ButtonSpec): Promise<ButtonModel> {
  const base = {
    title: spec.title,
    unit: spec.unit ?? "",
    decimals: spec.decimals ?? 1,
  };

  if (!spec.query.trim()) {
    return { ...base, unit: "", decimals: 0, value: null, status: "unknown", samples: [], overrideText: "SET Q" };
  }

  try {
    if (spec.healthQuery?.trim()) {
      const health = await instant(promUrl, spec.healthQuery);
      // Absent is not healthy: a probe that reports nothing at all is not
      // evidence of a working service.
      if (health === null || health === 0) {
        return {
          ...base,
          unit: "",
          decimals: 0,
          value: null,
          status: "crit",
          samples: [],
          overrideText: spec.downText ?? DEFAULT_DOWN_TEXT,
        };
      }
    }

    const value = await instant(promUrl, spec.query);
    const samples = await sparkline(promUrl, spec);

    return {
      ...base,
      value,
      status: classify(value, spec.warn, spec.crit, spec.invert ?? false),
      samples,
    };
  } catch (err) {
    return { ...base, ...failure(err), title: spec.title };
  }
}

function failure(err: unknown): Pick<ButtonModel, "value" | "status" | "samples" | "overrideText" | "unit" | "decimals"> {
  // A dead network path and a dead service look identical if both just go grey,
  // so name the difference on the key itself.
  const unreachable = err instanceof PrometheusUnreachable;
  return {
    unit: "",
    decimals: 0,
    value: null,
    status: unreachable ? ("unknown" as Status) : ("crit" as Status),
    samples: [],
    overrideText: unreachable ? "NO CONN" : "ERR",
  };
}

async function sparkline(promUrl: string, spec: ButtonSpec): Promise<Sample[]> {
  const query = spec.sparkQuery?.trim() || spec.query;
  const rangeSec = parseDuration(spec.sparkRange ?? DEFAULT_SPARK_RANGE, 1800);

  try {
    return await range(promUrl, query, rangeSec);
  } catch {
    // The headline number is the point; a missing sparkline should not blank an
    // otherwise healthy key.
    return [];
  }
}

/** True when the evaluation could not reach Prometheus at all. */
export function isDisconnected(model: ButtonModel): boolean {
  return model.overrideText === "NO CONN";
}
