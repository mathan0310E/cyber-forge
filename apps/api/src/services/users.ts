import type { SessionUser, UserRole } from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore } from '../db/store.js';

export interface UserRecord {
  id: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  role: UserRole;
  /** Only present for accounts created by the local auth driver. */
  passwordHash: string | null;
  passwordSalt: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /**
   * Admin identities are configured out-of-band (WOLF_FORGE_ADMIN_UIDS) and
   * mirrored here by the server. This field is never writable from the API.
   */
  adminGrantedBy: string | null;
}

export class UserRepository {
  constructor(private readonly store: DocStore) {}

  async getById(uid: string): Promise<UserRecord | null> {
    return this.store.get<UserRecord>(COLLECTIONS.users, uid);
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const res = await this.store.query<UserRecord>(COLLECTIONS.users, {
      where: [{ field: 'email', op: '==', value: email.toLowerCase() }],
      limit: 1,
    });
    return res.items[0] ?? null;
  }

  async create(input: {
    uid: string;
    email: string | null;
    displayName: string | null;
    emailVerified: boolean;
    role?: UserRole;
    passwordHash?: string | null;
    passwordSalt?: string | null;
  }): Promise<UserRecord> {
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: input.uid,
      email: input.email ? input.email.toLowerCase() : null,
      displayName: input.displayName,
      emailVerified: input.emailVerified,
      role: input.role ?? 'user',
      passwordHash: input.passwordHash ?? null,
      passwordSalt: input.passwordSalt ?? null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      adminGrantedBy: null,
    };
    await this.store.set(COLLECTIONS.users, input.uid, record);
    return record;
  }

  async update(uid: string, patch: Partial<UserRecord>): Promise<void> {
    // Role and password material are never settable through this path.
    const { role: _r, adminGrantedBy: _a, passwordHash: _p, passwordSalt: _s, ...safe } = patch;
    await this.store.update<UserRecord>(COLLECTIONS.users, uid, {
      ...safe,
      updatedAt: new Date().toISOString(),
    });
  }

  async recordLogin(uid: string): Promise<void> {
    await this.store.update<UserRecord>(COLLECTIONS.users, uid, {
      lastLoginAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async setRole(uid: string, role: UserRole, grantedBy: string): Promise<void> {
    await this.store.update<UserRecord>(COLLECTIONS.users, uid, {
      role,
      adminGrantedBy: grantedBy,
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(uid: string): Promise<void> {
    await this.store.delete(COLLECTIONS.users, uid);
  }

  toSessionUser(record: UserRecord): SessionUser {
    return {
      uid: record.id,
      email: record.email,
      displayName: record.displayName,
      emailVerified: record.emailVerified,
      role: record.role,
      createdAt: record.createdAt,
    };
  }
}
