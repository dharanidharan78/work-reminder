import React, { useState } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "./firebase";

export default function Login() {
  const [mode, setMode] = useState("signin"); // 'signin' | 'signup'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("Enter both email and password.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setLoading(true);
    try {
      if (mode === "signin") {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (err) {
      setError(friendlyError(err.code));
    }
    setLoading(false);
  }

  function friendlyError(code) {
    switch (code) {
      case "auth/invalid-email":
        return "That email address looks invalid.";
      case "auth/user-not-found":
        return "No account with that email. Try Sign Up instead.";
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "Wrong password. Try again.";
      case "auth/email-already-in-use":
        return "That email is already registered. Try Sign In instead.";
      case "auth/weak-password":
        return "Password is too weak (min 6 characters).";
      case "auth/network-request-failed":
        return "Network error — check your internet connection.";
      default:
        return "Something went wrong. Try again.";
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="logo" style={{ justifyContent: "center", marginBottom: 24 }}>
          <div className="logo-diamond" />
          <div>
            <div className="logo-name">WORK FLOW</div>
            <div className="logo-sub">Task Intelligence</div>
          </div>
        </div>

        <h2 className="login-title">
          {mode === "signin" ? "Sign in" : "Create account"}
        </h2>
        <p className="login-sub">
          Sync your tasks across laptop and phone.
        </p>

        <form onSubmit={handleSubmit} className="login-form">
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
            placeholder="Password (min 6 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />

          {error && <div className="login-error">{error}</div>}

          <button className="btn-red" type="submit" disabled={loading}>
            {loading
              ? "Please wait..."
              : mode === "signin"
              ? "Sign In"
              : "Sign Up"}
          </button>
        </form>

        <button
          className="login-switch"
          onClick={() =>
            setMode((m) => (m === "signin" ? "signup" : "signin"))
          }
        >
          {mode === "signin"
            ? "No account? Sign up"
            : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
