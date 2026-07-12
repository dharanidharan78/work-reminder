import React, { useState, useRef, useEffect } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  updateProfile,
  updatePassword,
  linkWithCredential,
  signInWithPhoneNumber,
  PhoneAuthProvider,
} from "firebase/auth";
import { auth, googleProvider, RecaptchaVerifier } from "./firebase";

/* ─────────────────────────────────────────────────────────
   Shared: turn any Firebase auth error into safe, friendly
   copy. Wrong email / wrong password / no such account are
   all collapsed into one generic "mismatch" message so we
   never reveal which part was wrong (standard security
   practice + what was asked for).
───────────────────────────────────────────────────────── */
function friendlyError(code) {
  switch (code) {
    case "auth/invalid-email":
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Username or password is incorrect.";
    case "auth/email-already-in-use":
      return "That email is already registered. Try signing in instead.";
    case "auth/weak-password":
      return "Password is too weak (min 6 characters).";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/popup-closed-by-user":
      return "Google sign-in was closed before finishing.";
    case "auth/network-request-failed":
      return "Network error — check your internet connection.";
    case "auth/invalid-phone-number":
      return "Enter a valid phone number, e.g. +919876543210.";
    case "auth/invalid-verification-code":
      return "That code isn't right. Check it and try again.";
    case "auth/code-expired":
      return "That code expired. Send a new one.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/* ─────────────────────────────────────────────────────────
   Password security: complexity rule + 5-attempt lockout.
   Complexity: min 6 chars, at least 1 number, at least 1
   special character.
   Lockout: 5 wrong attempts for the same email locks that
   email out for 1 hour. Tracked client-side in localStorage
   (keyed by email) since Firebase already rate-limits the
   backend — this is the friendlier, user-visible layer on
   top of that.
───────────────────────────────────────────────────────── */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 60 * 1000; // 1 hour
const ATTEMPTS_KEY = "wf_login_attempts";

function isStrongPassword(pw) {
  return (
    pw.length >= 6 &&
    /[0-9]/.test(pw) &&
    /[^A-Za-z0-9]/.test(pw)
  );
}

function passwordHint() {
  return "Min 6 characters, with at least 1 number and 1 special character.";
}

function readAttemptsStore() {
  try {
    return JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || "{}");
  } catch (_) {
    return {};
  }
}

function writeAttemptsStore(store) {
  try {
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(store));
  } catch (_) {}
}

// Returns { locked, remainingMs, attemptsLeft } for an email
function getLockState(email) {
  const store = readAttemptsStore();
  const rec = store[email.toLowerCase()];
  if (!rec) return { locked: false, remainingMs: 0, attemptsLeft: MAX_ATTEMPTS };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, remainingMs: rec.lockedUntil - Date.now(), attemptsLeft: 0 };
  }
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) {
    const store2 = readAttemptsStore();
    delete store2[email.toLowerCase()];
    writeAttemptsStore(store2);
    return { locked: false, remainingMs: 0, attemptsLeft: MAX_ATTEMPTS };
  }
  return { locked: false, remainingMs: 0, attemptsLeft: Math.max(0, MAX_ATTEMPTS - (rec.count || 0)) };
}

function recordFailedAttempt(email) {
  const key = email.toLowerCase();
  const store = readAttemptsStore();
  const rec = store[key] || { count: 0, lockedUntil: 0 };
  rec.count = (rec.count || 0) + 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
  }
  store[key] = rec;
  writeAttemptsStore(store);
  return getLockState(email);
}

function clearAttempts(email) {
  const store = readAttemptsStore();
  delete store[email.toLowerCase()];
  writeAttemptsStore(store);
}

function fmtRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z" />
  </svg>
);

/* ─────────────────────────────────────────────────────────
   Forgot password panel — lets the user reset either by
   emailed link, or by SMS code to a phone number that was
   previously linked to their account.
───────────────────────────────────────────────────────── */
function ForgotPassword({ onBack, prefillEmail }) {
  const [method, setMethod] = useState("email"); // 'email' | 'phone'

  // email flow
  const [email, setEmail] = useState(prefillEmail || "");
  const [emailSent, setEmailSent] = useState(false);

  // phone flow
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [code, setCode] = useState("");
  const [confirmationResult, setConfirmationResult] = useState(null);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [resetDone, setResetDone] = useState(false);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const recaptchaRef = useRef(null);
  const recaptchaContainerId = "recaptcha-container";

  useEffect(() => {
    return () => {
      if (recaptchaRef.current) {
        try { recaptchaRef.current.clear(); } catch (_) {}
      }
    };
  }, []);

  async function handleSendEmail(e) {
    e.preventDefault();
    setError("");
    if (!email.trim()) { setError("Enter your email address."); return; }
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setEmailSent(true);
    } catch (err) {
      setError(friendlyError(err.code));
    }
    setLoading(false);
  }

  async function handleSendCode(e) {
    e.preventDefault();
    setError("");
    if (!phone.trim()) { setError("Enter your phone number, e.g. +919876543210."); return; }
    setLoading(true);
    try {
      if (!recaptchaRef.current) {
        recaptchaRef.current = new RecaptchaVerifier(auth, recaptchaContainerId, {
          size: "invisible",
        });
      }
      const result = await signInWithPhoneNumber(auth, phone.trim(), recaptchaRef.current);
      setConfirmationResult(result);
      setOtpSent(true);
    } catch (err) {
      setError(friendlyError(err.code));
      if (recaptchaRef.current) {
        try { recaptchaRef.current.clear(); } catch (_) {}
        recaptchaRef.current = null;
      }
    }
    setLoading(false);
  }

  async function handleVerifyCode(e) {
    e.preventDefault();
    setError("");
    if (!code.trim()) { setError("Enter the code you received."); return; }
    setLoading(true);
    try {
      await confirmationResult.confirm(code.trim());
      // Signing in via a phone number that is linked to an existing
      // account authenticates that same account, so auth.currentUser
      // is now the account we want to reset the password for.
      setPhoneVerified(true);
    } catch (err) {
      setError(friendlyError(err.code));
    }
    setLoading(false);
  }

  async function handleSetNewPassword(e) {
    e.preventDefault();
    setError("");
    if (!isStrongPassword(newPassword)) { setError(`Password too weak. ${passwordHint()}`); return; }
    if (newPassword !== newPassword2) { setError("Passwords don't match."); return; }
    setLoading(true);
    try {
      await updatePassword(auth.currentUser, newPassword);
      clearAttempts(prefillEmail || auth.currentUser?.email || "");
      setResetDone(true);
    } catch (err) {
      setError(friendlyError(err.code));
    }
    setLoading(false);
  }

  if (resetDone) {
    return (
      <div className="auth-panel">
        <div className="auth-success-icon">✓</div>
        <h2 className="login-title">Password updated</h2>
        <p className="login-sub">You're all set — and already signed in.</p>
        <button className="btn-red auth-submit" onClick={onBack}>Continue</button>
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <button type="button" className="auth-back" onClick={onBack}>← Back to sign in</button>
      <h2 className="login-title">Reset your password</h2>
      <p className="login-sub">
        {method === "email"
          ? "We'll email you a secure link to reset your password."
          : "We'll text a verification code to a phone linked to your account."}
      </p>

      <div className="auth-method-toggle">
        <button
          type="button"
          className={"auth-tab" + (method === "email" ? " active" : "")}
          onClick={() => { setMethod("email"); setError(""); }}
        >
          Email
        </button>
        <button
          type="button"
          className={"auth-tab" + (method === "phone" ? " active" : "")}
          onClick={() => { setMethod("phone"); setError(""); }}
        >
          Mobile
        </button>
      </div>

      {method === "email" && !emailSent && (
        <form onSubmit={handleSendEmail} className="login-form">
          <input
            type="email"
            className="input-dark"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          {error && <div className="login-error">{error}</div>}
          <button className="btn-red auth-submit" type="submit" disabled={loading}>
            {loading ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}

      {method === "email" && emailSent && (
        <div className="auth-info-box">
          Check <b>{email.trim()}</b> for a link to reset your password. It may take a minute to arrive — don't forget to check spam.
        </div>
      )}

      {method === "phone" && !otpSent && (
        <form onSubmit={handleSendCode} className="login-form">
          <input
            type="tel"
            className="input-dark"
            placeholder="Phone number, e.g. +919876543210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
          {error && <div className="login-error">{error}</div>}
          <button className="btn-red auth-submit" type="submit" disabled={loading}>
            {loading ? "Sending…" : "Send code"}
          </button>
          <p className="auth-hint">
            Only works for a phone number already linked to your account.
          </p>
        </form>
      )}

      {method === "phone" && otpSent && !phoneVerified && (
        <form onSubmit={handleVerifyCode} className="login-form">
          <input
            type="text"
            inputMode="numeric"
            className="input-dark auth-otp-input"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
          />
          {error && <div className="login-error">{error}</div>}
          <button className="btn-red auth-submit" type="submit" disabled={loading}>
            {loading ? "Verifying…" : "Verify code"}
          </button>
        </form>
      )}

      {method === "phone" && phoneVerified && (
        <form onSubmit={handleSetNewPassword} className="login-form">
          <input
            type="password"
            className="input-dark"
            placeholder="New password (6+ chars, 1 number, 1 special char)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
          <input
            type="password"
            className="input-dark"
            placeholder="Confirm new password"
            value={newPassword2}
            onChange={(e) => setNewPassword2(e.target.value)}
            autoComplete="new-password"
          />
          <div className="auth-pw-hint">{passwordHint()}</div>
          {error && <div className="login-error">{error}</div>}
          <button className="btn-red auth-submit" type="submit" disabled={loading}>
            {loading ? "Saving…" : "Set new password"}
          </button>
        </form>
      )}

      <div id={recaptchaContainerId} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   Optional post-signup step: link a phone number to the new
   account (via real OTP verification) so it can later be
   used for phone-based password recovery.
───────────────────────────────────────────────────────── */
function LinkPhoneStep({ onDone }) {
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [code, setCode] = useState("");
  const [confirmationResult, setConfirmationResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const recaptchaRef = useRef(null);
  const recaptchaContainerId = "recaptcha-container-link";

  async function handleSendCode(e) {
    e.preventDefault();
    setError("");
    if (!phone.trim()) { setError("Enter a phone number, e.g. +919876543210."); return; }
    setLoading(true);
    try {
      if (!recaptchaRef.current) {
        recaptchaRef.current = new RecaptchaVerifier(auth, recaptchaContainerId, {
          size: "invisible",
        });
      }
      const result = await signInWithPhoneNumber(auth, phone.trim(), recaptchaRef.current);
      setConfirmationResult(result);
      setOtpSent(true);
    } catch (err) {
      setError(friendlyError(err.code));
    }
    setLoading(false);
  }

  async function handleVerifyAndLink(e) {
    e.preventDefault();
    setError("");
    if (!code.trim()) { setError("Enter the code you received."); return; }
    setLoading(true);
    try {
      const cred = PhoneAuthProvider.credential(confirmationResult.verificationId, code.trim());
      await linkWithCredential(auth.currentUser, cred);
      onDone();
    } catch (err) {
      setError(friendlyError(err.code));
    }
    setLoading(false);
  }

  return (
    <div className="auth-panel">
      <h2 className="login-title">Add a recovery number</h2>
      <p className="login-sub">Optional — lets you reset your password by SMS later.</p>

      {!otpSent ? (
        <form onSubmit={handleSendCode} className="login-form">
          <input
            type="tel"
            className="input-dark"
            placeholder="Phone number, e.g. +919876543210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
          {error && <div className="login-error">{error}</div>}
          <button className="btn-red auth-submit" type="submit" disabled={loading}>
            {loading ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerifyAndLink} className="login-form">
          <input
            type="text"
            inputMode="numeric"
            className="input-dark auth-otp-input"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
          />
          {error && <div className="login-error">{error}</div>}
          <button className="btn-red auth-submit" type="submit" disabled={loading}>
            {loading ? "Verifying…" : "Verify & link"}
          </button>
        </form>
      )}

      <button type="button" className="login-switch" onClick={onDone}>
        Skip for now
      </button>
      <div id={recaptchaContainerId} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   Main Login screen: Sign in / Sign up, straight-through
   Google auth, and entry into the forgot-password flow.
───────────────────────────────────────────────────────── */
export default function Login({ onBackToLanding }) {
  const [view, setView] = useState("signin"); // 'signin' | 'signup' | 'forgot' | 'linkPhone'
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [lockInfo, setLockInfo] = useState({ locked: false, remainingMs: 0, attemptsLeft: MAX_ATTEMPTS });

  // Live countdown while locked out, re-checked against the email
  // currently typed in the sign-in form.
  useEffect(() => {
    if (view !== "signin" || !email.trim()) {
      setLockInfo({ locked: false, remainingMs: 0, attemptsLeft: MAX_ATTEMPTS });
      return;
    }
    const check = () => setLockInfo(getLockState(email.trim()));
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [email, view]);

  async function handleGoogle() {
    setError("");
    setGoogleLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(friendlyError(err.code));
    }
    setGoogleLoading(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("Enter both email and password.");
      return;
    }

    if (view === "signin") {
      const lock = getLockState(email.trim());
      if (lock.locked) {
        setLockInfo(lock);
        setError(`Too many wrong attempts. Try again in ${fmtRemaining(lock.remainingMs)}.`);
        return;
      }
    }

    if (view === "signup" && !isStrongPassword(password)) {
      setError(`Password too weak. ${passwordHint()}`);
      return;
    }
    if (view === "signup" && password !== password2) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      if (view === "signin") {
        await signInWithEmailAndPassword(auth, email.trim(), password);
        clearAttempts(email.trim());
        setLockInfo({ locked: false, remainingMs: 0, attemptsLeft: MAX_ATTEMPTS });
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        if (name.trim()) {
          try { await updateProfile(cred.user, { displayName: name.trim() }); } catch (_) {}
        }
        setView("linkPhone");
      }
    } catch (err) {
      if (
        view === "signin" &&
        ["auth/wrong-password", "auth/invalid-credential", "auth/user-not-found"].includes(err.code)
      ) {
        const lock = recordFailedAttempt(email.trim());
        setLockInfo(lock);
        if (lock.locked) {
          setError(`Too many wrong attempts. Locked for 1 hour — try again in ${fmtRemaining(lock.remainingMs)}.`);
        } else {
          setError(`${friendlyError(err.code)} (${lock.attemptsLeft} attempt${lock.attemptsLeft === 1 ? "" : "s"} left)`);
        }
      } else {
        setError(friendlyError(err.code));
      }
    }
    setLoading(false);
  }

  const shell = (children) => (
    <div className="auth-shell">
      <div className="auth-hero">
        <div className="auth-hero-glow" />
        <div className="auth-hero-content">
          <div className="logo">
            <div className="logo-mark">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M4 12l4 6 4-11 4 11 4-6" stroke="#0a0e1a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <div className="logo-name">WORK FLOW</div>
              <div className="logo-sub">Task Intelligence</div>
            </div>
          </div>
          <h1 className="auth-hero-title">Your work,<br />finally in sync.</h1>
          <p className="auth-hero-text">
            One place for every task — laptop, phone, and everything in between.
          </p>
          <ul className="auth-hero-points">
            <li>Real-time sync across devices</li>
            <li>Google sign-in in one tap</li>
            <li>Bank-grade account recovery</li>
          </ul>
        </div>
      </div>
      <div className="auth-stage">
        {onBackToLanding && (
          <button type="button" className="auth-back-landing" onClick={onBackToLanding}>
            ← Back to home
          </button>
        )}
        <div className="login-card login-card-premium">{children}</div>
      </div>
    </div>
  );

  if (view === "forgot") {
    return shell(
      <ForgotPassword onBack={() => setView("signin")} prefillEmail={email} />
    );
  }

  if (view === "linkPhone") {
    return shell(
      <LinkPhoneStep onDone={() => { /* onAuthStateChanged takes it from here */ }} />
    );
  }

  return shell(
    <>
      <div className="auth-mobile-logo">
        <div className="logo-mark">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M4 12l4 6 4-11 4 11 4-6" stroke="#0a0e1a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div>
          <div className="logo-name">WORK FLOW</div>
          <div className="logo-sub">Task Intelligence</div>
        </div>
      </div>

      <h2 className="login-title">
        {view === "signin" ? "Welcome back" : "Create your account"}
      </h2>
      <p className="login-sub">
        {view === "signin"
          ? "Sign in to sync your tasks everywhere."
          : "Join to sync your tasks across laptop and phone."}
      </p>

      <button
        type="button"
        className="btn-google"
        onClick={handleGoogle}
        disabled={googleLoading}
      >
        <GoogleIcon />
        {googleLoading ? "Connecting…" : "Continue with Google"}
      </button>

      <div className="auth-divider"><span>or</span></div>

      <form onSubmit={handleSubmit} className="login-form">
        {view === "signup" && (
          <input
            type="text"
            className="input-dark"
            placeholder="Full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        )}
        <input
          type="email"
          className="input-dark"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <input
          type="password"
          className="input-dark"
          placeholder={
            view === "signup"
              ? "Password (6+ chars, 1 number, 1 special char)"
              : "Password"
          }
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={view === "signin" ? "current-password" : "new-password"}
          disabled={lockInfo.locked}
        />
        {view === "signup" && (
          <>
            <input
              type="password"
              className="input-dark"
              placeholder="Confirm password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              autoComplete="new-password"
            />
            <div className="auth-pw-hint">{passwordHint()}</div>
          </>
        )}

        {view === "signin" && (
          <button
            type="button"
            className="auth-forgot-link"
            onClick={() => setView("forgot")}
          >
            Forgot password?
          </button>
        )}

        {view === "signin" && !lockInfo.locked && lockInfo.attemptsLeft < MAX_ATTEMPTS && !error && (
          <div className="auth-attempts-warn">
            {lockInfo.attemptsLeft} attempt{lockInfo.attemptsLeft === 1 ? "" : "s"} left before this account is locked for 1 hour.
          </div>
        )}

        {view === "signin" && lockInfo.locked && (
          <div className="auth-lockout-banner">
            🔒 Locked out after {MAX_ATTEMPTS} wrong attempts. Try again in <b className="mono">{fmtRemaining(lockInfo.remainingMs)}</b>.
          </div>
        )}

        {error && <div className="login-error">{error}</div>}

        <button className="btn-red auth-submit" type="submit" disabled={loading || lockInfo.locked}>
          {loading
            ? "Please wait…"
            : lockInfo.locked
            ? "Locked"
            : view === "signin"
            ? "Sign In"
            : "Sign Up"}
        </button>
      </form>

      <button
        className="login-switch"
        onClick={() => {
          setError("");
          setView((v) => (v === "signin" ? "signup" : "signin"));
        }}
      >
        {view === "signin"
          ? "No account? Sign up"
          : "Already have an account? Sign in"}
      </button>
    </>
  );
}
