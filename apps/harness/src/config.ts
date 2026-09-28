import { listConfig, previewSigningKeyConfig } from "@factory/core";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";

export class HarnessConfig extends Context.Tag("@factory/HarnessConfig")<
  HarnessConfig,
  {
    /** Public origin, e.g. https://harness-production.up.railway.app. Used for OAuth redirects and origin checks. */
    readonly publicUrl: string;
    /**
     * GitHub logins allowed to sign in. `["*"]` lets any GitHub account in;
     * empty means nobody, so the harness is closed unless configured.
     */
    readonly allowedLogins: ReadonlyArray<string>;
    readonly sessionTtlSeconds: number;
    /** Where previews of sandbox ports are served; none when the preview gateway isn't set up. */
    readonly preview: Option.Option<{ readonly domain: string; readonly signingKey: Redacted.Redacted<string> }>;
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
      const onRailway = Option.isSome(yield* Config.option(Config.string("RAILWAY_ENVIRONMENT_NAME")));
      if (onRailway && publicUrl.startsWith("http://localhost")) {
        yield* Effect.logWarning(
          "PUBLIC_URL is not set and the service has no Railway domain: GitHub sign-in will redirect to localhost.",
        );
      }
      const allowedLogins = yield* listConfig("ALLOWED_GITHUB_LOGINS");
      if (allowedLogins.length === 0) {
        yield* Effect.logWarning("ALLOWED_GITHUB_LOGINS is empty: nobody will be able to sign in.");
      } else if (allowedLogins.includes("*")) {
        yield* Effect.logInfo("ALLOWED_GITHUB_LOGINS is *: any GitHub account can sign in.");
      }
      const previewDomain = Option.filter(yield* Config.option(Config.string("PREVIEW_DOMAIN")), (d) => d.trim() !== "");
      const previewKey = yield* previewSigningKeyConfig;
      const preview = Option.all({
        domain: Option.map(previewDomain, (d) => d.trim().toLowerCase().replace(/^\.|\.$/g, "")),
        signingKey: previewKey,
      });
      if (Option.isSome(previewDomain) && Option.isNone(previewKey)) {
        yield* Effect.logWarning("PREVIEW_DOMAIN is set but PREVIEW_SIGNING_KEY is missing or shorter than 32 characters: previews are off.");
      }
      return {
        preview,
        publicUrl: publicUrl.replace(/\/$/, ""),
        allowedLogins,
        sessionTtlSeconds: yield* Config.integer("SESSION_TTL_SECONDS").pipe(Config.withDefault(7 * 24 * 3600)),
      };
    }),
  );
}
