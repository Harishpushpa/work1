import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type ServiceJwtPayload = JWTPayload & {
  sub?: string;
  scopes?: string[];
  sid?: string;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrlCached = "";

const getJwks = () => {
  const url = (process.env.SERVICE_JWKS_URL || "").trim();
  if (!url) return null;
  if (!jwks || jwksUrlCached !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksUrlCached = url;
  }
  return jwks;
};

export const verifyServiceJwt = async (
  token: string,
): Promise<ServiceJwtPayload> => {
  const set = getJwks();
  if (!set) {
    throw new Error("SERVICE_JWKS_URL is not configured");
  }

  const issuer = (process.env.SERVICE_JWT_ISSUER || "").trim() || undefined;
  const audience =
    (process.env.SERVICE_JWT_AUDIENCE || "").trim() || "app-ai";

  const { payload } = await jwtVerify(token, set, {
    issuer,
    audience,
    algorithms: ["RS256"],
  });

  return payload as ServiceJwtPayload;
};

export const pathRequiredScopes = (path: string): string[] => {
  if (path.startsWith("/chat")) return ["chat"];
  if (path.startsWith("/upload")) return ["upload"];
  if (path.startsWith("/documents")) return ["documents"];
  if (path.startsWith("/api/conversations")) return ["conversations"];
  if (path.startsWith("/api/testing")) return ["chat"];
  if (path.startsWith("/jobs")) return ["faqs"];
  return [];
};

export const hasRequiredScopes = (
  tokenScopes: string[] | undefined,
  required: string[],
): boolean => {
  if (required.length === 0) return true;
  if (!tokenScopes || tokenScopes.length === 0) return false;
  return required.every((s) => tokenScopes.includes(s));
};
