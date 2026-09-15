/**
 * The browser store (§2, §8): sql.js, persisted to IndexedDB.
 *
 * The dev harness must work with no device, no camera and no network (CLAUDE.md), so
 * this is what runs in `npm run dev` and in the Playwright check. On device the same
 * interface is implemented over @capacitor-community/sqlite, running the identical SQL
 * from core/schema.ts.
 *
 * Writes are synchronous against the in-memory database — that synchronous write is the
 * commit the marker pad waits for, and it is microseconds. Serialising to IndexedDB
 * happens after, and nothing blocks on it.
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS } from '../core/schema';
import type { Marker, Session, Camera, MarkerType, MarkerSource } from '../core/markers';
import type { ClockProvenance } from '../core/clock';
import type { FpsName } from '../core/timecode';
import type { MarkerStore } from './store';
import { type BlobStore, MemoryBlobStore } from './blob';

const DB_KEY = 'db';

export interface SqlJsStoreOptions {
  blobStore?: BlobStore;
  /** Where to find sql-wasm.wasm. Vite passes an asset URL; node resolves it itself. */
  locateFile?: (file: string) => string;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const bool = (v: unknown): boolean => Number(v) === 1;
const json = <T>(v: unknown): T | null => (v == null ? null : (JSON.parse(String(v)) as T));

export class SqlJsStore implements MarkerStore {
  private db: Database | null = null;
  private readonly blobs: BlobStore;
  private readonly locateFile: ((file: string) => string) | undefined;
  private static sql: SqlJsStatic | null = null;

  constructor(opts: SqlJsStoreOptions = {}) {
    this.blobs = opts.blobStore ?? new MemoryBlobStore();
    this.locateFile = opts.locateFile;
  }

  async init(): Promise<void> {
    if (this.db) return;
    if (!SqlJsStore.sql) {
      SqlJsStore.sql = await initSqlJs(this.locateFile ? { locateFile: this.locateFile } : {});
    }
    const saved = await this.blobs.get(DB_KEY);
    this.db = saved ? new SqlJsStore.sql.Database(saved) : new SqlJsStore.sql.Database();

    // Read the version BEFORE creating tables: on a fresh database `meta` does not
    // exist yet, and on an old one the create-if-not-exists below is a no-op, so this
    // is the only moment the two cases are distinguishable.
    const found = saved ? this.storedVersion() : SCHEMA_VERSION;
    this.db.run(SCHEMA_SQL);
    this.migrate(found);

    this.db.run('insert or replace into meta (key, value) values (?, ?)', [
      'schema_version',
      String(SCHEMA_VERSION),
    ]);
  }

  /** The schema version recorded in a database we just opened; 1 if it predates `meta`. */
  private storedVersion(): number {
    try {
      const rows = this.all("select value from meta where key = 'schema_version'");
      const raw = rows[0]?.value;
      return raw == null ? 1 : Number(raw);
    } catch {
      // No meta table at all: this database predates it, so it is v1 by definition.
      return 1;
    }
  }

  private migrate(from: number): void {
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (sql) this.handle.run(sql);
    }
  }

  private get handle(): Database {
    if (!this.db) throw new Error('store used before init()');
    return this.db;
  }

  private all(sql: string, params: unknown[] = []): Row[] {
    const stmt = this.handle.prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: Row[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as Row);
      return rows;
    } finally {
      stmt.free();
    }
  }

  // ------------------------------------------------------------------ sessions

  async putSession(s: Session): Promise<void> {
    this.handle.run(
      `insert into sessions (id, label, fps, drop_frame, reference_camera, device, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         label = excluded.label, fps = excluded.fps, drop_frame = excluded.drop_frame,
         reference_camera = excluded.reference_camera, device = excluded.device,
         updated_at = excluded.updated_at`,
      [s.id, s.label, s.fps, s.drop_frame ? 1 : 0, s.reference_camera, s.device, s.created_at, s.updated_at],
    );
  }

  private static toSession(r: Row): Session {
    return {
      id: str(r.id),
      label: str(r.label),
      fps: str(r.fps) as FpsName,
      drop_frame: bool(r.drop_frame),
      reference_camera: str(r.reference_camera),
      device: str(r.device),
      created_at: str(r.created_at),
      updated_at: str(r.updated_at),
    };
  }

  async getSession(id: string): Promise<Session | null> {
    const rows = this.all('select * from sessions where id = ?', [id]);
    return rows[0] ? SqlJsStore.toSession(rows[0]) : null;
  }

  async listSessions(): Promise<Session[]> {
    return this.all('select * from sessions order by created_at desc').map(SqlJsStore.toSession);
  }

  // ------------------------------------------------------------------- cameras

  async putCamera(c: Camera): Promise<void> {
    this.handle.run(
      `insert into cameras (id, session_id, key, label, fps, drop_frame, roi, offset_frames,
                            offset_measured_at, offset_confidence_frames, bin_hint,
                            last_locked_at, lock_quality)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         label = excluded.label, fps = excluded.fps, drop_frame = excluded.drop_frame,
         roi = excluded.roi, offset_frames = excluded.offset_frames,
         offset_measured_at = excluded.offset_measured_at,
         offset_confidence_frames = excluded.offset_confidence_frames,
         bin_hint = excluded.bin_hint, last_locked_at = excluded.last_locked_at,
         lock_quality = excluded.lock_quality`,
      [
        c.id, c.session_id, c.key, c.label, c.fps, c.drop_frame ? 1 : 0,
        c.roi ? JSON.stringify(c.roi) : null,
        c.offset_frames, c.offset_measured_at, c.offset_confidence_frames, c.bin_hint,
        c.last_locked_at, c.lock_quality ? JSON.stringify(c.lock_quality) : null,
      ],
    );
  }

  async listCameras(sessionId: string): Promise<Camera[]> {
    return this.all('select * from cameras where session_id = ? order by key', [sessionId]).map(
      (r): Camera => ({
        id: str(r.id),
        session_id: str(r.session_id),
        key: str(r.key),
        label: strOrNull(r.label),
        fps: str(r.fps) as FpsName,
        drop_frame: bool(r.drop_frame),
        roi: json<{ x: number; y: number; w: number; h: number }>(r.roi),
        offset_frames: num(r.offset_frames),
        offset_measured_at: strOrNull(r.offset_measured_at),
        offset_confidence_frames: numOrNull(r.offset_confidence_frames),
        bin_hint: strOrNull(r.bin_hint),
        last_locked_at: strOrNull(r.last_locked_at),
        lock_quality: json<{ inliers: number; residual_frames: number }>(r.lock_quality),
      }),
    );
  }

  // ------------------------------------------------------------------- markers

  /**
   * §8: the ULID primary key makes this idempotent, so a retried sync cannot duplicate.
   * Last-writer-wins on updated_at — an older copy arriving late does not clobber a
   * newer edit.
   */
  async putMarker(m: Marker): Promise<void> {
    this.handle.run(
      `insert into markers (id, session_id, camera_id, tc, frame, type, color, note, source,
                            preroll_ms, wall_ms, clock, audio_path, device, created_at,
                            updated_at, deleted_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         tc = excluded.tc, frame = excluded.frame, type = excluded.type,
         color = excluded.color, note = excluded.note, source = excluded.source,
         preroll_ms = excluded.preroll_ms, wall_ms = excluded.wall_ms,
         clock = excluded.clock, audio_path = excluded.audio_path,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
       where excluded.updated_at >= markers.updated_at`,
      [
        m.id, m.session_id, m.camera_id, m.tc, m.frame, m.type, m.color, m.note, m.source,
        m.preroll_ms, m.wall_ms, m.clock, m.audio_path, m.device, m.created_at,
        m.updated_at, m.deleted_at,
      ],
    );
  }

  private static toMarker(r: Row): Marker {
    return {
      id: str(r.id),
      session_id: str(r.session_id),
      camera_id: str(r.camera_id),
      tc: str(r.tc),
      frame: num(r.frame),
      type: str(r.type) as MarkerType,
      color: str(r.color),
      note: str(r.note),
      source: str(r.source) as MarkerSource,
      preroll_ms: num(r.preroll_ms),
      wall_ms: num(r.wall_ms),
      clock: str(r.clock) as ClockProvenance,
      audio_path: strOrNull(r.audio_path),
      device: str(r.device),
      created_at: str(r.created_at),
      updated_at: str(r.updated_at),
      deleted_at: strOrNull(r.deleted_at),
    };
  }

  async listMarkers(sessionId: string): Promise<Marker[]> {
    return this.all(
      `select * from markers
        where session_id = ? and deleted_at is null
        order by created_at desc, id desc`,
      [sessionId],
    ).map(SqlJsStore.toMarker);
  }

  async markersChangedSince(sessionId: string, updatedAfter: string): Promise<Marker[]> {
    return this.all(
      'select * from markers where session_id = ? and updated_at > ? order by updated_at',
      [sessionId, updatedAfter],
    ).map(SqlJsStore.toMarker);
  }

  async queueDepth(sessionId: string): Promise<number> {
    // Phase 1 has no sync, so everything local is unsent. The query is the shape the
    // §9 queue-depth badge needs; the watermark arrives with sync in a later phase.
    const rows = this.all('select count(*) as n from markers where session_id = ?', [sessionId]);
    return num(rows[0]?.n ?? 0);
  }

  // --------------------------------------------------------------- persistence

  async persist(): Promise<void> {
    await this.blobs.set(DB_KEY, this.handle.export());
  }

  async close(): Promise<void> {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}
