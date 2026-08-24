/**
 * Normalizes the WhatsApp Business Cloud API's webhook payload shape -
 * see Meta's documentation for `entry[].changes[].value`. One HTTP
 * request can (rarely) batch multiple entries/changes, so parsing always
 * returns an array.
 */
export interface InboundMessage {
  waMessageId: string;
  businessPhoneNumberId: string;
  fromPhone: string;
  timestamp: string;
  contactName?: string;
  kind: "text" | "list_reply" | "button_reply" | "unsupported";
  text?: string;
  replyId?: string;
}

export interface InboundStatus {
  businessPhoneNumberId: string;
  waMessageId: string;
  status: string;
  timestamp: string;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: InboundStatus[];
}

interface RawMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    list_reply?: { id: string; title: string };
    button_reply?: { id: string; title: string };
  };
}

interface RawStatus {
  id: string;
  status: string;
  timestamp: string;
}

interface RawChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: RawMessage[];
  statuses?: RawStatus[];
}

interface RawWebhookBody {
  object?: string;
  entry?: Array<{ changes?: Array<{ value?: RawChangeValue; field?: string }> }>;
}

function normalizeMessage(raw: RawMessage, phoneNumberId: string, contactName?: string): InboundMessage {
  const base = {
    waMessageId: raw.id,
    businessPhoneNumberId: phoneNumberId,
    fromPhone: normalizePhone(raw.from),
    timestamp: raw.timestamp,
    contactName,
  };

  if (raw.type === "text" && raw.text) {
    return { ...base, kind: "text", text: raw.text.body };
  }
  if (raw.type === "interactive" && raw.interactive?.type === "list_reply" && raw.interactive.list_reply) {
    return { ...base, kind: "list_reply", replyId: raw.interactive.list_reply.id, text: raw.interactive.list_reply.title };
  }
  if (raw.type === "interactive" && raw.interactive?.type === "button_reply" && raw.interactive.button_reply) {
    return { ...base, kind: "button_reply", replyId: raw.interactive.button_reply.id, text: raw.interactive.button_reply.title };
  }
  return { ...base, kind: "unsupported" };
}

/** WhatsApp's `from`/`wa_id` fields are bare MSISDNs with no leading `+`. */
function normalizePhone(waId: string): string {
  return waId.startsWith("+") ? waId : `+${waId}`;
}

export function parseInboundWebhook(body: unknown): ParsedWebhook {
  const raw = body as RawWebhookBody;
  const messages: InboundMessage[] = [];
  const statuses: InboundStatus[] = [];

  for (const entry of raw.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const contactName = value?.contacts?.[0]?.profile?.name;
      for (const rawMessage of value?.messages ?? []) {
        messages.push(normalizeMessage(rawMessage, phoneNumberId, contactName));
      }
      for (const rawStatus of value?.statuses ?? []) {
        statuses.push({
          businessPhoneNumberId: phoneNumberId,
          waMessageId: rawStatus.id,
          status: rawStatus.status,
          timestamp: rawStatus.timestamp,
        });
      }
    }
  }

  return { messages, statuses };
}
