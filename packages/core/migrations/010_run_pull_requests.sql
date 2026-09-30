-- Keep the latest URL for runner compatibility, and retain every associated PR.
alter table runs add column pull_request_urls text[] not null default '{}';

update runs set pull_request_urls = array[lower(pull_request_url)]
where pull_request_url is not null;
