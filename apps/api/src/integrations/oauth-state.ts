import crypto from 'node:crypto';
import type { DocStore } from '../db/store.js';

const PREFIX = 'oauthstate_';
/** How long a started OAuth flow may live before its state is unusable. */
const STATE_TTL_MS = 15 * 60 * 1000;

interface StoredState {
  uid: string;
  provider: string;
  /** The url the user should land on after the callback, origin-validated. */
  returnTo: string;
  createdAt: string;
}

/**
 * One-time, expiring, server-side OAuth state records.
 *
 * The `state` parameter handed to the provider is a random high-entropy value;
 * the only server-side bindings (who started the flow, which return path is
 * legal) live in the store and are consumed once. This prevents CSRF against
 * the callback and stops an attacker from steering a victim's callback to an
 * arbitrary location.
 */
export class OAuthStateService {
  constructor(private readonly db: DocStore) {}

  private docId(state: string): string {
    // Only ever called with values we minted, but keep the prefix scoped tight.
    return `${PREFIX}${state}`;
  }

  /** Records a new OAuth flow and returns the random state token for it. */
  async begin(uid: string, provider: string, returnTo: string): Promise<string> {
    const state = crypto.randomBytes(24).toString('hex');
    await this.db.set<StoredState>('integrations', this.docId(state), {
      uid,
      provider,
      returnTo,
      createdAt: new Date().toISOString(),
    });
    return state;
  }

  /**
   * Consumes and returns the stored state record only when it exists, is not
   * expired, and its provider matches. Any mismatch deletes the record so it
   * can never be reused. Returns null when the state is unknown or invalid.
   */
  async consume(state: string, provider: string): Promise<StoredState | null> {
    if (!/^[a-f0-9]{48}$/.test(state)) return null;
    const doc = await this.db.get<StoredState>('integrations', this.docId(state));
    if (!doc) return null;
    void this.db.delete('integrations', this.docId(state));
    const age = Date.now() - new Date(doc.createdAt).getTime();
    if (Number.isNaN(age) || age > STATE_TTL_MS || age < 0) return null;
    if (doc.provider !== provider) return null;
    return doc;
  }
}