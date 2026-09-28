import { listConfig } from "@factory/core";
import { Config, Context, Effect, Layer, Option } from "effect";

export class HarnessConfig extends Context.Tag("@factory/HarnessConfig")<
  HarnessConfig,
  {
    /** Public origin, e.g. https://harness-production.up.railway.app. Used for OAuth redirects and origin checks. */
    readonly publicUrl: string;
    /** GitHub logins allowed to sign in. Empty means nobody: the harness is closed by default. */
    readonly allowedLogins: ReadonlyArray<string>;
    readonly sessionTtlSeconds: number;
  }
>() {
  static readonly Live = Layer.effect(
    HarnessConfig,
    Effect.gen(function* () {
      const port = yield* Config.integer("PORT").pipe(Config.withDefault(3000));
      // On Railway, fall back to the service's generated domain.
      const railwayDomain = yield* Config.option(Config.string("RAILWAY_PUBLIC_DOMAIN"));
      const publicUrl = yield* Config.string("PUBLIC_URL").pipe(
        Config.withDefault(
          Option.match(railwayDomain, { onNone: () => `http://localhost:${port}`, onSome: (d) => `https://${d}` }),
        ),
      );
      const allowedLogins = yield* listConfig("ALLOWED_GITHUB_LOGINS");
      if (allowedLogins.length === 0) {
        yield* Effect.logWarning("ALLOWED_GITHUB_LOGINS is empty: nobody will be able to sign in.");
      }
      return {
        publicUrl: publicUrl.replace(/\/$/, ""),
        allowedLogins,
        sessionTtlSeconds: yield* Config.integer("SESSION_TTL_SECONDS").pipe(Config.withDefault(7 * 24 * 3600)),
      };
    }),
  );
}
