-- A short name for each run, shown in the sidebar and the run header. A small
-- model writes it from the task after the run is created; once the user renames
-- the run, the name is theirs and nothing overwrites it.
alter table runs add column title text;
alter table runs add column title_by_user boolean not null default false;
