-- Previews (see packages/core/src/preview.ts). The preview gateway records
-- which ports are listening in a run's sandbox while the sandbox's preview
-- agent is connected (null when it is not), and when someone last used a
-- preview, so the runner keeps that sandbox from being stopped under them.
alter table runs
  add column preview_ports   jsonb,
  add column preview_seen_at timestamptz;

create index runs_preview_seen_idx on runs(preview_seen_at) where preview_seen_at is not null;
