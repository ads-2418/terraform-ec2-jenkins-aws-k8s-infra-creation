import type { Logger } from "@app/shared";
import { renderPlainText, toCloudApiPayload, type OutboundMessage } from "./templates.js";

export interface WhatsAppSendResult {
  waMessageId: string | null;
}

export interface WhatsAppSendClient {
  send(to: string, message: OutboundMessage): Promise<WhatsAppSendResult>;
}

/**
 * The real Cloud API client. Requires a live access token - not usable in
 * this environment (no Meta Business account here), but this is the
 * actual production implementation, not a stub: same request shape docs/
 * CALENDAR_INTEGRATION.md-style integrations use, same error handling
 * discipline as the rest of this codebase.
 */
export class HttpWhatsAppSendClient implements WhatsAppSendClient {
  constructor(
    private readonly config: { accessToken: string; phoneNumberId: string; apiVersion: string },
    private readonly logger: Logger,
  ) {}

  async send(to: string, message: OutboundMessage): Promise<WhatsAppSendResult> {
    const url = `https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toCloudApiPayload(to, message)),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error({ status: res.status, body, to }, "WhatsApp Cloud API send failed");
      return { waMessageId: null };
    }

    const data = (await res.json()) as { messages?: Array<{ id: string }> };
    return { waMessageId: data.messages?.[0]?.id ?? null };
  }
}

/**
 * Used whenever no real access token is configured (local dev, this
 * environment, CI) - logs what would have been sent instead of calling
 * out, and keeps an in-memory record so tests and the webhook-simulation
 * script can assert on conversation output without a live WhatsApp
 * account. Selected automatically by apps/worker's wiring based on
 * whether WHATSAPP_ACCESS_TOKEN is set - see docs/DEVELOPMENT.md.
 */
export class SimulatedWhatsAppSendClient implements WhatsAppSendClient {
  readonly sent: Array<{ to: string; message: OutboundMessage }> = [];

  constructor(private readonly logger?: Logger) {}

  async send(to: string, message: OutboundMessage): Promise<WhatsAppSendResult> {
    this.sent.push({ to, message });
    const rendered = renderPlainText(message);
    this.logger?.info({ to, rendered }, "[simulated WhatsApp send]");
    return { waMessageId: null };
  }
}
