import { Response } from "express";
import { ApiResponse } from "./api-response";

export class ResponseBuilder {
  static success<T>(
    res: Response,
    data: T,
    message = "Request completed successfully",
    statusCode = 200,
    metadata?: Record<string, unknown>
  ) {
    const response: ApiResponse<T> = {
      success: true,
      message,
      data,
      metadata,
      timestamp: new Date().toISOString(),
    };

    return res.status(statusCode).json(response);
  }

  static created<T>(
    res: Response,
    data: T,
    message = "Resource created successfully"
  ) {
    return this.success(res, data, message, 201);
  }

  static accepted<T>(
    res: Response,
    data: T,
    message = "Request accepted"
  ) {
    return this.success(res, data, message, 202);
  }

  static noContent(res: Response) {
    return res.status(204).send();
  }
}