import { redisClient } from "./redis.client";
export class CacheService {
    async get<T>(key: string): Promise<T | null> {
        const value = await redisClient.get(key);
        if (!value) return null;
        return JSON.parse(value);
    }
    async set(
        key: string,
        value: unknown,
        ttlSeconds?: number
    ) {
        const json = JSON.stringify(value);
        if (ttlSeconds) {
            await redisClient.set(key, json, {
                EX: ttlSeconds,
            });
            return;
        }
        await redisClient.set(key, json);
    }

    async delete(key: string) {
        await redisClient.del(key);
    }
}
