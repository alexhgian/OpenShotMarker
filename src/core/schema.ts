/**
 * The §8 data model in the SQLite dialect. Same shape as the Postgres in
 * supabase/migrations/0001_markers.sql — local SQLite is the truth, Supabase mirrors it.
 *
 * Kept in core/ (not platform/) because it is just text: both the sql.js browser store
 * and the Capacitor SQLite store run exactly these statements, so the two cannot drift.
 */

export const SCHEMA_VERSION = 2;

/**
 * Migrations from an earlier on-disk schema, applied in order for any version below
 * SCHEMA_VERSION. `create table if not exists` does nothing to a table that already
 * exists, so a database written before amendment 0001 would otherwise keep a markers
 * table with no wall_ms and no clock, and every insert would fail.
 *
 * SQLite's ALTER TABLE ADD COLUMN requires a non-null column to carry a default. The
 * defaults chosen here are the honest ones for rows that predate the §3.4 guard: those
 * markers were taken from the monotonic clock, and no wall witness was recorded.
 */
export const MIGRATIONS: Record<number, string> = {
  // v1 -> v2: amendment 0001 Part A.
  2: `
    alter table markers add column wall_ms integer not null default 0;
    alter table markers add column clock text not null default 'mono';
    alter table cameras add column anchor text;
  `,
};

export const SCHEMA_SQL = `
pragma foreign_keys = on;

create table if not exists sessions (
  id                text primary key,
  label             text not null,
  fps               text not null,
  drop_frame        integer not null,
  reference_camera  text not null,
  device            text not null,
  created_at        text not null,
  updated_at        text not null
);

create table if not exists cameras (
  id                       text primary key,
  session_id               text not null references sessions(id) on delete cascade,
  key                      text not null,
  label                    text,
  fps                      text not null,
  drop_frame               integer not null,
  roi                      text,
  offset_frames            integer not null default 0,
  offset_measured_at       text,
  offset_confidence_frames real,
  bin_hint                 text,
  last_locked_at           text,
  lock_quality             text,
  anchor                   text,
  unique (session_id, key)
);

create table if not exists markers (
  id          text primary key,
  session_id  text not null references sessions(id) on delete cascade,
  camera_id   text not null references cameras(id),
  tc          text not null,
  frame       integer not null,
  type        text not null,
  color       text not null,
  note        text not null default '',
  source      text not null,
  preroll_ms  integer not null,
  wall_ms     integer not null,
  clock       text not null default 'mono',
  audio_path  text,
  device      text not null,
  created_at  text not null,
  updated_at  text not null,
  deleted_at  text
);

-- "Recent markers, newest first" (§9) is the query the UI runs constantly. Newest is
-- by creation, not by frame: a re-lock can move the timecode backwards, and the
-- operator's list must still read in the order they tapped.
create index if not exists markers_session_created on markers (session_id, created_at desc);
-- Exports walk a session in timeline order instead (§10).
create index if not exists markers_session_frame on markers (session_id, frame);
-- Sync sends everything touched since a watermark, deletes included (§8).
create index if not exists markers_updated on markers (updated_at);

create table if not exists meta (
  key   text primary key,
  value text not null
);
`;
