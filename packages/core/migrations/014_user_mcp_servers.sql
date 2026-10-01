-- MCP settings belong to the account so every thread can use them. Credentials,
-- custom header values and stdio environment values are encrypted together.
create table user_mcp_servers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null check (name ~ '^[A-Za-z0-9_-]{1,64}$' and lower(name) not in ('factory', '__proto__', 'constructor', 'prototype')),
  enabled      boolean not null default true,
  config       jsonb not null,
  secrets_enc  text,
  revision     integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, id)
);
create unique index user_mcp_servers_name on user_mcp_servers (user_id, lower(name));

-- State is hashed, short lived, single use, and survives harness redeployments.
create table mcp_oauth_states (
  state_hash   text primary key,
  user_id      uuid not null,
  server_id    uuid not null,
  revision     integer not null,
  expires_at   timestamptz not null,
  foreign key (user_id, server_id) references user_mcp_servers(user_id, id) on delete cascade
);
create index mcp_oauth_states_expiry on mcp_oauth_states (expires_at);
