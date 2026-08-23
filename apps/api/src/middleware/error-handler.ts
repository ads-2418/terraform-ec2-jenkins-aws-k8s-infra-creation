import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError, RateLimitedError, isAppError } from "@app/shared";
import type { Logger } from "@app/shared";

/** Wire format is docs/API.md §2. */
export function createErrorHandler(logger: Logger) {
  return function errorHandler(error: FastifyError | AppError | Error, request: FastifyRequest, reply: FastifyReply): void {
    if (isAppError(error)) {
      if (error instanceof RateLimitedError) {
        reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      if (error.httpStatus >= 500) {
        logger.error({ err: error, requestId: request.id }, "request failed");
      }
      reply.status(error.httpStatus).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      });
      return;
    }

    // Fastify's own validation errors (route schema mismatches, bad JSON body).
    if ("statusCode" in error && typeof error.statusCode === "number" && error.statusCode < 500) {
      reply.status(error.statusCode).send({
        error: { code: "VALIDATION_ERROR", message: error.message, requestId: request.id },
      });
      return;
    }

    logger.error({ err: error, requestId: request.id }, "unhandled request error");
    reply.status(500).send({
      error: { code: "INTERNAL", message: "An unexpected error occurred.", requestId: request.id },
    });
  };
}
