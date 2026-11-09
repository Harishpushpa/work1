import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import type { PoolConfig } from "pg";

/** Resolve api/.env whether this file is run from src/ or dist/. */
export function resolveApiEnvPath(): string {
  // __dirname = api/{src|dist}/platform/database → ../../../.env = api/.env
  const candidates = [
    path.resolve(__dirname, "../../../.env"),
    path.resolve(process.cwd(), ".env"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return value;
}

export type ParsedPostgresUrl = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

/**
 * Parse postgresql:// / postgres:// URLs, including passwords that contain `@`
 * (split userinfo on the last `@` before host). Percent-decoding is applied.
 */
export function parsePostgresUrl(rawUrl: string): ParsedPostgresUrl {
  const raw = stripWrappingQuotes(rawUrl.trim());
  const match = raw.match(/^(postgres(?:ql)?):\/\/([^?]*)(\?.*)?$/i);
  if (!match) {
    throw new Error(
      `Invalid POSTGRES_URL (expected postgres:// or postgresql://): ${raw.slice(0, 32)}…`
    );
  }

  const authorityAndPath = match[2];
  const at = authorityAndPath.lastIndexOf("@");
  if (at < 0) {
    throw new Error("Invalid POSTGRES_URL: missing @userinfo/host separator");
  }

  const userInfo = authorityAndPath.slice(0, at);
  const hostPortDb = authorityAndPath.slice(at + 1);

  const colon = userInfo.indexOf(":");
  const user =
    colon >= 0
      ? decodeURIComponent(userInfo.slice(0, colon))
      : decodeURIComponent(userInfo);
  const password =
    colon >= 0 ? decodeURIComponent(userInfo.slice(colon + 1)) : "";

  const slash = hostPortDb.indexOf("/");
  const hostPort = slash >= 0 ? hostPortDb.slice(0, slash) : hostPortDb;
  const databaseRaw = slash >= 0 ? hostPortDb.slice(slash + 1) : "";
  const database = decodeURIComponent(databaseRaw.split("/")[0] || "");

  let host = hostPort;
  let port = 5432;
  if (hostPort.startsWith("[")) {
    // IPv6: [::1]:5432
    const end = hostPort.indexOf("]");
    host = hostPort.slice(1, end);
    const rest = hostPort.slice(end + 1);
    if (rest.startsWith(":")) port = Number(rest.slice(1)) || 5432;
  } else {
    const lastColon = hostPort.lastIndexOf(":");
    if (lastColon >= 0 && hostPort.indexOf(":") === lastColon) {
      host = hostPort.slice(0, lastColon);
      port = Number(hostPort.slice(lastColon + 1)) || 5432;
    }
  }

  if (!host || !database) {
    throw new Error("Invalid POSTGRES_URL: host and database are required");
  }

  return { host, port, user: user || "postgres", password, database };
}

/**
 * Load api/.env (wins over ambient PM2/shell), then if POSTGRES_URL is set,
 * expand it into POSTGRES_* so both `pg` and platform config share one source.
 */
export function loadApiEnv(): string {
  const envPath = resolveApiEnvPath();
  dotenv.config({ path: envPath, override: true });

  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (url) {
    const parsed = parsePostgresUrl(url);
    // URL is source of truth when present — fill discrete vars for the rest of the app.
    process.env.POSTGRES_HOST = parsed.host;
    process.env.POSTGRES_PORT = String(parsed.port);
    process.env.POSTGRES_USER = parsed.user;
    process.env.POSTGRES_PASSWORD = parsed.password;
    process.env.POSTGRES_DB = parsed.database;
  }

  return envPath;
}

export type PostgresConnInfo = {
  mode: "discrete" | "url";
  envPath: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  passwordLength: number;
  poolConfig: PoolConfig;
};

/**
 * Build a `pg` Pool config from discrete POSTGRES_* and/or POSTGRES_URL.
 * Always uses object form (never raw connectionString) so `@` in passwords works.
 */
export function buildPostgresPoolConfig(envPath = loadApiEnv()): PostgresConnInfo {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const mode: "discrete" | "url" = url ? "url" : "discrete";

  // loadApiEnv already expands URL → discrete; re-read after that.
  const host = process.env.POSTGRES_HOST || process.env.PGHOST;
  const user = process.env.POSTGRES_USER || process.env.PGUSER;
  const database = process.env.POSTGRES_DB || process.env.PGDATABASE;
  const passwordRaw = process.env.POSTGRES_PASSWORD ?? process.env.PGPASSWORD;
  const portRaw = process.env.POSTGRES_PORT || process.env.PGPORT;

  if (!host || !user || !database || passwordRaw === undefined) {
    throw new Error(
      `Postgres config incomplete (env: ${envPath}). ` +
        `Set POSTGRES_URL or POSTGRES_HOST/USER/PASSWORD/DB. ` +
        `Got host=${host ?? "∅"} user=${user ?? "∅"} db=${database ?? "∅"} password=${passwordRaw !== undefined ? "set" : "∅"}`
    );
  }

  const password = stripWrappingQuotes(String(passwordRaw));
  const port = portRaw ? Number(portRaw) : 5432;

  return {
    mode,
    envPath,
    host,
    port,
    user,
    database,
    passwordLength: password.length,
    poolConfig: { host, user, password, database, port },
  };
}

export function logPostgresConnInfo(info: PostgresConnInfo): void {
  console.log("[postgres]", {
    envPath: info.envPath,
    mode: info.mode,
    host: info.host,
    port: info.port,
    user: info.user,
    database: info.database,
    passwordLength: info.passwordLength,
  });
}
