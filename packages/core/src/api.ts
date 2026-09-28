/**
 * The harness's JSON API, shared by the harness (which encodes responses with
 * these schemas) and the web app (which decodes them). This module depends on
 * `effect` only, so the browser bundle can import it as `@factory/core/api`.
 */
import { Schema } from "effect";

export const RunStatus = Schema.Literal("queued", "running", "cancelling", "succeeded", "failed", "cancelled");
export type RunStatus = typeof RunStatus.Type;

export const ApiUser = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type ApiUser = typeof ApiUser.Type;

/** The signed-in user and what the UI needs to know before it can start a run. */
export const Me = Schema.Struct({
  user: ApiUser,
  hasApiKey: Schema.Boolean,
  /** Where to install the GitHub App or grant it more repositories. */
  installUrl: Schema.String,
});
export type Me = typeof Me.Type;

export const ApiRepo = Schema.Struct({
  installationId: Schema.Number,
  fullName: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
  htmlUrl: Schema.String,
});
export type ApiRepo = typeof ApiRepo.Type;

export const ApiRun = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  baseBranch: Schema.String,
  task: Schema.String,
  status: RunStatus,
  branch: Schema.NullOr(Schema.String),
  pullRequestUrl: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  startedAt: Schema.NullOr(Schema.Date),
  finishedAt: Schema.NullOr(Schema.Date),
  /** The agent asked a question and is waiting for the user's answer. */
  awaitingInput: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});
export type ApiRun = typeof ApiRun.Type;

/** See `RunEventKind` in the store for what each kind means and carries in `data`. */
export const RunEventKind = Schema.Literal(
  "info",
  "error",
  "stdout",
  "stderr",
  "message",
  "thinking",
  "tool_call",
  "tool_result",
  "agent_result",
  "user_message",
);
export type RunEventKind = typeof RunEventKind.Type;

export const ApiRunEvent = Schema.Struct({
  id: Schema.String,
  at: Schema.Date,
  kind: RunEventKind,
  message: Schema.String,
  data: Schema.optionalWith(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })), {
    default: () => null,
  }),
});
export type ApiRunEvent = typeof ApiRunEvent.Type;

/** The run's changes as one unified diff against the commit it started from. */
export const ApiRunDiff = Schema.Struct({
  patch: Schema.String,
  /** The patch was cut at a file boundary because it was too large to store. */
  truncated: Schema.Boolean,
  updatedAt: Schema.Date,
});
export type ApiRunDiff = typeof ApiRunDiff.Type;

export const RunDetail = Schema.Struct({
  run: ApiRun,
  events: Schema.Array(ApiRunEvent),
  /** More events exist after the last one; page through `/events?after=`. */
  hasMore: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  diff: Schema.optionalWith(Schema.NullOr(ApiRunDiff), { default: () => null }),
});
export type RunDetail = typeof RunDetail.Type;

/** New events after a cursor, with the run's latest state (what the run page polls). */
export const RunEventsPage = Schema.Struct({
  run: ApiRun,
  events: Schema.Array(ApiRunEvent),
  hasMore: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** When the diff last changed; fetch `/diff` again when this moves. */
  diffUpdatedAt: Schema.optionalWith(Schema.NullOr(Schema.Date), { default: () => null }),
});
export type RunEventsPage = typeof RunEventsPage.Type;

/** A message to a running agent: an answer to its question, or new direction. */
export const SendMessageBody = Schema.Struct({ text: Schema.String });
export type SendMessageBody = typeof SendMessageBody.Type;

/** One provider a user can bring a key for, and the key saved for it (never the key itself). */
export const ApiKeySlot = Schema.Struct({
  provider: Schema.String,
  label: Schema.String,
  placeholder: Schema.String,
  consoleUrl: Schema.String,
  saved: Schema.NullOr(Schema.Struct({ hint: Schema.String, updatedAt: Schema.Date })),
});
export type ApiKeySlot = typeof ApiKeySlot.Type;

export const CreateRunBody = Schema.Struct({
  installationId: Schema.Number,
  repo: Schema.String,
  task: Schema.String,
  baseBranch: Schema.optional(Schema.String),
});
export type CreateRunBody = typeof CreateRunBody.Type;

export const CreateRepoBody = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  private: Schema.Boolean,
});
export type CreateRepoBody = typeof CreateRepoBody.Type;

export const SaveKeyBody = Schema.Struct({ key: Schema.String });
export type SaveKeyBody = typeof SaveKeyBody.Type;

/**
 * Every non-2xx JSON answer. `code` is stable for the UI to branch on:
 * `unauthorized` (sign in), `reauth` (sign in again), `api_key_required`
 * (add a key in Settings), `forbidden`, `not_found`, `bad_request`, `github`, `internal`.
 */
export const ApiError = Schema.Struct({ code: Schema.String, error: Schema.String });
export type ApiError = typeof ApiError.Type;
