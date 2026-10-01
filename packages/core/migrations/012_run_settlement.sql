-- Manual settlement only affects thread organization; a follow-up reopens it.
alter table runs add column settled_at timestamptz;
