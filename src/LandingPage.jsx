import React from "react";

/* ─────────────────────────────────────────────────────────
   Premium marketing landing page — same navy / blue / gold
   design language as the dashboard and the auth screens.
   Shown before sign-in; "Get Started" / "Sign In" both drop
   the visitor into the Login screen.
───────────────────────────────────────────────────────── */

const LogoMark = ({ size = 32 }) => (
  <div className="logo-mark" style={{ width: size, height: size }}>
    <svg width={size * 0.65} height={size * 0.65} viewBox="0 0 24 24" fill="none">
      <path d="M4 12l4 6 4-11 4 11 4-6" stroke="#0a0e1a" strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </div>
);

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const FEATURES = [
  {
    icon: "⚡",
    title: "AI task import",
    text: "Drop in a plan file — PDF, Word, Excel, or text — and Groq AI turns it into dated, prioritized tasks automatically.",
  },
  {
    icon: "🗺️",
    title: "Roadmap builder",
    text: "Upload a learning roadmap and get it split into daily mini-tasks, page by page, with linked free & paid resources.",
  },
  {
    icon: "📄",
    title: "Doc summaries",
    text: "Summarize any document into clean bullet points, then listen with built-in read-aloud voice mode.",
  },
  {
    icon: "🔄",
    title: "Real-time sync",
    text: "Every task, roadmap, and summary syncs instantly across your laptop and phone — never lose your place.",
  },
];

export default function LandingPage({ onEnter }) {
  return (
    <div className="lp-root">
      <div className="lp-bg-glow" />

      {/* ── Nav ── */}
      <nav className="lp-nav">
        <div className="logo">
          <LogoMark size={32} />
          <div>
            <div className="logo-name"><span className="logo-word-work">WORK</span> <span className="logo-word-flow">FLOW</span></div>
            <div className="logo-sub">Task Intelligence</div>
          </div>
        </div>
        <div className="lp-nav-links">
          <a href="#features" className="lp-nav-link">Features</a>
          <a href="#how" className="lp-nav-link">How it works</a>
        </div>
        <div className="lp-nav-actions">
          <button className="lp-btn-ghost" onClick={onEnter}>Sign In</button>
          <button className="lp-btn-primary" onClick={onEnter}>Get Started</button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <header className="lp-hero">
        <div className="lp-hero-copy">
          <div className="lp-eyebrow">Built for students &amp; builders</div>
          <h1 className="lp-hero-title">
            Make Things <span className="lp-hero-accent">Simple</span>!
          </h1>
          <p className="lp-hero-text">
            WORK FLOW brings tasks, roadmaps, document summaries and reminders
            into one calm, premium workspace — synced across every device you own.
          </p>
          <div className="lp-hero-cta">
            <button className="lp-btn-primary lp-btn-lg" onClick={onEnter}>Get Started Free</button>
            <button className="lp-btn-ghost lp-btn-lg" onClick={onEnter}>Sign In</button>
          </div>
          <ul className="lp-hero-points">
            <li><CheckIcon /> No credit card required</li>
            <li><CheckIcon /> Works on low-end devices</li>
            <li><CheckIcon /> Real-time sync everywhere</li>
          </ul>
        </div>

        {/* Hero mock dashboard preview */}
        <div className="lp-hero-visual">
          <div className="lp-mock-card">
            <div className="lp-mock-header">
              <div className="lp-mock-dots">
                <span /><span /><span />
              </div>
              <div className="lp-mock-title">Dashboard</div>
            </div>
            <div className="lp-mock-body">
              <div className="lp-mock-row">
                <div className="lp-mock-pill lp-mock-pill-accent">Today</div>
                <div className="lp-mock-pill">Roadmap</div>
                <div className="lp-mock-pill">Docs</div>
              </div>
              <div className="lp-mock-task">
                <div className="lp-mock-check" />
                <div className="lp-mock-lines">
                  <div className="lp-mock-line w70" />
                  <div className="lp-mock-line w40" />
                </div>
              </div>
              <div className="lp-mock-task">
                <div className="lp-mock-check done" />
                <div className="lp-mock-lines">
                  <div className="lp-mock-line w80" />
                  <div className="lp-mock-line w30" />
                </div>
              </div>
              <div className="lp-mock-progress">
                <div className="lp-mock-progress-label">
                  <span>Weekly progress</span><span>70%</span>
                </div>
                <div className="lp-mock-progress-track">
                  <div className="lp-mock-progress-fill" />
                </div>
              </div>
              <div className="lp-mock-stat-row">
                <div className="lp-mock-stat">
                  <div className="lp-mock-stat-num">12</div>
                  <div className="lp-mock-stat-label">Tasks done</div>
                </div>
                <div className="lp-mock-stat">
                  <div className="lp-mock-stat-num">3</div>
                  <div className="lp-mock-stat-label">Roadmaps</div>
                </div>
              </div>
            </div>
          </div>
          <div className="lp-mock-float lp-mock-float-1">✓ Task synced</div>
          <div className="lp-mock-float lp-mock-float-2">📄 Summary ready</div>

          {/* Brand swatch cards — floating over the hero visual,
              same treatment as the reference screenshot */}
          <div className="lp-swatch-card lp-swatch-blue lp-swatch-1">
            <div className="lp-swatch-name">Work Hard</div>
            <div className="lp-swatch-hex">Stay Focus </div>
          </div>
          <div className="lp-swatch-card lp-swatch-porcelain lp-swatch-2">
            <div className="lp-swatch-name">Find your Goal!</div>
            <div className="lp-swatch-hex"> Work Discipline</div>
          </div>
        </div>
      </header>

      {/* ── Features ── */}
      <section className="lp-features" id="features">
        <h2 className="lp-section-title">Everything in one workspace</h2>
        <p className="lp-section-sub">A premium, distraction-free home for how you actually get things done.</p>
        <div className="lp-feature-grid">
          {FEATURES.map((f) => (
            <div className="lp-feature-card" key={f.title}>
              <div className="lp-feature-icon">{f.icon}</div>
              <div className="lp-feature-title">{f.title}</div>
              <div className="lp-feature-text">{f.text}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="lp-how" id="how">
        <h2 className="lp-section-title">Three steps to a clear day</h2>
        <div className="lp-steps">
          <div className="lp-step">
            <div className="lp-step-num">01</div>
            <div className="lp-step-title">Sign up in seconds</div>
            <div className="lp-step-text">Google sign-in or email — you're in and syncing instantly.</div>
          </div>
          <div className="lp-step">
            <div className="lp-step-num">02</div>
            <div className="lp-step-title">Import or add tasks</div>
            <div className="lp-step-text">Upload a plan file or add tasks by hand — AI handles the rest.</div>
          </div>
          <div className="lp-step">
            <div className="lp-step-num">03</div>
            <div className="lp-step-title">Stay in flow</div>
            <div className="lp-step-text">Reminders, roadmaps and summaries keep every device in sync.</div>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="lp-cta">
        <div className="lp-cta-card">
          <h2 className="lp-cta-title">Ready to make things simple?</h2>
          <p className="lp-cta-text">Join WORK FLOW and bring every task into one premium workspace.</p>
          <button className="lp-btn-primary lp-btn-lg" onClick={onEnter}>Get Started Free</button>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="logo">
          <LogoMark size={24} />
          <div className="logo-name" style={{ fontSize: 13 }}><span className="logo-word-work">WORK</span> <span className="logo-word-flow">FLOW</span></div>
        </div>
        <div className="lp-footer-text">© {new Date().getFullYear()} WORK FLOW. Built for focused work.</div>
      </footer>
    </div>
  );
}
