import { useCallback, useEffect, useRef, useState } from 'react';
import { noteName } from '../lib/midi';
import { noteScore, DEFAULT_DETECTOR_CONFIG } from '../audio/pitchDetector';
import {
  CALIB_NOTES,
  computeCalibration,
  saveCalibration,
  type CalibrationData,
} from '../audio/calibration';

/**
 * Guided per-piano calibration. For each sampled note the user plays it (a couple
 * of strikes) during a capture window; we record the peak harmonic score. Boosts
 * are derived (weaker notes lifted toward the median) and saved to localStorage.
 *
 * Self-contained: opens its own mic/AudioContext so it doesn't entangle the
 * practice mic, mirroring the standalone Phase 0 prototype.
 */

const CAPTURE_MS = 2200;
const FFT_SIZE = 8192; // match the detector's FFT so calibration scores are comparable

type Phase = 'idle' | 'ready' | 'capturing' | 'done';

export function CalibrationWizard({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (data: CalibrationData) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0); // 0..1 of capture window
  const [liveScore, setLiveScore] = useState(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const freqDbRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const peaksRef = useRef<Record<number, number>>({});

  const teardown = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void ctxRef.current?.close();
    ctxRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const startMic = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -100;
      analyser.maxDecibels = -10;
      src.connect(analyser);
      analyserRef.current = analyser;
      freqDbRef.current = new Float32Array(analyser.frequencyBinCount);
      setPhase('ready');
      setStep(0);
      peaksRef.current = {};
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const captureStep = useCallback(() => {
    const ctx = ctxRef.current;
    const analyser = analyserRef.current;
    const freqDb = freqDbRef.current;
    if (!ctx || !analyser || !freqDb) return;

    const targetMidi = CALIB_NOTES[step];
    setPhase('capturing');
    setProgress(0);
    let peak = 0;
    const startMs = performance.now();

    const tick = () => {
      const elapsed = performance.now() - startMs;
      analyser.getFloatFrequencyData(freqDb);
      const s = noteScore(freqDb, ctx.sampleRate, analyser.fftSize, DEFAULT_DETECTOR_CONFIG, targetMidi);
      if (s > peak) peak = s;
      setLiveScore(s);
      setProgress(Math.min(1, elapsed / CAPTURE_MS));

      if (elapsed >= CAPTURE_MS) {
        peaksRef.current[targetMidi] = peak;
        setLiveScore(0);
        if (step < CALIB_NOTES.length - 1) {
          setStep((s2) => s2 + 1);
          setPhase('ready');
        } else {
          const data = computeCalibration(peaksRef.current);
          saveCalibration(data);
          onSaved(data);
          setPhase('done');
          teardown();
        }
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [step, onSaved, teardown]);

  const close = useCallback(() => {
    teardown();
    onClose();
  }, [teardown, onClose]);

  const target = CALIB_NOTES[step];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20,18,16,.93)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '28px 32px',
          maxWidth: 460,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <h2 style={{ fontSize: 17, margin: '0 0 6px' }}>Calibrate your piano</h2>

        {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', margin: '14px 0 20px' }}>
          {CALIB_NOTES.map((n, i) => (
            <div
              key={n}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background:
                  i < step || phase === 'done'
                    ? 'var(--green)'
                    : i === step && phase !== 'idle'
                      ? 'var(--amber)'
                      : 'var(--line)',
              }}
            />
          ))}
        </div>

        {phase === 'idle' && (
          <>
            <p style={{ fontSize: 13, color: 'var(--dim)', lineHeight: 1.5, marginBottom: 20 }}>
              We'll listen to {CALIB_NOTES.length} notes across the keyboard so the detector learns
              your piano's sound. Play each note when prompted (a couple of strikes, ~2&nbsp;s).
            </p>
            <button className="primary" onClick={() => void startMic()}>
              Start calibration
            </button>
          </>
        )}

        {(phase === 'ready' || phase === 'capturing') && (
          <>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 48,
                fontWeight: 700,
                color: 'var(--amber)',
                lineHeight: 1,
                marginBottom: 4,
              }}
            >
              {noteName(target)}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--dim)', marginBottom: 18 }}>
              MIDI {target} · note {step + 1} of {CALIB_NOTES.length}
            </div>

            {/* Capture progress / live level */}
            <div
              style={{
                height: 8,
                background: '#100e0c',
                borderRadius: 4,
                overflow: 'hidden',
                border: '1px solid var(--line)',
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(phase === 'capturing' ? progress : 0) * 100}%`,
                  background: 'var(--green)',
                  transition: 'width .05s',
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: 'var(--dim)', minHeight: 18, marginBottom: 18 }}>
              {phase === 'capturing'
                ? `Listening… ${liveScore > 0.02 ? 'got it' : 'play the note'}`
                : `Ready — press Capture, then play ${noteName(target)}.`}
            </div>

            {phase === 'ready' && (
              <button className="primary" onClick={captureStep}>
                Capture {noteName(target)}
              </button>
            )}
          </>
        )}

        {phase === 'done' && (
          <>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✓</div>
            <p style={{ fontSize: 13, color: 'var(--green)', marginBottom: 20 }}>
              Calibration saved. The detector is tuned for your piano.
            </p>
            <button className="primary" onClick={close}>
              Done
            </button>
          </>
        )}

        <div
          onClick={close}
          style={{
            fontSize: 12,
            color: 'var(--dim)',
            marginTop: 16,
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {phase === 'done' ? 'Close' : 'Skip / cancel'}
        </div>
      </div>
    </div>
  );
}
