/**
 * Serializable JSON value contracts.
 *
 * This package owns wire-safe data shapes shared by extension UI, services,
 * storage adapters, and runtime adapters.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

