import { NodeRuntime } from "@effect/platform-node";
import { PgLive, Store } from "@factory/core";
import { Effect, Layer, Redacted, Runtime } from "effect";
import { PreviewConfig } from "./config.js";
import { makeGateway, type PreviewBackend } from "./gateway.js";

/**
 * The preview gateway (see gateway.ts). One replica: tunnels live in this
 * process's memory, so a browser request has to land where its sandbox's
 * tunnel is.
 */
const main = Effect.gen(function* () {
  const config = yield* PreviewConfig;
  const store = yield* Store;
  const runtime = yield* Effect.runtime<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Runtime.runPromise(runtime)(effect);

  // A fresh gateway holds no tunnels, so no sandbox is connected yet.
  yield* store.clearPreviewPorts.pipe(Effect.catchAll((err) => Effect.logWarning("Could not clear preview ports", err)));

  const backend: PreviewBackend = {
    setPorts: (runId, ports) => run(store.setPreviewPorts(runId, ports)),
    touch: (runId) => run(store.touchPreview(runId)),
    sandboxState: (runId) => run(Effect.map(store.getRun(runId), (r) => (r._tag === "Some" ? r.value.sandbox_state : undefined))),
  };
  const gateway = makeGateway({
    domain: config.domain,
    signingKey: Redacted.value(config.signingKey),
    webUrl: config.webUrl,
    backend,
    log: (level, message) => Runtime.runSync(runtime)(level === "warn" ? Effect.logWarning(message) : Effect.logInfo(message)),
  });

  yield* Effect.acquireRelease(
    Effect.async<void, Error>((resume) => {
      gateway.server.once("error", (err) => resume(Effect.fail(err)));
      gateway.server.listen(config.port, config.host, () => resume(Effect.void));
    }),
    () =>
      Effect.async<void>((resume) => {
        gateway.close();
        gateway.server.close(() => resume(Effect.void));
        gateway.server.closeAllConnections();
      }),
  );
  yield* Effect.logInfo(`Preview gateway for *.${config.domain} listening on ${config.host}:${config.port}`);
  return yield* Effect.never;
}).pipe(Effect.scoped);

const MainLive = Layer.mergeAll(Store.Live, PreviewConfig.Live).pipe(Layer.provide(PgLive));

main.pipe(Effect.provide(MainLive), NodeRuntime.runMain);
