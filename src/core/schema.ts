/**
 * The §8 data model in the SQLite dialect. Same shape as the Postgres in
 * supabase/migrations/0001_markers.sql — local SQLite is the truth, Supabase mirrors it.
 *
 * Kept in core/ (not platform/) because it is just text: both the sql.js browser store
 * and the Capacitor SQLite store run exactly these statements, so the two cannot drift.
 */

export const SCHEMA_VERSION = 1;

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
