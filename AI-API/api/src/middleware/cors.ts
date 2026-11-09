import type { NextFunction, Request, Response } from "express";

const parseList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const normalizeOrigin = (origin: string): string => origin.replace(/\/$/, "");

const DEFAULT_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Api-Key",
  "x-api-key",
  "X-Document-Source",
  "x-document-source",
  "X-Session-Id",
  "x-session-id",
  "X-Policy-Id",
  "x-policy-id",
].join(", ");

/**
 * Allowed browser Origins:
 * - CORS_ORIGINS=* → allow any
 * - CORS_ORIGINS=https://a.com,https://b.com → exact allowlist
 * - CORS_ALLOW_SUBDOMAINS_OF=intellikast.in → https://*.intellikast.in (+ apex)
 * - unset in production → defaults to intellikast.in (widget → api)
 */
export const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);

  const origins = parseList(process.env.CORS_ORIGINS);
  if (origins.includes("*")) return true;
  if (origins.some((o) => normalizeOrigin(o) === normalized)) return true;

  const suffixes = parseList(
    process.env.CORS_ALLOW_SUBDOMAINS_OF ||
      (origins.length === 0 ? "intellikast.in" : "")
  );
  if (suffixes.length > 0) {
    try {
      const host = new URL(normalized).hostname.toLowerCase();
      if (
        suffixes.some((suffix) => {
          const s = suffix.replace(/^\./, "").toLowerCase();
          return host === s || host.endsWith(`.${s}`);
        })
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }

  if (
    origins.length === 0 &&
    !process.env.CORS_ALLOW_SUBDOMAINS_OF &&
    process.env.NODE_ENV !== "production"
  ) {
    return true;
  }

  return false;
};

function applyCorsHeaders(req: Request, res: Response, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );

  const requested = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof requested === "string" && requested.trim()
      ? requested
      : DEFAULT_ALLOW_HEADERS,
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type");
}

export default function corsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    applyCorsHeaders(req, res, origin);
  } else if (origin && req.method === "OPTIONS") {
    console.warn(
      `[cors] blocked preflight origin=${origin} ` +
        `CORS_ORIGINS=${process.env.CORS_ORIGINS ?? ""} ` +
        `CORS_ALLOW_SUBDOMAINS_OF=${process.env.CORS_ALLOW_SUBDOMAINS_OF ?? "(default intellikast.in)"}`,
    );
  }

  if (req.method === "OPTIONS") {
    // Always end preflight here (never fall through to auth).
    res.sendStatus(origin && isOriginAllowed(origin) ? 204 : 403);
    return;
  }

  next();
}
