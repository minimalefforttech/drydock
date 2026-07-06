/**
 * Stable product error contracts.
 *
 * Services return these codes at package boundaries so UI and tests never
 * depend on provider-specific text.
 */

import type { JsonObject } from "./json.js";

export type ProductErrorCode =
  | "RUNTIME_CREATE_FAILED"
  | "RUNTIME_CLEANUP_FAILED"
  | "RUNTIME_RESET_REQUIRED"
  | "RUNTIME_RESTART_REQUIRED"
  | "AUTH_REQUIRED"
  | "ACCESS_REQUEST_REQUIRED"
  | "ADAPTER_UNAVAILABLE"
  | "PROTOCOL_UNAVAILABLE"
  | "DIFF_CONFLICT"
  | "PLAN_APPROVAL_REQUIRED"
  | "HITL_REQUIRED"
  | "TASK_ACTIVATION_REQUIRED"
  | "TASK_SYNC_CONFLICT"
  | "PROVIDER_SCHEMA_INVALID"
  | "STATE_STORE_UNAVAILABLE"
  | "WORKSPACE_SWITCH_REQUIRED"
  | "DAY_PLAN_CONFLICT";

export interface ProductError {
  readonly code: ProductErrorCode;
  readonly service: string;
  readonly operation: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly userAction: string;
  readonly providerId?: string;
  readonly diagnostics?: JsonObject;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProductError };

/** Creates a boundary-safe product error without leaking raw provider output by default. */
export function productError(input: ProductError): ProductError {
  return input;
}

