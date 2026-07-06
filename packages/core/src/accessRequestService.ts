/**
 * Access request service.
 *
 * Owns the explicit approval path for widening a live session's mounts. A
 * request stays pending until a human resolves it; approval validates denied
 * paths and yields a MountPolicy the orchestration layer applies via a
 * runtime-generation restart. This service never touches runtimes itself.
 */

import path from "node:path";
import type {
  AccessRequestId,
  AccessRequestRecord,
  AccessRequestStatus,
  AccessRequestStore,
  MountPolicy,
  SessionId
} from "@drydock/contracts";
import type { Clock } from "./clock.js";
import type { IdGenerator } from "./ids.js";
import { assertMountAllowed } from "./mountPolicy.js";

export interface AccessRequestServiceOptions {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly store: AccessRequestStore;
  readonly deniedPaths: readonly string[];
}

export class AccessRequestService {
  constructor(private readonly options: AccessRequestServiceOptions) {}

  async createRequest(input: {
    readonly sessionId: SessionId;
    readonly hostPath: string;
    readonly mode: "read-only" | "read-write";
    readonly reason: string;
  }): Promise<AccessRequestRecord> {
    if (!path.isAbsolute(input.hostPath)) {
      throw new Error(`Access request path must be absolute: ${input.hostPath}`);
    }
    const record: AccessRequestRecord = {
      accessRequestId: this.options.ids.accessRequestId(),
      sessionId: input.sessionId,
      hostPath: path.resolve(input.hostPath),
      mode: input.mode,
      reason: input.reason,
      status: "pending",
      requestedAt: this.options.clock.isoNow()
    };
    await this.options.store.insertRequest(record);
    return record;
  }

  /**
   * Corrects a still-pending request's path (the approval card's Edit path
   * affordance). Absoluteness is re-checked here, the one gate createRequest
   * uses, so an edited path can never widen the mount beyond an absolute host
   * directory. The stored path is resolved to match createRequest's storage.
   */
  async editRequestPath(accessRequestId: AccessRequestId, hostPath: string): Promise<AccessRequestRecord> {
    const request = await this.requiredPending(accessRequestId);
    if (!path.isAbsolute(hostPath)) {
      throw new Error(`Access request path must be absolute: ${hostPath}`);
    }
    const resolved = path.resolve(hostPath);
    await this.options.store.updateRequestPath(accessRequestId, resolved);
    return { ...request, hostPath: resolved };
  }

  /**
   * Validates a pending request against denied paths and builds the mount it
   * would add. The request stays pending until markApproved runs, so a failed
   * runtime restart leaves it retryable.
   */
  async prepareApproval(accessRequestId: AccessRequestId): Promise<{ readonly request: AccessRequestRecord; readonly mount: MountPolicy }> {
    const request = await this.requiredPending(accessRequestId);
    assertMountAllowed(request.hostPath, this.options.deniedPaths);
    const approvedAt = this.options.clock.isoNow();
    const mount: MountPolicy = {
      mountId: this.options.ids.mountId(),
      hostPath: request.hostPath,
      runtimePath: `/approved/${accessRequestId}`,
      mode: request.mode,
      source: request.mode === "read-only" ? "shared-read" : "shared-write",
      approvedBy: "user",
      approvedAt
    };
    return { request, mount };
  }

  async markApproved(accessRequestId: AccessRequestId, resolvedBy: string): Promise<AccessRequestRecord> {
    return this.resolve(accessRequestId, "approved", resolvedBy);
  }

  async denyRequest(accessRequestId: AccessRequestId, resolvedBy: string): Promise<AccessRequestRecord> {
    return this.resolve(accessRequestId, "denied", resolvedBy);
  }

  listRequests(status?: AccessRequestStatus): Promise<AccessRequestRecord[]> {
    return this.options.store.listRequests(status);
  }

  private async resolve(accessRequestId: AccessRequestId, status: AccessRequestStatus, resolvedBy: string): Promise<AccessRequestRecord> {
    const request = await this.requiredPending(accessRequestId);
    const resolvedAt = this.options.clock.isoNow();
    await this.options.store.updateRequestStatus(accessRequestId, status, resolvedAt, resolvedBy);
    return { ...request, status, resolvedAt, resolvedBy };
  }

  private async requiredPending(accessRequestId: AccessRequestId): Promise<AccessRequestRecord> {
    const request = await this.options.store.getRequest(accessRequestId);
    if (request === null) {
      throw new Error(`Access request ${accessRequestId} was not found.`);
    }
    if (request.status !== "pending") {
      throw new Error(`Access request ${accessRequestId} is already ${request.status}.`);
    }
    return request;
  }
}
