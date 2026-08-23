import type { ActorType } from "@app/db";

export interface Actor {
  type: ActorType;
  id?: string;
}

/** Every mutating engine entry point takes this - docs/APPOINTMENT_ENGINE.md §6. */
export interface IdempotentRequest {
  tenantId: string;
  idempotencyKey: string;
  /** Hash of the semantically relevant request body, computed by the caller (apps/api). */
  requestHash: string;
}
