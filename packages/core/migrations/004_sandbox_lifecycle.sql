-- A run is now a conversation. After each turn its sandbox stays up so the
-- user can send another message; after a few idle minutes the runner stops it
-- (captures its disk as a checkpoint, then destroys the VM) and boots it again
-- from that checkpoint on the next message. A run with no activity for a week
-- is deleted along with its sandbox or checkpoint.
create type sandbox_state as enum ('none', 'running', 'stopping', 'stopped', 'deleted');

alter table runs
  add column sandbox_state           sandbox_state not null default 'none',
  add column sandbox_state_at        timestamptz,
  -- The checkpoint a stopped sandbox boots from (by name) and is deleted by (by id).
  add column sandbox_checkpoint_id   text,
  add column sandbox_checkpoint_name text,
  -- The last agent activity or user message: what idle stop and retention measure.
  add column last_activity_at        timestamptz not null default now(),
  -- How many times the runner has picked the run up (1 for the first task).
  add column turns                   integer not null default 0,
  -- The last user_message event handed to the agent.
  add column delivered_message_id    bigint not null default 0;

-- Runs from before this migration had their sandbox destroyed when they ended.
update runs set
  last_activity_at = coalesce(finished_at, heartbeat_at, started_at, created_at),
  sandbox_state = case
    when sandbox_id is null then 'none'::sandbox_state
    when status in ('running', 'cancelling') then 'running'::sandbox_state
    else 'deleted'::sandbox_state
  end,
  sandbox_state_at = now(),
  turns = case when started_at is null then 0 else 1 end,
  delivered_message_id = coalesce(
    (select max(e.id) from run_events e where e.run_id = runs.id and e.kind = 'user_message'),
    0
  );

create index runs_live_sandbox_idx on runs(last_activity_at) where sandbox_state in ('running', 'stopping');
create index runs_last_activity_idx on runs(last_activity_at);
