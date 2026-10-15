import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  COLLECTIONS,
  compareValues,
  decodeCursor,
  encodeCursor,
  type DocStore,
  type Primitive,
  type QueryOptions,
  type QueryResult,
  type TransactionContext,
  type WhereClause,
} from './store.js';
import { logger } from '../services/logger.js';

type Doc = Record<string, unknown> & { id: string };

/**
 * Filesystem-backed document store for local development, tests and
 * self-hosting without Firebase.
 *
 * One JSON file per collection, written atomically (tmp file + rename). All
 * mutations are serialised through a promise chain so concurrent requests cannot
 * interleave read-modify-write cycles. This is a development driver: it assumes
 * a single API process.
 */
export class LocalDocStore implements DocStore {
  readonly driver = 'local' as const;
  private readonly dataDir: string;
  private readonly cache = new Map<string, Map<string, Doc>>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Monotonic revision guard used by the version-conflict check. */
  private revision = 0;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  private file(collection: string): string {
    return path.join(this.dataDir, `${collection}.json`);
  }

  private async load(collection: string): Promise<Map<string, Doc>> {
    const cached = this.cache.get(collection);
    if (cached) return cached;
    const map = new Map<string, Doc>();
    try {
      const raw = await fs.readFile(this.file(collection), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const d of parsed as Doc[]) {
          if (d && typeof d === 'object' && typeof d.id === 'string') map.set(d.id, d);
        }
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger().warn({ collection, err: String(e) }, 'local store: unreadable collection, starting empty');
      }
    }
    this.cache.set(collection, map);
    return map;
  }

  private async persist(collection: string, map: Map<string, Doc>): Promise<void> {
    const file = this.file(collection);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify([...map.values()], null, 0);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, file);
  }

  /** Serialises an operation so no two mutations interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the chain alive even if a link rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const map = await this.load(collection);
    const doc = map.get(id);
    return doc ? (structuredClone(doc) as T) : null;
  }

  async getMany<T>(collection: string, ids: string[]): Promise<T[]> {
    const map = await this.load(collection);
    const out: T[] = [];
    for (const id of ids) {
      const doc = map.get(id);
      if (doc) out.push(structuredClone(doc) as T);
    }
    return out;
  }

  async set<T extends object>(collection: string, id: string, doc: T): Promise<void> {
    await this.enqueue(async () => {
      const map = await this.load(collection);
      this.revision += 1;
      map.set(id, { ...(structuredClone(doc) as Doc), id, __rev: this.revision });
      await this.persist(collection, map);
    });
  }

  async update<T extends object>(collection: string, id: string, patch: Partial<T>): Promise<void> {
    await this.enqueue(async () => {
      const map = await this.load(collection);
      const existing = map.get(id);
      if (!existing) return;
      this.revision += 1;
      map.set(id, { ...existing, ...(structuredClone(patch) as Doc), id, __rev: this.revision });
      await this.persist(collection, map);
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.enqueue(async () => {
      const map = await this.load(collection);
      if (!map.delete(id)) return;
      await this.persist(collection, map);
    });
  }

  async query<T>(collection: string, options: QueryOptions): Promise<QueryResult<T>> {
    const map = await this.load(collection);
    const where = options.where ?? [];
    let items = [...map.values()].filter((doc) => matches(doc, where));

    const order = options.orderBy ?? [];
    if (order.length > 0) {
      items.sort((a, b) => {
        for (const o of order) {
          const cmp = compareValues(a[o.field] as Primitive, b[o.field] as Primitive);
          if (cmp !== 0) return o.direction === 'asc' ? cmp : -cmp;
        }
        return compareValues(a.id, b.id);
      });
    } else {
      items.sort((a, b) => compareValues(a.id, b.id));
    }

    if (options.cursor) {
      const key = decodeCursor(options.cursor);
      if (key.length > 0 && order.length > 0) {
        items = items.filter((doc) => {
          for (let i = 0; i < order.length; i += 1) {
            const cmp = compareValues(doc[order[i]!.field] as Primitive, key[i] ?? null);
            if (cmp !== 0) return order[i]!.direction === 'asc' ? cmp > 0 : cmp < 0;
          }
          return compareValues(doc.id, (key[order.length] as string) ?? '') > 0;
        });
      }
    }

    const limit = options.limit ?? 20;
    const page = items.slice(0, limit);
    const hasMore = items.length > limit;
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0 && order.length > 0) {
      const last = page[page.length - 1]!;
      nextCursor = encodeCursor([...order.map((o) => last[o.field] as Primitive), last.id]);
    }

    return { items: page.map((d) => structuredClone(d) as T), nextCursor };
  }

  async deleteWhere(collection: string, where: WhereClause[]): Promise<number> {
    return this.enqueue(async () => {
      const map = await this.load(collection);
      let removed = 0;
      for (const [id, doc] of [...map.entries()]) {
        if (matches(doc, where)) {
          map.delete(id);
          removed += 1;
        }
      }
      if (removed > 0) await this.persist(collection, map);
      return removed;
    });
  }

  /**
   * Snapshot-isolated transaction. The whole operation runs inside the write
   * queue, so it is atomic with respect to other store operations.
   */
  async transact<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const reads = new Map<string, Map<string, Doc>>();
      const writes: Array<() => Promise<void>> = [];

      const loadFor = async (collection: string) => {
        let map = reads.get(collection);
        if (!map) {
          map = new Map((await this.load(collection)).entries());
          reads.set(collection, map);
        }
        return map;
      };

      const tx: TransactionContext = {
        get: async <D>(collection: string, id: string) => {
          const map = await loadFor(collection);
          const doc = map.get(id);
          return doc ? (structuredClone(doc) as D) : null;
        },
        set: async <D extends object>(collection: string, id: string, doc: D) => {
          const map = await loadFor(collection);
          map.set(id, { ...(structuredClone(doc) as Doc), id });
          writes.push(async () => {
            const live = await this.load(collection);
            live.set(id, { ...(structuredClone(doc) as Doc), id });
            await this.persist(collection, live);
          });
        },
        update: async <D extends object>(collection: string, id: string, patch: Partial<D>) => {
          const map = await loadFor(collection);
          const existing = map.get(id);
          if (!existing) return;
          const next = { ...existing, ...(structuredClone(patch) as Doc), id };
          map.set(id, next);
          writes.push(async () => {
            const live = await this.load(collection);
            live.set(id, next);
            await this.persist(collection, live);
          });
        },
        delete: async (collection: string, id: string) => {
          const map = await loadFor(collection);
          map.delete(id);
          writes.push(async () => {
            const live = await this.load(collection);
            live.delete(id);
            await this.persist(collection, live);
          });
        },
      };

      const result = await fn(tx);
      for (const w of writes) await w();
      return result;
    });
  }

  /** Test helper: drops every cached collection. */
  async reset(): Promise<void> {
    await this.enqueue(async () => {
      this.cache.clear();
      await fs.rm(this.dataDir, { recursive: true, force: true });
      await fs.mkdir(this.dataDir, { recursive: true });
    });
  }
}

function matches(doc: Doc, where: WhereClause[]): boolean {
  for (const clause of where) {
    const value = doc[clause.field] as Primitive;
    switch (clause.op) {
      case '==':
        if (value !== clause.value) return false;
        break;
      case 'in':
        if (!clause.value.includes(value)) return false;
        break;
      case '>':
        if (compareValues(value, clause.value) <= 0) return false;
        break;
      case '>=':
        if (compareValues(value, clause.value) < 0) return false;
        break;
      case '<':
        if (compareValues(value, clause.value) >= 0) return false;
        break;
      case '<=':
        if (compareValues(value, clause.value) > 0) return false;
        break;
    }
  }
  return true;
}

export const ALL_COLLECTIONS = Object.values(COLLECTIONS);
