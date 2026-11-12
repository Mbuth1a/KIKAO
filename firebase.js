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
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

// Kikao Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyArrLKAegDQ0PwwYhDqojNnZRj7LomU16Y",
  authDomain: "kikao-pwa.firebaseapp.com",
  projectId: "kikao-pwa",
  storageBucket: "kikao-pwa.firebasestorage.app",
  messagingSenderId: "196996148404",
  appId: "1:196996148404:web:fb139364541797f664fbe1",
  measurementId: "G-S6S92TN54Y"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {}, "default");

auth.languageCode = "en";

await setPersistence(auth, browserLocalPersistence);

let confirmationResult = null;
let recaptchaVerifier = null;

// Normalize Kenyan mobile numbers into E.164 format
function normalizeKenyanPhone(phone) {
  const value = String(phone).trim().replace(/[\s()-]/g, "");

  if (/^\+254[17]\d{8}$/.test(value)) return value;
  if (/^254[17]\d{8}$/.test(value)) return `+${value}`;

  if (/^0[17]\d{8}$/.test(value)) {
    return `+254${value.slice(1)}`;
  }

  throw new Error(
    "Enter a valid Kenyan mobile number, e.g. 0712345678."
  );
}

// Initialize reCAPTCHA and send OTP
async function sendPhoneOtp(phone, containerId = "recaptcha-container") {
  const phoneNumber = normalizeKenyanPhone(phone);

  if (recaptchaVerifier) {
    recaptchaVerifier.clear();
  }

  recaptchaVerifier = new RecaptchaVerifier(
    auth,
    containerId,
    { size: "normal" }
  );

  try {
    await recaptchaVerifier.render();

    confirmationResult = await signInWithPhoneNumber(
      auth,
      phoneNumber,
      recaptchaVerifier
    );

    return {
      success: true,
      message: `Verification code sent to ${phoneNumber}.`
    };
  } catch (error) {
    recaptchaVerifier.clear();
    recaptchaVerifier = null;
    confirmationResult = null;
    throw error;
  }
}

// Verify OTP and authenticate user
async function verifyPhoneOtp(code) {
  if (!confirmationResult) {
    throw new Error("Request a verification code first.");
  }

  const cleanCode = String(code).trim();

  if (!/^\d{6}$/.test(cleanCode)) {
    throw new Error("Enter the six-digit verification code.");
  }

  const credential = await confirmationResult.confirm(cleanCode);

  confirmationResult = null;

  return credential.user;
}

// Observe actual Firebase authentication state
function observeAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

// Get current authenticated user
function getCurrentUser() {
  return auth.currentUser;
}

// Sign out
async function signOutUser() {
  await signOut(auth);
}
function timestampToMillis(value) {
  return value && typeof value.toMillis === "function"
    ? value.toMillis()
    : null;
}

async function saveUserProfile(profile) {
  const user = auth.currentUser;

  if (!user || user.uid !== profile.uid) {
    throw new Error("You must be signed in to save this profile.");
  }

  const name = String(profile.name || "").trim();
  const age = Number(profile.age);
  const phone = user.phoneNumber;

  if (!name || name.length > 40) {
    throw new Error("Enter a name between 1 and 40 characters.");
  }

  if (!Number.isInteger(age) || age < 18 || age > 120) {
    throw new Error("Your age must be between 18 and 120.");
  }

  if (!phone || phone !== profile.phone) {
    throw new Error("The profile phone does not match the verified account.");
  }

  const profileRef = doc(db, "users", user.uid);
  const existingSnapshot = await getDoc(profileRef);
  const existing = existingSnapshot.exists()
    ? existingSnapshot.data()
    : null;

  await setDoc(profileRef, {
    uid: user.uid,
    name,
    phone,
    age,
    verified: true,
    verificationMethod: "firebase-phone",
    verifiedAt: existing?.verifiedAt || serverTimestamp(),
    createdAt: existing?.createdAt || serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });

  const savedSnapshot = await getDoc(profileRef);

  if (!savedSnapshot.exists()) {
    throw new Error("Could not confirm that the profile was saved.");
  }

  const saved = savedSnapshot.data();

  return {
    uid: saved.uid,
    name: saved.name,
    phone: saved.phone,
    age: saved.age,
    verified: saved.verified,
    verificationMethod: saved.verificationMethod,
    verifiedAt: timestampToMillis(saved.verifiedAt),
    createdAt: timestampToMillis(saved.createdAt),
    updatedAt: timestampToMillis(saved.updatedAt)
  };
}

async function getUserProfile(uid) {
  const user = auth.currentUser;

  if (!user || user.uid !== uid) {
    throw new Error("You can only retrieve your own profile.");
  }

  const snapshot = await getDoc(doc(db, "users", uid));

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.data();

  return {
    uid: data.uid,
    name: data.name,
    phone: data.phone,
    age: data.age,
    verified: data.verified,
    verificationMethod: data.verificationMethod,
    verifiedAt: timestampToMillis(data.verifiedAt),
    createdAt: timestampToMillis(data.createdAt),
    updatedAt: timestampToMillis(data.updatedAt)
  };
}

export {
  app,
  auth,
  db,
  sendPhoneOtp,
  verifyPhoneOtp,
  observeAuthState,
  getCurrentUser,
  signOutUser,
  saveUserProfile,
  getUserProfile
};

console.info("Kikao Firebase initialized:", app.options.projectId);