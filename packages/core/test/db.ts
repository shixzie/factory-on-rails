import { NodeContext } from "@effect/platform-node";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { migrate } from "../src/db.js";

/**
 * Integration tests run against a disposable database, e.g.
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/factory_test pnpm test
 * The layer wipes the public schema and migrates it from scratch.
 */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export const TestDbLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`drop schema public cascade`;
    yield* sql`create schema public`;
    yield* migrate;
  }).pipe(Effect.provide(NodeContext.layer)),
).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(testDatabaseUrl ?? ""), maxConnections: 4 })));
