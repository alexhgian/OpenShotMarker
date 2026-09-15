/**
 * The ordering rule from §9, made structural.
 *
 * `capture()` is deliberately NOT async. It cannot contain an `await`, so the timestamp
 * it takes on its first line cannot drift behind a store write, a render or a network
 * call — the compiler enforces what a comment would only ask for. It returns the
 * finished Marker synchronously; the store write is handed off afterwards and nobody
 * waits on it (§2: the SQLite write is the commit, the pad never waits on the network).
 *
 * No timecode logic lives here. This is ordering glue over core/markers.ts, which is
 * where the maths is and where it is tested.
 */

import { createMarker, type Marker, type MarkerType, type MarkerSource } from '../core/markers';
import type { TcClock, MonotonicNow } from '../core/clock';
import type { MarkerStore } from '../platform/store';

export interface RecorderDeps {
  store: MarkerStore;
  clock: TcClock;
  session_id: string;
  camera_id: string;
  device: string;
  /** §3.3: performance.now(). Injected so tests need no real time. */
  now: MonotonicNow;
  /** Called after the row is durable, so the UI can move a row from local to synced. */
  onCommitted?: (marker: Marker) => void;
  onError?: (marker: Marker, err: unknown) => void;
}

export interface CaptureOptions {
  note?: string;
  source?: MarkerSource;
  prerollMs?: number;
}

export class MarkerRecorder {
  constructor(private readonly deps: RecorderDeps) {}

  /**
   * Synchronous by construction. Call this as the first statement of the pointerdown
   * handler; everything else in that handler may happen whenever it likes.
   */
  capture(type: MarkerType, opts: CaptureOptions = {}): Marker {
    const tCapturedMs = this.deps.now(); // ← the number. Nothing above it, nothing awaited.

    const marker = createMarker({
      session_id: this.deps.session_id,
      camera_id: this.deps.camera_id,
      type,
      tCapturedMs,
      clock: this.deps.clock,
      device: this.deps.device,
      note: opts.note ?? '',
      source: opts.source ?? 'tap',
      ...(opts.prerollMs === undefined ? {} : { prerollMs: opts.prerollMs }),
    });

    this.commit(marker);
    return marker;
  }

  /** Fire-and-forget. A rejected write must never surface as an unhandled rejection. */
  private commit(marker: Marker): void {
    void (async () => {
      try {
        await this.deps.store.putMarker(marker);
        await this.deps.store.persist();
        this.deps.onCommitted?.(marker);
      } catch (err) {
        this.deps.onError?.(marker, err);
      }
    })();
  }

  /** Same handoff for an edited or deleted row. */
  update(marker: Marker): void {
    this.commit(marker);
  }
}
