import { HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { GitHubUserApi, InstanceSettings, PgLive, Store, TokenCipher } from "@factory/core";
import { Config, Layer } from "effect";
import { createServer } from "node:http";
import { app, originCheck } from "./app.js";
import { HarnessConfig } from "./config.js";
import { RailwayApi } from "./railway.js";
import { PullRequestStatuses } from "./pull-requests.js";
import { TitleModel } from "./titles.js";

const ServicesLive = PullRequestStatuses.Live.pipe(
  Layer.provideMerge(Layer.mergeAll(GitHubUserApi.Live, RailwayApi.Live, HarnessConfig.Live, TitleModel.Live)),
  Layer.provideMerge(InstanceSettings.Live),
  Layer.provideMerge(Layer.mergeAll(Store.Live, TokenCipher.Live)),
  Layer.provide(PgLive),
  Layer.provide(NodeHttpClient.layerUndici),
);

const ServerLive = NodeHttpServer.layerConfig(createServer, {
  port: Config.integer("PORT").pipe(Config.withDefault(3000)),
  host: Config.string("HOST").pipe(Config.withDefault("0.0.0.0")),
});

const HttpLive = app.pipe(originCheck, HttpMiddleware.logger, HttpServer.serve(), HttpServer.withLogAddress);

HttpLive.pipe(Layer.provide(ServerLive), Layer.provide(ServicesLive), Layer.launch, NodeRuntime.runMain);
