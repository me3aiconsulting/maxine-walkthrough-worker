-- Migration: walkthrough_captures
-- One row per walkthrough video, keyed to the intake session it belongs to.
-- Apply via Supabase:apply_migration (name: create_walkthrough_captures)

create table if not exists public.walkthrough_captures (
  session_id       uuid primary key references public.intake_sessions(id) on delete cascade,
  video_path       text,                      -- Storage path of the raw upload
  timeline_path    text,                      -- Storage path of timeline.json (worker output)
  status           text not null default 'pending'
                     check (status in ('pending','processing','ready','interpreted','error')),
  duration_s       integer,
  frame_count      integer,
  transcript_chars integer,
  error            text,
  dossier          jsonb,                     -- filled by the interpretation step (stage 2)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.walkthrough_captures is
  'Video walkthrough captures: decomposition output (timeline) and interpretation output (dossier).';

-- Service-role-only by default; the worker and edge functions use the service key.
alter table public.walkthrough_captures enable row level security;
