-- Null preserves the CLI defaults for existing runs.
alter table runs add column model text;
alter table runs add column reasoning_effort text
  check (reasoning_effort in ('low', 'medium', 'high', 'xhigh', 'max', 'ultra'));
alter table runs add constraint runs_agent_effort_check
  check (reasoning_effort is null or agent = 'codex' or reasoning_effort <> 'ultra');
