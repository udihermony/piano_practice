import { useEffect, useMemo, useRef, useState } from 'react';
import { useOsmd } from './score/useOsmd';
import { SAMPLE_C_MAJOR } from './score/sampleScore';
import { noteName } from './lib/midi';
import { useMic } from './audio/useMic';
import { evaluateMatch } from './score/matcher';
import { DetectorPanel } from './components/DetectorPanel';
import { CalibrationWizard } from './components/CalibrationWizard';
import {
  boostMap,
  calibLabel,
  clearCalibration,
  loadCalibration,
  type CalibrationData,
} from './audio/calibration';

export default function App() {
  const osmd = useOsmd();
  const [practicing, setPracticing] = useState(false);
  const [justMatched, setJustMatched] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationData | null>(() => loadCalibration());
  const [showCalib, setShowCalib] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [library, setLibrary] = useState<string[]>([]);

  const noteBoost = useMemo(() => boostMap(calibration), [calibration]);
  const detectorConfig = useMemo(() => ({ noteBoost }), [noteBoost]);

  // Fetch the shared library list (served from public/library on the dev server).
  useEffect(() => {
    fetch('/library-list')
      .then((r) => (r.ok ? r.json() : []))
      .then((files: string[]) => setLibrary(files))
      .catch(() => setLibrary([]));
  }, []);

  const prettyName = (file: string) => file.replace(/\.(xml|musicxml|mxl)$/i, '').replace(/_/g, ' ');

  // Feed expected notes to the detector while practicing → score-informed verification.
  const mic = useMic({
    expected: practicing ? osmd.expectedMidi : null,
    detectorConfig,
  });

  // Load the sample score once OSMD is ready.
  useEffect(() => {
    void osmd.loadXml(SAMPLE_C_MAJOR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-skip rests while practicing (the matcher never matches an empty set).
  useEffect(() => {
    if (!practicing || !osmd.loaded || osmd.atEnd) return;
    if (osmd.expectedMidi.length === 0) osmd.next();
  }, [practicing, osmd.loaded, osmd.atEnd, osmd.expectedMidi, osmd]);

  // The practice loop: evaluate exactly one match attempt per detection event
  // (keyed on detectionId so a held chord can't re-trigger advancement, and
  // repeated notes still work since each strike is a new onset).
  const lastEvalRef = useRef(0);
  useEffect(() => {
    if (!practicing || !osmd.loaded || osmd.atEnd) return;
    if (mic.detectionId === lastEvalRef.current) return;
    lastEvalRef.current = mic.detectionId;

    const result = evaluateMatch(osmd.expectedMidi, mic.heldNotes);
    if (result.matched) {
      setJustMatched(true);
      window.setTimeout(() => setJustMatched(false), 250);
      osmd.next();
    }
  }, [mic.detectionId, mic.heldNotes, practicing, osmd]);

  const expectedSatisfied = new Set(
    evaluateMatch(osmd.expectedMidi, mic.heldNotes).satisfied,
  );

  return (
    <div>
      <header style={{ marginBottom: 14 }}>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--amber)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}
        >
          Piano Practice
        </div>
        <h1 style={{ fontSize: 18, margin: '4px 0 10px' }}>{osmd.title || 'Piano Practice'}</h1>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,.musicxml,.mxl"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setPracticing(false);
                void osmd.loadFile(f);
              }
              e.target.value = '';
            }}
          />
          {library.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) => {
                const file = e.target.value;
                if (file) {
                  setPracticing(false);
                  void osmd.loadUrl(`/library/${encodeURIComponent(file)}`);
                }
              }}
            >
              <option value="" disabled>
                Library…
              </option>
              {library.map((f) => (
                <option key={f} value={f}>
                  {prettyName(f)}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => fileInputRef.current?.click()}>Load file…</button>
          <button
            onClick={() => {
              setPracticing(false);
              void osmd.loadXml(SAMPLE_C_MAJOR);
            }}
          >
            Sample
          </button>
          <span style={{ width: 1, height: 22, background: 'var(--line)' }} />
          <button onClick={() => setShowCalib(true)}>
            {calibration ? 'Recalibrate' : 'Calibrate piano'}
          </button>
          {calibration && (
            <span style={{ fontSize: 11, color: 'var(--dim)', fontFamily: 'var(--mono)' }}>
              {calibLabel(calibration) || 'calibrated'}
              <button
                onClick={() => {
                  clearCalibration();
                  setCalibration(null);
                }}
                style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
              >
                clear
              </button>
            </span>
          )}
        </div>
      </header>

      {osmd.error && (
        <div style={{ color: 'var(--red)', marginBottom: 12 }}>
          Failed to load score: {osmd.error}
        </div>
      )}

      <div
        className="score-surface"
        style={{
          marginBottom: 14,
          outline: justMatched ? '2px solid var(--green)' : '2px solid transparent',
          transition: 'outline-color .15s',
        }}
      >
        <div ref={osmd.containerRef} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <button
          className={practicing ? '' : 'primary'}
          onClick={() => setPracticing((p) => !p)}
          disabled={!osmd.loaded}
        >
          {practicing ? '■ Stop practice' : '▶ Start practice'}
        </button>
        <span style={{ width: 1, height: 22, background: 'var(--line)' }} />
        <button onClick={osmd.prev} disabled={!osmd.loaded || practicing}>
          ◀ Prev
        </button>
        <button onClick={osmd.next} disabled={!osmd.loaded || osmd.atEnd || practicing}>
          Next ▶
        </button>
        <button onClick={osmd.reset} disabled={!osmd.loaded}>
          Reset
        </button>
        {osmd.atEnd && (
          <span style={{ color: 'var(--green)', fontSize: 13, fontWeight: 600 }}>
            🎉 End of score
          </span>
        )}
        {practicing && !osmd.atEnd && (
          <span style={{ color: 'var(--dim)', fontSize: 13 }}>
            {mic.running ? 'play the highlighted notes…' : 'start the mic below to play'}
          </span>
        )}
      </div>

      <div
        style={{
          fontFamily: 'var(--mono)',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 9,
          padding: '14px 16px',
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: 'var(--dim)',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}
        >
          Expected at cursor
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {osmd.expectedMidi.length === 0 ? (
            <span style={{ color: 'var(--dim)', fontStyle: 'italic' }}>
              {osmd.loaded ? '(rest or end)' : 'Loading…'}
            </span>
          ) : (
            osmd.expectedMidi.map((m) => {
              const ok = expectedSatisfied.has(m);
              return (
                <span
                  key={m}
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    padding: '4px 10px',
                    borderRadius: 6,
                    background: 'var(--panel)',
                    color: ok ? 'var(--green)' : 'var(--amber)',
                    border: `1px solid ${ok ? 'var(--green)' : 'var(--amber)'}`,
                  }}
                >
                  {noteName(m)}
                  <span style={{ color: 'var(--ink)', opacity: 0.6, marginLeft: 6, fontSize: 12 }}>
                    {m}
                  </span>
                </span>
              );
            })
          )}
        </div>
      </div>

      <DetectorPanel mic={mic} />

      {showCalib && (
        <CalibrationWizard
          onClose={() => setShowCalib(false)}
          onSaved={(data) => setCalibration(data)}
        />
      )}
    </div>
  );
}
