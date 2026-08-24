import { z } from "zod";

/**
 * Single source of truth for env parsing - every app validates its
 * environment through this at startup and fails fast on a missing/invalid
 * value instead of discovering it mid-request. See docs/DEVELOPMENT.md §2
 * and docs/SECURITY.md §5 (secrets never hard-coded, always injected via
 * env in every environment).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1),

  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  API_PORT: z.coerce.number().int().positive().default(3000),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  DEFAULT_HOLD_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  DEFAULT_NO_SHOW_GRACE_MINUTES: z.coerce.number().int().positive().default(30),

  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  EMAIL_FROM: z.string().email().default("no-reply@example.com"),

  // --- WhatsApp Business Cloud API (docs/WHATSAPP.md) ---------------------
  // WHATSAPP_ACCESS_TOKEN is intentionally optional: unset means "no real
  // Meta credentials configured" and apps/worker falls back to the
  // simulated send client (logs instead of calling out) - see
  // docs/DEVELOPMENT.md. The other three always have a value so webhook
  // signature verification and the GET handshake work in local dev/test
  // even without real credentials.
  WHATSAPP_APP_SECRET: z.string().default("dev-only-whatsapp-app-secret"),
  WHATSAPP_VERIFY_TOKEN: z.string().default("dev-only-verify-token"),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = result.data;
  return cached;
}
