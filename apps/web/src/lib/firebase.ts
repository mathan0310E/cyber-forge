import { initializeApp } from 'firebase/app';
import { GoogleAuthProvider, getAuth, onIdTokenChanged } from 'firebase/auth';

/**
 * Browser-side Firebase config. These values are non-secret (Firebase keys are
 * meant to be public; security comes from the backend rules + ID token
 * verification). Whether Google sign-in is available depends on these env vars
 * being set in the web build.
 */
const apiKey = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined;
const appId = import.meta.env.VITE_FIREBASE_APP_ID as string | undefined;

export const firebaseEnabled = Boolean(apiKey && authDomain && projectId && appId);

let auth:
  | import('firebase/auth').Auth
  | undefined;

export function getFirebaseAuth() {
  if (!firebaseEnabled) return undefined;
  if (!auth) {
    const app = initializeApp({
      apiKey,
      authDomain,
      projectId,
      appId,
    });
    auth = getAuth(app);
  }
  return auth;
}

export const googleProvider = new GoogleAuthProvider();

export { onIdTokenChanged };