-- Users who signed in with GitHub. Tokens are GitHub App user access tokens,
-- encrypted with TOKEN_ENCRYPTION_KEY (AES-256-GCM) before they reach the database.
create table users (
  id                        uuid primary key default gen_random_uuid(),
  github_id                 bigint not null unique,
  github_login              text not null,
  name                      text,
  avatar_url                text,
  access_token_enc          text not null,
  access_token_expires_at   timestamptz,
  refresh_token_enc         text,
  refresh_token_expires_at  timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Browser sessions. The cookie holds a random token; only its sha256 is stored.
create table sessions (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_user_id_idx on sessions(user_id);

-- A run is one unit of agent work: one task, against one repo, in one sandbox.
create type run_status as enum ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled');

create table runs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  repo_full_name   text not null,
  installation_id  bigint not null,
  base_branch      text not null,
  task             text not null,
  status           run_status not null default 'queued',
  branch           text,
  sandbox_id       text,
  pull_request_url text,
  error            text,
  claimed_by       text,
  heartbeat_at     timestamptz,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
create index runs_queue_idx on runs(created_at) where status = 'queued';
create index runs_user_idx on runs(user_id, created_at desc);

-- Append-only log of what happened during a run (status changes, agent output).
create table run_events (
  id          bigserial primary key,
  run_id      uuid not null references runs(id) on delete cascade,
  at          timestamptz not null default now(),
  kind        text not null check (kind in ('info', 'error', 'stdout', 'stderr')),
  message     text not null
);
create index run_events_run_idx on run_events(run_id, id);
