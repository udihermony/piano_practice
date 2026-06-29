import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzeSpectrum,
  verifyExpectedDetailed,
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
} from './pitchDetector';
import { noteName } from '../lib/midi';

const round = (n: number) => Math.round(n * 1000) / 1000;

/** One recorded detection event, for diagnosing why notes are missed. */
export interface RecordedEvent {
  t: number; // seconds since recording start
  fluxRatio: number; // onset strength that triggered this capture
  expected: number[];
  /** Per expected note: peak raw score over the window + the thresholds it faced. */
  notes: {
    midi: number;
    name: string;
    peakScore: number;
    relThreshold: number;
    floorThreshold: number;
    votes: number;
    present: boolean;
  }[];
  /** Notes locked in (verified present). */
  locked: number[];
  matched: boolean;
}

/**
 * Mic capture + onset-triggered detection, ported from the Phase 0 prototype.
 *
 * Pipeline per frame (rAF loop, ~60Hz):
 *  1. RMS silence gate.
 *  2. Spectral flux onset detection — fires on each note attack, including legato
 *     where RMS barely rises (a new note adds partials).
 *  3. On onset: run the detector over a short capture window and vote across frames;
 *     lock the majority result in until the next onset or silence. The sustain
 *     spectrum drifts, so we do NOT re-detect every frame.
 *
 * FFT stays on the main thread for now (analyser loop, as in the prototype);
 * moving it to an AudioWorklet→Worker is a later optimization (HANDOFF §7.3).
 */

export interface UseMicOptions {
  detectorConfig?: Partial<DetectorConfig>;
  /** RMS below this blanks detection. */
  gate?: number;
  fftSize?: number;
  /** Flux must exceed this multiple of the smoothed baseline to count as an onset. */
  onsetFluxRatio?: number;
  /**
   * When set (practice mode), the detector verifies only these expected pitches
   * instead of transcribing the whole spectrum — much more reliable. Null = free
   * transcription (free-play readout).
   */
  expected?: number[] | null;
}

export interface UseMic {
  running: boolean;
  error: string | null;
  /** Locked detection result, held until next onset/silence. */
  heldNotes: number[];
  /**
   * Increments once per onset lock-in (even if the note set is unchanged). Lets the
   * matcher evaluate exactly one attempt per strike — essential for repeated notes.
   */
  detectionId: number;
  /** Normalized per-note display scores from the last analyzed frame. */
  scores: Map<number, number>;
  /** Current input RMS (0..~0.3). */
  level: number;
  gated: boolean;
  start: () => Promise<void>;
  stop: () => void;
  // Diagnostics recorder
  recording: boolean;
  eventCount: number;
  startRecording: () => void;
  stopRecording: () => void;
  clearRecording: () => void;
  /** Save the session to the dev server (sessions/), falling back to download. */
  exportSession: (meta?: Record<string, unknown>) => Promise<string>;
}

const ONSET_COOLDOWN_MS = 200;
const CAPTURE_FRAMES = 10;
const CAPTURE_SKIP = 1;
// Fraction of voting frames a note must appear in to lock. Lenient in verify mode
// (we only test expected pitches, so ghosts can't sneak in, and bass notes decay
// fast / register unevenly on phone mics), stricter for free transcription.
const VOTE_FRACTION_VERIFY = 0.4;
const VOTE_FRACTION_FREE = 0.6;
const MIN_VOTES = 2;

export function useMic(opts: UseMicOptions = {}): UseMic {
  const gate = opts.gate ?? 0.01;
  // 8192 ≈ 171ms FFT window at 48kHz — fills fast enough to match the ~165ms capture
  // window, so detection isn't working off a stale third-of-a-second spectrum (which
  // caused phantom misses and cursor lag). Resolution is fine for verify mode, where
  // we only test specific expected pitches and never resolve adjacent semitones.
  const fftSize = opts.fftSize ?? 8192;
  const onsetFluxRatio = opts.onsetFluxRatio ?? 2.5;

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heldNotes, setHeldNotes] = useState<number[]>([]);
  const [detectionId, setDetectionId] = useState(0);
  const [scores, setScores] = useState<Map<number, number>>(new Map());
  const [level, setLevel] = useState(0);
  const [gated, setGated] = useState(true);

  // Audio graph + loop state held in refs (not React state — updates every frame).
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const freqDbRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const timeBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);

  const prevSpectrumRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const fluxSmoothRef = useRef(0);
  const lastOnsetRef = useRef(-9999);
  const captureLeftRef = useRef(0);
  const captureVotesRef = useRef<Record<number, number>>({});
  const heldRef = useRef<number[]>([]);

  // Diagnostics recorder
  const [recording, setRecording] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const recordingRef = useRef(false);
  const eventsRef = useRef<RecordedEvent[]>([]);
  const recStartRef = useRef(0);
  const onsetFluxRef = useRef(0);
  // Per-expected accumulation during the current capture window.
  const captureDetailRef = useRef<
    Record<number, { peakScore: number; relThreshold: number; floorThreshold: number }>
  >({});

  // Keep the detector config current without restarting the loop.
  const cfgRef = useRef<DetectorConfig>({ ...DEFAULT_DETECTOR_CONFIG });
  useEffect(() => {
    cfgRef.current = { ...DEFAULT_DETECTOR_CONFIG, ...opts.detectorConfig };
  }, [opts.detectorConfig]);

  // Current expected set for score-informed verification (null = free transcription).
  const expectedRef = useRef<number[] | null>(opts.expected ?? null);
  useEffect(() => {
    expectedRef.current = opts.expected ?? null;
  }, [opts.expected]);

  const loop = useCallback(() => {
    const ctx = ctxRef.current;
    const analyser = analyserRef.current;
    const freqDb = freqDbRef.current;
    const timeBuf = timeBufRef.current;
    if (!ctx || !analyser || !freqDb || !timeBuf) return;

    rafRef.current = requestAnimationFrame(loop);

    // 1. RMS / silence gate
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sum / timeBuf.length);
    setLevel(rms);
    const isGated = rms < gate;
    setGated(isGated);

    analyser.getFloatFrequencyData(freqDb);

    if (isGated) {
      prevSpectrumRef.current = null;
      fluxSmoothRef.current = 0;
      captureLeftRef.current = 0;
      captureVotesRef.current = {};
      if (heldRef.current.length) {
        heldRef.current = [];
        setHeldNotes([]);
      }
      return;
    }

    const now = performance.now();

    // 2. Spectral flux onset detection (half-wave rectified)
    const binCount = analyser.frequencyBinCount;
    const curMag = new Float32Array(binCount);
    for (let b = 0; b < binCount; b++) curMag[b] = Math.pow(10, freqDb[b] / 20);

    let flux = 0;
    const prev = prevSpectrumRef.current;
    if (prev) {
      for (let b = 0; b < binCount; b++) {
        const d = curMag[b] - prev[b];
        if (d > 0) flux += d;
      }
    }
    prevSpectrumRef.current = curMag;

    const fluxSmooth = fluxSmoothRef.current;
    const fluxRatio = fluxSmooth > 0 ? flux / fluxSmooth : 0;
    fluxSmoothRef.current = fluxSmooth === 0 ? flux : fluxSmooth * 0.9 + flux * 0.1;

    const isOnset =
      fluxSmooth > 0 && fluxRatio > onsetFluxRatio && now - lastOnsetRef.current > ONSET_COOLDOWN_MS;
    if (isOnset) {
      lastOnsetRef.current = now;
      captureLeftRef.current = CAPTURE_FRAMES;
      captureVotesRef.current = {};
      captureDetailRef.current = {};
      onsetFluxRef.current = fluxRatio;
    }

    // 3. Capture-window voting
    if (captureLeftRef.current > 0) {
      const frameIdx = CAPTURE_FRAMES - captureLeftRef.current;
      const expected = expectedRef.current;

      // Score-informed when practicing (verify expected pitches), else full transcription.
      let frameDetected: number[];
      if (expected && expected.length > 0) {
        const detail = verifyExpectedDetailed(
          freqDb,
          ctx.sampleRate,
          analyser.fftSize,
          cfgRef.current,
          expected,
        );
        frameDetected = detail.notes.filter((n) => n.present).map((n) => n.midi);
        // Track peak score + thresholds per expected note for the recorder.
        if (recordingRef.current && frameIdx >= CAPTURE_SKIP) {
          for (const n of detail.notes) {
            const cur = captureDetailRef.current[n.midi];
            if (!cur || n.score > cur.peakScore) {
              captureDetailRef.current[n.midi] = {
                peakScore: n.score,
                relThreshold: n.relThreshold,
                floorThreshold: n.floorThreshold,
              };
            }
          }
        }
      } else {
        const result = analyzeSpectrum(freqDb, ctx.sampleRate, analyser.fftSize, cfgRef.current);
        setScores(result.scores);
        frameDetected = result.detected;
      }

      if (frameIdx >= CAPTURE_SKIP) {
        for (const m of frameDetected) {
          captureVotesRef.current[m] = (captureVotesRef.current[m] ?? 0) + 1;
        }
      }
      captureLeftRef.current--;

      if (captureLeftRef.current === 0) {
        const votingFrames = CAPTURE_FRAMES - CAPTURE_SKIP;
        const inVerify = !!(expectedRef.current && expectedRef.current.length > 0);
        const frac = inVerify ? VOTE_FRACTION_VERIFY : VOTE_FRACTION_FREE;
        const threshold = Math.max(MIN_VOTES, Math.ceil(votingFrames * frac));
        const locked = Object.entries(captureVotesRef.current)
          .filter(([, v]) => v >= threshold)
          .map(([m]) => parseInt(m, 10))
          .sort((a, b) => a - b);
        heldRef.current = locked;
        setHeldNotes(locked);
        if (locked.length > 0) setDetectionId((id) => id + 1);

        // Record the event (practice/expected mode only — that's what we diagnose).
        const expected = expectedRef.current;
        if (recordingRef.current && expected && expected.length > 0) {
          const lockedSet = new Set(locked);
          const notes = expected.map((m) => {
            const d = captureDetailRef.current[m];
            return {
              midi: m,
              name: noteName(m),
              peakScore: d ? round(d.peakScore) : 0,
              relThreshold: d ? round(d.relThreshold) : 0,
              floorThreshold: d ? round(d.floorThreshold) : 0,
              votes: captureVotesRef.current[m] ?? 0,
              present: lockedSet.has(m),
            };
          });
          const matched = expected.every((m) => lockedSet.has(m));
          eventsRef.current.push({
            t: round((now - recStartRef.current) / 1000),
            fluxRatio: round(onsetFluxRef.current),
            expected: [...expected],
            notes,
            locked,
            matched,
          });
          setEventCount(eventsRef.current.length);
        }
      }
    }
  }, [gate, onsetFluxRatio]);

  const start = useCallback(async () => {
    setError(null);
    try {
      // CRITICAL: speech DSP defaults mangle music — turn all three off (HANDOFF §2).
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      ctxRef.current = ctx;

      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -100;
      analyser.maxDecibels = -10;
      src.connect(analyser);
      analyserRef.current = analyser;

      freqDbRef.current = new Float32Array(analyser.frequencyBinCount);
      timeBufRef.current = new Float32Array(analyser.fftSize);
      prevSpectrumRef.current = null;
      fluxSmoothRef.current = 0;

      setRunning(true);
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fftSize, loop]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void ctxRef.current?.close();
    ctxRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
    setRunning(false);
    setHeldNotes([]);
    heldRef.current = [];
    setScores(new Map());
    setLevel(0);
    setGated(true);
  }, []);

  // Clean up on unmount.
  useEffect(() => stop, [stop]);

  // ---- Recorder controls ----
  const startRecording = useCallback(() => {
    eventsRef.current = [];
    setEventCount(0);
    recStartRef.current = performance.now();
    recordingRef.current = true;
    setRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);
  }, []);

  const clearRecording = useCallback(() => {
    eventsRef.current = [];
    setEventCount(0);
  }, []);

  const exportSession = useCallback(async (meta?: Record<string, unknown>) => {
    const filename = `app-session-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    const payload = {
      exportedAt: new Date().toISOString(),
      config: { ...cfgRef.current },
      ...meta,
      events: eventsRef.current,
    };
    try {
      const res = await fetch('/save-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, data: payload }),
      });
      const json = await res.json();
      if (json.ok) return `saved ${json.path ?? filename}`;
      throw new Error(json.error ?? 'save failed');
    } catch {
      // Fallback: browser download.
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      return `downloaded ${filename}`;
    }
  }, []);

  return {
    running,
    error,
    heldNotes,
    detectionId,
    scores,
    level,
    gated,
    start,
    stop,
    recording,
    eventCount,
    startRecording,
    stopRecording,
    clearRecording,
    exportSession,
  };
}
