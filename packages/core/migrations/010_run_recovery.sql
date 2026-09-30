-- A replacement runner reconnects to these sandbox sessions after a deploy or
-- crash. Recovering a turn keeps its number, start time and pending cancellation.
alter table runs add column execution jsonb;
alter table runs add column recovering boolean not null default false;

drop index runs_queue_idx;
create index runs_queue_idx on runs(created_at)
  where status = 'queued' or (status = 'cancelling' and claimed_by is null and recovering);

-- Retained command output is replayed when reconnecting. Each structured event
-- is persisted once while ordinary events continue to be append-only.
create unique index run_events_replay_key_idx on run_events(run_id, (data->>'_replayKey'))
  where data->>'_replayKey' is not null;
