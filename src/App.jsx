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
  bell:  "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9",
  stats: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  add:   "M12 4v16m8-8H4",
  check: "M5 13l4 4L19 7",
  close: "M6 18L18 6M6 6l12 12",
};

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

const AIPanel = ({ aiMessages, aiLoading, aiInput, setAiInput, onAsk, chatRef,
                   onImportFile, importing, fileInputRef }) => (
  <div className="card-red">
    <div className="panel-label red">
      <div className="panel-dot" />AI Intel
    </div>
    <div className="ai-chat" ref={chatRef}>
      {aiMessages.map((m, i) => (
        <div key={i} className={m.role === "ai" ? "ai-bubble" : "user-bubble"}>
          <SafeMessage text={m.text} />
        </div>
      ))}
      {(aiLoading || importing) && (
        <div className="ai-bubble">
          <span className="dot1" /><span className="dot2" /><span className="dot3" />
        </div>
      )}
    </div>
    <div className="ai-input-row">
      <input className="input-dark" placeholder="Ask AI..."
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
      className="qp-btn import-btn"
      style={{ width: "100%", marginTop: "8px" }}
      disabled={importing}
      onClick={() => fileInputRef.current && fileInputRef.current.click()}
    >
      {importing ? "📁 Reading file & adding tasks…" : "📁 Upload plan (txt/pdf/excel/word) → auto-add tasks"}
    </button>
  </div>
);

// ─── NOTIFICATION PERMISSION BANNER ───────────────────────
const NotifPermissionBanner = ({ onRequest, status }) => {
  if (status === "granted" || status === "denied" || !("Notification" in window)) return null;
  return (
    <button className="notif-permission-btn" onClick={onRequest}>
      🔔 Enable push notifications for task reminders
    </button>
  );
};

const RemindersPanel = ({ upcoming, notifStatus, onRequestNotif }) => (
  <div className="card-dark">
    <div className="panel-label gray">
      ⏰ Reminders
      <span className="panel-hint">auto every min</span>
    </div>
    <NotifPermissionBanner status={notifStatus} onRequest={onRequestNotif} />
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
            <div className="panel-dot" />New Task
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

const NAV_ITEMS = [
  { id:"tasks",     label:"Tasks"  },
  { id:"ai",        label:"AI"     },
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

  const chatRef        = useRef(null);
  const saveTimer      = useRef(null);
  const desktopInpRef  = useRef(null);
  const fileInputRef   = useRef(null);

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

  // Fire a push notification
  const fireNotification = useCallback((title, body) => {
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, {
          body,
          icon: "/favicon.ico",
          badge: "/favicon.ico",
          tag: "workflow-reminder",
          renotify: true,
          requireInteraction: false,
        });
      } catch (e) {
        // Notification API not available (e.g. in some mobile browsers)
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
        await setDoc(doc(db, "users", user.uid, "tasks", id), { ...t, done: !t.done });
      }
      flashSaved();
    } catch (e) {
      showToast("⚠️ Couldn't update — check connection");
    }
  }, [user, tasks, flashSaved]);

  const deleteTask = useCallback(async (id) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, "users", user.uid, "tasks", id));
      flashSaved();
    } catch (e) {
      showToast("⚠️ Couldn't delete — check connection");
    }
  }, [user, flashSaved]);

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

  return (
    <div className="dharani-root">
      <div className="bg-ambience">
        <div className="bg-gradient" />
        <div className="bg-glow" />
      </div>

      {showAdd && (
        <AddModal {...formProps} onClose={() => setShowAdd(false)} />
      )}

      <div className="wrap">
        {/* Header */}
        <header className="header">
          <div className="logo">
            <div className="logo-diamond" />
            <div>
              <div className="logo-name">WORK FLOW</div>
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
            <button className="del-btn" title="Sign out" onClick={() => signOut(auth)}>
              <Icon d={ICONS.close} size={16} />
            </button>
          </div>
        </header>

        {/* Desktop */}
        <div className="desktop-layout">
          <div className="left-col">
            <div className="card-red">
              <AddForm {...formProps} inputRef={desktopInpRef} />
            </div>
            <FilterTabs tab={tab} setTab={setTab} />
            <TaskList filtered={filtered} onToggle={toggleTask} onDelete={deleteTask} />
          </div>
          <div className="right-col">
            <AIPanel
              aiMessages={aiMessages} aiLoading={aiLoading}
              aiInput={aiInput} setAiInput={setAiInput}
              onAsk={askAI} chatRef={chatRef}
              onImportFile={importTasksFromFile} importing={importing} fileInputRef={fileInputRef}
            />
            <RemindersPanel
              upcoming={upcoming}
              notifStatus={notifStatus}
              onRequestNotif={requestNotifPermission}
            />
            <StatsPanel total={total} done={done} pending={pending}
              highCount={highCount} pct={pct} />
          </div>
        </div>

        {/* Mobile */}
        <div className="mobile-layout">
          {screen === "tasks" && (
            <>
              <FilterTabs tab={tab} setTab={setTab} />
              <TaskList filtered={filtered} onToggle={toggleTask} onDelete={deleteTask} />
            </>
          )}
          {screen === "ai" && (
            <AIPanel
              aiMessages={aiMessages} aiLoading={aiLoading}
              aiInput={aiInput} setAiInput={setAiInput}
              onAsk={askAI} chatRef={chatRef}
              onImportFile={importTasksFromFile} importing={importing} fileInputRef={fileInputRef}
            />
          )}
          {screen === "reminders" && (
            <RemindersPanel
              upcoming={upcoming}
              notifStatus={notifStatus}
              onRequestNotif={requestNotifPermission}
            />
          )}
          {screen === "stats" && (
            <StatsPanel total={total} done={done} pending={pending}
              highCount={highCount} pct={pct} />
          )}
        </div>
      </div>

      <BottomNav screen={screen} setScreen={setScreen} onAdd={() => setShowAdd(true)} />

      <div className={"toast " + (toast.visible ? "visible" : "hidden")}>
        {toast.msg}
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser]       = useState(undefined); // undefined = loading
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u || null));
    return () => unsub();
  }, []);

  if (user === undefined) {
    return (
      <div style={{
        minHeight: "100vh", background: "#000", color: "#888",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "monospace", fontSize: 14,
      }}>
        Loading WORK FLOW…
      </div>
    );
  }

  if (!user) {
    return (
      <ErrorBoundary>
        <Login />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppInner user={user} key={user.uid} />
    </ErrorBoundary>
  );
}
