import { redisClient } from "./redis.client";

export async function checkRedisHealth() {
  try {
    await redisClient.ping();

    return {
      status: "UP",
    };
  } catch {
    return {
      status: "DOWN",
    };
  }
}
