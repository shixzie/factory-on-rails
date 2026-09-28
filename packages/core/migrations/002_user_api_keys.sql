-- Bring your own key: each user's model provider API keys, encrypted with
-- TOKEN_ENCRYPTION_KEY. Only the runner decrypts them, to inject into that
-- user's sandboxes. `hint` is the last four characters, for display.
create table user_api_keys (
  user_id     uuid not null references users(id) on delete cascade,
  provider    text not null,
  key_enc     text not null,
  hint        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, provider)
);
