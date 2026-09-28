import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { GitHubAppApi, PgLive, Store, TokenCipher } from "@factory/core";
import { Effect, Layer } from "effect";
import { RunnerConfig } from "./config.js";
import { Sandboxes } from "./sandbox.js";
import { runner } from "./worker.js";

const MainLive = Layer.mergeAll(
  Store.Live,
  TokenCipher.Live,
  GitHubAppApi.Live,
  Sandboxes.Live,
  RunnerConfig.Live,
).pipe(Layer.provideMerge(PgLive), Layer.provide(NodeHttpClient.layerUndici));

runner.pipe(Effect.provide(MainLive), NodeRuntime.runMain);
