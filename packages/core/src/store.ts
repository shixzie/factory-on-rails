import type { Sql } from "./db.js";

export type RunStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];

export interface UserRow {
  id: string;
  github_id: string;
  github_login: string;
  name: string | null;
  avatar_url: string | null;
  access_token_enc: string;
  access_token_expires_at: Date | null;
  refresh_token_enc: string | null;
  refresh_token_expires_at: Date | null;
}

export interface RunRow {
  id: string;
  user_id: string;
  repo_full_name: string;
  installation_id: string;
  base_branch: string;
  task: string;
  status: RunStatus;
  branch: string | null;
  sandbox_id: string | null;
  pull_request_url: string | null;
  error: string | null;
  claimed_by: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  at: Date;
  kind: "info" | "error" | "stdout" | "stderr";
  message: string;
}

// ---- users & sessions -------------------------------------------------------

export async function upsertUser(
  sql: Sql,
  u: Omit<UserRow, "id" | "github_id"> & { github_id: number },
): Promise<UserRow> {
  const [row] = await sql<UserRow[]>`
    insert into users ${sql(u)}
    on conflict (github_id) do update set
      github_login = excluded.github_login,
      name = excluded.name,
      avatar_url = excluded.avatar_url,
      access_token_enc = excluded.access_token_enc,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_enc = excluded.refresh_token_enc,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      updated_at = now()
    returning *`;
  return row!;
}

export async function updateUserTokens(
  sql: Sql,
  userId: string,
  t: Pick<UserRow, "access_token_enc" | "access_token_expires_at" | "refresh_token_enc" | "refresh_token_expires_at">,
): Promise<void> {
  await sql`update users set ${sql(t)}, updated_at = now() where id = ${userId}`;
}

export async function createSession(sql: Sql, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
  await sql`
    insert into sessions (token_hash, user_id, expires_at)
    values (${tokenHash}, ${userId}, now() + make_interval(secs => ${ttlSeconds}))`;
}

export async function userForSession(sql: Sql, tokenHash: string): Promise<UserRow | undefined> {
  const [row] = await sql<UserRow[]>`
    select u.* from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${tokenHash} and s.expires_at > now()`;
  return row;
}

export async function deleteSession(sql: Sql, tokenHash: string): Promise<void> {
  await sql`delete from sessions where token_hash = ${tokenHash}`;
}

// ---- runs -------------------------------------------------------------------

export async function enqueueRun(
  sql: Sql,
  r: Pick<RunRow, "user_id" | "repo_full_name" | "base_branch" | "task"> & { installation_id: number },
): Promise<RunRow> {
  const [row] = await sql<RunRow[]>`insert into runs ${sql(r)} returning *`;
  await sql`select pg_notify('runs_queued', ${row!.id})`;
  return row!;
}

export function listRuns(sql: Sql, userId: string, limit = 50): Promise<RunRow[]> {
  return sql<RunRow[]>`select * from runs where user_id = ${userId} order by created_at desc limit ${limit}`;
}

export async function getRun(sql: Sql, id: string): Promise<RunRow | undefined> {
  const [row] = await sql<RunRow[]>`select * from runs where id = ${id}`;
  return row;
}

/**
 * Atomically claims the oldest queued run. SKIP LOCKED lets several runner
 * replicas poll the same table without handing out a run twice.
 */
export async function claimNextRun(sql: Sql, workerId: string): Promise<RunRow | undefined> {
  const [row] = await sql<RunRow[]>`
    update runs set status = 'running', claimed_by = ${workerId}, started_at = now(), heartbeat_at = now()
    where id = (
      select id from runs where status = 'queued'
      order by created_at
      for update skip locked
      limit 1
    )
    returning *`;
  return row;
}

export async function heartbeat(sql: Sql, runId: string): Promise<RunStatus | undefined> {
  const [row] = await sql<{ status: RunStatus }[]>`
    update runs set heartbeat_at = now() where id = ${runId} returning status`;
  return row?.status;
}

export async function updateRun(
  sql: Sql,
  runId: string,
  patch: Partial<Pick<RunRow, "branch" | "sandbox_id" | "pull_request_url">>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await sql`update runs set ${sql(patch)} where id = ${runId}`;
}

export async function finishRun(
  sql: Sql,
  runId: string,
  status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
  error?: string,
): Promise<void> {
  await sql`
    update runs set status = ${status}, error = ${error ?? null}, finished_at = now()
    where id = ${runId} and status in ('running', 'cancelling')`;
}

/** Marks a queued run cancelled, or asks the runner to stop a running one. */
export async function requestCancel(sql: Sql, runId: string, userId: string): Promise<boolean> {
  const rows = await sql`
    update runs set
      status = case when status = 'queued' then 'cancelled'::run_status else 'cancelling'::run_status end,
      finished_at = case when status = 'queued' then now() else finished_at end
    where id = ${runId} and user_id = ${userId} and status in ('queued', 'running')
    returning id`;
  return rows.length > 0;
}

/** Runs whose runner stopped heartbeating (crash, redeploy) are failed so they don't hang forever. */
export function reapStaleRuns(sql: Sql, staleAfterSeconds: number): Promise<Pick<RunRow, "id" | "sandbox_id">[]> {
  return sql`
    update runs set status = 'failed', error = 'runner stopped heartbeating', finished_at = now()
    where status in ('running', 'cancelling')
      and heartbeat_at < now() - make_interval(secs => ${staleAfterSeconds})
    returning id, sandbox_id`;
}

// ---- events -----------------------------------------------------------------

export async function appendEvents(
  sql: Sql,
  runId: string,
  events: Pick<RunEventRow, "kind" | "message">[],
): Promise<void> {
  if (events.length === 0) return;
  await sql`insert into run_events ${sql(events.map((e) => ({ run_id: runId, kind: e.kind, message: e.message })))}`;
}

export function listEvents(sql: Sql, runId: string, afterId = 0, limit = 500): Promise<RunEventRow[]> {
  return sql<RunEventRow[]>`
    select * from run_events where run_id = ${runId} and id > ${afterId}
    order by id limit ${limit}`;
}
