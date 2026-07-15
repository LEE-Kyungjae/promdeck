/**
 * Coerces a Property Inspector value to a number.
 *
 * Text fields hand back strings, and an empty field arrives as `""` rather than
 * `undefined`. Passing that straight through is not harmless: `""` coerces to
 * `0` in a `>=` comparison, so an unset threshold would match every value and
 * paint every key red. Anything non-numeric collapses to `undefined` — "no
 * threshold" — which is what an empty field actually means.
 */
export function num(input: unknown): number | undefined {
  if (input === undefined || input === null || input === "") {
    return undefined;
  }

  const parsed = typeof input === "number" ? input : Number(String(input).trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}
