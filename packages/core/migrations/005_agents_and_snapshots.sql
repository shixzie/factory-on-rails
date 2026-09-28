-- Runs can use Claude Code or Codex, and a user can start their runs from a
-- sandbox snapshot: a Railway checkpoint an operator prepared (agent CLIs
-- signed in, toolchains installed) and declared in SANDBOX_SNAPSHOTS.
alter table runs add column agent text not null default 'claude';

alter table users add column sandbox_snapshot text;
