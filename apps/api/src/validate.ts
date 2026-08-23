import type { ZodSchema } from "zod";
import { ValidationError } from "@app/shared";

/** Every request body is validated at this boundary before any domain code sees it - docs/SECURITY.md §6. */
export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
