/**
 * Polyphonic piano pitch detector — ported from the validated Phase 0 prototype
 * (prototype/piano-detect-test.html). Pure and swappable: given a frequency-domain
 * frame it returns the notes present. Everything below this interface (template
 * matching now, possibly a model later) can change without touching the matcher/UI.
 *
 * Method: greedy harmonic subtraction + neighbor/harmonic ghost suppression.
 * See HANDOFF.md §3 for the rationale. Key lesson encoded here: harmonic ghost
 * suppression uses ONLY integer ratios — 1.5 (fifth) and 1.25 (third) are the
 * intervals chords are built from and must never be suppressed.
 */

export interface DetectorConfig {
  /** Main lever for picking up quieter chord tones. */
  sens: number;
  /** Harmonics per note template. */
  harm: number;
  /** Harmonic-subtraction strength (fraction removed before next scan). */
  oct: number;
  /** Candidate MIDI range. */
  lo: number;
  hi: number;
  /** Whether the fundamental must be present (vs. weighting upper partials). */
  requireFund: boolean;
  /** Per-note score multipliers from calibration (midi -> factor, default 1). */
  noteBoost: Record<number, number>;
}

export interface DetectorResult {
  /** Accepted MIDI notes, ascending. */
  detected: number[];
  /** Normalized per-note scores (0..1) for display bars; includes ghosts. */
  scores: Map<number, number>;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  sens: 0.45,
  harm: 6,
  oct: 0.75,
  lo: 36,
  hi: 96,
  requireFund: true,
  noteBoost: {},
};

const A4 = 440;
const MAX_POLYPHONY = 8;
const midiToFreq = (m: number) => A4 * Math.pow(2, (m - 69) / 12);

/** Bins covering harmonic h of f0 (±~10 cents, ≥1 bin). */
function harmBins(
  f0: number,
  h: number,
  binHz: number,
  nyq: number,
  len: number,
): [number, number] | null {
  const fh = f0 * h;
  if (fh >= nyq) return null;
  const win = Math.max(binHz, fh * 0.006);
  return [Math.max(0, Math.floor((fh - win) / binHz)), Math.min(len - 1, Math.ceil((fh + win) / binHz))];
}

/** Fundamental-dominant harmonic-template score for note `m` over a linear spectrum. */
function harmonicScore(
  spectrum: Float32Array,
  m: number,
  binHz: number,
  nyq: number,
  cfg: DetectorConfig,
): number {
  const f0 = midiToFreq(m);
  let fund = 0;
  let upper = 0;
  for (let h = 1; h <= cfg.harm; h++) {
    const hb = harmBins(f0, h, binHz, nyq, spectrum.length);
    if (!hb) break;
    let peak = 0;
    for (let b = hb[0]; b <= hb[1]; b++) if (spectrum[b] > peak) peak = spectrum[b];
    if (h === 1) fund = peak;
    else upper += peak / h;
  }
  const raw = cfg.requireFund ? fund + 0.5 * upper : 0.6 * fund + 0.7 * upper;
  return raw * (cfg.noteBoost[m] ?? 1);
}

function dbToLinear(freqDb: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(freqDb.length);
  for (let b = 0; b < freqDb.length; b++) out[b] = Math.pow(10, freqDb[b] / 20);
  return out;
}

/**
 * Analyze one frequency-domain frame.
 * @param freqDb dB-magnitude spectrum from AnalyserNode.getFloatFrequencyData
 * @param sampleRate audio context sample rate
 * @param fftSize analyser fftSize
 */
export function analyzeSpectrum(
  freqDb: Float32Array,
  sampleRate: number,
  fftSize: number,
  cfg: DetectorConfig,
): DetectorResult {
  const binHz = sampleRate / fftSize;
  const nyq = sampleRate / 2;

  // Linear-magnitude residual we subtract from as notes are claimed.
  const residual = dbToLinear(freqDb);
  const scoreNote = (m: number): number => harmonicScore(residual, m, binHz, nyq, cfg);

  // Snapshot raw scores BEFORE subtraction, for display bars (shows ghosts too).
  const display = new Map<number, number>();
  let dispMax = 1e-9;
  for (let m = cfg.lo; m <= cfg.hi; m++) {
    const s = scoreNote(m);
    display.set(m, s);
    if (s > dispMax) dispMax = s;
  }

  // Greedy peel: pick strongest, subtract its harmonics, repeat.
  const detected: number[] = [];
  let firstScore = 0;
  const stopRatio = 0.18 - 0.15 * cfg.sens;
  for (let iter = 0; iter < MAX_POLYPHONY; iter++) {
    let bestM = -1;
    let best = 0;
    for (let m = cfg.lo; m <= cfg.hi; m++) {
      const s = scoreNote(m);
      if (s > best) {
        best = s;
        bestM = m;
      }
    }
    if (bestM < 0 || best <= 0) break;
    if (iter === 0) firstScore = best;
    else if (best < stopRatio * firstScore) break;
    detected.push(bestM);
    const f0 = midiToFreq(bestM);
    const keep = 1 - cfg.oct;
    for (let h = 1; h <= cfg.harm; h++) {
      const hb = harmBins(f0, h, binHz, nyq, residual.length);
      if (!hb) break;
      for (let b = hb[0]; b <= hb[1]; b++) residual[b] *= keep;
    }
  }

  const filtered = suppressGhosts(detected, display);

  const scores = new Map<number, number>();
  display.forEach((v, k) => scores.set(k, v / dispMax));
  return { detected: filtered.sort((a, b) => a - b), scores };
}

/**
 * Two-rule ghost suppression on the greedy-peel result.
 * Uses pre-subtraction display scores to rank notes.
 */
function suppressGhosts(detected: number[], display: Map<number, number>): number[] {
  const score = (m: number) => display.get(m) ?? 0;
  const suppressed = new Set<number>();

  // Rule 1 — Neighbor suppression: drop weaker note when two accepted notes are
  // within 2 semitones. Real chord tones are always 3+ semitones apart.
  for (const m of detected) {
    if (suppressed.has(m)) continue;
    for (const n of detected) {
      if (n === m || suppressed.has(n)) continue;
      if (Math.abs(n - m) <= 2) {
        if (score(m) >= score(n)) suppressed.add(n);
        else suppressed.add(m);
      }
    }
  }

  // Rule 2 — Harmonic ghost suppression. ONLY integer harmonics (2x,3x,…) are
  // real overtones; non-integer ratios like 1.5 are chord intervals — never touch
  // them. An upper note is a ghost only if it ALSO scores weak relative to the
  // lower note (a deliberate octave chord tone has its own strong fundamental).
  const HARMONIC_RATIOS = [2.0, 3.0, 4.0, 5.0, 6.0, 7.0];
  const RATIO_TOL = 0.02;
  const GHOST_REL = 0.5;
  for (const lower of detected) {
    if (suppressed.has(lower)) continue;
    const fLower = midiToFreq(lower);
    const sLower = score(lower);
    for (const higher of detected) {
      if (higher <= lower || suppressed.has(higher)) continue;
      if (score(higher) >= sLower * GHOST_REL) continue;
      const ratio = midiToFreq(higher) / fLower;
      for (const hr of HARMONIC_RATIOS) {
        if (Math.abs(ratio - hr) / hr < RATIO_TOL) {
          suppressed.add(higher);
          break;
        }
      }
    }
  }

  return detected.filter((m) => !suppressed.has(m));
}

/**
 * Score-informed verification (HANDOFF §7.4). Given the pitches expected at the
 * cursor, return which of them are actually present — instead of transcribing the
 * whole spectrum. This sidesteps the octave-ghost problem: we never ask "is D5
 * present?" when the score expects D4, so an octave overtone can't be mistaken for
 * the played note. Far more reliable than open-ended polyphony.
 *
 * A note counts as present when its harmonic-template score is BOTH:
 *  - a meaningful fraction of the strongest expected note (within-chord balance), and
 *  - well above the background floor (median score across the candidate range),
 *    which confirms real energy at that pitch rather than noise/bleed.
 */
const VERIFY_REL = 0.18; // fraction of the strongest expected note
const VERIFY_FLOOR_MULT = 4; // multiples of the median background score

export function verifyExpected(
  freqDb: Float32Array,
  sampleRate: number,
  fftSize: number,
  cfg: DetectorConfig,
  expected: number[],
): number[] {
  if (expected.length === 0) return [];
  const binHz = sampleRate / fftSize;
  const nyq = sampleRate / 2;
  const spectrum = dbToLinear(freqDb);

  // Background floor: median score across the full candidate range.
  const all: number[] = [];
  for (let m = cfg.lo; m <= cfg.hi; m++) all.push(harmonicScore(spectrum, m, binHz, nyq, cfg));
  all.sort((a, b) => a - b);
  const floor = all[Math.floor(all.length / 2)] || 1e-9;

  // Score each expected note; find the strongest for the relative test.
  const expScores = new Map<number, number>();
  let maxExp = 1e-9;
  for (const m of expected) {
    const s = harmonicScore(spectrum, m, binHz, nyq, cfg);
    expScores.set(m, s);
    if (s > maxExp) maxExp = s;
  }

  const present: number[] = [];
  for (const m of expected) {
    const s = expScores.get(m)!;
    if (s >= maxExp * VERIFY_REL && s >= floor * VERIFY_FLOOR_MULT) present.push(m);
  }
  return present.sort((a, b) => a - b);
}
