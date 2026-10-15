/**
 * Driver-neutral document store.
 *
 * Two implementations exist: Firestore (production) and a filesystem-backed
 * local driver (development, tests, and self-hosting without Firebase). Both
 * support the same small query surface, which is deliberately limited to what
 * Firestore can index efficiently so behaviour does not diverge.
 */

export type Primitive = string | number | boolean | null;

export interface WhereEquals {
  field: string;
  op: '==';
  value: Primitive;
}

export interface WhereIn {
  field: string;
  op: 'in';
  value: Primitive[];
}

export interface WhereRange {
  field: string;
  op: '>' | '>=' | '<' | '<=';
  value: Primitive;
}

export type WhereClause = WhereEquals | WhereIn | WhereRange;

export interface QueryOptions {
  where?: WhereClause[];
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  cursor?: string | null;
}

export interface QueryResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DocStore {
  readonly driver: 'firestore' | 'local';
  get<T>(collection: string, id: string): Promise<T | null>;
  getMany<T>(collection: string, ids: string[]): Promise<T[]>;
  set<T extends object>(collection: string, id: string, doc: T): Promise<void>;
  update<T extends object>(collection: string, id: string, patch: Partial<T>): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  query<T>(collection: string, options: QueryOptions): Promise<QueryResult<T>>;
  /** Deletes every document matching the clauses. Used for account deletion. */
  deleteWhere(collection: string, where: WhereClause[]): Promise<number>;
  /**
   * Runs `fn` with exclusive access to the named documents. `read` inside the
   * callback observes a consistent snapshot; writes are committed atomically.
   */
  transact<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface TransactionContext {
  get<T>(collection: string, id: string): Promise<T | null>;
  set<T extends object>(collection: string, id: string, doc: T): Promise<void>;
  update<T extends object>(collection: string, id: string, patch: Partial<T>): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
}

export const COLLECTIONS = {
  users: 'users',
  projects: 'projects',
  versions: 'projectVersions',
  jobs: 'buildJobs',
  events: 'buildEvents',
  integrations: 'integrations',
  deployments: 'deployments',
  usage: 'usageRecords',
  audit: 'auditLogs',
  aiConfig: 'aiConfig',
  rateLimits: 'rateLimits',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export function encodeCursor(values: Primitive[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Primitive[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed as Primitive[];
  } catch {
    return [];
  }
}

/** Total order used to compare ordering-key values consistently across drivers. */
export function compareValues(a: Primitive, b: Primitive): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? 1 : -1;
  return String(a) < String(b) ? -1 : 1;
}
