export interface ApiResponse<T = unknown> {
    success: boolean;
    message: string;
    data?: T;
    metadata?: Record<string, unknown>;
    timestamp: string;
  }