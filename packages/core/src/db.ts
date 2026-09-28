import postgres from "postgres";

export type Sql = postgres.Sql;

export function createDb(databaseUrl: string, options: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    // Railway's private network Postgres does not use TLS; public URLs do.
    ssl: databaseUrl.includes(".railway.internal") ? false : "prefer",
    transform: { undefined: null },
    onnotice: () => {},
  });
}
