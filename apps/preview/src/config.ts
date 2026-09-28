import { previewSigningKeyConfig } from "@factory/core";
import { Config, ConfigError, Context, Effect, Either, Layer, Option, Redacted } from "effect";

export class PreviewConfig extends Context.Tag("@factory/PreviewConfig")<
  PreviewConfig,
  {
    /** Hosts are `<label>.<domain>`, e.g. `p5173-<run>.preview.shixzie.com`. */
    readonly domain: string;
    readonly signingKey: Redacted.Redacted<string>;
    /** The factory's own origin (the web app). */
    readonly webUrl: string;
    readonly port: number;
    readonly host: string;
  }
>() {
  static readonly Live = Layer.effect(
    PreviewConfig,
    Effect.gen(function* () {
      const signingKey = yield* previewSigningKeyConfig.pipe(
        Config.mapOrFail(
          Option.match({
            onNone: () =>
              Either.left(ConfigError.MissingData(["PREVIEW_SIGNING_KEY"], "Set PREVIEW_SIGNING_KEY (at least 32 characters) to run the preview gateway")),
            onSome: Either.right,
          }),
        ),
      );
      return {
        domain: yield* Config.nonEmptyString("PREVIEW_DOMAIN").pipe(Config.map((d) => d.trim().toLowerCase().replace(/^\.|\.$/g, ""))),
        signingKey,
        webUrl: yield* Config.nonEmptyString("PUBLIC_URL").pipe(Config.map((u) => u.trim().replace(/\/$/, ""))),
        port: yield* Config.integer("PORT").pipe(Config.withDefault(8080)),
        host: yield* Config.string("HOST").pipe(Config.withDefault("::")),
      };
    }),
  );
}
