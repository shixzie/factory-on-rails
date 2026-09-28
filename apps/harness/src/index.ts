import { serve } from "@hono/node-server";
import { createDb } from "@factory/core";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const sql = createDb(config.databaseUrl);
const app = createApp(sql, config);

if (config.allowedLogins.length === 0) {
  console.warn("ALLOWED_GITHUB_LOGINS is empty: nobody will be able to sign in.");
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`harness listening on :${info.port} (${config.publicUrl})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void sql.end({ timeout: 5 }).then(() => process.exit(0));
  });
}
