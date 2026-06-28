/**
 * Pure matching logic: does what was played satisfy what the score expects at the
 * current cursor position? Kept UI-independent and unit-tested (HANDOFF §7.6).
 *
 * Design decisions:
 *  - A position matches when EVERY expected note is present in the detected set
 *    (order-independent). Extra detected notes are tolerated — piano detection is
 *    ghost-prone, and requiring exact equality would make the loop feel broken.
 *  - We never auto-skip and never punish: a non-match just means "stay put".
 *  - Octave-exact by default. (Octave-tolerant matching is a possible future option
 *    for the low-register cases, but exact is correct for real practice.)
 */

export interface MatchResult {
  matched: boolean;
  /** Expected notes that were found in the detected set. */
  satisfied: number[];
  /** Expected notes still missing. */
  missing: number[];
  /** Detected notes that were not expected (ghosts or wrong notes). */
  extra: number[];
}

/**
 * Evaluate one detection event against the expected note set.
 * @param expected MIDI numbers required at the cursor (chord = multiple).
 * @param detected MIDI numbers reported by the detector for this event.
 */
export function evaluateMatch(expected: number[], detected: number[]): MatchResult {
  const detectedSet = new Set(detected);
  const expectedSet = new Set(expected);

  const satisfied: number[] = [];
  const missing: number[] = [];
  for (const e of expectedSet) {
    if (detectedSet.has(e)) satisfied.push(e);
    else missing.push(e);
  }
  const extra = [...detectedSet].filter((d) => !expectedSet.has(d));

  // An empty expected set (rest) never auto-matches — the caller advances rests.
  const matched = expected.length > 0 && missing.length === 0;

  return {
    matched,
    satisfied: satisfied.sort((a, b) => a - b),
    missing: missing.sort((a, b) => a - b),
    extra: extra.sort((a, b) => a - b),
  };
}
