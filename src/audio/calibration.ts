import { noteName } from '../lib/midi';

/**
 * Per-piano calibration: learn how strongly each register registers into the mic,
 * then boost weaker notes so the detector treats them evenly. Ported from the
 * Phase 0 prototype, persisted to localStorage so it survives reloads.
 */

const STORAGE_KEY = 'piano_calibration_v1';

/** Notes sampled across the range: C3, C4, A4, C5, C6. */
export const CALIB_NOTES = [48, 60, 69, 72, 84];

export interface CalibNote {
  midi: number;
  /** Peak raw harmonic score observed for this note. */
  peak: number;
  /** Score multiplier applied in the detector (medianPeak / peak, capped). */
  boost: number;
}

export interface CalibrationData {
  savedAt: number;
  notes: CalibNote[];
}

const MAX_BOOST = 3;

/** Compute boosts from captured peaks: weaker notes get lifted toward the median. */
export function computeCalibration(peaks: Record<number, number>): CalibrationData {
  const vals = Object.values(peaks).filter((v) => v > 0).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : 1;
  const notes: CalibNote[] = CALIB_NOTES.map((midi) => {
    const peak = peaks[midi] ?? 0;
    const boost = peak > 1e-6 ? Math.min(MAX_BOOST, median / peak) : 1;
    return { midi, peak, boost };
  });
  return { savedAt: Date.now(), notes };
}

export function saveCalibration(data: CalibrationData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function loadCalibration(): CalibrationData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CalibrationData) : null;
  } catch {
    return null;
  }
}

export function clearCalibration(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Turn calibration data into the midi→multiplier map the detector consumes. */
export function boostMap(data: CalibrationData | null): Record<number, number> {
  const map: Record<number, number> = {};
  if (!data) return map;
  for (const n of data.notes) if (n.boost && n.boost !== 1) map[n.midi] = n.boost;
  return map;
}

export function calibLabel(data: CalibrationData): string {
  return data.notes
    .filter((n) => n.boost !== 1)
    .map((n) => `${noteName(n.midi)}×${n.boost.toFixed(1)}`)
    .join('  ');
}
