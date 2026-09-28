import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { GitHubAppApi, InstanceSettings, PgLive, Store, TokenCipher } from "@factory/core";
import { Effect, Layer, Option, Schedule } from "effect";
import { RunnerConfig } from "./config.js";
import { Sandboxes } from "./sandbox.js";
import { runner } from "./worker.js";

const MainLive = Layer.mergeAll(GitHubAppApi.Live, Sandboxes.Live, RunnerConfig.Live).pipe(
  Layer.provideMerge(InstanceSettings.Live),
  Layer.provideMerge(Layer.mergeAll(Store.Live, TokenCipher.Live)),
  Layer.provideMerge(PgLive),
  Layer.provide(NodeHttpClient.layerUndici),
);

/** Tells the harness's setup page whether this runner's own variables say where sandboxes go. */
const reportSandboxes = Effect.gen(function* () {
  const settings = yield* InstanceSettings;
  const target = yield* settings.sandboxTarget;
  yield* settings.reportRunner(Option.exists(target, (t) => t.source === "env"));
  if (Option.isNone(target)) yield* Effect.logWarning("Sandboxes are not set up yet: runs will fail until setup is finished at /setup.");
}).pipe(
  // On a deploy the harness may not have run the migration that adds the table yet: keep trying for a while.
  Effect.sandbox,
  Effect.retry(Schedule.spaced("10 seconds").pipe(Schedule.upTo("15 minutes"))),
  Effect.catchAll((cause) => Effect.logWarning("Could not report sandbox setup to the harness", cause)),
);

Effect.zipRight(Effect.fork(reportSandboxes), runner).pipe(Effect.provide(MainLive), NodeRuntime.runMain);
