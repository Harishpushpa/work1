import { defineConfig } from "drizzle-kit";
import { config } from "./src/platform/config";

export default defineConfig({
  schema: "./src/platform/database/schema/*.table.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: `postgresql://${config.postgres.user}:${encodeURIComponent(
      config.postgres.password
    )}@127.0.0.1:${config.postgres.port}/${config.postgres.database}`,
  },
});