import crypto from 'node:crypto';
import type {
  BuildStatus,
  ListProjectsQuery,
  Project,
  ProjectCategory,
  ProjectFramework,
  ProjectTheme,
  ProjectVersion,
  VersionDiffEntry,
} from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore, type WhereClause, type QueryResult } from '../db/store.js';
import { ApiError } from '../services/errors.js';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export interface ProjectVersionRecord extends ProjectVersion {
  /** Manifest of the artifact tree, stored alongside the metadata. */
  manifest: Array<{ path: string; size: number; hash: string }>;
  createdBy: string;
  /** Spec snapshot used to generate this version, so refinements keep context. */
  specJson: string | null;
}

export class ProjectRepository {
  constructor(private readonly store: DocStore) {}

  async getOwned(projectId: string, ownerUid: string): Promise<Project> {
    const project = await this.store.get<Project>(COLLECTIONS.projects, projectId);
    if (!project) throw ApiError.notFound('Project not found');
    // Ownership is checked on every single access path.
    if (project.ownerUid !== ownerUid) throw ApiError.notFound('Project not found');
    return project;
  }

  async get(projectId: string): Promise<Project | null> {
    return this.store.get<Project>(COLLECTIONS.projects, projectId);
  }

  async list(ownerUid: string, query: ListProjectsQuery) {
    const where: WhereClause[] = [{ field: 'ownerUid', op: '==', value: ownerUid }];
    if (!query.includeArchived) {
      where.push({ field: 'archived', op: '==', value: false });
    }
    if (query.status) {
      where.push({ field: 'status', op: '==', value: query.status });
    }

    const result = await this.store.query<Project>(COLLECTIONS.projects, {
      where,
      orderBy: [{ field: query.sort, direction: query.direction }],
      limit: query.limit,
      cursor: query.cursor ?? null,
    });

    if (!query.search) return result;

    // Free-text filtering happens after pagination because Firestore has no
    // portable substring search. The page size stays bounded, so this is cheap.
    const needle = query.search.toLowerCase();
    return {
      items: result.items.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.description.toLowerCase().includes(needle),
      ),
      nextCursor: result.nextCursor,
    };
  }

  async countForUser(ownerUid: string): Promise<number> {
    let cursor: string | null = null;
    let total = 0;
    for (let i = 0; i < 50; i += 1) {
      const page: QueryResult<Project> = await this.store.query<Project>(COLLECTIONS.projects, {
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

  async create(input: {
    ownerUid: string;
    name: string;
    description: string;
    category: ProjectCategory;
    framework: ProjectFramework;
    theme: ProjectTheme;
  }): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      id: newId('prj'),
      ownerUid: input.ownerUid,
      name: input.name,
      description: input.description,
      category: input.category,
      framework: input.framework,
      theme: input.theme,
      status: 'draft',
      lastBuildStatus: 'never',
      currentVersionId: null,
      versionCount: 0,
      archived: false,
      createdAt: now,
      updatedAt: now,
      lastBuildAt: null,
      previewUrl: null,
      lastError: null,
    };
    await this.store.set(COLLECTIONS.projects, project.id, project);
    return project;
  }

  async update(projectId: string, ownerUid: string, patch: Partial<Project>): Promise<Project> {
    const existing = await this.getOwned(projectId, ownerUid);
    const {
      id: _id,
      ownerUid: _owner,
      createdAt: _created,
      ...safe
    } = patch as Partial<Project> & { id?: string; ownerUid?: string; createdAt?: string };
    const next: Project = {
      ...existing,
      ...safe,
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(COLLECTIONS.projects, projectId, next);
    return next;
  }

  async setCurrentVersion(
    projectId: string,
    ownerUid: string,
    versionId: string,
    versionCount: number,
    buildStatus: BuildStatus,
  ): Promise<void> {
    await this.getOwned(projectId, ownerUid);
    await this.store.update<Project>(COLLECTIONS.projects, projectId, {
      currentVersionId: versionId,
      versionCount,
      lastBuildStatus: buildStatus,
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(projectId: string, ownerUid: string): Promise<void> {
    await this.getOwned(projectId, ownerUid);
    await this.store.delete(COLLECTIONS.projects, projectId);
  }

  async deleteAllForUser(ownerUid: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const page: QueryResult<Project> = await this.store.query<Project>(COLLECTIONS.projects, {
        where: [{ field: 'ownerUid', op: '==', value: ownerUid }],
        orderBy: [{ field: 'createdAt', direction: 'asc' }],
        limit: 100,
        cursor,
      });
      for (const p of page.items) ids.push(p.id);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    await this.store.deleteWhere(COLLECTIONS.projects, [
      { field: 'ownerUid', op: '==', value: ownerUid },
    ]);
    return ids;
  }
}

export class VersionRepository {
  constructor(private readonly store: DocStore) {}

  async get(projectId: string, versionId: string): Promise<ProjectVersionRecord> {
    const record = await this.store.get<ProjectVersionRecord>(COLLECTIONS.versions, versionId);
    if (!record || record.projectId !== projectId) {
      throw ApiError.notFound('Version not found');
    }
    return record;
  }

  async list(projectId: string, limit = 50, cursor?: string | null) {
    return this.store.query<ProjectVersionRecord>(COLLECTIONS.versions, {
      where: [{ field: 'projectId', op: '==', value: projectId }],
      orderBy: [{ field: 'ordinal', direction: 'desc' }],
      limit,
      cursor: cursor ?? null,
    });
  }

  async latestOrdinal(projectId: string): Promise<number> {
    const page = await this.store.query<ProjectVersionRecord>(COLLECTIONS.versions, {
      where: [{ field: 'projectId', op: '==', value: projectId }],
      orderBy: [{ field: 'ordinal', direction: 'desc' }],
      limit: 1,
    });
    return page.items[0]?.ordinal ?? 0;
  }

  async create(input: {
    projectId: string;
    parentVersionId: string | null;
    summary: string;
    origin: ProjectVersion['origin'];
    manifest: Array<{ path: string; size: number; hash: string }>;
    createdBy: string;
    buildStatus: BuildStatus;
    buildLogExcerpt?: string | null;
    model?: string | null;
    taskRole?: string | null;
    specJson?: string | null;
    /** Explicit version ID; used when artifacts were already written under it. */
    id?: string;
  }): Promise<ProjectVersionRecord> {
    const ordinal = (await this.latestOrdinal(input.projectId)) + 1;
    const totalBytes = input.manifest.reduce((sum, f) => sum + f.size, 0);
    const record: ProjectVersionRecord = {
      id: input.id ?? newId('ver'),
      projectId: input.projectId,
      parentVersionId: input.parentVersionId,
      ordinal,
      summary: input.summary,
      origin: input.origin,
      fileCount: input.manifest.length,
      totalBytes,
      buildStatus: input.buildStatus,
      buildLogExcerpt: input.buildLogExcerpt ?? null,
      createdAt: new Date().toISOString(),
      model: input.model ?? null,
      taskRole: input.taskRole ?? null,
      manifest: input.manifest,
      createdBy: input.createdBy,
      specJson: input.specJson ?? null,
    };
    await this.store.set(COLLECTIONS.versions, record.id, record);
    return record;
  }

  async updateBuildStatus(
    versionId: string,
    buildStatus: BuildStatus,
    buildLogExcerpt: string | null,
  ): Promise<void> {
    await this.store.update<ProjectVersionRecord>(COLLECTIONS.versions, versionId, {
      buildStatus,
      buildLogExcerpt,
    });
  }

  async deleteAllForProject(projectId: string): Promise<void> {
    await this.store.deleteWhere(COLLECTIONS.versions, [
      { field: 'projectId', op: '==', value: projectId },
    ]);
  }
}

/** Line-level diff summary between two manifests. */
export function diffManifests(
  from: Map<string, string>,
  to: Map<string, string>,
): { entries: VersionDiffEntry[] } {
  const entries: VersionDiffEntry[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const a = from.get(path);
    const b = to.get(path);
    if (a === undefined && b !== undefined) {
      entries.push({ path, change: 'added', additions: countLines(b), deletions: 0 });
    } else if (a !== undefined && b === undefined) {
      entries.push({ path, change: 'deleted', additions: 0, deletions: countLines(a) });
    } else if (a !== undefined && b !== undefined && a !== b) {
      const stats = lineDelta(a, b);
      entries.push({
        path,
        change: 'modified',
        additions: stats.additions,
        deletions: stats.deletions,
      });
    }
  }
  return { entries };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/** Counts added/removed lines using a longest-common-subsequence line diff. */
function lineDelta(a: string, b: string): { additions: number; deletions: number } {
  const left = a.split('\n');
  const right = b.split('\n');
  if (left.length * right.length > 4_000_000) {
    return { additions: right.length, deletions: left.length };
  }
  const lcs = longestCommonSubsequenceLength(left, right);
  return {
    additions: right.length - lcs,
    deletions: left.length - lcs,
  };
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}
