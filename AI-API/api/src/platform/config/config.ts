import { env } from "./env";

export const config = {
    app: {
        name: "AI Core Platform",
        environment: env.NODE_ENV,
        port: env.PORT,
    },

    logger: {
        level: env.LOG_LEVEL,
    },

    postgres: {
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        database: env.POSTGRES_DB,
        user: env.POSTGRES_USER,
        password: env.POSTGRES_PASSWORD,
    },

    redis: {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        historyCacheTtl: env.REDIS_HISTORY_CACHE_TTL,
        historyLimit: env.REDIS_HISTORY_LIMIT,
    },

    qdrant: {
        url: env.QDRANT_URL,
        apiKey: env.QDRANT_API_KEY ?? "",
    },
    llm: {
        summarization: {
            model: env.SUMMARIZATION_MODEL,
            tokenThreshold: env.SUMMARIZATION_TOKEN_THRESHOLD,
            inputCostPerMillion: env.SUMMARIZATION_INPUT_COST_PER_MILLION,
            outputCostPerMillion: env.SUMMARIZATION_OUTPUT_COST_PER_MILLION,
        },
        framework: env.FRAMEWORK,
        cheapModel: env.LLM_CHEAP_MODEL,
        embeddingCostPerMillion: env.EMBEDDING_COST_PER_MILLION,
    },
    security: {
        secretKey: env.SECRET_KEY,
    },
} as const;