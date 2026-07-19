import React, { useState, useEffect, useRef, useCallback, Component } from "react";
import "./App.css";
import { auth, db, messagingPromise, VAPID_KEY } from "./firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  writeBatch,
} from "firebase/firestore";
import { getToken, onMessage } from "firebase/messaging";
import Login from "./Login";
import LandingPage from "./LandingPage";

// ─── ICONS (upload / spinner) ──────────────────────────────
const UploadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 16V4M12 4L7 9M12 4l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const SpinnerIcon = () => (
  <svg className="icon-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.2"/>
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

// ─── GOOGLE CALENDAR INTEGRATION ───────────────────────────
// Client-only OAuth via Google Identity Services (no backend / no client
// secret needed). Access tokens live only in memory for this tab — never
// written to Firestore. Only the *connection status* (connected email +
// auto-sync preference) is persisted, in users/{uid}/meta/googleCalendar.
const GOOGLE_CLIENT_ID = "355949282033-grpk6dcacusitk75b7iosc09r1agpmlf.apps.googleusercontent.com";
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email";
const GCAL_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

let _gisScriptPromise = null;
function loadGoogleIdentityScript() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (_gisScriptPromise) return _gisScriptPromise;
  _gisScriptPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById("gis-client-script");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Couldn't reach Google — check connection")));
      return;
    }
    const script = document.createElement("script");
    script.id = "gis-client-script";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Couldn't reach Google — check connection"));
    document.head.appendChild(script);
  });
  return _gisScriptPromise;
}

// Builds a Google Calendar event body from a WORK FLOW task. Only tasks
// with a due date go to Calendar (undated tasks have nothing to schedule).
// Repeating (daily/weekly) tasks are skipped for now — a single Calendar
// event can't represent a recurring checklist item cleanly.
function gcalEventBodyFromTask(task) {
  if (!task.dueDate || task.repeat !== "none") return null;
  const prefix = task.done ? "✅ " : task.priority === "high" ? "🔴 " : task.priority === "medium" ? "🟠 " : "🟢 ";
  const summary = prefix + task.title;
  const description = "WORK FLOW task • Priority: " + task.priority;
  if (task.dueTime) {
    const start = new Date(`${task.dueDate}T${task.dueTime}:00`);
    if (isNaN(start.getTime())) return null;
    const end = new Date(start.getTime() + 30 * 60000);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
    return {
      summary, description,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end:   { dateTime: end.toISOString(), timeZone: tz },
    };
  }
  const nd = new Date(task.dueDate + "T00:00:00");
  nd.setDate(nd.getDate() + 1);
  const endDate = nd.getFullYear() + "-" + String(nd.getMonth() + 1).padStart(2, "0") + "-" + String(nd.getDate()).padStart(2, "0");
  return {
    summary, description,
    start: { date: task.dueDate },
    end:   { date: endDate },
  };
}

async function gcalFetch(token, url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

// ─── LOCAL FALLBACK (used only for the "notified" set, which is
// purely a local de-dupe flag and doesn't need to sync) ───────
const NOTIFIED_KEY = "workflow-notified-v1";
const DAY_KEY      = "workflow-day-v1";

function loadLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : (fallback !== undefined ? fallback : null);
  } catch { return fallback !== undefined ? fallback : null; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
// ─── REPEAT / SCHEDULE HELPERS ─────────────────────────────
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getTodayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// Returns YYYY-MM-DD for "today + n days"
function addDaysStr(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// Returns YYYY-MM-DD for "given base date (YYYY-MM-DD) + n days" —
// used by the Roadmap feature to lay out day 1..N from a chosen start date.
function addDaysFromDate(dateStr, n) {
  const parts = (dateStr || getTodayStr()).split("-");
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// A task is "done" for today's purposes: for repeating tasks this
// looks at whether today's date is in completedDates; for one-time
// tasks it's just the plain done flag (kept for backward compat).
function isDoneToday(t) {
  if (!t) return false;
  if (t.repeat === "daily" || t.repeat === "weekly") {
    return (t.completedDates || []).includes(getTodayStr());
  }
  return !!t.done;
}

// Whether a repeating task is scheduled to appear today at all.
// One-time and daily tasks are always relevant; weekly tasks only
// on their chosen weekdays.
function isRelevantToday(t) {
  if (!t) return false;
  if (t.repeat === "weekly") {
    const day = new Date().getDay(); // 0=Sun..6=Sat
    return (t.repeatDays || []).includes(day);
  }
  return true;
}

function repeatLabel(t) {
  if (!t) return "";
  if (t.repeat === "daily") return "🔁 Daily";
  if (t.repeat === "weekly" && (t.repeatDays || []).length > 0) {
    return "🔁 " + t.repeatDays.slice().sort((a, b) => a - b).map(i => WEEKDAYS[i]).join(",");
  }
  return "";
}

function isOverdue(t) {
  if (!t || !t.dueTime || isDoneToday(t)) return false;
  const parts = t.dueTime.split(":");
  if (parts.length < 2) return false;
  const due = new Date();
  if (t.repeat === "none" && t.dueDate) {
    const [y, m, d] = t.dueDate.split("-");
    due.setFullYear(parseInt(y,10), parseInt(m,10)-1, parseInt(d,10));
  }
  due.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
  return new Date() > due;
}

// ─── SAFE HTML RENDERER (XSS fix) ─────────────────────────
function SafeMessage({ text }) {
  // Only allow <br> tags — strip everything else
  const lines = text.split("\n");
  return (
    <span>
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {line}
          {i < lines.length - 1 && <br />}
        </React.Fragment>
      ))}
    </span>
  );
}

// ─── ICONS ────────────────────────────────────────────────
const ICONS = {
  tasks: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  ai:    "M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z",
  attach:"M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3.5 3.5 0 014.95 4.95l-9.2 9.19a1.5 1.5 0 01-2.12-2.12l8.49-8.48",
  bell:  "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9",
  stats: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  roadmap: "M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7",
  add:   "M12 4v16m8-8H4",
  check: "M5 13l4 4L19 7",
  close: "M6 18L18 6M6 6l12 12",
  user:  "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14c-4.418 0-8 2.239-8 5v1h16v-1c0-2.761-3.582-5-8-5z",
  gear:  "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z",
  edit:  "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  mail:  "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
  clock: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  logout:"M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1",
  summary:"M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  speaker:"M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z",
  pause:"M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z",
  play:"M14.752 11.168l-6.518-3.759A1 1 0 007 8.276v7.448a1 1 0 001.234.972l.5-.14M14.752 11.168l-6.518 3.759M14.752 11.168L21 7.5v9L14.752 11.168zM9 20a9 9 0 100-18 9 9 0 000 18z",
  stop:"M9 9h6v6H9V9zm-6 3a9 9 0 1118 0 9 9 0 01-18 0z",
  dashboard:"M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm0 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zm0 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z",
  message:"M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
  calendar:"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
  lock:"M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 10-8 0v2h8z",
  note:"M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  folder:"M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z",
  pdf:"M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zm7 0v5h5",
  chevronLeft:"M15 19l-7-7 7-7",
  camera:"M4 8a2 2 0 012-2h1.5l1-1.5h7l1 1.5H18a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V8zM12 17a4 4 0 100-8 4 4 0 000 8z",
  sun:"M12 3v2m0 14v2m9-9h-2M5 12H3m14.95 6.95l-1.414-1.414M6.464 6.464L5.05 5.05m13.9 0l-1.414 1.414M6.464 17.536l-1.414 1.414M12 17a5 5 0 100-10 5 5 0 000 10z",
  moon:"M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z",
  menu:"M4 6h16M4 12h16M4 18h16",
};

const APP_VERSION = "12.6.0";

// ─── LEARNING RESOURCE PLATFORMS (Roadmap → Resources) ─────
// Real, always-valid search-results links — never AI-guessed URLs,
// so nothing ever 404s. The AI only picks the topic keywords;
// this map turns each keyword into working links, at zero extra
// token cost per platform.
const RESOURCE_PLATFORMS = [
  { key:"youtube",      label:"YouTube",      emoji:"🎥", price:"Free",         priceClass:"free",
    url: (q) => "https://www.youtube.com/results?search_query=" + encodeURIComponent(q + " tutorial") },
  { key:"freecodecamp", label:"freeCodeCamp", emoji:"🆓", price:"Free",         priceClass:"free",
    url: (q) => "https://www.freecodecamp.org/news/search/?query=" + encodeURIComponent(q) },
  { key:"coursera",     label:"Coursera",     emoji:"🎓", price:"Free–Paid",    priceClass:"mid",
    url: (q) => "https://www.coursera.org/search?query=" + encodeURIComponent(q) },
  { key:"udemy",        label:"Udemy",        emoji:"💰", price:"Paid (budget)",priceClass:"paid",
    url: (q) => "https://www.udemy.com/courses/search/?q=" + encodeURIComponent(q) },
];

function buildResourceLinks(topic) {
  return RESOURCE_PLATFORMS.map(p => ({
    key: p.key, label: p.label, emoji: p.emoji, price: p.price, priceClass: p.priceClass,
    url: p.url(topic),
  }));
}

function Icon({ d, size }) {
  return (
    <svg width={size || 20} height={size || 20} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

// ─── ERROR BOUNDARY ───────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight:"100vh", background:"#000", color:"#fff",
          display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center",
          fontFamily:"monospace", padding:"20px", textAlign:"center"
        }}>
          <div style={{ color:"#ef233c", fontSize:32, marginBottom:16 }}>⚠</div>
          <div style={{ color:"#ef233c", fontSize:16, marginBottom:8 }}>App crashed</div>
          <div style={{ color:"#555", fontSize:12, marginBottom:24, maxWidth:360 }}>
            {this.state.error && this.state.error.message}
          </div>
          <button onClick={() => window.location.reload()}
            style={{ background:"#ef233c", color:"#fff", border:"none",
              borderRadius:8, padding:"10px 24px", cursor:"pointer", fontSize:14 }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════
// SUB-COMPONENTS — all defined OUTSIDE App()
// ═══════════════════════════════════════════════

const TaskItem = ({ t, onToggle, onDelete }) => {
  const over = isOverdue(t);
  const doneToday = isDoneToday(t);
  const rLabel = repeatLabel(t);
  const relevant = isRelevantToday(t);
  return (
    <div className={"task-item" + (doneToday ? " done" : "") + (!relevant ? " not-today" : "")}>
      <div className={"check-box" + (doneToday ? " checked" : "")}
        onClick={() => onToggle(t.id)}>
        {doneToday && <Icon d={ICONS.check} size={12} />}
      </div>
      <div className="task-body">
        <div className="task-title">{t.title}</div>
        <div className="task-meta">
          <span className={"badge badge-" + t.priority}>
            {t.priority === "high" ? "HIGH" : t.priority === "medium" ? "MED" : "LOW"}
          </span>
          {rLabel && <span className="repeat-badge">{rLabel}</span>}
          {t.dueDate && t.repeat === "none" && (
            <span className="date-badge">
              📅 {t.dueDate}
            </span>
          )}
          {t.dueTime && (
            <span className={"time-badge" + (over ? " time-overdue" : "")}>
              ⏰ {t.dueTime}
            </span>
          )}
          {over && !doneToday && <span className="badge badge-overdue">OVERDUE</span>}
          {!relevant && <span className="badge badge-not-today">NOT TODAY</span>}
        </div>
      </div>
      <button className="del-btn" onClick={() => onDelete(t.id)}>
        <Icon d={ICONS.close} size={16} />
      </button>
    </div>
  );
};

const TaskList = ({ filtered, onToggle, onDelete }) => (
  <div className="task-list">
    {filtered.length === 0
      ? <div className="task-empty">No tasks — add one! 🔴</div>
      : filtered.map(t => (
          <TaskItem key={t.id} t={t} onToggle={onToggle} onDelete={onDelete} />
        ))
    }
  </div>
);

const FilterTabs = ({ tab, setTab }) => (
  <div className="filter-tabs">
    {[["all","All"],["today","📅 Today"],["pending","Pending"],["done","Done"],["high","🔴 High"]].map(([key, label]) => (
      <button key={key}
        className={"ftab" + (tab === key ? " active" : "")}
        onClick={() => setTab(key)}>
        {label}
      </button>
    ))}
  </div>
);

const AddForm = ({ taskInput, setTaskInput, priority, setPriority,
                   dueDate, setDueDate, dueTime, setDueTime,
                   repeat, setRepeat, repeatDays, setRepeatDays,
                   onAdd, pct, done, total, inputRef }) => (
  <div className="add-form">
    <input
      ref={inputRef || null}
      className="input-dark"
      placeholder="Type your task... (Enter to add)"
      value={taskInput}
      onChange={e => setTaskInput(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter") onAdd(); }}
      autoComplete="off"
    />
    <div className="add-form-row2">
      <select className="input-dark sel" value={priority}
        onChange={e => setPriority(e.target.value)}>
        <option value="high">🔴 High</option>
        <option value="medium">🟡 Medium</option>
        <option value="low">🟢 Low</option>
      </select>
      <select className="input-dark sel" value={repeat}
        onChange={e => setRepeat(e.target.value)}>
        <option value="none">One-time</option>
        <option value="daily">Every day</option>
        <option value="weekly">Custom days</option>
      </select>
      {repeat === "none" && (
        <input type="date" className="input-dark sel date-inp" value={dueDate}
          onChange={e => setDueDate(e.target.value)} />
      )}
      <input type="time" className="input-dark sel" value={dueTime}
        onChange={e => setDueTime(e.target.value)} />
      <button className="btn-red" onClick={onAdd}>Add</button>
    </div>
    {repeat === "weekly" && (
      <div className="weekday-picker">
        {WEEKDAYS.map((d, i) => (
          <button
            key={i}
            type="button"
            className={"weekday-chip" + (repeatDays.includes(i) ? " active" : "")}
            onClick={() => setRepeatDays(prev =>
              prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i].sort((a,b) => a-b)
            )}
          >
            {d}
          </button>
        ))}
      </div>
    )}
    <div className="progress-row" style={{ marginTop:"10px" }}>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: pct + "%" }} />
      </div>
      <span className="progress-text">{done}/{total} done</span>
    </div>
  </div>
);

// ─── CHAT PANEL ─────────────────────────────────────────────
// Unified Claude-style chat: ask AI questions, or tap the (+) button
// to open a small menu with the two file-driven actions — "Summarize
// a document" (posts a bullet summary into the thread) and "Auto-add
// tasks from file" (extracts tasks straight to your list). Same
// input, same history, one entry point — replaces the old separate
// paperclip-attach button and the standalone upload icon.
const ChatPanel = ({ aiMessages, aiLoading, aiInput, setAiInput, onAsk, chatRef,
                     onImportFile, importing, fileInputRef,
                     onAttachFile, attaching, attachProgress, attachFileInputRef,
                     speakingId, speechPaused, onSpeak, onTogglePause, onStop }) => {
  const [plusOpen, setPlusOpen] = useState(false);
  const plusWrapRef = useRef(null);
  const busy = attaching || importing;

  useEffect(() => {
    if (!plusOpen) return;
    const onDocClick = (e) => {
      if (plusWrapRef.current && !plusWrapRef.current.contains(e.target)) setPlusOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [plusOpen]);

  return (
  <div className="card-red">
    <div className="panel-label red">
      <div className="panel-dot" />Chat
    </div>
    <div className="ai-chat" ref={chatRef}>
      {aiMessages.map((m, i) => {
        if (m.type === "file") {
          return (
            <div key={i} className="user-bubble chat-file-chip">
              <Icon d={FILE_ICON_BY_EXT(m.fileName)} size={14} />
              <span>{m.fileName}</span>
            </div>
          );
        }
        if (m.type === "summary") {
          const isSpeakingThis = speakingId === m.summaryId;
          return (
            <div key={i} className="ai-bubble chat-summary-bubble">
              <div className="chat-summary-title">{m.title}</div>
              <div className="roadmap-item-sub" style={{ margin:"2px 0 8px" }}>
                {m.sourceFileName} · {m.bullets.length} points
                {m.truncated ? " · long file, summarized from the first part" : ""}
              </div>
              <ul className="sum-bullets">
                {m.bullets.map((b, bi) => (
                  <li key={bi} className={"sum-bullet" + (isSpeakingThis ? " speaking" : "")}>{b}</li>
                ))}
              </ul>
              <div className="sum-voice-row">
                {!isSpeakingThis ? (
                  <button className="qp-btn sum-voice-btn" onClick={() => onSpeak({ id:m.summaryId, title:m.title, bullets:m.bullets })}>
                    <Icon d={ICONS.speaker} size={14} /> Read aloud
                  </button>
                ) : (
                  <>
                    <button className="qp-btn sum-voice-btn" onClick={onTogglePause}>
                      <Icon d={speechPaused ? ICONS.play : ICONS.pause} size={14} />
                      {speechPaused ? " Resume" : " Pause"}
                    </button>
                    <button className="qp-btn sum-voice-btn" onClick={onStop}>
                      <Icon d={ICONS.stop} size={14} /> Stop
                    </button>
                  </>
                )}
              </div>
              <div className="sum-verify-note">
                ⚠️ AI-generated summary — double-check against the original file for anything critical.
              </div>
            </div>
          );
        }
        return (
          <div key={i} className={m.role === "ai" ? "ai-bubble" : "user-bubble"}>
            <SafeMessage text={m.text} />
          </div>
        );
      })}
      {(aiLoading || importing || attaching) && (
        <div className="ai-bubble">
          <span className="dot1" /><span className="dot2" /><span className="dot3" />
          {attaching && attachProgress && <span className="chat-loading-label">{attachProgress}</span>}
          {importing && <span className="chat-loading-label">Reading file &amp; adding tasks…</span>}
        </div>
      )}
    </div>
    <div className="ai-input-row">
      <input
        type="file"
        ref={attachFileInputRef}
        accept=".txt,.md,.csv,.json,.xlsx,.xls,.pdf,.docx"
        style={{ display: "none" }}
        onChange={e => {
          const file = e.target.files && e.target.files[0];
          if (file) onAttachFile(file);
          e.target.value = "";
        }}
      />
      <input
        type="file"
        ref={fileInputRef}
        accept=".txt,.md,.csv,.json,.xlsx,.xls,.pdf,.docx"
        style={{ display: "none" }}
        onChange={e => {
          const file = e.target.files && e.target.files[0];
          if (file) onImportFile(file);
          e.target.value = "";
        }}
      />
      <div className="chat-plus-wrap" ref={plusWrapRef}>
        <button
          className={"chat-plus-btn" + (plusOpen ? " is-open" : "")}
          title={busy ? (attachProgress || "Working…") : "Add a document"}
          aria-label="Add"
          aria-expanded={plusOpen}
          disabled={busy}
          onClick={() => setPlusOpen(o => !o)}
        >
          {busy ? <SpinnerIcon /> : <Icon d={ICONS.add} size={18} />}
        </button>
        {plusOpen && (
          <div className="chat-plus-menu" role="menu">
            <button
              className="chat-plus-menu-item"
              role="menuitem"
              onClick={() => { setPlusOpen(false); attachFileInputRef.current && attachFileInputRef.current.click(); }}
            >
              <span className="chat-plus-menu-icon"><Icon d={ICONS.summary} size={16} /></span>
              <span className="chat-plus-menu-text">
                <span className="chat-plus-menu-title">Summarize a document</span>
                <span className="chat-plus-menu-sub">Get a bullet summary in this chat</span>
              </span>
            </button>
            <button
              className="chat-plus-menu-item"
              role="menuitem"
              onClick={() => { setPlusOpen(false); fileInputRef.current && fileInputRef.current.click(); }}
            >
              <span className="chat-plus-menu-icon"><Icon d={ICONS.tasks} size={16} /></span>
              <span className="chat-plus-menu-text">
                <span className="chat-plus-menu-title">Auto-add tasks from file</span>
                <span className="chat-plus-menu-sub">AI reads a plan and adds tasks for you</span>
              </span>
            </button>
          </div>
        )}
      </div>
      <input className="input-dark" placeholder="Ask AI, or tap + to add a file…"
        value={aiInput}
        onChange={e => setAiInput(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") onAsk(); }}
      />
      <button className="btn-ai" onClick={() => onAsk()}>ASK</button>
    </div>
    <div className="quick-prompts">
      {[
        ["Today's focus",  "What should I do first today?"],
        ["Urgent",         "Which tasks are overdue or urgent?"],
        ["Motivate me",    "Give me a motivational push to finish my tasks"],
        ["Break it down",  "Break down my biggest task into steps"],
      ].map(([label, prompt]) => (
        <button key={label} className="qp-btn" onClick={() => onAsk(prompt)}>
          {label}
        </button>
      ))}
    </div>
  </div>
  );
};

// ─── NOTIFICATION PERMISSION BANNER ───────────────────────
const NotifPermissionBanner = ({ onRequest, status }) => {
  if (status === "granted" || status === "denied" || !("Notification" in window)) return null;
  return (
    <button className="notif-permission-btn" onClick={onRequest}>
      🔔 Enable push notifications for task reminders
    </button>
  );
};

const GoogleCalendarCard = ({
  gcalConnected, gcalEmail, gcalAutoSync, gcalSyncing, gcalConnecting, gcalLastSync,
  onConnectGcal, onDisconnectGcal, onSyncNowGcal, onToggleAutoSync,
}) => (
  <div className="gcal-card">
    <div className="gcal-head">
      <span className="gcal-title">📅 Google Calendar</span>
      {gcalConnected && <span className="gcal-badge-connected">Connected</span>}
    </div>
    {gcalConnected ? (
      <>
        {gcalEmail && <div className="gcal-email">{gcalEmail}</div>}
        <label className="gcal-toggle">
          <input type="checkbox" checked={gcalAutoSync} onChange={onToggleAutoSync} />
          Auto-sync new &amp; updated tasks
        </label>
        <div className="gcal-btn-row">
          <button className="gcal-btn-sync" disabled={gcalSyncing} onClick={onSyncNowGcal}>
            {gcalSyncing ? "Syncing…" : "Sync now"}
          </button>
          <button className="gcal-btn-disconnect" onClick={onDisconnectGcal}>Disconnect</button>
        </div>
        {gcalLastSync && <div className="gcal-lastsync">Last synced {timeAgo(gcalLastSync)}</div>}
      </>
    ) : (
      <>
        <div className="gcal-desc">
          Push dated tasks — meetings, project deadlines, pending &amp; upcoming work — into Google Calendar.
        </div>
        <button className="gcal-btn-connect" disabled={gcalConnecting} onClick={onConnectGcal}>
          {gcalConnecting ? "Connecting…" : "Connect Google Calendar"}
        </button>
      </>
    )}
  </div>
);

const RemindersPanel = ({
  upcoming, notifStatus, onRequestNotif,
  gcalConnected, gcalEmail, gcalAutoSync, gcalSyncing, gcalConnecting, gcalLastSync,
  onConnectGcal, onDisconnectGcal, onSyncNowGcal, onToggleAutoSync,
}) => (
  <div className="card-dark">
    <div className="panel-label gray">
      ⏰ Reminders
      <span className="panel-hint">auto every min</span>
    </div>
    <NotifPermissionBanner status={notifStatus} onRequest={onRequestNotif} />
    <div className="notif-limit-note">
      ℹ️ Reminders fire while WORK FLOW is open (even in the background) — not when it's fully closed. That needs a paid Firebase plan.
    </div>
    <GoogleCalendarCard
      gcalConnected={gcalConnected} gcalEmail={gcalEmail} gcalAutoSync={gcalAutoSync}
      gcalSyncing={gcalSyncing} gcalConnecting={gcalConnecting} gcalLastSync={gcalLastSync}
      onConnectGcal={onConnectGcal} onDisconnectGcal={onDisconnectGcal}
      onSyncNowGcal={onSyncNowGcal} onToggleAutoSync={onToggleAutoSync}
    />
    {upcoming.length === 0
      ? <div className="empty-small">No timed tasks</div>
      : (
        <div className="reminder-list">
          {upcoming.map(t => (
            <div key={t.id} className="reminder-item">
              <div className="reminder-left">
                <span className="reminder-title">
                  {t.title.length > 28 ? t.title.slice(0, 28) + "…" : t.title}
                </span>
                {t.dueDate && (
                  <span className="reminder-date">📅 {t.dueDate}</span>
                )}
              </div>
              <div className="reminder-right">
                <span className={"reminder-time" + (isOverdue(t) ? " time-overdue" : "")}>
                  {t.dueTime}
                </span>
              </div>
            </div>
          ))}
        </div>
      )
    }
  </div>
);

const StatsPanel = ({ total, done, pending, highCount, pct }) => (
  <div className="card-dark">
    <div className="panel-label gray">Session Stats</div>
    <div className="stats-grid">
      <div className="stat-box">
        <div className="stat-num red">{total}</div>
        <div className="stat-lbl">Total</div>
      </div>
      <div className="stat-box">
        <div className="stat-num green">{done}</div>
        <div className="stat-lbl">Done</div>
      </div>
      <div className="stat-box">
        <div className="stat-num yellow">{pending}</div>
        <div className="stat-lbl">Pending</div>
      </div>
      <div className="stat-box">
        <div className="stat-num pink">{highCount}</div>
        <div className="stat-lbl">High Pri</div>
      </div>
    </div>
    <div className="stats-bar-section">
      <div className="stats-bar-label">
        <span>Progress</span><span>{pct}%</span>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: pct + "%" }} />
      </div>
    </div>
  </div>
);

// ─── ROADMAP PANEL ─────────────────────────────────────────
// Separate "session" from Tasks: upload any roadmap file (e.g. a
// 100-day full stack roadmap) and it gets split into one small,
// dated mini-task per day, starting from a chosen start date.
const RoadmapPanel = ({ roadmaps, roadmapsLoading, importing, rmProgress, fileInputRef,
                        rmName, setRmName, rmStartDate, setRmStartDate,
                        rmTotalDays, setRmTotalDays, rmPageSize, setRmPageSize,
                        generatingIds,
                        onImportFile, onToggleDay, onDelete, onUnlockNextPage, onRefreshTopics }) => {
  const [expandedId, setExpandedId] = useState(null);
  const [activeTopic, setActiveTopic] = useState(null);
  const totalDaysNum = parseInt(rmTotalDays, 10) || 0;
  const isOdd = totalDaysNum > 0 && totalDaysNum % 2 !== 0;
  const suggestedPageSize = totalDaysNum > 0 ? Math.ceil(totalDaysNum / 2) : "";
  // Auto-fetch topics the first time a roadmap is expanded, in case it
  // predates the Resources feature or a past extraction attempt failed
  // silently — so Resources heal themselves instead of staying empty forever.
  const autoFetchedRef = useRef(new Set());
  useEffect(() => {
    if (!expandedId) return;
    const r = roadmaps.find(x => x.id === expandedId);
    if (!r) return;
    const hasTopics = r.topics && r.topics.length > 0;
    if (!hasTopics && !r.topicsLoading && !autoFetchedRef.current.has(expandedId)) {
      autoFetchedRef.current.add(expandedId);
      onRefreshTopics && onRefreshTopics(expandedId);
    }
  }, [expandedId, roadmaps, onRefreshTopics]);

  // The full session view keeps every day (including past ones) visible
  // for a history trail, so completed cards shouldn't vanish like on the
  // preview card — instead they get a quick fade "pulse" down to their
  // normal done-state opacity, then the strip smooth-scrolls to bring the
  // next pending day into view (the Netflix "up next" glide).
  const [justCompletedKey, setJustCompletedKey] = useState(null);
  const dayCardRefs = useRef({});
  const justCompletedTimerRef = useRef(null);
  useEffect(() => () => { if (justCompletedTimerRef.current) clearTimeout(justCompletedTimerRef.current); }, []);
  const handleToggleWithScroll = (roadmapId, dayIdx, days) => {
    const key = roadmapId + ":" + dayIdx;
    setJustCompletedKey(key);
    onToggleDay(roadmapId, dayIdx);
    const nextPendingIdx = days.findIndex((dd, ii) => ii > dayIdx && !dd.done && dd.generated);
    if (nextPendingIdx !== -1) {
      const nextKey = roadmapId + ":" + nextPendingIdx;
      setTimeout(() => {
        const el = dayCardRefs.current[nextKey];
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      }, 260);
    }
    justCompletedTimerRef.current = setTimeout(() => setJustCompletedKey(null), 620);
  };

  return (
    <div className="card-dark">
      <div className="panel-label gray">
        🗺️ Roadmap
        <span className="panel-hint">day-by-day plan, unlocked page by page</span>
      </div>

      <div className="rm-form">
        <input
          className="input-dark"
          placeholder="Roadmap name (optional)"
          value={rmName}
          onChange={e => setRmName(e.target.value)}
        />
        <div className="rm-form-row">
          <input
            type="date"
            className="input-dark sel"
            value={rmStartDate}
            onChange={e => setRmStartDate(e.target.value)}
          />
          <input
            type="number"
            className="input-dark sel"
            min="1" max="180"
            value={rmTotalDays}
            placeholder="Days"
            onChange={e => setRmTotalDays(e.target.value)}
          />
        </div>
        {isOdd && (
          <div className="rm-odd-note">
            <div className="rm-odd-label">
              ⚠️ {totalDaysNum} is odd — it can't split evenly into 2 pages. Choose your own days-per-page:
            </div>
            <input
              type="number"
              className="input-dark sel"
              min="1" max={totalDaysNum}
              value={rmPageSize}
              placeholder={"Days per page (e.g. " + suggestedPageSize + ")"}
              onChange={e => setRmPageSize(e.target.value)}
            />
          </div>
        )}
        <input
          type="file"
          ref={fileInputRef}
          accept=".txt,.md,.csv,.json,.xlsx,.xls,.pdf,.docx"
          style={{ display: "none" }}
          onChange={e => {
            const file = e.target.files && e.target.files[0];
            if (file) onImportFile(file);
            e.target.value = "";
          }}
        />
        <button
          className="roadmap-upload-btn"
          title={importing ? (rmProgress || "Building page 1…") : "Upload roadmap file → split into pages of daily tasks"}
          aria-label="Upload roadmap file"
          disabled={importing}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
        >
          {importing ? <SpinnerIcon /> : <UploadIcon />}
          <span>{importing ? (rmProgress || "Building page 1…") : "Upload roadmap file"}</span>
        </button>
      </div>

      {roadmapsLoading ? (
        <div className="empty-small">Loading…</div>
      ) : roadmaps.length === 0 ? (
        <div className="empty-small">No roadmaps yet — upload a plan file above</div>
      ) : (
        <div className="roadmap-list">
          {roadmaps.map(r => {
            const days = r.days || [];
            const total = days.length;
            const doneCount = days.filter(d => d.done).length;
            const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
            const isOpen = expandedId === r.id;
            const isGenerating = generatingIds && generatingIds.has(r.id);
            const currentPage = r.currentPage || 1;
            const totalPages = r.totalPages || 1;
            const hasMorePages = currentPage < totalPages;
            return (
              <div key={r.id} className="roadmap-item">
                <div className="roadmap-item-head" onClick={() => { setExpandedId(isOpen ? null : r.id); setActiveTopic(null); }}>
                  <div className="roadmap-item-title">{r.name || "Roadmap"}</div>
                  <button
                    className="del-btn"
                    onClick={e => { e.stopPropagation(); onDelete(r.id); }}
                  >
                    <Icon d={ICONS.close} size={14} />
                  </button>
                </div>
                <div className="roadmap-item-sub">
                  Starts {r.startDate} · {total} days · Page {currentPage}/{totalPages} ({r.pageSize || total}/page)
                </div>
                <div className="progress-row">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: pct + "%" }} />
                  </div>
                  <span className="progress-text">{doneCount}/{total}</span>
                </div>
                {isGenerating && (
                  <div className="roadmap-generating">🔄 Unlocking page {currentPage + 1} of {totalPages}…</div>
                )}
                {isOpen && (
                  <div className="roadmap-expanded-grid">
                    <div className="roadmap-left-col">
                    <div className="roadmap-days-horizontal">
                      {days.map((d, i) => {
                        const locked = !d.generated;
                        const key = r.id + ":" + i;
                        const justCompleted = justCompletedKey === key;
                        return (
                          <div
                            key={i}
                            ref={el => { if (el) dayCardRefs.current[key] = el; }}
                            className={"roadmap-day-card" + (d.done ? " done" : "") + (locked ? " locked" : "") + (justCompleted ? " rm-card-just-completed" : "")}
                          >
                            {locked ? (
                              <div className="rm-card-lock" title="Unlocks after the current page is completed">🔒</div>
                            ) : (
                              <div
                                className={"check-box" + (d.done ? " checked" : "")}
                                onClick={() => handleToggleWithScroll(r.id, i, days)}
                              >
                                {d.done && <Icon d={ICONS.check} size={12} />}
                              </div>
                            )}
                            <div className="roadmap-day-meta">
                              <span className="roadmap-day-num">Day {d.day}</span>
                              <span className="date-badge">📅 {d.date}</span>
                            </div>
                            <div className="roadmap-day-task">
                              {locked ? "Locked" : d.task}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {hasMorePages && !isGenerating && (
                      <button
                        className="qp-btn rm-unlock-btn"
                        onClick={() => onUnlockNextPage(r.id)}
                      >
                        🔓 Unlock page {currentPage + 1} of {totalPages} now
                      </button>
                    )}
                    </div>

                    {/* Learning resources — free videos / free & paid courses,
                        picked from the AI-extracted topics for this roadmap.
                        Links are built locally (not by the AI), so they always
                        open real, working search results — never a broken URL.
                        Shown parallel to the (possibly locked) next session. */}
                    <div className="roadmap-right-col">
                    <div className="rm-resources">
                      <div className="rm-resources-head">
                        📚 Resources
                        {r.topicsLoading && <span className="panel-hint">finding topics…</span>}
                      </div>
                      {(!r.topics || r.topics.length === 0) && !r.topicsLoading ? (
                        <div className="rm-resources-empty">
                          <div className="empty-small">No topics detected yet</div>
                          <button
                            className="qp-btn rm-retry-topics-btn"
                            onClick={() => onRefreshTopics && onRefreshTopics(r.id)}
                          >
                            🔄 Find topics
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="rm-topic-chips">
                            {(r.topics || []).map(topic => (
                              <button
                                key={topic}
                                className={"rm-topic-chip" + (activeTopic === topic ? " active" : "")}
                                onClick={() => setActiveTopic(activeTopic === topic ? null : topic)}
                              >
                                {topic}
                              </button>
                            ))}
                          </div>
                          {activeTopic && (
                            <div className="rm-resource-cards">
                              {buildResourceLinks(activeTopic).map(res => (
                                <a
                                  key={res.key}
                                  className="rm-resource-card"
                                  href={res.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <span className="rm-resource-emoji">{res.emoji}</span>
                                  <span className="rm-resource-info">
                                    <span className="rm-resource-platform">{res.label}</span>
                                    <span className="rm-resource-title">{activeTopic}</span>
                                  </span>
                                  <span className={"rm-price-badge " + res.priceClass}>{res.price}</span>
                                </a>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── ROADMAP PREVIEW CARD (Dashboard main panel) ────────────
// Compact card for the Dashboard: shows every active roadmap by
// name, with its next pending days as small horizontal cards
// (locked days marked with 🔒), so progress is visible without
// leaving the main panel. Tapping opens the full Roadmap session.
const RoadmapPreviewCard = ({ roadmaps, roadmapsLoading, onOpenRoadmap, onToggleDay, mobile }) => {
  // Netflix-style completion animation: card fades + collapses in place
  // (CSS handles the "next task glides in" part via flex reflow), and the
  // actual Firestore write is deferred until the animation finishes so
  // the card doesn't just vanish mid-transition.
  const [completingKey, setCompletingKey] = useState(null);
  const completeTimerRef = useRef(null);
  useEffect(() => () => { if (completeTimerRef.current) clearTimeout(completeTimerRef.current); }, []);
  const handleAnimatedToggle = (e, roadmapId, idx) => {
    e.stopPropagation();
    const key = roadmapId + ":" + idx;
    if (completingKey) return; // one completion animation at a time
    setCompletingKey(key);
    completeTimerRef.current = setTimeout(() => {
      onToggleDay(roadmapId, idx);
      setCompletingKey(null);
    }, 640);
  };

  if (roadmapsLoading || !roadmaps || roadmaps.length === 0) return null;
  return (
    <div className="card-dark">
      <div className="panel-label gray">
        🗺️ Roadmap
        <span className="panel-hint">pending tasks · tap to open</span>
      </div>
      <div className="rm-preview-list">
        {roadmaps.map(r => {
          const days = r.days || [];
          const firstPendingIdx = days.findIndex(d => !d.done);

          // ── Mobile: one row only, styled like a regular task item ──
          if (mobile) {
            const d = firstPendingIdx === -1 ? null : days[firstPendingIdx];
            const locked = d ? !d.generated : false;
            return (
              <div key={r.id} className="rm-preview-group">
                <div className="rm-preview-name" onClick={onOpenRoadmap}>{r.name || "Roadmap"}</div>
                {!d ? (
                  <div className="empty-small">All caught up 🎉</div>
                ) : (
                  <div
                    className={"task-item roadmap-mobile-task" + (d.done ? " done" : "") + (locked ? " locked" : "")}
                    onClick={onOpenRoadmap}
                  >
                    {locked ? (
                      <div className="rm-card-lock" title="Unlocks after the current page is completed">🔒</div>
                    ) : (
                      <div
                        className={"check-box" + (d.done ? " checked" : "")}
                        onClick={e => { e.stopPropagation(); onToggleDay(r.id, firstPendingIdx); }}
                      >
                        {d.done && <Icon d={ICONS.check} size={12} />}
                      </div>
                    )}
                    <div className="task-body">
                      <div className="task-title">Day {d.day} · {r.name || "Roadmap"}</div>
                      <div className="task-meta">
                        <span className="date-badge">📅 {d.date}</span>
                      </div>
                      <div className="roadmap-mobile-task-text">
                        {locked ? "Locked — unlocks after the current page is completed" : d.task}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          }

          // ── Desktop: unchanged horizontal-scroll card list ──
          const visible = firstPendingIdx === -1 ? [] : days.slice(firstPendingIdx, firstPendingIdx + 6);
          return (
            <div key={r.id} className="rm-preview-group">
              <div className="rm-preview-name" onClick={onOpenRoadmap}>{r.name || "Roadmap"}</div>
              {visible.length === 0 ? (
                <div className="empty-small">All caught up 🎉</div>
              ) : (
                <div className="roadmap-days-horizontal">
                  {visible.map((d, i) => {
                    const idx = firstPendingIdx + i;
                    const locked = !d.generated;
                    const key = r.id + ":" + idx;
                    const isCompleting = completingKey === key;
                    return (
                      <div
                        key={idx}
                        className={"roadmap-day-card" + (d.done ? " done" : "") + (locked ? " locked" : "") + (isCompleting ? " rm-card-completing" : "")}
                        onClick={onOpenRoadmap}
                      >
                        {locked ? (
                          <div className="rm-card-lock" title="Unlocks after the current page is completed">🔒</div>
                        ) : (
                          <div
                            className={"check-box" + ((d.done || isCompleting) ? " checked" : "")}
                            onClick={e => handleAnimatedToggle(e, r.id, idx)}
                          >
                            {(d.done || isCompleting) && <Icon d={ICONS.check} size={12} />}
                          </div>
                        )}
                        <div className="roadmap-day-meta">
                          <span className="roadmap-day-num">Day {d.day}</span>
                          <span className="date-badge">📅 {d.date}</span>
                        </div>
                        <div className="roadmap-day-task">
                          {locked ? "Locked" : d.task}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Center-screen "add a task" panel (Gemini-style rectangular card on
// desktop; unchanged bottom sheet on mobile — see .add-modal CSS).
// File-driven flows (summarize / auto-add tasks) live in the Chat
// panel's (+) menu now, so this modal is purely the manual task form.
const AddModal = ({ onClose, taskInput, setTaskInput, priority, setPriority,
                    dueDate, setDueDate, dueTime, setDueTime,
                    repeat, setRepeat, repeatDays, setRepeatDays,
                    onAdd, pct, done, total }) => {
  const ref = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => { if (ref.current) ref.current.focus(); }, 80);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="add-modal-overlay" onClick={onClose}>
      <div className="add-modal" onClick={e => e.stopPropagation()}>
        <div className="add-modal-header">
          <span className="panel-label red" style={{ marginBottom:0 }}>
            <div className="panel-dot" />Add a task
          </span>
          <button className="del-btn" onClick={onClose}>
            <Icon d={ICONS.close} size={18} />
          </button>
        </div>

        <AddForm
          inputRef={ref}
          taskInput={taskInput} setTaskInput={setTaskInput}
          priority={priority}   setPriority={setPriority}
          dueDate={dueDate}     setDueDate={setDueDate}
          dueTime={dueTime}     setDueTime={setDueTime}
          repeat={repeat}       setRepeat={setRepeat}
          repeatDays={repeatDays} setRepeatDays={setRepeatDays}
          onAdd={onAdd} pct={pct} done={done} total={total}
        />
      </div>
    </div>
  );
};

// ─── Profile ────────────────────────────────────────────────
function initialsOf(name, email) {
  const src = (name || "").trim() || (email || "").split("@")[0] || "?";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function fmtDateTime(ms) {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium", timeStyle: "short",
    });
  } catch (_) { return "—"; }
}

const Avatar = ({ user, size, photoDataUrl }) => {
  const s = size || 36;
  const src = photoDataUrl || user.photoURL;
  return src ? (
    <img src={src} alt="" className="avatar-img"
      style={{ width:s, height:s }} referrerPolicy="no-referrer" />
  ) : (
    <div className="avatar-fallback" style={{ width:s, height:s, fontSize:s*0.4 }}>
      {initialsOf(user.displayName, user.email)}
    </div>
  );
};

// Resize + compress an uploaded image client-side before it's stored as a
// base64 string in Firestore — keeps the doc small on a low-RAM setup and
// avoids needing Firebase Storage + its own security rules.
function resizeImageFile(file, maxSize = 200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        const scale = Math.min(1, maxSize / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const ProfileModal = ({ user, onClose, onToast, nickname, dob, onSaveMeta, photoDataUrl }) => {
  const [editing, setEditing]   = useState(false);
  const [name, setName]         = useState(user.displayName || "");
  const [saving, setSaving]     = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [nickDraft, setNickDraft] = useState(nickname || "");
  const [dobDraft, setDobDraft]   = useState(dob || "");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const inputRef = useRef(null);
  const photoInputRef = useRef(null);

  const handlePhotoPick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onToast && onToast("Please choose an image file");
      return;
    }
    setUploadingPhoto(true);
    try {
      const dataUrl = await resizeImageFile(file);
      onSaveMeta && onSaveMeta({ photoDataUrl: dataUrl });
      onToast && onToast("Profile picture updated");
    } catch (e) {
      onToast && onToast("Couldn't process that image");
    } finally {
      setUploadingPhoto(false);
    }
  };

  useEffect(() => {
    if (editing) setTimeout(() => inputRef.current && inputRef.current.focus(), 60);
  }, [editing]);

  useEffect(() => { setNickDraft(nickname || ""); }, [nickname]);
  useEffect(() => { setDobDraft(dob || ""); }, [dob]);

  const saveMeta = () => {
    onSaveMeta && onSaveMeta({ nickname: nickDraft.trim(), dob: dobDraft });
    setEditingMeta(false);
  };

  const provider = user.providerData?.[0]?.providerId === "google.com"
    ? "Google" : "Email & Password";

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === user.displayName) { setEditing(false); return; }
    setSaving(true);
    try {
      const { updateProfile } = await import("firebase/auth");
      await updateProfile(auth.currentUser, { displayName: trimmed });
      onToast && onToast("Profile updated");
      setEditing(false);
    } catch (e) {
      onToast && onToast("Couldn't update name");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="add-modal-overlay" onClick={onClose}>
      <div className="profile-modal" onClick={e => e.stopPropagation()}>
        <div className="add-modal-header">
          <span className="panel-label red" style={{ marginBottom:0 }}>
            <div className="panel-dot" />Profile
          </span>
          <button className="del-btn" onClick={onClose}>
            <Icon d={ICONS.close} size={18} />
          </button>
        </div>

        <div className="profile-hero">
          <label className="avatar-edit-wrap" title="Change profile picture">
            <Avatar user={user} size={64} photoDataUrl={photoDataUrl} />
            <span className="avatar-edit-overlay">
              <Icon d={ICONS.camera} size={20} />
            </span>
            <span className="avatar-edit-badge">
              <Icon d={ICONS.camera} size={11} />
            </span>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoPick}
              disabled={uploadingPhoto}
            />
          </label>
          <div className="profile-hero-info">
            {editing ? (
              <div className="profile-name-edit">
                <input
                  ref={inputRef} className="profile-name-input" value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveName()}
                  maxLength={40}
                />
                <button className="profile-save-btn" disabled={saving} onClick={saveName}>
                  {saving ? "…" : "Save"}
                </button>
                <button className="profile-cancel-btn"
                  onClick={() => { setEditing(false); setName(user.displayName || ""); }}>
                  <Icon d={ICONS.close} size={14} />
                </button>
              </div>
            ) : (
              <div className="profile-name-row">
                <span className="profile-name">{user.displayName || "Unnamed"}</span>
                <button className="profile-edit-btn" title="Edit name" onClick={() => setEditing(true)}>
                  <Icon d={ICONS.edit} size={14} />
                </button>
              </div>
            )}
            <span className="profile-provider mono">{provider} account</span>
          </div>
        </div>

        <div className="profile-section">
          <div className="profile-row">
            <Icon d={ICONS.mail} size={16} />
            <div className="profile-row-text">
              <span className="profile-row-label">Signed in as</span>
              <span className="profile-row-value">{user.email || "—"}</span>
            </div>
          </div>
          <div className="profile-row">
            <Icon d={ICONS.clock} size={16} />
            <div className="profile-row-text">
              <span className="profile-row-label">Current session since</span>
              <span className="profile-row-value">{fmtDateTime(Date.parse(user.metadata?.lastSignInTime))}</span>
            </div>
          </div>
          <div className="profile-row">
            <Icon d={ICONS.user} size={16} />
            <div className="profile-row-text">
              <span className="profile-row-label">Account created</span>
              <span className="profile-row-value">{fmtDateTime(Date.parse(user.metadata?.creationTime))}</span>
            </div>
          </div>
        </div>

        <div className="profile-section">
          <div className="profile-section-head">
            <span>Basic information</span>
            {!editingMeta ? (
              <button className="profile-edit-btn" title="Edit" onClick={() => setEditingMeta(true)}>
                <Icon d={ICONS.edit} size={13} />
              </button>
            ) : (
              <div className="profile-meta-actions">
                <button className="profile-save-btn small" onClick={saveMeta}>Save</button>
                <button className="profile-cancel-btn" onClick={() => {
                  setEditingMeta(false); setNickDraft(nickname || ""); setDobDraft(dob || "");
                }}>
                  <Icon d={ICONS.close} size={13} />
                </button>
              </div>
            )}
          </div>

          <div className="profile-row">
            <Icon d={ICONS.user} size={16} />
            <div className="profile-row-text">
              <span className="profile-row-label">Nickname</span>
              {editingMeta ? (
                <input className="profile-meta-input" value={nickDraft} maxLength={24}
                  placeholder="Add a nickname"
                  onChange={e => setNickDraft(e.target.value)} />
              ) : (
                <span className="profile-row-value">{nickname || "Not set"}</span>
              )}
            </div>
          </div>
          <div className="profile-row">
            <Icon d={ICONS.calendar} size={16} />
            <div className="profile-row-text">
              <span className="profile-row-label">Date of birth</span>
              {editingMeta ? (
                <input type="date" className="profile-meta-input date-inp" value={dobDraft}
                  onChange={e => setDobDraft(e.target.value)} />
              ) : (
                <span className="profile-row-value">{dob || "Not set"}</span>
              )}
            </div>
          </div>
        </div>

        <div className="profile-section">
          <div className="profile-row">
            <Icon d={ICONS.gear} size={16} />
            <div className="profile-row-text">
              <span className="profile-row-label">App version</span>
              <span className="profile-row-value mono">WORK FLOW v{APP_VERSION}</span>
            </div>
          </div>
        </div>

        <button className="profile-signout-btn" onClick={() => signOut(auth)}>
          <Icon d={ICONS.logout} size={16} />Sign out
        </button>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════
// DESKTOP SIDEBAR + TOPBAR + NOTES / MY FILES
// ═══════════════════════════════════════════════
const SIDE_NAV_ITEMS = [
  { id:"dashboard", label:"Dashboard", icon:"dashboard" },
  { id:"tasks",      label:"Tasks",     icon:"tasks"     },
  { id:"messages",   label:"Chat",      icon:"message"   },
  { id:"activity",   label:"Activity",  icon:"stats"     },
  { id:"calendar",   label:"Calendar",  icon:"calendar"  },
];

const SCREEN_TITLES = {
  dashboard: ["Dashboard", "Make things simple."],
  tasks:     ["Tasks",     "Everything you need to get done."],
  messages:  ["Chat",  "Ask AI about your day, or attach a file to summarize."],
  activity:  ["Activity",  "Your progress at a glance."],
  calendar:  ["Calendar",  "Upcoming and overdue reminders."],
  roadmap:   ["Roadmap",   "Your day-by-day learning plan."],
};

const Sidebar = ({ deskScreen, setDeskScreen, onSettings, onCollapse }) => (
  <aside className="sidebar">
    <div className="sidebar-logo">
      <div className="logo-mark">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M4 12l4 6 4-11 4 11 4-6" stroke="#0a0e1a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <div>
        <div className="logo-name"><span className="logo-word-work">WORK</span> <span className="logo-word-flow">FLOW</span></div>
        <div className="logo-sub">Task Intelligence</div>
      </div>
      <button className="sidebar-collapse-btn" title="Collapse sidebar" onClick={onCollapse}>
        <Icon d={ICONS.chevronLeft} size={15} />
      </button>
    </div>

    <nav className="sidebar-nav">
      {SIDE_NAV_ITEMS.map(n => (
        <button key={n.id}
          className={"sidebar-nav-btn" + (deskScreen === n.id ? " active" : "")}
          onClick={() => setDeskScreen(n.id)}>
          <Icon d={ICONS[n.icon]} size={18} />
          <span>{n.label}</span>
        </button>
      ))}
    </nav>

    <div className="sidebar-bottom">
      <button className="sidebar-nav-btn" onClick={onSettings}>
        <Icon d={ICONS.gear} size={18} /><span>Settings</span>
      </button>
    </div>
  </aside>
);

// ── Collapsed-sidebar state: nav icons dock to the bottom of the screen
// on desktop instead of the left rail, freeing up horizontal space.
const DesktopDockNav = ({ deskScreen, setDeskScreen, onSettings, onExpand }) => (
  <nav className="desktop-dock-nav">
    <button className="dock-nav-btn dock-expand-btn" title="Expand sidebar" onClick={onExpand}>
      <Icon d={ICONS.menu} size={18} />
    </button>
    <div className="dock-nav-divider" />
    {SIDE_NAV_ITEMS.map(n => (
      <button key={n.id}
        className={"dock-nav-btn" + (deskScreen === n.id ? " active" : "")}
        title={n.label}
        onClick={() => setDeskScreen(n.id)}>
        <Icon d={ICONS[n.icon]} size={19} />
      </button>
    ))}
    <div className="dock-nav-divider" />
    <button className="dock-nav-btn" title="Settings" onClick={onSettings}>
      <Icon d={ICONS.gear} size={19} />
    </button>
  </nav>
);

const TopBar = ({ deskScreen, setDeskScreen, upcoming, showNotifPanel, setShowNotifPanel,
                  user, onProfile, photoDataUrl }) => {
  const [title, subtitle] = SCREEN_TITLES[deskScreen] || SCREEN_TITLES.dashboard;
  const overdueCount = upcoming.filter(isOverdue).length;
  return (
    <header className="topbar">
      <div className="topbar-title-wrap">
        <div className="topbar-title">{title}</div>
        <div className="topbar-subtitle">{subtitle}</div>
      </div>
      <div className="topbar-right">
        <button
          className={"roadmap-btn" + (deskScreen === "roadmap" ? " active" : "")}
          onClick={() => setDeskScreen(deskScreen === "roadmap" ? "dashboard" : "roadmap")}
        >
          <Icon d={ICONS.roadmap} size={15} />
          {deskScreen === "roadmap" ? "Back to Dashboard" : "Roadmap"}
        </button>

        <div className="topbar-notif-wrap">
          <button className="topbar-icon-btn" title="Notifications"
            onClick={() => setShowNotifPanel(!showNotifPanel)}>
            <Icon d={ICONS.bell} size={18} />
            {overdueCount > 0 && <span className="notif-dot" />}
          </button>
          {showNotifPanel && (
            <div className="notif-popover">
              <div className="notif-popover-head">Reminders</div>
              {upcoming.length === 0 ? (
                <div className="empty-small">No timed tasks</div>
              ) : (
                <div className="reminder-list">
                  {upcoming.slice(0, 6).map(t => (
                    <div key={t.id} className="reminder-item">
                      <div className="reminder-left">
                        <span className="reminder-title">
                          {t.title.length > 28 ? t.title.slice(0, 28) + "…" : t.title}
                        </span>
                        {t.dueDate && <span className="reminder-date">📅 {t.dueDate}</span>}
                      </div>
                      <div className="reminder-right">
                        <span className={"reminder-time" + (isOverdue(t) ? " time-overdue" : "")}>
                          {t.dueTime}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <button className="profile-btn topbar-profile-btn" title="Profile" onClick={onProfile}>
          <Avatar user={user} size={34} photoDataUrl={photoDataUrl} />
        </button>
      </div>
    </header>
  );
};

const timeAgo = (ms) => {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
};

const NotesCard = ({ noteText, noteEditing, setNoteEditing, noteDraft, setNoteDraft,
                     noteSaving, noteUpdatedAt, onSave }) => (
  <div className="side-card notes-card">
    <div className="side-card-head">
      <span>Today's note</span>
      {!noteEditing && (
        <button className="side-card-edit-btn" title="Edit note"
          onClick={() => { setNoteDraft(noteText); setNoteEditing(true); }}>
          <Icon d={ICONS.edit} size={13} />
        </button>
      )}
    </div>

    {noteEditing ? (
      <div className="note-edit-box">
        <textarea
          className="note-textarea"
          value={noteDraft}
          placeholder="Write a quick note for today…"
          maxLength={280}
          onChange={e => setNoteDraft(e.target.value)}
          autoFocus
        />
        <div className="note-edit-actions">
          <button className="profile-save-btn small" disabled={noteSaving}
            onClick={() => onSave(noteDraft.trim())}>
            {noteSaving ? "…" : "Save"}
          </button>
          <button className="profile-cancel-btn" onClick={() => setNoteEditing(false)}>
            <Icon d={ICONS.close} size={13} />
          </button>
        </div>
      </div>
    ) : noteText ? (
      <>
        <p className="note-text">{noteText}</p>
        {noteUpdatedAt && <span className="note-timestamp">{timeAgo(noteUpdatedAt)}</span>}
      </>
    ) : (
      <div className="empty-small">No note yet — tap the pencil to add one</div>
    )}
  </div>
);

const FILE_ICON_BY_EXT = (name) => {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".pdf")) return ICONS.pdf;
  if (n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv")) return ICONS.stats;
  return ICONS.folder;
};

const MyFilesCard = ({ summaries, summariesLoading, onAddFile, onOpenFile }) => (
  <div className="side-card files-card">
    <div className="side-card-head">
      <span>My files</span>
      <button className="side-card-add-btn" onClick={onAddFile}>
        <Icon d={ICONS.add} size={13} />Add file
      </button>
    </div>

    {summariesLoading ? (
      <div className="empty-small">Loading…</div>
    ) : summaries.length === 0 ? (
      <div className="empty-small">You have not added any file yet</div>
    ) : (
      <div className="files-list">
        {summaries.slice(0, 5).map(s => (
          <button key={s.id} className="file-row" onClick={() => onOpenFile(s)}>
            <span className="file-row-icon"><Icon d={FILE_ICON_BY_EXT(s.sourceFileName)} size={15} /></span>
            <span className="file-row-info">
              <span className="file-row-name">{s.title || "Summary"}</span>
              <span className="file-row-sub">{s.sourceFileName}</span>
            </span>
          </button>
        ))}
      </div>
    )}
  </div>
);

const FileDetailModal = ({ file, onClose, onDelete, speakingId, speechPaused,
                           onSpeak, onTogglePause, onStop }) => {
  const isSpeakingThis = speakingId === file.id;
  return (
    <div className="add-modal-overlay" onClick={onClose}>
      <div className="add-modal" onClick={e => e.stopPropagation()}>
        <div className="add-modal-header">
          <span className="panel-label red" style={{ marginBottom:0 }}>
            <div className="panel-dot" />{file.title || "Summary"}
          </span>
          <button className="del-btn" onClick={onClose}>
            <Icon d={ICONS.close} size={18} />
          </button>
        </div>
        <div className="roadmap-item-sub" style={{ marginBottom:10 }}>
          {file.sourceFileName} · {file.bullets.length} points
          {file.truncated ? " · long file, summarized from the first part" : ""}
        </div>
        <ul className="sum-bullets">
          {file.bullets.map((b, i) => (
            <li key={i} className={"sum-bullet" + (isSpeakingThis ? " speaking" : "")}>{b}</li>
          ))}
        </ul>
        <div className="sum-voice-row">
          {!isSpeakingThis ? (
            <button className="qp-btn sum-voice-btn" onClick={() => onSpeak(file)}>
              <Icon d={ICONS.speaker} size={14} /> Read aloud
            </button>
          ) : (
            <>
              <button className="qp-btn sum-voice-btn" onClick={onTogglePause}>
                <Icon d={speechPaused ? ICONS.play : ICONS.pause} size={14} />
                {speechPaused ? " Resume" : " Pause"}
              </button>
              <button className="qp-btn sum-voice-btn" onClick={onStop}>
                <Icon d={ICONS.stop} size={14} /> Stop
              </button>
            </>
          )}
          <button className="qp-btn sum-voice-btn" onClick={() => { onDelete(file.id); onClose(); }}>
            <Icon d={ICONS.close} size={14} /> Delete
          </button>
        </div>
        <div className="sum-verify-note">
          ⚠️ AI-generated summary — double-check against the original file for anything critical.
        </div>
      </div>
    </div>
  );
};

const NAV_ITEMS = [
  { id:"tasks",     label:"Tasks"  },
  { id:"ai",        label:"Chat"   },
  { id:"roadmap",   label:"Road"   },
  { id:"reminders", label:"Remind" },
  { id:"stats",     label:"Stats"  },
];

const BottomNav = ({ screen, setScreen, onAdd }) => (
  <nav className="mobile-nav">
    {NAV_ITEMS.map(n => (
      <button key={n.id}
        className={"mobile-nav-btn" + (screen === n.id ? " nav-active" : " nav-inactive")}
        onClick={() => setScreen(n.id)}>
        <Icon d={ICONS[n.id] || ICONS.tasks} size={22} />
        <span>{n.label}</span>
      </button>
    ))}
    <button className="mobile-fab" onClick={onAdd}>
      <Icon d={ICONS.add} size={26} />
    </button>
  </nav>
);

// ═══════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════
function AppInner({ user }) {
  const [tasks, setTasks]           = useState([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [screen, setScreen]         = useState("tasks");
  const [tab, setTab]               = useState("all");
  const [taskInput, setTaskInput]   = useState("");
  const [priority, setPriority]     = useState("medium");
  const [dueDate, setDueDate]       = useState("");
  const [dueTime, setDueTime]       = useState("");
  const [repeat, setRepeat]         = useState("none");
  const [repeatDays, setRepeatDays] = useState([]);
  const [showAdd, setShowAdd]       = useState(false);
  const [clock, setClock]           = useState("");
  const [toast, setToast]           = useState({ visible:false, msg:"" });
  const [aiMessages, setAiMessages] = useState([{
    role: "ai",
    text: "Hey! 👋 Ask me to prioritize your day, break down a task, or check what's urgent.",
  }]);
  const [aiInput, setAiInput]       = useState("");
  const [aiLoading, setAiLoading]   = useState(false);
  const [importing, setImporting]   = useState(false);
  const [saveFlash, setSaveFlash]   = useState(false);
  const [notifStatus, setNotifStatus] = useState(
    "Notification" in window ? Notification.permission : "denied"
  );
  const [notified, setNotified]     = useState(() => {
    const today = new Date().toDateString();
    if (loadLS(DAY_KEY, null) !== today) {
      saveLS(NOTIFIED_KEY, []);
      saveLS(DAY_KEY, today);
      return new Set();
    }
    return new Set(loadLS(NOTIFIED_KEY, []));
  });

  // ── Roadmap: separate "session" — upload a plan file, split into
  // one dated mini-task per day starting from a chosen start date.
  const [roadmaps, setRoadmaps]         = useState([]);
  const [roadmapsLoading, setRoadmapsLoading] = useState(true);
  const [rmName, setRmName]             = useState("");
  const [rmStartDate, setRmStartDate]   = useState(getTodayStr());
  const [rmTotalDays, setRmTotalDays]   = useState(100);
  const [rmPageSize, setRmPageSize]     = useState("");
  const [rmImporting, setRmImporting]   = useState(false);
  const [rmProgress, setRmProgress]     = useState("");
  const [rmGeneratingIds, setRmGeneratingIds] = useState(() => new Set());

  // ── Summarize: upload a PDF/Word/text file, get a clean AI bullet
  // summary, and optionally have it read aloud (Web Speech API).
  const [summaries, setSummaries]       = useState([]);
  const [summariesLoading, setSummariesLoading] = useState(true);
  const [sumImporting, setSumImporting] = useState(false);
  const [sumProgress, setSumProgress]   = useState("");
  const [speakingId, setSpeakingId]     = useState(null);
  const [speechPaused, setSpeechPaused] = useState(false);

  const [showProfile, setShowProfile] = useState(false);
  const [rightTab, setRightTab]       = useState("ai");

  // ── Desktop sidebar navigation (separate from the mobile `screen`
  // state above, so the mobile bottom-nav experience is untouched)
  const [deskScreen, setDeskScreen]   = useState("dashboard");
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  // ── Desktop sidebar collapse: when true, the left sidebar hides and
  // its nav items reappear as an icon bar docked to the bottom of the screen
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ── Quick note (top-right "Today note" style card)
  const [noteText, setNoteText]       = useState("");
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft]     = useState("");
  const [noteSaving, setNoteSaving]   = useState(false);
  const [noteUpdatedAt, setNoteUpdatedAt] = useState(null);

  // ── Profile extras not covered by Firebase Auth (nickname / DOB / photo)
  const [nickname, setNickname]       = useState("");
  const [dob, setDob]                 = useState("");
  const [photoDataUrl, setPhotoDataUrl] = useState("");

  // ── Appearance — dark mode only (light-mode toggle removed).
  const theme = "dark";

  const [openFile, setOpenFile]       = useState(null);

  // ── Google Calendar sync (connection status only — access tokens
  // never leave this browser tab, see ensureGcalToken below)
  const [gcalConnected, setGcalConnected]   = useState(false);
  const [gcalEmail, setGcalEmail]           = useState("");
  const [gcalAutoSync, setGcalAutoSync]     = useState(false);
  const [gcalLastSync, setGcalLastSync]     = useState(null);
  const [gcalSyncing, setGcalSyncing]       = useState(false);
  const [gcalConnecting, setGcalConnecting] = useState(false);
  const gcalTokenRef       = useRef(null); // { accessToken, expiresAt }
  const gcalTokenClientRef = useRef(null);
  const swRegRef           = useRef(null); // FCM service worker registration (used for reliable background-tab notifications)

  const chatRef        = useRef(null);
  const saveTimer      = useRef(null);
  const desktopInpRef  = useRef(null);
  const fileInputRef   = useRef(null);
  const rmFileInputRef = useRef(null);
  const sumFileInputRef = useRef(null); // now used as the Chat panel's attach-file input

  // Clock
  useEffect(() => {
    const tick = () => setClock(
      new Date().toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit", hour12:true })
    );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Firestore real-time sync — this is what makes tasks appear on
  // every device signed into the same account, instantly.
  useEffect(() => {
    if (!user) return;
    const tasksRef = collection(db, "users", user.uid, "tasks");
    const q = query(tasksRef, orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setTasks(list);
        setTasksLoading(false);
      },
      (err) => {
        console.error("Firestore sync error:", err);
        setTasksLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  // Roadmap sync — same real-time pattern as tasks, separate collection
  // so roadmap plans stay out of the regular task list.
  useEffect(() => {
    if (!user) return;
    const rmRef = collection(db, "users", user.uid, "roadmaps");
    const q = query(rmRef, orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setRoadmaps(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setRoadmapsLoading(false);
      },
      (err) => {
        console.error("Roadmap sync error:", err);
        setRoadmapsLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  // Summaries sync — same real-time pattern, own collection.
  useEffect(() => {
    if (!user) return;
    const sumRef = collection(db, "users", user.uid, "summaries");
    const q = query(sumRef, orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setSummaries(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setSummariesLoading(false);
      },
      (err) => {
        console.error("Summary sync error:", err);
        setSummariesLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  // Note sync — single small doc, real-time so it shows on every device.
  useEffect(() => {
    if (!user) return;
    const noteRef = doc(db, "users", user.uid, "meta", "note");
    const unsub = onSnapshot(noteRef, (snap) => {
      const data = snap.data();
      setNoteText(data?.text || "");
      setNoteUpdatedAt(data?.updatedAt || null);
    }, () => {});
    return () => unsub();
  }, [user]);

  // Profile-meta sync — nickname / date of birth / photo / theme (Firebase
  // Auth has no fields for these, so they live in their own small doc).
  useEffect(() => {
    if (!user) return;
    const metaRef = doc(db, "users", user.uid, "meta", "profile");
    const unsub = onSnapshot(metaRef, (snap) => {
      const data = snap.data();
      setNickname(data?.nickname || "");
      setDob(data?.dob || "");
      setPhotoDataUrl(data?.photoDataUrl || "");
    }, () => {});
    return () => unsub();
  }, [user]);

  // Google Calendar connection status — real-time so "Connected" shows
  // instantly and stays in sync if disconnected from another device.
  useEffect(() => {
    if (!user) return;
    const ref = doc(db, "users", user.uid, "meta", "googleCalendar");
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data();
      setGcalConnected(!!data?.connected);
      setGcalEmail(data?.email || "");
      setGcalAutoSync(!!data?.autoSync);
      setGcalLastSync(data?.lastSyncedAt || null);
    }, () => {});
    return () => unsub();
  }, [user]);

  // Stop any speech synthesis if the component unmounts mid-read.
  useEffect(() => {
    return () => {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  // FCM — register for push notifications and listen for foreground pushes
  useEffect(() => {
    if (!user) return;
    let unsubMsg = () => {};
    (async () => {
      try {
        const messaging = await messagingPromise;
        if (!messaging) return; // unsupported browser

        if (!("serviceWorker" in navigator)) return;
        const registration = await navigator.serviceWorker.register(
          "/firebase-messaging-sw.js"
        );
        swRegRef.current = registration;

        if (Notification.permission === "granted") {
          const token = await getToken(messaging, {
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: registration,
          });
          if (token) {
            await setDoc(
              doc(db, "users", user.uid, "fcmTokens", token),
              { token, updatedAt: Date.now(), ua: navigator.userAgent },
              { merge: true }
            );
          }
        }

        // Foreground messages (app open & focused) — show as a toast too
        unsubMsg = onMessage(messaging, (payload) => {
          const title = payload.notification?.title || "Reminder";
          const body = payload.notification?.body || "";
          showToast("🔔 " + title + (body ? ": " + body : ""));
        });
      } catch (e) {
        console.warn("FCM setup skipped:", e.message);
      }
    })();
    return () => unsubMsg();
  }, [user]);


  // Request notification permission
  const requestNotifPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setNotifStatus(result);
    if (result === "granted") {
      showToast("🔔 Notifications enabled!");
    }
  }, []);

  // Fire a push notification.
  // Free-plan / no-backend setup: this only works while the app (tab or
  // installed PWA) is still running somewhere — there's no server pushing
  // to your phone when the app is fully closed or the browser is killed.
  // We still make it as reliable as possible for "app open but screen
  // locked / tab in background" by preferring the service worker's
  // showNotification() — on Android Chrome that lands in the real system
  // notification tray/lock screen, whereas new Notification() often does
  // nothing once the tab loses focus.
  const fireNotification = useCallback((title, body) => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const opts = {
      body,
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      tag: "workflow-reminder",
      renotify: true,
      requireInteraction: false,
    };
    const reg = swRegRef.current;
    if (reg && reg.showNotification) {
      reg.showNotification(title, opts).catch(() => {
        try { new Notification(title, opts); } catch (_) {}
      });
    } else {
      try {
        new Notification(title, opts);
      } catch (e) {
        console.warn("Notification failed:", e);
      }
    }
  }, []);

  // Reminder checker — runs every minute
  useEffect(() => {
    const check = () => {
      const now = new Date();
      tasks.forEach(t => {
        if (!t.dueTime || isDoneToday(t) || notified.has(t.id)) return;
        if (t.repeat === "weekly" && !isRelevantToday(t)) return;
        const parts = t.dueTime.split(":");
        if (parts.length < 2) return;
        const due = new Date();
        if (t.repeat === "none" && t.dueDate) {
          const [y, m, d] = t.dueDate.split("-");
          due.setFullYear(parseInt(y,10), parseInt(m,10)-1, parseInt(d,10));
        }
        due.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
        const diff = (due - now) / 60000;
        if (diff <= 0 && diff >= -1) {
          const msg = "⏰ Due: " + t.title;
          showToast(msg);
          // Push notification to mobile/desktop
          fireNotification("⏰ WORK FLOW Reminder", t.title + (t.dueDate ? " — " + t.dueDate : ""));
          const n = new Set([...notified, t.id]);
          setNotified(n);
          saveLS(NOTIFIED_KEY, [...n]);
        }
      });
    };
    check(); // run immediately on mount/update
    const id = setInterval(check, 60000);
    return () => clearInterval(id);
  }, [tasks, notified, fireNotification]);

  // Chat scroll
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [aiMessages]);

  // Firestore writes — no local setTasks needed, since onSnapshot above
  // updates state automatically the moment the write lands, on every device.
  const flashSaved = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveFlash(true);
    saveTimer.current = setTimeout(() => setSaveFlash(false), 2000);
  }, []);

  // ── Google Calendar: token handling + sync helpers ──────
  // Returns a usable access token. If `interactive` is false and we already
  // have one cached in memory that isn't near expiry, reuse it — otherwise
  // ask Google Identity Services for one (silently if we've already been
  // granted access this session, or with a consent prompt on first connect).
  const ensureGcalToken = useCallback((interactive) => {
    return new Promise((resolve, reject) => {
      const cached = gcalTokenRef.current;
      if (!interactive && cached && cached.expiresAt > Date.now() + 60000) {
        resolve(cached.accessToken);
        return;
      }
      loadGoogleIdentityScript().then(() => {
        if (!gcalTokenClientRef.current) {
          gcalTokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: GCAL_SCOPE,
            callback: () => {},
          });
        }
        gcalTokenClientRef.current.callback = (resp) => {
          if (resp && resp.access_token) {
            gcalTokenRef.current = {
              accessToken: resp.access_token,
              expiresAt: Date.now() + Number(resp.expires_in || 3500) * 1000,
            };
            resolve(resp.access_token);
          } else {
            reject(new Error(resp?.error || "Google sign-in was cancelled"));
          }
        };
        gcalTokenClientRef.current.requestAccessToken({ prompt: interactive ? "consent" : "" });
      }).catch(reject);
    });
  }, []);

  const connectGoogleCalendar = useCallback(async () => {
    if (!user) return;
    setGcalConnecting(true);
    try {
      const token = await ensureGcalToken(true);
      let email = "";
      try {
        const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: "Bearer " + token },
        });
        if (r.ok) { const j = await r.json(); email = j.email || ""; }
      } catch (_) {}
      await setDoc(doc(db, "users", user.uid, "meta", "googleCalendar"),
        { connected: true, email, autoSync: true, updatedAt: Date.now() }, { merge: true });
      showToast("📅 Google Calendar connected" + (email ? " — " + email : ""));
    } catch (e) {
      showToast("⚠️ Couldn't connect Google Calendar: " + e.message);
    } finally {
      setGcalConnecting(false);
    }
  }, [user, ensureGcalToken]);

  const disconnectGoogleCalendar = useCallback(async () => {
    if (!user) return;
    try {
      const tok = gcalTokenRef.current?.accessToken;
      if (tok && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(tok, () => {});
    } catch (_) {}
    gcalTokenRef.current = null;
    try {
      await setDoc(doc(db, "users", user.uid, "meta", "googleCalendar"),
        { connected: false, autoSync: false, updatedAt: Date.now() }, { merge: true });
      showToast("Google Calendar disconnected");
    } catch (e) {
      showToast("⚠️ Couldn't disconnect — check connection");
    }
  }, [user]);

  const toggleGcalAutoSync = useCallback(async () => {
    if (!user) return;
    try {
      await setDoc(doc(db, "users", user.uid, "meta", "googleCalendar"),
        { autoSync: !gcalAutoSync, updatedAt: Date.now() }, { merge: true });
    } catch (e) {
      showToast("⚠️ Couldn't update setting");
    }
  }, [user, gcalAutoSync]);

  // Push one task to Google Calendar — creates its event on first sync,
  // then PATCHes the same event on every later sync (id saved on the task).
  const syncTaskToGcal = useCallback(async (task, opts = {}) => {
    if (!user) return;
    const body = gcalEventBodyFromTask(task);
    if (!body) return;
    try {
      const token = await ensureGcalToken(false);
      let eventId = task.gcalEventId;
      let res;
      if (eventId) {
        res = await gcalFetch(token, `${GCAL_EVENTS_URL}/${eventId}`, { method: "PATCH", body: JSON.stringify(body) });
        if (res.status === 404 || res.status === 410) eventId = null; // event no longer exists on Google's side
      }
      if (!eventId) {
        res = await gcalFetch(token, GCAL_EVENTS_URL, { method: "POST", body: JSON.stringify(body) });
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data.id && data.id !== task.gcalEventId) {
        await setDoc(doc(db, "users", user.uid, "tasks", task.id), { gcalEventId: data.id }, { merge: true });
      }
      if (!opts.silent) {
        await setDoc(doc(db, "users", user.uid, "meta", "googleCalendar"), { lastSyncedAt: Date.now() }, { merge: true });
      }
    } catch (e) {
      if (!opts.silent) showToast("⚠️ Calendar sync failed: " + e.message);
      throw e;
    }
  }, [user, ensureGcalToken]);

  const removeTaskFromGcal = useCallback(async (task) => {
    if (!user || !task.gcalEventId) return;
    try {
      const token = await ensureGcalToken(false);
      await gcalFetch(token, `${GCAL_EVENTS_URL}/${task.gcalEventId}`, { method: "DELETE" });
    } catch (_) { /* best-effort — a leftover Calendar event isn't worth surfacing an error for */ }
  }, [user, ensureGcalToken]);

  // Manual "Sync now" — pushes every dated, one-time task in one go. Handy
  // for the first sync after connecting (to catch pre-existing tasks) and
  // any time auto-sync is off.
  const syncAllTasksToGcal = useCallback(async () => {
    if (!user) return;
    setGcalSyncing(true);
    const datedTasks = tasks.filter(t => t.dueDate && t.repeat === "none");
    let ok = 0, fail = 0;
    for (const t of datedTasks) {
      try { await syncTaskToGcal(t, { silent: true }); ok++; }
      catch (_) { fail++; }
    }
    try {
      await setDoc(doc(db, "users", user.uid, "meta", "googleCalendar"), { lastSyncedAt: Date.now() }, { merge: true });
    } catch (_) {}
    setGcalSyncing(false);
    showToast(fail === 0
      ? `📅 Synced ${ok} task${ok === 1 ? "" : "s"} to Google Calendar`
      : `📅 Synced ${ok}, ${fail} failed — try again`);
  }, [user, tasks, syncTaskToGcal]);

  async function addTask() {
    const title = taskInput.trim();
    if (!title || !user) return;
    if (repeat === "weekly" && repeatDays.length === 0) {
      showToast("⚠️ Pick at least one day for custom repeat");
      return;
    }
    const id = String(Date.now());
    const task = {
      title, priority,
      dueDate: repeat === "none" ? dueDate : "",
      dueTime,
      repeat,
      repeatDays: repeat === "weekly" ? repeatDays : [],
      completedDates: [],
      done: false, createdAt: Date.now(),
    };
    try {
      await setDoc(doc(db, "users", user.uid, "tasks", id), task);
      flashSaved();
      if (gcalConnected && gcalAutoSync) {
        syncTaskToGcal({ ...task, id }, { silent: true }).catch(() => {});
      }
    } catch (e) {
      showToast("⚠️ Couldn't save — check connection");
    }
    setTaskInput("");
    setDueDate("");
    setDueTime("");
    setRepeat("none");
    setRepeatDays([]);
    setShowAdd(false);
  }

  const saveNote = useCallback(async (text) => {
    if (!user) return;
    setNoteSaving(true);
    try {
      await setDoc(doc(db, "users", user.uid, "meta", "note"),
        { text, updatedAt: Date.now() }, { merge: true });
      flashSaved();
    } catch (e) {
      showToast("⚠️ Couldn't save note — check connection");
    } finally {
      setNoteSaving(false);
      setNoteEditing(false);
    }
  }, [user, flashSaved]);

  const saveProfileMeta = useCallback(async (fields) => {
    if (!user) return;
    try {
      await setDoc(doc(db, "users", user.uid, "meta", "profile"),
        { ...fields, updatedAt: Date.now() }, { merge: true });
      showToast("Profile updated");
    } catch (e) {
      showToast("⚠️ Couldn't update profile — check connection");
    }
  }, [user]);

  const toggleTask = useCallback(async (id) => {
    if (!user) return;
    const t = tasks.find(t => t.id === id);
    if (!t) return;
    try {
      if (t.repeat === "daily" || t.repeat === "weekly") {
        const today = getTodayStr();
        const cur = t.completedDates || [];
        const next = cur.includes(today) ? cur.filter(d => d !== today) : [...cur, today];
        await setDoc(doc(db, "users", user.uid, "tasks", id), { ...t, completedDates: next });
      } else {
        const newDone = !t.done;
        await setDoc(doc(db, "users", user.uid, "tasks", id), { ...t, done: newDone });
        if (gcalConnected && gcalAutoSync) {
          syncTaskToGcal({ ...t, done: newDone }, { silent: true }).catch(() => {});
        }
      }
      flashSaved();
    } catch (e) {
      showToast("⚠️ Couldn't update — check connection");
    }
  }, [user, tasks, flashSaved, gcalConnected, gcalAutoSync, syncTaskToGcal]);

  const deleteTask = useCallback(async (id) => {
    if (!user) return;
    try {
      const t = tasks.find(x => x.id === id);
      await deleteDoc(doc(db, "users", user.uid, "tasks", id));
      if (gcalConnected && gcalAutoSync && t && t.gcalEventId) {
        removeTaskFromGcal(t).catch(() => {});
      }
      flashSaved();
    } catch (e) {
      showToast("⚠️ Couldn't delete — check connection");
    }
  }, [user, tasks, flashSaved, gcalConnected, gcalAutoSync, removeTaskFromGcal]);

  const filtered = tasks.filter(t => {
    if (tab === "today")   return isRelevantToday(t);
    if (tab === "pending") return !isDoneToday(t);
    if (tab === "done")    return isDoneToday(t);
    if (tab === "high")    return t.priority === "high";
    return true;
  });

  const total     = tasks.length;
  const done      = tasks.filter(t => isDoneToday(t)).length;
  const pending   = total - done;
  const highCount = tasks.filter(t => t.priority === "high" && !isDoneToday(t)).length;
  const pct       = total > 0 ? Math.round((done / total) * 100) : 0;
  const upcoming  = tasks
    .filter(t => t.dueTime && !isDoneToday(t))
    .sort((a, b) => {
      const aStr = (a.dueDate || "9999-12-31") + "T" + a.dueTime;
      const bStr = (b.dueDate || "9999-12-31") + "T" + b.dueTime;
      return aStr.localeCompare(bStr);
    });

  function showToast(msg) {
    setToast({ visible:true, msg });
    setTimeout(() => setToast({ visible:false, msg:"" }), 4000);
  }

  // Groq AI
  async function askAI(question) {
    const q = (question !== undefined ? question : aiInput).trim();
    if (!q || aiLoading) return;
    setAiInput("");
    setAiMessages(prev => [...prev, { role:"user", text:q }]);
    setAiLoading(true);

    const ctx = tasks.length === 0
      ? "No tasks yet."
      : tasks.map(t =>
          "- [" + (isDoneToday(t) ? "DONE" : t.priority.toUpperCase()) + '] "' + t.title + '"' +
          (t.dueDate && t.repeat === "none" ? " on " + t.dueDate : "") +
          (t.dueTime ? " @ " + t.dueTime : "") +
          (repeatLabel(t) ? " (" + repeatLabel(t) + ")" : "")
        ).join("\n");

    const now = new Date();
    const systemMsg =
      "You are a personal AI task assistant for WORK FLOW app. Sharp, concise, motivating.\n" +
      "Time: " + now.toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit", hour12:true }) + "\n" +
      "Date: " + now.toLocaleDateString("en-IN", { weekday:"long", day:"numeric", month:"long" }) + "\n" +
      "Tasks:\n" + ctx + "\n" +
      "Rules: Reply in 2-4 sentences. Be direct. No markdown headers.";

    const GROQ_KEY = process.env.REACT_APP_GROQ_API_KEY;

    if (!GROQ_KEY || GROQ_KEY === "your_groq_key_here") {
      setAiMessages(prev => [...prev, {
        role:"ai",
        text:"⚠️ Groq API key not set! Open .env and add: REACT_APP_GROQ_API_KEY=gsk_..."
      }]);
      setAiLoading(false);
      return;
    }

    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + GROQ_KEY,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 300,
          temperature: 0.7,
          messages: [
            { role: "system", content: systemMsg },
            { role: "user",   content: q },
          ],
        }),
      });

      const d = await r.json();

      if (d.error) {
        setAiMessages(prev => [...prev, {
          role:"ai",
          text:"⚠️ Groq error: " + d.error.message
        }]);
        setAiLoading(false);
        return;
      }

      const reply =
        d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content
          ? d.choices[0].message.content
          : "No response from Groq.";

      setAiMessages(prev => [...prev, { role:"ai", text: reply }]);

    } catch (err) {
      setAiMessages(prev => [...prev, {
        role:"ai",
        text:"⚠️ Network error: " + err.message
      }]);
    }
    setAiLoading(false);
  }

  // Reads any supported file type and returns its content as plain text,
  // so it can be handed to the AI regardless of format.
  async function extractTextFromFile(file) {
    const name = file.name.toLowerCase();

    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      let out = "";
      wb.SheetNames.forEach(sheetName => {
        out += "Sheet: " + sheetName + "\n";
        out += XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]) + "\n\n";
      });
      return out;
    }

    if (name.endsWith(".pdf")) {
      const pdfjsLib = await import("pdfjs-dist/build/pdf");
      pdfjsLib.GlobalWorkerOptions.workerSrc = process.env.PUBLIC_URL + "/pdf.worker.min.js";
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      let out = "";
      const maxPages = Math.min(pdf.numPages, 30); // cap to keep this fast on low-RAM devices
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        out += content.items.map(it => it.str).join(" ") + "\n";
      }
      return out;
    }

    if (name.endsWith(".docx")) {
      const mammoth = await import("mammoth/mammoth.browser");
      const buf = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      return result.value || "";
    }

    if (name.endsWith(".doc")) {
      throw new Error("Old .doc format isn't supported — please save it as .docx or .pdf and try again");
    }

    // Plain text formats: .txt, .md, .csv, .json
    return await file.text();
  }

  // Upload a plan/schedule file — txt, md, csv, json, Excel, PDF, or Word —
  // and let the AI pull out every task in it, then auto-create them on the
  // right days. Tasks with no date mentioned get spread one-per-day starting today.
  async function importTasksFromFile(file) {
    if (!user || importing) return;
    setImporting(true);
    try {
      const rawText = await extractTextFromFile(file);
      const trimmed = (rawText || "").slice(0, 8000); // keep the prompt small for the 8B model
      if (!trimmed.trim()) {
        showToast("⚠️ Couldn't find any readable text in that file");
        setImporting(false);
        return;
      }

      const GROQ_KEY = process.env.REACT_APP_GROQ_API_KEY;
      if (!GROQ_KEY || GROQ_KEY === "your_groq_key_here") {
        showToast("⚠️ Groq API key not set — can't read the file");
        setImporting(false);
        return;
      }

      const todayStr = getTodayStr();
      const sysPrompt =
        "You extract a task list from an uploaded plan/schedule file and output ONLY a raw JSON array — no markdown, no code fences, no explanation.\n" +
        "Today's date is " + todayStr + ".\n" +
        "Each array item must be an object with exactly these fields:\n" +
        '  "title": short task name (string, required)\n' +
        '  "date": the specific date for the task in YYYY-MM-DD format. If the file names a weekday (e.g. "Monday") without a date, use the NEXT occurrence of that weekday from today. If NO date or day is mentioned for a task at all, set "date" to an empty string "".\n' +
        '  "time": 24-hour "HH:MM" if a time is mentioned, else ""\n' +
        '  "priority": "high", "medium", or "low" — infer from urgency wording, default "medium"\n' +
        "Extract every distinct task/to-do you can find. Ignore headers, greetings, or non-task lines.";

      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + GROQ_KEY,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 2000,
          temperature: 0.2,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user",   content: trimmed },
          ],
        }),
      });

      const d = await r.json();
      if (d.error) {
        showToast("⚠️ Groq error: " + d.error.message);
        setImporting(false);
        return;
      }

      let raw = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
      raw = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();

      let items;
      try {
        items = JSON.parse(raw);
      } catch (e) {
        showToast("⚠️ Couldn't understand that file's format");
        setImporting(false);
        return;
      }
      if (!Array.isArray(items) || items.length === 0) {
        showToast("⚠️ No tasks found in that file");
        setImporting(false);
        return;
      }

      // Undated tasks get spread one-per-day starting today, in file order
      let spreadOffset = 0;
      const batch = writeBatch(db);
      let count = 0;
      items.forEach((item, i) => {
        const title = (item && item.title ? String(item.title) : "").trim();
        if (!title) return;
        let dueDate = item.date && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : "";
        if (!dueDate) {
          dueDate = addDaysStr(spreadOffset);
          spreadOffset += 1;
        }
        const priority = ["high", "medium", "low"].includes(item.priority) ? item.priority : "medium";
        const dueTime = /^\d{2}:\d{2}$/.test(item.time || "") ? item.time : "";
        const id = String(Date.now()) + "-" + i;
        const task = {
          title, priority, dueDate, dueTime,
          repeat: "none", repeatDays: [],
          completedDates: [], done: false,
          createdAt: Date.now(),
        };
        batch.set(doc(db, "users", user.uid, "tasks", id), task);
        count += 1;
      });

      if (count === 0) {
        showToast("⚠️ No tasks found in that file");
        setImporting(false);
        return;
      }

      await batch.commit();
      flashSaved();
      showToast("✅ Added " + count + " task" + (count === 1 ? "" : "s") + " from " + file.name);
      setAiMessages(prev => [...prev, {
        role: "ai",
        text: "📁 Imported " + count + " task" + (count === 1 ? "" : "s") + " from \"" + file.name + "\" and added them to your list, spread across the right days.",
      }]);
    } catch (err) {
      showToast("⚠️ Couldn't read that file: " + err.message);
    }
    setImporting(false);
  }

  // Attach a document (📎) straight into the Chat thread: reads it, gets a
  // clean bullet-point summary from Groq, posts a "you attached X" chip
  // followed by an AI summary bubble (with read-aloud) into aiMessages —
  // and still saves to Firestore `summaries` so My Files keeps working.
  // One single Groq call per file, kept small (max_tokens 500) since only
  // a summary comes back, not the whole document.
  async function summarizeFileFromFile(file) {
    if (!user || sumImporting) return;
    setAiMessages(prev => [...prev, { role: "user", type: "file", fileName: file.name }]);
    setSumImporting(true);
    setSumProgress("Reading file…");
    try {
      const rawText = await extractTextFromFile(file);
      const cleaned = (rawText || "").replace(/\s+/g, " ").trim();
      if (!cleaned) {
        const msg = "⚠️ Couldn't find any readable text in that file";
        showToast(msg);
        setAiMessages(prev => [...prev, { role: "ai", text: msg }]);
        setSumImporting(false);
        setSumProgress("");
        return;
      }
      const trimmed = cleaned.slice(0, 14000);
      const wasTruncated = cleaned.length > trimmed.length;

      const GROQ_KEY = process.env.REACT_APP_GROQ_API_KEY;
      if (!GROQ_KEY || GROQ_KEY === "your_groq_key_here") {
        const msg = "⚠️ Groq API key not set! Open .env and add: REACT_APP_GROQ_API_KEY=gsk_...";
        showToast("⚠️ Groq API key not set — can't summarize the file");
        setAiMessages(prev => [...prev, { role: "ai", text: msg }]);
        setSumImporting(false);
        setSumProgress("");
        return;
      }

      setSumProgress("Summarizing…");
      const sysPrompt =
        "Summarize the document into clean, short bullet points a busy student can skim.\n" +
        "Output ONLY a raw JSON object — no markdown, no code fences, no explanation — with exactly these fields:\n" +
        '  "title": a short 3-6 word title guessed from the content\n' +
        '  "bullets": an array of 6 to 12 short bullet strings (max ~20 words each), covering only what is actually in the text — never invent facts not present\n' +
        "Stay strictly factual to the source text below.";

      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + GROQ_KEY,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 500,
          temperature: 0.2,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user",   content: trimmed },
          ],
        }),
      });

      const d = await r.json();
      if (d.error) {
        const msg = "⚠️ Groq error: " + d.error.message;
        showToast(msg);
        setAiMessages(prev => [...prev, { role: "ai", text: msg }]);
        setSumImporting(false);
        setSumProgress("");
        return;
      }

      let raw = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
      raw = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

      const bullets = parsed && Array.isArray(parsed.bullets)
        ? parsed.bullets.map(b => String(b || "").trim()).filter(Boolean).slice(0, 12)
        : [];

      if (bullets.length === 0) {
        const msg = "⚠️ Couldn't summarize that file — try a different one";
        showToast(msg);
        setAiMessages(prev => [...prev, { role: "ai", text: msg }]);
        setSumImporting(false);
        setSumProgress("");
        return;
      }

      const id = String(Date.now());
      const title = (parsed && parsed.title ? String(parsed.title).trim() : "") ||
        file.name.replace(/\.[^.]+$/, "");
      const summaryDoc = {
        title, sourceFileName: file.name, bullets,
        sourceChars: cleaned.length, truncated: wasTruncated,
        createdAt: Date.now(),
      };
      await setDoc(doc(db, "users", user.uid, "summaries", id), summaryDoc);
      flashSaved();
      setAiMessages(prev => [...prev, {
        role: "ai", type: "summary",
        summaryId: id, title, bullets,
        sourceFileName: file.name, truncated: wasTruncated,
      }]);
    } catch (err) {
      const msg = "⚠️ Couldn't read that file: " + err.message;
      showToast(msg);
      setAiMessages(prev => [...prev, { role: "ai", text: msg }]);
    }
    setSumProgress("");
    setSumImporting(false);
  }

  const deleteSummary = useCallback(async (id) => {
    if (!user) return;
    try {
      if (speakingId === id && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        setSpeakingId(null);
        setSpeechPaused(false);
      }
      await deleteDoc(doc(db, "users", user.uid, "summaries", id));
      flashSaved();
    } catch (e) {
      showToast("⚠️ Couldn't delete — check connection");
    }
  }, [user, flashSaved, speakingId]);

  // Voice mode — reads the title + bullets aloud using the browser's
  // built-in Web Speech API (no extra API calls, works offline).
  const speakSummary = useCallback((summary) => {
    if (!("speechSynthesis" in window)) {
      showToast("⚠️ Voice reading isn't supported in this browser");
      return;
    }
    window.speechSynthesis.cancel();
    const text = summary.title + ". " +
      summary.bullets.map((b, i) => "Point " + (i + 1) + ": " + b + ".").join(" ");
    const utter = new window.SpeechSynthesisUtterance(text);
    utter.rate = 0.98;
    utter.pitch = 1;
    utter.onend = () => { setSpeakingId(null); setSpeechPaused(false); };
    utter.onerror = () => { setSpeakingId(null); setSpeechPaused(false); };
    window.speechSynthesis.speak(utter);
    setSpeakingId(summary.id);
    setSpeechPaused(false);
  }, []);

  const togglePauseSpeech = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      setSpeechPaused(true);
    } else if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setSpeechPaused(false);
    }
  }, []);

  const stopSpeech = useCallback(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeakingId(null);
    setSpeechPaused(false);
  }, []);

  // Parses Groq's rate-limit reset headers, e.g. "7.66s" or "500ms", into milliseconds.
  function parseGroqResetMs(value) {
    if (!value) return 0;
    const v = String(value).trim();
    if (v.endsWith("ms")) return parseFloat(v) || 0;
    if (v.endsWith("s")) return (parseFloat(v) || 0) * 1000;
    return (parseFloat(v) || 0) * 1000;
  }

  // Core reusable Groq call: turns a SLICE of a roadmap (rangeStart..rangeEnd,
  // out of totalDaysForProportion overall) into { day: task } entries, using
  // small 10-day sub-batches with rate-limit-aware pacing/retry so a single
  // page (not the whole roadmap) never risks the "request too large" error.
  async function groqGenerateDayRangeChunked(GROQ_KEY, sourceText, totalDaysForProportion, rangeStart, rangeEnd, onProgress) {
    const BATCH_SIZE = 10;
    const byDay = {};
    let tokensRemaining = null;
    let nextWaitMs = 0;
    const MAX_RETRIES = 4;

    for (let batchStart = rangeStart; batchStart <= rangeEnd; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, rangeEnd);
      const batchDays = batchEnd - batchStart + 1;

      const sliceStart = Math.max(0, Math.floor(((batchStart - 1) / totalDaysForProportion) * sourceText.length) - 150);
      const sliceEnd = Math.min(sourceText.length, Math.floor((batchEnd / totalDaysForProportion) * sourceText.length) + 150);
      let chunkText = sourceText.slice(sliceStart, sliceEnd).trim();
      if (!chunkText) chunkText = sourceText.slice(0, 1200);
      chunkText = chunkText.slice(0, 1800);

      const sysPrompt =
        "You convert part of a learning/project roadmap document into a strict day-by-day plan and output ONLY a raw JSON array — no markdown, no code fences, no explanation.\n" +
        "This batch must have EXACTLY " + batchDays + " entries, for days " + batchStart + " to " + batchEnd + " of a " + totalDaysForProportion + "-day roadmap overall, in order.\n" +
        "Each array item must be an object with exactly these fields:\n" +
        '  "day": integer day number (' + batchStart + " to " + batchEnd + ")\n" +
        '  "task": one short, specific, actionable mini-task for that day (max ~15 words)\n' +
        "The text below is roughly the portion of the roadmap relevant to these days — use it, and if it runs out, continue with the natural next step in the topic.\n" +
        "Never leave a day empty.";

      const estMaxTokens = Math.min(700, 120 + batchDays * 30);
      const estInputTokens = Math.ceil((chunkText.length + sysPrompt.length) / 4) + 50;
      const estNeeded = estInputTokens + estMaxTokens;

      if (tokensRemaining !== null && tokensRemaining < estNeeded) {
        if (onProgress) onProgress("Waiting for Groq's per-minute limit to reset…");
        await new Promise(res => setTimeout(res, nextWaitMs || 15000));
      }

      if (onProgress) onProgress("Building days " + batchStart + "–" + batchEnd + " of " + rangeEnd + "…");

      let attempt = 0;
      while (attempt <= MAX_RETRIES) {
        let r;
        try {
          r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + GROQ_KEY,
            },
            body: JSON.stringify({
              model: "llama-3.1-8b-instant",
              max_tokens: estMaxTokens,
              temperature: 0.3,
              messages: [
                { role: "system", content: sysPrompt },
                { role: "user",   content: chunkText },
              ],
            }),
          });
        } catch (netErr) {
          console.warn("Roadmap batch network error:", netErr.message);
          break; // fall through — those days keep their fallback task
        }

        const remHeader   = r.headers.get("x-ratelimit-remaining-tokens");
        const resetHeader = r.headers.get("x-ratelimit-reset-tokens");
        nextWaitMs = parseGroqResetMs(resetHeader) + 800;
        tokensRemaining = remHeader !== null ? parseInt(remHeader, 10) : null;

        if (r.status === 429) {
          const retryAfterHeader = r.headers.get("retry-after");
          const retryMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : nextWaitMs;
          attempt += 1;
          if (attempt > MAX_RETRIES) {
            return { byDay, error: "Groq rate limit hit repeatedly — try upgrading to Dev tier or a smaller page size" };
          }
          if (onProgress) onProgress("Groq rate limit — retrying in " + Math.ceil(retryMs / 1000) + "s…");
          await new Promise(res => setTimeout(res, Math.max(retryMs, 1000)));
          continue;
        }

        let d;
        try { d = await r.json(); } catch (e) { d = {}; }

        if (d.error) {
          return { byDay, error: "Groq error: " + d.error.message };
        }

        let raw = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
        raw = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();

        let items;
        try { items = JSON.parse(raw); } catch (e) { items = []; }
        if (Array.isArray(items)) {
          items.forEach(it => {
            const dayNum = parseInt(it && it.day, 10);
            const task = (it && it.task ? String(it.task) : "").trim();
            if (dayNum >= batchStart && dayNum <= batchEnd && task) byDay[dayNum] = task;
          });
        }
        break; // success — move to next batch
      }
    }
    return { byDay, error: null };
  }

  // One small, one-shot Groq call that pulls 5-8 topic/skill keywords out
  // of the roadmap text (e.g. "React", "REST APIs", "MongoDB"). Kept to a
  // tiny max_tokens since this never needs to run again for this roadmap —
  // the resulting topics are turned into real platform links locally
  // (see buildResourceLinks), so no further AI calls or token spend happen
  // when the user browses resources.
  async function extractRoadmapTopics(GROQ_KEY, sourceText, roadmapName) {
    try {
      const sysPrompt =
        "Extract the 5 to 8 core skills/technologies/subjects taught in this roadmap.\n" +
        "Output ONLY a raw JSON array of short strings (1-3 words each, e.g. \"React\", \"REST APIs\"). " +
        "No markdown, no explanation, no duplicates.";
      const snippet = (roadmapName ? roadmapName + "\n" : "") + sourceText.slice(0, 2500);
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + GROQ_KEY,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 150,
          temperature: 0.2,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user",   content: snippet },
          ],
        }),
      });
      const d = await r.json();
      if (d.error) return [];
      let raw = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
      raw = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
      let items;
      try { items = JSON.parse(raw); } catch (e) { items = []; }
      if (!Array.isArray(items)) return [];
      return items
        .map(t => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 8);
    } catch (e) {
      return []; // resources are a bonus, never block the roadmap itself
    }
  }

  // Upload a roadmap/plan file — same supported formats as task import.
  // To dodge Groq's token limits for good (instead of just working around
  // them with retries), the roadmap is split into PAGES:
  //   • even total days  → auto-split into 2 equal pages
  //   • odd total days   → user picks their own days-per-page
  // Only page 1 is generated up front (small, fast, well under any token
  // limit). Later pages are generated lazily — automatically once the
  // current page's days are all checked off, or manually via "Unlock next
  // page" — so the AI is never asked to build the whole roadmap in one go.
  async function importRoadmapFromFile(file) {
    if (!user || rmImporting) return;
    const totalDays = Math.max(1, Math.min(180, parseInt(rmTotalDays, 10) || 100));
    const startDate = rmStartDate || getTodayStr();
    const isOdd = totalDays % 2 !== 0;
    const pageSize = isOdd
      ? Math.max(1, Math.min(totalDays, parseInt(rmPageSize, 10) || Math.ceil(totalDays / 2)))
      : totalDays / 2;
    const totalPages = Math.max(1, Math.ceil(totalDays / pageSize));

    setRmImporting(true);
    setRmProgress("");
    try {
      const rawText = await extractTextFromFile(file);
      const trimmed = (rawText || "").slice(0, 12000);
      if (!trimmed.trim()) {
        showToast("⚠️ Couldn't find any readable text in that file");
        setRmImporting(false);
        return;
      }

      const GROQ_KEY = process.env.REACT_APP_GROQ_API_KEY;
      if (!GROQ_KEY || GROQ_KEY === "your_groq_key_here") {
        showToast("⚠️ Groq API key not set — can't read the file");
        setRmImporting(false);
        return;
      }

      const page1End = Math.min(pageSize, totalDays);
      const { byDay, error } = await groqGenerateDayRangeChunked(
        GROQ_KEY, trimmed, totalDays, 1, page1End, (msg) => setRmProgress(msg)
      );
      if (error) {
        showToast("⚠️ " + error);
        setRmImporting(false);
        setRmProgress("");
        return;
      }

      // Page 1 gets real tasks; the rest stay locked placeholders until unlocked.
      let lastTask = "Review and practice what you've covered so far";
      const days = [];
      for (let day = 1; day <= totalDays; day++) {
        if (day <= page1End) {
          const task = byDay[day] || lastTask;
          lastTask = byDay[day] || lastTask;
          days.push({ day, date: addDaysFromDate(startDate, day - 1), task, done: false, generated: true });
        } else {
          days.push({ day, date: addDaysFromDate(startDate, day - 1), task: null, done: false, generated: false });
        }
      }

      const id = String(Date.now());
      const name = rmName.trim() || file.name.replace(/\.[^.]+$/, "");
      const roadmapDoc = {
        name, sourceFileName: file.name, startDate, totalDays,
        pageSize, totalPages, currentPage: 1,
        sourceText: trimmed, // kept so later pages can be generated without re-uploading
        createdAt: Date.now(), days,
        topics: [], topicsLoading: true,
      };
      await setDoc(doc(db, "users", user.uid, "roadmaps", id), roadmapDoc);
      flashSaved();
      showToast("✅ Page 1 of " + totalPages + " ready (" + page1End + " days) — the rest unlock as you complete each page");
      setRmName("");
      setRmPageSize("");

      // Fire-and-forget: find topics → build Resources, without holding up
      // page 1 or spending any extra tokens beyond this one small call.
      extractRoadmapTopics(GROQ_KEY, trimmed, name).then(async (topics) => {
        try {
          await setDoc(doc(db, "users", user.uid, "roadmaps", id),
            { topics, topicsLoading: false }, { merge: true });
        } catch (e) { /* resources are a bonus — silently skip on failure */ }
      });
    } catch (err) {
      showToast("⚠️ Couldn't read that file: " + err.message);
    }
    setRmProgress("");
    setRmImporting(false);
  }

  // Generates one page's worth of day-tasks on demand (auto-triggered when
  // the previous page is fully checked off, or manually via the "Unlock
  // next page" button) and merges them into the roadmap doc.
  const generateRoadmapPage = useCallback(async (roadmapId, pageIndex) => {
    if (!user) return;
    setRmGeneratingIds(prev => {
      if (prev.has(roadmapId)) return prev;
      const next = new Set(prev); next.add(roadmapId); return next;
    });
    try {
      const r = roadmaps.find(x => x.id === roadmapId);
      if (!r || pageIndex > (r.totalPages || 1) || pageIndex <= (r.currentPage || 1)) return;

      const GROQ_KEY = process.env.REACT_APP_GROQ_API_KEY;
      if (!GROQ_KEY || GROQ_KEY === "your_groq_key_here") {
        showToast("⚠️ Groq API key not set — can't unlock the next page");
        return;
      }

      const pageSize = r.pageSize || r.totalDays;
      const rangeStart = (pageIndex - 1) * pageSize + 1;
      const rangeEnd = Math.min(pageIndex * pageSize, r.totalDays);
      const { byDay, error } = await groqGenerateDayRangeChunked(
        GROQ_KEY, r.sourceText || "", r.totalDays, rangeStart, rangeEnd, null
      );
      if (error) {
        showToast("⚠️ " + error);
        return;
      }

      let lastTask = "Review and practice what you've covered so far";
      const prevDay = r.days[rangeStart - 2];
      if (prevDay && prevDay.task) lastTask = prevDay.task;

      const newDays = r.days.map((d, i) => {
        const dayNum = i + 1;
        if (dayNum >= rangeStart && dayNum <= rangeEnd) {
          const task = byDay[dayNum] || lastTask;
          lastTask = byDay[dayNum] || lastTask;
          return { ...d, task, generated: true };
        }
        return d;
      });

      await setDoc(doc(db, "users", user.uid, "roadmaps", roadmapId), {
        name: r.name, sourceFileName: r.sourceFileName, startDate: r.startDate,
        totalDays: r.totalDays, pageSize: r.pageSize, totalPages: r.totalPages,
        currentPage: pageIndex, sourceText: r.sourceText, createdAt: r.createdAt,
        days: newDays,
        topics: r.topics || [], topicsLoading: !!r.topicsLoading,
      });
      flashSaved();
      showToast("✅ Page " + pageIndex + " of " + r.totalPages + " unlocked!");
    } catch (e) {
      showToast("⚠️ Couldn't unlock next page — check connection");
    } finally {
      setRmGeneratingIds(prev => {
        const next = new Set(prev); next.delete(roadmapId); return next;
      });
    }
  }, [user, roadmaps, flashSaved]);

  const unlockNextRoadmapPage = useCallback((roadmapId) => {
    const r = roadmaps.find(x => x.id === roadmapId);
    if (!r) return;
    generateRoadmapPage(roadmapId, (r.currentPage || 1) + 1);
  }, [roadmaps, generateRoadmapPage]);

  const toggleRoadmapDay = useCallback(async (roadmapId, dayIdx) => {
    if (!user) return;
    const r = roadmaps.find(x => x.id === roadmapId);
    if (!r) return;
    const days = (r.days || []).map((d, i) => i === dayIdx ? { ...d, done: !d.done } : d);
    try {
      await setDoc(doc(db, "users", user.uid, "roadmaps", roadmapId), {
        name: r.name, sourceFileName: r.sourceFileName, startDate: r.startDate,
        totalDays: r.totalDays, pageSize: r.pageSize, totalPages: r.totalPages,
        currentPage: r.currentPage, sourceText: r.sourceText, createdAt: r.createdAt,
        days,
        topics: r.topics || [], topicsLoading: !!r.topicsLoading,
      });
      flashSaved();

      // If that was the last day of the current page, automatically unlock the next one.
      const pageSize = r.pageSize || r.totalDays;
      const currentPage = r.currentPage || 1;
      const totalPages = r.totalPages || 1;
      const pageStart = (currentPage - 1) * pageSize;
      const pageEnd = Math.min(currentPage * pageSize, r.totalDays);
      const pageSlice = days.slice(pageStart, pageEnd);
      const pageFullyDone = pageSlice.length > 0 && pageSlice.every(d => d.done);
      if (pageFullyDone && currentPage < totalPages) {
        generateRoadmapPage(roadmapId, currentPage + 1);
      }
    } catch (e) {
      showToast("⚠️ Couldn't update — check connection");
    }
  }, [user, roadmaps, flashSaved, generateRoadmapPage]);

  const deleteRoadmap = useCallback(async (id) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, "users", user.uid, "roadmaps", id));
      flashSaved();
    } catch (e) {
      showToast("⚠️ Couldn't delete — check connection");
    }
  }, [user, flashSaved]);

  // Fixes the "Resources not showing" bug: roadmaps created before the
  // Resources feature existed (or where the one-shot topic extraction
  // silently failed — no key, rate limit, offline, etc.) are left with
  // topics:[] forever, since nothing ever retried it. This lets the
  // Resources panel fetch/re-fetch topics on demand for ANY roadmap,
  // old or new, instead of relying only on the fire-and-forget call
  // made at upload time.
  const refreshRoadmapTopics = useCallback(async (roadmapId) => {
    if (!user) return;
    const r = roadmaps.find(x => x.id === roadmapId);
    if (!r) return;
    if (!r.sourceText) {
      showToast("⚠️ No source text saved for this roadmap — re-upload the file to get resources");
      return;
    }
    const GROQ_KEY = process.env.REACT_APP_GROQ_API_KEY;
    if (!GROQ_KEY || GROQ_KEY === "your_groq_key_here") {
      showToast("⚠️ Groq API key not set — can't find topics");
      return;
    }
    try {
      await setDoc(doc(db, "users", user.uid, "roadmaps", roadmapId),
        { topicsLoading: true }, { merge: true });
      const topics = await extractRoadmapTopics(GROQ_KEY, r.sourceText, r.name);
      await setDoc(doc(db, "users", user.uid, "roadmaps", roadmapId),
        { topics, topicsLoading: false }, { merge: true });
      if (!topics || topics.length === 0) {
        showToast("⚠️ Couldn't detect any topics for this roadmap");
      }
    } catch (e) {
      try {
        await setDoc(doc(db, "users", user.uid, "roadmaps", roadmapId),
          { topicsLoading: false }, { merge: true });
      } catch (_) { /* ignore */ }
      showToast("⚠️ Couldn't find topics — check connection");
    }
  }, [user, roadmaps]);

  const formProps = {
    taskInput, setTaskInput,
    priority,  setPriority,
    dueDate,   setDueDate,
    dueTime,   setDueTime,
    repeat,    setRepeat,
    repeatDays, setRepeatDays,
    onAdd: addTask,
    pct, done, total,
  };

  const roadmapProps = {
    roadmaps, roadmapsLoading,
    importing: rmImporting, rmProgress, fileInputRef: rmFileInputRef,
    rmName, setRmName, rmStartDate, setRmStartDate, rmTotalDays, setRmTotalDays,
    rmPageSize, setRmPageSize,
    generatingIds: rmGeneratingIds,
    onImportFile: importRoadmapFromFile,
    onToggleDay: toggleRoadmapDay,
    onDelete: deleteRoadmap,
    onUnlockNextPage: unlockNextRoadmapPage,
    onRefreshTopics: refreshRoadmapTopics,
  };

  const gcalProps = {
    upcoming, notifStatus, onRequestNotif: requestNotifPermission,
    gcalConnected, gcalEmail, gcalAutoSync, gcalSyncing, gcalConnecting, gcalLastSync,
    onConnectGcal: connectGoogleCalendar, onDisconnectGcal: disconnectGoogleCalendar,
    onSyncNowGcal: syncAllTasksToGcal, onToggleAutoSync: toggleGcalAutoSync,
  };

  const chatProps = {
    aiMessages, aiLoading, aiInput, setAiInput, onAsk: askAI, chatRef,
    onImportFile: importTasksFromFile, importing, fileInputRef,
    onAttachFile: summarizeFileFromFile, attaching: sumImporting, attachProgress: sumProgress,
    attachFileInputRef: sumFileInputRef,
    speakingId, speechPaused, onSpeak: speakSummary,
    onTogglePause: togglePauseSpeech, onStop: stopSpeech,
  };

  const openAddModal = () => { setShowAdd(true); };

  // "Add file" on the My Files card jumps straight into Chat and pops the
  // (+) menu's attach picker, instead of opening a separate Summarize tab.
  const openChatToAttach = (goDesktop) => {
    if (goDesktop) setDeskScreen("messages"); else setScreen("ai");
    setTimeout(() => {
      if (sumFileInputRef.current) sumFileInputRef.current.click();
    }, 150);
  };

  return (
    <div className="dharani-root" data-theme={theme}>
      <div className="bg-ambience">
        <div className="bg-gradient" />
        <div className="bg-glow" />
      </div>

      {showAdd && (
        <AddModal {...formProps} onClose={() => setShowAdd(false)} />
      )}

      {showProfile && (
        <ProfileModal user={user} onClose={() => setShowProfile(false)} onToast={showToast}
          nickname={nickname} dob={dob} onSaveMeta={saveProfileMeta}
          photoDataUrl={photoDataUrl} />
      )}

      {openFile && (
        <FileDetailModal file={openFile} onClose={() => setOpenFile(null)}
          onDelete={deleteSummary} speakingId={speakingId} speechPaused={speechPaused}
          onSpeak={speakSummary} onTogglePause={togglePauseSpeech} onStop={stopSpeech} />
      )}

      {/* ── MOBILE header (unchanged experience on phones) ── */}
      <div className="wrap mobile-only-wrap">
        <header className="header">
          <div className="logo">
            <div className="logo-mark">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M4 12l4 6 4-11 4 11 4-6" stroke="#0a0e1a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <div className="logo-name"><span className="logo-word-work">WORK</span> <span className="logo-word-flow">FLOW</span></div>
              <div className="logo-sub">Task Intelligence</div>
            </div>
          </div>
          <div className="header-right">
            {saveFlash && (
              <div className="save-indicator">
                <div className="save-dot" /><span>SAVED</span>
              </div>
            )}
            <div className="clock">{clock}</div>
            <div className="stats-badge">{pct}% done</div>
            <button className="profile-btn" title="Profile" onClick={() => setShowProfile(true)}>
              <Avatar user={user} size={30} photoDataUrl={photoDataUrl} />
            </button>
          </div>
        </header>

        {/* Mobile screens (all existing behaviour, untouched) */}
        <div className="mobile-layout">
          {screen === "tasks" && (
            <>
              <FilterTabs tab={tab} setTab={setTab} />
              <TaskList filtered={filtered} onToggle={toggleTask} onDelete={deleteTask} />
              <RoadmapPreviewCard
                roadmaps={roadmaps} roadmapsLoading={roadmapsLoading}
                onOpenRoadmap={() => setScreen("roadmap")}
                onToggleDay={toggleRoadmapDay}
                mobile
              />
            </>
          )}
          {screen === "ai" && (
            <ChatPanel {...chatProps} />
          )}
          {screen === "roadmap" && (
            <RoadmapPanel {...roadmapProps} />
          )}
          {screen === "reminders" && (
            <RemindersPanel {...gcalProps} />
          )}
          {screen === "stats" && (
            <StatsPanel total={total} done={done} pending={pending}
              highCount={highCount} pct={pct} />
          )}
        </div>
      </div>

      <BottomNav screen={screen} setScreen={setScreen} onAdd={() => setShowAdd(true)} />

      {/* ── DESKTOP app shell: sidebar + topbar + content ── */}
      <div className={"app-shell" + (sidebarCollapsed ? " sidebar-collapsed" : "")}>
        {!sidebarCollapsed && (
          <Sidebar
            deskScreen={deskScreen} setDeskScreen={setDeskScreen}
            onSettings={() => setShowProfile(true)}
            onCollapse={() => setSidebarCollapsed(true)}
          />
        )}

        <div className="main-area">
          <TopBar
            deskScreen={deskScreen} setDeskScreen={setDeskScreen}
            upcoming={upcoming}
            showNotifPanel={showNotifPanel} setShowNotifPanel={setShowNotifPanel}
            user={user} onProfile={() => setShowProfile(true)} photoDataUrl={photoDataUrl}
          />

          {deskScreen === "dashboard" && (
            <div className="dashboard-grid">
              <div className="dashboard-center">
                <div className="dashboard-center-head">
                  <FilterTabs tab={tab} setTab={setTab} />
                  <button className="btn-red new-task-btn" onClick={() => openAddModal()}>
                    <Icon d={ICONS.add} size={15} />New task
                  </button>
                </div>
                <TaskList filtered={filtered} onToggle={toggleTask} onDelete={deleteTask} />
              </div>
              <div className="dashboard-side">
                <RoadmapPreviewCard
                  roadmaps={roadmaps} roadmapsLoading={roadmapsLoading}
                  onOpenRoadmap={() => setDeskScreen("roadmap")}
                  onToggleDay={toggleRoadmapDay}
                />
                <NotesCard
                  noteText={noteText} noteEditing={noteEditing} setNoteEditing={setNoteEditing}
                  noteDraft={noteDraft} setNoteDraft={setNoteDraft} noteSaving={noteSaving}
                  noteUpdatedAt={noteUpdatedAt} onSave={saveNote}
                />
                <MyFilesCard
                  summaries={summaries} summariesLoading={summariesLoading}
                  onAddFile={() => openChatToAttach(true)}
                  onOpenFile={setOpenFile}
                />
              </div>
            </div>
          )}

          {deskScreen === "tasks" && (
            <div className="tasks-screen">
              <div className="dashboard-center-head">
                <FilterTabs tab={tab} setTab={setTab} />
                <button className="btn-red new-task-btn" onClick={() => openAddModal()}>
                  <Icon d={ICONS.add} size={15} />New task
                </button>
              </div>
              <TaskList filtered={filtered} onToggle={toggleTask} onDelete={deleteTask} />
            </div>
          )}

          {deskScreen === "messages" && (
            <div className="single-screen">
              <ChatPanel {...chatProps} />
            </div>
          )}

          {deskScreen === "activity" && (
            <div className="single-screen">
              <StatsPanel total={total} done={done} pending={pending}
                highCount={highCount} pct={pct} />
            </div>
          )}

          {deskScreen === "calendar" && (
            <div className="single-screen">
              <RemindersPanel {...gcalProps} />
            </div>
          )}

          {deskScreen === "roadmap" && (
            <div className="single-screen">
              <RoadmapPanel {...roadmapProps} />
            </div>
          )}
        </div>
      </div>

      {sidebarCollapsed && (
        <DesktopDockNav
          deskScreen={deskScreen} setDeskScreen={setDeskScreen}
          onSettings={() => setShowProfile(true)}
          onExpand={() => setSidebarCollapsed(false)}
        />
      )}

      <div className={"toast " + (toast.visible ? "visible" : "hidden")}>
        {toast.msg}
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser]       = useState(undefined); // undefined = loading
  const [showLanding, setShowLanding] = useState(() => {
    try { return sessionStorage.getItem("wf-skip-landing") !== "1"; } catch { return true; }
  });
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u || null));
    return () => unsub();
  }, []);

  if (user === undefined) {
    return (
      <div className="wf-loading-screen">
        <div className="wf-loading-mark">W</div>
        <div className="wf-loading-text">Loading WORK FLOW…</div>
      </div>
    );
  }

  if (!user) {
    if (showLanding) {
      return (
        <ErrorBoundary>
          <LandingPage onEnter={() => {
            try { sessionStorage.setItem("wf-skip-landing", "1"); } catch {}
            setShowLanding(false);
          }} />
        </ErrorBoundary>
      );
    }
    return (
      <ErrorBoundary>
        <Login onBackToLanding={() => setShowLanding(true)} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppInner user={user} key={user.uid} />
    </ErrorBoundary>
  );
}
