-- Instance-wide settings that a deployment can create from the web app's
-- setup page instead of environment variables: the GitHub App it signs in
-- with, and the Railway environment its sandboxes run in. One JSON value per
-- key; secrets inside it are encrypted with TOKEN_ENCRYPTION_KEY.
create table instance_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
