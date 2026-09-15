import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MarkerRecorder } from '../../src/ui/recorder';
import { TcClock } from '../../src/core/clock';
import { tcToFrames, realFps } from '../../src/core/timecode';
import type { Marker } from '../../src/core/markers';
import type { MarkerStore } from '../../src/platform/store';

const clock = () =>
  new TcClock({
    fps: '29.97',
    drop: true,
    anchor: { tcFrame: tcToFrames('10:14:22;07', '29.97', true), t: 0 },
  });

/** A store whose writes never settle — stands in for a wedged disk or a dead radio. */
function hangingStore(): MarkerStore {
  const never = () => new Promise<never>(() => {});
  return {
    init: never,
    putSession: never,
    getSession: never,
    listSessions: never,
    putCamera: never,
    listCameras: never,
    putMarker: never,
    listMarkers: never,
    markersChangedSince: never,
    queueDepth: never,
    persist: never,
    close: never,
  } as unknown as MarkerStore;
}

function recordingStore(): { store: MarkerStore; written: Marker[]; resolve: () => void } {
  const written: Marker[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const store = {
    putMarker: async (m: Marker) => {
      await gate;
      written.push(m);
    },
    persist: async () => {},
  } as unknown as MarkerStore;
  return { store, written, resolve: () => release() };
}

const deps = (store: MarkerStore, now: () => number, extra = {}) => ({
  store,
  clock: clock(),
  session_id: 'S',
  camera_id: 'C',
  device: 'test',
  now,
  ...extra,
});

describe('§9 rule 1 — the timestamp is taken before the store write', () => {
  it('returns a finished marker even when the store write never resolves', () => {
    const rec = new MarkerRecorder(deps(hangingStore(), () => 0));
    const m = rec.capture('great');
    // A complete, correct marker exists synchronously; nothing awaited the store.
    expect(m.frame).toBe(1104761 - Math.round(1.5 * realFps('29.97')));
    expect(m.tc).toBe('10:14:20;22');
    expect(m.type).toBe('great');
  });

  it('reads the clock before the write is even attempted', () => {
    const order: string[] = [];
    const now = () => {
      order.push('now');
      return 0;
    };
    const store = {
      putMarker: async () => {
        order.push('putMarker');
      },
      persist: async () => {
        order.push('persist');
      },
    } as unknown as MarkerStore;

    new MarkerRecorder(deps(store, now)).capture('great');
    expect(order[0]).toBe('now');
  });

  it('does not move the number while the write is in flight', async () => {
    const { store, written, resolve } = recordingStore();
    let t = 0;
    const rec = new MarkerRecorder(deps(store, () => t));
    const returned = rec.capture('great');

    // The clock runs on for ten seconds before the write lands.
    t = 10_000;
    resolve();
    await vi.waitFor(() => expect(written).toHaveLength(1));

    expect(written[0]!.frame).toBe(returned.frame);
    expect(written[0]!.tc).toBe(returned.tc);
  });

  it('capture() is not an async function — the compiler forbids an await inside it', () => {
    // The structural half of the guarantee: an `await` cannot be added to capture()
    // without changing its signature, and changing its signature breaks every caller.
    expect(MarkerRecorder.prototype.capture.constructor.name).toBe('Function');
    expect(Object.prototype.toString.call(MarkerRecorder.prototype.capture)).toBe(
      '[object Function]',
    );
    const src = MarkerRecorder.prototype.capture.toString();
    expect(src.startsWith('async')).toBe(false);
    expect(src).not.toMatch(/\bawait\b/);
  });

  it('the pointerdown handler captures before it touches React state', () => {
    // The lint-rule half: App.tsx's handler must not be async, and must call
    // recorder.capture before any setState. Reading the source is crude but it is
    // exactly the regression that would silently cost 200 ms of accuracy.
    const src = readFileSync(new URL('../../src/ui/App.tsx', import.meta.url), 'utf8');
    const handler = src.slice(
      src.indexOf('const onPadPointerDown'),
      src.indexOf('// ------------------------------------------------------------ manual lock'),
    );
    expect(handler).toContain('recorder.capture(');
    expect(handler).not.toMatch(/\basync\b/);
    expect(handler).not.toMatch(/\bawait\b/);
    // capture comes before the first setState in the handler body.
    expect(handler.indexOf('recorder.capture(')).toBeLessThan(handler.indexOf('setMarkers'));
    // and the pad is wired to pointerdown, not click (§9).
    expect(src).toContain('onPointerDown={() => onPadPointerDown(type)}');
    expect(src).not.toMatch(/onClick=\{\(\) => onPadPointerDown/);
  });
});

describe('the recorder hands the write off without waiting', () => {
  it('reports a commit once the row is durable', async () => {
    const committed: Marker[] = [];
    const store = {
      putMarker: async () => {},
      persist: async () => {},
    } as unknown as MarkerStore;
    const rec = new MarkerRecorder(
      deps(store, () => 0, { onCommitted: (m: Marker) => committed.push(m) }),
    );
    const m = rec.capture('cutaway');
    await vi.waitFor(() => expect(committed).toHaveLength(1));
    expect(committed[0]!.id).toBe(m.id);
  });

  it('surfaces a failed write instead of crashing as an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const store = {
      putMarker: async () => {
        throw new Error('disk full');
      },
      persist: async () => {},
    } as unknown as MarkerStore;
    const rec = new MarkerRecorder(deps(store, () => 0, { onError: (_m: Marker, e: unknown) => errors.push(e) }));
    rec.capture('note');
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(String(errors[0])).toContain('disk full');
  });

  it('swallows a failed write silently when no handler is given, rather than crashing', async () => {
    const store = {
      putMarker: async () => {
        throw new Error('nope');
      },
      persist: async () => {},
    } as unknown as MarkerStore;
    const rec = new MarkerRecorder(deps(store, () => 0));
    expect(() => rec.capture('note')).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('attaches a typed note and honours a pre-roll override', () => {
    const rec = new MarkerRecorder(deps(hangingStore(), () => 0));
    const m = rec.capture('great', { note: 'hair flip', source: 'typed', prerollMs: 0 });
    expect(m.note).toBe('hair flip');
    expect(m.source).toBe('typed');
    expect(m.preroll_ms).toBe(0);
    expect(m.frame).toBe(1104761);
  });

  it('sends an edited row back through the same handoff', async () => {
    const { store, written, resolve } = recordingStore();
    const rec = new MarkerRecorder(deps(store, () => 0));
    const m = rec.capture('great');
    rec.update({ ...m, note: 'edited' });
    resolve();
    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written[1]!.note).toBe('edited');
  });
});
