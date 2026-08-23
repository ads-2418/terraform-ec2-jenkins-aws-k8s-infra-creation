import { z } from "zod";

/** E.164 phone number, normalized before persistence - docs/SECURITY.md §6. */
export const e164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, "Phone number must be in E.164 format, e.g. +919876543210");

export const uuidSchema = z.string().uuid();

export const idempotencyKeyHeaderSchema = z.string().min(8).max(128);

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
