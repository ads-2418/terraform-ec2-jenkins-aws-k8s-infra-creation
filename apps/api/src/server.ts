import { loadConfig } from "@app/config";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = buildApp(config);

app
  .listen({ port: config.API_PORT, host: "0.0.0.0" })
  .then(() => {
    app.log.info({ port: config.API_PORT }, "api server listening");
  })
  .catch((err: unknown) => {
    app.log.error({ err }, "failed to start api server");
    process.exit(1);
  });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
