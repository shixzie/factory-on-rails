import type { ReasoningEffort } from "./api.js";
import { SqlClient, SqlError } from "@effect/sql";
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

/** Commands already started for a turn, so another runner can reconnect without starting them twice. */
export interface RunExecution {
  checkout?: "clone" | "resume";
  prompt?: { text: string; commitMessage: string; deliveredMessageId: string };
  /** CI repair progress shares the turn's durable command sessions. */
  ci?: { cycle: number; startedAt: number; pullRequestUrl: string; deliveredMessageId?: string };
  sessions: Record<string, {
    name: string;
    startedAt?: number;
    result?: { exitCode: number | null; stdout: string; timedOut: boolean };
  }>;
}

export interface RunRow {
  id: string;
  user_id: string;
  repo_full_name: string;
  installation_id: string;
  base_branch: string;
  task: string;
  /** A short name for the run: written by a small model from the task, or by the user. Null until one exists. */
  title: string | null;
  /** The user named the run, so a generated title never replaces it. */
  title_by_user: boolean;
  /** The coding agent: `claude` or `codex` (see AGENTS). */
  agent: string;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  status: RunStatus;
  branch: string | null;
  sandbox_id: string | null;
  /** Latest PR, used by the runner when continuing work on its branch. */
  pull_request_url: string | null;
  /** Every PR associated with the thread, in association order. */
  pull_request_urls: ReadonlyArray<string>;
  error: string | null;
  claimed_by: string | null;
  heartbeat_at: Date | null;
  execution: RunExecution | null;
  /** The next claim continues the interrupted turn, rather than starting another one. */
  recovering: boolean;
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
  /** Ports listening in the sandbox while its preview agent is connected; null when it is not. */
  preview_ports: ReadonlyArray<PreviewPort> | null;
  /** When someone last used one of the run's previews. */
  preview_seen_at: Date | null;
}

/** A port listening in a run's sandbox, and the process behind it when the agent could tell. */
export interface PreviewPort {
  port: number;
  process?: string;
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
    | "execution"
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
    r: Pick<RunRow, "user_id" | "repo_full_name" | "base_branch" | "task"> & {
      installation_id: number;
      agent?: string;
      model?: string | null;
      reasoning_effort?: ReasoningEffort | null;
    },
  ) => Q<RunRow>;
  readonly listRuns: (userId: string, limit?: number) => Q<ReadonlyArray<RunRow>>;
  readonly getRun: (id: string) => Q<Option.Option<RunRow>>;
  /**
   * Atomically claims the oldest queued run or cancellation awaiting recovery. SKIP LOCKED lets several runner
   * replicas poll the same table without handing out a run twice.
   */
  readonly claimNextRun: (workerId: string) => Q<Option.Option<RunRow>>;
  /** Records liveness and returns the run's current status (how the runner notices cancellation). */
  readonly heartbeat: (runId: string, workerId?: string) => Q<Option.Option<RunStatus>>;
  /** Associates an existing PR without changing the runner's current PR. */
  readonly linkPullRequest: (runId: string, url: string) => Q<void>;
  /** A guarded write fails if the worker no longer owns the run. */
  readonly updateRun: (runId: string, patch: RunPatch, workerId?: string) => Q<void>;
  /** Hands an interrupted turn back to the queue, preserving its sandbox, sessions and cancellation. */
  readonly releaseRun: (runId: string, workerId: string) => Q<void>;
  /** Stores a generated title, unless the user has named the run. Returns whether it was stored. */
  readonly setGeneratedTitle: (runId: string, title: string) => Q<boolean>;
  /** The user names their run; generated titles never replace it afterwards. None if it is not their run. */
  readonly renameRun: (runId: string, userId: string, title: string) => Q<Option.Option<RunRow>>;
  /**
   * Ends a turn. A run that succeeded while the user sent a message the agent
   * never got goes straight back to the queue, so that message is answered.
   */
  readonly finishRun: (runId: string, status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">, error?: string, workerId?: string) => Q<void>;
  /** Marks a queued run cancelled, or asks the runner to stop a running one. */
  readonly requestCancel: (runId: string, userId: string) => Q<boolean>;
  /** Releases runs whose runner stopped heartbeating (crash, redeploy) so another runner can reconnect. */
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

  // previews (see preview.ts)
  /** What the sandbox's preview agent reports; null when it disconnects. */
  readonly setPreviewPorts: (runId: string, ports: ReadonlyArray<PreviewPort> | null) => Q<void>;
  /** Forgets every run's ports (the gateway starting up holds no tunnels). */
  readonly clearPreviewPorts: Q<void>;
  /** Someone is using a preview: counts as activity, so the sandbox isn't stopped under them. */
  readonly touchPreview: (runId: string) => Q<void>;
  /** Finished runs whose running sandbox had preview traffic in the last `seconds`. */
  readonly previewedSandboxes: (seconds: number) => Q<ReadonlyArray<Pick<RunRow, "id" | "sandbox_id">>>;
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
      sql<RunRow>`select * from runs where user_id = ${userId}
        order by (status in ('queued', 'running', 'cancelling') or awaiting_input) desc,
          last_activity_at desc, created_at desc, id desc
        limit ${limit}`,

    getRun: (id) => sql<RunRow>`select * from runs where id = ${id}`.pipe(Effect.map(Arr.head)),

    claimNextRun: (workerId) =>
      sql<RunRow>`
        update runs set
          status = case when status = 'cancelling' then 'cancelling'::run_status else 'running'::run_status end,
          claimed_by = ${workerId}, started_at = case when recovering then started_at else now() end, heartbeat_at = now(),
          finished_at = null, error = null, turns = turns + case when recovering then 0 else 1 end, last_activity_at = now()
        where id = (
          -- A sandbox being checkpointed is picked up once it has stopped.
          select id from runs where
            (status = 'queued' or (status = 'cancelling' and claimed_by is null and recovering))
            and sandbox_state <> 'stopping'
          order by created_at
          for update skip locked
          limit 1
        )
        returning *`.pipe(Effect.map(Arr.head)),

    heartbeat: (runId, workerId) =>
      sql<{ status: RunStatus }>`
        update runs set heartbeat_at = now(), last_activity_at = now() where id = ${runId}
          ${workerId === undefined ? sql`` : sql`and claimed_by = ${workerId} and status in ('running', 'cancelling')`}
        returning status`.pipe(
        Effect.map((rows) => Option.map(Arr.head(rows), (r) => r.status)),
      ),

    linkPullRequest: (runId, url) =>
      sql`update runs set pull_request_urls = array_append(pull_request_urls, lower(${url}))
          where id = ${runId} and not (lower(${url}) = any(pull_request_urls))`.pipe(Effect.asVoid),

    updateRun: (runId, patch, workerId) =>
      Object.keys(patch).length === 0
        ? Effect.void
        : sql`
            update runs set ${sql.update({
              ...patch,
              ...(patch.execution === undefined ? {} : { execution: patch.execution === null ? null : JSON.stringify(patch.execution) }),
            })}
              ${patch.sandbox_state ? sql`, sandbox_state_at = now()` : sql``}
              ${patch.pull_request_url ? sql`, pull_request_urls = case
                when lower(${patch.pull_request_url}) = any(pull_request_urls) then pull_request_urls
                else array_append(pull_request_urls, lower(${patch.pull_request_url})) end` : sql``}
            where id = ${runId}
              ${workerId === undefined ? sql`` : sql`and claimed_by = ${workerId} and status in ('running', 'cancelling')`}
            returning id`.pipe(Effect.flatMap((rows) => workerId !== undefined && rows.length === 0
              ? Effect.fail(new SqlError.SqlError({ message: "The runner no longer owns this run" }))
              : Effect.void)),

    releaseRun: (runId, workerId) =>
      Effect.gen(function* () {
        const rows = yield* sql`
          update runs set
            status = case when status = 'cancelling' then 'cancelling'::run_status else 'queued'::run_status end,
            claimed_by = null, heartbeat_at = null, recovering = true
          where id = ${runId} and claimed_by = ${workerId} and status in ('running', 'cancelling')
          returning id`;
        if (rows.length > 0) yield* notifyQueued(runId);
      }),

    setGeneratedTitle: (runId, title) =>
      sql`update runs set title = ${title} where id = ${runId} and not title_by_user returning id`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),

    renameRun: (runId, userId, title) =>
      sql<RunRow>`
        update runs set title = ${title}, title_by_user = true
        where id = ${runId} and user_id = ${userId}
        returning *`.pipe(Effect.map(Arr.head)),

    finishRun: (runId, status, error, workerId) =>
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
            error = ${error ?? null}, finished_at = now(), awaiting_input = false, last_activity_at = now(),
            claimed_by = null, heartbeat_at = null, execution = null, recovering = false
          where id = ${runId} and status in ('running', 'cancelling')
            ${workerId === undefined ? sql`` : sql`and claimed_by = ${workerId}`}
          returning status`;
        if (rows[0]?.status === "queued") yield* notifyQueued(runId);
      }),

    requestCancel: (runId, userId) =>
      sql`
        update runs set
          status = case when status = 'queued' and not recovering then 'cancelled'::run_status else 'cancelling'::run_status end,
          finished_at = case when status = 'queued' and not recovering then now() else finished_at end
        where id = ${runId} and user_id = ${userId} and status in ('queued', 'running')
        returning id`.pipe(Effect.map((rows) => rows.length > 0)),

    reapStaleRuns: (staleAfterSeconds) =>
      Effect.gen(function* () {
        const rows = yield* sql<Pick<RunRow, "id" | "sandbox_id">>`
          update runs set
            status = case when status = 'cancelling' then 'cancelling'::run_status else 'queued'::run_status end,
            claimed_by = null, heartbeat_at = null, recovering = true
          where status in ('running', 'cancelling')
            and heartbeat_at < now() - make_interval(secs => ${staleAfterSeconds})
          returning id, sandbox_id`;
        yield* Effect.forEach(rows, (row) => notifyQueued(row.id), { discard: true });
        return rows;
      }),

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
              update runs set status = 'queued', last_activity_at = now(), awaiting_input = false,
                execution = null, recovering = false, claimed_by = null, heartbeat_at = null
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
          )} on conflict do nothing`.pipe(Effect.asVoid),

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

    setPreviewPorts: (runId, ports) =>
      sql`
        update runs set preview_ports = ${ports === null ? null : JSON.stringify(ports)}::jsonb
        where id = ${runId}`.pipe(Effect.asVoid),

    clearPreviewPorts: sql`update runs set preview_ports = null where preview_ports is not null`.pipe(Effect.asVoid),

    touchPreview: (runId) =>
      sql`
        update runs set last_activity_at = now(), preview_seen_at = now()
        where id = ${runId} and sandbox_state = 'running'`.pipe(Effect.asVoid),

    previewedSandboxes: (seconds) =>
      sql<Pick<RunRow, "id" | "sandbox_id">>`
        select id, sandbox_id from runs
        where sandbox_state = 'running' and sandbox_id is not null and status in ${sql.in(TERMINAL_STATUSES)}
          and preview_seen_at > now() - make_interval(secs => ${seconds})`,
  };
  return service;
});

/** All database access for the factory, as one service over @effect/sql. */
export class Store extends Context.Tag("@factory/Store")<Store, StoreService>() {
  static readonly Live = Layer.effect(Store, make);
}
