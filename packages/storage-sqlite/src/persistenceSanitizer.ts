/**
 * Last-line sanitization for JSON written to local state.
 *
 * Normalized events still need to replay with their original shape, so this
 * removes only transport internals and credentials, and caps fields that can
 * contain unbounded command/tool output. Security evidence uses the stricter
 * metadata mode below to omit content-bearing fields entirely.
 */

import type { JsonObject, JsonValue } from "@drydock/contracts";

export const PERSISTED_OUTPUT_MAX_CHARS = 16_384;
export const SECURITY_METADATA_MAX_STRING_CHARS = 512;
export const SECURITY_METADATA_MAX_JSON_CHARS = 8_192;

const REDACTED = "[REDACTED]";
const OUTPUT_TRUNCATION_SUFFIX = "… [truncated by storage]";

const RAW_TRANSPORT_KEYS = new Set([
  "raw",
  "rawframe",
  "rawframes",
  "transportframe",
  "transportframes",
  "transportevent",
  "transportevents"
]);

const OUTPUT_KEYS = new Set(["output", "stdout", "stderr", "tooloutput", "commandoutput"]);

const SECURITY_METADATA_KEYS = new Set([
  "accessrequestid",
  "allowedrootcount",
  "cloneonly",
  "managed",
  "mode",
  "networkedaiallowed",
  "policyfingerprint",
  "runid",
  "status"
]);

/** Sanitizes a replayable event without mutating the caller's object. */
export function sanitizePersistedEventPayload(payload: JsonObject): JsonObject {
  return sanitizeObject(payload, "event");
}

/**
 * Produces small, redacted, content-free metadata for the security ledger.
 * If the result is still unexpectedly large, all metadata is omitted rather
 * than risking protected content being retained as evidence.
 */
export function sanitizeSecurityMetadata(metadata: JsonObject | undefined): JsonObject {
  if (metadata === undefined) {
    return {};
  }
  const sanitized = sanitizeObject(metadata, "security");
  return JSON.stringify(sanitized).length <= SECURITY_METADATA_MAX_JSON_CHARS
    ? sanitized
    : { omitted: "metadata exceeded the evidence limit" };
}

function sanitizeObject(value: JsonObject, mode: "event" | "security"): JsonObject {
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key);
    if (mode === "security" && !SECURITY_METADATA_KEYS.has(normalizedKey)) {
      continue;
    }
    if (RAW_TRANSPORT_KEYS.has(normalizedKey)) {
      continue;
    }
    if (isSecretKey(normalizedKey)) {
      sanitized[key] = REDACTED;
      continue;
    }
    sanitized[key] = sanitizeValue(child, normalizedKey, mode);
  }
  return sanitized;
}

function sanitizeValue(value: JsonValue, parentKey: string, mode: "event" | "security"): JsonValue {
  if (typeof value === "string") {
    const redacted = redactCredentialText(value);
    if (mode === "security") {
      return capString(redacted, SECURITY_METADATA_MAX_STRING_CHARS, "… [truncated]");
    }
    return OUTPUT_KEYS.has(parentKey)
      ? capString(redacted, PERSISTED_OUTPUT_MAX_CHARS, OUTPUT_TRUNCATION_SUFFIX)
      : redacted;
  }
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeValue(child, parentKey, mode));
  }
  if (value !== null && typeof value === "object") {
    return sanitizeObject(value, mode);
  }
  return value;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  return key.endsWith("authorization")
    || key.endsWith("cookie")
    || key.endsWith("token")
    || key.endsWith("password")
    || key.endsWith("passphrase")
    || key.endsWith("secret")
    || key.endsWith("apikey")
    || key.endsWith("accesstoken")
    || key.endsWith("refreshtoken")
    || key.endsWith("authtoken")
    || key.endsWith("bearertoken")
    || key.endsWith("privatekey")
    || key.endsWith("secretkey")
    || key.endsWith("accesskey")
    || key.endsWith("accesskeyid")
    || key.endsWith("credential")
    || key.endsWith("credentials");
}

/**
 * LOCKSTEP COPY of `redactCredentialText` in `@drydock/core`
 * `commandRunner.ts` (receipt evidence path): storage and core are sibling
 * packages over contracts. Change both together.
 */
function redactCredentialText(value: string): string {
  return value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----/g,
      "[REDACTED PRIVATE KEY]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?\b(?:api[-_ ]?key|x-api-key)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
}

function capString(value: string, limit: number, suffix: string): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}
