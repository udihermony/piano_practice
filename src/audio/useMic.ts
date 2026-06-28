import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzeSpectrum,
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
} from './pitchDetector';

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
}

const ONSET_COOLDOWN_MS = 200;
const CAPTURE_FRAMES = 10;
const CAPTURE_SKIP = 1;
const VOTE_FRACTION = 0.7;

export function useMic(opts: UseMicOptions = {}): UseMic {
  const gate = opts.gate ?? 0.01;
  const fftSize = opts.fftSize ?? 16384;
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

  // Keep the detector config current without restarting the loop.
  const cfgRef = useRef<DetectorConfig>({ ...DEFAULT_DETECTOR_CONFIG });
  useEffect(() => {
    cfgRef.current = { ...DEFAULT_DETECTOR_CONFIG, ...opts.detectorConfig };
  }, [opts.detectorConfig]);

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
    }

    // 3. Capture-window voting
    if (captureLeftRef.current > 0) {
      const frameIdx = CAPTURE_FRAMES - captureLeftRef.current;
      const result = analyzeSpectrum(freqDb, ctx.sampleRate, analyser.fftSize, cfgRef.current);
      setScores(result.scores);
      if (frameIdx >= CAPTURE_SKIP) {
        for (const m of result.detected) {
          captureVotesRef.current[m] = (captureVotesRef.current[m] ?? 0) + 1;
        }
      }
      captureLeftRef.current--;

      if (captureLeftRef.current === 0) {
        const votingFrames = CAPTURE_FRAMES - CAPTURE_SKIP;
        const threshold = Math.ceil(votingFrames * VOTE_FRACTION);
        const locked = Object.entries(captureVotesRef.current)
          .filter(([, v]) => v >= threshold)
          .map(([m]) => parseInt(m, 10))
          .sort((a, b) => a - b);
        heldRef.current = locked;
        setHeldNotes(locked);
        if (locked.length > 0) setDetectionId((id) => id + 1);
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

  return { running, error, heldNotes, detectionId, scores, level, gated, start, stop };
}
