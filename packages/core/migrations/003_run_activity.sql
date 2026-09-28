-- Structured run activity: what the agent said and did (messages, tool calls
-- and their results), messages the user sends to a running agent, and a
-- snapshot of the files the run changed.
alter table run_events drop constraint run_events_kind_check;
alter table run_events add constraint run_events_kind_check check (kind in (
  'info', 'error', 'stdout', 'stderr',
  'message', 'thinking', 'tool_call', 'tool_result', 'agent_result', 'user_message'
));
-- Per-kind details, e.g. a tool call's name and input.
alter table run_events add column data jsonb;
create index run_events_user_message_idx on run_events(run_id, id) where kind = 'user_message';

-- True while the agent is waiting for the user to answer a question.
alter table runs add column awaiting_input boolean not null default false;

-- The latest diff of the run's branch against the commit it started from,
-- replaced as the agent works, so it never grows past one patch per run.
create table run_diffs (
  run_id      uuid primary key references runs(id) on delete cascade,
  patch       text not null,
  truncated   boolean not null default false,
  updated_at  timestamptz not null default now()
);
