# Piano Practice App — Progress & Handoff

> Context for whoever picks this up next (likely a coding agent with direct file access).
> This summarizes design decisions, the working pitch-detection prototype, what's been
> validated on real hardware, and the ordered next steps. The full product spec lives
> alongside this; this doc records what changed and what was *decided* during prototyping.

---

## 1. What this is

A **local-first piano practice app** (Simply Piano–style core loop, personal use only): load
MusicXML → render score → listen via mic → advance the cursor only when the correct
note/chord is played → color notes green/red. React + TypeScript + Vite + OSMD, Web Audio
for capture, PWA target. No backend, accounts, or cloud.

First milestone: get it working on **one Android phone + one acoustic piano** (the dev's own).

---

## 2. Load-bearing decisions (locked during prototyping)

These are not up for re-litigation; they shape the architecture.

- **Position-based, not time-based.** The playhead *waits* for the correct note. No tempo
  tracking, no score-following alignment. This is what makes the project feasible solo — it
  removes the hardest problem in real-time music software.
- **Latency target dropped.** The old `<100 ms` goal is deleted. Because detection only gates
  cursor advance, a 200 ms detection delay is invisible. Optimize for *correctness*, not speed.
- **Detection is constrained verification, not transcription.** At every cursor position the app
  already knows which notes to expect. So the detector's real job is "are these specific expected
  pitches present?" — far easier than open-ended polyphonic transcription. Lean on this prior
  everywhere.
- **OSMD cursor is the single source of truth for "what's expected now."** Do NOT build a parallel
  MusicXML event parser. Use `osmd.cursor` + the notes under it, derive expected MIDI numbers from
  that. Avoids drift on repeats/voltas/ties/grace notes.
- **Onset detection is a required, named subsystem.** Pitch-presence alone is insufficient: an
  acoustic piano sustains and rings, so repeated notes and held-then-restruck notes need onsets.
  The matcher must consume note *onset events*, not "currently sounding pitches."
- **Detector is swappable behind one interface:** `(audioFrame) => DetectedNote[]`. Everything
  below the interface (template matching now, possibly Basic Pitch later) can change without
  touching the matcher or UI.

### Critical audio-capture gotcha
`getUserMedia` defaults `echoCancellation`, `noiseSuppression`, and `autoGainControl` to **on**,
and all three mangle musical audio. They MUST be explicitly disabled:
```js
navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
});
```
This is the #1 reason in-browser music apps "detect nothing." Already handled in the prototype.

---

## 3. The detector prototype

File: **`piano-detect-test.html`** — a standalone, dependency-free diagnostic page (Phase 0 spike).
It opens the mic, runs FFT-based harmonic template matching every frame, and shows a
chromatic spectrum→keyboard strip + a live readout of detected MIDI numbers. Tuning sliders let
you adjust live on real hardware.

### Algorithm (current): greedy harmonic subtraction
The core is in `analyzeFrame()`. It evolved across two versions:

- **v1 (failed on chords):** scored every note by harmonic-energy sum, normalized against the
  single loudest note in the frame, thresholded. This is **structurally anti-polyphonic** — chord
  energy splits across tones and they share partials, so quieter chord tones fall under the
  normalized cutoff. Melody worked, chords totally failed. *(Lesson: max-normalization punishes
  polyphony. Don't go back to it.)*

- **v2 (current):** greedy iterative estimation —
  1. Score every candidate note by its harmonic series, **fundamental-dominant** (`fund + 0.5*upper`),
     so each genuine note survives subtraction of *shared upper* partials.
  2. Accept the strongest note.
  3. **Subtract its harmonic series from the residual spectrum** (multiply claimed bins by
     `1 - subtraction`).
  4. Re-scan the residual; repeat until the next-best score falls below `stopRatio * firstScore`
     or `MAX_POLYPHONY` (8) is hit.

  This resolves chords (after C4 is peeled, E4/G4 are the strongest things left) **and** kills
  octave ghosts for free (a ghost's "fundamental" is a real note's harmonic, which just got
  subtracted).

### Key parameters (exposed as sliders, with sane defaults)
| Param | Default | Meaning |
|---|---|---|
| Sensitivity | 0.45 | Sets `stopRatio = 0.18 - 0.15*sens`; higher = peel keeps picking quieter notes. Main lever for missing chord tones. |
| Harmonic subtraction | 0.85 | Fraction of an accepted note's harmonic bins removed before next scan. Higher = fewer ghosts, but risks eating shared-partial chord tones. |
| Harmonics counted | 6 | Partials per note template. |
| FFT size | 16384 | Resolution vs. window. 32768 ≈ 1.3 Hz/bin for low notes; longer window (~0.74 s) but fine for position-based. |
| Silence gate (RMS) | 0.010 | Blanks detection below this level. |
| Note range | MIDI 36–96 | Candidate range. |

Implementation details worth preserving: harmonic search window is ±~10 cents (`fh*0.006`, min 1
bin) to absorb tuning + piano inharmonicity; spectrum read as dB via `getFloatFrequencyData`,
converted to linear magnitude; `smoothingTimeConstant = 0` for responsiveness.

### Known limits (inherent to the method)
- **Low register is worst** — FFT bin spacing can't separate adjacent low semitones, and dense
  low partials confuse subtraction. Bump FFT size there.
- There may be a **tension** between ghost-rejection and chord-completeness: the subtraction level
  that kills ghosts can start eating real chord tones. **Whether both can hold at one setting is the
  go/no-go verdict for template-matching-only** (see §4).

---

## 4. Test status (on real phone + piano)

- ✅ **Melody / single notes: detected well.**
- ❌ **Chords failed under v1** (max-normalization).
- 🔄 **v2 (greedy subtraction) deployed; chord re-test was the next action when this handoff was
  written.** The specific result to capture: *at settings where single notes are rock-solid, does a
  C-E-G triad come through complete AND stay free of ghosts?*
  - If **yes** → template matching is sufficient for the MVP. Proceed to integrate it.
  - If **mid triads work but dense/low voicings don't** → still a fine MVP result: ship
    melody + simple chords on template matching, defer hard cases to the fallback.
  - If **chords can't hold without ghosts at any setting** → escalate to the fallback ladder (§6).

---

## 5. Android on-device testing — the setup that worked

Goal: serve the page to the phone with a **secure context** (mic needs HTTPS or localhost).

- ❌ `cloudflared` quick tunnel (`*.trycloudflare.com`) — worked on the Mac, but the **phone could
  not reach it** (domain blocked; persisted across both networks and with Private DNS off). Avoid
  for phone testing.
- ✅ **Working path — LAN + Chrome insecure-origin whitelist:**
  1. Phone + Mac on the **same WiFi** (no client isolation on the router).
  2. On the Mac: `python3 -m http.server 8000` in the folder with the HTML.
  3. Confirm the phone can load `http://<MAC_LAN_IP>:8000/piano-detect-test.html` (loads but mic
     dead — expected). Dev's Mac LAN IP was `192.168.1.135`.
  4. Phone Chrome → `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → add
     `http://192.168.1.135:8000` → **Enabled** → Relaunch. Mic now works over plain LAN HTTP.
- Note: a plain LAN IP over HTTP will NOT grant mic without that flag (or a real cert). `localhost`
  on the Mac is a secure context with no setup — use it for desktop testing.

For the real PWA later, plan a proper dev HTTPS cert (e.g. `vite --host` + mkcert) so the flag hack
isn't needed.

---

## 6. Polyphony fallback ladder (if template matching proves insufficient)

In order of escalation:
1. **Score-informed template matching** (current). Lightest, no model, leans on the prior. Make it
   *truly* score-constrained in-app: only test expected notes + a few neighbors, not all 88.
2. **Windowed Basic Pitch (Spotify)** — `@spotify/basic-pitch-ts`, polyphonic, runs in-browser via
   TF.js (CPU or WebGPU), resamples to 22.05 kHz. Built for files; feed it overlapping windows for
   streaming. Primary fallback. Test inference latency on the actual phone early.
3. **Onsets and Frames (Magenta)** — piano-specialized, more accurate on piano, but heavier to run
   well on Android. Only if Basic Pitch's accuracy disappoints.
4. **Lightweight research models** (Onsets & Velocities; Mobile-AMT, which targets real-world phone
   recordings) — future, would require ONNX export + runtime wiring. Not MVP.

CREPE is ruled out — it's monophonic, can't do chords.

---

## 7. Next steps for the coder (ordered)

1. **Capture the chord verdict** (§4) using the prototype before writing integration code — it
   decides which detector path you're building around.
2. **Stand up the project skeleton** per the spec architecture (React/TS/Vite, Zustand, OSMD).
   Render a MusicXML file and get the OSMD cursor moving manually first (Phase 1).
3. **Port the detector** behind `(audioFrame) => DetectedNote[]`. Lift `analyzeFrame()` from
   `piano-detect-test.html` into `audio/pitchDetector.ts`. Move FFT off the main thread:
   AudioWorklet captures frames → Web Worker runs detection → results to main thread (keeps 60 FPS
   rendering intact; inference at ~10–20 Hz is plenty). **Do not** try to run a model inside the
   AudioWorklet.
4. **Make detection score-informed in-app:** feed the detector the expected MIDI set from the OSMD
   cursor so it verifies rather than transcribes. This should materially improve chord reliability
   over the unconstrained prototype.
5. **Add onset detection** (e.g., spectral flux) so the matcher fires on note onsets, not
   steady-state presence. Required for repeated notes.
6. **Build the pure matcher** (`score/matcher.ts`): expected vs. detected, chord = all expected
   notes within ~150 ms, order-independent, advance on completion, never auto-skip. Keep it
   UI-independent and unit-tested.
7. **WAV regression harness** (deferred but valuable): record a few known chords once, run the
   detector against the files to A/B settings without replaying live. Makes the detector
   regression-testable.
8. **UX caution on the red "incorrect" flash:** piano throws octave/harmonic false positives
   constantly. Default to "stay put, no penalty" on non-matches; require brief stability before
   judging a note *wrong*. Aggressive red will feel broken even when playing correctly.
9. Remember OSMD **re-renders on resize and wipes notehead colors** — reapply colors after every
   layout pass.

---

## 8. Files
- `piano-detect-test.html` — the standalone detector prototype (run via `python3 -m http.server`).
- `HANDOFF.md` — this document.
- (product spec — separate)
