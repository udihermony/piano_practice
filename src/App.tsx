import { useEffect } from 'react';
import { useOsmd } from './score/useOsmd';
import { SAMPLE_C_MAJOR } from './score/sampleScore';
import { noteName } from './lib/midi';

export default function App() {
  const osmd = useOsmd();

  // Load the sample score once OSMD is ready.
  useEffect(() => {
    void osmd.loadXml(SAMPLE_C_MAJOR);
    // loadXml is stable (useCallback); run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          Phase 1 · Score & Cursor
        </div>
        <h1 style={{ fontSize: 18, margin: '4px 0 0' }}>Piano Practice</h1>
      </header>

      {osmd.error && (
        <div style={{ color: 'var(--red)', marginBottom: 12 }}>
          Failed to load score: {osmd.error}
        </div>
      )}

      <div className="score-surface" style={{ marginBottom: 14 }}>
        <div ref={osmd.containerRef} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <button onClick={osmd.prev} disabled={!osmd.loaded}>
          ◀ Prev
        </button>
        <button className="primary" onClick={osmd.next} disabled={!osmd.loaded || osmd.atEnd}>
          Next ▶
        </button>
        <button onClick={osmd.reset} disabled={!osmd.loaded}>
          Reset
        </button>
        {osmd.atEnd && <span style={{ color: 'var(--dim)', fontSize: 13 }}>End of score</span>}
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
            osmd.expectedMidi.map((m) => (
              <span
                key={m}
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: 6,
                  background: 'var(--panel)',
                  color: 'var(--amber)',
                  border: '1px solid var(--amber)',
                }}
              >
                {noteName(m)}
                <span style={{ color: 'var(--ink)', opacity: 0.6, marginLeft: 6, fontSize: 12 }}>
                  {m}
                </span>
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
