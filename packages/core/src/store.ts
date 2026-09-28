import { SqlClient, type SqlError } from "@effect/sql";
import { Array as Arr, Context, Effect, Layer, Option } from "effect";

export type RunStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];

/**
 * Where a run's sandbox is. `running` stays up between turns for follow-up
 * messages; `stopping` means a runner is checkpointing and destroying it;
 * `stopped` means only its checkpoint is left (it boots again on the next
 * message); `deleted` means it is gone and the next turn starts a new one
 * from the run's branch.
 */
export type SandboxState = "none" | "running" | "stopping" | "stopped" | "deleted";

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
  /** The sandbox snapshot the user's runs start from (see SANDBOX_SNAPSHOTS); null for the platform default. */
  sandbox_snapshot: string | null;
}

export type UserTokenColumns = Pick<
  UserRow,
  "access_token_enc" | "access_token_expires_at" | "refresh_token_enc" | "refresh_token_expires_at"
>;

export interface RunRow {
  id: string;
  user_id: string;
  repo_full_name: string;
  installation_id: string;
  base_branch: string;
  task: string;
  /** The coding agent: `claude` or `codex` (see AGENTS). */
  agent: string;
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
  awaiting_input: boolean;
  sandbox_state: SandboxState;
  sandbox_state_at: Date | null;
  sandbox_checkpoint_id: string | null;
  sandbox_checkpoint_name: string | null;
  last_activity_at: Date;
  turns: number;
  /** A bigint id, as a string. */
  delivered_message_id: string;
}

/** What the runner needs to stop or delete a run's sandbox. */
export type RunSandbox = Pick<RunRow, "id" | "sandbox_id" | "sandbox_state" | "sandbox_checkpoint_id">;

/**
 * What a run's log records. `info`/`error` are the runner's own steps and
 * `stdout`/`stderr` raw command output. When the agent streams structured
 * output (Claude Code's stream-json), it becomes `message`, `thinking`,
 * `tool_call` (data: id, name, input), `tool_result` (data: toolUseId,
 * isError) and a closing `agent_result`. `user_message` is something the user
 * sent to the running agent.
 */
export type RunEventKind =
  | "info"
  | "error"
  | "stdout"
  | "stderr"
  | "message"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "agent_result"
  | "user_message";

export interface RunEventRow {
  id: string;
  run_id: string;
  at: Date;
  kind: RunEventKind;
  message: string;
  data: Record<string, unknown> | null;
}

export type RunEvent = Pick<RunEventRow, "kind" | "message"> & { data?: Record<string, unknown> | null };

export interface RunDiffRow {
  patch: string;
  truncated: boolean;
  updated_at: Date;
}

export interface ApiKeySummary {
  provider: string;
  hint: string;
  updated_at: Date;
}

type Q<A> = Effect.Effect<A, SqlError.SqlError>;

export type RunPatch = Partial<
  Pick<
    RunRow,
    | "branch"
    | "sandbox_id"
    | "pull_request_url"
    | "awaiting_input"
    | "sandbox_state"
    | "sandbox_checkpoint_id"
    | "sandbox_checkpoint_name"
    | "delivered_message_id"
  >
>;

export interface StoreService {
  // users & sessions
  readonly upsertUser: (u: Omit<UserRow, "id" | "github_id" | "sandbox_snapshot"> & { github_id: number }) => Q<UserRow>;
  readonly getUser: (userId: string) => Q<Option.Option<UserRow>>;
  readonly setSandboxSnapshot: (userId: string, snapshot: string | null) => Q<void>;
  readonly updateUserTokens: (userId: string, t: UserTokenColumns) => Q<void>;
  readonly createSession: (tokenHash: string, userId: string, ttlSeconds: number) => Q<void>;
  readonly userForSession: (tokenHash: string) => Q<Option.Option<UserRow>>;
  readonly deleteSession: (tokenHash: string) => Q<void>;
  // runs
  readonly enqueueRun: (
    r: Pick<RunRow, "user_id" | "repo_full_name" | "base_branch" | "task"> & { installation_id: number; agent?: string },
  ) => Q<RunRow>;
  readonly listRuns: (userId: string, limit?: number) => Q<ReadonlyArray<RunRow>>;
  readonly getRun: (id: string) => Q<Option.Option<RunRow>>;
  /**
   * Atomically claims the oldest queued run. SKIP LOCKED lets several runner
   * replicas poll the same table without handing out a run twice.
   */
  readonly claimNextRun: (workerId: string) => Q<Option.Option<RunRow>>;
  /** Records liveness and returns the run's current status (how the runner notices cancellation). */
  readonly heartbeat: (runId: string) => Q<Option.Option<RunStatus>>;
  readonly updateRun: (runId: string, patch: RunPatch) => Q<void>;
  /**
   * Ends a turn. A run that succeeded while the user sent a message the agent
   * never got goes straight back to the queue, so that message is answered.
   */
  readonly finishRun: (runId: string, status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">, error?: string) => Q<void>;
  /** Marks a queued run cancelled, or asks the runner to stop a running one. */
  readonly requestCancel: (runId: string, userId: string) => Q<boolean>;
  /** Fails runs whose runner stopped heartbeating (crash, redeploy) so they don't hang forever. */
  readonly reapStaleRuns: (staleAfterSeconds: number) => Q<ReadonlyArray<Pick<RunRow, "id" | "sandbox_id">>>;
  /** A user message to a queued or running run: stored for the runner to hand to the agent. */
  readonly addUserMessage: (runId: string, text: string) => Q<void>;
  /**
   * A user message to a finished run: stored, and the run is queued again so
   * the agent picks the conversation up. None if the run is not finished.
   */
  readonly continueRun: (runId: string, text: string) => Q<Option.Option<RunRow>>;
  /**
   * Claims runs whose sandbox has been idle (no turn in progress, no activity)
   * for `idleSeconds`, marking them `stopping`. Also takes back `stopping`
   * runs whose runner gave up for `staleSeconds`.
   */
  readonly claimIdleSandboxes: (idleSeconds: number, staleSeconds: number, limit: number) => Q<ReadonlyArray<RunSandbox>>;
  /** Finished runs with no activity for `days`, oldest first. */
  readonly expiredRuns: (days: number, limit: number) => Q<ReadonlyArray<RunSandbox>>;
  /** Deletes a run (and its events and diff) if it is still finished and expired. */
  readonly deleteExpiredRun: (runId: string, days: number) => Q<boolean>;
  // events
  readonly appendEvents: (runId: string, events: ReadonlyArray<RunEvent>) => Q<void>;
  readonly listEvents: (runId: string, afterId?: number, limit?: number) => Q<ReadonlyArray<RunEventRow>>;
  /** Messages the user sent to a run after `afterId` (what the runner hands to the agent). */
  readonly listUserMessages: (runId: string, afterId: number) => Q<ReadonlyArray<RunEventRow>>;
  // the files a run changed
  readonly saveDiff: (runId: string, patch: string, truncated: boolean) => Q<void>;
  readonly getDiff: (runId: string) => Q<Option.Option<RunDiffRow>>;
  /** When the diff last changed, without loading it (what the run page polls). */
  readonly diffUpdatedAt: (runId: string) => Q<Option.Option<Date>>;
  // bring-your-own API keys
  readonly upsertApiKey: (k: { user_id: string; provider: string; key_enc: string; hint: string }) => Q<void>;
  /** What the UI may show: never the key itself. */
  readonly listApiKeys: (userId: string) => Q<ReadonlyArray<ApiKeySummary>>;
  readonly deleteApiKey: (userId: string, provider: string) => Q<void>;
  /** Encrypted keys for the runner to decrypt and inject into a run's sandbox. */
  readonly encryptedApiKeys: (userId: string) => Q<ReadonlyArray<{ provider: string; key_enc: string }>>;
  // instance settings (see instance.ts)
  readonly getSetting: (key: string) => Q<Option.Option<unknown>>;
  /** Saves a setting. With `onlyIfAbsent` an existing value is kept, and the result says whether this one was saved. */
  readonly putSetting: (key: string, value: unknown, options?: { readonly onlyIfAbsent?: boolean }) => Q<boolean>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  /** Wakes the runners (see worker.ts); polling is their fallback. */
  const notifyQueued = (runId: string) => sql`select pg_notify('runs_queued', ${runId})`.pipe(Effect.asVoid);

  const service: StoreService = {
    upsertUser: (u) =>
      sql<UserRow>`
        insert into users ${sql.insert(u)}
        on conflict (github_id) do update set
          github_login = excluded.github_login,
          name = excluded.name,
          avatar_url = excluded.avatar_url,
          access_token_enc = excluded.access_token_enc,
          access_token_expires_at = excluded.access_token_expires_at,
          refresh_token_enc = excluded.refresh_token_enc,
          refresh_token_expires_at = excluded.refresh_token_expires_at,
          updated_at = now()
        returning *`.pipe(Effect.map((rows) => rows[0]!)),

    getUser: (userId) => sql<UserRow>`select * from users where id = ${userId}`.pipe(Effect.map(Arr.head)),

    setSandboxSnapshot: (userId, snapshot) =>
      sql`update users set sandbox_snapshot = ${snapshot}, updated_at = now() where id = ${userId}`.pipe(Effect.asVoid),

    updateUserTokens: (userId, t) =>
      sql`update users set ${sql.update(t)}, updated_at = now() where id = ${userId}`.pipe(Effect.asVoid),

    createSession: (tokenHash, userId, ttlSeconds) =>
      sql`
        insert into sessions (token_hash, user_id, expires_at)
        values (${tokenHash}, ${userId}, now() + make_interval(secs => ${ttlSeconds}))`.pipe(Effect.asVoid),

    userForSession: (tokenHash) =>
      sql<UserRow>`
        select u.* from sessions s join users u on u.id = s.user_id
        where s.token_hash = ${tokenHash} and s.expires_at > now()`.pipe(Effect.map(Arr.head)),

    deleteSession: (tokenHash) => sql`delete from sessions where token_hash = ${tokenHash}`.pipe(Effect.asVoid),

    enqueueRun: (r) =>
      Effect.gen(function* () {
        const [row] = yield* sql<RunRow>`insert into runs ${sql.insert({ ...r, agent: r.agent ?? "claude" })} returning *`;
        yield* notifyQueued(row!.id);
        return row!;
      }),

    listRuns: (userId, limit = 50) =>
      sql<RunRow>`select * from runs where user_id = ${userId} order by created_at desc limit ${limit}`,

    getRun: (id) => sql<RunRow>`select * from runs where id = ${id}`.pipe(Effect.map(Arr.head)),

    claimNextRun: (workerId) =>
      sql<RunRow>`
        update runs set
          status = 'running', claimed_by = ${workerId}, started_at = now(), heartbeat_at = now(),
          finished_at = null, error = null, turns = turns + 1, last_activity_at = now()
        where id = (
          -- A sandbox being checkpointed is picked up once it has stopped.
          select id from runs where status = 'queued' and sandbox_state <> 'stopping'
          order by created_at
          for update skip locked
          limit 1
        )
        returning *`.pipe(Effect.map(Arr.head)),

    heartbeat: (runId) =>
      sql<{ status: RunStatus }>`
        update runs set heartbeat_at = now(), last_activity_at = now() where id = ${runId} returning status`.pipe(
        Effect.map((rows) => Option.map(Arr.head(rows), (r) => r.status)),
      ),

    updateRun: (runId, patch) =>
      Object.keys(patch).length === 0
        ? Effect.void
        : sql`
            update runs set ${sql.update(patch)}
              ${patch.sandbox_state ? sql`, sandbox_state_at = now()` : sql``}
            where id = ${runId}`.pipe(Effect.asVoid),

    finishRun: (runId, status, error) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ status: RunStatus }>`
          update runs set
            status = case
              when ${status} = 'succeeded' and exists (
                select 1 from run_events e
                where e.run_id = runs.id and e.kind = 'user_message' and e.id > runs.delivered_message_id
              ) then 'queued'::run_status
              else ${status}::run_status
            end,
            error = ${error ?? null}, finished_at = now(), awaiting_input = false, last_activity_at = now()
          where id = ${runId} and status in ('running', 'cancelling')
          returning status`;
        if (rows[0]?.status === "queued") yield* notifyQueued(runId);
      }),

    requestCancel: (runId, userId) =>
      sql`
        update runs set
          status = case when status = 'queued' then 'cancelled'::run_status else 'cancelling'::run_status end,
          finished_at = case when status = 'queued' then now() else finished_at end
        where id = ${runId} and user_id = ${userId} and status in ('queued', 'running')
        returning id`.pipe(Effect.map((rows) => rows.length > 0)),

    reapStaleRuns: (staleAfterSeconds) =>
      sql<Pick<RunRow, "id" | "sandbox_id">>`
        update runs set status = 'failed', error = 'runner stopped heartbeating', finished_at = now()
        where status in ('running', 'cancelling')
          and heartbeat_at < now() - make_interval(secs => ${staleAfterSeconds})
        returning id, sandbox_id`,

    addUserMessage: (runId, text) =>
      sql.withTransaction(
        Effect.zipRight(
          sql`insert into run_events (run_id, kind, message) values (${runId}, 'user_message', ${text})`,
          sql`update runs set last_activity_at = now(), awaiting_input = false where id = ${runId}`,
        ),
      ).pipe(Effect.asVoid),

    continueRun: (runId, text) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<RunRow>`
              update runs set status = 'queued', last_activity_at = now(), awaiting_input = false
              where id = ${runId} and status in ${sql.in(TERMINAL_STATUSES)}
              returning *`;
            if (rows.length === 0) return Option.none<RunRow>();
            yield* sql`insert into run_events (run_id, kind, message) values (${runId}, 'user_message', ${text})`;
            return Option.some(rows[0]!);
          }),
        )
        .pipe(Effect.tap((row) => (Option.isSome(row) ? notifyQueued(runId) : Effect.void))),

    claimIdleSandboxes: (idleSeconds, staleSeconds, limit) =>
      sql<RunSandbox>`
        update runs set sandbox_state = 'stopping', sandbox_state_at = now()
        where id in (
          select id from runs
          where (sandbox_state = 'running' and status in ${sql.in(TERMINAL_STATUSES)}
                 and last_activity_at < now() - make_interval(secs => ${idleSeconds}))
             or (sandbox_state = 'stopping' and sandbox_state_at < now() - make_interval(secs => ${staleSeconds}))
          order by last_activity_at
          for update skip locked
          limit ${limit}
        )
        returning id, sandbox_id, sandbox_state, sandbox_checkpoint_id`,

    expiredRuns: (days, limit) =>
      sql<RunSandbox>`
        select id, sandbox_id, sandbox_state, sandbox_checkpoint_id from runs
        where status in ${sql.in(TERMINAL_STATUSES)} and sandbox_state <> 'stopping'
          and last_activity_at < now() - make_interval(days => ${days})
        order by last_activity_at
        limit ${limit}`,

    deleteExpiredRun: (runId, days) =>
      sql`
        delete from runs
        where id = ${runId} and status in ${sql.in(TERMINAL_STATUSES)} and sandbox_state <> 'stopping'
          and last_activity_at < now() - make_interval(days => ${days})
        returning id`.pipe(Effect.map((rows) => rows.length > 0)),

    appendEvents: (runId, events) =>
      events.length === 0
        ? Effect.void
        : sql`insert into run_events ${sql.insert(
            events.map((e) => ({
              run_id: runId,
              kind: e.kind,
              message: e.message,
              data: e.data == null ? null : JSON.stringify(e.data),
            })),
          )}`.pipe(Effect.asVoid),

    listEvents: (runId, afterId = 0, limit = 500) =>
      sql<RunEventRow>`
        select * from run_events where run_id = ${runId} and id > ${afterId}
        order by id limit ${limit}`,

    listUserMessages: (runId, afterId) =>
      sql<RunEventRow>`
        select * from run_events where run_id = ${runId} and kind = 'user_message' and id > ${afterId}
        order by id`,

    saveDiff: (runId, patch, truncated) =>
      sql`
        insert into run_diffs (run_id, patch, truncated) values (${runId}, ${patch}, ${truncated})
        on conflict (run_id) do update set patch = excluded.patch, truncated = excluded.truncated, updated_at = now()`.pipe(
        Effect.asVoid,
      ),

    getDiff: (runId) =>
      sql<RunDiffRow>`select patch, truncated, updated_at from run_diffs where run_id = ${runId}`.pipe(Effect.map(Arr.head)),

    diffUpdatedAt: (runId) =>
      sql<{ updated_at: Date }>`select updated_at from run_diffs where run_id = ${runId}`.pipe(
        Effect.map((rows) => Option.map(Arr.head(rows), (r) => r.updated_at)),
      ),

    upsertApiKey: (k) =>
      sql`
        insert into user_api_keys ${sql.insert(k)}
        on conflict (user_id, provider) do update set
          key_enc = excluded.key_enc, hint = excluded.hint, updated_at = now()`.pipe(Effect.asVoid),

    listApiKeys: (userId) =>
      sql<ApiKeySummary>`select provider, hint, updated_at from user_api_keys where user_id = ${userId} order by provider`,

    deleteApiKey: (userId, provider) =>
      sql`delete from user_api_keys where user_id = ${userId} and provider = ${provider}`.pipe(Effect.asVoid),

    encryptedApiKeys: (userId) =>
      sql<{ provider: string; key_enc: string }>`select provider, key_enc from user_api_keys where user_id = ${userId}`,

    getSetting: (key) =>
      sql<{ value: unknown }>`select value from instance_settings where key = ${key}`.pipe(
        Effect.map((rows) => Option.map(Arr.head(rows), (r) => r.value)),
      ),

    putSetting: (key, value, options) => {
      const row = { key, value: JSON.stringify(value) };
      const saved = options?.onlyIfAbsent
        ? sql`insert into instance_settings ${sql.insert(row)} on conflict (key) do nothing returning key`
        : sql`
            insert into instance_settings ${sql.insert(row)}
            on conflict (key) do update set value = excluded.value, updated_at = now()
            returning key`;
      return Effect.map(saved, (rows) => rows.length > 0);
    },
  };
  return service;
});

/** All database access for the factory, as one service over @effect/sql. */
export class Store extends Context.Tag("@factory/Store")<Store, StoreService>() {
  static readonly Live = Layer.effect(Store, make);
}
