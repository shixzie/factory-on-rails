/**
 * The harness's JSON API, shared by the harness (which encodes responses with
 * these schemas) and the web app (which decodes them). This module depends on
 * `effect` only, so the browser bundle can import it as `@factory/core/api`.
 */
import { Schema } from "effect";

export const RunStatus = Schema.Literal("queued", "running", "cancelling", "succeeded", "failed", "cancelled");
export type RunStatus = typeof RunStatus.Type;

/** Where a run's sandbox is; see `SandboxState` in the store. */
export const SandboxState = Schema.Literal("none", "running", "stopping", "stopped", "deleted");
export type SandboxState = typeof SandboxState.Type;

/** The coding agent a run uses; see `AGENTS` in providers.ts. */
export const AgentId = Schema.Literal("claude", "codex");
export type AgentId = typeof AgentId.Type;
export const AGENT_LABELS: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex" };

/** A finished run's sandbox is stopped (checkpointed, then destroyed) after this long without activity. */
export const SANDBOX_IDLE_STOP_MINUTES = 5;
/** A run with no activity for this long is deleted, with its sandbox. */
export const RUN_RETENTION_DAYS = 7;

export const ApiUser = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type ApiUser = typeof ApiUser.Type;

/** An agent a user can pick for a run, and whether they can start one with it. */
export const ApiAgent = Schema.Struct({
  id: AgentId,
  label: Schema.String,
  /** The user saved a credential for it, or picked a sandbox snapshot that can carry one. */
  ready: Schema.Boolean,
});
export type ApiAgent = typeof ApiAgent.Type;

/** The signed-in user and what the UI needs to know before it can start a run. */
export const Me = Schema.Struct({
  user: ApiUser,
  /** At least one agent is ready, so a run can start. */
  hasApiKey: Schema.Boolean,
  agents: Schema.optionalWith(Schema.Array(ApiAgent), {
    default: () => [{ id: "claude" as const, label: "Claude Code", ready: false }],
  }),
  /** The sandbox snapshot the user's runs start from, if they picked one. */
  snapshot: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
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

/** A port listening in a run's sandbox, and the process behind it when known. */
export const PreviewPort = Schema.Struct({
  port: Schema.Number,
  process: Schema.optional(Schema.String),
});
export type PreviewPort = typeof PreviewPort.Type;

export const ApiRun = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  baseBranch: Schema.String,
  task: Schema.String,
  /** A short name for the run (generated from the task, or the user's). Null until one exists: show `task` instead. */
  title: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  /** The user named the run themselves. */
  titleByUser: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  agent: Schema.optionalWith(AgentId, { default: () => "claude" as const }),
  status: RunStatus,
  branch: Schema.NullOr(Schema.String),
  /** Latest PR; retained for clients that only display one. */
  pullRequestUrl: Schema.NullOr(Schema.String),
  pullRequestUrls: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  startedAt: Schema.NullOr(Schema.Date),
  finishedAt: Schema.NullOr(Schema.Date),
  /** The agent asked a question and is waiting for the user's answer. */
  awaitingInput: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  sandboxState: Schema.optionalWith(SandboxState, { default: () => "none" as const }),
  /** The last agent activity or user message; the run is deleted `RUN_RETENTION_DAYS` after it. */
  lastActivityAt: Schema.optionalWith(Schema.NullOr(Schema.Date), { default: () => null }),
  /**
   * Ports listening in the sandbox, as its preview agent last reported them;
   * null while the agent is not connected (no sandbox, stopped, or starting).
   */
  previewPorts: Schema.optionalWith(Schema.NullOr(Schema.Array(PreviewPort)), { default: () => null }),
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
  /** This factory has a preview gateway set up (PREVIEW_DOMAIN and PREVIEW_SIGNING_KEY). */
  previewsEnabled: Schema.optionalWith(Schema.Boolean, { default: () => false }),
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

/**
 * A message to the agent: an answer to its question or new direction while it
 * runs, or, once it has finished, the next turn of the conversation.
 */
export const SendMessageBody = Schema.Struct({ text: Schema.String });
export type SendMessageBody = typeof SendMessageBody.Type;

/** One provider a user can bring a key for, and the key saved for it (never the key itself). */
export const ApiKeySlot = Schema.Struct({
  provider: Schema.String,
  label: Schema.String,
  description: Schema.optionalWith(Schema.String, { default: () => "" }),
  /** The agent that uses it. */
  agent: Schema.optionalWith(AgentId, { default: () => "claude" as const }),
  placeholder: Schema.String,
  /** Where to get one. */
  consoleUrl: Schema.String,
  consoleLabel: Schema.optionalWith(Schema.String, { default: () => "Get a key" }),
  /** Credentials such as an auth.json document need a multi-line input. */
  multiline: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  saved: Schema.NullOr(Schema.Struct({ hint: Schema.String, updatedAt: Schema.Date })),
});
export type ApiKeySlot = typeof ApiKeySlot.Type;

export const CreateRunBody = Schema.Struct({
  installationId: Schema.Number,
  repo: Schema.String,
  task: Schema.String,
  baseBranch: Schema.optional(Schema.String),
  agent: Schema.optional(AgentId),
});
export type CreateRunBody = typeof CreateRunBody.Type;

/** The longest name a run can have. */
export const RUN_TITLE_MAX_CHARS = 80;

/** Associates an existing GitHub pull request with a run. */
export const LinkPullRequestBody = Schema.Struct({ url: Schema.String });

/** Renames a run. Generated titles never replace a name the user gave it. */
export const RenameRunBody = Schema.Struct({ title: Schema.String });
export type RenameRunBody = typeof RenameRunBody.Type;

export const CreateRepoBody = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  private: Schema.Boolean,
});
export type CreateRepoBody = typeof CreateRepoBody.Type;

/** Open a port of the run's sandbox in the browser; `path` is where to land. */
export const OpenPreviewBody = Schema.Struct({
  port: Schema.Int.pipe(Schema.between(1, 65535)),
  path: Schema.optional(Schema.String),
});
export type OpenPreviewBody = typeof OpenPreviewBody.Type;

/** A one-time link (valid for a minute) that signs the browser in to that port's preview origin. */
export const PreviewLink = Schema.Struct({
  url: Schema.String,
  /** The preview's origin, e.g. https://p5173-<run>.preview.example.com. */
  origin: Schema.String,
});
export type PreviewLink = typeof PreviewLink.Type;

export const SaveKeyBody = Schema.Struct({ key: Schema.String });
export type SaveKeyBody = typeof SaveKeyBody.Type;

/**
 * The sandbox snapshots (prepared Railway checkpoints) this user may start
 * runs from, and the one they picked. `null` means the platform's default.
 */
export const SnapshotSettings = Schema.Struct({
  available: Schema.Array(Schema.String),
  selected: Schema.NullOr(Schema.String),
});
export type SnapshotSettings = typeof SnapshotSettings.Type;

export const SaveSnapshotBody = Schema.Struct({ snapshot: Schema.NullOr(Schema.String) });
export type SaveSnapshotBody = typeof SaveSnapshotBody.Type;

/**
 * What a fresh deployment still needs, for the setup page (public: it works
 * before anyone can sign in). A deployment configured with environment
 * variables reports everything as ready.
 */
export const SetupStatus = Schema.Struct({
  githubApp: Schema.NullOr(
    Schema.Struct({
      slug: Schema.String,
      /** Configured with environment variables rather than created on the setup page. */
      fromEnv: Schema.Boolean,
      /** The account the setup page created it under. */
      owner: Schema.NullOr(Schema.String),
      installUrl: Schema.String,
    }),
  ),
  sandboxes: Schema.Struct({ ready: Schema.Boolean, fromEnv: Schema.Boolean }),
  /** The GitHub accounts named in ALLOWED_GITHUB_LOGINS, shown until the App exists (the App must belong to one). */
  owners: Schema.Array(Schema.String),
  /** The signed-in user, and whether they may finish setup (named in ALLOWED_GITHUB_LOGINS, or the App's owner). */
  viewer: Schema.NullOr(Schema.Struct({ login: Schema.String, admin: Schema.Boolean })),
});
export type SetupStatus = typeof SetupStatus.Type;

/** Creates the GitHub App under the signed-in GitHub account, or under an organization. */
export const CreateGitHubAppBody = Schema.Struct({ organization: Schema.optional(Schema.String) });
export type CreateGitHubAppBody = typeof CreateGitHubAppBody.Type;

/** The form the browser posts to GitHub to register the App from its manifest. */
export const GitHubAppForm = Schema.Struct({ action: Schema.String, manifest: Schema.String });
export type GitHubAppForm = typeof GitHubAppForm.Type;

/** A Railway account or workspace token, used once to set up the sandbox environment and never stored. */
export const SetupSandboxesBody = Schema.Struct({ token: Schema.String });
export type SetupSandboxesBody = typeof SetupSandboxesBody.Type;

/**
 * Every non-2xx JSON answer. `code` is stable for the UI to branch on:
 * `unauthorized` (sign in), `reauth` (sign in again), `api_key_required`
 * (add a key for the agent in Settings, or pick a snapshot), `setup_required` (finish /setup), `forbidden`, `not_found`, `bad_request`, `github`, `internal`.
 */
export const ApiError = Schema.Struct({ code: Schema.String, error: Schema.String });
export type ApiError = typeof ApiError.Type;
