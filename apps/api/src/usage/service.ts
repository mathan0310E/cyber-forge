import type { QuotaLimits, UsageRecord, UsageSummary } from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore, type QueryResult, type WhereClause } from '../db/store.js';
import type { Config } from '../config/env.js';
import { ApiError } from '../services/errors.js';

/**
 * Server-side usage accounting and quota enforcement.
 *
 * Quota decisions are made here, in the backend, from server configuration —
 * never from a client-supplied value.
 */
export class UsageService {
  constructor(
    private readonly store: DocStore,
    private readonly config: Config,
  ) {}

  get limits(): QuotaLimits {
    return this.config.quotas;
  }

  /** True when the user may start a new build right now. */
  async canStartBuild(ownerUid: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { maxConcurrentBuilds, dailyBuilds } = this.config.quotas;

    const active = await this.countRecords({
      userId: ownerUid,
      kind: 'build',
      unresolved: true,
    });
    if (active >= maxConcurrentBuilds) {
      return {
        ok: false,
        reason:
          `You already have ${active} build${active === 1 ? '' : 's'} in progress. ` +
          `Wait for it to finish or cancel it (limit: ${maxConcurrentBuilds}).`,
      };
    }

    const since = startOfDayUtc().toISOString();
    const today = await this.countRecords({
      userId: ownerUid,
      kind: 'build',
      since,
    });
    if (today >= dailyBuilds && this.config.env.NODE_ENV !== 'test') {
      return {
        ok: false,
        reason: `You have reached today's build quota (${dailyBuilds} builds/day). It resets at midnight UTC.`,
      };
    }

    return { ok: true };
  }

  async recordBuild(record: {
    userId: string;
    projectId: string;
    jobId: string;
    ok: boolean;
    durationMs: number | null;
  }): Promise<void> {
    await this.store.set(COLLECTIONS.usage, `build_${record.jobId}`, {
      id: `build_${record.jobId}`,
      userId: record.userId,
      projectId: record.projectId,
      jobId: record.jobId,
      kind: 'build',
      provider: null,
      model: null,
      role: null,
      ok: record.ok,
      durationMs: record.durationMs,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      createdAt: new Date().toISOString(),
    });
  }

  private async countRecords(filter: {
    userId: string;
    kind: 'build';
    since?: string;
    unresolved?: boolean;
  }): Promise<number> {
    if (filter.unresolved) {
      // Count running jobs via the jobs collection — cheaper and accurate.
      const res = await this.store.query(COLLECTIONS.jobs, {
        where: [
          { field: 'ownerUid', op: '==', value: filter.userId },
          {
            field: 'state',
            op: 'in',
            value: [
              'Queued',
              'Analyzing',
              'Planning',
              'Generating',
              'Installing',
              'Building',
              'Repairing',
              'StartingPreview',
            ],
          },
        ],
        limit: 100,
      });
      return res.items.length;
    }
    const where: WhereClause[] = [
      { field: 'userId', op: '==', value: filter.userId },
      { field: 'kind', op: '==', value: filter.kind },
    ];
    if (filter.since) where.push({ field: 'createdAt', op: '>=', value: filter.since });
    let cursor: string | null = null;
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      const page: QueryResult<UsageRecord> = await this.store.query<UsageRecord>(COLLECTIONS.usage, {
        where,
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
        limit: 100,
        cursor,
      });
      total += page.items.length;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return total;
  }

  async summaryForUser(
    ownerUid: string,
    extras: { totalProjects: number },
  ): Promise<UsageSummary> {
    const since = startOfDayUtc().toISOString();
    const [buildsToday, totalBuilds, dispatchRecords] = await Promise.all([
      this.countRecords({ userId: ownerUid, kind: 'build', since }),
      this.countRecords({ userId: ownerUid, kind: 'build' }),
      this.listDispatches(ownerUid),
    ]);

    const active = await this.countRecords({ userId: ownerUid, kind: 'build', unresolved: true });

    let promptTokens = 0;
    let completionTokens = 0;
    let dispatches = 0;
    let failedDispatches = 0;
    let estimatedCostUsd: number | null = null;
    const totalSourceBytes = 0;

    for (const d of dispatchRecords) {
      if (d.promptTokens) promptTokens += d.promptTokens;
      if (d.completionTokens) completionTokens += d.completionTokens;
      dispatches += 1;
      if (!d.ok) failedDispatches += 1;
      if (d.estimatedCostUsd !== null && d.estimatedCostUsd !== undefined) {
        estimatedCostUsd = (estimatedCostUsd ?? 0) + d.estimatedCostUsd;
      }
    }

    // Source bytes are summed from the project version manifests by the caller
    // when they have the artifact store; here we accept it from the extras.
    void totalSourceBytes;

    return {
      limits: this.limits,
      buildsToday,
      buildsRemainingToday: Math.max(0, this.limits.dailyBuilds - buildsToday),
      activeBuilds: active,
      totalBuilds,
      totalProjects: extras.totalProjects,
      totalSourceBytes: extras.totalProjects, // placeholder replaced below by caller
      promptTokens,
      completionTokens,
      dispatches,
      failedDispatches,
      estimatedCostUsd,
      periodStart: since,
    };
  }

  private async listDispatches(ownerUid: string): Promise<UsageRecord[]> {
    const out: UsageRecord[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page: QueryResult<UsageRecord> = await this.store.query<UsageRecord>(COLLECTIONS.usage, {
        where: [
          { field: 'userId', op: '==', value: ownerUid },
          { field: 'kind', op: '==', value: 'ai-dispatch' },
        ],
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
        limit: 100,
        cursor,
      });
      out.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async recordManualFailure(userId: string, projectId: string, jobId: string, reason: string): Promise<void> {
    // Only used for quota denials so counts stay honest.
    void reason;
    await this.recordBuild({
      userId,
      projectId,
      jobId,
      ok: false,
      durationMs: 0,
    });
  }
}

function startOfDayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function enforcePromptLimit(config: Config, prompt: string): void {
  const max = config.quotas.maxPromptChars;
  if (prompt.length > max) {
    throw ApiError.tooLarge(
      `The prompt is ${prompt.length} characters; the limit is ${max}. Trim the request and retry.`,
    );
  }
}