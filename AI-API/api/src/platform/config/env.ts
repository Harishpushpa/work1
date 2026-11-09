import { envSchema } from "./schema";
import { loadApiEnv } from "../database/postgres-env";

// api/.env wins over ambient PM2/shell (needed when password contains @).
loadApiEnv();

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
