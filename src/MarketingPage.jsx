import React, { useState, useEffect, useRef } from "react";

// ── BRAND TOKENS ───────────────────────────────────────────────
const C = {
  pageBg:      "#f3f1ec",  // cream — page surface
  white:       "#fbfaf7",  // off-white — card surface
  orange:      "#f6a70f",  // amber — primary accent
  orangeLight: "#fce3ab",  // amber tint
  orangeDeep:  "#c8820a",  // deep amber — for text on light bg
  dark:        "#12181f",  // ink — primary text / dark surface
  darkAlt:     "#1a2330",
  text:        "#12181f",  // ink
  textSub:     "#8a6a4f",  // umber — secondary text
  textMuted:   "#a08870",  // muted umber
  border:      "rgba(18,24,31,0.10)",
  borderLight: "rgba(18,24,31,0.06)",
  radius:      12,
};

function clamp(min, max) {
  return `clamp(${min}px, ${(min + max) / 2}px, ${max}px)`;
}


// ── HOOKS ──────────────────────────────────────────────────────
function useInView(threshold = 0.15) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) setVisible(true); },
      { threshold }
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, visible];
}

// ── SHARED STYLES ──────────────────────────────────────────────
const S = {
  fadeUp: (visible, delay = 0) => ({
    opacity:    visible ? 1 : 0,
    transform:  visible ? "translateY(0)" : "translateY(22px)",
    transition: `opacity 0.55s ease ${delay}s, transform 0.55s ease ${delay}s`,
  }),
  section: { width: "100%", padding: "96px 24px" },
  container: { maxWidth: 1120, margin: "0 auto" },
  sectionLabel: {
    display:       "inline-flex",
    alignItems:    "center",
    fontSize:      11,
    fontWeight:    700,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color:         C.orangeDeep,
    background:    C.orangeLight,
    border:        "1px solid rgba(253,191,36,0.4)",
    borderRadius:  100,
    padding:       "4px 12px",
    marginBottom:  20,
  },
  h2: {
    fontSize:     clamp(32, 48),
    fontWeight:   800,
    color:        C.text,
    lineHeight:   1.15,
    marginBottom: 16,
  },
  bodyLarge: {
    fontSize:   18,
    color:      C.textSub,
    lineHeight: 1.65,
    maxWidth:   560,
  },
};

// ── NAV ────────────────────────────────────────────────────────
const NAV_LINKS = [
  { id: "home",         label: "Home",                   page: "home"     },
  { id: "features",     label: "How It Works",             page: "solution" },
  { id: "pricing",      label: "Pricing",                page: "contact"  },
  { id: "team",         label: "Meet the Team",          page: "team"     },
];

function Nav({ currentPage, navigate }) {
  const [scrolled,    setScrolled]   = useState(false);
  const [mobileOpen,  setMobileOpen] = useState(false);
  const [isMobile,    setIsMobile]   = useState(() => window.innerWidth < 768);

  // Scroll effect
  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 12);
    window.addEventListener("scroll", fn, { passive: true });
    return () => window.removeEventListener("scroll", fn);
  }, []);

  // Viewport resize — switch modes and close menu when going desktop
  useEffect(() => {
    const fn = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setMobileOpen(false);
    };
    window.addEventListener("resize", fn, { passive: true });
    return () => window.removeEventListener("resize", fn);
  }, []);

  // Close on page change
  useEffect(() => { setMobileOpen(false); }, [currentPage]);

  // Lock body scroll while menu is open
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const handleNav = (id) => {
    setMobileOpen(false);
    navigate(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const navBg = (scrolled || mobileOpen)
    ? "rgba(255,255,255,0.98)"
    : "rgba(255,255,255,0.85)";
  const navBorder = (scrolled || mobileOpen)
    ? C.border
    : "rgba(11,18,32,0.05)";

  return (
    <>
      {/* ── Fixed nav bar ─────────────────────────────────────── */}
      <nav style={{
        position:       "fixed",
        top:            0,
        left:           0,
        right:          0,
        zIndex:         200,
        height:         60,
        display:        "flex",
        alignItems:     "center",
        padding:        "0 32px",
        background:     navBg,
        backdropFilter: "blur(12px)",
        borderBottom:   `1px solid ${navBorder}`,
        transition:     "border-color 0.25s, background 0.25s",
      }}>
        <div style={{
          maxWidth:       1120,
          margin:         "0 auto",
          width:          "100%",
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
        }}>
          {/* Logo */}
          <button
            onClick={() => handleNav("home")}
            style={{ display: "flex", alignItems: "center", gap: 12, background: "none", border: "none", cursor: "pointer", padding: 0, flexShrink: 0 }}
          >
            <img src="/assets/ralli-icon.png" alt="" aria-hidden="true" style={{ height: 20, width: "auto", display: "block" }} />
            <img src="/assets/ralli-logo.png" alt="ralli" style={{ height: 26, display: "block" }} />
          </button>

          {/* Desktop links — hidden below 768px */}
          {!isMobile && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {NAV_LINKS.map(l => (
                <button
                  key={l.id}
                  onClick={() => handleNav(l.page)}
                  style={{
                    fontSize:     14,
                    fontWeight:   currentPage === l.page ? 700 : 500,
                    color:        currentPage === l.page ? C.text : C.textSub,
                    background:   currentPage === l.page ? C.orangeLight : "none",
                    border:       "none",
                    borderRadius: 7,
                    padding:      "6px 14px",
                    cursor:       "pointer",
                    transition:   "background 0.15s, color 0.15s",
                  }}
                  onMouseEnter={e => { if (currentPage !== l.page) { e.currentTarget.style.background = C.pageBg; e.currentTarget.style.color = C.text; } }}
                  onMouseLeave={e => { if (currentPage !== l.page) { e.currentTarget.style.background = "none"; e.currentTarget.style.color = C.textSub; } }}
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}

          {/* Desktop right — log in + book a demo */}
          {!isMobile && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <a
                href="/login"
                style={{
                  fontSize:       14,
                  fontWeight:     500,
                  color:          C.textSub,
                  textDecoration: "none",
                  padding:        "7px 12px",
                  transition:     "color 0.15s",
                }}
                onMouseEnter={e => e.currentTarget.style.color = C.text}
                onMouseLeave={e => e.currentTarget.style.color = C.textSub}
              >
                log in
              </a>
              <button
                onClick={() => handleNav("contact")}
                style={{
                  fontSize:     14,
                  fontWeight:   700,
                  color:        C.dark,
                  background:   C.orange,
                  border:       "none",
                  borderRadius: 8,
                  padding:      "8px 18px",
                  cursor:       "pointer",
                  transition:   "opacity 0.15s",
                }}
                onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
                onMouseLeave={e => e.currentTarget.style.opacity = "1"}
              >
                book a demo
              </button>
            </div>
          )}

          {/* Hamburger button — visible below 768px */}
          {isMobile && (
            <button
              onClick={() => setMobileOpen(o => !o)}
              aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileOpen}
              aria-controls="ralli-mobile-nav"
              style={{
                display:         "flex",
                flexDirection:   "column",
                justifyContent:  "center",
                alignItems:      "center",
                gap:             5,
                width:           44,
                height:          44,
                background:      "none",
                border:          "none",
                cursor:          "pointer",
                padding:         0,
                borderRadius:    8,
                flexShrink:      0,
              }}
            >
              {/* Bar 1 — rotates to top of X */}
              <span style={{
                display:      "block",
                width:        22,
                height:       2,
                background:   C.dark,
                borderRadius: 2,
                transition:   "transform 0.22s ease",
                transform:    mobileOpen ? "translateY(7px) rotate(45deg)" : "none",
              }}/>
              {/* Bar 2 — fades out */}
              <span style={{
                display:      "block",
                width:        22,
                height:       2,
                background:   C.dark,
                borderRadius: 2,
                transition:   "opacity 0.22s ease",
                opacity:      mobileOpen ? 0 : 1,
              }}/>
              {/* Bar 3 — rotates to bottom of X */}
              <span style={{
                display:      "block",
                width:        22,
                height:       2,
                background:   C.dark,
                borderRadius: 2,
                transition:   "transform 0.22s ease",
                transform:    mobileOpen ? "translateY(-7px) rotate(-45deg)" : "none",
              }}/>
            </button>
          )}
        </div>
      </nav>

      {/* ── Mobile menu (backdrop + panel) ────────────────────── */}
      {isMobile && (
        <>
          {/* Backdrop — tap to close */}
          <div
            role="presentation"
            onClick={() => setMobileOpen(false)}
            style={{
              position:       "fixed",
              inset:          0,
              zIndex:         150,
              background:     "rgba(11,18,32,0.45)",
              backdropFilter: "blur(2px)",
              opacity:        mobileOpen ? 1 : 0,
              pointerEvents:  mobileOpen ? "auto" : "none",
              transition:     "opacity 0.22s ease",
            }}
          />

          {/* Panel */}
          <div
            id="ralli-mobile-nav"
            role="dialog"
            aria-label="Navigation menu"
            aria-modal="true"
            style={{
              position:     "fixed",
              top:          60,
              left:         0,
              right:        0,
              zIndex:       190,
              background:   C.white,
              borderBottom: `1px solid ${C.border}`,
              boxShadow:    "0 20px 48px rgba(11,18,32,0.14)",
              padding:      "12px 20px 24px",
              transform:    mobileOpen ? "translateY(0)" : "translateY(-10px)",
              opacity:      mobileOpen ? 1 : 0,
              visibility:   mobileOpen ? "visible" : "hidden",
              transition:   mobileOpen
                ? "transform 0.22s ease, opacity 0.22s ease, visibility 0s 0s"
                : "transform 0.22s ease, opacity 0.22s ease, visibility 0s 0.22s",
            }}
          >
            {/* Page links */}
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 14 }}>
              {NAV_LINKS.map(l => (
                <button
                  key={l.id}
                  onClick={() => handleNav(l.page)}
                  tabIndex={mobileOpen ? 0 : -1}
                  style={{
                    display:       "flex",
                    alignItems:    "center",
                    width:         "100%",
                    fontSize:      16,
                    fontWeight:    currentPage === l.page ? 700 : 500,
                    color:         currentPage === l.page ? C.text : C.textSub,
                    background:    currentPage === l.page ? C.orangeLight : "none",
                    border:        "none",
                    borderRadius:  9,
                    padding:       "12px 16px",
                    cursor:        "pointer",
                    textAlign:     "left",
                    minHeight:     48,
                    transition:    "background 0.12s",
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: C.border, marginBottom: 14 }} />

            {/* CTA row */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                onClick={() => handleNav("contact")}
                tabIndex={mobileOpen ? 0 : -1}
                style={{
                  display:         "flex",
                  alignItems:      "center",
                  justifyContent:  "center",
                  width:           "100%",
                  fontSize:        15,
                  fontWeight:      700,
                  color:           C.dark,
                  background:      C.orange,
                  border:          "none",
                  borderRadius:    10,
                  padding:         "14px 0",
                  cursor:          "pointer",
                  minHeight:       48,
                  boxShadow:       "0 4px 14px rgba(253,191,36,0.35)",
                }}
              >
                Book a Demo
              </button>
              <a
                href="/login"
                tabIndex={mobileOpen ? 0 : -1}
                style={{
                  display:         "flex",
                  alignItems:      "center",
                  justifyContent:  "center",
                  width:           "100%",
                  fontSize:        15,
                  fontWeight:      500,
                  color:           C.textSub,
                  textDecoration:  "none",
                  background:      "transparent",
                  border:          `1.5px solid ${C.border}`,
                  borderRadius:    10,
                  padding:         "13px 0",
                  minHeight:       48,
                  boxSizing:       "border-box",
                }}
              >
                log in
              </a>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ── SHARED COMPONENTS ──────────────────────────────────────────
function PageWrapper({ children }) {
  useEffect(() => { window.scrollTo({ top: 0 }); }, []);
  return (
    <div style={{
      paddingTop:      60,
      minHeight:       "100vh",
      background: [
        "radial-gradient(ellipse at 88% 5%, rgba(246,167,15,0.22) 0%, rgba(252,227,171,0.12) 24%, transparent 52%)",
        "radial-gradient(ellipse at 10% 30%, rgba(252,227,171,0.34) 0%, rgba(246,167,15,0.08) 26%, transparent 55%)",
        "radial-gradient(ellipse at 75% 55%, rgba(246,167,15,0.10) 0%, rgba(252,227,171,0.16) 22%, transparent 50%)",
        "radial-gradient(ellipse at 18% 82%, rgba(246,167,15,0.15) 0%, rgba(252,227,171,0.10) 28%, transparent 56%)",
        "linear-gradient(180deg, #fbfaf7 0%, #ffffff 28%, #fdfaf3 52%, #ffffff 72%, #fbfaf7 100%)",
      ].join(","),
      backgroundRepeat: "no-repeat",
      backgroundSize:   "100% 100%",
    }}>
      {children}
    </div>
  );
}

function CTABanner({ navigate }) {
  const [ref, visible] = useInView();
  return (
    <section style={{ ...S.section, background: "transparent" }}>
      <div ref={ref} style={{ ...S.container, textAlign: "center" }}>
        <h2 style={{
          ...S.fadeUp(visible),
          fontSize:      clamp(28, 44),
          fontWeight:    800,
          color:         C.text,
          lineHeight:    1.1,
          letterSpacing: "-0.03em",
          textTransform: "lowercase",
          maxWidth:      560,
          margin:        "0 auto 16px",
        }}>
          guarantee comprehension, boost sales efficiency
        </h2>
        <p style={{ ...S.fadeUp(visible, 0.07), fontSize: 16, color: C.textSub, lineHeight: 1.65, maxWidth: 380, margin: "0 auto 32px" }}>
          stop guessing if your team is ready. deploy smart evaluation profiles and track real confidence indicators.
        </p>
        <div style={{ ...S.fadeUp(visible, 0.13), display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => { navigate("contact"); window.scrollTo({ top: 0 }); }}
            style={{
              fontSize: 14, fontWeight: 700, color: C.dark,
              background: C.orange, border: "none", borderRadius: 9,
              padding: "12px 26px", cursor: "pointer", transition: "opacity 0.15s",
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
            onMouseLeave={e => e.currentTarget.style.opacity = "1"}
          >
            get started free
          </button>
          <button
            onClick={() => { navigate("contact"); window.scrollTo({ top: 0 }); }}
            style={{
              fontSize: 14, fontWeight: 600, color: C.text,
              background: "transparent", border: `1.5px solid ${C.border}`,
              borderRadius: 9, padding: "12px 26px", cursor: "pointer", transition: "opacity 0.15s",
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = "0.65"}
            onMouseLeave={e => e.currentTarget.style.opacity = "1"}
          >
            talk to sales
          </button>
        </div>
      </div>
    </section>
  );
}

// ── HOME PAGE ──────────────────────────────────────────────────
function Hero({ navigate }) {
  const [ref, visible] = useInView(0.05);
  return (
    <section style={{
      padding:   "140px 24px 100px",
      background: "transparent",
      textAlign:  "center",
      position:   "relative",
      overflow:   "hidden",
    }}>
      <div ref={ref} style={{ maxWidth: 760, margin: "0 auto", position: "relative" }}>
        {/* Badge */}
        <div style={{ ...S.fadeUp(visible), display: "flex", justifyContent: "center", marginBottom: 32 }}>
          <div style={{
            display:      "inline-flex",
            alignItems:   "center",
            gap:          8,
            background:   C.orange,
            borderRadius: 100,
            padding:      "5px 14px 5px 6px",
            fontSize:     12,
            fontWeight:   600,
            color:        C.dark,
          }}>
            ralli games are now live · schedule a demo now
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 6.5h8M7.5 3.5l3 3-3 3" stroke={C.dark} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
        </div>
        {/* Headline */}
        <h1 style={{
          ...S.fadeUp(visible, 0.07),
          fontSize:      clamp(44, 72),
          fontWeight:    800,
          color:         C.dark,
          lineHeight:    1.0,
          letterSpacing: "-0.04em",
          maxWidth:      700,
          margin:        "0 auto 22px",
          textTransform: "lowercase",
        }}>
          comprehension instead of completion
        </h1>
        <p style={{ ...S.fadeUp(visible, 0.12), fontSize: clamp(15, 18), color: C.textSub, lineHeight: 1.65, maxWidth: 460, margin: "0 auto 36px" }}>
          measuring readiness by defining comprehension instead of tracking completion checkboxes
        </p>
        <div style={{ ...S.fadeUp(visible, 0.17), display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => { navigate("contact"); window.scrollTo({ top: 0 }); }}
            style={{
              fontSize: 14, fontWeight: 700, color: C.white,
              background: C.dark, border: "none", borderRadius: 9,
              padding: "12px 26px", cursor: "pointer", transition: "opacity 0.15s",
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = "0.8"}
            onMouseLeave={e => e.currentTarget.style.opacity = "1"}
          >
            get started free
          </button>
          <button
            onClick={() => { navigate("contact"); window.scrollTo({ top: 0 }); }}
            style={{
              fontSize: 14, fontWeight: 600, color: C.dark,
              background: "transparent", border: `1.5px solid rgba(18,24,31,0.25)`,
              borderRadius: 9, padding: "12px 26px", cursor: "pointer", transition: "opacity 0.15s",
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = "0.65"}
            onMouseLeave={e => e.currentTarget.style.opacity = "1"}
          >
            talk to sales
          </button>
        </div>
      </div>
    </section>
  );
}

function HeroDashboard() {
  return (
    <div style={{
      maxWidth:     900,
      margin:       "0 auto",
      borderRadius: 16,
      border:       `1px solid ${C.border}`,
      background:   C.white,
      boxShadow:    "0 24px 80px rgba(11,18,32,0.12),0 4px 16px rgba(11,18,32,0.06)",
      overflow:     "hidden",
    }}>
      {/* Chrome bar */}
      <div style={{ height: 40, background: "#F1F5F9", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 14px", gap: 6 }}>
        {["#EF4444","#FBBF24","#22C55E"].map((c,i) => <div key={i} style={{ width: 9, height: 9, borderRadius: "50%", background: c }} />)}
        <div style={{ marginLeft: 10, height: 20, background: C.white, borderRadius: 5, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 9px", fontSize: 10, color: C.textMuted, maxWidth: 220 }}>app.ralli.io/analytics</div>
      </div>
      <div style={{ padding: 20, background: C.pageBg }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 16 }}>
          {[
            { label: "Team Readiness", value: "78%", delta: "+6 pts", good: true },
            { label: "Avg Quiz Score",  value: "82%", delta: "+4%",   good: true },
            { label: "Completion",      value: "91%", delta: "",      good: null },
            { label: "Below Threshold", value: "4",   delta: "−2",    good: true },
          ].map((k,i) => (
            <div key={i} style={{ background: C.white, borderRadius: C.radius, border: `1px solid ${C.border}`, padding: "12px 14px" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text, lineHeight: 1 }}>{k.value}</div>
              {k.delta && <div style={{ fontSize: 10, fontWeight: 600, color: k.good ? "#16A34A" : "#DC2626", marginTop: 3 }}>{k.delta} this month</div>}
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 10 }}>
          {/* Heatmap */}
          <div style={{ background: C.white, borderRadius: C.radius, border: `1px solid ${C.border}`, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 12 }}>Knowledge Heatmap</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 3 }}>
              {["Product","Objections","Pricing","Discovery","Closing","Compliance"].map((h,i) => (
                <div key={i} style={{ fontSize: 8, fontWeight: 600, color: C.textMuted, textAlign: "center", paddingBottom: 3, letterSpacing: "0.03em" }}>{h}</div>
              ))}
              {[[92,44,78,88,61,95],[85,72,55,90,78,88],[78,38,91,67,83,72],[95,81,66,74,92,58]].map((row,ri) =>
                row.map((score,ci) => {
                  const bg = score>=80?"#D1FAE5":score>=60?"#FEF9C3":"#FEE2E2";
                  const fc = score>=80?"#16A34A":score>=60?"#A16207":"#DC2626";
                  return <div key={`${ri}-${ci}`} style={{ background: bg, borderRadius: 5, padding: "6px 2px", textAlign: "center", fontSize: 11, fontWeight: 700, color: fc }}>{score}</div>;
                })
              )}
            </div>
          </div>
          {/* Rep list */}
          <div style={{ background: C.white, borderRadius: C.radius, border: `1px solid ${C.border}`, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 12 }}>Rep Readiness</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[{name:"Jordan M.",score:94,s:"ready"},{name:"Taylor S.",score:88,s:"ready"},{name:"Riley K.",score:79,s:"on-track"},{name:"Alex P.",score:62,s:"at-risk"},{name:"Morgan T.",score:45,s:"at-risk"}].map((rep,i) => {
                const sc = rep.s==="ready"?"#16A34A":rep.s==="on-track"?"#CA8A04":"#DC2626";
                const sb = rep.s==="ready"?"#D1FAE5":rep.s==="on-track"?"#FEF9C3":"#FEE2E2";
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <div style={{ width:26,height:26,borderRadius:"50%",background:`hsl(${i*55},60%,60%)`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:"#fff" }}>
                      {rep.name.split(" ").map(n=>n[0]).join("")}
                    </div>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontSize:11,fontWeight:600,color:C.text }}>{rep.name}</div>
                      <div style={{ height:3,background:"#F1F5F9",borderRadius:3,marginTop:3 }}>
                        <div style={{ height:"100%",width:`${rep.score}%`,background:sc,borderRadius:3 }} />
                      </div>
                    </div>
                    <div style={{ fontSize:10,fontWeight:700,color:C.text,minWidth:26,textAlign:"right" }}>{rep.score}%</div>
                    <div style={{ fontSize:8,fontWeight:700,color:sc,background:sb,borderRadius:100,padding:"2px 6px",textTransform:"uppercase",letterSpacing:"0.05em" }}>{rep.s}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── "onboarding is just day one" ──────────────────────────────
function FeaturesGrid() {
  const [ref, visible] = useInView();
  const features = [
    {
      icon: <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="2" y="2" width="18" height="18" rx="5" fill={C.orangeLight}/><path d="M7 11h8M7 7h8M7 15h5" stroke={C.orangeDeep} strokeWidth="1.8" strokeLinecap="round"/></svg>,
      title: "continuous calibration",
      desc:  "automated quizzes sync micro-lessons with every product update, keeping representatives precisely aligned.",
    },
    {
      icon: <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="2" y="2" width="18" height="18" rx="5" fill={C.orangeLight}/><circle cx="11" cy="11" r="4" stroke={C.orangeDeep} strokeWidth="1.8"/><path d="M11 7V5M11 17v-2M7 11H5M17 11h-2" stroke={C.orangeDeep} strokeWidth="1.8" strokeLinecap="round"/></svg>,
      title: "knowledge persistence",
      desc:  "smart repetition targets forgotten concepts over time, cementing comprehension across every market shift.",
    },
    {
      icon: <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="2" y="2" width="18" height="18" rx="5" fill={C.orangeLight}/><path d="M6 15l4-4 3 3 4-5" stroke={C.orangeDeep} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
      title: "real-time readiness",
      desc:  "always know who is ready to pitch. track individual progress over a dynamic learning arc.",
    },
  ];
  return (
    <section style={{ ...S.section, background: "transparent" }}>
      <div ref={ref} style={{ ...S.container }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <span style={S.sectionLabel}>ongoing mastery</span>
          <h2 style={{ ...S.h2, ...S.fadeUp(visible), textTransform: "lowercase", margin: "12px auto 14px", maxWidth: 440 }}>
            onboarding is just day one
          </h2>
          <p style={{ ...S.fadeUp(visible, 0.07), fontSize: 16, color: C.textSub, lineHeight: 1.65, maxWidth: 480, margin: "0 auto" }}>
            enablement should not expire after week two. ralli provides continuous, micro-sized knowledge loops to guarantee readiness through every market shift.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 16 }}>
          {features.map((f, i) => (
            <div key={i} style={{
              ...S.fadeUp(visible, 0.1 + i * 0.07),
              background:   C.white,
              border:       `1px solid ${C.border}`,
              borderRadius: 14,
              padding:      "26px 22px",
              boxShadow:    "0 2px 10px rgba(18,24,31,0.04)",
            }}>
              <div style={{ marginBottom: 14 }}>{f.icon}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 8 }}>{f.title}</div>
              <p style={{ fontSize: 13, color: C.textSub, lineHeight: 1.65, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── "curated paths for fast comprehension" ────────────────────
function LearningPaths() {
  const [ref, visible] = useInView();
  const paths = [
    { title: "enterprise playbook",  lessons: 12, progress: 90 },
    { title: "handling competitors", lessons: 8,  progress: 45 },
    { title: "pricing & roi models", lessons: 6,  progress: 30 },
  ];
  return (
    <section style={{ ...S.section, background: "transparent" }}>
      <div ref={ref} style={{ ...S.container }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 64, alignItems: "center" }}>
          <div style={S.fadeUp(visible, 0.04)}>
            <span style={S.sectionLabel}>structured learning paths</span>
            <h2 style={{ ...S.h2, textTransform: "lowercase", margin: "14px 0 16px" }}>
              curated paths for fast comprehension
            </h2>
            <p style={{ ...S.bodyLarge }}>
              organize critical pitch information into bite-size lessons. representatives progress through guided paths designed for cognitive retention.
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {paths.map((p, i) => (
              <div key={i} style={{
                ...S.fadeUp(visible, 0.1 + i * 0.08),
                background:   C.white,
                borderRadius: 12,
                border:       `1px solid ${C.border}`,
                padding:      "18px 20px",
                boxShadow:    "0 2px 8px rgba(18,24,31,0.04)",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{p.title}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.textMuted }}>{p.progress}% done</div>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>{p.lessons} lessons · 0 of {p.lessons} to do</div>
                <div style={{ height: 4, background: C.borderLight, borderRadius: 3 }}>
                  <div style={{ height: "100%", width: `${p.progress}%`, background: C.orange, borderRadius: 3 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── "evaluation beyond clicking checkboxes" ───────────────────
function EvaluationSection() {
  const [ref, visible] = useInView();
  return (
    <section ref={ref} style={{ width: "100%", display: "flex", flexWrap: "wrap" }}>
      {/* Left — ink panel with quiz */}
      <div style={{ flex: "1 1 320px", background: C.dark, padding: "72px 48px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
          <span style={{ ...S.sectionLabel, background: "rgba(246,167,15,0.15)", borderColor: "rgba(246,167,15,0.3)", color: C.orange }}>real-time evaluation</span>
          <span style={{ ...S.sectionLabel, background: "rgba(246,167,15,0.15)", borderColor: "rgba(246,167,15,0.3)", color: C.orange }}>enterprise diagnostics</span>
        </div>
        <div style={{ ...S.fadeUp(visible), background: "rgba(251,250,247,0.05)", border: "1px solid rgba(251,250,247,0.1)", borderRadius: 14, padding: 22, maxWidth: 440 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(251,250,247,0.35)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>scenario evaluation</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.white, marginBottom: 20, lineHeight: 1.5 }}>
            how should you respond when an enterprise lead asks about our off-grid data deployment options?
          </div>
          {[
            { letter: "a", text: "explain our default cloud backup SLA architecture." },
            { letter: "b", text: "pivot to security, highlighting our zero-latency offline protocol.", active: true },
            { letter: "c", text: "defer to engineering for a custom architecture plan." },
          ].map((opt) => (
            <div key={opt.letter} style={{
              display:      "flex",
              alignItems:   "flex-start",
              gap:          10,
              padding:      "10px 12px",
              borderRadius: 8,
              background:   opt.active ? C.orange : "transparent",
              border:       `1px solid ${opt.active ? C.orange : "rgba(251,250,247,0.1)"}`,
              marginBottom: 6,
            }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: opt.active ? C.dark : "rgba(251,250,247,0.35)", minWidth: 14 }}>{opt.letter}</span>
              <span style={{ fontSize: 12, color: opt.active ? C.dark : "rgba(251,250,247,0.55)", lineHeight: 1.5 }}>{opt.text}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Right — cream panel with text */}
      <div style={{ flex: "1 1 320px", background: "transparent", padding: "72px 48px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <span style={{ ...S.sectionLabel, alignSelf: "flex-start", marginBottom: 20 }}>comprehension diagnostics</span>
        <h2 style={{ ...S.h2, ...S.fadeUp(visible, 0.08), textTransform: "lowercase", marginBottom: 16, maxWidth: 360 }}>
          evaluation beyond clicking checkboxes
        </h2>
        <p style={{ fontSize: 16, color: C.textSub, lineHeight: 1.7, maxWidth: 360 }}>
          completion tracking is a false signal. ralli maps deep memory via active scenario testing, diagnosing comprehension bottlenecks before they impact sales calls.
        </p>
      </div>
    </section>
  );
}

// ── "live games build comprehension" ─────────────────────────
function GamesSection({ navigate }) {
  const [ref, visible] = useInView();
  const teams = [
    { rank: 1, name: "Enterprise Outbound", pts: "2,400 pts" },
    { rank: 2, name: "Mid-Market Growth",   pts: "2,100 pts" },
    { rank: 3, name: "APAC Accounts",       pts: "1,800 pts" },
  ];
  return (
    <section style={{ ...S.section, background: "transparent" }}>
      <div ref={ref} style={{ ...S.container }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <span style={S.sectionLabel}>gamified alignment</span>
          <h2 style={{ ...S.h2, ...S.fadeUp(visible), textTransform: "lowercase", margin: "12px auto 14px", maxWidth: 500 }}>
            live games build comprehension
          </h2>
          <p style={{ ...S.fadeUp(visible, 0.07), fontSize: 16, color: C.textSub, lineHeight: 1.65, maxWidth: 440, margin: "0 auto" }}>
            turn alignment reviews into competitive team games. teams study and validate knowledge blocks in collaborative live tournaments.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 52, alignItems: "center" }}>
          {/* Leaderboard card */}
          <div style={{ ...S.fadeUp(visible, 0.1), background: C.white, border: `1px solid ${C.border}`, borderRadius: 16, padding: "22px 22px 18px", boxShadow: "0 4px 18px rgba(18,24,31,0.07)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.dark }}>live ralli leaderboard</div>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#16A34A", background: "#D1FAE5", borderRadius: 100, padding: "3px 9px" }}>LIVE</div>
            </div>
            {teams.map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: i < teams.length - 1 ? `1px solid ${C.borderLight}` : "none" }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: i === 0 ? C.orange : C.textMuted, minWidth: 18 }}>#{t.rank}</span>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: `hsl(${i * 80 + 20},60%,62%)`, flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: C.dark }}>{t.name}</div>
                <div style={{ fontSize: 12, fontWeight: 800, color: i === 0 ? C.orange : C.textSub }}>{t.pts}</div>
              </div>
            ))}
          </div>
          {/* Text */}
          <div style={S.fadeUp(visible, 0.14)}>
            <h3 style={{ fontSize: 20, fontWeight: 800, color: C.dark, marginBottom: 14, lineHeight: 1.25, textTransform: "lowercase" }}>
              cohesive collaboration, healthy competition
            </h3>
            <p style={{ fontSize: 15, color: C.textSub, lineHeight: 1.7, marginBottom: 22 }}>
              foster team alignment with custom challenges. host weekly multiplayer events covering objection models, pricing formulas, and product releases.
            </p>
            <button
              onClick={() => { navigate("contact"); window.scrollTo({ top: 0 }); }}
              style={{
                fontSize: 13, fontWeight: 700, color: C.white,
                background: C.dark, border: "none", borderRadius: 8,
                padding: "10px 20px", cursor: "pointer", transition: "opacity 0.15s",
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = "0.8"}
              onMouseLeave={e => e.currentTarget.style.opacity = "1"}
            >
              see live games
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── "diagnose compliance before pitching" ─────────────────────
function InsightsSection() {
  const [ref, visible] = useInView();
  return (
    <section style={{ ...S.section, background: "transparent" }}>
      <div ref={ref} style={{ ...S.container }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 64, alignItems: "center" }}>
          <div style={S.fadeUp(visible, 0.04)}>
            <span style={S.sectionLabel}>actionable insights</span>
            <h2 style={{ ...S.h2, textTransform: "lowercase", margin: "14px 0 16px" }}>
              diagnose compliance before pitching
            </h2>
            <p style={{ ...S.bodyLarge }}>
              track precise memory trajectories across every segment. ralli automatically surfaces forgotten concepts and reveals systemic training blind spots.
            </p>
          </div>
          <div style={{ ...S.fadeUp(visible, 0.1), background: C.dark, borderRadius: 16, padding: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(251,250,247,0.45)", marginBottom: 18 }}>comprehension blind spots</div>
            {[
              { title: "Off-Grid Security Protocol", sub: "12 reps · 8 at risk",  badge: "−42% drop", red: true },
              { title: "Premium Tier ROI Models",    sub: "9 reps · 4 at risk",   badge: "higher win rate", red: false },
            ].map((item, i) => (
              <div key={i} style={{
                background:   "rgba(251,250,247,0.05)",
                border:       "1px solid rgba(251,250,247,0.08)",
                borderRadius: 10,
                padding:      "16px 16px",
                marginBottom: i === 0 ? 10 : 0,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.white, marginBottom: 4 }}>{item.title}</div>
                    <div style={{ fontSize: 11, color: "rgba(251,250,247,0.35)" }}>{item.sub}</div>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    color:        item.red ? "#f87171" : "#4ade80",
                    background:   item.red ? "rgba(239,68,68,0.12)" : "rgba(74,222,128,0.12)",
                    borderRadius: 100, padding: "3px 9px", whiteSpace: "nowrap", marginLeft: 8,
                  }}>{item.badge}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── "drill down into readiness profiles" ──────────────────────
function ProfilesSection() {
  const [ref, visible] = useInView();
  const reps = [
    { name: "sarah chen",     role: "Enterprise Outbound", score: 94, status: "ready",   color: C.orange },
    { name: "marcus vance",   role: "Mid-Market Growth",   score: 100, status: "ready",  color: "#a78bfa" },
    { name: "jemima chadrix", role: "APAC Accounts",       score: 79, status: "ready",    color: "#34d399" },
  ];
  return (
    <section style={{ ...S.section, background: "transparent" }}>
      <div ref={ref} style={{ ...S.container }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <span style={S.sectionLabel}>individual rep coaching</span>
          <h2 style={{ ...S.h2, ...S.fadeUp(visible), textTransform: "lowercase", margin: "12px auto 14px", maxWidth: 520 }}>
            drill down into readiness profiles
          </h2>
          <p style={{ ...S.fadeUp(visible, 0.07), fontSize: 16, color: C.textSub, lineHeight: 1.65, maxWidth: 440, margin: "0 auto" }}>
            identify precisely who is ready to deploy and who needs immediate knowledge calibration. target coaching where it impacts revenue.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 16 }}>
          {reps.map((r, i) => (
            <div key={i} style={{
              ...S.fadeUp(visible, 0.1 + i * 0.07),
              background:   C.white,
              borderRadius: 16,
              border:       `1px solid ${C.border}`,
              padding:      "28px 22px",
              textAlign:    "center",
              boxShadow:    "0 2px 10px rgba(18,24,31,0.04)",
            }}>
              <div style={{ width: 60, height: 60, borderRadius: "50%", background: r.color, margin: "0 auto 14px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 800, color: C.dark }}>
                {r.name.split(" ").map(n => n[0].toUpperCase()).join("")}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 3 }}>{r.name}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 18 }}>{r.role}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: C.textMuted }}>readiness index</span>
                <span style={{ fontSize: 12, fontWeight: 800, color: r.score >= 90 ? "#16a34a" : r.score >= 70 ? C.orangeDeep : "#dc2626" }}>
                  {r.score}% · {r.status}
                </span>
              </div>
              <div style={{ height: 4, background: C.borderLight, borderRadius: 3 }}>
                <div style={{ height: "100%", width: `${r.score}%`, background: r.score >= 90 ? "#22c55e" : r.score >= 70 ? C.orange : "#ef4444", borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Platform showcase (preserves HeroDashboard visual) ────────
function PlatformShowcase() {
  const [ref, visible] = useInView(0.08);
  return (
    <section style={{ ...S.section, background: "transparent", padding: "72px 24px" }}>
      <div ref={ref} style={{ ...S.container }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <span style={S.sectionLabel}>the platform</span>
          <h2 style={{ ...S.h2, ...S.fadeUp(visible), textTransform: "lowercase", maxWidth: 480, margin: "12px auto 14px" }}>
            one view. every rep. full readiness picture.
          </h2>
          <p style={{ ...S.bodyLarge, ...S.fadeUp(visible, 0.07), textAlign: "center", margin: "0 auto" }}>
            readiness scores, knowledge gaps, and coaching signals — all in one place.
          </p>
        </div>
        <div style={S.fadeUp(visible, 0.13)}>
          <HeroDashboard />
        </div>
      </div>
    </section>
  );
}

// ── Testimonial ───────────────────────────────────────────────
function TestimonialSection() {
  const [ref, visible] = useInView();
  return (
    <section style={{ ...S.section, background: "transparent" }}>
      <div ref={ref} style={{ ...S.container, textAlign: "center", maxWidth: 760 }}>
        <span style={S.sectionLabel}>a proof of readiness</span>
        <blockquote style={{
          ...S.fadeUp(visible, 0.07),
          fontSize:      clamp(18, 28),
          fontWeight:    700,
          color:         C.dark,
          lineHeight:    1.4,
          letterSpacing: "-0.02em",
          margin:        "22px auto 28px",
          fontStyle:     "normal",
          maxWidth:      680,
        }}>
          "we stopped tracking completion because completion meant nothing. with ralli, we finally have an exact diagnostic on what our team actually comprehends before they get on the phone."
        </blockquote>
        <div style={{ ...S.fadeUp(visible, 0.13), display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: "50%", background: C.orange, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: C.dark }}>DH</div>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>diana hunter</div>
            <div style={{ fontSize: 12, color: C.textSub }}>vp sales, enterprise software</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HomePage({ navigate }) {
  return (
    <PageWrapper>
      <Hero navigate={navigate} />
      <PlatformShowcase />
      <InsightsSection />
      <GamesSection navigate={navigate} />
      <ProfilesSection />
      <FeaturesGrid />
      <LearningPaths />
      <EvaluationSection />
      <TestimonialSection />
      <CTABanner navigate={navigate} />
    </PageWrapper>
  );
}

// ── SOLUTION PAGE ──────────────────────────────────────────────
function ProductPreview() {
  const [ref, visible] = useInView();
  const [active, setActive] = useState(0);
  const features = [
    { label: "Learn",        headline: "Courses that build real knowledge",      desc: "Structured learning paths with video, text, and assessments. Track progress per module, not just overall completion.", visual: <LearnMockup /> },
    { label: "Games",        headline: "Make competition the classroom",         desc: "Live multiplayer games turn training into events. Reps compete. Knowledge sticks.", visual: <GameMockup /> },
    { label: "Quizzes",      headline: "Spot gaps before they cost you",         desc: "Targeted assessments surface exactly where knowledge breaks down — by rep, by topic, by team.", visual: <QuizMockup /> },
    { label: "Battle Cards", headline: "The right answer at the right moment",   desc: "Objection handlers, competitor intel, and talk tracks — searchable and always current.", visual: <BattleCardMockup /> },
  ];
  return (
    <section style={{ ...S.section, background: C.pageBg }}>
      <div ref={ref} style={{ ...S.container }}>
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <span style={S.sectionLabel}>Product</span>
          <h2 style={{ ...S.h2, ...S.fadeUp(visible), maxWidth: 520, margin: "0 auto 14px" }}>Every tool your team needs to stay sharp.</h2>
          <p style={{ ...S.bodyLarge, ...S.fadeUp(visible, 0.07), margin: "0 auto", textAlign: "center" }}>
            ralli bundles learning, practice, and readiness measurement in one place — no duct tape, no context switching.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 28, flexWrap: "wrap" }}>
          {features.map((f,i) => (
            <button key={i} onClick={() => setActive(i)} style={{
              fontSize: 14, fontWeight: 600,
              color: active===i?C.dark:C.textSub,
              background: active===i?C.orange:C.white,
              border: `1.5px solid ${active===i?C.orange:C.border}`,
              borderRadius: 8, padding: "7px 16px", cursor: "pointer", transition: "all 0.15s",
            }}>
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 48, alignItems: "center", background: C.white, borderRadius: 18, border: `1px solid ${C.border}`, padding: 36, boxShadow: "0 8px 32px rgba(11,18,32,0.06)" }}>
          <div>
            <h3 style={{ fontSize: 24, fontWeight: 800, color: C.text, marginBottom: 12, lineHeight: 1.2 }}>{features[active].headline}</h3>
            <p style={{ fontSize: 15, color: C.textSub, lineHeight: 1.65 }}>{features[active].desc}</p>
          </div>
          <div>{features[active].visual}</div>
        </div>
      </div>
    </section>
  );
}

function ReadinessAnalytics() {
  const [ref, visible] = useInView();
  return (
    <section style={{ ...S.section, background: C.white }}>
      <div ref={ref} style={{ ...S.container }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, alignItems: "center" }}>
          <div style={S.fadeUp(visible, 0.07)}><AnalyticsMockup /></div>
          <div>
            <span style={S.sectionLabel}>Readiness Analytics</span>
            <h2 style={{ ...S.h2, ...S.fadeUp(visible) }}>Know who's ready before the call happens.</h2>
            <p style={{ ...S.bodyLarge, ...S.fadeUp(visible, 0.07), marginBottom: 26 }}>
              ralli surfaces readiness scores, knowledge gaps, and coaching signals at the rep and team level — so you can act before performance suffers.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { label: "Readiness scores per rep",    desc: "Not just completion — actual assessed comprehension." },
                { label: "Knowledge heatmaps by topic", desc: "See exactly where gaps are concentrated across your team." },
                { label: "Coaching signals",             desc: "Auto-surface the reps who need attention before quota is missed." },
              ].map((f,i) => (
                <div key={i} style={{ ...S.fadeUp(visible, 0.12+i*0.06), display: "flex", gap: 12 }}>
                  <div style={{ width:18,height:18,borderRadius:5,background:C.orange,flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center" }}>
                    <svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L4 7L9 1" stroke={C.dark} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  <div>
                    <div style={{ fontSize:13,fontWeight:700,color:C.text,marginBottom:2 }}>{f.label}</div>
                    <div style={{ fontSize:13,color:C.textSub,lineHeight:1.55 }}>{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function AnalyticsMockup() {
  const topics = [
    {name:"Discovery",score:91},{name:"Objection Handling",score:58},{name:"Pricing",score:74},{name:"Closing",score:83},{name:"Compliance",score:95},
  ];
  return (
    <div style={{ background: C.pageBg, borderRadius: 16, border: `1px solid ${C.border}`, padding: 20, boxShadow: "0 8px 32px rgba(11,18,32,0.07)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>Team Readiness Overview</div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 18 }}>June 2026 · 18 reps</div>
      <div style={{ display: "flex", gap: 18, alignItems: "center", marginBottom: 22 }}>
        <div style={{ position: "relative", width: 76, height: 76, flexShrink: 0 }}>
          <svg width="76" height="76" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="32" fill="none" stroke="#F1F5F9" strokeWidth="10"/>
            <circle cx="40" cy="40" r="32" fill="none" stroke={C.orange} strokeWidth="10" strokeDasharray={`${2*Math.PI*32*0.78} ${2*Math.PI*32*0.22}`} strokeDashoffset={2*Math.PI*32*0.25} strokeLinecap="round"/>
          </svg>
          <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <span style={{ fontSize:15,fontWeight:900,color:C.text }}>78%</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize:11,color:C.textMuted,marginBottom:3 }}>Overall Readiness</div>
          <div style={{ fontSize:12,fontWeight:700,color:"#16A34A" }}>↑ 6 pts vs. last month</div>
          <div style={{ fontSize:11,color:C.textMuted,marginTop:5 }}>4 reps below 60% threshold</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {topics.map((t,i) => {
          const c = t.score>=80?"#22C55E":t.score>=60?C.orange:"#EF4444";
          return (
            <div key={i}>
              <div style={{ display:"flex",justifyContent:"space-between",marginBottom:3 }}>
                <span style={{ fontSize:11,fontWeight:600,color:C.textSub }}>{t.name}</span>
                <span style={{ fontSize:11,fontWeight:700,color:C.text }}>{t.score}%</span>
              </div>
              <div style={{ height:5,background:"#F1F5F9",borderRadius:3 }}>
                <div style={{ height:"100%",width:`${t.score}%`,background:c,borderRadius:3 }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LearnMockup() {
  const lessons = [
    {title:"Intro to Discovery",progress:100,done:true},{title:"Building the Business Case",progress:72,done:false},{title:"Handling Objections",progress:0,done:false},{title:"Closing Frameworks",progress:0,done:false},
  ];
  return (
    <div style={{ background: C.pageBg, borderRadius: 11, border: `1px solid ${C.border}`, padding: 14 }}>
      <div style={{ fontSize:10,fontWeight:700,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10 }}>Enterprise Sales Path</div>
      <div style={{ display:"flex",flexDirection:"column",gap:7 }}>
        {lessons.map((l,i) => (
          <div key={i} style={{ background:C.white,borderRadius:7,border:`1px solid ${C.border}`,padding:"9px 12px",display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:18,height:18,borderRadius:"50%",background:l.done?C.orange:C.borderLight,border:`2px solid ${l.done?C.orange:C.border}`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
              {l.done && <svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4L4 7L9 1" stroke={C.dark} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontSize:11,fontWeight:600,color:C.text,marginBottom:l.progress>0&&!l.done?3:0 }}>{l.title}</div>
              {l.progress>0&&!l.done&&<div style={{ height:3,background:C.borderLight,borderRadius:2 }}><div style={{ height:"100%",width:`${l.progress}%`,background:C.orange,borderRadius:2 }} /></div>}
            </div>
            {l.progress>0&&!l.done&&<div style={{ fontSize:10,fontWeight:700,color:C.textMuted }}>{l.progress}%</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function GameMockup() {
  const players = [{name:"Jordan M.",score:2400,rank:1},{name:"Taylor S.",score:2100,rank:2},{name:"Riley K.",score:1950,rank:3},{name:"Alex P.",score:1700,rank:4}];
  return (
    <div style={{ background:C.dark,borderRadius:11,padding:14 }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
        <div style={{ fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.08em" }}>Live Game — Q3</div>
        <div style={{ fontSize:10,fontWeight:700,color:C.orange,background:"rgba(253,191,36,0.12)",borderRadius:100,padding:"2px 8px" }}>⚡ LIVE</div>
      </div>
      {players.map((p,i) => (
        <div key={i} style={{ display:"flex",alignItems:"center",gap:9,padding:"7px 0",borderBottom:i<players.length-1?"1px solid rgba(255,255,255,0.06)":"none" }}>
          <div style={{ fontSize:10,fontWeight:700,color:i===0?C.orange:"rgba(255,255,255,0.3)",minWidth:14 }}>#{p.rank}</div>
          <div style={{ width:22,height:22,borderRadius:"50%",background:`hsl(${i*80},60%,55%)`,flexShrink:0 }} />
          <div style={{ flex:1,fontSize:11,fontWeight:600,color:C.white }}>{p.name}</div>
          <div style={{ fontSize:12,fontWeight:800,color:i===0?C.orange:"rgba(255,255,255,0.7)" }}>{p.score.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function QuizMockup() {
  return (
    <div style={{ background:C.white,borderRadius:11,border:`1px solid ${C.border}`,padding:14 }}>
      <div style={{ fontSize:10,fontWeight:700,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10 }}>Question 4 of 8</div>
      <div style={{ fontSize:13,fontWeight:700,color:C.text,marginBottom:12,lineHeight:1.45 }}>A prospect says "your price is too high." What's the most effective first response?</div>
      {[{text:"Offer an immediate discount",correct:false,selected:false},{text:"Anchor to the cost of inaction",correct:true,selected:true},{text:"Explain your pricing model in detail",correct:false,selected:false},{text:"Ask what their budget is",correct:false,selected:false}].map((o,i) => (
        <div key={i} style={{ padding:"8px 11px",borderRadius:7,border:`1.5px solid ${o.selected?(o.correct?"#22C55E":"#EF4444"):C.border}`,background:o.selected?(o.correct?"#F0FDF4":"#FEF2F2"):C.pageBg,marginBottom:5,fontSize:12,fontWeight:o.selected?700:500,color:o.selected?(o.correct?"#16A34A":"#DC2626"):C.textSub }}>
          {o.text}
        </div>
      ))}
    </div>
  );
}

function BattleCardMockup() {
  return (
    <div style={{ background:C.white,borderRadius:11,border:`1px solid ${C.border}`,padding:14 }}>
      <div style={{ display:"flex",alignItems:"center",gap:7,marginBottom:12 }}>
        <div style={{ fontSize:9,fontWeight:700,color:"#DC2626",background:"#FEF2F2",borderRadius:100,padding:"2px 7px",textTransform:"uppercase",letterSpacing:"0.06em" }}>Competitor</div>
        <div style={{ fontSize:12,fontWeight:800,color:C.text }}>vs. Competitor X</div>
      </div>
      <div style={{ fontSize:10,fontWeight:700,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:7 }}>When they say:</div>
      <div style={{ fontSize:12,fontWeight:600,color:C.text,fontStyle:"italic",marginBottom:10,lineHeight:1.45 }}>"Competitor X has all the same features for less."</div>
      <div style={{ fontSize:10,fontWeight:700,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:7 }}>You say:</div>
      <div style={{ fontSize:12,color:C.textSub,lineHeight:1.6,borderLeft:`3px solid ${C.orange}`,paddingLeft:10 }}>
        "You're right that pricing looks similar. The difference is what you get on the back end — ralli shows you which reps are actually ready to close, not just who clicked through a module."
      </div>
    </div>
  );
}

function SolutionPage({ navigate }) {
  return (
    <PageWrapper>
      <section style={{ ...S.section, padding: "80px 24px 48px", background: C.pageBg, textAlign: "center" }}>
        <div style={{ ...S.container }}>
          <span style={S.sectionLabel}>Solution</span>
          <h1 style={{ fontSize: clamp(32, 56), fontWeight: 900, color: C.text, lineHeight: 1.1, letterSpacing: "-0.03em", maxWidth: 640, margin: "12px auto 16px" }}>
            Built for the teams who can't afford to guess who's ready.
          </h1>
          <p style={{ fontSize: 18, color: C.textSub, lineHeight: 1.65, maxWidth: 480, margin: "0 auto" }}>
            Every feature in ralli feeds a single output: a clear, honest readiness signal for every rep on your team.
          </p>
        </div>
      </section>
      <ProductPreview />
      <ReadinessAnalytics />
      <CTABanner navigate={navigate} />
    </PageWrapper>
  );
}

// ── MEET THE TEAM PAGE ─────────────────────────────────────────
const TEAM = [
  {
    name:  "Avanti Fernandes",
    role:  "Founder & CEO",
    bio:   "Building software that gives sales teams an honest picture of who's ready. Former operator who got tired of watching quota suffer because training reports looked fine.",
    color: "#FDBF24",
  },
  {
    name:  "Coming Soon",
    role:  "Head of Product",
    bio:   "We're growing. If you're obsessed with how reps actually learn and retain knowledge, we'd like to talk.",
    color: "#A78BFA",
    open:  true,
  },
  {
    name:  "Coming Soon",
    role:  "Head of Engineering",
    bio:   "Looking for someone who can ship fast and build systems that scale. Real-time, multi-tenant, production-ready from day one.",
    color: "#34D399",
    open:  true,
  },
  {
    name:  "Coming Soon",
    role:  "Head of Customer Success",
    bio:   "We want someone who measures their success by how fast our customers see theirs.",
    color: "#60A5FA",
    open:  true,
  },
];

function TeamPage({ navigate }) {
  const [ref, visible] = useInView(0.05);
  return (
    <PageWrapper>
      {/* Header */}
      <section style={{ ...S.section, padding: "80px 24px 64px", background: "linear-gradient(180deg,#FFFDF5 0%,#F7F8FA 100%)", textAlign: "center" }}>
        <div style={{ ...S.container }}>
          <span style={S.sectionLabel}>Meet the Team</span>
          <h1 style={{ fontSize: clamp(32, 54), fontWeight: 900, color: C.text, lineHeight: 1.1, letterSpacing: "-0.03em", maxWidth: 580, margin: "12px auto 16px" }}>
            Small team. Serious focus.
          </h1>
          <p style={{ fontSize: 17, color: C.textSub, lineHeight: 1.65, maxWidth: 440, margin: "0 auto" }}>
            We're building ralli to be the readiness platform we wished existed when we were managing sales teams.
          </p>
        </div>
      </section>

      {/* Team grid */}
      <section style={{ ...S.section, padding: "64px 24px 96px", background: C.pageBg }}>
        <div ref={ref} style={{ ...S.container }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 20 }}>
            {TEAM.map((m, i) => (
              <div key={i} style={{
                ...S.fadeUp(visible, i * 0.07),
                background:   C.white,
                borderRadius: 18,
                border:       `1px solid ${m.open ? C.border : C.border}`,
                padding:      28,
                boxShadow:    "0 4px 20px rgba(11,18,32,0.06)",
                position:     "relative",
                overflow:     "hidden",
              }}>
                {/* Top accent */}
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: m.color, borderRadius: "18px 18px 0 0" }} />

                {/* Avatar */}
                <div style={{
                  width:          52,
                  height:         52,
                  borderRadius:   "50%",
                  background:     m.open ? `${m.color}20` : m.color,
                  border:         m.open ? `2px dashed ${m.color}` : "none",
                  display:        "flex",
                  alignItems:     "center",
                  justifyContent: "center",
                  marginBottom:   16,
                  fontSize:       m.open ? 20 : 20,
                  fontWeight:     800,
                  color:          m.open ? m.color : C.dark,
                }}>
                  {m.open ? "+" : m.name.split(" ").map(n => n[0]).join("")}
                </div>

                {/* Info */}
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text, marginBottom: 3 }}>{m.name}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: m.open ? m.color : C.orange, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  {m.open ? "Open Role · " : ""}{m.role}
                </div>
                <p style={{ fontSize: 13, color: C.textSub, lineHeight: 1.6 }}>{m.bio}</p>

                {m.open && (
                  <button
                    onClick={() => { navigate("contact"); window.scrollTo({ top: 0 }); }}
                    style={{
                      marginTop:    16,
                      fontSize:     12,
                      fontWeight:   700,
                      color:        C.dark,
                      background:   C.orange,
                      border:       "none",
                      borderRadius: 7,
                      padding:      "7px 14px",
                      cursor:       "pointer",
                    }}
                  >
                    Get in touch →
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Values strip */}
          <div style={{ marginTop: 64 }}>
            <div style={{ textAlign: "center", marginBottom: 36 }}>
              <h2 style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 10 }}>How we work</h2>
              <p style={{ fontSize: 15, color: C.textSub, maxWidth: 400, margin: "0 auto" }}>
                A few things we hold onto, especially when moving fast.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 16 }}>
              {[
                { title: "Operators first",         desc: "We build for the people doing the work, not the people watching dashboards." },
                { title: "Ship, then improve",       desc: "Imperfect and in production beats perfect and in planning." },
                { title: "Readiness is the metric", desc: "We measure ourselves the same way we want our customers to measure their teams." },
                { title: "No BS",                   desc: "Honest feedback, direct communication, no corporate theater." },
              ].map((v, i) => (
                <div key={i} style={{ background: C.white, borderRadius: 14, border: `1px solid ${C.border}`, padding: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 6 }}>{v.title}</div>
                  <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.55 }}>{v.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <CTABanner navigate={navigate} />
    </PageWrapper>
  );
}

// ── CONTACT PAGE ───────────────────────────────────────────────
function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", company: "", role: "", message: "", type: "demo" });
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState(null);

  const validate = () => {
    const e = {};
    if (!form.name.trim())    e.name    = "Required";
    if (!form.email.trim())   e.email   = "Required";
    else if (!/\S+@\S+\.\S+/.test(form.email)) e.email = "Enter a valid email";
    if (!form.message.trim()) e.message = "Required";
    return e;
  };

  const handleSubmit = async (evt) => {
    evt.preventDefault();
    if (loading) return;                          // block duplicate clicks
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    setApiError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/contact", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          type:    form.type,
          name:    form.name,
          email:   form.email,
          company: form.company,
          role:    form.role,
          message: form.message,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setApiError(data?.error ?? "Something went wrong. Please try again.");
        return;
      }
      setSubmitted(true);
    } catch (_) {
      setApiError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const set = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    if (errors[k]) setErrors(e => { const ne = { ...e }; delete ne[k]; return ne; });
    if (apiError)  setApiError(null);
  };

  const inputStyle = (key) => ({
    width:        "100%",
    padding:      "10px 14px",
    fontSize:     14,
    color:        C.text,
    background:   C.white,
    border:       `1.5px solid ${errors[key] ? "#EF4444" : C.border}`,
    borderRadius: 9,
    outline:      "none",
    boxSizing:    "border-box",
    fontFamily:   "inherit",
    transition:   "border-color 0.15s",
  });

  const labelStyle = { fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6, display: "block" };

  if (submitted) {
    return (
      <PageWrapper>
        <section style={{ ...S.section, padding: "120px 24px", minHeight: "80vh", display: "flex", alignItems: "center" }}>
          <div style={{ ...S.container, textAlign: "center" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: C.orangeLight, border: `2px solid ${C.orange}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
              <svg width="26" height="22" viewBox="0 0 26 22" fill="none"><path d="M2 12L9 19L24 3" stroke={C.orangeDeep} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <h2 style={{ fontSize: 30, fontWeight: 800, color: C.text, marginBottom: 12 }}>We'll be in touch.</h2>
            <p style={{ fontSize: 16, color: C.textSub, lineHeight: 1.65, maxWidth: 380, margin: "0 auto" }}>
              Thanks, {form.name.split(" ")[0]}. We'll follow up within one business day.
            </p>
          </div>
        </section>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      {/* Header */}
      <section style={{ ...S.section, padding: "80px 24px 56px", background: "linear-gradient(180deg,#FFFDF5 0%,#F7F8FA 100%)", textAlign: "center" }}>
        <div style={{ ...S.container }}>
          <span style={S.sectionLabel}>Contact</span>
          <h1 style={{ fontSize: clamp(30, 52), fontWeight: 900, color: C.text, lineHeight: 1.1, letterSpacing: "-0.03em", maxWidth: 520, margin: "12px auto 14px" }}>
            Let's talk readiness.
          </h1>
          <p style={{ fontSize: 17, color: C.textSub, lineHeight: 1.65, maxWidth: 400, margin: "0 auto" }}>
            Whether you want a demo, have a question, or are interested in joining the team — we're here.
          </p>
        </div>
      </section>

      {/* Form + info */}
      <section style={{ ...S.section, padding: "56px 24px 96px", background: C.pageBg }}>
        <div style={{ ...S.container }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 48, alignItems: "start" }}>
            {/* Form */}
            <div style={{ background: C.white, borderRadius: 18, border: `1px solid ${C.border}`, padding: 36, boxShadow: "0 8px 32px rgba(11,18,32,0.06)" }}>
              {/* Type selector */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>I'm reaching out about</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {[
                    { value: "demo",    label: "Book a Demo" },
                    { value: "general", label: "General Inquiry" },
                    { value: "join",    label: "Joining the Team" },
                  ].map(t => (
                    <button
                      key={t.value}
                      onClick={() => set("type", t.value)}
                      style={{
                        fontSize:     13,
                        fontWeight:   600,
                        color:        form.type === t.value ? C.dark : C.textSub,
                        background:   form.type === t.value ? C.orange : C.pageBg,
                        border:       `1.5px solid ${form.type === t.value ? C.orange : C.border}`,
                        borderRadius: 8,
                        padding:      "7px 14px",
                        cursor:       "pointer",
                        transition:   "all 0.15s",
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <form onSubmit={handleSubmit} noValidate>
                {/* Name + Email row */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Name *</label>
                    <input
                      value={form.name}
                      onChange={e => set("name", e.target.value)}
                      placeholder="Jordan Miller"
                      style={inputStyle("name")}
                      onFocus={e => e.target.style.borderColor = C.orange}
                      onBlur={e => e.target.style.borderColor = errors.name ? "#EF4444" : C.border}
                    />
                    {errors.name && <div style={{ fontSize: 11, color: "#EF4444", marginTop: 4 }}>{errors.name}</div>}
                  </div>
                  <div>
                    <label style={labelStyle}>Email *</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={e => set("email", e.target.value)}
                      placeholder="jordan@company.com"
                      style={inputStyle("email")}
                      onFocus={e => e.target.style.borderColor = C.orange}
                      onBlur={e => e.target.style.borderColor = errors.email ? "#EF4444" : C.border}
                    />
                    {errors.email && <div style={{ fontSize: 11, color: "#EF4444", marginTop: 4 }}>{errors.email}</div>}
                  </div>
                </div>

                {/* Company + Role row */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Company</label>
                    <input
                      value={form.company}
                      onChange={e => set("company", e.target.value)}
                      placeholder="Acme Corp"
                      style={inputStyle("company")}
                      onFocus={e => e.target.style.borderColor = C.orange}
                      onBlur={e => e.target.style.borderColor = C.border}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Your Role</label>
                    <input
                      value={form.role}
                      onChange={e => set("role", e.target.value)}
                      placeholder="VP of Sales"
                      style={inputStyle("role")}
                      onFocus={e => e.target.style.borderColor = C.orange}
                      onBlur={e => e.target.style.borderColor = C.border}
                    />
                  </div>
                </div>

                {/* Message */}
                <div style={{ marginBottom: 24 }}>
                  <label style={labelStyle}>Message *</label>
                  <textarea
                    value={form.message}
                    onChange={e => set("message", e.target.value)}
                    placeholder={
                      form.type === "demo"    ? "Tell us about your team — size, current tools, what you're trying to solve..." :
                      form.type === "join"    ? "Tell us about your background and what role interests you..." :
                      "What's on your mind?"
                    }
                    rows={5}
                    style={{ ...inputStyle("message"), resize: "vertical", lineHeight: 1.55 }}
                    onFocus={e => e.target.style.borderColor = C.orange}
                    onBlur={e => e.target.style.borderColor = errors.message ? "#EF4444" : C.border}
                  />
                  {errors.message && <div style={{ fontSize: 11, color: "#EF4444", marginTop: 4 }}>{errors.message}</div>}
                </div>

                {/* API-level error banner */}
                {apiError && (
                  <div style={{
                    marginBottom: 16,
                    padding:      "11px 14px",
                    borderRadius: 8,
                    background:   "#FEF2F2",
                    border:       "1px solid #FECACA",
                    fontSize:     13,
                    color:        "#DC2626",
                    lineHeight:   1.5,
                  }}>
                    {apiError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width:        "100%",
                    fontSize:     15,
                    fontWeight:   700,
                    color:        C.dark,
                    background:   loading ? "#FDE68A" : C.orange,
                    border:       "none",
                    borderRadius: 10,
                    padding:      "13px 0",
                    cursor:       loading ? "not-allowed" : "pointer",
                    boxShadow:    loading ? "none" : "0 4px 16px rgba(253,191,36,0.35)",
                    transition:   "transform 0.15s, box-shadow 0.15s, background 0.15s",
                    display:      "flex",
                    alignItems:   "center",
                    justifyContent: "center",
                    gap:          8,
                  }}
                  onMouseEnter={e => { if (!loading) { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 6px 22px rgba(253,191,36,0.45)"; } }}
                  onMouseLeave={e => { if (!loading) { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(253,191,36,0.35)"; } }}
                >
                  {loading && (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ animation: "spin 0.8s linear infinite" }}>
                      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                      <circle cx="8" cy="8" r="6" stroke={C.dark} strokeOpacity="0.25" strokeWidth="2.5"/>
                      <path d="M8 2a6 6 0 0 1 6 6" stroke={C.dark} strokeWidth="2.5" strokeLinecap="round"/>
                    </svg>
                  )}
                  {loading
                    ? "Sending…"
                    : form.type === "demo" ? "Request Demo" : form.type === "join" ? "Send Application" : "Send Message"
                  }
                </button>
              </form>
            </div>

            {/* Sidebar info */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { icon: "📧", label: "Email",    value: "avanti@runralli.com" },
                { icon: "⚡", label: "Response", value: "Within 1 business day" },
              ].map((item, i) => (
                <div key={i} style={{ background: C.white, borderRadius: 14, border: `1px solid ${C.border}`, padding: "18px 20px" }}>
                  <div style={{ fontSize: 18, marginBottom: 6 }}>{item.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>{item.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{item.value}</div>
                </div>
              ))}

              <div style={{ background: C.orangeLight, borderRadius: 14, border: "1px solid rgba(253,191,36,0.35)", padding: "18px 20px" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 6 }}>Booking a demo?</div>
                <p style={{ fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>
                  We'll walk you through the full readiness workflow — Learn, Practice, Compete, Measure, Improve — and show you what a team readiness score actually looks like.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PageWrapper>
  );
}

// ── LEGAL PAGES ────────────────────────────────────────────────
function LegalSection({ title, children }) {
  return (
    <div style={{ marginBottom: 40 }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 14, paddingBottom: 10, borderBottom: `1px solid ${C.border}` }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function LegalP({ children }) {
  return (
    <p style={{ fontSize: 15, color: C.textSub, lineHeight: 1.75, marginBottom: 12 }}>
      {children}
    </p>
  );
}

function PrivacyPage({ navigate }) {
  return (
    <PageWrapper>
      <section style={{ ...S.section, padding: "80px 24px 48px", background: "linear-gradient(180deg,#FFFDF5 0%,#F7F8FA 100%)", textAlign: "center" }}>
        <div style={{ ...S.container }}>
          <span style={S.sectionLabel}>Legal</span>
          <h1 style={{ fontSize: clamp(30, 48), fontWeight: 900, color: C.text, lineHeight: 1.1, letterSpacing: "-0.02em", maxWidth: 560, margin: "12px auto 14px" }}>
            Privacy Policy
          </h1>
          <p style={{ fontSize: 15, color: C.textMuted, maxWidth: 400, margin: "0 auto" }}>
            Last updated: July 2026
          </p>
        </div>
      </section>

      <section style={{ ...S.section, padding: "56px 24px 96px", background: C.pageBg }}>
        <div style={{ ...S.container, maxWidth: 740 }}>
          <LegalP>
            ralli ("we," "our," or "us") is committed to protecting the privacy of the individuals who use our platform. This Privacy Policy describes how we collect, use, and share information when you visit runralli.com or use the ralli platform.
          </LegalP>

          <LegalSection title="1. Information We Collect">
            <LegalP>
              <strong>Account information.</strong> When you sign up for ralli, we collect your name, email address, company name, and role. Organization administrators may also provide team member information when setting up accounts.
            </LegalP>
            <LegalP>
              <strong>Usage data.</strong> We collect information about how you interact with the platform — courses completed, quiz scores, game participation, and readiness scores. This data is used to generate the analytics and readiness insights that are core to the product.
            </LegalP>
            <LegalP>
              <strong>Contact form submissions.</strong> If you contact us through the website, we collect the name, email, company, role, and message you provide.
            </LegalP>
            <LegalP>
              <strong>Technical data.</strong> We collect standard server logs, IP addresses, browser type, and device information for security and performance monitoring.
            </LegalP>
          </LegalSection>

          <LegalSection title="2. How We Use Your Information">
            <LegalP>We use collected information to provide and improve the ralli platform, authenticate users, generate readiness analytics, send product and account communications, respond to support and sales inquiries, and comply with legal obligations.</LegalP>
            <LegalP>We do not sell your personal information to third parties.</LegalP>
          </LegalSection>

          <LegalSection title="3. Data Sharing">
            <LegalP>
              <strong>Within your organization.</strong> Readiness scores and progress data are visible to managers and administrators within your organization as configured by your team's settings.
            </LegalP>
            <LegalP>
              <strong>Service providers.</strong> We share data with third-party service providers who support our operations — including Supabase (database and authentication), Resend (email delivery), and Vercel (hosting). These providers are contractually required to protect your data and use it only to perform services on our behalf.
            </LegalP>
            <LegalP>
              <strong>Legal requirements.</strong> We may disclose information if required by law or to protect the rights, safety, or property of ralli or others.
            </LegalP>
          </LegalSection>

          <LegalSection title="4. Data Retention">
            <LegalP>We retain account and usage data for as long as your organization maintains an active account with ralli. Upon account cancellation, data is deleted within 90 days unless retention is required by law.</LegalP>
          </LegalSection>

          <LegalSection title="5. Security">
            <LegalP>We use industry-standard security practices including encryption in transit (TLS), row-level security on all database records, and access controls that enforce organizational data isolation. No security system is perfect; we cannot guarantee the absolute security of your information.</LegalP>
          </LegalSection>

          <LegalSection title="6. Cookies">
            <LegalP>We use session cookies for authentication and local storage for user preferences. We do not use third-party advertising cookies. Analytics, if implemented, use privacy-respecting tools that do not track users across sites.</LegalP>
          </LegalSection>

          <LegalSection title="7. Your Rights">
            <LegalP>Depending on your location, you may have rights to access, correct, delete, or export your personal data. To make a request, contact us at <a href="mailto:avanti@runralli.com" style={{ color: C.orangeDeep, textDecoration: "none" }}>avanti@runralli.com</a>. We will respond within 30 days.</LegalP>
          </LegalSection>

          <LegalSection title="8. Children">
            <LegalP>ralli is intended for business use by adults. We do not knowingly collect personal information from individuals under 16 years of age.</LegalP>
          </LegalSection>

          <LegalSection title="9. Changes to This Policy">
            <LegalP>We may update this Privacy Policy from time to time. We will notify account holders of material changes via email. Continued use of the platform after changes take effect constitutes acceptance of the updated policy.</LegalP>
          </LegalSection>

          <LegalSection title="10. Contact">
            <LegalP>
              Questions about this Privacy Policy? Email us at{" "}
              <a href="mailto:avanti@runralli.com" style={{ color: C.orangeDeep, textDecoration: "none" }}>avanti@runralli.com</a>.
            </LegalP>
          </LegalSection>

          <div style={{ paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
            <button
              onClick={() => { navigate("home"); window.scrollTo({ top: 0 }); }}
              style={{ fontSize: 14, fontWeight: 600, color: C.orangeDeep, background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              ← Back to ralli
            </button>
          </div>
        </div>
      </section>
    </PageWrapper>
  );
}

function TermsPage({ navigate }) {
  return (
    <PageWrapper>
      <section style={{ ...S.section, padding: "80px 24px 48px", background: "linear-gradient(180deg,#FFFDF5 0%,#F7F8FA 100%)", textAlign: "center" }}>
        <div style={{ ...S.container }}>
          <span style={S.sectionLabel}>Legal</span>
          <h1 style={{ fontSize: clamp(30, 48), fontWeight: 900, color: C.text, lineHeight: 1.1, letterSpacing: "-0.02em", maxWidth: 560, margin: "12px auto 14px" }}>
            Terms of Service
          </h1>
          <p style={{ fontSize: 15, color: C.textMuted, maxWidth: 400, margin: "0 auto" }}>
            Last updated: July 2026
          </p>
        </div>
      </section>

      <section style={{ ...S.section, padding: "56px 24px 96px", background: C.pageBg }}>
        <div style={{ ...S.container, maxWidth: 740 }}>
          <LegalP>
            By accessing or using the ralli platform at runralli.com, you agree to these Terms of Service. If you are using ralli on behalf of an organization, you represent that you have the authority to bind that organization to these terms.
          </LegalP>

          <LegalSection title="1. The Service">
            <LegalP>ralli is a sales readiness platform that provides learning management, gamification, quizzes, battle cards, and performance analytics for sales teams. We may update, modify, or discontinue features at any time with reasonable notice.</LegalP>
          </LegalSection>

          <LegalSection title="2. Accounts">
            <LegalP>You are responsible for maintaining the security of your account credentials. You must notify us immediately of any unauthorized access at <a href="mailto:avanti@runralli.com" style={{ color: C.orangeDeep, textDecoration: "none" }}>avanti@runralli.com</a>.</LegalP>
            <LegalP>Each organization using ralli is a separate tenant. You may not access data belonging to another organization. You may not create accounts on behalf of individuals without their knowledge.</LegalP>
          </LegalSection>

          <LegalSection title="3. Acceptable Use">
            <LegalP>You agree not to: use the platform for unlawful purposes; upload content that is defamatory, harassing, or violates third-party rights; attempt to reverse-engineer or circumvent any security measures; use automated tools to scrape or extract data; or interfere with the platform's availability for other users.</LegalP>
          </LegalSection>

          <LegalSection title="4. Your Content">
            <LegalP>You retain ownership of the training content, courses, quizzes, and battle cards you create within ralli. By uploading content, you grant ralli a limited license to store and display that content to authorized users within your organization.</LegalP>
            <LegalP>You are responsible for ensuring your content does not infringe any third-party intellectual property rights or violate applicable law.</LegalP>
          </LegalSection>

          <LegalSection title="5. ralli's Intellectual Property">
            <LegalP>The ralli platform, including its software, design, trademarks, and methodology, is owned by ralli and protected by intellectual property law. These Terms do not grant you any rights to our intellectual property beyond the right to use the platform as permitted herein.</LegalP>
          </LegalSection>

          <LegalSection title="6. Payment and Subscription">
            <LegalP>Subscription pricing, billing terms, and payment methods are set out in your order agreement or the plan selected at sign-up. All fees are non-refundable except as required by law or explicitly stated in your agreement. We reserve the right to suspend access for non-payment after reasonable notice.</LegalP>
          </LegalSection>

          <LegalSection title="7. Disclaimer of Warranties">
            <LegalP>ralli is provided "as is" without warranty of any kind, express or implied. We do not warrant that the platform will be error-free, uninterrupted, or that any specific business outcomes will result from use of the platform.</LegalP>
          </LegalSection>

          <LegalSection title="8. Limitation of Liability">
            <LegalP>To the fullest extent permitted by law, ralli shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising out of your use of the platform. Our total liability for any claim arising under these Terms shall not exceed the amounts you paid us in the 12 months preceding the claim.</LegalP>
          </LegalSection>

          <LegalSection title="9. Termination">
            <LegalP>Either party may terminate the agreement with 30 days' written notice. We may terminate immediately for material breach of these Terms. Upon termination, your access to the platform ceases and your data will be deleted within 90 days.</LegalP>
          </LegalSection>

          <LegalSection title="10. Governing Law">
            <LegalP>These Terms are governed by the laws of the State of Delaware, United States, without regard to its conflict of law provisions. Any disputes shall be resolved exclusively in the state or federal courts located in Delaware.</LegalP>
          </LegalSection>

          <LegalSection title="11. Changes to These Terms">
            <LegalP>We may update these Terms from time to time. We will provide at least 14 days' notice of material changes via email. Continued use of the platform after the effective date of changes constitutes acceptance.</LegalP>
          </LegalSection>

          <LegalSection title="12. Contact">
            <LegalP>
              Questions about these Terms? Email us at{" "}
              <a href="mailto:avanti@runralli.com" style={{ color: C.orangeDeep, textDecoration: "none" }}>avanti@runralli.com</a>.
            </LegalP>
          </LegalSection>

          <div style={{ paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
            <button
              onClick={() => { navigate("home"); window.scrollTo({ top: 0 }); }}
              style={{ fontSize: 14, fontWeight: 600, color: C.orangeDeep, background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              ← Back to ralli
            </button>
          </div>
        </div>
      </section>
    </PageWrapper>
  );
}

// ── FOOTER ─────────────────────────────────────────────────────
function Footer({ navigate }) {
  const handleNav = (id) => { navigate(id); window.scrollTo({ top: 0 }); };
  return (
    <footer style={{ background: C.dark, borderTop: "1px solid rgba(255,255,255,0.06)", padding: "40px 24px" }}>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 32, alignItems: "start", marginBottom: 32 }}>
          {/* Brand */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <img src="/assets/ralli-icon.png" alt="" aria-hidden="true" style={{ height: 18, width: "auto", display: "block" }} />
              <img src="/assets/ralli-logo-light.png" alt="ralli" style={{ height: 22, display: "block" }} />
            </div>
            <p style={{ fontSize:13,color:"rgba(255,255,255,0.3)",lineHeight:1.55,maxWidth:240 }}>
              The operational readiness platform for sales teams.
            </p>
          </div>
          {/* Links */}
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.3)",textTransform:"uppercase",letterSpacing:"0.09em",marginBottom:12 }}>Product</div>
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                {[{id:"home",label:"Home"},{id:"solution",label:"Solution"}].map(l => (
                  <button key={l.id} onClick={() => handleNav(l.id)} style={{ fontSize:13,color:"rgba(255,255,255,0.5)",background:"none",border:"none",cursor:"pointer",padding:0,textAlign:"left",transition:"color 0.15s" }}
                    onMouseEnter={e=>e.currentTarget.style.color="rgba(255,255,255,0.85)"}
                    onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,0.5)"}>
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.3)",textTransform:"uppercase",letterSpacing:"0.09em",marginBottom:12 }}>Company</div>
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                {[{id:"team",label:"Meet the Team"},{id:"contact",label:"Contact"}].map(l => (
                  <button key={l.id} onClick={() => handleNav(l.id)} style={{ fontSize:13,color:"rgba(255,255,255,0.5)",background:"none",border:"none",cursor:"pointer",padding:0,textAlign:"left",transition:"color 0.15s" }}
                    onMouseEnter={e=>e.currentTarget.style.color="rgba(255,255,255,0.85)"}
                    onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,0.5)"}>
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.3)",textTransform:"uppercase",letterSpacing:"0.09em",marginBottom:12 }}>Legal</div>
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                {[{id:"privacy",label:"Privacy Policy"},{id:"terms",label:"Terms of Service"}].map(l => (
                  <button key={l.id} onClick={() => handleNav(l.id)} style={{ fontSize:13,color:"rgba(255,255,255,0.5)",background:"none",border:"none",cursor:"pointer",padding:0,textAlign:"left",transition:"color 0.15s" }}
                    onMouseEnter={e=>e.currentTarget.style.color="rgba(255,255,255,0.85)"}
                    onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,0.5)"}>
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)",paddingTop:24,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12 }}>
          <div style={{ display:"flex",gap:20,alignItems:"center",flexWrap:"wrap" }}>
            <div style={{ fontSize:12,color:"rgba(255,255,255,0.25)" }}>© {new Date().getFullYear()} ralli. All rights reserved.</div>
            <button onClick={() => handleNav("privacy")} style={{ fontSize:12,color:"rgba(255,255,255,0.3)",background:"none",border:"none",cursor:"pointer",padding:0,transition:"color 0.15s" }}
              onMouseEnter={e=>e.currentTarget.style.color="rgba(255,255,255,0.65)"}
              onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,0.3)"}>
              Privacy
            </button>
            <button onClick={() => handleNav("terms")} style={{ fontSize:12,color:"rgba(255,255,255,0.3)",background:"none",border:"none",cursor:"pointer",padding:0,transition:"color 0.15s" }}
              onMouseEnter={e=>e.currentTarget.style.color="rgba(255,255,255,0.65)"}
              onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,0.3)"}>
              Terms
            </button>
          </div>
          <a href="/login" style={{ fontSize:12,color:"rgba(255,255,255,0.35)",textDecoration:"none",transition:"color 0.15s" }}
            onMouseEnter={e=>e.currentTarget.style.color="rgba(255,255,255,0.65)"}
            onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,0.35)"}>
            Login →
          </a>
        </div>
      </div>
    </footer>
  );
}

// ── ROOT ───────────────────────────────────────────────────────
const PAGE_TITLES = {
  home:     "ralli — Operational Readiness Platform",
  solution: "Solution — ralli",
  team:     "Meet the Team — ralli",
  contact:  "Contact — ralli",
  privacy:  "Privacy Policy — ralli",
  terms:    "Terms of Service — ralli",
};

const VALID_PAGES = new Set([
  ...NAV_LINKS.map(l => l.id),
  "privacy",
  "terms",
]);

export default function MarketingPage() {
  // Determine starting page from URL:
  //   /privacy  → "privacy"
  //   /terms    → "terms"
  //   /#section → that section
  //   /         → "home"
  const getInitialPage = () => {
    const p = window.location.pathname;
    if (p === "/privacy") return "privacy";
    if (p === "/terms")   return "terms";
    const hash = window.location.hash.replace("#", "");
    if (VALID_PAGES.has(hash)) return hash;
    return "home";
  };

  const [currentPage, setCurrentPage] = useState(getInitialPage);

  // Update document.title on every page change
  useEffect(() => {
    document.title = PAGE_TITLES[currentPage] ?? PAGE_TITLES.home;
  }, [currentPage]);

  const navigate = (page) => {
    setCurrentPage(page);
    // Legal pages get real paths; SPA sections keep hash; home → /
    if (page === "privacy" || page === "terms") {
      window.history.pushState(null, "", `/${page}`);
    } else if (page === "home") {
      window.history.pushState(null, "", "/");
    } else {
      window.history.pushState(null, "", `/#${page}`);
    }
  };

  const renderPage = () => {
    switch (currentPage) {
      case "solution": return <SolutionPage navigate={navigate} />;
      case "team":     return <TeamPage navigate={navigate} />;
      case "contact":  return <ContactPage />;
      case "privacy":  return <PrivacyPage navigate={navigate} />;
      case "terms":    return <TermsPage navigate={navigate} />;
      default:         return <HomePage navigate={navigate} />;
    }
  };

  return (
    <div style={{ fontFamily: "'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", background: C.pageBg }}>
      <Nav currentPage={currentPage} navigate={navigate} />
      {renderPage()}
      <Footer navigate={navigate} />
    </div>
  );
}
