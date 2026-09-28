import { Config } from "effect";
import { parseSnapshots } from "./providers.js";

/** Comma-separated list, trimmed and lower-cased; empty entries dropped. */
export const listConfig = (name: string): Config.Config<ReadonlyArray<string>> =>
  Config.string(name).pipe(
    Config.withDefault(""),
    Config.map((raw) =>
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

/**
 * A PEM key. Railway's variable editor tends to store literal "\n"
 * sequences, so accept either form.
 */
export const pemConfig = (name: string) =>
  Config.redacted(Config.string(name).pipe(Config.map((pem) => pem.replace(/\\n/g, "\n"))));

/** SANDBOX_SNAPSHOTS, parsed (see `parseSnapshots`); bad entries are reported, not fatal. */
export const snapshotsConfig = Config.string("SANDBOX_SNAPSHOTS").pipe(Config.withDefault(""), Config.map(parseSnapshots));
