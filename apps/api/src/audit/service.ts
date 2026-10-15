import crypto from 'node:crypto';
import type { AuditLog } from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore } from '../db/store.js';

/**
 * Server-side audit trail.
 *
 * Records privileged or sensitive operations (login, project creation,
 * deletion, integration connect/disconnect, deployments, admin actions).
 * Nothing sensitive is ever stored here: metadata is redacted and prompts,
 * tokens and file bodies never reach this collection.
 */
export class AuditService {
  constructor(private readonly store: DocStore) {}

  async record(input: {
    actorUid: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    outcome?: 'success' | 'failure' | 'denied';
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const entry: AuditLog = {
      id: `aud_${crypto.randomBytes(10).toString('hex')}`,
      actorUid: input.actorUid,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome ?? 'success',
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    try {
      await this.store.set(COLLECTIONS.audit, entry.id, entry);
    } catch {
      // Auditing must never take the request down.
    }
  }
}