import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
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

/**
 * Firestore implementation of DocStore.
 *
 * Cursors are opaque base64url strings that carry the ordering-key values of the
 * last document on the previous page, so the same cursor semantics hold for both
 * drivers. Composite indexes required for the queries used by the API are
 * declared in firebase/firestore.indexes.json.
 */
export class FirestoreDocStore implements DocStore {
  readonly driver = 'firestore' as const;

  constructor(private readonly db: Firestore) {}

  private ref(collection: string, id: string) {
    return this.db.collection(collection).doc(id);
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const snap = await this.ref(collection, id).get();
    if (!snap.exists) return null;
    return { ...(snap.data() as T), id: snap.id } as T;
  }

  async getMany<T>(collection: string, ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const refs = ids.map((id) => this.ref(collection, id));
    const snaps = await this.db.getAll(...refs);
    return snaps
      .filter((s) => s.exists)
      .map((s) => ({ ...(s.data() as T), id: s.id }) as T);
  }

  async set<T extends object>(collection: string, id: string, doc: T): Promise<void> {
    await this.ref(collection, id).set(stripId(doc));
  }

  async update<T extends object>(collection: string, id: string, patch: Partial<T>): Promise<void> {
    await this.ref(collection, id).set(stripId(patch), { merge: true });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.ref(collection, id).delete();
  }

  private buildQuery(collection: string, where: WhereClause[], options: QueryOptions): Query {
    let q: Query = this.db.collection(collection);
    for (const clause of where) {
      if (clause.op === 'in') {
        if (clause.value.length === 0) {
          // Firestore rejects an empty `in`; force an impossible match.
          q = q.where(clause.field, 'in', ['__none__']);
        } else {
          q = q.where(clause.field, 'in', clause.value.slice(0, 30));
        }
      } else {
        q = q.where(clause.field, clause.op, clause.value);
      }
    }
    for (const o of options.orderBy ?? []) {
      q = q.orderBy(o.field, o.direction);
    }
    if ((options.orderBy ?? []).length === 0) {
      q = q.orderBy('__name__', 'asc');
    }
    return q;
  }

  async query<T>(collection: string, options: QueryOptions): Promise<QueryResult<T>> {
    const where = options.where ?? [];
    const order = options.orderBy ?? [];
    const limit = options.limit ?? 20;

    let q = this.buildQuery(collection, where, options);
    if (options.cursor) {
      const key = decodeCursor(options.cursor);
      if (key.length > 0) {
        q = q.startAfter(...key);
      }
    }

    // Fetch one extra row to determine whether another page exists.
    const snap = await q.limit(limit + 1).get();
    const docs: QueryDocumentSnapshot[] = snap.docs;
    const hasMore = docs.length > limit;
    const page = docs.slice(0, limit);
    const items = page.map((d) => ({ ...(d.data() as T), id: d.id }) as T);

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1]!;
      const data = last.data() as Record<string, Primitive>;
      const key: Primitive[] = order.map((o) => data[o.field] ?? null);
      if (key.length === 0) key.push(last.id);
      nextCursor = encodeCursor(key);
    }

    return { items, nextCursor };
  }

  async deleteWhere(collection: string, where: WhereClause[]): Promise<number> {
    let removed = 0;
    // Bounded loop: at most 50 batches, which is far beyond any realistic
    // per-user record count, and prevents an unbounded delete loop.
    for (let i = 0; i < 50; i += 1) {
      const q = this.buildQuery(collection, where, { limit: 300 });
      const snap = await q.limit(300).get();
      if (snap.empty) break;
      const batch = this.db.batch();
      for (const doc of snap.docs) batch.delete(doc.ref);
      await batch.commit();
      removed += snap.size;
      if (snap.size < 300) break;
    }
    return removed;
  }

  async transact<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async (fstx) => {
      const tx: TransactionContext = {
        get: async <D>(collection: string, id: string) => {
          const snap = await fstx.get(this.ref(collection, id));
          if (!snap.exists) return null;
          return { ...(snap.data() as D), id: snap.id } as D;
        },
        set: async <D extends object>(collection: string, id: string, doc: D) => {
          fstx.set(this.ref(collection, id), stripId(doc));
        },
        update: async <D extends object>(collection: string, id: string, patch: Partial<D>) => {
          fstx.set(this.ref(collection, id), stripId(patch), { merge: true });
        },
        delete: async (collection: string, id: string) => {
          fstx.delete(this.ref(collection, id));
        },
      };
      return fn(tx);
    });
  }
}

function stripId<T extends object>(doc: T): Record<string, unknown> {
  const { id: _ignored, ...rest } = doc as Record<string, unknown> & { id?: unknown };
  return rest;
}

export { compareValues };
