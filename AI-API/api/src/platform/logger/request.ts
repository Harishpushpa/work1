import pinoHttp from "pino-http";
import { logger } from "./logger";

export const requestLogger = pinoHttp({
  logger,

  autoLogging: true,

  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },

  customErrorMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },

  customProps(req, res) {
    return {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
    };
  },

  serializers: {
    req() {
      return undefined;
    },

    res() {
      return undefined;
    },
  },
});
