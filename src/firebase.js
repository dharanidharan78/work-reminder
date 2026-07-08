// ─── FIREBASE CONFIG & INIT ───────────────────────────────
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  RecaptchaVerifier,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getMessaging, isSupported } from "firebase/messaging";

const firebaseConfig = {
  apiKey: "AIzaSyBCXvKsURDwdds9Z3viJ-9qTcFhk0ypdOs",
  authDomain: "workflow-fb565.firebaseapp.com",
  projectId: "workflow-fb565",
  storageBucket: "workflow-fb565.firebasestorage.app",
  messagingSenderId: "880448325204",
  appId: "1:880448325204:web:e66e6c19c85f223a108fc1",
  measurementId: "G-RCFWSFCN8B",
};

export const VAPID_KEY =
  "BEEA5JuHka2w1kDPOVfqfHVPndj-K7h3vhWlOAn-J0tKxa7bPASu7VWCjEPl4MfzR--6LOa8KQXBTK6GI652RHU";

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// Google sign-in provider (used for one-click "Continue with Google")
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// Exposed so Login.jsx can build an invisible reCAPTCHA for phone OTP
export { RecaptchaVerifier };

// Messaging only works in supported browsers (not all mobile browsers
// support it, and it needs a secure context — https or localhost)
export let messagingPromise = isSupported().then((ok) =>
  ok ? getMessaging(app) : null
);

export default app;
