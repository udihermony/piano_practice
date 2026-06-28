import type { UseMic } from '../audio/useMic';
import { noteName } from '../lib/midi';

/**
 * Live detector readout: mic level + detected notes. The mic instance is owned by
 * App (so the practice loop can also consume it) and passed in here.
 */
export function DetectorPanel({ mic }: { mic: UseMic }) {
  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 9,
        padding: '14px 16px',
        marginTop: 14,
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        {!mic.running ? (
          <button className="primary" onClick={() => void mic.start()}>
            Start mic
          </button>
        ) : (
          <button onClick={mic.stop}>Stop mic</button>
        )}
        <span style={{ fontSize: 12, color: 'var(--dim)', fontFamily: 'var(--mono)' }}>
          {mic.running ? (mic.gated ? 'listening…' : 'detecting') : 'mic off'}
        </span>
      </div>

      {mic.error && (
        <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>
          Mic error: {mic.error}
          <br />
          Needs a secure context: localhost on desktop, or the Chrome insecure-origin flag on
          phone (see HANDOFF.md §5).
        </div>
      )}

      {/* Level meter */}
      <div
        style={{
          height: 6,
          background: '#100e0c',
          borderRadius: 3,
          overflow: 'hidden',
          border: '1px solid var(--line)',
          marginBottom: 12,
        }}
      >
        <i
          style={{
            display: 'block',
            height: '100%',
            width: `${Math.min(100, mic.level * 600)}%`,
            background: mic.gated ? 'var(--line)' : 'linear-gradient(90deg,var(--green),var(--amber))',
            transition: 'width .05s linear',
          }}
        />
      </div>

      <div
        style={{
          fontSize: 10,
          color: 'var(--dim)',
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          marginBottom: 8,
          fontFamily: 'var(--mono)',
        }}
      >
        Detected now
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', minHeight: 26 }}>
        {mic.heldNotes.length === 0 ? (
          <span style={{ color: 'var(--dim)', fontStyle: 'italic', fontSize: 13 }}>
            {mic.running ? 'play a note…' : 'press Start mic'}
          </span>
        ) : (
          mic.heldNotes.map((m) => (
            <span
              key={m}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 14,
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: 6,
                background: 'var(--green-soft, #2a6b3a)',
                color: 'var(--green)',
                border: '1px solid var(--green)',
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
  );
}
