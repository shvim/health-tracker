import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut
} from "firebase/auth";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(Boolean);

const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app, import.meta.env.VITE_FIRESTORE_DATABASE_ID || "(default)") : null;
const googleProvider = new GoogleAuthProvider();
const GOOGLE_LOCK_KEY = "health-tracker-google-session";

let userPromise;
const authListeners = new Set();
const persistenceReady = auth
  ? setPersistence(auth, browserLocalPersistence).catch(() => {})
  : Promise.resolve();
const authReady = auth
  ? persistenceReady.then(() => {
      if (typeof auth.authStateReady === "function") return auth.authStateReady();
      return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(auth, () => {
          unsubscribe();
          resolve();
        });
      });
    })
  : Promise.resolve();

function emitAuth(user) {
  authListeners.forEach((listener) => listener(formatUser(user)));
}

function formatUser(user) {
  if (!user) return { ready: true, signedIn: false, isAnonymous: false, label: "Not signed in" };
  return {
    ready: true,
    signedIn: true,
    isAnonymous: user.isAnonymous,
    label: user.displayName || user.email || "Google"
  };
}

async function getUser() {
  if (!auth) return null;
  await authReady;
  if (!userPromise) {
    userPromise = Promise.resolve(auth.currentUser || null);
  }
  userPromise.then(emitAuth);
  return userPromise;
}

export function subscribeAuth(listener) {
  authListeners.add(listener);
  listener({ ready: false, signedIn: false, isAnonymous: false, label: "Checking sign-in" });
  if (!auth) return () => authListeners.delete(listener);

  const unsubscribe = onAuthStateChanged(auth, (user) => {
    emitAuth(user);
  });

  return () => {
    authListeners.delete(listener);
    unsubscribe();
  };
}

async function readUserEntries(user, storageKey) {
  if (!db || !user) return [];
  const snapshot = await getDoc(doc(db, "users", user.uid, "healthTracker", storageKey));
  return snapshot.exists() ? snapshot.data().entries || [] : [];
}

async function writeUserEntries(user, storageKey, entries) {
  if (!db || !user) return;
  await setDoc(doc(db, "users", user.uid, "healthTracker", storageKey), {
    uid: user.uid,
    entries,
    updatedAt: serverTimestamp()
  });
}

export async function signInWithGoogle(storageKey) {
  if (!auth || !db) return { user: null, entries: [] };
  await persistenceReady;
  try {
    const credential = await signInWithPopup(auth, googleProvider);
    localStorage.setItem(GOOGLE_LOCK_KEY, "true");
    userPromise = Promise.resolve(credential.user);
    emitAuth(credential.user);
    const entries = await readUserEntries(credential.user, storageKey);
    localStorage.setItem(storageKey, JSON.stringify(entries));
    return { user: credential.user, entries };
  } catch (error) {
    if (error.code === "auth/popup-closed-by-user" || error.code === "auth/cancelled-popup-request") {
      return { user: null, entries: [] };
    }
    throw error;
  }
}

export async function signOutGoogle() {
  if (!auth) return;
  await signOut(auth);
  localStorage.removeItem(GOOGLE_LOCK_KEY);
  localStorage.removeItem("health-tracker-v3");
  userPromise = null;
  emitAuth(null);
}

export async function loadEntries(storageKey) {
  const localValue = localStorage.getItem(storageKey);
  if (!db) return localValue ? JSON.parse(localValue) : [];

  const user = await getUser();
  if (!user) return localStorage.getItem(GOOGLE_LOCK_KEY) ? [] : (localValue ? JSON.parse(localValue) : []);
  const cloudEntries = await readUserEntries(user, storageKey);
  localStorage.setItem(storageKey, JSON.stringify(cloudEntries));
  return cloudEntries;
}

export async function saveEntries(storageKey, entries) {
  localStorage.setItem(storageKey, JSON.stringify(entries));
  if (!db) return;

  const user = await getUser();
  if (!user) return;
  localStorage.setItem(GOOGLE_LOCK_KEY, "true");
  await writeUserEntries(user, storageKey, entries);
}
