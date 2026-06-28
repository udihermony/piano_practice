import { describe, it, expect } from 'vitest';
import { evaluateMatch } from './matcher';

describe('evaluateMatch', () => {
  it('matches a single expected note that was detected', () => {
    const r = evaluateMatch([60], [60]);
    expect(r.matched).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('matches a chord when all expected notes are present (order-independent)', () => {
    const r = evaluateMatch([60, 64, 67], [67, 60, 64]);
    expect(r.matched).toBe(true);
    expect(r.satisfied).toEqual([60, 64, 67]);
  });

  it('tolerates extra detected ghost notes', () => {
    const r = evaluateMatch([60, 64, 67], [60, 64, 67, 74]);
    expect(r.matched).toBe(true);
    expect(r.extra).toEqual([74]);
  });

  it('does not match when an expected chord tone is missing', () => {
    const r = evaluateMatch([60, 64, 67], [60, 67]);
    expect(r.matched).toBe(false);
    expect(r.missing).toEqual([64]);
  });

  it('does not match a wrong single note', () => {
    const r = evaluateMatch([60], [62]);
    expect(r.matched).toBe(false);
    expect(r.missing).toEqual([60]);
    expect(r.extra).toEqual([62]);
  });

  it('never matches an empty expected set (rest)', () => {
    expect(evaluateMatch([], []).matched).toBe(false);
    expect(evaluateMatch([], [60]).matched).toBe(false);
  });

  it('does not match on silence when a note is expected', () => {
    const r = evaluateMatch([60], []);
    expect(r.matched).toBe(false);
    expect(r.missing).toEqual([60]);
  });
});
