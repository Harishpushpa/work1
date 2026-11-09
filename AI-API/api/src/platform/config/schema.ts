import { z } from "zod";

export const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]),
    PORT: z.coerce.number().default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    POSTGRES_HOST: z.string(),
    POSTGRES_PORT: z.coerce.number(),
    POSTGRES_DB: z.string(),
    POSTGRES_USER: z.string(),
    POSTGRES_PASSWORD: z.string(),
    REDIS_HOST: z.string(),
    REDIS_PORT: z.coerce.number(),
    REDIS_HISTORY_CACHE_TTL: z.coerce.number(),
    REDIS_HISTORY_LIMIT: z.coerce.number(),
    QDRANT_URL: z.string().url(),
    QDRANT_API_KEY: z.string(),
    SUMMARIZATION_MODEL: z.string(),
    SUMMARIZATION_TOKEN_THRESHOLD: z.coerce.number(),
    SUMMARIZATION_INPUT_COST_PER_MILLION: z.coerce.number().default(0.15),
    SUMMARIZATION_OUTPUT_COST_PER_MILLION: z.coerce.number().default(0.6),
    DOCUMENT_RETRY_LIMIT: z.coerce.number().default(3),
    FRAMEWORK: z.enum(["haystack", "openai"]).default("openai"),
    LLM_CHEAP_MODEL: z.string(),
    SECRET_KEY: z.string().min(1),
    EMBEDDING_COST_PER_MILLION: z.coerce.number().default(0),
    /** Comma-separated Origins, or * for any. Example: https://insursa-widget.intellikast.in */
    CORS_ORIGINS: z.string().optional().default(""),
    /** Comma-separated parent domains; allows https://*.domain and https://domain */
    CORS_ALLOW_SUBDOMAINS_OF: z.string().optional().default(""),
    /** app-api JWKS for verifying RS256 service JWTs */
    SERVICE_JWKS_URL: z.string().optional().default(""),
    SERVICE_JWT_ISSUER: z.string().optional().default(""),
    SERVICE_JWT_AUDIENCE: z.string().optional().default("app-ai"),
});

export type Env = z.infer<typeof envSchema>;