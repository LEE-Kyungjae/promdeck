/**
 * Button rendering.
 *
 * Everything is drawn as SVG against a fixed 144x144 viewBox and handed to the
 * Stream Deck as a data URI. The host rasterises it to whatever the attached
 * hardware actually uses (72px on a Mini/MK.2, 96px on an XL, 120px on a
 * Stream Deck +), so no key dimension is ever hard-coded here. Adding support
 * for a new device is a no-op.
 */

import type { Sample } from "./prometheus.js";

export type Status = "ok" | "warn" | "crit" | "unknown";

const PALETTE: Record<Status, { bg: string; fg: string; accent: string; muted: string }> = {
  ok: { bg: "#12261a", fg: "#e8f5ec", accent: "#3ddc84", muted: "#7fa98d" },
  warn: { bg: "#2e2410", fg: "#fdf3e0", accent: "#f5b544", muted: "#b39a6b" },
  crit: { bg: "#2e1416", fg: "#ffeaec", accent: "#ff4d5e", muted: "#b8808a" },
  unknown: { bg: "#1c1c1f", fg: "#9a9aa2", accent: "#55555e", muted: "#6b6b74" },
};

const VIEWBOX = 144;

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Picks a font size that keeps `text` inside the key.
 * The glyphs are roughly 0.62em wide in the DejaVu-ish default face, so this
 * approximates the rendered width rather than measuring it — good enough to
 * stop long values from bleeding off the edge.
 */
function fitFontSize(text: string, maxWidth: number, preferred: number, min: number): number {
  const estimated = text.length * preferred * 0.62;
  if (estimated <= maxWidth) {
    return preferred;
  }
  return Math.max(min, Math.floor((maxWidth / (text.length * 0.62)) * 10) / 10);
}

/** Formats a raw metric value into something that fits on a key. */
export function formatValue(value: number | null, unit: string, decimals: number): string {
  if (value === null) {
    return "—";
  }

  let scaled = value;
  let suffix = unit;

  // Compact large numbers so "1400000" doesn't take the whole key.
  if (unit === "" || unit === "B" || unit === "req") {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) {
      scaled = value / 1_000_000_000;
      suffix = `G${unit}`;
    } else if (abs >= 1_000_000) {
      scaled = value / 1_000_000;
      suffix = `M${unit}`;
    } else if (abs >= 1_000) {
      scaled = value / 1_000;
      suffix = `k${unit}`;
    }
  }

  const rounded = scaled.toFixed(decimals);
  // Trim a trailing ".0" so integers read cleanly.
  const trimmed = rounded.replace(/\.0+$/, "");
  return suffix ? `${trimmed}${suffix}` : trimmed;
}

/**
 * Classifies a value against thresholds.
 * When `invert` is set, *lower* values are worse — which is what you want for
 * `up` (1 = healthy) or a success-rate query.
 */
export function classify(
  value: number | null,
  warn: number | undefined,
  crit: number | undefined,
  invert: boolean,
): Status {
  if (value === null) {
    return "unknown";
  }

  const breaches = (threshold: number): boolean => (invert ? value <= threshold : value >= threshold);

  if (crit !== undefined && breaches(crit)) {
    return "crit";
  }
  if (warn !== undefined && breaches(warn)) {
    return "warn";
  }
  return "ok";
}

/** Builds the sparkline path, normalised to its own min/max. */
function sparklinePath(samples: Sample[], x: number, y: number, width: number, height: number): string {
  if (samples.length < 2) {
    return "";
  }

  const values = samples.map((s) => s.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  // A flat series has no range to normalise against. Drawing it at the
  // normalised zero would pin a steady `up=1` to the bottom of the key, which
  // reads as "floored" rather than "steady", so centre it instead.
  const flat = span === 0;

  const points = samples.map((sample, index) => {
    const px = x + (index / (samples.length - 1)) * width;
    const normalised = flat ? 0.5 : (sample.v - min) / span;
    const py = y + height - normalised * height;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });

  return points.join(" ");
}

export type ButtonModel = {
  title: string;
  value: number | null;
  unit: string;
  decimals: number;
  status: Status;
  samples: Sample[];
  /** Rendered instead of the value when set, e.g. "NO CONN". */
  overrideText?: string;
};

/**
 * Renders a key face as raw SVG markup.
 *
 * Hosts consume this differently: the Elgato software takes a data URI and
 * rasterises for us, while the Linux daemon has to rasterise itself. Both start
 * here.
 */
export function renderButtonSvg(model: ButtonModel): string {
  const colors = PALETTE[model.status];
  const valueText = model.overrideText ?? formatValue(model.value, model.unit, model.decimals);

  const titleText = escapeXml(model.title.toUpperCase());
  const titleSize = fitFontSize(titleText, VIEWBOX - 16, 17, 10);
  const valueSize = fitFontSize(valueText, VIEWBOX - 16, 46, 20);

  const spark = sparklinePath(model.samples, 10, 104, VIEWBOX - 20, 28);
  const sparkLayer = spark
    ? `<polyline points="${spark}" fill="none" stroke="${colors.accent}" stroke-width="3"
         stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">
  <rect width="${VIEWBOX}" height="${VIEWBOX}" rx="14" fill="${colors.bg}"/>
  <rect x="0" y="0" width="${VIEWBOX}" height="5" rx="2.5" fill="${colors.accent}"/>
  <text x="${VIEWBOX / 2}" y="34" text-anchor="middle" font-family="sans-serif"
        font-size="${titleSize}" font-weight="600" fill="${colors.muted}"
        letter-spacing="1">${titleText}</text>
  <text x="${VIEWBOX / 2}" y="86" text-anchor="middle" font-family="sans-serif"
        font-size="${valueSize}" font-weight="700" fill="${colors.fg}">${escapeXml(valueText)}</text>
  ${sparkLayer}
</svg>`;

  return svg;
}

/** Renders a key face as an SVG data URI, for hosts that accept one directly. */
export function renderButton(model: ButtonModel): string {
  return `data:image/svg+xml;base64,${Buffer.from(renderButtonSvg(model)).toString("base64")}`;
}
