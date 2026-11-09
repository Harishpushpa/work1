import postgres from "postgres";
import { config } from "../config";

export const sql = postgres({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  username: config.postgres.user,
  password: config.postgres.password,

  max: 20,
});