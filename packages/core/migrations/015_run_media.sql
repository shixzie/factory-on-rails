-- Previewable files from a run (images, video, PDF): files the agent changed
-- and images tools showed it. Keyed by git blob id, which the diff and tool
-- results point at, so the same file is stored once per run.
create table run_media (
  run_id     uuid not null references runs(id) on delete cascade,
  sha        text not null check (sha ~ '^[0-9a-f]{40}$'),
  media_type text not null check (media_type in (
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/svg+xml',
    'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf'
  )),
  size       integer not null,
  data       bytea not null,
  created_at timestamptz not null default now(),
  primary key (run_id, sha)
);
