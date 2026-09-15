-- §8 data model, Postgres side. Local SQLite is the truth; this mirrors it.
--
-- Not applied from the cloud session that wrote it. Run `supabase db push` from the
-- desktop (HANDOFF.md, "What comes back to the desktop afterwards").
--
-- Sync rules this schema has to support (§8):
--   * client-generated ULIDs, so every upsert is idempotent and a retry after a flaky
--     radio cannot duplicate a marker;
--   * soft delete via deleted_at, so a delete on the phone reaches the server as a row
--     rather than as an absence;
--   * last-writer-wins on updated_at.

create extension if not exists pgcrypto;

create table if not exists sessions (
  id                text primary key,
  org_id            uuid not null,
  label             text not null,
  fps               text not null,
  drop_frame        boolean not null,
  reference_camera  text not null,
  device            text not null,
  created_at        timestamptz not null,
  updated_at        timestamptz not null
);

create table if not exists cameras (
  id                       text primary key,
  session_id               text not null references sessions(id) on delete cascade,
  key                      text not null,
  label                    text,
  fps                      text not null,
  drop_frame               boolean not null,
  roi                      jsonb,
  -- §6, and the sentence is kept in the file as well as the docs:
  --   A_frame = B_frame + offset_frames
  offset_frames            integer not null default 0,
  offset_measured_at       timestamptz,
  offset_confidence_frames real,
  bin_hint                 text,
  last_locked_at           timestamptz,
  lock_quality             jsonb,
  unique (session_id, key)
);

create table if not exists markers (
  id          text primary key,
  session_id  text not null references sessions(id) on delete cascade,
  camera_id   text not null references cameras(id),
  tc          text not null,
  -- Stored alongside tc deliberately (§8): it is what every export computes from, and
  -- recomputing it from the string later means re-deriving drop-frame state we knew.
  frame       integer not null,
  type        text not null check (type in ('earmark', 'great', 'cutaway', 'inout', 'note')),
  color       text not null,
  note        text not null default '',
  source      text not null check (source in ('tap', 'voice', 'typed')),
  preroll_ms  integer not null,
  -- audio_path is deliberately absent: recordings stay on the device, never synced (§8).
  device      text not null,
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  deleted_at  timestamptz
);

create index if not exists markers_session_created on markers (session_id, created_at desc);
create index if not exists markers_session_frame   on markers (session_id, frame);
create index if not exists markers_updated         on markers (updated_at);
create index if not exists cameras_session         on cameras (session_id);

-- ----------------------------------------------------------------- row-level security
--
-- §8: sessions are visible to the org; a marker's `device` is informational, not an ACL.
-- The org lookup below is a stub — it assumes a `members (user_id, org_id)` table that
-- this migration does not create, because membership belongs to whatever auth model the
-- desktop step settles on. Until that exists these policies deny everything, which is
-- the safe direction to be wrong in.

alter table sessions enable row level security;
alter table cameras  enable row level security;
alter table markers  enable row level security;

create or replace function current_org_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select org_id from members where user_id = auth.uid();
$$;

drop policy if exists sessions_org_access on sessions;
create policy sessions_org_access on sessions
  for all
  using (org_id in (select current_org_ids()))
  with check (org_id in (select current_org_ids()));

drop policy if exists cameras_org_access on cameras;
create policy cameras_org_access on cameras
  for all
  using (exists (
    select 1 from sessions s
     where s.id = cameras.session_id and s.org_id in (select current_org_ids())))
  with check (exists (
    select 1 from sessions s
     where s.id = cameras.session_id and s.org_id in (select current_org_ids())));

drop policy if exists markers_org_access on markers;
create policy markers_org_access on markers
  for all
  using (exists (
    select 1 from sessions s
     where s.id = markers.session_id and s.org_id in (select current_org_ids())))
  with check (exists (
    select 1 from sessions s
     where s.id = markers.session_id and s.org_id in (select current_org_ids())));
