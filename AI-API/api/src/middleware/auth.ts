import { Request, Response, NextFunction } from "express";
import {
  hasRequiredScopes,
  pathRequiredScopes,
  verifyServiceJwt,
  type ServiceJwtPayload,
} from "./serviceJwt";

declare global {
  namespace Express {
    interface Request {
      serviceAuth?: ServiceJwtPayload;
    }
  }
}

/** Legacy shared secret (SECRET_KEY / API_SECRET) for rollout dual-auth. */
function expectedApiKey(): string {
  return process.env.SECRET_KEY || process.env.API_SECRET || "";
}

export default async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.method === "OPTIONS") {
    return next();
  }

  if (req.path.startsWith("/docs") || req.path === "/openapi.json") {
    return next();
  }

  const authHeader = req.headers.authorization as string | undefined;
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : undefined;
  const headerKey = req.headers["x-api-key"] as string | undefined;

  // Prefer RS256 service JWT when Bearer looks like a JWT (three segments)
  if (bearer && bearer.split(".").length === 3 && process.env.SERVICE_JWKS_URL) {
    try {
      const payload = await verifyServiceJwt(bearer);
      const required = pathRequiredScopes(req.path);
      if (!hasRequiredScopes(payload.scopes, required)) {
        return res.status(403).json({
          error: "Forbidden",
          detail: `Missing scopes: ${required.join(", ")}`,
        });
      }
      req.serviceAuth = payload;
      return next();
    } catch (err: any) {
      // Fall through to static key only if configured; otherwise 401
      if (!expectedApiKey()) {
        return res.status(401).json({
          error: "Unauthorized",
          detail: err?.message || "Invalid service JWT",
        });
      }
    }
  }

  // Dual-auth: static x-api-key / Bearer secret (no query api_key in production)
  const secret = expectedApiKey();
  if (!secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (process.env.NODE_ENV === "production" && req.query.api_key) {
    return res.status(401).json({ error: "Query api_key is not allowed" });
  }

  const queryKey =
    process.env.NODE_ENV === "production"
      ? undefined
      : ((req.query.api_key as string) || undefined);
  const key = headerKey || (bearer && bearer.split(".").length !== 3 ? bearer : undefined) || queryKey;

  if (!key || key !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
