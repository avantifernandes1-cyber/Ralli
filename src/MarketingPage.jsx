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
            <img src="data:image/png;base64,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" alt="ralli" style={{ height: 28, width: "auto", display: "block" }} />
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
            <div style={{ marginBottom: 10 }}>
              <img src="data:image/png;base64,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" alt="ralli" style={{ height: 24, width: "auto", display: "block" }} />
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
