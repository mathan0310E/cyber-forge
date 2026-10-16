import { initializeApp, type FirebaseApp } from 'firebase/app';
import { GoogleAuthProvider, getAuth, onIdTokenChanged } from 'firebase/auth';
import { getAnalytics, type Analytics } from 'firebase/analytics';

/**
 * Browser-side Firebase config. These values are non-secret (Firebase keys are
 * meant to be public; security comes from the backend rules + ID token
 * verification). Whether Google sign-in / analytics is available depends on
 * these env vars being set in the web build.
 */
const apiKey = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined;
const appId = import.meta.env.VITE_FIREBASE_APP_ID as string | undefined;
const measurementId = import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined;

export const firebaseEnabled = Boolean(apiKey && authDomain && projectId && appId);

const firebaseConfig = {
  apiKey,
  authDomain,
  projectId,
  appId,
  ...(measurementId ? { measurementId } : {}),
};

let app: FirebaseApp | undefined;
let auth:
  | import('firebase/auth').Auth
  | undefined;
let analytics: Analytics | undefined;
let analyticsAttempted = false;

function ensureApp() {
  if (!app) app = initializeApp(firebaseConfig);
  return app;
}

export function getFirebaseAuth() {
  if (!firebaseEnabled) return undefined;
  if (!auth) auth = getAuth(ensureApp());
  return auth;
}

/** Firebase Analytics for the browser build. Undefined when Firebase is not configured. */
export function getFirebaseAnalytics() {
  if (!firebaseEnabled) return undefined;
  if (!analyticsAttempted) {
    analyticsAttempted = true;
    try {
      analytics = getAnalytics(ensureApp());
    } catch {
      /* Analytics unavailable in this environment; silently degrade. */
    }
  }
  return analytics;
}

export const googleProvider = new GoogleAuthProvider();

export { onIdTokenChanged };