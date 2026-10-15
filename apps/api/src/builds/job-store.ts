import crypto from 'node:crypto';
import {
  canTransition,
  isTerminal,
  type BuildEvent,
  type BuildEventType,
  type BuildJob,
  type BuildOperation,
  type BuildState,
} from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore, type QueryResult } from '../db/store.js';
import { ApiError } from '../services/errors.js';
import { redactDeep } from '../services/redact.js';

export class BuildJobRepository {
  constructor(private readonly store: DocStore) {}

  async create(input: {
    projectId: string;
    ownerUid: string;
    operation: BuildOperation;
    instruction: string | null;
    baseVersionId: string | null;
    maxRepairAttempts: number;
  }): Promise<BuildJob> {
    const now = new Date().toISOString();
    const job: BuildJob = {
      id: `job_${crypto.randomBytes(12).toString('hex')}`,
      projectId: input.projectId,
      ownerUid: input.ownerUid,
      operation: input.operation,
      state: 'Queued',
      progress: 0,
      instruction: input.instruction,
      baseVersionId: input.baseVersionId,
      resultVersionId: null,
      repairAttempts: 0,
      maxRepairAttempts: input.maxRepairAttempts,
      errorSummary: null,
      errorCode: null,
      cancelRequested: false,
      workerId: null,
      model: null,
      provider: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      lastSeq: 0,
    };
    await this.store.set(COLLECTIONS.jobs, job.id, job);
    return job;
  }

  async get(jobId: string): Promise<BuildJob | null> {
    return this.store.get<BuildJob>(COLLECTIONS.jobs, jobId);
  }

  /** Ownership-checked read. Every API path uses this. */
  async getOwned(jobId: string, ownerUid: string): Promise<BuildJob> {
    const job = await this.store.get<BuildJob>(COLLECTIONS.jobs, jobId);
    if (!job || job.ownerUid !== ownerUid) throw ApiError.notFound('Build job not found');
    return job;
  }

  async update(jobId: string, patch: Partial<BuildJob>): Promise<void> {
    await this.store.update<BuildJob>(COLLECTIONS.jobs, jobId, patch);
  }

  /**
   * Advances the job state machine. Illegal transitions are rejected, so a
   * stale worker cannot resurrect a finished job or skip a stage.
   */
  async transition(
    jobId: string,
    to: BuildState,
    patch: Partial<BuildJob> = {},
  ): Promise<BuildJob> {
    return this.store.transact(async (tx) => {
      const current = await tx.get<BuildJob>(COLLECTIONS.jobs, jobId);
      if (!current) throw ApiError.notFound('Build job not found');
      if (current.state === to) {
        const updated = { ...current, ...patch };
        await tx.set(COLLECTIONS.jobs, jobId, updated);
        return updated;
      }
      if (!canTransition(current.state, to)) {
        throw ApiError.conflict(
          `Illegal build transition ${current.state} → ${to} for job ${jobId}.`,
        );
      }
      const now = new Date().toISOString();
      const next: BuildJob = {
        ...current,
        ...patch,
        state: to,
        startedAt: current.startedAt ?? (to === 'Analyzing' ? now : current.startedAt),
        finishedAt: isTerminal(to) ? now : current.finishedAt,
      };
      await tx.set(COLLECTIONS.jobs, jobId, next);
      return next;
    });
  }

  async requestCancel(jobId: string): Promise<void> {
    await this.store.update<BuildJob>(COLLECTIONS.jobs, jobId, { cancelRequested: true });
  }

  /** Jobs for a project, newest first. */
  async listForProject(projectId: string, limit = 20, cursor?: string | null) {
    return this.store.query<BuildJob>(COLLECTIONS.jobs, {
      where: [{ field: 'projectId', op: '==', value: projectId }],
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
      limit,
      cursor: cursor ?? null,
    });
  }

  async countActiveForUser(ownerUid: string): Promise<number> {
    const active: BuildState[] = [
      'Queued',
      'Analyzing',
      'Planning',
      'Generating',
      'Installing',
      'Building',
      'Repairing',
      'StartingPreview',
      'Deploying',
    ];
    const res = await this.store.query<BuildJob>(COLLECTIONS.jobs, {
      where: [
        { field: 'ownerUid', op: '==', value: ownerUid },
        { field: 'state', op: 'in', value: [...active] },
      ],
      limit: 50,
    });
    return res.items.length;
  }

  async countSince(ownerUid: string, sinceIso: string): Promise<number> {
    const res = await this.store.query<BuildJob>(COLLECTIONS.jobs, {
      where: [
        { field: 'ownerUid', op: '==', value: ownerUid },
        { field: 'createdAt', op: '>=', value: sinceIso },
      ],
      limit: 500,
    });
    return res.items.length;
  }

  async countAllForUser(ownerUid: string): Promise<number> {
    let cursor: string | null = null;
    let total = 0;
    for (let i = 0; i < 50; i += 1) {
      const page: QueryResult<BuildJob> = await this.store.query<BuildJob>(COLLECTIONS.jobs, {
        where: [{ field: 'ownerUid', op: '==', value: ownerUid }],
        orderBy: [{ field: 'createdAt', direction: 'asc' }],
        limit: 100,
        cursor,
      });
      total += page.items.length;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return total;
  }

  async deleteAllForProject(projectId: string): Promise<void> {
    await this.store.deleteWhere(COLLECTIONS.jobs, [
      { field: 'projectId', op: '==', value: projectId },
    ]);
  }

  /**
   * Finds jobs left in a non-terminal state by a previous process. Called at
   * startup so an interrupted worker does not leave jobs running forever.
   */
  async findOrphans(limit = 100): Promise<BuildJob[]> {
    const res = await this.store.query<BuildJob>(COLLECTIONS.jobs, {
      where: [
        {
          field: 'state',
          op: 'in',
          value: [
            'Analyzing',
            'Planning',
            'Generating',
            'Installing',
            'Building',
            'Repairing',
            'StartingPreview',
            'Deploying',
          ],
        },
      ],
      limit,
    });
    return res.items;
  }
}

export class BuildEventRepository {
  constructor(private readonly store: DocStore) {}

  /**
   * Appends an event. Sequence numbers are allocated inside a transaction so
   * concurrent writers cannot produce duplicates or gaps that would break
   * SSE resumption.
   */
  async append(input: {
    jobId: string;
    type: BuildEventType;
    state: BuildState;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<BuildEvent> {
    const event = await this.store.transact(async (tx) => {
      const job = await tx.get<BuildJob>(COLLECTIONS.jobs, input.jobId);
      if (!job) throw ApiError.notFound('Build job not found');
      const seq = job.lastSeq + 1;
      const next: BuildEvent = {
        id: `evt_${crypto.randomBytes(10).toString('hex')}`,
        jobId: input.jobId,
        seq,
        type: input.type,
        state: input.state,
        message: input.message.slice(0, 2_000),
        data: redactDeep(input.data ?? {}) as Record<string, unknown>,
        at: new Date().toISOString(),
      };
      await tx.set(COLLECTIONS.events, next.id, next);
      await tx.update<BuildJob>(COLLECTIONS.jobs, input.jobId, { lastSeq: seq });
      return next;
    });
    return event;
  }

  async listSince(jobId: string, sinceSeq: number, limit = 500): Promise<BuildEvent[]> {
    const res = await this.store.query<BuildEvent>(COLLECTIONS.events, {
      where: [
        { field: 'jobId', op: '==', value: jobId },
        { field: 'seq', op: '>', value: sinceSeq },
      ],
      orderBy: [{ field: 'seq', direction: 'asc' }],
      limit,
    });
    return res.items;
  }

  async listAll(jobId: string, limit = 500): Promise<BuildEvent[]> {
    const res = await this.store.query<BuildEvent>(COLLECTIONS.events, {
      where: [{ field: 'jobId', op: '==', value: jobId }],
      orderBy: [{ field: 'seq', direction: 'asc' }],
      limit,
    });
    return res.items;
  }

  async deleteForJob(jobId: string): Promise<void> {
    await this.store.deleteWhere(COLLECTIONS.events, [
      { field: 'jobId', op: '==', value: jobId },
    ]);
  }

  /** Deletes every event owned by a user (used during account deletion). */
  async deleteForOwner(ownerUid: string): Promise<void> {
    await this.store.deleteWhere(COLLECTIONS.events, [
      { field: 'ownerUid', op: '==', value: ownerUid },
    ]);
  }
}
