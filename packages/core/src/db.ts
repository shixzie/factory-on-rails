import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { FileSystem, Path } from "@effect/platform";
import { Migrator } from "@effect/sql";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Layer } from "effect";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Postgres client from DATABASE_URL (Railway injects it from the postgres service). */
export const PgLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
  maxConnections: Config.integer("DATABASE_MAX_CONNECTIONS").pipe(Config.withDefault(10)),
});

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * Loads migrations/NNN_name.sql files. Migrations stay plain SQL; the
 * @effect/sql Migrator tracks which ones ran and locks against concurrent deploys.
 */
export const sqlFileLoader: Migrator.Loader<FileSystem.FileSystem | Path.Path> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = (yield* fs.readDirectory(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match) {
        return yield* new Migrator.MigrationError({ reason: "bad-state", message: `Bad migration file name: ${file}` });
      }
      const text = yield* fs.readFileString(path.join(MIGRATIONS_DIR, file));
      const load = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(text));
      return [Number(match[1]), match[2]!, Effect.succeed(load)] as const;
    }),
  );
}).pipe(
  Effect.catchTag("SystemError", "BadArgument", (err) =>
    Effect.fail(new Migrator.MigrationError({ reason: "import-error", message: err.message, cause: err })),
  ),
);

export const migrate = Migrator.make({})({ loader: sqlFileLoader, table: "schema_migrations" }).pipe(
  Effect.tap((applied) =>
    Effect.log(applied.length ? `applied migrations: ${applied.map(([id, name]) => `${id}_${name}`).join(", ")}` : "database is up to date"),
  ),
);

// `node packages/core/dist/db.js` runs migrations (the harness pre-deploy command).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate.pipe(Effect.provide(Layer.mergeAll(PgLive, NodeContext.layer)), NodeRuntime.runMain);
}
