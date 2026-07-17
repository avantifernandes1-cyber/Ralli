import { useState, useEffect } from "react";

// Design tokens — exact from brand kit
const C = {
  bg: "#f3f1ec",         // cream — page surface
  bgCard: "#fbfaf7",     // off-white — card surface
  white: "#ffffff",
  dark: "#12181f",       // ink
  orange: "#f6a70f",     // amber
  orangeTint: "#fce3ab", // amber tint
  umber: "#8a6a4f",      // secondary text
  textMuted: "rgba(18,24,31,0.65)",
  textFaint: "rgba(18,24,31,0.4)",
  borderColor: "rgba(18,24,31,0.08)",
  green: "#4ade80",
  red: "#ef4444",
};
const border = `1px solid ${C.borderColor}`;
const F = { heading: "'Unbounded', sans-serif", body: "'Outfit', sans-serif" };

// ─── SVG Assets (no expiring URLs) ───────────────────────────────────────────

// Pinwheel mark: two rotated capsules ±45° with amber center cutout
// Used as standalone icon mark AND as the tittle above the ı in the wordmark
function PinwheelMark({ size = 30, bg = "#f6a70f", fg = "white" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="30" height="30" rx="7" fill={bg} />
      {/* Capsule 1 — rotated +45° */}
      <rect x="11" y="5" width="8" height="20" rx="4" fill={fg} transform="rotate(45 15 15)" />
      {/* Capsule 2 — rotated −45° */}
      <rect x="11" y="5" width="8" height="20" rx="4" fill={fg} transform="rotate(-45 15 15)" />
      {/* Amber center cutout — reveals the background through the overlap */}
      <rect x="11.5" y="11.5" width="7" height="7" rx="2" fill={bg} />
    </svg>
  );
}

// Ralli wordmark: "rall" + dotless ı (U+0131) in Unbounded 700
// Amber pinwheel replaces the tittle (dot) of the final ı — per brand spec
function RalliLogo({ height = 32 }) {
  const fs = Math.round(height * 0.75);
  const iconSize = Math.round(fs * 0.46);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", userSelect: "none", lineHeight: 1 }}>
      <span style={{
        fontFamily: F.heading, fontWeight: 700, fontSize: fs,
        color: C.dark, letterSpacing: "-0.01em", lineHeight: 1,
      }}>rall</span>
      <span style={{ position: "relative", display: "inline-block", lineHeight: 1 }}>
        {/* Dotless i — U+0131 */}
        <span style={{
          fontFamily: F.heading, fontWeight: 700, fontSize: fs,
          color: C.dark, letterSpacing: "-0.01em", lineHeight: 1,
        }}>ı</span>
        {/* Amber pinwheel as tittle, floated above the stem */}
        <span style={{
          position: "absolute",
          bottom: "100%",
          left: "50%",
          transform: "translateX(-20%)",
          marginBottom: 1,
          lineHeight: 0,
          display: "block",
        }}>
          <PinwheelMark size={iconSize} bg="#f6a70f" fg="white" />
        </span>
      </span>
    </div>
  );
}

// Lucide icon set — exact stroke icons used in Figma (book-open, refresh-cw, trending-up, arrow-right)
function IconBookOpen({ size = 24, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function IconRefreshCw({ size = 24, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function IconTrendingUp({ size = 24, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}

function IconArrowRight({ size = 12, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

// Avatar placeholder — used for leaderboard entries, rep profiles, testimonial
// Swap with real <img> when photos are available
function Avatar({ initials, size = 36, bg = "rgba(246,167,15,0.15)", color = "#8a6a4f" }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size / 2,
      background: bg, display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      <span style={{
        fontFamily: F.body, fontWeight: 700,
        fontSize: Math.max(10, Math.round(size * 0.35)),
        color, lineHeight: 1, userSelect: "none",
      }}>{initials}</span>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionLabel({ text }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      background: C.white, border, borderRadius: 99,
      padding: "6px 12px", alignSelf: "flex-start",
    }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.orange, flexShrink: 0 }} />
      <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 12, color: C.textMuted, textTransform: "lowercase", whiteSpace: "nowrap" }}>
        {text}
      </span>
    </div>
  );
}

function H({ children, size = 36, center = false, style = {} }) {
  return (
    <p style={{
      fontFamily: F.heading, fontWeight: 700, fontSize: size,
      color: C.dark, textTransform: "lowercase", lineHeight: 1.2,
      textAlign: center ? "center" : "left",
      ...style,
    }}>
      {children}
    </p>
  );
}

function P({ children, size = 16, center = false, faint = false, style = {} }) {
  return (
    <p style={{
      fontFamily: F.body, fontWeight: 400, fontSize: size,
      color: faint ? C.textFaint : C.textMuted, lineHeight: 1.5,
      textAlign: center ? "center" : "left",
      ...style,
    }}>
      {children}
    </p>
  );
}

function BtnPrimary({ children, onClick, type = "button", style = {} }) {
  return (
    <button type={type} onClick={onClick} style={{
      background: C.dark, color: C.white,
      fontFamily: F.body, fontWeight: 600, fontSize: 14,
      padding: "12px 24px", borderRadius: 8, border: "none",
      cursor: "pointer", whiteSpace: "nowrap",
      ...style,
    }}>
      {children}
    </button>
  );
}

function BtnSecondary({ children, onClick, style = {} }) {
  return (
    <button onClick={onClick} style={{
      background: C.white, color: C.dark,
      fontFamily: F.body, fontWeight: 600, fontSize: 14,
      padding: "12px 24px", borderRadius: 8, border,
      cursor: "pointer", whiteSpace: "nowrap",
      ...style,
    }}>
      {children}
    </button>
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{ background: C.bgCard, border, borderRadius: 16, padding: 32, ...style }}>
      {children}
    </div>
  );
}

const sec = { padding: "100px 80px", width: "100%" };

// ─── Nav ──────────────────────────────────────────────────────────────────────

function Nav({ navigate }) {
  return (
    <nav style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
      background: C.white, borderBottom: border, height: 72,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 80px",
    }}>
      <div style={{ cursor: "pointer" }} onClick={() => navigate("home")}>
        <RalliLogo height={30} />
      </div>

      <div style={{ display: "flex" }}>
        {[
          { page: "home", label: "features" },
          { page: "solution", label: "how it works" },
          { page: "contact", label: "pricing" },
        ].map(({ page, label }) => (
          <button key={page} onClick={() => navigate(page)} style={{
            fontFamily: F.body, fontWeight: 500, fontSize: 14,
            color: C.dark, background: "none", border: "none",
            padding: "8px 12px", cursor: "pointer", borderRadius: 6,
          }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <a href="/login" style={{ fontFamily: F.body, fontWeight: 500, fontSize: 14, color: C.dark, textDecoration: "none" }}>
          log in
        </a>
        <button onClick={() => navigate("contact")} style={{
          background: C.orange, color: C.dark,
          fontFamily: F.body, fontWeight: 600, fontSize: 14,
          padding: "10px 20px", borderRadius: 99, border: "none", cursor: "pointer",
        }}>
          book a demo
        </button>
      </div>
    </nav>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer style={{ background: C.white, borderTop: border, padding: "80px 80px 40px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 64 }}>
        <div style={{ width: 280 }}>
          <div style={{ marginBottom: 16 }}>
            <RalliLogo height={28} />
          </div>
          <P size={14}>
            the micro-learning sales enablement platform that replaces passive tracking with active retention loops.
          </P>
        </div>
        <div style={{ display: "flex", gap: 64 }}>
          {[
            { title: "product", links: ["features", "live games", "quizzes", "insights"] },
            { title: "company", links: ["about", "careers", "customers", "press"] },
            { title: "resources", links: ["blog", "help desk", "sales guides", "status"] },
          ].map(col => (
            <div key={col.title} style={{ display: "flex", flexDirection: "column", gap: 12, width: 120 }}>
              <span style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 12, color: C.dark, textTransform: "lowercase" }}>
                {col.title}
              </span>
              {col.links.map(l => (
                <span key={l} style={{ fontFamily: F.body, fontSize: 14, color: C.textMuted, cursor: "pointer" }}>{l}</span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: F.body, fontSize: 13, color: C.textFaint }}>© 2026 ralli tech inc. all rights reserved.</span>
        <div style={{ display: "flex", gap: 24 }}>
          {["privacy policy", "terms of service"].map(t => (
            <span key={t} style={{ fontFamily: F.body, fontSize: 13, color: C.textFaint, cursor: "pointer" }}>{t}</span>
          ))}
        </div>
      </div>
    </footer>
  );
}

// ─── CTA Banner ───────────────────────────────────────────────────────────────

function CTABanner({ navigate }) {
  return (
    <div style={{
      ...sec, padding: "120px 80px",
      background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.12) 40%, rgba(246,167,15,0.2))",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 32,
    }}>
      <H size={40} center style={{ maxWidth: 800 }}>guarantee comprehension, boost sales efficiency</H>
      <P size={18} center style={{ maxWidth: 560 }}>
        stop guessing if your team is ready. deploy smart evaluation paths and track real confidence indicators.
      </P>
      <div style={{ display: "flex", gap: 16 }}>
        <BtnPrimary onClick={() => navigate("contact")}>Get Started Free</BtnPrimary>
        <BtnSecondary onClick={() => navigate("contact")}>Talk to Sales</BtnSecondary>
      </div>
    </div>
  );
}

// ─── Home Page ────────────────────────────────────────────────────────────────

function HomePage({ navigate }) {
  const philosophyCards = [
    {
      Icon: IconBookOpen,
      title: "continuous calibration",
      body: "automated updates sync micro-lessons with every product update, keeping representatives perfectly aligned.",
    },
    {
      Icon: IconRefreshCw,
      title: "knowledge persistence",
      body: "smart repetition targets forgotten concepts over time, cementing comprehension forever.",
    },
    {
      Icon: IconTrendingUp,
      title: "real-time readiness",
      body: "always know who is ready to pitch. track individual comprehension progress over a dynamic learning arc.",
    },
  ];

  return (
    <>
      {/* Hero */}
      <div style={{
        ...sec, padding: "140px 80px 100px",
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.07) 40%, rgba(246,167,15,0.12))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 32,
      }}>
        {/* Badge */}
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: C.white, border, borderRadius: 99, padding: "6px 12px",
        }}>
          <div style={{
            background: C.orange, borderRadius: 99, padding: "2px 6px",
            fontFamily: F.body, fontWeight: 700, fontSize: 11, color: C.dark,
          }}>NEW</div>
          <span style={{ fontFamily: F.body, fontWeight: 500, fontSize: 13, color: C.textMuted }}>
            ralli games are now live — schedule a demo now
          </span>
          <IconArrowRight size={12} color={C.textMuted} />
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center", maxWidth: 800 }}>
          <H size={52} center style={{ lineHeight: 1.1 }}>comprehension instead of completion</H>
          <P size={18} center style={{ maxWidth: 640 }}>
            measuring readiness by defining comprehension instead of tracking completion checkboxes
          </P>
        </div>

        <div style={{ display: "flex", gap: 16 }}>
          <BtnPrimary onClick={() => navigate("contact")}>Get Started Free</BtnPrimary>
          <BtnSecondary onClick={() => navigate("contact")}>Talk to Sales</BtnSecondary>
        </div>
      </div>

      {/* Onboarding is just day one */}
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.06) 40%, rgba(246,167,15,0.1))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 64,
      }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: "100%" }}>
          <SectionLabel text="ongoing mastery" />
          <H size={36} center>onboarding is just day one</H>
          <P size={18} center style={{ maxWidth: 720 }}>
            enablement shouldn't expire after week two. ralli provides continuous, micro-sized knowledge loops to guarantee readiness through every market shift.
          </P>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24, width: "100%" }}>
          {philosophyCards.map(({ Icon, title, body }) => (
            <Card key={title} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{
                background: "rgba(246,167,15,0.1)", borderRadius: 8,
                width: 48, height: 48, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>
                <Icon size={24} color={C.orange} />
              </div>
              <H size={18} style={{ whiteSpace: "nowrap" }}>{title}</H>
              <P size={15}>{body}</P>
            </Card>
          ))}
        </div>
      </div>

      {/* Learning paths */}
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.08) 40%, rgba(246,167,15,0.13))",
        display: "flex", gap: 48, alignItems: "center",
      }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 24 }}>
          <SectionLabel text="structured learning paths" />
          <H size={36}>curated paths for fast comprehension</H>
          <P size={16}>organize critical pitch information into bite-sized lessons. representatives progress through guided paths designed for cognitive retention.</P>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {[
            { title: "Enterprise Playbook", meta: "8 lessons • 45m", pct: "80%", w: "80%" },
            { title: "Handling Competitors", meta: "5 lessons • 30m", pct: "40%", w: "40%" },
            { title: "Pricing & ROI Models", meta: "12 lessons • 1h 10m", pct: "10%", w: "10%" },
          ].map(item => (
            <Card key={item.title} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <p style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 16, color: C.dark, textTransform: "lowercase", marginBottom: 4 }}>{item.title}</p>
                  <p style={{ fontFamily: F.body, fontSize: 14, color: C.textFaint }}>{item.meta}</p>
                </div>
                <div style={{ background: "rgba(246,167,15,0.1)", borderRadius: 12, padding: "4px 10px" }}>
                  <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 12, color: C.dark }}>{item.pct} done</span>
                </div>
              </div>
              <div style={{ background: C.borderColor, borderRadius: 3, height: 6, overflow: "hidden" }}>
                <div style={{ background: C.orange, height: "100%", width: item.w }} />
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Quizzes */}
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.07) 40%, rgba(246,167,15,0.11))",
        display: "flex", gap: 48, alignItems: "center",
      }}>
        <Card style={{ flex: 1, borderRadius: 24, display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 14, color: C.textMuted, textTransform: "uppercase" }}>real-time evaluation</span>
            <span style={{ fontFamily: F.body, fontSize: 14, color: C.orange }}>question 3 of 5</span>
          </div>
          <H size={18}>how should you respond when an enterprise lead asks about our off-grid data deployment options?</H>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              { l: "a", text: "explain our default cloud backup SLA options.", sel: false },
              { l: "b", text: "pivot to ralli secure sync, highlighting our zero-latency offline protocol.", sel: true },
              { l: "c", text: "defer to engineering for a custom architecture plan.", sel: false },
            ].map(opt => (
              <div key={opt.l} style={{
                display: "flex", alignItems: "center", gap: 16,
                background: C.white, border: opt.sel ? `1px solid ${C.orange}` : border,
                borderRadius: 12, padding: 16,
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: opt.sel ? C.orange : "#f3f1ec",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <span style={{ fontFamily: F.body, fontWeight: 700, fontSize: 14, color: opt.sel ? C.white : C.dark }}>{opt.l}</span>
                </div>
                <span style={{ fontFamily: F.body, fontSize: 15, color: C.dark, flex: 1 }}>{opt.text}</span>
              </div>
            ))}
          </div>
        </Card>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 24 }}>
          <SectionLabel text="comprehension diagnostics" />
          <H size={36}>evaluation beyond clicking checkboxes</H>
          <P size={16}>completion tracking is a false signal. ralli maps deep memory via active scenario testing, diagnosing comprehension bottlenecks before they impact sales calls.</P>
        </div>
      </div>

      {/* Live games */}
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.08) 40%, rgba(246,167,15,0.14))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 64,
      }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: "100%" }}>
          <SectionLabel text="gamified alignment" />
          <H size={36} center>live games build comprehension</H>
          <P size={18} center style={{ maxWidth: 720 }}>turn alignment reviews into competitive team games. teams study and validate knowledge blocks in collaborative live tournaments.</P>
        </div>
        <div style={{ display: "flex", gap: 24, alignItems: "center", width: "100%" }}>
          <Card style={{ flex: 1, borderRadius: 24, display: "flex", flexDirection: "column", gap: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <H size={16}>live ralli leaderboard</H>
              <div style={{ background: C.green, borderRadius: 12, padding: "4px 10px" }}>
                <span style={{ fontFamily: F.body, fontWeight: 700, fontSize: 12, color: C.white }}>LIVE</span>
              </div>
            </div>
            {[
              { rank: "#1", initials: "EO", name: "Enterprise Outbound", pts: "2,450 pts" },
              { rank: "#2", initials: "MM", name: "Mid-Market Growth",   pts: "2,100 pts" },
              { rank: "#3", initials: "AP", name: "APAC Accounts",       pts: "1,950 pts" },
            ].map(row => (
              <div key={row.rank} style={{ display: "flex", alignItems: "center", gap: 16, background: C.white, border, borderRadius: 12, padding: 16 }}>
                <span style={{ fontFamily: F.body, fontWeight: 700, fontSize: 16, color: C.textFaint, width: 24 }}>{row.rank}</span>
                <Avatar initials={row.initials} size={36} />
                <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 15, color: C.dark, flex: 1 }}>{row.name}</span>
                <span style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 14, color: C.orange }}>{row.pts}</span>
              </div>
            ))}
          </Card>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 24 }}>
            <H size={24}>cohesive collaboration, healthy competition</H>
            <P size={16}>foster team alignment with custom challenges. host weekly multiplayer events covering objection models, pricing formulas, and product releases.</P>
            <BtnPrimary onClick={() => navigate("contact")} style={{ alignSelf: "flex-start" }}>See live games</BtnPrimary>
          </div>
        </div>
      </div>

      {/* Insights */}
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.07) 40%, rgba(246,167,15,0.12))",
        display: "flex", gap: 48, alignItems: "center",
      }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 24 }}>
          <SectionLabel text="actionable insights" />
          <H size={36}>diagnose compliance before pitching</H>
          <P size={16}>track precise memory trajectories across every segment. ralli automatically surfaces forgotten concepts and reveals systemic training blind spots.</P>
        </div>
        <Card style={{ flex: 1, borderRadius: 24, display: "flex", flexDirection: "column", gap: 24 }}>
          <H size={16}>comprehension blind spots</H>
          {[
            { topic: "Off-Grid Security Protocol", drop: "42% drop", dropColor: C.red,    action: "assign micro-quiz" },
            { topic: "Premium Tier ROI Models",    drop: "18% drop", dropColor: C.orange, action: "trigger review loop" },
          ].map(item => (
            <div key={item.topic} style={{ display: "flex", alignItems: "center", gap: 16, background: C.white, border, borderRadius: 12, padding: 16 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontFamily: F.body, fontWeight: 600, fontSize: 15, color: C.dark, marginBottom: 4 }}>{item.topic}</p>
                <p style={{ fontFamily: F.body, fontSize: 13, color: C.textFaint }}>retention gap identified over past 14 days</p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end", flexShrink: 0 }}>
                <span style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 12, color: item.dropColor }}>{item.drop}</span>
                <div style={{ background: "#f3f1ec", borderRadius: 6, padding: "4px 8px" }}>
                  <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 11, color: C.dark }}>{item.action}</span>
                </div>
              </div>
            </div>
          ))}
        </Card>
      </div>

      {/* Team readiness profiles */}
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.09) 40%, rgba(246,167,15,0.15))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 64,
      }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: "100%" }}>
          <SectionLabel text="representative monitoring" />
          <H size={36} center>drill down into readiness profiles</H>
          <P size={18} center style={{ maxWidth: 720 }}>identify precisely who is ready to deploy and who needs immediate knowledge calibration. target coaching where it impacts revenue.</P>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24, width: "100%" }}>
          {[
            { initials: "SC", name: "sarah chen",     team: "Enterprise Outbound", readiness: "94% ready", color: C.green  },
            { initials: "MV", name: "marcus vance",   team: "Mid-Market Growth",   readiness: "88% ready", color: C.green  },
            { initials: "JR", name: "jemima rhodrix", team: "APAC Outbound",       readiness: "71% ready", color: C.orange },
          ].map(rep => (
            <Card key={rep.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
              <Avatar initials={rep.initials} size={80} />
              <div style={{ textAlign: "center", width: "100%" }}>
                <p style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 16, color: C.dark, textTransform: "lowercase", marginBottom: 4 }}>{rep.name}</p>
                <p style={{ fontFamily: F.body, fontSize: 13, color: C.textFaint }}>{rep.team}</p>
              </div>
              <div style={{ width: "100%", borderTop: `1px solid ${C.borderColor}`, paddingTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: F.body, fontWeight: 600, fontSize: 14, color: C.textMuted }}>readiness index</span>
                <span style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 14, color: rep.color }}>{rep.readiness}</span>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Testimonial */}
      <div style={{
        ...sec, padding: "120px 80px",
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.08) 40%, rgba(246,167,15,0.13))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 48,
      }}>
        <SectionLabel text="proof of readiness" />
        <p style={{
          fontFamily: F.heading, fontWeight: 700, fontSize: 28, color: C.dark,
          lineHeight: 1.4, textAlign: "center", maxWidth: 960, textTransform: "lowercase",
        }}>
          "we stopped tracking completion because completion meant nothing. with ralli, we finally have an exact diagnostic on what our team actually comprehends before they get on the phone."
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Avatar initials="ER" size={48} />
          <div>
            <p style={{ fontFamily: F.body, fontWeight: 700, fontSize: 15, color: C.dark }}>elena roster</p>
            <p style={{ fontFamily: F.body, fontSize: 13, color: C.textFaint }}>VP of Sales, Vanta</p>
          </div>
        </div>
      </div>

      <CTABanner navigate={navigate} />
    </>
  );
}

// ─── Solution Page ────────────────────────────────────────────────────────────

function SolutionPage({ navigate }) {
  const [tab, setTab] = useState("learn");

  const tabs = {
    learn: [
      { label: "structured learning", title: "courses & guided paths", body: "Organize pitch content into sequenced lessons. Reps move through structured paths built for retention, not just completion." },
      { label: "micro-lessons", title: "bite-sized, always current", body: "Lessons auto-update with product changes. No manual curation required — your content stays fresh without effort." },
    ],
    games: [
      { label: "live competitions", title: "team tournaments", body: "Host live multiplayer knowledge challenges. Teams compete in real-time on objection handling, pricing, and product knowledge." },
      { label: "leaderboards", title: "healthy competition", body: "Live leaderboards show team standings and individual progress. Recognition drives participation without manager pressure." },
    ],
    quizzes: [
      { label: "diagnostic quizzes", title: "active recall testing", body: "Go beyond completion checkboxes. Scenario-based questions surface real comprehension gaps before they hit a sales call." },
      { label: "spaced repetition", title: "smart reinforcement", body: "Ralli automatically resurfaces concepts based on forgetting curves. Knowledge sticks without cramming." },
    ],
    battlecards: [
      { label: "competitive intel", title: "objection battle cards", body: "Reps access real-time competitive responses, objection frameworks, and pricing rebuttals — right when they need them." },
      { label: "always updated", title: "live sync with your deck", body: "Battle cards update automatically when product or pricing changes. One source of truth across the entire team." },
    ],
  };

  return (
    <>
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.07) 40%, rgba(246,167,15,0.12))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 24,
      }}>
        <SectionLabel text="the platform" />
        <H size={52} center style={{ maxWidth: 800 }}>built for how reps actually retain knowledge</H>
        <P size={18} center style={{ maxWidth: 640 }}>a complete readiness system — from structured learning to competitive games to manager-level diagnostics.</P>
      </div>

      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.06) 40%, rgba(246,167,15,0.1))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 48,
      }}>
        <div style={{ display: "flex", gap: 4, background: C.white, border, borderRadius: 12, padding: 4 }}>
          {["learn", "games", "quizzes", "battlecards"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              fontFamily: F.body, fontWeight: 600, fontSize: 14,
              padding: "8px 20px", borderRadius: 8, border: "none", cursor: "pointer",
              background: tab === t ? C.dark : "transparent",
              color: tab === t ? C.white : C.textMuted,
            }}>
              {t === "battlecards" ? "Battle Cards" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, width: "100%" }}>
          {(tabs[tab] || []).map(card => (
            <Card key={card.title} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <SectionLabel text={card.label} />
              <H size={24} style={{ marginTop: 4 }}>{card.title}</H>
              <P>{card.body}</P>
            </Card>
          ))}
        </div>
      </div>

      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.08) 40%, rgba(246,167,15,0.13))",
        display: "flex", gap: 48, alignItems: "center",
      }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 24 }}>
          <SectionLabel text="manager intelligence" />
          <H size={36}>readiness analytics that drive decisions</H>
          <P size={16}>see comprehension scores across every rep, team, and topic. surface gaps before they become pipeline problems. know exactly where to coach.</P>
          <BtnPrimary onClick={() => navigate("contact")} style={{ alignSelf: "flex-start" }}>book a demo</BtnPrimary>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {[
            { label: "Team readiness score",        value: "87%",     color: C.green  },
            { label: "Comprehension drop alerts",   value: "3 active", color: C.orange },
            { label: "Avg quiz score (30d)",         value: "76%",     color: C.dark   },
            { label: "Lessons completed this week", value: "248",     color: C.dark   },
          ].map(stat => (
            <Card key={stat.label} style={{ padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: F.body, fontWeight: 500, fontSize: 15, color: C.textMuted }}>{stat.label}</span>
              <span style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 18, color: stat.color }}>{stat.value}</span>
            </Card>
          ))}
        </div>
      </div>

      <CTABanner navigate={navigate} />
    </>
  );
}

// ─── Team Page ────────────────────────────────────────────────────────────────

function TeamPage({ navigate }) {
  const members = [
    { name: "Avanti Fernandes", role: "Founder & CEO",         bio: "Building the future of sales readiness. Previously in enterprise SaaS. Obsessed with operators, not dashboards.", isOpen: false },
    { name: "Open Role",        role: "Head of Engineering",   bio: "We're looking for a technical co-founder to own the product stack end to end.",                                    isOpen: true  },
    { name: "Open Role",        role: "Head of Design",        bio: "Own the visual system and product experience from day one. Join at the ground floor.",                             isOpen: true  },
    { name: "Open Role",        role: "Head of Sales",         bio: "Build and lead GTM from scratch. First sales hire, direct line to the founder.",                                   isOpen: true  },
  ];

  return (
    <>
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.07) 40%, rgba(246,167,15,0.12))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 24,
      }}>
        <SectionLabel text="the team" />
        <H size={52} center>the people building ralli</H>
        <P size={18} center style={{ maxWidth: 640 }}>we're a small team obsessed with making sales teams genuinely better — not just busier.</P>
      </div>

      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.06) 40%, rgba(246,167,15,0.1))",
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24,
      }}>
        {members.map((m, i) => (
          <Card key={i} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{
              width: 64, height: 64, borderRadius: 32,
              background: m.isOpen ? "rgba(246,167,15,0.12)" : C.orange,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ fontFamily: F.body, fontWeight: 700, fontSize: 22, color: m.isOpen ? C.textMuted : C.dark }}>
                {m.name[0]}
              </span>
            </div>
            <div>
              <p style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 18, color: C.dark, textTransform: "lowercase", marginBottom: 6 }}>{m.name}</p>
              <p style={{ fontFamily: F.body, fontWeight: 600, fontSize: 13, color: C.orange }}>{m.role}</p>
            </div>
            <P size={14}>{m.bio}</P>
            {m.isOpen && (
              <button onClick={() => navigate("contact")} style={{
                fontFamily: F.body, fontWeight: 600, fontSize: 13, color: C.dark,
                background: "none", border, borderRadius: 8, padding: "8px 16px",
                cursor: "pointer", alignSelf: "flex-start",
              }}>Apply →</button>
            )}
          </Card>
        ))}
      </div>

      <div style={{
        padding: "60px 80px",
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.06) 40%, rgba(246,167,15,0.1))",
        display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap",
      }}>
        {["comprehension over completion", "speed over perfection", "operators over dashboards"].map(v => (
          <div key={v} style={{ background: C.white, border, borderRadius: 12, padding: "12px 20px" }}>
            <span style={{ fontFamily: F.heading, fontWeight: 700, fontSize: 13, color: C.dark, textTransform: "lowercase" }}>{v}</span>
          </div>
        ))}
      </div>

      <CTABanner navigate={navigate} />
    </>
  );
}

// ─── Contact Page ─────────────────────────────────────────────────────────────

function ContactPage() {
  const [formType, setFormType] = useState("demo");
  const [data, setData] = useState({ name: "", email: "", company: "", role: "", message: "" });
  const [submitted, setSubmitted] = useState(false);

  const set = (k) => (e) => setData(prev => ({ ...prev, [k]: e.target.value }));

  const inputStyle = {
    fontFamily: F.body, fontSize: 15, color: C.dark,
    background: C.white, border, borderRadius: 8,
    padding: "12px 16px", outline: "none", width: "100%", boxSizing: "border-box",
  };

  if (submitted) {
    return (
      <div style={{
        minHeight: "calc(100vh - 72px)", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 24,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.07) 40%, rgba(246,167,15,0.12))",
        padding: 80,
      }}>
        <div style={{ width: 64, height: 64, borderRadius: 32, background: "rgba(74,222,128,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, color: C.green }}>✓</div>
        <H size={32} center>we'll be in touch</H>
        <P size={18} center style={{ maxWidth: 480 }}>thanks for reaching out. someone from the ralli team will follow up within one business day.</P>
      </div>
    );
  }

  return (
    <>
      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.07) 40%, rgba(246,167,15,0.12))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 24,
      }}>
        <SectionLabel text="get in touch" />
        <H size={52} center>let's talk</H>
        <P size={18} center style={{ maxWidth: 560 }}>whether you want a demo, have questions, or want to join the team — we want to hear from you.</P>
      </div>

      <div style={{
        ...sec,
        background: "linear-gradient(to right, #ffffff, rgba(252,227,171,0.06) 40%, rgba(246,167,15,0.1))",
        display: "flex", gap: 64, alignItems: "flex-start",
      }}>
        <form onSubmit={(e) => { e.preventDefault(); setSubmitted(true); }} style={{ flex: 2, display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {[
              { id: "demo",    label: "Book a Demo" },
              { id: "general", label: "General Inquiry" },
              { id: "join",    label: "Join the Team" },
            ].map(t => (
              <button key={t.id} type="button" onClick={() => setFormType(t.id)} style={{
                fontFamily: F.body, fontWeight: 600, fontSize: 13,
                padding: "8px 16px", borderRadius: 8, border, cursor: "pointer",
                background: formType === t.id ? C.dark : C.white,
                color: formType === t.id ? C.white : C.textMuted,
              }}>
                {t.label}
              </button>
            ))}
          </div>

          {[
            { k: "name",    label: "Name",    placeholder: "Your full name" },
            { k: "email",   label: "Email",   placeholder: "you@company.com", type: "email" },
            { k: "company", label: "Company", placeholder: "Where do you work?" },
            { k: "role",    label: "Role",    placeholder: "Your title" },
          ].map(f => (
            <div key={f.k}>
              <label style={{ fontFamily: F.body, fontWeight: 600, fontSize: 14, color: C.dark, display: "block", marginBottom: 8 }}>{f.label}</label>
              <input type={f.type || "text"} placeholder={f.placeholder} value={data[f.k]} onChange={set(f.k)} required style={inputStyle} />
            </div>
          ))}

          <div>
            <label style={{ fontFamily: F.body, fontWeight: 600, fontSize: 14, color: C.dark, display: "block", marginBottom: 8 }}>Message</label>
            <textarea placeholder="What's on your mind?" value={data.message} onChange={set("message")} rows={5} style={{ ...inputStyle, resize: "vertical" }} />
          </div>

          <BtnPrimary type="submit" style={{ alignSelf: "flex-start" }}>Send Message</BtnPrimary>
        </form>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 32, position: "sticky", top: 96 }}>
          <Card style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <H size={20}>get a demo</H>
            <P>see ralli in action. we'll walk through the product, answer questions, and build a plan that fits your team.</P>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {["30-minute walkthrough", "Custom to your team size", "Same-week availability"].map(item => (
                <div key={item} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.orange, flexShrink: 0 }} />
                  <P size={14}>{item}</P>
                </div>
              ))}
            </div>
          </Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <P size={13} faint>or email us directly</P>
            <a href="mailto:avanti.fernandes1@gmail.com" style={{ fontFamily: F.body, fontWeight: 600, fontSize: 15, color: C.dark, textDecoration: "none" }}>
              avanti@ralli.co
            </a>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function MarketingPage() {
  const getPage = () => window.location.hash.replace("#", "") || "home";
  const [currentPage, setCurrentPage] = useState(getPage);

  useEffect(() => {
    const onHash = () => setCurrentPage(getPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (page) => {
    window.history.pushState(null, "", `#${page}`);
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: F.body }}>
      <Nav currentPage={currentPage} navigate={navigate} />
      <div style={{ paddingTop: 72 }}>
        {currentPage === "home"     && <HomePage navigate={navigate} />}
        {currentPage === "solution" && <SolutionPage navigate={navigate} />}
        {currentPage === "team"     && <TeamPage navigate={navigate} />}
        {currentPage === "contact"  && <ContactPage navigate={navigate} />}
      </div>
      <Footer navigate={navigate} />
    </div>
  );
}
