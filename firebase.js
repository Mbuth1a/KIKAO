import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  FacebookAuthProvider,
  linkWithPopup
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyArrLKAegDQ0PwwYhDqojNnZRj7LomU16Y",
  authDomain: "kikao-pwa.firebaseapp.com",
  projectId: "kikao-pwa",
  storageBucket: "kikao-pwa.firebasestorage.app",
  messagingSenderId: "196996148404",
  appId: "1:196996148404:web:fb139364541797f664fbe1",
  measurementId: "G-S6S92TN54Y"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {}, "default");

auth.languageCode = "en";

await setPersistence(auth, browserLocalPersistence);

/**
 * Sign in with Google. Uses a popup so it works on desktop and mobile PWA.
 * On returning users this resolves immediately; on new users it creates
 * the Firebase Auth record with a UID but no Firestore profile doc yet.
 */
async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  // Force account selection so users can pick the right account on shared devices
  provider.setCustomParameters({ prompt: "select_account" });

  const result = await signInWithPopup(auth, provider);
  return result.user;
}

function observeAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

function getCurrentUser() {
  return auth.currentUser;
}

async function signOutUser() {
  await signOut(auth);
}

function timestampToMillis(value) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : null;
}

/**
 * Persist the user's Kikao profile.
 *
 * The profile is keyed to the Firebase Auth UID. With Google sign-in,
 * `user.phoneNumber` is null, so we no longer store a phone or require
 * it to match the auth token. The user's email is available at
 * `user.email` and is stored on the profile.
 */
async function saveUserProfile(profile) {
  const user = auth.currentUser;
  if (!user || user.uid !== profile.uid) {
    throw new Error("You must be signed in to save this profile.");
  }

  const name = String(profile.name || "").trim();
  const age = Number(profile.age);

  if (!name || name.length > 40) {
    throw new Error("Enter a name between 1 and 40 characters.");
  }
  if (!Number.isInteger(age) || age < 18 || age > 120) {
    throw new Error("Your age must be between 18 and 120.");
  }

  const gender = ["woman","man","nonbinary","prefer_not_to_say"].includes(profile.gender)
    ? profile.gender
    : "prefer_not_to_say";

  const profileRef = doc(db, "users", user.uid);
  const existingSnapshot = await getDoc(profileRef);
  const existing = existingSnapshot.exists() ? existingSnapshot.data() : null;

  const payload = {
    uid: user.uid,
    name,
    email: user.email || existing?.email || null,
    age,
    gender,
    verified: true,
    verificationMethod: "google",
    verifiedAt: existing?.verifiedAt || serverTimestamp(),
    createdAt: existing?.createdAt || serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  // Terms acceptance — only written when the caller explicitly provides a version.
  // Existing acceptances are preserved if the caller doesn't pass one.
  if (profile.termsVersion) {
    payload.termsVersion = profile.termsVersion;
    payload.termsAcceptedAt = serverTimestamp();
  }

  // Preserve any previously-linked social descriptors
  if (profile.facebook) payload.facebook = profile.facebook;
  if (profile.instagram) payload.instagram = profile.instagram;

  await setDoc(profileRef, payload, { merge: true });

  const savedSnapshot = await getDoc(profileRef);
  if (!savedSnapshot.exists()) {
    throw new Error("Could not confirm that the profile was saved.");
  }
  const saved = savedSnapshot.data();

  return {
    uid: saved.uid,
    name: saved.name,
    email: saved.email || null,
    age: saved.age,
    gender: saved.gender,
    verified: saved.verified,
    verificationMethod: saved.verificationMethod,
    verifiedAt: timestampToMillis(saved.verifiedAt),
    createdAt: timestampToMillis(saved.createdAt),
    updatedAt: timestampToMillis(saved.updatedAt),
    termsVersion: saved.termsVersion || null,
    termsAcceptedAt: timestampToMillis(saved.termsAcceptedAt),
    facebook: saved.facebook || null,
    instagram: saved.instagram || null
  };
}

async function getUserProfile(uid) {
  const user = auth.currentUser;
  if (!user || user.uid !== uid) {
    throw new Error("You can only retrieve your own profile.");
  }
  const snapshot = await getDoc(doc(db, "users", uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return {
    uid: data.uid,
    name: data.name,
    email: data.email || null,
    age: data.age,
    gender: data.gender || "prefer_not_to_say",
    verified: data.verified,
    verificationMethod: data.verificationMethod,
    verifiedAt: timestampToMillis(data.verifiedAt),
    createdAt: timestampToMillis(data.createdAt),
    updatedAt: timestampToMillis(data.updatedAt),
    termsVersion: data.termsVersion || null,
    termsAcceptedAt: timestampToMillis(data.termsAcceptedAt),
    facebook: data.facebook || null,
    instagram: data.instagram || null
  };
}


async function profileExistsForUser(user) {
  if (!user) return false;
  const snap = await getDoc(doc(db, "users", user.uid));
  return snap.exists();
}

/**
 * Facebook linking. Returns the descriptor to merge into the profile.
 * Requires the Facebook provider to be enabled in the Firebase Console
 * and the app domain to be authorized.
 */
async function linkFacebookAccount() {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in first.");

  const provider = new FacebookAuthProvider();
  provider.addScope("public_profile");

  try {
    const result = await linkWithPopup(user, provider);
    const fb = result.user.providerData.find(p => p.providerId === "facebook.com");
    return {
      linked: true,
      id: fb?.uid || null,
      name: result.user.displayName || fb?.displayName || null,
      linkedAt: Date.now()
    };
  } catch (error) {
    if (error?.code === "auth/provider-already-linked") {
      const fb = user.providerData.find(p => p.providerId === "facebook.com");
      return {
        linked: true,
        id: fb?.uid || null,
        name: fb?.displayName || null,
        linkedAt: Date.now()
      };
    }
    throw error;
  }
}

export {
  app,
  auth,
  db,
  signInWithGoogle,
  observeAuthState,
  getCurrentUser,
  signOutUser,
  saveUserProfile,
  getUserProfile,
  linkFacebookAccount,
  profileExistsForUser
};

console.info("Kikao Firebase initialized:", app.options.projectId);