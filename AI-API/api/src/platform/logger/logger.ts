import pino from "pino";
import { config } from "../config";

export const logger = pino({
  level: config.logger.level,

  transport:
    config.app.environment !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            singleLine: true,
          },
        }
      : undefined,
});
