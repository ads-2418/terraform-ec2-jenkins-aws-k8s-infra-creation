/**
 * Internal representation of an outbound message, mapped to the Cloud
 * API's request shape by toCloudApiPayload. Free-form text is only valid
 * within Meta's 24h customer-service window (a reply to something the
 * patient just sent); anything business-initiated outside that window
 * needs a pre-approved template message instead - not modeled here since
 * this phase only ever replies within an active conversation.
 * docs/WHATSAPP.md §3.
 */
export type OutboundMessage =
  | { kind: "text"; text: string }
  | {
      kind: "list";
      bodyText: string;
      buttonLabel: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }
  | { kind: "buttons"; bodyText: string; buttons: Array<{ id: string; title: string }> };

// WhatsApp interactive-message field limits - truncated defensively so a
// long doctor/service name can't produce a request the real API rejects.
const LIST_ROW_TITLE_MAX = 24;
const LIST_BUTTON_LABEL_MAX = 20;
const BUTTON_TITLE_MAX = 20;
const MAX_LIST_ROWS = 10;
const MAX_BUTTONS = 3;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function textMessage(text: string): OutboundMessage {
  return { kind: "text", text };
}

export function listMessage(args: {
  bodyText: string;
  buttonLabel: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}): OutboundMessage {
  return {
    kind: "list",
    bodyText: args.bodyText,
    buttonLabel: truncate(args.buttonLabel, LIST_BUTTON_LABEL_MAX),
    rows: args.rows.slice(0, MAX_LIST_ROWS).map((r) => ({ ...r, title: truncate(r.title, LIST_ROW_TITLE_MAX) })),
  };
}

export function buttonsMessage(args: {
  bodyText: string;
  buttons: Array<{ id: string; title: string }>;
}): OutboundMessage {
  return {
    kind: "buttons",
    bodyText: args.bodyText,
    buttons: args.buttons.slice(0, MAX_BUTTONS).map((b) => ({ ...b, title: truncate(b.title, BUTTON_TITLE_MAX) })),
  };
}

/** The Cloud API's `POST /{phone-number-id}/messages` request body. */
export function toCloudApiPayload(to: string, message: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", to };

  switch (message.kind) {
    case "text":
      return { ...base, type: "text", text: { body: message.text } };
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: message.bodyText },
          action: {
            button: message.buttonLabel,
            sections: [{ rows: message.rows }],
          },
        },
      };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.bodyText },
          action: {
            buttons: message.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
          },
        },
      };
  }
}

/** A plain-text rendering, used by the simulated client's console log and by tests asserting on message content. */
export function renderPlainText(message: OutboundMessage): string {
  switch (message.kind) {
    case "text":
      return message.text;
    case "list":
      return `${message.bodyText}\n${message.rows.map((r, i) => `${i + 1}. ${r.title}${r.description ? ` - ${r.description}` : ""}`).join("\n")}`;
    case "buttons":
      return `${message.bodyText}\n${message.buttons.map((b) => `[${b.title}]`).join("  ")}`;
  }
}
