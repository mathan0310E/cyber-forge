import path from 'node:path';
import type { Config } from '../config/env.js';
import { logger } from '../services/logger.js';
import { LocalDocStore } from './local-store.js';
import { FirestoreDocStore } from './firestore-store.js';
import type { DocStore } from './store.js';

export interface StoreInitResult {
  store: DocStore;
  /** Explanation surfaced in /health and the UI when Firebase is not in use. */
  note: string;
}

let singleton: DocStore | undefined;

export async function initStore(config: Config): Promise<StoreInitResult> {
  if (singleton) return { store: singleton, note: 'already initialised' };

  const wantFirestore = config.env.WOLF_FORGE_DATA_DRIVER === 'firestore';
  const mayFirestore =
    config.env.WOLF_FORGE_DATA_DRIVER !== 'local' && config.firebase.configured;

  if (wantFirestore && !config.firebase.configured) {
    throw new Error(
      'WOLF_FORGE_DATA_DRIVER=firestore but Firebase Admin credentials are missing. ' +
        'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, or ' +
        'GOOGLE_APPLICATION_CREDENTIALS, or switch to WOLF_FORGE_DATA_DRIVER=local.',
    );
  }

  if (mayFirestore) {
    const { getFirestore } = await import('firebase-admin/firestore');
    const { getApps, initializeApp, cert, applicationDefault } = await import('firebase-admin/app');

    if (getApps().length === 0) {
      const credential =
        config.env.FIREBASE_PROJECT_ID &&
        config.env.FIREBASE_CLIENT_EMAIL &&
        config.env.FIREBASE_PRIVATE_KEY
          ? cert({
              projectId: config.env.FIREBASE_PROJECT_ID,
              clientEmail: config.env.FIREBASE_CLIENT_EMAIL,
              // Support keys pasted with literal \n escapes.
              privateKey: config.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            })
          : applicationDefault();
      initializeApp({
        credential,
        ...(config.env.FIREBASE_PROJECT_ID ? { projectId: config.env.FIREBASE_PROJECT_ID } : {}),
      });
    }

    const db = getFirestore();
    singleton = new FirestoreDocStore(db);
    logger().info({ driver: 'firestore' }, 'persistence ready');
    return { store: singleton, note: 'Firestore' };
  }

  const dataDir = path.resolve(config.env.ARTIFACT_STORAGE_PATH, '..', '.data');
  const local = new LocalDocStore(dataDir);
  await local.init();
  singleton = local;
  const note =
    'Local filesystem store (development driver). Data is not shared between machines ' +
    'and is not suitable for multi-instance deployments.';
  logger().warn({ driver: 'local', dataDir }, 'persistence ready — development driver');
  return { store: local, note };
}

export function getStore(): DocStore {
  if (!singleton) throw new Error('Store accessed before initStore() completed');
  return singleton;
}

/** Test helper. */
export function setStoreForTesting(store: DocStore): void {
  singleton = store;
}
