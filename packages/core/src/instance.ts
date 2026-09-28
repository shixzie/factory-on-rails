import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { pemConfig } from "./config.js";
import { TokenCipher } from "./crypto.js";
import { Store } from "./store.js";

/**
 * Instance-wide settings: the GitHub App the factory signs in and pushes
 * with, and the Railway environment its sandboxes run in.
 *
 * A deployment gets them one of two ways. Environment variables (docs/setup.md)
 * win when they are set. Otherwise the web app's setup page creates them (the
 * GitHub App from a manifest, the sandbox environment and its token through
 * Railway's API) and they are stored in `instance_settings`, secrets encrypted
 * with TOKEN_ENCRYPTION_KEY. That second way is what the Railway template uses,
 * so a fresh deployment needs no hand-copied credentials.
 */

export type SettingSource = "env" | "setup";

/** What the harness needs: GitHub sign-in (the App's OAuth side) and its install link. */
export interface GitHubOAuthSettings {
  readonly source: SettingSource;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly slug: string;
  /** The account that owns the App, when the setup page created it. */
  readonly owner: string | null;
}

/** What the runner needs: the App's own identity, to mint installation tokens. */
export interface GitHubAppAuthSettings {
  readonly appId: string;
  readonly privateKey: Redacted.Redacted<string>;
}

/** A GitHub App created from a manifest (see `GitHubUserApi.convertManifest`). */
export interface CreatedGitHubApp {
  readonly appId: string;
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: string;
  readonly owner: string;
  readonly htmlUrl: string;
}

/** Where sandboxes run: an environment and a project token scoped to it. */
export interface SandboxTarget {
  readonly source: SettingSource;
  readonly environmentId: string;
  readonly token: Redacted.Redacted<string>;
}

export interface ProvisionedSandboxes {
  readonly projectId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly token: string;
}

const GITHUB_APP = "github_app";
const SANDBOXES = "sandboxes";
const RUNNER = "runner";

const StoredGitHubApp = Schema.Struct({
  appId: Schema.String,
  slug: Schema.String,
  clientId: Schema.String,
  owner: Schema.String,
  htmlUrl: Schema.String,
  clientSecretEnc: Schema.String,
  privateKeyEnc: Schema.String,
});

const StoredSandboxes = Schema.Struct({
  projectId: Schema.String,
  environmentId: Schema.String,
  environmentName: Schema.String,
  tokenEnc: Schema.String,
});

const RunnerReport = Schema.Struct({ sandboxesFromEnv: Schema.Boolean });

/** An env var that, when set, switches a setting to environment variables (the rest are then required). */
const present = (name: string) => Config.option(Config.nonEmptyString(name));

export class InstanceSettings extends Context.Tag("@factory/InstanceSettings")<
  InstanceSettings,
  {
    readonly githubOAuth: Effect.Effect<Option.Option<GitHubOAuthSettings>>;
    readonly githubAppAuth: Effect.Effect<Option.Option<GitHubAppAuthSettings>>;
    /** Stores the App the setup page created. False if one was already stored (the first one wins). */
    readonly saveGitHubApp: (app: CreatedGitHubApp) => Effect.Effect<boolean>;
    readonly sandboxTarget: Effect.Effect<Option.Option<SandboxTarget>>;
    readonly saveSandboxes: (s: ProvisionedSandboxes) => Effect.Effect<void>;
    /**
     * Whether a runner can create sandboxes: the setup page stored a target, or
     * a runner reported that its own environment variables provide one (the
     * harness can't see the runner's variables).
     */
    readonly sandboxesReady: Effect.Effect<{ readonly ready: boolean; readonly fromEnv: boolean }>;
    /** Called by the runner at startup, for `sandboxesReady`. */
    readonly reportRunner: (sandboxesFromEnv: boolean) => Effect.Effect<void>;
  }
>() {
  static readonly Live = Layer.effect(
    InstanceSettings,
    Effect.gen(function* () {
      const store = yield* Store;
      const cipher = yield* TokenCipher;

      // Environment variables are read once, at startup, so a half-set group fails fast with its name.
      const envOAuth = yield* Effect.flatMap(present("GITHUB_APP_CLIENT_ID"), (clientId) =>
        Option.isNone(clientId)
          ? Effect.succeed(Option.none<GitHubOAuthSettings>())
          : Effect.map(
              Config.all({ clientSecret: Config.redacted("GITHUB_APP_CLIENT_SECRET"), slug: Config.string("GITHUB_APP_SLUG") }),
              (c): Option.Option<GitHubOAuthSettings> =>
                Option.some({ source: "env", clientId: clientId.value, owner: null, ...c }),
            ),
      );
      const envAppAuth = yield* Effect.flatMap(present("GITHUB_APP_ID"), (appId) =>
        Option.isNone(appId)
          ? Effect.succeed(Option.none<GitHubAppAuthSettings>())
          : Effect.map(pemConfig("GITHUB_APP_PRIVATE_KEY"), (privateKey) => Option.some({ appId: appId.value, privateKey })),
      );
      const envSandbox = yield* Effect.flatMap(present("RAILWAY_SANDBOX_TOKEN"), (token) =>
        Option.isNone(token)
          ? Effect.succeed(Option.none<SandboxTarget>())
          : Effect.map(Config.string("SANDBOX_ENVIRONMENT_ID"), (environmentId) =>
              Option.some<SandboxTarget>({ source: "env", environmentId, token: Redacted.make(token.value) }),
            ),
      );

      // A broken database or key is a defect here: callers can't do anything about it.
      const read = <A, I>(key: string, schema: Schema.Schema<A, I>) =>
        store.getSetting(key).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.succeed(Option.none<A>()),
            onSome: (value) => Effect.map(Schema.decodeUnknown(schema)(value), Option.some),
          })),
          Effect.orDie,
        );
      const reveal = (enc: string) => Effect.map(Effect.orDie(cipher.decrypt(enc)), Redacted.make);

      const storedApp = read(GITHUB_APP, StoredGitHubApp);

      return {
        githubOAuth: Option.isSome(envOAuth)
          ? Effect.succeed(envOAuth)
          : Effect.flatMap(storedApp, Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (app) =>
                Effect.map(reveal(app.clientSecretEnc), (clientSecret) =>
                  Option.some<GitHubOAuthSettings>({
                    source: "setup",
                    clientId: app.clientId,
                    clientSecret,
                    slug: app.slug,
                    owner: app.owner,
                  }),
                ),
            })),

        githubAppAuth: Option.isSome(envAppAuth)
          ? Effect.succeed(envAppAuth)
          : Effect.flatMap(storedApp, Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (app) =>
                Effect.map(reveal(app.privateKeyEnc), (privateKey) => Option.some({ appId: app.appId, privateKey })),
            })),

        saveGitHubApp: (app) =>
          store
            .putSetting(
              GITHUB_APP,
              Schema.encodeSync(StoredGitHubApp)({
                appId: app.appId,
                slug: app.slug,
                clientId: app.clientId,
                owner: app.owner,
                htmlUrl: app.htmlUrl,
                clientSecretEnc: cipher.encrypt(app.clientSecret),
                privateKeyEnc: cipher.encrypt(app.privateKey),
              }),
              { onlyIfAbsent: true },
            )
            .pipe(Effect.orDie),

        sandboxTarget: Option.isSome(envSandbox)
          ? Effect.succeed(envSandbox)
          : Effect.flatMap(read(SANDBOXES, StoredSandboxes), Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (s) =>
                Effect.map(reveal(s.tokenEnc), (token) =>
                  Option.some<SandboxTarget>({ source: "setup", environmentId: s.environmentId, token }),
                ),
            })),

        saveSandboxes: (s) =>
          store
            .putSetting(SANDBOXES, {
              projectId: s.projectId,
              environmentId: s.environmentId,
              environmentName: s.environmentName,
              tokenEnc: cipher.encrypt(s.token),
            })
            .pipe(Effect.asVoid, Effect.orDie),

        sandboxesReady: Effect.gen(function* () {
          if (Option.isSome(envSandbox)) return { ready: true, fromEnv: true };
          if (Option.isSome(yield* read(SANDBOXES, StoredSandboxes))) return { ready: true, fromEnv: false };
          const runner = yield* read(RUNNER, RunnerReport);
          const fromEnv = Option.exists(runner, (r) => r.sandboxesFromEnv);
          return { ready: fromEnv, fromEnv };
        }),

        reportRunner: (sandboxesFromEnv) =>
          store.putSetting(RUNNER, { sandboxesFromEnv }).pipe(Effect.asVoid, Effect.orDie),
      };
    }),
  );
}
