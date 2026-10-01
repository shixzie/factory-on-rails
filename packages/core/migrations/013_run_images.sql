-- Only metadata travels with runs/events; image bytes are loaded when needed.
alter table runs add column images jsonb not null default '[]'::jsonb;

create table run_images (
  id uuid primary key,
  run_id uuid not null references runs(id) on delete cascade,
  name text not null,
  media_type text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  data text not null,
  created_at timestamptz not null default now()
);
create index run_images_run_idx on run_images(run_id);
