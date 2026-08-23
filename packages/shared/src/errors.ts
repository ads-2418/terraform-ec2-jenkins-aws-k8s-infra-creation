/**
 * Every error the API surfaces to a client is one of these - see
 * docs/API.md §2 for the wire format. Domain packages throw these directly;
 * the Gateway's error middleware (apps/api) is the only place that knows
 * how to render one as an HTTP response, so domain code never touches
 * HTTP status codes itself.
 */
export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly fields: Array<{ path: string; message: string }> | undefined;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.fields = fields;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super("NOT_FOUND", `${resource} not found.`, 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(fields: Array<{ path: string; message: string }>) {
    super("VALIDATION_ERROR", "Request failed validation.", 400, fields);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}

/** The slot is no longer available - see docs/APPOINTMENT_ENGINE.md §3-4. */
export class SlotUnavailableError extends AppError {
  constructor() {
    super("SLOT_UNAVAILABLE", "This slot is no longer available.", 409);
    this.name = "SlotUnavailableError";
  }
}

/** The hold's TTL elapsed before it was confirmed - docs/APPOINTMENT_ENGINE.md §5. */
export class HoldExpiredError extends AppError {
  constructor() {
    super("HOLD_EXPIRED", "This hold has expired. Please select a new time.", 410);
    this.name = "HoldExpiredError";
  }
}

/** Transition not legal for the appointment's current status - docs/APPOINTMENT_ENGINE.md §2. */
export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super("INVALID_TRANSITION", `Cannot transition appointment from ${from} to ${to}.`, 409);
    this.name = "InvalidTransitionError";
  }
}

/** Same Idempotency-Key replayed with a different request body - docs/API.md §3. */
export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super(
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with a different request.",
      422,
    );
    this.name = "IdempotencyKeyReusedError";
  }
}

export class RateLimitedError extends AppError {
  constructor(scope: "IP" | "TENANT" | "API_KEY", retryAfterSeconds: number) {
    super(`RATE_LIMITED_${scope}`, "Too many requests.", 429);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
  readonly retryAfterSeconds: number;
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
