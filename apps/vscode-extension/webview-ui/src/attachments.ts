/**
 * Attachment upload helpers shared by the chat composer and question cards.
 *
 * Files (picked documents/images or pasted screenshots) upload into the LIVE
 * session's container at /workspace/attachments/… through the host
 * `chat.uploadAttachment` request - the bytes ride the runtime transport, so
 * no mounts change, nothing restarts, and remote/networked runtimes receive
 * them the same way. The returned runtime path is referenced in prompts and
 * answers as a `[file:…]` token the agent can open directly.
 */

import { request } from "./messaging.js";

export const ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;

export interface UploadedAttachment {
  readonly runtimePath: string;
  readonly name: string;
  readonly bytes: number;
}

/** Base64-encodes a Blob in chunks (btoa on the whole buffer overflows args). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Uploads one blob into the session's sandbox. Throws with a user-facing
 * message on failure (session not live, size cap, host error).
 */
export async function uploadAttachment(sessionId: string, name: string, blob: Blob): Promise<UploadedAttachment> {
  if (blob.size === 0) throw new Error("The attachment was empty.");
  if (blob.size > ATTACHMENT_MAX_BYTES) throw new Error("Attachments are capped at 12 MB.");
  const dataBase64 = await blobToBase64(blob);
  const response = await request({ type: "chat.uploadAttachment", sessionId, name, dataBase64 });
  if (!response.ok) throw new Error(response.error.message);
  if (response.payload.type !== "chat.uploadAttachment") throw new Error("Unexpected upload response.");
  return response.payload;
}

/** Files carried by a paste event (screenshots paste as image files). */
export function pastedFiles(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (items === undefined) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return files;
}

/** A stable display/upload name for a pasted blob without one (screenshots). */
export function pastedName(file: File, index: number): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1] ?? "png";
  return `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}-${String(index + 1)}.${ext}`;
}
