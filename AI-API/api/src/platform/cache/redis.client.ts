import { createClient } from "redis";
import { config } from "../../platform/config";
import { logger } from "../../platform/logger";

export const redisClient = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
  },
});

redisClient.on("connect", () => {
  logger.info("Redis connected");
});

redisClient.on("error", (error) => {
  logger.error(error, "Redis connection failed");
});
