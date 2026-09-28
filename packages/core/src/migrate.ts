import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, type Sql } from "./db.js";
import { requireEnv } from "./env.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
// Arbitrary constant so concurrent deploys never apply migrations twice.
const LOCK_ID = 727_001;

/** Applies every migrations/*.sql file not yet recorded, in filename order. */
export async function migrate(sql: Sql, log: (msg: string) => void = console.log): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      log(`applying migration ${file}`);
      await tx.unsafe(await readFile(`${MIGRATIONS_DIR}${file}`, "utf8"));
      await tx`insert into schema_migrations (name) values (${file})`;
      applied.push(file);
    }
  });

  log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sql = createDb(requireEnv("DATABASE_URL"), { max: 1 });
  migrate(sql)
    .then(() => sql.end())
    .catch(async (err) => {
      console.error(err);
      await sql.end();
      process.exit(1);
    });
}
