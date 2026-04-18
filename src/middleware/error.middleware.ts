import { Request, Response, NextFunction } from "express";

/** Throw from handlers to return a non-500 status from the global error middleware. */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof Error) {
    console.error(err.stack || err.message);
  } else {
    console.error(err);
  }
  if (res.headersSent) return;
  const status =
    err instanceof HttpError
      ? err.statusCode
      : typeof err === "object" &&
          err !== null &&
          "statusCode" in err &&
          typeof (err as { statusCode: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Internal server error";
  res.status(status).json({ success: false, message });
}
