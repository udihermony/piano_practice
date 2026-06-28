import { useCallback, useEffect, useRef, useState } from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

/**
 * Wraps OpenSheetMusicDisplay. The OSMD cursor is the single source of truth for
 * "what notes are expected right now" — we never build a parallel MusicXML parser
 * (avoids drift on repeats/voltas/ties/grace notes; see HANDOFF.md §2).
 *
 * MIDI derivation: OSMD's Pitch.halfTone is private in the typings, so we derive
 * MIDI from the public Frequency getter — MIDI = round(69 + 12*log2(f/440)).
 */
export interface UseOsmd {
  containerRef: React.RefObject<HTMLDivElement | null>;
  loaded: boolean;
  error: string | null;
  /** MIDI numbers expected at the current cursor position (chord = multiple). */
  expectedMidi: number[];
  atEnd: boolean;
  next: () => void;
  prev: () => void;
  reset: () => void;
  loadXml: (xml: string) => Promise<void>;
}

function frequencyToMidi(freq: number): number {
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

export function useOsmd(): UseOsmd {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expectedMidi, setExpectedMidi] = useState<number[]>([]);
  const [atEnd, setAtEnd] = useState(false);

  // Initialize OSMD when the container mounts. Cleanup nulls the ref and clears
  // the instance so a StrictMode remount rebinds to the fresh DOM node.
  useEffect(() => {
    if (!containerRef.current) return;
    const instance = new OpenSheetMusicDisplay(containerRef.current, {
      autoResize: true,
      backend: 'svg',
      drawTitle: true,
    });
    osmdRef.current = instance;
    return () => {
      osmdRef.current = null;
      try {
        instance.clear();
      } catch {
        /* instance may already be torn down */
      }
    };
  }, []);

  const readExpectedMidi = useCallback(() => {
    const osmd = osmdRef.current;
    if (!osmd?.cursor) {
      setExpectedMidi([]);
      return;
    }
    const notes = osmd.cursor.NotesUnderCursor();
    const midi: number[] = [];
    for (const note of notes) {
      // Rests and undefined pitches are skipped.
      const pitch = note.Pitch;
      if (!pitch || note.isRest()) continue;
      midi.push(frequencyToMidi(pitch.Frequency));
    }
    midi.sort((a, b) => a - b);
    setExpectedMidi(midi);
    // OSMD marks Iterator.EndReached when the cursor steps past the last note.
    setAtEnd(Boolean(osmd.cursor.Iterator?.EndReached));
  }, []);

  const loadXml = useCallback(
    async (xml: string) => {
      const osmd = osmdRef.current;
      if (!osmd) return;
      setError(null);
      setLoaded(false);
      try {
        await osmd.load(xml);
        // A StrictMode remount may have disposed this instance mid-load; if the
        // ref no longer points to it, bail silently — the remounted instance will
        // load again on its own effect run.
        if (osmdRef.current !== osmd) return;
        osmd.render();
        osmd.cursor.show();
        osmd.cursor.reset();
        setLoaded(true);
        setAtEnd(false);
        readExpectedMidi();
      } catch (e) {
        if (osmdRef.current !== osmd) return; // error from a superseded instance
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [readExpectedMidi],
  );

  const next = useCallback(() => {
    const osmd = osmdRef.current;
    if (!osmd?.cursor) return;
    osmd.cursor.next();
    readExpectedMidi();
  }, [readExpectedMidi]);

  const prev = useCallback(() => {
    const osmd = osmdRef.current;
    if (!osmd?.cursor) return;
    osmd.cursor.previous();
    readExpectedMidi();
  }, [readExpectedMidi]);

  const reset = useCallback(() => {
    const osmd = osmdRef.current;
    if (!osmd?.cursor) return;
    osmd.cursor.reset();
    setAtEnd(false);
    readExpectedMidi();
  }, [readExpectedMidi]);

  return {
    containerRef,
    loaded,
    error,
    expectedMidi,
    atEnd,
    next,
    prev,
    reset,
    loadXml,
  };
}
