/**
 * The store interface (§2, §8).
 *
 * Local-first: the SQLite write *is* the commit. Sync and transcription are background
 * details, and the marker pad never waits on either. Implementations live beside this
 * file — sql.js in the browser today, @capacitor-community/sqlite on device later —
 * and both run the identical SQL from core/schema.ts so they cannot drift.
 */

import type { Marker, Session, Camera } from '../core/markers';

/** Per-row sync state shown in the recent list (§9). */
export type SyncState = 'local' | 'queued' | 'synced';

export interface MarkerStore {
  init(): Promise<void>;

  putSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;

  putCamera(camera: Camera): Promise<void>;
  listCameras(sessionId: string): Promise<Camera[]>;

  /** Idempotent by ULID primary key (§8) — a retry after a flaky radio cannot duplicate. */
  putMarker(marker: Marker): Promise<void>;
  /** Live markers for a session, newest first. Soft-deleted rows are excluded. */
  listMarkers(sessionId: string): Promise<Marker[]>;
  /** Everything touched since a watermark, soft deletes included — what sync sends. */
  markersChangedSince(sessionId: string, updatedAfter: string): Promise<Marker[]>;

  /** How many rows the server has not seen yet; shown so the operator knows (§9). */
  queueDepth(sessionId: string): Promise<number>;

  /** Flush to durable storage. A no-op where writes are already durable. */
  persist(): Promise<void>;
  close(): Promise<void>;
}
