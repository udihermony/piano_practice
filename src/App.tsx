import { useEffect, useMemo, useRef, useState } from 'react';
import { useOsmd } from './score/useOsmd';
import { SAMPLE_C_MAJOR } from './score/sampleScore';
import { noteName } from './lib/midi';
import { useMic } from './audio/useMic';
import { evaluateMatch } from './score/matcher';
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
  const [saveMsg, setSaveMsg] = useState('');
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

  const divider = <span style={{ width: 1, height: 20, background: 'var(--line)' }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 32px)', gap: 10 }}>
      {/* ---- Toolbar (always visible) ---- */}
      <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Source row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14, marginRight: 4 }}>{osmd.title || 'Piano Practice'}</strong>
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
          {divider}
          <button onClick={() => setShowCalib(true)}>
            {calibration ? 'Recalibrate' : 'Calibrate'}
          </button>
          {calibration && (
            <button
              onClick={() => {
                clearCalibration();
                setCalibration(null);
              }}
              style={{ padding: '4px 10px', fontSize: 11 }}
              title={calibLabel(calibration) || 'calibrated'}
            >
              clear cal
            </button>
          )}
        </div>

        {/* Transport row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className={practicing ? '' : 'primary'}
            onClick={() => setPracticing((p) => !p)}
            disabled={!osmd.loaded}
          >
            {practicing ? '■ Stop' : '▶ Practice'}
          </button>
          {!mic.running ? (
            <button onClick={() => void mic.start()}>🎤 Start mic</button>
          ) : (
            <button onClick={mic.stop}>🎤 Stop mic</button>
          )}
          {divider}
          <button onClick={osmd.prev} disabled={!osmd.loaded || practicing}>
            ◀
          </button>
          <button onClick={osmd.next} disabled={!osmd.loaded || osmd.atEnd || practicing}>
            ▶
          </button>
          <button onClick={osmd.reset} disabled={!osmd.loaded}>
            ⟲
          </button>
          {/* Mic level */}
          <div
            style={{
              width: 70,
              height: 6,
              background: '#100e0c',
              borderRadius: 3,
              overflow: 'hidden',
              border: '1px solid var(--line)',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, mic.level * 600)}%`,
                background: mic.gated ? 'var(--line)' : 'var(--green)',
                transition: 'width .05s linear',
              }}
            />
          </div>
          {osmd.atEnd && (
            <span style={{ color: 'var(--green)', fontSize: 13, fontWeight: 600 }}>🎉 End</span>
          )}
          {mic.error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{mic.error}</span>}
          {divider}
          {/* Diagnostics recorder */}
          {!mic.recording ? (
            <button onClick={mic.startRecording} style={{ fontSize: 11, padding: '6px 10px' }}>
              ● Record
            </button>
          ) : (
            <button
              onClick={mic.stopRecording}
              style={{ fontSize: 11, padding: '6px 10px', color: 'var(--red)' }}
            >
              ■ Stop rec ({mic.eventCount})
            </button>
          )}
          <button
            onClick={async () => setSaveMsg(await mic.exportSession({ title: osmd.title }))}
            disabled={mic.eventCount === 0}
            style={{ fontSize: 11, padding: '6px 10px' }}
          >
            Save
          </button>
          {saveMsg && (
            <span style={{ fontSize: 11, color: 'var(--green)', fontFamily: 'var(--mono)' }}>
              {saveMsg}
            </span>
          )}
        </div>

        {/* Compact readout row */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            fontFamily: 'var(--mono)',
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--dim)' }}>Expected:</span>
          {osmd.expectedMidi.length === 0 ? (
            <span style={{ color: 'var(--dim)', fontStyle: 'italic' }}>—</span>
          ) : (
            osmd.expectedMidi.map((m) => {
              const ok = expectedSatisfied.has(m);
              return (
                <span
                  key={m}
                  style={{
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 5,
                    color: ok ? 'var(--green)' : 'var(--amber)',
                    border: `1px solid ${ok ? 'var(--green)' : 'var(--amber)'}`,
                  }}
                >
                  {noteName(m)}
                </span>
              );
            })
          )}
          {divider}
          <span style={{ color: 'var(--dim)' }}>Heard:</span>
          {mic.heldNotes.length === 0 ? (
            <span style={{ color: 'var(--dim)', fontStyle: 'italic' }}>—</span>
          ) : (
            mic.heldNotes.map((m) => (
              <span key={m} style={{ color: 'var(--green)', fontWeight: 600 }}>
                {noteName(m)}
              </span>
            ))
          )}
        </div>
      </div>

      {osmd.error && (
        <div style={{ color: 'var(--red)' }}>Failed to load score: {osmd.error}</div>
      )}

      {/* ---- Score fills remaining height, scrolls internally, follows cursor ---- */}
      <div
        className="score-surface"
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'auto',
          outline: justMatched ? '2px solid var(--green)' : '2px solid transparent',
          transition: 'outline-color .15s',
        }}
      >
        <div ref={osmd.containerRef} />
      </div>

      {showCalib && (
        <CalibrationWizard
          onClose={() => setShowCalib(false)}
          onSaved={(data) => setCalibration(data)}
        />
      )}
    </div>
  );
}
