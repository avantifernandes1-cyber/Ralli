import React, { useState, useEffect, useCallback, useRef } from "react";

// ── MULTI-TENANT ARCHITECTURE ─────────────────────────────────────────────────
// Data models, seed data, permissions, auth, and tenant service layers.
// Production: replace mock implementations with Supabase queries (see each module).
import { SEED_TENANTS, SEED_USERS, SEED_TENANT_SETTINGS } from "./src/data/seeds.js";
import {
  isRalliAdmin,
  FEATURE_CONFIG, normalizePlan, canAccess,
  DEFAULT_ROLE_PERMISSIONS, loadRolePermissions, saveRolePermissions, hasPermission,
} from "./src/lib/permissions.js";
// Auth and tenant service available for future wiring:
// import { mockLogin, resolveSession, buildSession } from "./src/lib/auth.js";
// import { createTenant, createTenantAdmin, activateTenant, suspendTenant } from "./src/lib/tenantService.js";

// ── SUPABASE REALTIME GAME ENGINE ─────────────────────────────────────────────
import { supabase } from "./src/lib/supabase.js";
import {
  createGameSession,
  findSessionByPin,
  startGameSession,
  endGameSession,
  getActiveSessions,
  joinGameSession,
  getLobbyParticipants,
  subscribeToLobbyParticipants,
  saveGameAnswers,
  updateSessionPhase,
  markParticipantLeft,
  updateParticipantHeartbeat,
  getPlayerGameHistory,
  getSessionPlayers,
  getSessionRestoreData,
} from "./src/lib/gameService.js";
import {
  getTenantCourses,
  getTenantLessons,
  getTenantQuizzes,
  upsertLesson,
  upsertCourse,
  upsertQuiz,
  deleteQuiz as dbDeleteQuiz,
  getLessonCompletions,
  markLessonComplete,
  getTenantAssignments,
  createAssignment as dbCreateAssignment,
  deleteAssignment as dbDeleteAssignment,
  archiveCourse as archiveCourseService,
  archiveLesson as archiveLessonService,
  restoreCourse as restoreCourseService,
  restoreLesson as restoreLessonService,
  getArchivedContent,
  getTenantLessonCompletions,
  saveQuizAttempt,
  getUserQuizAttempts,
  getTenantBcCategories,
  getTenantBattleCards,
  saveBcCategory   as dbSaveBcCategory,
  deleteBcCategory as dbDeleteBcCategory,
  saveBattleCard   as dbSaveBattleCard,
  deleteBattleCard as dbDeleteBattleCard,
  updateUserProfile as dbUpdateUserProfile,
  updateLastSeenAssignmentsAt,
} from "./src/lib/contentService.js";
import { getProfile, createMissingProfile, getTenantProfiles } from "./src/lib/profileService.js";
import { sendInviteEmail } from "./src/lib/emailService.js";
import { provisionTenant, buildInviteUrl, normalizeProvisionedOrg, createMemberInvite } from "./src/lib/provisioningService.js";
import { awardLessonPoints, awardCoursePoints, awardQuizPoints, awardGamePointsForSession, getLeaderboard, computeUserMeta, getUserStreak } from "./src/lib/scoringService.js";
import { triggerReadinessUpdate, getTopicHeatmap, getOrgMetrics, getRepTopicScores } from "./src/lib/insightsService.js";

// ── MOBILE HOOK ────────────────────────────────────────────
function useMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return mobile;
}

// ── GAME CHANNEL — Supabase Realtime (Broadcast + Presence) ───────────────────
//
// Replaces the BroadcastChannel implementation.
// Players on any device can join by PIN — no same-browser requirement.
//
// Architecture:
//   Presence  → player roster (PLAYER_JOIN / HOST_ACK dance eliminated)
//   Broadcast → all game control messages (GAME_START, SHOW_QUESTION, ANSWER, etc.)
//
// Return interface is identical to the old useGameChannel — no screen changes needed.

const GM = {
  PLAYER_JOIN:   "PLAYER_JOIN",
  PLAYER_LEAVE:  "PLAYER_LEAVE",
  HOST_ACK:      "HOST_ACK",      // kept for backward compat — no longer sent
  GAME_START:    "GAME_START",
  SHOW_QUESTION: "SHOW_QUESTION",
  ANSWER:        "ANSWER",
  OPEN_REVIEW:   "OPEN_REVIEW",   // host broadcasts: show responses + grading in progress
  REVEAL:        "REVEAL",
  SCOREBOARD:    "SCOREBOARD",
  NEXT_QUESTION: "NEXT_QUESTION",
  GAME_END:      "GAME_END",
  PAUSE:         "PAUSE",         // host broadcasts: game paused
  RESUME:        "RESUME",        // host broadcasts: game resumed
  FORCE_END:     "FORCE_END",     // host broadcasts: game ended early
};

const PLAYER_EMOJIS = ["🦊","🐯","🦁","🐺","🦅","🐬","🦄","🐉","🦋","🐙","🦖","🦈","🐸","🐼","🦝"];
const PLAYER_COLORS = ["#F97316","#3B82F6","#10B981","#8B5CF6","#F43F5E","#EAB308","#0EA5E9","#EC4899","#84CC16","#6366F1","#F59E0B","#14B8A6","#EF4444","#A855F7","#22C55E"];

function useGameChannel(pin, role) {
  const channelRef       = useRef(null);
  // Buffer for the player's track payload — flushed once the channel is SUBSCRIBED.
  // Fixes the race where ch.track() is called before the WebSocket handshake completes.
  const pendingTrackRef  = useRef(null);
  const [chPlayers, setChPlayers] = useState([]);
  const [chAnswers, setChAnswers] = useState({});   // { playerId: { optionIdx, timeMs, name, text } }
  const [chMsg,     setChMsg]     = useState(null); // latest inbound broadcast for player side

  useEffect(() => {
    if (!pin) return;

    // Each client gets a unique presence key so the host and all players
    // have distinct entries in the presence state map.
    const presenceKey = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const channel = supabase.channel(`game:${pin}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence:  { key: presenceKey },
      },
    });

    // ── Presence sync → player roster ─────────────────────────────────────────
    // Fires on every join/leave. Flatten all presence entries and filter to
    // user-role entries only (excludes the host's presence entry).
    channel.on("presence", { event: "sync" }, () => {
      const state   = channel.presenceState();
      const players = Object.values(state)
        .flat()
        .filter((p) => p.presenceRole === "user")
        .map((p) => ({
          id:    p.playerId,
          name:  p.name,
          emoji: p.emoji  ?? PLAYER_EMOJIS[0],
          color: p.color  ?? PLAYER_COLORS[0],
          score: 0,
        }));
      setChPlayers(players);
    });

    // ── Broadcast receive ──────────────────────────────────────────────────────
    channel.on("broadcast", { event: "*" }, ({ event, payload }) => {
      if (role === "admin") {
        // Host only cares about ANSWER events from players
        if (event === GM.ANSWER) {
          setChAnswers((prev) => ({
            ...prev,
            [payload.playerId]: {
              optionIdx: payload.optionIdx,
              timeMs:    payload.timeMs,
              name:      payload.name,
              text:      payload.text,
            },
          }));
        }
      } else {
        // Players receive all host broadcasts as chMsg (same shape as before)
        setChMsg({ type: event, ...payload });
      }
    });

    channelRef.current = channel;
    channel.subscribe((status) => {
      // Once subscribed, flush any track that was queued before the WebSocket was ready.
      if (status === 'SUBSCRIBED' && pendingTrackRef.current) {
        channel.track(pendingTrackRef.current);
        pendingTrackRef.current = null;
      }
    });

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      pendingTrackRef.current = null;
      setChPlayers([]);
      setChAnswers({});
      setChMsg(null);
    };
  }, [pin, role]);

  // ── broadcast ─────────────────────────────────────────────────────────────
  // Intercepts PLAYER_JOIN → tracks player in Presence instead of sending a message.
  // All other GM messages are sent via Supabase Broadcast.
  const broadcast = useCallback((msg) => {
    const ch = channelRef.current;
    if (!ch) return;

    const { type, ...payload } = msg;

    if (type === GM.PLAYER_JOIN) {
      // Buffer the track payload so the subscribe callback can flush it if the
      // WebSocket isn't ready yet (race condition on lobby mount).
      const trackData = {
        presenceRole: "user",
        playerId:     payload.player.id,
        name:         payload.player.name,
        emoji:        payload.player.emoji,
        color:        payload.player.color,
      };
      pendingTrackRef.current = trackData;
      // Also attempt immediately — succeeds if already SUBSCRIBED, is a no-op otherwise.
      ch.track(trackData);
      return;
    }

    // PLAYER_LEAVE: untrack from presence
    if (type === GM.PLAYER_LEAVE) {
      ch.untrack();
      return;
    }

    // All other messages: send via Broadcast
    ch.send({ type: "broadcast", event: type, payload });
  }, []);

  return { chPlayers, setChPlayers, chAnswers, setChAnswers, chMsg, broadcast };
}

// ── DESIGN TOKENS (exact Figma theme.css values) ────────────
// Font: Inter 400/500/600/700/800/900

const C = {
  // Backgrounds
  pageBg:        "#F6F7F9",        // --background (cool neutral, like Linear)
  sidebar:       "#FFFFFF",        // --sidebar (white)
  sidebarAccent: "#FFFBEF",        // --sidebar-accent (softer yellow tint)
  sidebarBorder: "rgba(11,18,32,0.05)",
  white:         "#FFFFFF",
  muted:         "#FFFBEF",        // --muted

  // Borders
  border:    "rgba(11,18,32,0.08)",
  inputBg:   "#F8F9FA",

  // Shadows
  shadowSm: "0 1px 2px rgba(11,18,32,0.05), 0 1px 4px rgba(11,18,32,0.04)",
  shadowMd: "0 2px 8px rgba(11,18,32,0.07), 0 1px 2px rgba(11,18,32,0.04)",
  shadowLg: "0 8px 24px rgba(11,18,32,0.09), 0 2px 6px rgba(11,18,32,0.05)",

  // Brand — Ralli Sunshine yellow
  orange:        "#FDBF24",        // --primary (golden yellow)
  orangeAmber:   "#FDBF24",
  orangeDeep:    "#CC9800",        // darker yellow
  orangeLight:   "#FFFBEF",        // --secondary/accent
  orangeBorder:  "#FFD86A",
  orangeDark:    "#CC9800",
  orangeGlow:    "rgba(253,191,36,0.15)",

  // Text
  text:              "#0B1220",    // --foreground (near black)
  textSub:           "#334155",    // --muted-foreground
  textMuted:         "#64748B",
  textSidebar:       "#334155",    // dark text on white sidebar
  textSidebarActive: "#0B1220",    // dark active text

  // Accents
  green:   "#FFD86A",   // secondary yellow (replaces green brand accent)
  lime:    "#FDBF24",
  blue:    "#0EA5E9",
  purple:  "#8B5CF6",
  red:     "#EF4444",
  yellow:  "#FDBF24",

  // Semantic bg tints
  greenBg:  "#FFFBEF",
  limeBg:   "#FFFBEF",
  redBg:    "#FEF2F2",
  blueBg:   "#F0F9FF",
  purpleBg: "#F5F3FF",

  // Dark — for full-screen game UI (stays dark intentionally)
  dark:    "#0B1220",
  darkAlt: "#1F2937",

  // Game surfaces (cream theme)
  cream:      "#FFF8E1",
  creamBorder:"#F5D567",
  cardBg:     "#FFFBF0",
  cardBorder: "#EDE8D4",
  trueGreen:  "#22C55E",
  trueGreenBg:"#DCFCE7",
  gamePurple: "#7C3AED",

  radius:   14,
  radiusSm:  8,
  radiusMd: 12,
  radiusLg: 20,
};

// ── FEATURE ACCESS + ROLE PERMISSIONS ────────────────────────────────────────
// Imported from src/lib/permissions.js (see that file for full documentation).
// FEATURE_CONFIG, normalizePlan, canAccess, DEFAULT_ROLE_PERMISSIONS,
// loadRolePermissions, saveRolePermissions, hasPermission, isRalliAdmin
// are all available as named imports above.

// ── RALLI LOGO ─────────────────────────────────────────────
function RalliLogo({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style={{ display: "block", flexShrink: 0 }}>
      <rect width="100" height="100" rx="22" fill="#FDBF24"/>
      {/* Four rounded pods at diagonal positions */}
      <circle cx="34" cy="34" r="22" fill="white"/>
      <circle cx="66" cy="34" r="22" fill="white"/>
      <circle cx="34" cy="66" r="22" fill="white"/>
      <circle cx="66" cy="66" r="22" fill="white"/>
      {/* Pentagon center cutout — reveals amber background */}
      <polygon points="50,39 62,47 57,61 43,61 38,47" fill="#FDBF24"/>
    </svg>
  );
}

// ── SHARED COMPONENTS ──────────────────────────────────────

function Avatar({ initials, size = 32, color = C.orange, bg }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: bg || color + "22",
      border: `2px solid ${color}44`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 700, color,
      flexShrink: 0,
    }}>
      {initials}
    </div>
  );
}

function ProgressBar({ value, max = 100, color = C.orange, height = 6, trackColor = C.muted }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div style={{ background: trackColor, borderRadius: 99, height, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${pct}%`, borderRadius: 99,
        background: color, transition: "width 0.5s ease",
      }} />
    </div>
  );
}

function Card({ children, style = {}, onClick, id }) {
  return (
    <div id={id} onClick={onClick} style={{
      background: C.white, borderRadius: 16,
      border: `1px solid ${C.border}`,
      boxShadow: C.shadowSm,
      padding: 20, ...style,
    }}>
      {children}
    </div>
  );
}

// ── SHARED LOADING / EMPTY / ERROR STATES ────────────────────────────────────
// Reusable across all first-load real-user screens.
// Demo mode: these components are never shown (data is always present from seed).

function LoadingState({ rows = 3, message = "Loading…" }) {
  return (
    <>
      <style>{`@keyframes ralliShimmer{0%{background-position:-600px 0}100%{background-position:600px 0}}`}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {message && <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 4 }}>{message}</div>}
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} style={{
            height: 52, borderRadius: 12,
            background: "linear-gradient(90deg, #f5f5f4 25%, #ece9e4 50%, #f5f5f4 75%)",
            backgroundSize: "1200px 100%",
            animation: "ralliShimmer 1.5s ease-in-out infinite",
            opacity: Math.max(0.4, 1 - i * 0.18),
          }} />
        ))}
      </div>
    </>
  );
}

function EmptyState({ icon = "📭", title = "Nothing here yet", message = "", action = null }) {
  return (
    <div style={{
      background: C.white, borderRadius: 14, border: `1px solid ${C.border}`,
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: "56px 40px", textAlign: "center", gap: 12,
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 14, background: C.orangeLight,
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22,
      }}>{icon}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{title}</div>
      {message && <p style={{ margin: 0, fontSize: 13, color: C.textSub, maxWidth: 320, lineHeight: 1.6 }}>{message}</p>}
      {action}
    </div>
  );
}

function ErrorState({ message = "Something went wrong.", onRetry = null }) {
  return (
    <div style={{
      background: "#FEF2F2", borderRadius: 14, border: "1px solid #FCA5A5",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: "44px 32px", textAlign: "center", gap: 10,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10, background: "#FEE2E2",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16, fontWeight: 900, color: "#B91C1C",
      }}>✕</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#B91C1C" }}>{message}</div>
      {onRetry && (
        <button onClick={onRetry} style={{
          marginTop: 4, padding: "7px 18px", borderRadius: 8, border: "none",
          background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>Try again</button>
      )}
    </div>
  );
}

// Shown to org admins on screens that require team data to be meaningful.
function OrgAdminEmptyScreen({ feature = "this feature", onGoToTeam }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 380, gap: 20, textAlign: "center", padding: 40 }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: C.orangeLight, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="3" width="8" height="8" rx="2" fill={C.orange} opacity="0.7"/>
          <rect x="13" y="3" width="8" height="8" rx="2" fill={C.orange} opacity="0.4"/>
          <rect x="3" y="13" width="8" height="8" rx="2" fill={C.orange} opacity="0.4"/>
          <rect x="13" y="13" width="8" height="8" rx="2" fill={C.orange} opacity="0.7"/>
        </svg>
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>Nothing here yet</div>
        <p style={{ margin: 0, fontSize: 13, color: C.textMuted, maxWidth: 300, lineHeight: 1.6 }}>
          Come back to {feature} once your team is set up and your reps start using ralli.
        </p>
      </div>
      {onGoToTeam && (
        <button
          onClick={onGoToTeam}
          style={{ padding: "10px 22px", borderRadius: 99, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: C.shadowSm }}
        >
          Go to Team →
        </button>
      )}
    </div>
  );
}

function Tag({ children, color = C.orange, bg }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "3px 10px", borderRadius: 99,
      fontSize: 11, fontWeight: 600, letterSpacing: "0.01em",
      color, background: bg || color + "15",
    }}>
      {children}
    </span>
  );
}

// ── HOME SCREEN ────────────────────────────────────────────

const leaderboardData = [
  { rank: 1, initials: "MC", name: "Mia Chen", score: 98, change: 2, color: "#8B5CF6" },
  { rank: 2, initials: "DP", name: "Dev Patel", score: 95, change: 1, color: "#3B82F6" },
  { rank: 3, initials: "JR", name: "Jordan Rivera", score: 91, change: 3, isMe: true, color: C.orange },
  { rank: 4, initials: "SK", name: "Sara Kim", score: 88, change: -1, color: "#22C55E" },
  { rank: 5, initials: "TW", name: "Tom Walsh", score: 84, change: 0, color: C.textSub },
];

// Inline tooltip helper — renders an ℹ badge with a hover tooltip
function InfoTooltip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{ width: 15, height: 15, borderRadius: "50%", background: C.muted, color: C.textMuted, fontSize: 9, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "default", userSelect: "none", marginLeft: 4 }}
      >i</span>
      {show && (
        <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)", background: C.dark, color: "#fff", fontSize: 11, lineHeight: 1.5, padding: "8px 12px", borderRadius: 8, width: 220, zIndex: 999, boxShadow: "0 4px 16px rgba(0,0,0,0.18)", pointerEvents: "none" }}>
          {text}
          <div style={{ position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)", borderWidth: 5, borderStyle: "solid", borderColor: `${C.dark} transparent transparent transparent` }} />
        </div>
      )}
    </span>
  );
}

function HomeScreen({ user, onNav, quizAssignments = [], onResumeLesson, onStartQuiz, onStartCourse, orgUsers = [], isReal = false, tenantId = null, quizzes = [], lastSeenAt = null, onNewAssignments = null }) {
  const mobile = useMobile();
  const firstName = user.name.split(" ")[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  // Dynamic date: e.g. "Jun 28"
  const todayLabel = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Tasks panel visibility
  const [showTasksPanel, setShowTasksPanel] = useState(false);

  // ── Real-user assignment data ─────────────────────────────
  const [homeCourses,     setHomeCourses]     = useState([]);
  const [homeLessons,     setHomeLessons]     = useState([]);
  const [homeAssignments, setHomeAssignments] = useState([]);
  const [homeCompleted,   setHomeCompleted]   = useState(new Set());
  const [homeLoading,     setHomeLoading]     = useState(isReal);

  // ── Leaderboard sidebar — reads from user_point_events (single source of truth)
  const [homeLbRows, setHomeLbRows] = useState([]);
  useEffect(() => {
    if (!isReal || !tenantId) return;
    getLeaderboard(tenantId, user?.id).then(({ data }) => {
      if (data) setHomeLbRows(data.slice(0, 5));
    });
  }, [isReal, tenantId, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isReal || !tenantId || !user?.id) { setHomeLoading(false); return; }
    Promise.all([
      getTenantCourses(tenantId),
      getTenantLessons(tenantId),
      getTenantAssignments(tenantId),
      getLessonCompletions(user.id),
    ]).then(([{ data: c }, { data: l }, { data: a }, { data: done }]) => {
      if (c) setHomeCourses(c);
      if (l) setHomeLessons(l);
      if (a) {
        setHomeAssignments(a);
        // Mark as seen only after assignments successfully load.
        // If the fetch fails (a === null), we do NOT update last_seen_assignments_at
        // so the user still sees "NEW" badges on the next visit / login.
        updateLastSeenAssignmentsAt(user.id);
      }
      if (done) setHomeCompleted(done);
      setHomeLoading(false);
    });
  }, [isReal, tenantId, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report new-assignment count to App so the "Learn" nav badge stays in sync.
  // "new" = assigned after lastSeenAt (only meaningful when lastSeenAt is set).
  useEffect(() => {
    if (!isReal || !onNewAssignments || !lastSeenAt) { onNewAssignments?.(0); return; }
    const userTeamId = orgUsers.find(u => u.id === user?.id)?.teamId ?? null;
    const mine = homeAssignments.filter(a =>
      (a.assignedTo?.type === "group"      && a.assignedTo?.orgId === user?.orgId) ||
      (a.assignedTo?.type === "individual" && a.assignedTo?.userId === user?.id)   ||
      (a.assignedTo?.type === "team"       && userTeamId && userTeamId === a.assignedTo?.teamId)
    );
    const newCount = mine.filter(a => a.assignedAtRaw && a.assignedAtRaw > lastSeenAt).length;
    onNewAssignments(newCount);
  }, [homeAssignments, lastSeenAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Unified assignment enrichment ─────────────────────────
  // For real users: build enriched list from Supabase data.
  // For demo users: transform quizAssignments into the same shape.
  const enrichedAssignments = (() => {
    if (isReal) {
      const userTeamId = orgUsers.find(u => u.id === user?.id)?.teamId ?? null;
      const mine = homeAssignments.filter(a =>
        (a.assignedTo?.type === "group"      && a.assignedTo?.orgId === user?.orgId) ||
        (a.assignedTo?.type === "individual" && a.assignedTo?.userId === user?.id)   ||
        (a.assignedTo?.type === "team"       && userTeamId && userTeamId === a.assignedTo?.teamId)
      );
      return mine.map(a => {
        const isCourse = a.contentType === "course";
        const isLesson = a.contentType === "lesson";
        const content  = isCourse ? homeCourses.find(c => c.id === a.contentId)
                       : isLesson ? homeLessons.find(l => l.id === a.contentId)
                       : quizzes.find(q => q.id === a.contentId);
        if (!content) return null;
        let pct = 0, isComplete = false;
        if (isCourse) {
          const cls = (content.lessonIds ?? []).map(id => homeLessons.find(l => l.id === id)).filter(Boolean);
          const done = cls.filter(l => homeCompleted.has(l.id)).length;
          pct = cls.length ? Math.round((done / cls.length) * 100) : 0;
          isComplete = cls.length > 0 && pct === 100;
        } else if (isLesson) {
          isComplete = homeCompleted.has(content.id);
          pct = isComplete ? 100 : 0;
        }
        const dueStatus = (a.dueAt && a.dueAt !== "Open") ? getDueStatus(a.dueAt) : null;
        const isNew = !!lastSeenAt && !!a.assignedAtRaw && a.assignedAtRaw > lastSeenAt;
        return { ...a, content, contentKind: isCourse ? "course" : isLesson ? "lesson" : "quiz", pct, isComplete, dueStatus, isNew };
      }).filter(Boolean);
    }
    // Demo: wrap quizAssignments (outstanding only shown, completed = has passed attempt)
    return quizAssignments.map(q => {
      const isComplete = q.attempts?.some(a => a.passed) ?? false;
      const dueStatus = (q.dueAt && q.dueAt !== "Open") ? getDueStatus(q.dueAt) : null;
      return { ...q, content: q, contentKind: "quiz", pct: isComplete ? 100 : 0, isComplete, dueStatus, contentType: "quiz", contentId: q.id };
    });
  })();

  const pendingAssignments   = enrichedAssignments.filter(x => !x.isComplete);
  const completedAssignments = enrichedAssignments.filter(x => x.isComplete);
  const overdueAssignments   = pendingAssignments.filter(x => x.dueStatus?.label === "Overdue");
  const pendingCount         = pendingAssignments.length;

  // For demo backwards-compat: recommended quiz
  const outstanding    = quizAssignments.filter(q => !q.attempts?.some(a => a.passed));
  const recommendedQuiz = !isReal ? (outstanding.find(q => !q.attempts?.length) ?? null) : null;

  if (user.role === "admin") {
    // Compute real values from already-loaded props — no additional queries.
    const repUsers       = isReal
      ? orgUsers.filter(u => !["ralli_admin", "superadmin", "orgAdmin"].includes(u.role))
      : null;
    const teamSize       = isReal ? (homeLoading ? null : repUsers.length) : 18;
    const totalAssign    = isReal ? (homeLoading ? null : homeAssignments.length) : 12;

    const adminStats = [
      {
        iconBg: C.blue,
        label: "Team Size",
        value: teamSize != null ? String(teamSize) : "—",
        sub: "",
        note: !isReal ? "3 inactive this week"
            : homeLoading ? "Loading…"
            : teamSize === 0 ? "No members yet"
            : `${teamSize} member${teamSize !== 1 ? "s" : ""}`,
        noteColor: !isReal ? C.red : C.textSub,
      },
      {
        iconBg: C.orange,
        label: "Avg. Team Score",
        value: isReal ? "—" : "86",
        sub: isReal ? "" : "/100",
        note: isReal ? "See Insights for details" : "+2 pts this week",
        noteColor: isReal ? C.textSub : C.green,
      },
      {
        iconBg: C.green,
        label: "Live Sessions",
        value: isReal ? "—" : "2",
        sub: isReal ? "" : " active",
        note: isReal ? "Launch from Games tab" : "1 pending launch",
        noteColor: C.textSub,
      },
      {
        iconBg: C.purple,
        label: "Total Assignments",
        value: totalAssign != null ? String(totalAssign) : "—",
        sub: "",
        note: !isReal ? "Across 3 modules"
            : homeLoading ? "Loading…"
            : totalAssign === 0 ? "None created yet"
            : `${totalAssign} active module${totalAssign !== 1 ? "s" : ""}`,
        noteColor: C.textSub,
      },
    ];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, margin: 0 }}>{greeting}, {firstName}</h1>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>{todayLabel} · <span style={{ color: C.green, fontWeight: 600 }}>Admin dashboard</span></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: mobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 14 }}>
          {adminStats.map((s, i) => (
            <Card key={i}>
              <div style={{ fontSize: 28, fontWeight: 800, color: C.text, lineHeight: 1 }}>{s.value}<span style={{ fontSize: 16, fontWeight: 500, color: C.textSub }}>{s.sub}</span></div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>{s.label}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: s.noteColor, marginTop: 6 }}>{s.note}</div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Streak + greeting */}
      <div>
        {user.streak && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.orange }}>{user.streak ?? 0}-day streak</span>
            <span style={{ fontSize: 13, color: C.textSub }}>Keep it going</span>
          </div>
        )}
        <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, margin: 0 }}>{greeting}, {firstName}</h1>
        <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>
          {todayLabel} ·{" "}
          <button onClick={() => setShowTasksPanel(true)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: pendingCount === 0 ? C.green : C.orange, fontWeight: 600, fontSize: 12 }}>
            {pendingCount === 0 ? "All caught up" : `${pendingCount} task${pendingCount !== 1 ? "s" : ""} remaining`}
          </button>
        </div>
      </div>

      {/* Stat Cards */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 14 }}>
        {[
          {
            iconBg: C.orange, label: "Readiness Score", value: user.score != null ? String(user.score) : "—", sub: user.score != null ? "/100" : "",
            note: user.score != null ? (isReal ? "Last 30 days of activity" : "+4 pts this week") : "No data yet", noteColor: user.score != null ? C.green : C.textSub,
            tooltip: "Your Readiness Score reflects quiz accuracy, lesson completion, and game performance over the past 30 days. Scores range from 0–100 and update within 24 hours of activity.",
          },
          {
            iconBg: C.green, label: "Team Rank", value: user.rank != null ? `#${user.rank}` : "—", sub: user.rank != null ? ` of ${orgUsers.length > 0 ? orgUsers.length : "—"}` : "",
            note: user.rank == null ? "No data yet" : user.rank <= 3 ? "↑ Top performer" : user.rank <= 5 ? "↑ Up 1 spot" : "Keep pushing",
            noteColor: user.rank <= 3 ? C.green : C.textSub,
          },
          {
            iconBg: C.blue, label: "Weekly Change", value: user.weeklyChange ? user.weeklyChange.replace("%", "") : "—", sub: user.weeklyChange ? "%" : "",
            note: "vs last week", noteColor: C.textSub,
            tooltip: `Compares your Readiness Score this week (${todayLabel} back 7 days) to the prior 7-day period. Positive = improvement. Scores consider quiz results, lesson completions, and game performance.`,
          },
          {
            iconBg: C.purple, label: "Assigned Training", value: String(pendingCount), sub: " pending",
            note: pendingCount === 0 ? "All caught up!" : overdueAssignments.length > 0 ? `${overdueAssignments.length} overdue` : `${completedAssignments.length} of ${enrichedAssignments.length} complete`,
            noteColor: pendingCount === 0 ? C.green : overdueAssignments.length > 0 ? C.red : C.textSub,
            clickable: true,
          },
        ].map((s, i) => (
          <Card key={i} style={{ cursor: s.clickable ? "pointer" : "default", transition: "box-shadow 0.15s" }}
            onClick={s.clickable ? () => setShowTasksPanel(true) : undefined}
            onMouseEnter={s.clickable ? (e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(253,191,36,0.18)") : undefined}
            onMouseLeave={s.clickable ? (e => e.currentTarget.style.boxShadow = "") : undefined}
          >
            <div style={{ fontSize: 28, fontWeight: 800, color: C.text, lineHeight: 1 }}>
              {s.value}<span style={{ fontSize: 16, fontWeight: 500, color: C.textSub }}>{s.sub}</span>
            </div>
            <div style={{ fontSize: 12, color: C.textSub, marginTop: 4, display: "flex", alignItems: "center" }}>
              {s.label}
              {s.tooltip && <InfoTooltip text={s.tooltip} />}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: s.noteColor, marginTop: 6 }}>{s.note}</div>
          </Card>
        ))}
      </div>

      {/* In Progress + Leaderboard */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 320px", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

          {/* In Progress / Upcoming — all pending assignments */}
          {homeLoading ? (
            <Card><p style={{ margin: 0, fontSize: 14, color: C.textSub }}>Loading assignments…</p></Card>
          ) : pendingAssignments.length === 0 ? (
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: C.green }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: C.green, letterSpacing: "0.06em" }}>ALL CAUGHT UP</span>
              </div>
              <p style={{ margin: 0, fontSize: 14, color: C.textSub }}>No outstanding assignments. Check the Learn or Quizzes tabs for more content.</p>
            </Card>
          ) : pendingAssignments.map((item) => {
            const { content, contentKind, pct, dueStatus } = item;
            const typeColor  = contentKind === "course" ? (content.color ?? C.orange) : contentKind === "quiz" ? C.purple : LESSON_TYPE_COLORS[content.type] ?? C.blue;
            const typeLabel  = contentKind === "course" ? "COURSE" : contentKind === "quiz" ? "QUIZ" : `LESSON · ${(content.type ?? "").toUpperCase()}`;
            const timeProgress = (item.assignedAtRaw && item.dueAt && item.dueAt !== "Open")
              ? getDueProgress(item.assignedAtRaw, item.dueAt) : 0;
            const barColor   = dueStatus?.label === "Overdue" ? C.red : timeProgress > 80 ? C.red : timeProgress > 50 ? C.orange : C.green;
            const handleAction = () => {
              if (contentKind === "quiz")   onStartQuiz?.(content.id);
              else if (contentKind === "course") onStartCourse?.(content.id);
              else onResumeLesson?.(content.id);
            };
            const actionLabel = pct > 0 ? "Resume →" : "Start →";
            return (
              <Card key={item.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: typeColor }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: typeColor, letterSpacing: "0.06em" }}>{typeLabel}</span>
                  {item.required && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: C.redBg, color: C.red }}>REQUIRED</span>}
                  {item.isNew && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#DBEAFE", color: "#2563EB" }}>NEW</span>}
                  {dueStatus && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: dueStatus.color + "18", color: dueStatus.color, marginLeft: "auto" }}>
                      {dueStatus.label}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{content.title ?? content.name}</div>
                    <div style={{ display: "flex", gap: 12, marginTop: 5, fontSize: 12, color: C.textSub }}>
                      {contentKind === "course" && <span>{(content.lessonIds ?? []).length} lessons</span>}
                      {contentKind === "lesson" && content.duration && <span>⏱ {content.duration}</span>}
                      {contentKind === "quiz"   && <span>{(content.questions ?? []).length} questions</span>}
                      {(content.xp || content.xp === 0) && <span style={{ color: C.orange, fontWeight: 600 }}>+{content.xp} XP</span>}
                      {item.dueAt && item.dueAt !== "Open" && <span>Due {item.dueAt}</span>}
                    </div>
                  </div>
                  {pct > 0 && (
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: typeColor }}>{pct}%</div>
                      <div style={{ fontSize: 10, color: C.textSub }}>complete</div>
                    </div>
                  )}
                </div>
                {(pct > 0 || timeProgress > 0) && (
                  <div style={{ marginTop: 12, marginBottom: 14 }}>
                    <ProgressBar value={pct > 0 ? pct : timeProgress} color={pct > 0 ? typeColor : barColor} height={5} />
                  </div>
                )}
                <div style={{ marginTop: pct > 0 || timeProgress > 0 ? 0 : 12 }}>
                  <button onClick={handleAction} style={{ padding: "9px 18px", borderRadius: 8, border: "none", cursor: "pointer", background: typeColor, color: "#fff", fontSize: 13, fontWeight: 700 }}>
                    {actionLabel}
                  </button>
                </div>
              </Card>
            );
          })}

          {/* Demo: Recommended quiz for non-real users */}
          {!isReal && recommendedQuiz && (
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: C.purple }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: C.purple, letterSpacing: "0.06em" }}>RECOMMENDED QUIZ</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{recommendedQuiz.title}</div>
                  <div style={{ display: "flex", gap: 14, marginTop: 6 }}>
                    <span style={{ fontSize: 12, color: C.textSub }}>{recommendedQuiz.questions?.length ?? 0} questions</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: C.orange }}>+{recommendedQuiz.xp} XP</span>
                  </div>
                </div>
                <button onClick={() => onStartQuiz?.(recommendedQuiz.id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${C.orangeBorder}`, background: C.orangeLight, color: C.orange, fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
                  Start Quiz →
                </button>
              </div>
            </Card>
          )}
        </div>

        {/* Leaderboard sidebar */}
        {(() => {
          // For real users: homeLbRows loaded from user_point_events (single source of truth).
          // For demo users: use the hardcoded mock data.
          const lbData = isReal
            ? homeLbRows.map(r => ({ ...r, score: r.total }))
            : leaderboardData.map(p => ({ ...p, isMe: p.userId ? p.userId === user?.id : !!p.isMe }));
          return (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Leaderboard</span>
                <span onClick={() => onNav?.("leaderboard")} style={{ fontSize: 12, color: C.orange, fontWeight: 600, cursor: "pointer" }}>Full view</span>
              </div>
              {lbData.length === 0 ? (
                <div style={{ padding: "32px 20px", textAlign: "center" }}>
                  <div style={{ fontSize: 24, marginBottom: 10 }}>🏆</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>No rankings yet</div>
                  <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>Rankings appear once your team completes training.</div>
                </div>
              ) : (
                <div>
                  {lbData.map((p, i) => (
                    <div key={p.userId ?? p.rank ?? i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", background: p.isMe ? C.orangeLight : "transparent", borderBottom: i < lbData.length - 1 ? `1px solid ${C.border}` : "none" }}>
                      <div style={{ width: 24, height: 24, borderRadius: "50%", background: p.rank === 1 ? "#F5A623" : p.rank === 2 ? "#A8B2C0" : p.rank === 3 ? "#CD7F32" : C.pageBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: p.rank <= 3 ? "#fff" : C.textSub, flexShrink: 0 }}>{p.rank}</div>
                      <Avatar initials={p.initials} size={32} color={p.color} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: p.isMe ? 700 : 500, color: p.isMe ? C.orange : C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{p.score.toLocaleString()}</div>
                        {(p.change ?? 0) !== 0 ? <div style={{ fontSize: 11, fontWeight: 600, color: p.change > 0 ? C.green : C.red }}>{p.change > 0 ? `+${p.change}` : p.change}</div> : <div style={{ fontSize: 11, color: C.textMuted }}>—</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })()}
      </div>

      {/* Tasks Panel — overlay modal */}
      {showTasksPanel && (
        <div style={{ position: "fixed", inset: 0, zIndex: 900, display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowTasksPanel(false); }}>
          <div style={{ background: "rgba(0,0,0,0.3)", position: "absolute", inset: 0 }} onClick={() => setShowTasksPanel(false)} />
          <div style={{ position: "relative", width: 420, height: "100vh", background: C.white, boxShadow: "-4px 0 32px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", overflowY: "auto", zIndex: 901 }}>
            <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: C.white, zIndex: 1 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>Outstanding Assignments</div>
                <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{pendingCount} remaining</div>
              </div>
              <button onClick={() => setShowTasksPanel(false)} style={{ background: C.muted, border: "none", borderRadius: 8, width: 32, height: 32, fontSize: 16, cursor: "pointer", color: C.textSub, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
            </div>
            <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
              {pendingAssignments.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: C.textSub }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>All caught up!</div>
                  <div style={{ fontSize: 13 }}>No outstanding assignments.</div>
                </div>
              ) : pendingAssignments.map(item => {
                const { content, contentKind, pct, dueStatus } = item;
                const typeColor = contentKind === "course" ? (content.color ?? C.orange) : contentKind === "quiz" ? C.purple : LESSON_TYPE_COLORS[content.type] ?? C.blue;
                const timeProgress = (item.assignedAtRaw && item.dueAt && item.dueAt !== "Open")
                  ? getDueProgress(item.assignedAtRaw, item.dueAt) : 0;
                const barColor = dueStatus?.label === "Overdue" ? C.red : timeProgress > 80 ? C.red : timeProgress > 50 ? C.orange : C.green;
                const handleAction = () => {
                  setShowTasksPanel(false);
                  if (contentKind === "quiz")        onStartQuiz?.(content.id);
                  else if (contentKind === "course") onStartCourse?.(content.id);
                  else                               onResumeLesson?.(content.id);
                };
                return (
                  <div key={item.id} style={{ background: C.pageBg, borderRadius: 12, padding: "14px 16px", border: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: typeColor, letterSpacing: "0.05em", marginBottom: 2 }}>
                          {contentKind === "course" ? "COURSE" : contentKind === "quiz" ? "QUIZ" : "LESSON"}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 2 }}>{content.title ?? content.name}</div>
                        {item.dueAt && item.dueAt !== "Open" && <div style={{ fontSize: 11, color: C.textSub }}>Due {item.dueAt}</div>}
                      </div>
                      {dueStatus && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: dueStatus.color + "18", color: dueStatus.color, flexShrink: 0 }}>{dueStatus.label}</span>}
                    </div>
                    {(pct > 0 || timeProgress > 0) && (
                      <div style={{ marginBottom: 10 }}>
                        <ProgressBar value={pct > 0 ? pct : timeProgress} color={pct > 0 ? typeColor : barColor} height={4} />
                      </div>
                    )}
                    <button onClick={handleAction} style={{ padding: "7px 14px", borderRadius: 7, border: "none", cursor: "pointer", background: typeColor, color: "#fff", fontSize: 12, fontWeight: 700 }}>
                      {pct > 0 ? "Resume →" : "Start →"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RANKD DATA ───────────────────────────────────────────────

const INITIAL_SESSIONS = [
  { code: "482901", name: "Q2 Battle Cards Blitz",      questionCount: 10, status: "waiting", playerCount: 0,  demoMode: true,  players: [] },
  { code: "773412", name: "Objection Handling Sprint",   questionCount: 8,  status: "ended",   playerCount: 14, demoMode: true,  players: [] },
  { code: "291847", name: "Competitor Positioning Quiz", questionCount: 12, status: "ended",   playerCount: 9,  demoMode: true,  players: [] },
];

// Helper: produce a display date N days before today so demo dates stay current.
const _demoDate = (daysAgo) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

// Production hook: replace with /api/game-history/:userId
const USER_GAME_HISTORY = [
  {
    id: "gh1",
    sessionName: "Q1 Pipeline Knowledge Blitz",
    date: _demoDate(7),
    rank: 2, totalPlayers: 14,
    scorePercent: 92, scoreRaw: 9200,
    accuracy: 80, avgResponseMs: 8400,
    questions: [
      { id: "q1", text: "What's the #1 reason price objections stall mid-market deals?", topic: "Objection Handling", type: "mc", options: ["Product is genuinely too expensive","Perceived value hasn't been established","Champion lacks budget authority","Competitor pricing is lower"], correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 7200,  pointsEarned: 1000 },
      { id: "q2", text: "True or False: You should always discount on the first call.", topic: "Negotiation",         type: "tf", options: ["True","False"],                                                                                                                                         correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 3100,  pointsEarned: 950  },
      { id: "q3", text: "Which SPICED stage surfaces the business impact of a problem?", topic: "Discovery",        type: "mc", options: ["Situation","Pain","Impact","Critical Event"],                                                                                                              correctIndex: 2, userAnswerIndex: 2, isCorrect: true,  responseMs: 9800,  pointsEarned: 900  },
      { id: "q4", text: "What is the ideal number of stakeholders in a multi-threaded deal?", topic: "Pipeline",    type: "mc", options: ["1-2","3-4","As many as possible","Depends on deal size"],                                                                                                  correctIndex: 3, userAnswerIndex: 1, isCorrect: false, responseMs: 11200, pointsEarned: 0    },
      { id: "q5", text: "True or False: A critical event is required to create deal urgency.", topic: "Pipeline",   type: "tf", options: ["True","False"],                                                                                                                                         correctIndex: 0, userAnswerIndex: 0, isCorrect: true,  responseMs: 4500,  pointsEarned: 980  },
      { id: "q6", text: "Which objection type is MOST common among VP-level buyers?",         topic: "Objection Handling", type: "mc", options: ["Price","Timing","Priority","Trust"],                                                                                                              correctIndex: 2, userAnswerIndex: 3, isCorrect: false, responseMs: 13400, pointsEarned: 0    },
      { id: "q7", text: "What does 'CRM hygiene' primarily affect?",                          topic: "Forecasting",  type: "mc", options: ["Deal velocity","Forecast accuracy","Rep motivation","Territory mapping"],                                                                                correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 8700,  pointsEarned: 920  },
      { id: "q8", text: "True or False: Stage progression criteria should be subjective.",    topic: "Forecasting",  type: "tf", options: ["True","False"],                                                                                                                                         correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 3900,  pointsEarned: 970  },
      { id: "q9", text: "What is the primary goal of a discovery call?",                      topic: "Discovery",    type: "mc", options: ["Demo the product","Qualify budget","Surface felt pain","Build rapport"],                                                                                  correctIndex: 2, userAnswerIndex: 2, isCorrect: true,  responseMs: 6600,  pointsEarned: 940  },
      { id: "q10", text: "Which metric best predicts if a deal will close this quarter?",     topic: "Pipeline",     type: "mc", options: ["Deal size","Stage","Critical event + champion","Number of calls"],                                                                                       correctIndex: 2, userAnswerIndex: 3, isCorrect: false, responseMs: 14100, pointsEarned: 0    },
    ],
  },
  {
    id: "gh2",
    sessionName: "Objection Handling Showdown",
    date: _demoDate(13),
    rank: 1, totalPlayers: 11,
    scorePercent: 100, scoreRaw: 10000,
    accuracy: 100, avgResponseMs: 6100,
    questions: [
      { id: "q1", text: "What's the first step in the price objection reframe framework?",    topic: "Objection Handling", type: "mc", options: ["Anchor to ROI","Acknowledge","Value Bridge","Ask a question"],                                                                                     correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 5200,  pointsEarned: 1000 },
      { id: "q2", text: "True or False: 'Not interested' means the call is over.",            topic: "Objection Handling", type: "tf", options: ["True","False"],                                                                                                                                   correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 2800,  pointsEarned: 980  },
      { id: "q3", text: "Which script technique turns 'not interested' into a conversation?", topic: "Objection Handling", type: "mc", options: ["Persist harder","Specificity challenge","Discount offer","Hang up and call back"],                                                                 correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 7400,  pointsEarned: 950  },
      { id: "q4", text: "What should you anchor price to during a negotiation?",              topic: "Negotiation",        type: "mc", options: ["Competitor price","Monthly installments","Business outcome ROI","Your cost basis"],                                                                 correctIndex: 2, userAnswerIndex: 2, isCorrect: true,  responseMs: 6900,  pointsEarned: 960  },
      { id: "q5", text: "True or False: You should defend your price when challenged.",       topic: "Negotiation",        type: "tf", options: ["True","False"],                                                                                                                                   correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 3300,  pointsEarned: 990  },
      { id: "q6", text: "What does 'Value Bridge' connect in the 3-step objection framework?",topic: "Objection Handling", type: "mc", options: ["Price to competitor","Investment to business outcome","Product to features","Budget to timeline"],                                                correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 8100,  pointsEarned: 940  },
      { id: "q7", text: "Which phrase is BEST for closing a stalled price conversation?",     topic: "Objection Handling", type: "mc", options: ["Let me check with my manager","What would make this a clear yes?","I can offer a bigger discount","Let's revisit next quarter"],                   correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 7700,  pointsEarned: 945  },
      { id: "q8", text: "True or False: Budget objections and priority objections require different responses.", topic: "Objection Handling", type: "tf", options: ["True","False"],                                                                                                                correctIndex: 0, userAnswerIndex: 0, isCorrect: true,  responseMs: 4200,  pointsEarned: 975  },
    ],
  },
  {
    id: "gh3",
    sessionName: "Discovery Call Drills",
    date: _demoDate(20),
    rank: 4, totalPlayers: 16,
    scorePercent: 76, scoreRaw: 7600,
    accuracy: 63, avgResponseMs: 12800,
    questions: [
      { id: "q1", text: "What does the 'S' in SPICED stand for?",                            topic: "Discovery",    type: "mc", options: ["Situation","Stakeholder","Scope","Speed"],                                                                                                                correctIndex: 0, userAnswerIndex: 0, isCorrect: true,  responseMs: 5100,  pointsEarned: 1000 },
      { id: "q2", text: "True or False: You should demo before completing discovery.",        topic: "Discovery",    type: "tf", options: ["True","False"],                                                                                                                                         correctIndex: 1, userAnswerIndex: 0, isCorrect: false, responseMs: 9200,  pointsEarned: 0    },
      { id: "q3", text: "What is the purpose of the 'Critical Event' in SPICED?",            topic: "Discovery",    type: "mc", options: ["Understand budget","Find the forcing function","Map the org chart","Identify competition"],                                                               correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 10400, pointsEarned: 900  },
      { id: "q4", text: "Which question uncovers felt pain most effectively?",               topic: "Discovery",    type: "mc", options: ["What's your budget?","Where does this process break down?","Who is your current vendor?","What features do you need?"],                                    correctIndex: 1, userAnswerIndex: 3, isCorrect: false, responseMs: 14700, pointsEarned: 0    },
      { id: "q5", text: "True or False: A deal with no critical event still has urgency.",   topic: "Pipeline",     type: "tf", options: ["True","False"],                                                                                                                                         correctIndex: 1, userAnswerIndex: 0, isCorrect: false, responseMs: 6800,  pointsEarned: 0    },
      { id: "q6", text: "How should you close a discovery call?",                            topic: "Discovery",    type: "mc", options: ["Send a proposal","Summarize pain, confirm impact, ask about next step","Ask for a reference","Demo the product immediately"],                             correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 11200, pointsEarned: 870  },
      { id: "q7", text: "What's the risk of asking too many Situation questions?",           topic: "Discovery",    type: "mc", options: ["Losing urgency","Sounding like a survey","Missing budget","Not finding the champion"],                                                                    correctIndex: 1, userAnswerIndex: 2, isCorrect: false, responseMs: 17300, pointsEarned: 0    },
      { id: "q8", text: "True or False: Decision criteria and decision process are the same.", topic: "Discovery",   type: "tf", options: ["True","False"],                                                                                                                                        correctIndex: 1, userAnswerIndex: 0, isCorrect: false, responseMs: 8400,  pointsEarned: 0    },
    ],
  },
  {
    id: "gh4",
    sessionName: "MEDDIC Fundamentals Quiz",
    date: _demoDate(26),
    rank: 1, totalPlayers: 9,
    scorePercent: 100, scoreRaw: 10000,
    accuracy: 100, avgResponseMs: 5700,
    questions: [
      { id: "q1", text: "What does MEDDIC stand for?",                                       topic: "Pipeline",     type: "mc", options: ["Metrics, Economic Buyer, Decision Criteria, Decision Process, Identify Pain, Champion","Market, Execution, Deal, Decision, Intelligence, Close","Metrics, Engagement, Discovery, Deal, Intent, Close","None of the above"], correctIndex: 0, userAnswerIndex: 0, isCorrect: true,  responseMs: 6100, pointsEarned: 1000 },
      { id: "q2", text: "True or False: The Economic Buyer is always the first person you meet.", topic: "Pipeline", type: "tf", options: ["True","False"],                                                                                                                                        correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 3200, pointsEarned: 985  },
      { id: "q3", text: "What makes a 'Champion' different from a regular contact?",         topic: "Pipeline",     type: "mc", options: ["They have budget","They have power and personal motivation","They respond to emails quickly","They've used your product before"],                          correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 7400, pointsEarned: 960  },
      { id: "q4", text: "Which MEDDIC element is most commonly missing from stalled deals?", topic: "Pipeline",     type: "mc", options: ["Metrics","Champion","Decision Process","Identified Pain"],                                                                                                correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 5900, pointsEarned: 970  },
      { id: "q5", text: "True or False: Identified Pain must be quantified to be useful.",   topic: "Pipeline",     type: "tf", options: ["True","False"],                                                                                                                                         correctIndex: 0, userAnswerIndex: 0, isCorrect: true,  responseMs: 4100, pointsEarned: 990  },
      { id: "q6", text: "What is the best indicator of a deal that will close this period?", topic: "Forecasting",  type: "mc", options: ["Large contract value","Named champion + known decision date","Rep confidence","Number of demos completed"],                                               correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 6700, pointsEarned: 950  },
      { id: "q7", text: "What question reveals Decision Process most directly?",             topic: "Pipeline",     type: "mc", options: ["What's your budget?","Who else needs to be involved in a decision like this?","What features matter most?","Have you evaluated competitors?"],            correctIndex: 1, userAnswerIndex: 1, isCorrect: true,  responseMs: 5300, pointsEarned: 965  },
    ],
  },
];

// Backward compat reference for any remaining UI using the old shape
const JORDAN_SCORES = USER_GAME_HISTORY.map(s => ({
  sessionName: s.sessionName, date: s.date.split(",")[0].replace(/^(\w+ \d+).*/, "$1"),
  rank: s.rank, score: s.scorePercent, questionCount: s.questions.length, totalPlayers: s.totalPlayers,
}));

const AVATARS = ["🦊","🐯","🦁","🐺","🦅","🐬","🦄","🐙","🐸","🐻","🐼","🐨","🦋","🦜","🐢","🦈","🦉","🐮","🐷","🦊","🦝","🦦","🐲","🦕"];

const LOBBY_PLAYERS = [
  { name: "Jordan Rivera",  emoji: "🦊", color: C.orange  },
  { name: "Mia Chen",       emoji: "🐯", color: C.green   },
  { name: "Dev Patel",      emoji: "🦅", color: "#0EA5E9" },
  { name: "Sara Kim",       emoji: "🐬", color: "#8B5CF6" },
  { name: "Tom Walsh",      emoji: "🐺", color: "#F43F5E" },
  { name: "Alex Reyes",     emoji: "🦁", color: "#F59E0B" },
  { name: "Priya Sharma",   emoji: "🐙", color: "#10B981" },
  { name: "Marcus Brown",   emoji: "🦄", color: "#EC4899" },
];

const MOCK_RESULTS_LEADERBOARD = [
  { rank: 1, name: "Jordan Rivera", emoji: "🦊", score: 9200, accuracy: 92 },
  { rank: 2, name: "Mia Chen",      emoji: "🐯", score: 8800, accuracy: 88 },
  { rank: 3, name: "Dev Patel",     emoji: "🦅", score: 8100, accuracy: 81 },
  { rank: 4, name: "Sara Kim",      emoji: "🐬", score: 7400, accuracy: 74 },
  { rank: 5, name: "Alex Reyes",    emoji: "🦁", score: 6900, accuracy: 69 },
  { rank: 6, name: "Tom Walsh",     emoji: "🐺", score: 6200, accuracy: 62 },
  { rank: 7, name: "Priya Sharma",  emoji: "🐙", score: 5800, accuracy: 58 },
  { rank: 8, name: "Marcus Brown",  emoji: "🦄", score: 5100, accuracy: 51 },
];

const MOCK_QUESTION_BREAKDOWN = [
  { q: "Handling price objections in mid-market deals",  correct: 7, total: 8, type: "Multiple Choice", avgTime: 11.2 },
  { q: "True or False: Always discount on first call",    correct: 8, total: 8, type: "True / False",    avgTime: 4.1  },
  { q: "What discovery questions reveal true pain?",      correct: 5, total: 8, type: "Type Answer",     avgTime: 18.7 },
  { q: "Rate the urgency level of this deal signal",      correct: 6, total: 8, type: "Slider",          avgTime: 9.3  },
  { q: "Reframe script for Salesforce objection",         correct: 4, total: 8, type: "Multiple Choice", avgTime: 14.8 },
  { q: "Match the objection type to the response",        correct: 6, total: 8, type: "Puzzle / Match",  avgTime: 22.1 },
];

const GAME_QUESTIONS = [
  {
    q: "What's the #1 reason price objections stall mid-market deals?",
    type: "mc",
    options: ["Product is genuinely too expensive", "Perceived value hasn't been established", "Champion lacks budget authority", "Competitor pricing is lower"],
    correct: 1, timeLimit: 20,
  },
  {
    q: "You should always discount on the first call to close faster",
    type: "tf",
    options: ["True", "False"],
    correct: 1, timeLimit: 10,
  },
  {
    q: "In the MEDDIC framework, what does the 'I' stand for?",
    type: "mc",
    options: ["Initiative", "Impact", "Identify Pain", "Implicit Critical Event"],
    correct: 2, timeLimit: 20,
  },
  {
    q: "Which discovery question best uncovers the true pain?",
    type: "mc",
    options: ["What's your budget?", "What happens if you don't solve this by Q3?", "Have you evaluated other vendors?", "Who else is involved?"],
    correct: 1, timeLimit: 20,
  },
  {
    q: "When a prospect says 'Salesforce does the same thing', you should immediately lower your price",
    type: "tf",
    options: ["True", "False"],
    correct: 1, timeLimit: 10,
  },
  {
    q: "In the objection-handling framework, what's the correct order?",
    type: "mc",
    options: ["Reframe → Acknowledge → Anchor", "Anchor → Reframe → Acknowledge", "Acknowledge → Reframe → Anchor", "Acknowledge → Anchor → Reframe"],
    correct: 2, timeLimit: 20,
  },
];

const OPTION_COLORS = [
  { bg: "#F59E0B", glow: "rgba(245,158,11,0.3)"  },  // A — amber
  { bg: "#3B82F6", glow: "rgba(59,130,246,0.3)"  },  // B — blue
  { bg: "#22C55E", glow: "rgba(34,197,94,0.3)"   },  // C — green
  { bg: "#EF4444", glow: "rgba(239,68,68,0.3)"   },  // D — red
];

const SAMPLE_QUIZZES = [
  {
    id: "sq1",
    name: "Objection Handling Sprint",
    createdAt: "Jun 10",
    questions: GAME_QUESTIONS,
  },
  {
    id: "sq2",
    name: "MEDDIC Fundamentals",
    createdAt: "Jun 5",
    questions: GAME_QUESTIONS.slice(0, 3),
  },
];

const OPEN_DEMO_RESPONSES = [
  { text: "I lead with the ROI calculator — gets them off price immediately.", author: "Marcus T." },
  { text: "Ask what they're currently using and what's not working. Makes the price feel like a solution.", author: "Jordan K." },
  { text: "Acknowledge the concern, then pivot to total cost of inaction.", author: "Priya S." },
  { text: "I reframe it: \"What's it costing you NOT to fix this?\"", author: "Devon R." },
  { text: "Break it into monthly cost and compare to what they're wasting now.", author: "Alex M." },
];

const Q_TYPES = [
  { id: "mc",     label: "Multiple Choice", icon: "", color: "#7C3AED", desc: "Pick one correct answer" },
  { id: "tf",     label: "True / False",    icon: "", color: "#0284C7", desc: "Two options only"       },
  { id: "type",   label: "Type Answer",     icon: "", color: "#059669", desc: "Players type a response" },
  { id: "open",   label: "Open Ended",      icon: "", color: "#8B5CF6", desc: "Free response, manually graded" },
  { id: "slider", label: "Slider Scale",    icon: "", color: "#D97706", desc: "Rate on a numeric scale" },
  { id: "pin",    label: "Pin Answer",      icon: "", color: "#DC2626", desc: "Click the right spot"   },
  { id: "match",  label: "Matching",        icon: "", color: "#8B5CF6", desc: "Connect pairs together"  },
];

const Q_TYPE_LABELS = { mc: "Multiple Choice", tf: "True / False", type: "Type Answer", open: "Open Ended", slider: "Slider", pin: "Pin", match: "Matching" };
const Q_TYPE_ICONS  = { mc: "", tf: "", type: "", open: "", slider: "", pin: "", match: "" };

// ── REAL GAME HOST VIEW ──────────────────────────────────────
const PURPLE = "#8B5CF6";

function KahootHostView({ onNav, sessionName, pin, sessionDbId, tenantId, questions, broadcast, chAnswers, chPlayers, onGameEnd, setChAnswers }) {
  const mobile       = useMobile();
  const [phase,      setPhase]      = useState("countdown");
  const [qIdx,       setQIdx]       = useState(0);
  const [cdNum,      setCdNum]      = useState(3);
  const [timeLeft,   setTimeLeft]   = useState(0);
  const [scores,     setScores]     = useState(() => chPlayers.map(p => ({ ...p, score: 0 })));
  const [openGrades, setOpenGrades] = useState({});  // { idx: "correct"|"incorrect", __showNames: bool }
  const [paused,     setPaused]     = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [questionHistory, setQuestionHistory] = useState([]);
  // DB-backed participant count for countdown — presence may lag behind actual joins
  const [dbParticipantCount, setDbParticipantCount] = useState(chPlayers.length);

  // ── Session restoration ───────────────────────────────────────────────────────
  // "loading" while fetching DB state, "done" when ready, "error" if fetch fails.
  // Demo mode (no sessionDbId) initialises as "done" and skips all restoration.
  const [restoreState, setRestoreState] = useState(sessionDbId ? "loading" : "done");
  const [restoreError, setRestoreError] = useState(null);
  const [retryCount,   setRetryCount]   = useState(0);

  useEffect(() => {
    if (!sessionDbId) return; // demo mode — nothing to restore
    let cancelled = false;
    setRestoreState("loading");
    setRestoreError(null);

    (async () => {
      try {
        // 1. Parallel fetch: session state + per-question answer history
        const { session, answers } = await getSessionRestoreData(sessionDbId);
        if (cancelled) return;

        if (session.error) throw new Error(session.error.message ?? "Failed to load session");
        if (!session.data) throw new Error("Session not found");

        const sess = session.data;

        // 2. phase==="waiting" → new game has not progressed past lobby; start normally
        if (sess.phase === "waiting") {
          if (!cancelled) setRestoreState("done");
          return;
        }

        // 3. Restore question index, paused flag, and phase
        const restoredQIdx = sess.current_question_index ?? 0;
        setQIdx(restoredQIdx);
        setPaused(sess.paused ?? false);

        const safePhase = (sess.phase === "ended") ? "reveal" : (sess.phase ?? "countdown");
        if (safePhase === "countdown") setCdNum(3);
        if (safePhase === "question") {
          const rq = questions[restoredQIdx];
          if (rq?.timeLimit) setTimeLeft(rq.timeLimit);
        }
        // Set phase after other state so countdown/question effects don't fire prematurely
        setPhase(safePhase);

        // 4. Reconstruct cumulative scores from saved game_answers
        if (answers.data?.length) {
          // Deduplicate: for each (player_id, question_idx) keep the highest-points row
          const best = new Map();
          for (const row of answers.data) {
            const key = `${row.player_id}:${row.question_idx}`;
            const existing = best.get(key);
            if (!existing || (row.points ?? 0) > (existing.points ?? 0)) best.set(key, row);
          }

          // Sum deduplicated points per player
          const totals = new Map(); // player_id → { name, score }
          for (const row of best.values()) {
            const cur = totals.get(row.player_id);
            if (cur) cur.score += row.points ?? 0;
            else totals.set(row.player_id, { name: row.player_name, score: row.points ?? 0 });
          }

          // Fetch all participants (no status filter) for emoji/color
          const { data: participants } = await supabase
            .from("game_session_participants")
            .select("player_id, name, emoji, color")
            .eq("session_id", sessionDbId)
            .order("joined_at", { ascending: true });
          if (cancelled) return;

          // Build merged score rows, starting from full participant list (preserves 0-score players)
          const seen = new Set();
          const scoreRows = (participants ?? []).map((p, i) => {
            seen.add(p.player_id);
            const t = totals.get(p.player_id);
            const eidx = i % PLAYER_EMOJIS.length;
            return {
              id:         p.player_id,
              name:       p.name,
              emoji:      p.emoji ?? PLAYER_EMOJIS[eidx],
              color:      p.color ?? PLAYER_COLORS[eidx % PLAYER_COLORS.length],
              score:      t?.score ?? 0,
              delta:      0,
              wasCorrect: false,
            };
          });

          // Also include any players with answers who are absent from participant list
          let extra = scoreRows.length;
          for (const [pid, t] of totals.entries()) {
            if (seen.has(pid)) continue;
            const eidx = extra % PLAYER_EMOJIS.length;
            scoreRows.push({
              id:         pid,
              name:       t.name,
              emoji:      PLAYER_EMOJIS[eidx],
              color:      PLAYER_COLORS[eidx % PLAYER_COLORS.length],
              score:      t.score,
              delta:      0,
              wasCorrect: false,
            });
            extra++;
          }

          scoreRows.sort((a, b) => b.score - a.score);
          if (!cancelled) setScores(scoreRows);
        }

        if (!cancelled) setRestoreState("done");
      } catch (err) {
        if (!cancelled) {
          console.error("[ralli:host] restore failed:", err);
          setRestoreError(err.message ?? "Failed to restore session state");
          setRestoreState("error");
        }
      }
    })();

    return () => { cancelled = true; };
  }, [sessionDbId, retryCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionDbId) return;
    getLobbyParticipants(sessionDbId).then(({ data }) => {
      if (!data) return;
      const active = data.filter(p => !p.status || p.status === "joined" || p.status === "active").length;
      setDbParticipantCount(Math.max(active, chPlayers.length));
    });
  }, [sessionDbId, chPlayers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist phase transitions to DB so host can recover on refresh
  const persistPhase = useCallback((nextPhase, nextQIdx, nextPaused) => {
    if (!sessionDbId) return;
    updateSessionPhase(sessionDbId, {
      phase:                nextPhase ?? phase,
      currentQuestionIndex: nextQIdx  ?? qIdx,
      paused:               nextPaused ?? paused,
    }).catch(e => console.error("[ralli:host] updateSessionPhase failed:", e));
  }, [sessionDbId, phase, qIdx, paused]); // eslint-disable-line react-hooks/exhaustive-deps

  const q           = questions[qIdx];
  const total       = questions.length;
  const answeredCount = Object.keys(chAnswers).length;
  const playerCount   = Math.max(chPlayers.length, 1);
  const isFinalQ      = qIdx === total - 1;
  const timerPct      = q ? (timeLeft / q.timeLimit) * 100 : 0;
  const timerColor    = timerPct > 50 ? C.green : timerPct > 25 ? C.orange : C.red;

  useEffect(() => {
    if (restoreState !== "done") return; // don't reset restored scores during restoration
    if (phase === "countdown" && (qIdx === 0 || scores.length === 0)) setScores(chPlayers.map(p => ({ ...p, score: 0 })));
  }, [chPlayers.length, restoreState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (restoreState !== "done") return; // block until restoration finishes
    if (phase !== "countdown") return;
    if (cdNum <= 0) {
      setPhase("question"); setTimeLeft(q.timeLimit);
      persistPhase("question", qIdx, false);
      broadcast({ type: GM.SHOW_QUESTION, qIdx, question: q, timeLimit: q.timeLimit, questionStartedAt: Date.now() });
      return;
    }
    const t = setTimeout(() => setCdNum(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, cdNum, restoreState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (restoreState !== "done") return; // block until restoration finishes
    if (phase !== "question" || paused) return;
    if (timeLeft <= 0) { doReveal(); return; }
    const t = setTimeout(() => setTimeLeft(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, timeLeft, paused, restoreState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (restoreState !== "done") return; // block until restoration finishes
    if (phase !== "question" || answeredCount < playerCount || answeredCount === 0) return;
    doReveal();
  }, [answeredCount, phase, restoreState]); // eslint-disable-line react-hooks/exhaustive-deps

  const doReveal = () => {
    if (q.type === "open") {
      // Collect open-ended responses and go to grading phase
      setOpenGrades({});
      setPhase("open-review");
      persistPhase("open-review", qIdx, false);
      broadcast({ type: GM.OPEN_REVIEW, qText: q.q });
      return;
    }
    if (q.type === "type") {
      // Auto-grade typed answers against acceptedAnswers (case-insensitive)
      const accepted = (q.acceptedAnswers ?? []).map(a => a.toLowerCase().trim());
      const qDist = []; // no option distribution for type questions
      setQuestionHistory(h => [...h, { qIdx, q: q?.q, options: [], correct: null, distribution: qDist, correctCount: 0, totalAnswers: Object.values(chAnswers).length, avgTimeMs: 0 }]);
      let baseScores;
      if (scores.length > 0) { baseScores = scores; }
      else if (chPlayers.length > 0) { baseScores = chPlayers.map(p => ({ ...p, score: 0 })); }
      else { baseScores = Object.entries(chAnswers).map(([pid, ans], i) => ({ id: pid, name: ans.name ?? pid, emoji: PLAYER_EMOJIS[i % PLAYER_EMOJIS.length], color: PLAYER_COLORS[i % PLAYER_COLORS.length], score: 0 })); }
      const newScores = baseScores.map(p => {
        const ans = chAnswers[p.id];
        if (!ans?.text) return { ...p, delta: 0, wasCorrect: false };
        const correct = accepted.length > 0 && accepted.some(a => ans.text.toLowerCase().trim() === a);
        const speedBonus = correct && ans.timeMs ? Math.max(0, Math.round((1 - ans.timeMs / (q.timeLimit * 1000)) * 50)) : 0;
        const delta = correct ? 100 + speedBonus : 0;
        return { ...p, score: p.score + delta, delta, wasCorrect: correct };
      });
      newScores.sort((a, b) => b.score - a.score);
      setScores(newScores);
      setPhase("reveal");
      persistPhase("reveal", qIdx, false);
      broadcast({ type: GM.REVEAL, correctIdx: null, scores: newScores, acceptedAnswers: q.acceptedAnswers ?? [] });
      if (sessionDbId) {
        const scoreMap = Object.fromEntries(newScores.map(p => [p.id, p]));
        const answerRows = Object.entries(chAnswers).map(([pid, ans]) => {
          const sp = scoreMap[pid];
          const correct = (q.acceptedAnswers ?? []).some(a => (ans.text ?? "").toLowerCase().trim() === a.toLowerCase().trim());
          return { playerId: pid, playerName: ans.name ?? sp?.name ?? pid, questionIdx: qIdx, optionIdx: null, text: ans.text ?? null, timeMs: ans.timeMs ?? null, isCorrect: correct, points: sp?.delta ?? 0, tenantId };
        });
        saveGameAnswers(sessionDbId, answerRows).then(({ error }) => { if (error) console.error("[ralli:host] saveGameAnswers (type) failed:", error); });
      }
      return;
    }
    // Record per-question stats
    const qDist = (q?.options ?? []).map((_, i) => Object.values(chAnswers).filter(a => a.optionIdx === i).length);
    const qTotal = Object.values(chAnswers).length;
    const qAvgMs = qTotal > 0 ? Object.values(chAnswers).reduce((s,a) => s+(a.timeMs||0), 0) / qTotal : 0;
    setQuestionHistory(h => [...h, { qIdx, q: q?.q, options: q?.options, correct: q?.correct, distribution: qDist, correctCount: qDist[q?.correct]||0, totalAnswers: qTotal, avgTimeMs: qAvgMs }]);
    setPhase("reveal");
    persistPhase("reveal", qIdx, false);
    // Tri-level fallback: scores state → presence chPlayers → chAnswers keys (always populated at this point)
    let baseScores;
    if (scores.length > 0) {
      baseScores = scores;
    } else if (chPlayers.length > 0) {
      baseScores = chPlayers.map(p => ({ ...p, score: 0 }));
    } else {
      baseScores = Object.entries(chAnswers).map(([pid, ans], i) => ({
        id: pid, name: ans.name ?? pid,
        emoji: PLAYER_EMOJIS[i % PLAYER_EMOJIS.length],
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        score: 0,
      }));
    }
    const newScores = baseScores.map(p => {
      const ans = chAnswers[p.id];
      if (!ans) return { ...p, delta: 0, wasCorrect: false };
      const correct = ans.optionIdx === q.correct;
      const speedBonus = correct && ans.timeMs ? Math.max(0, Math.round((1 - ans.timeMs / (q.timeLimit * 1000)) * 50)) : 0;
      const delta = correct ? 100 + speedBonus : 0;
      return { ...p, score: p.score + delta, delta, wasCorrect: correct };
    });
    newScores.sort((a, b) => b.score - a.score);
    setScores(newScores);
    broadcast({ type: GM.REVEAL, correctIdx: q.correct, scores: newScores });
    // Persist each player's answer to game_answers (fire-and-forget)
    if (sessionDbId) {
      const scoreMap = Object.fromEntries(newScores.map(p => [p.id, p]));
      const answerRows = Object.entries(chAnswers).map(([pid, ans]) => {
        const sp = scoreMap[pid];
        return {
          playerId:    pid,
          playerName:  ans.name ?? sp?.name ?? pid,
          questionIdx: qIdx,
          optionIdx:   ans.optionIdx ?? null,
          text:        ans.text ?? null,
          timeMs:      ans.timeMs ?? null,
          isCorrect:   ans.optionIdx === q.correct,
          points:      sp?.delta ?? 0,
          tenantId,
        };
      });
      saveGameAnswers(sessionDbId, answerRows)
        .then(({ error }) => { if (error) console.error("[ralli:host] saveGameAnswers failed:", error); });
    }
  };

  // Admin finishes grading open-ended responses
  const doOpenGradeDone = () => {
    const openResponses = Object.entries(chAnswers).map(([pid, ans], i) => ({ id: i, playerId: pid, text: ans.text, name: ans.name }));
    const newScores = scores.map(p => {
      const respIdx = openResponses.findIndex(r => r.playerId === p.id);
      const grade   = openGrades[respIdx];
      const delta   = grade === "correct" ? 100 : 0;
      return { ...p, score: p.score + delta, delta, wasCorrect: grade === "correct" };
    });
    newScores.sort((a, b) => b.score - a.score);
    setScores(newScores);
    broadcast({ type: GM.REVEAL, correctIdx: null, scores: newScores, isOpen: true });
    setPhase("reveal");
    persistPhase("reveal", qIdx, false);
    // Persist open-ended answers (fire-and-forget)
    if (sessionDbId) {
      const scoreMap = Object.fromEntries(newScores.map(p => [p.id, p]));
      const answerRows = openResponses.map(r => ({
        playerId:    r.playerId,
        playerName:  r.name ?? r.playerId,
        questionIdx: qIdx,
        optionIdx:   null,
        text:        r.text ?? null,
        timeMs:      null,
        isCorrect:   openGrades[r.id] === "correct",
        points:      scoreMap[r.playerId]?.delta ?? 0,
        tenantId,
      }));
      saveGameAnswers(sessionDbId, answerRows)
        .then(({ error }) => { if (error) console.error("[ralli:host] saveGameAnswers (open) failed:", error); });
    }
  };

  const doNext = () => {
    if (isFinalQ) {
      broadcast({ type: GM.GAME_END, scores });
      if (onGameEnd) onGameEnd({ scores, questions, questionHistory });
      persistPhase("ended", qIdx, false);
      onNav("rankd-results");
      return;
    }
    const next = qIdx + 1;
    if (setChAnswers) setChAnswers({});
    setQIdx(next); setCdNum(3); setPhase("countdown");
    persistPhase("countdown", next, false);
    broadcast({ type: GM.NEXT_QUESTION, qIdx: next });
  };

  const doTogglePause = () => {
    const next = !paused;
    setPaused(next);
    persistPhase(phase, qIdx, next);
    broadcast({ type: next ? GM.PAUSE : GM.RESUME });
  };

  const doForceEnd = () => {
    setShowEndConfirm(false);
    broadcast({ type: GM.FORCE_END, scores });
    if (onGameEnd) onGameEnd({ scores, questions, questionHistory });
    persistPhase("ended", qIdx, false);
    onNav("rankd-results");
  };

  const dist = (q?.options ?? []).map((_, i) => Object.values(chAnswers).filter(a => a.optionIdx === i).length);
  const openResponses = Object.entries(chAnswers).map(([pid, ans], i) => ({ id: i, playerId: pid, text: ans.text, name: ans.name }));
  const rankBadges = ["1st","2nd","3rd","4th","5th"];

  // ── Loading / error states during session restoration ─────────────────────────
  if (restoreState === "loading") {
    return (
      <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.cream }}>
        <div style={{ textAlign: "center", padding: 40 }}>
          <style>{`@keyframes rhs{to{transform:rotate(360deg)}}`}</style>
          <div style={{ width: 36, height: 36, borderRadius: "50%", border: `3px solid ${C.border}`, borderTopColor: C.orange, animation: "rhs 0.7s linear infinite", margin: "0 auto 20px" }} />
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.text }}>Restoring session…</p>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: C.textMuted }}>{sessionName}</p>
        </div>
      </div>
    );
  }

  if (restoreState === "error") {
    return (
      <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.cream }}>
        <div style={{ textAlign: "center", padding: 40, maxWidth: 380 }}>
          <div style={{ fontSize: 36, marginBottom: 16 }}>⚠️</div>
          <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: C.text }}>Could not restore session</p>
          <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textMuted }}>{restoreError ?? "Failed to load game state from the server."}</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              onClick={() => setRetryCount(c => c + 1)}
              style={{ padding: "10px 24px", borderRadius: 12, border: "none", background: C.orange, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}
            >
              Retry
            </button>
            <button
              onClick={() => onNav("rankd")}
              style={{ padding: "10px 24px", borderRadius: 12, border: `1.5px solid ${C.border}`, background: "#fff", color: C.text, fontWeight: 700, fontSize: 14, cursor: "pointer" }}
            >
              Back to Games
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "open-review") {
    return (
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", background: C.cream }}>
        {/* Header */}
        <div style={{ padding: "20px 32px 16px", borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: "rgba(255,255,255,0.6)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#7C3AED", letterSpacing: "0.1em" }}>OPEN-ENDED RESPONSES</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>Q{qIdx + 1}/{total}</span>
              {openResponses.length > 0 && (
                <button onClick={() => setOpenGrades(g => ({ ...g, __showNames: !g.__showNames }))} style={{ padding: "4px 10px", borderRadius: 8, border: `1px solid ${PURPLE}44`, cursor: "pointer", background: openGrades.__showNames ? PURPLE + "33" : "transparent", color: openGrades.__showNames ? PURPLE : "rgba(255,255,255,0.4)", fontSize: 11, fontWeight: 700 }}>
                  {openGrades.__showNames ? "Hide Names" : "Show Names"}
                </button>
              )}
            </div>
          </div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900, color: C.text }}>{q.q}</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            {openResponses.length} response{openResponses.length !== 1 ? "s" : ""} · grade each one, then continue
          </p>
        </div>

        {/* Responses */}
        <div style={{ flex: 1, padding: "16px 32px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          {openResponses.length === 0 && (
            <div style={{ textAlign: "center", padding: 60, color: C.textMuted, fontSize: 14 }}>No responses submitted.</div>
          )}
          {openResponses.map((r, i) => {
            const grade = openGrades[i];
            return (
              <div key={i} style={{ padding: "14px 18px", borderRadius: 14, background: grade === "correct" ? "rgba(16,185,129,0.1)" : grade === "incorrect" ? "rgba(239,68,68,0.08)" : "#fff", border: `1px solid ${grade === "correct" ? "rgba(16,185,129,0.4)" : grade === "incorrect" ? "rgba(239,68,68,0.35)" : C.border}` }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, background: "rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: C.textMuted, marginTop: 2 }}>{i + 1}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {openGrades.__showNames && <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 700, color: PURPLE }}>{r.name}</p>}
                    <p style={{ margin: 0, fontSize: 15, color: C.text, lineHeight: 1.45 }}>{r.text || <em style={{ opacity: 0.4 }}>No response</em>}</p>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button onClick={() => setOpenGrades(g => ({ ...g, [i]: g[i] === "correct" ? undefined : "correct" }))} style={{ padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, background: grade === "correct" ? C.green : "rgba(16,185,129,0.12)", color: grade === "correct" ? "#fff" : C.green, minHeight: 36 }}>✓</button>
                    <button onClick={() => setOpenGrades(g => ({ ...g, [i]: g[i] === "incorrect" ? undefined : "incorrect" }))} style={{ padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, background: grade === "incorrect" ? C.red : "rgba(239,68,68,0.1)", color: grade === "incorrect" ? "#fff" : C.red, minHeight: 36 }}>✗</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Continue CTA */}
        <div style={{ padding: "16px 32px 24px", borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
          <button onClick={doOpenGradeDone} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: C.orange, color: "#fff", fontWeight: 900, fontSize: 15, cursor: "pointer", boxShadow: "0 0 32px rgba(253,191,36,0.35)" }}>
            {isFinalQ ? "Finish & Show Results →" : "Continue to Next Question →"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "countdown") {
    const CIRC = 376.99;
    const dotPos = cdNum === 3 ? 0 : cdNum === 2 ? 35 : 70;
    return (
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: C.cream }}>
        <style>{`@keyframes cdRing{from{stroke-dashoffset:${CIRC}}to{stroke-dashoffset:0}}`}</style>
        <p style={{ margin: "0 0 16px", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: C.textMuted, textTransform: "uppercase" }}>
          {qIdx === 0 ? "Game starting in" : `Question ${qIdx + 1} of ${total} in`}
        </p>
        <div key={cdNum} style={{ position: "relative", width: 140, height: 140, flexShrink: 0 }}>
          <svg viewBox="0 0 140 140" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
            <circle cx="70" cy="70" r="60" fill="none" stroke={C.creamBorder} strokeWidth="6" />
            {cdNum > 0 && (
              <circle cx="70" cy="70" r="60" fill="none" stroke={C.gamePurple} strokeWidth="6"
                strokeDasharray={CIRC} strokeDashoffset={CIRC} strokeLinecap="round"
                style={{ animation: "cdRing 1s linear forwards" }} />
            )}
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: cdNum === 0 ? 48 : 68, fontWeight: 900, lineHeight: 1, color: cdNum === 0 ? C.trueGreen : C.text, userSelect: "none" }}>
              {cdNum === 0 ? "GO!" : cdNum}
            </span>
          </div>
        </div>
        <div style={{ position: "relative", width: 80, height: 16, marginTop: 20, flexShrink: 0 }}>
          <div style={{ position: "absolute", top: 3, width: 10, height: 10, borderRadius: "50%", background: C.gamePurple, opacity: cdNum === 0 ? 0 : 1, left: dotPos, transition: "left 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s" }} />
        </div>
        <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", borderRadius: 12, background: C.cardBg, border: `1px solid ${C.creamBorder}` }}>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.1em", color: C.text }}>PIN: {pin}</span>
          <span style={{ fontSize: 13, color: C.textMuted }}>· {dbParticipantCount} player{dbParticipantCount !== 1 ? "s" : ""}</span>
        </div>
      </div>
    );
  }

  if (phase === "scoreboard") {
    return (
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: C.cream, padding: "32px 24px" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textMuted }}>
            {isFinalQ ? "Final Leaderboard" : `After Question ${qIdx + 1} of ${total}`}
          </p>
          <h2 style={{ margin: "0 0 12px", fontSize: 26, fontWeight: 900, color: C.text }}>Leaderboard</h2>
        </div>
        <div style={{ width: "100%", maxWidth: 540, display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
          {scores.map((p, i) => (
            <div key={p.id ?? p.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderRadius: 14, background: C.cardBg, border: `1.5px solid ${C.creamBorder}` }}>
              <div style={{ width: 32, textAlign: "center", fontSize: i < 3 ? 20 : 13, fontWeight: 700, color: i < 3 ? C.orange : C.textMuted, flexShrink: 0 }}>{i + 1}</div>
              <span style={{ fontSize: 24, flexShrink: 0 }}>{p.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>{p.name}</p>
                <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>{p.score.toLocaleString()} pts</p>
              </div>
              {p.delta > 0
                ? <div style={{ padding: "4px 12px", borderRadius: 99, background: C.trueGreenBg }}><span style={{ fontSize: 13, fontWeight: 800, color: C.trueGreen }}>+{p.delta.toLocaleString()}</span></div>
                : <div style={{ padding: "4px 12px", borderRadius: 99, background: "#F3F4F6" }}><span style={{ fontSize: 12, color: C.textMuted }}>+0</span></div>
              }
            </div>
          ))}
        </div>
        <button onClick={doNext} style={{ padding: "13px 40px", borderRadius: 14, border: "none", cursor: "pointer", fontSize: 15, fontWeight: 900, color: "#fff", background: C.orange, boxShadow: "0 4px 20px rgba(253,191,36,0.35)" }}>
          {isFinalQ ? "End Game & View Results →" : `Next Question (${qIdx + 2} / ${total}) →`}
        </button>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", background: C.cream }}>
      {/* Top bar */}
      <div style={{ padding: "14px 28px", display: "flex", alignItems: "center", gap: 16, borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: "rgba(255,255,255,0.7)", backdropFilter: "blur(8px)" }}>
        <div style={{ padding: "5px 14px", borderRadius: 10, background: C.orangeLight, border: `1px solid ${C.orangeBorder}`, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 900, color: C.dark }}>Q{qIdx + 1}</span>
          <span style={{ fontSize: 12, color: C.textMuted }}> / {total}</span>
        </div>
        <div style={{ flex: 1, display: "flex", gap: 3 }}>
          {questions.map((_, i) => (
            <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i < qIdx ? C.green : i === qIdx ? C.orange : "rgba(255,255,255,0.12)", transition: "background 0.3s" }} />
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: answeredCount >= playerCount ? "#059669" : C.dark }}>{answeredCount}/{playerCount}</div>
            <div style={{ fontSize: 10, color: C.textMuted }}>players answered</div>
          </div>
          <div style={{ width: 36, height: 36, borderRadius: "50%", background: timerColor, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 13, color: "#fff", transition: "background 0.3s" }}>{phase === "reveal" ? "✓" : timeLeft}</div>
          {/* Admin controls */}
          <button onClick={doTogglePause} title={paused ? "Resume" : "Pause"} style={{ width: 36, height: 36, borderRadius: "50%", border: `1px solid ${C.border}`, background: paused ? C.orange : "rgba(255,255,255,0.9)", color: paused ? "#fff" : C.dark, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {paused ? "▶" : "⏸"}
          </button>
          <button onClick={() => setShowEndConfirm(true)} title="End game early" style={{ width: 36, height: 36, borderRadius: "50%", border: "1px solid rgba(239,68,68,0.5)", background: "rgba(239,68,68,0.08)", color: "#ef4444", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            ■
          </button>
          <button onClick={() => setShowEndConfirm(true)} title="End and exit" style={{ width: 36, height: 36, borderRadius: "50%", border: `1px solid ${C.border}`, background: "rgba(255,255,255,0.9)", color: C.textSub, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            ✕
          </button>
        </div>
      </div>

      {/* End confirm modal */}
      {showEndConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 20, padding: "32px 40px", textAlign: "center", maxWidth: 360 }}>
            <h2 style={{ margin: "0 0 8px", color: C.text, fontWeight: 900, fontSize: 20 }}>End game now?</h2>
            <p style={{ margin: "0 0 24px", color: C.textSub, fontSize: 14 }}>Current scores will be shown as the final leaderboard. This can't be undone.</p>
            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => setShowEndConfirm(false)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.text, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
              <button onClick={doForceEnd} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: "#ef4444", color: "#fff", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>End Game</button>
            </div>
          </div>
        </div>
      )}

      {/* Paused overlay */}
      {paused && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, zIndex: 100, backdropFilter: "blur(4px)" }}>
          <div style={{ fontSize: 56 }}>⏸</div>
          <p style={{ margin: 0, fontSize: 22, fontWeight: 900, color: "#fff" }}>Game Paused</p>
          <button onClick={doTogglePause} style={{ marginTop: 4, padding: "14px 36px", borderRadius: 14, border: "none", background: C.orange, color: "#fff", fontSize: 17, fontWeight: 900, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
            ▶ Resume
          </button>
        </div>
      )}

      {/* Timer bar */}
      <div style={{ height: 4, background: C.border, flexShrink: 0 }}>
        <div style={{ height: "100%", width: `${phase === "reveal" ? 0 : timerPct}%`, background: timerColor, transition: "width 1s linear, background 0.3s" }} />
      </div>

      {/* Question */}
      <div style={{ padding: mobile ? "16px 16px 12px" : "24px 40px 16px", flexShrink: 0 }}>
        <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: C.textMuted, textTransform: "uppercase" }}>{Q_TYPE_LABELS[q.type] ?? "Question"}</p>
        <h2 style={{ margin: 0, fontSize: mobile ? 18 : 24, fontWeight: 900, color: C.text, lineHeight: 1.3 }}>{q.q}</h2>
      </div>

      {/* Answer options — type question shows accepted-answer panel, not a grid */}
      {q.type === "type" && (
        <div style={{ flex: 1, padding: "0 40px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ padding: "18px 22px", borderRadius: 14, background: "#fff", border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 8 }}>ACCEPTED ANSWER{(q.acceptedAnswers?.length ?? 0) > 1 ? "S" : ""}</div>
            {(q.acceptedAnswers ?? []).length > 0
              ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {q.acceptedAnswers.map((a, i) => (
                    <span key={i} style={{ padding: "6px 14px", borderRadius: 8, background: "#D1FAE5", color: "#059669", fontSize: 14, fontWeight: 700 }}>{a}</span>
                  ))}
                </div>
              : <span style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic" }}>Accepted answer not provided.</span>
            }
          </div>
          {phase === "reveal" && (
            <div style={{ padding: "14px 18px", borderRadius: 14, background: C.white, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 10 }}>PLAYER RESPONSES</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {Object.entries(chAnswers).map(([pid, ans], i) => {
                  const accepted = (q.acceptedAnswers ?? []).map(a => a.toLowerCase().trim());
                  const correct  = accepted.length > 0 && accepted.some(a => (ans.text ?? "").toLowerCase().trim() === a);
                  return (
                    <div key={pid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 10, background: correct ? "#D1FAE5" : "#FEF2F2" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: correct ? "#059669" : C.red }}>{correct ? "✓" : "✗"}</span>
                      <span style={{ fontSize: 13, color: C.text, flex: 1 }}>{ans.text ?? <em style={{ color: C.textMuted }}>No response</em>}</span>
                      <span style={{ fontSize: 11, color: C.textSub }}>{ans.name}</span>
                    </div>
                  );
                })}
                {Object.keys(chAnswers).length === 0 && <span style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic" }}>No responses received.</span>}
              </div>
            </div>
          )}
          {phase !== "reveal" && (
            <div style={{ padding: "12px 18px", borderRadius: 12, background: C.muted, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{answeredCount}</span>
              <span style={{ fontSize: 13, color: C.textSub }}>of {playerCount} answered</span>
            </div>
          )}
        </div>
      )}
      <div style={{ flex: q.type === "type" ? 0 : 1, padding: "0 40px 20px", display: q.type === "type" ? "none" : "flex", flexDirection: "column", gap: 10 }}>
        {(q.options ?? []).map((opt, i) => {
          const OPTION_COLORS = ["#EF4444", "#3B82F6", "#F59E0B", "#22C55E"];
          const optColor = OPTION_COLORS[i % OPTION_COLORS.length];
          const isCorrect = phase === "reveal" && i === q.correct;
          const isWrong   = phase === "reveal" && i !== q.correct;
          const pct = playerCount > 0 ? Math.round((dist[i] / playerCount) * 100) : 0;
          // During reveal: correct = vivid green, wrong = dimmed colored card
          const bgColor = isCorrect ? "#059669" : optColor;
          return (
            <div key={i} style={{
              borderRadius: 14, padding: "14px 18px",
              background: bgColor,
              border: `3px solid ${isCorrect ? "#34D399" : "transparent"}`,
              opacity: isWrong ? 0.35 : 1,
              transition: "opacity 0.3s",
              boxShadow: isCorrect ? "0 0 24px rgba(16,185,129,0.4)" : "0 2px 8px rgba(0,0,0,0.15)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: phase === "reveal" ? 8 : 0 }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(0,0,0,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 900, color: "#fff", flexShrink: 0 }}>
                  {isCorrect ? "✓" : String.fromCharCode(65 + i)}
                </div>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#fff", flex: 1 }}>{opt}</span>
                {phase === "reveal" && <span style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>{dist[i]} · {pct}%</span>}
              </div>
              {phase === "reveal" && (
                <div style={{ height: 4, borderRadius: 2, background: "rgba(0,0,0,0.2)" }}>
                  <div style={{ height: "100%", width: `${pct}%`, borderRadius: 2, background: "rgba(255,255,255,0.6)", transition: "width 0.6s" }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Reveal: mini leaderboard + next CTA */}
      {phase === "reveal" && (
        <div style={{ padding: "0 40px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
            {scores.slice(0, 5).map((p, i) => (
              <div key={p.id} style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderRadius: 12, background: "rgba(255,255,255,0.85)", border: `1px solid ${C.border}` }}>
                <span style={{ fontSize: i < 3 ? 18 : 13, fontWeight: 700 }}>{rankBadges[i]}</span>
                <span style={{ fontSize: 18 }}>{p.emoji}</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: C.orangeDeep, fontWeight: 800 }}>{p.score.toLocaleString()} pts</div>
                </div>
              </div>
            ))}
          </div>
          <button onClick={() => { broadcast({ type: GM.SCOREBOARD, scores, isFinal: isFinalQ }); setPhase("scoreboard"); persistPhase("scoreboard", qIdx, false); }} style={{ padding: "14px 44px", borderRadius: 18, border: "none", background: C.orange, color: "#fff", fontWeight: 900, fontSize: 15, cursor: "pointer", boxShadow: "0 0 40px rgba(253,191,36,0.4)" }}>
            Reveal Leaderboard →
          </button>
        </div>
      )}
    </div>
  );
}

// ── REAL GAME PLAYER VIEW ────────────────────────────────────
function KahootPlayerView({ onNav, playerName, playerId, pin, sessionDbId, broadcast, chMsg }) {
  const mobile          = useMobile();
  const [phase,         setPhase]         = useState("waiting");
  const [cdNum,         setCdNum]         = useState(3);
  const [question,      setQuestion]      = useState(null);
  const [timeLeft,      setTimeLeft]      = useState(0);
  const [selectedIdx,   setSelectedIdx]   = useState(null);
  const [openText,      setOpenText]      = useState("");
  const [openSubmitted, setOpenSubmitted] = useState(false);
  const [qStartMs,      setQStartMs]      = useState(null);
  const [myScore,       setMyScore]       = useState(0);
  const [myRank,        setMyRank]        = useState(null);
  const [myDelta,       setMyDelta]       = useState(0);
  const [isCorrect,     setIsCorrect]     = useState(null);
  const [finalScores,   setFinalScores]   = useState(null);
  const [gamePaused,    setGamePaused]    = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  // Heartbeat: keep last_seen_at fresh while in-game so host can detect stale connections
  useEffect(() => {
    if (!sessionDbId || !playerId) return;
    const interval = setInterval(() => {
      updateParticipantHeartbeat(sessionDbId, playerId)
        .catch(e => console.error("[ralli:player] heartbeat failed:", e));
    }, 30_000);
    return () => clearInterval(interval);
  }, [sessionDbId, playerId]);

  useEffect(() => {
    if (!chMsg) return;
    // Game start: host broadcast — show countdown before first question
    if (chMsg.type === GM.GAME_START) { setCdNum(3); setPhase("countdown"); }
    if (chMsg.type === GM.SHOW_QUESTION) {
      const timeLimit = chMsg.timeLimit ?? chMsg.question?.timeLimit ?? 20;
      const elapsed = chMsg.questionStartedAt ? Math.floor((Date.now() - chMsg.questionStartedAt) / 1000) : 0;
      setQuestion(chMsg.question); setTimeLeft(Math.max(1, timeLimit - elapsed));
      setSelectedIdx(null); setOpenText(""); setOpenSubmitted(false);
      setQStartMs(Date.now()); setPhase("question");
    }
    if (chMsg.type === GM.OPEN_REVIEW) { setPhase("open-waiting"); }
    if (chMsg.type === GM.REVEAL) {
      setPhase("reveal");
      let revealCorrect;
      if (chMsg.isOpen) {
        revealCorrect = null; // open-ended — host graded
      } else if (Array.isArray(chMsg.acceptedAnswers)) {
        // Type-answer: check typed text against accepted answers
        const acc = chMsg.acceptedAnswers.map(a => a.toLowerCase().trim());
        revealCorrect = acc.length > 0 && acc.some(a => openText.toLowerCase().trim() === a);
      } else {
        revealCorrect = selectedIdx === chMsg.correctIdx;
      }
      setIsCorrect(revealCorrect);
      const me = chMsg.scores?.find(p => p.id === playerId) ?? chMsg.scores?.find(p => p.name === playerName);
      if (me) { setMyScore(me.score); setMyDelta(me.delta); setMyRank(chMsg.scores.indexOf(me) + 1); }
    }
    if (chMsg.type === GM.NEXT_QUESTION) { setCdNum(3); setIsCorrect(null); setGamePaused(false); setPhase("countdown"); }
    if (chMsg.type === GM.GAME_END) { setFinalScores(chMsg.scores); setPhase("ended"); }
    if (chMsg.type === GM.PAUSE) { setGamePaused(true); }
    if (chMsg.type === GM.RESUME) { setGamePaused(false); }
    if (chMsg.type === GM.FORCE_END) { setFinalScores(chMsg.scores); setPhase("ended"); }
    if (chMsg.type === GM.SCOREBOARD) { if (chMsg.scores) setFinalScores(chMsg.scores); setPhase("scoreboard"); }
  }, [chMsg]);

  useEffect(() => {
    if (phase !== "countdown") return;
    if (cdNum <= 0) { return; } // stop at "GO!" — SHOW_QUESTION will transition to "question"
    const t = setTimeout(() => setCdNum(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, cdNum]);

  useEffect(() => {
    if (phase !== "question" || gamePaused) return;
    if (timeLeft <= 0) { setPhase("answered"); return; }
    const t = setTimeout(() => setTimeLeft(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, timeLeft, gamePaused]);

  const handleAnswer = (idx) => {
    if (phase !== "question" || selectedIdx !== null) return;
    const timeMs = Date.now() - (qStartMs ?? Date.now());
    setSelectedIdx(idx); setPhase("answered");
    broadcast({ type: GM.ANSWER, playerId, name: playerName, optionIdx: idx, timeMs });
  };

  const timerPct   = question ? (timeLeft / question.timeLimit) * 100 : 0;
  const timerColor = timerPct > 50 ? C.green : timerPct > 25 ? C.orange : C.red;
  const bgGrad     = C.cream;

  const leaveBtn = (
    <button onClick={() => setShowLeaveConfirm(true)} style={{
      position: "absolute", top: 14, left: 14, zIndex: 20,
      padding: "7px 14px", borderRadius: 99, border: `1px solid rgba(255,255,255,0.4)`,
      background: "rgba(255,255,255,0.25)", color: C.dark, fontSize: 12, fontWeight: 700,
      cursor: "pointer", backdropFilter: "blur(4px)",
    }}>← Leave</button>
  );

  const leaveModal = showLeaveConfirm && (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20 }}>
      <div style={{ background: C.cardBg, borderRadius: 20, padding: "32px 36px", textAlign: "center", maxWidth: 320, width: "100%" }}>
        <h2 style={{ margin: "0 0 8px", color: C.text, fontWeight: 900, fontSize: 18 }}>Leave game?</h2>
        <p style={{ margin: "0 0 24px", color: C.textSub, fontSize: 14 }}>You can rejoin with the same PIN. Your current answers will not be saved.</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => setShowLeaveConfirm(false)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.text, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          <button onClick={() => onNav("rankd")} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: C.orange, color: "#fff", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>Leave</button>
        </div>
      </div>
    </div>
  );

  if (phase === "waiting") {
    return (
      <div style={{ minHeight: "100%", background: C.cream, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, position: "relative" }}>
        {leaveModal}{leaveBtn}
        
        <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>Hang tight…</p>
        <p style={{ margin: 0, fontSize: 14, color: C.textSub }}>Next question coming up</p>
        <div style={{ marginTop: 12, padding: "7px 18px", borderRadius: 99, background: "rgba(253,191,36,0.1)", border: "1px solid rgba(253,191,36,0.25)" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.orangeDeep }}>{myScore.toLocaleString()} pts</span>
          {myRank && <span style={{ fontSize: 12, color: C.textSub, marginLeft: 8 }}>Rank #{myRank}</span>}
        </div>
      </div>
    );
  }

  if (phase === "scoreboard" || phase === "ended") {
    const rankBadges = ["1st","2nd","3rd","4th","5th"];
    const isFinalBoard = phase === "ended";
    const boardScores  = finalScores ?? [];
    const myRankIdx    = boardScores.findIndex(p => p.id === playerId);
    const myRankNum    = myRankIdx >= 0 ? myRankIdx + 1 : null;
    return (
      <div style={{ minHeight: "100%", background: C.cream, display: "flex", flexDirection: "column" }}>
        {leaveModal}
        <div style={{ padding: "16px 20px 14px", background: C.cardBg, borderBottom: `1px solid ${C.border}`, textAlign: "center" }}>
          <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textMuted }}>{isFinalBoard ? "Game Over" : "Leaderboard"}</p>
          <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 900, color: C.text }}>{isFinalBoard ? "Final Leaderboard" : "Leaderboard"}</h2>
          {myRankNum && <p style={{ margin: 0, fontSize: 13, color: C.orange, fontWeight: 700 }}>You finished {myRankNum <= 5 ? rankBadges[myRankNum - 1] : `#${myRankNum}`}!</p>}
        </div>
        <div style={{ flex: 1, padding: "16px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {boardScores.map((p, i) => {
            const isMe = p.id === playerId;
            return (
              <div key={p.id ?? i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderRadius: 14, background: C.cardBg, border: `1.5px solid ${isMe ? C.orangeBorder : C.creamBorder}`, boxShadow: isMe ? "0 2px 12px rgba(253,191,36,0.12)" : "0 1px 4px rgba(0,0,0,0.04)" }}>
                <div style={{ width: 32, textAlign: "center", fontSize: i < 3 ? 18 : 13, fontWeight: 700, color: i < 3 ? C.orange : C.textMuted, flexShrink: 0 }}>{i < 5 ? rankBadges[i] : i + 1}</div>
                <span style={{ fontSize: 22, flexShrink: 0 }}>{p.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>{p.name}</p>
                    {isMe && <span style={{ fontSize: 10, fontWeight: 800, padding: "1px 7px", borderRadius: 99, background: C.orange, color: "#fff" }}>YOU</span>}
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>{p.score.toLocaleString()} pts</p>
                </div>
                {p.delta > 0 && <div style={{ padding: "4px 10px", borderRadius: 99, background: C.trueGreenBg }}><span style={{ fontSize: 12, fontWeight: 800, color: C.trueGreen }}>+{p.delta.toLocaleString()}</span></div>}
              </div>
            );
          })}
          {boardScores.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textMuted, fontSize: 14 }}>No scores yet</div>}
        </div>
        <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.border}` }}>
          {isFinalBoard
            ? <button onClick={() => onNav("home")} style={{ width: "100%", padding: "13px", borderRadius: 14, border: "none", background: C.orange, color: "#fff", fontWeight: 900, fontSize: 15, cursor: "pointer", boxShadow: "0 0 32px rgba(253,191,36,0.3)" }}>Done</button>
            : <p style={{ margin: 0, fontSize: 13, color: C.textSub, textAlign: "center" }}>Waiting for host to continue…</p>
          }
        </div>
      </div>
    );
  }

  if (phase === "countdown") {
    const CIRC = 376.99;
    const dotPos = cdNum === 3 ? 0 : cdNum === 2 ? 35 : 70;
    return (
      <div style={{ minHeight: "100%", background: C.cream, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, position: "relative" }}>
        {leaveModal}{leaveBtn}
        <style>{`@keyframes cdRing{from{stroke-dashoffset:${CIRC}}to{stroke-dashoffset:0}}`}</style>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: C.textMuted, textTransform: "uppercase" }}>Get ready</p>
        <div key={cdNum} style={{ position: "relative", width: 120, height: 120, flexShrink: 0 }}>
          <svg viewBox="0 0 120 120" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
            <circle cx="60" cy="60" r="52" fill="none" stroke={C.creamBorder} strokeWidth="5" />
            {cdNum > 0 && (
              <circle cx="60" cy="60" r="52" fill="none" stroke={C.gamePurple} strokeWidth="5"
                strokeDasharray={2 * Math.PI * 52} strokeDashoffset={2 * Math.PI * 52} strokeLinecap="round"
                style={{ animation: "cdRing 1s linear forwards" }} />
            )}
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: cdNum === 0 ? 32 : 52, fontWeight: 900, lineHeight: 1, color: cdNum === 0 ? C.trueGreen : C.text, userSelect: "none" }}>
              {cdNum === 0 ? "GO!" : cdNum}
            </span>
          </div>
        </div>
        <div style={{ position: "relative", width: 80, height: 16, flexShrink: 0 }}>
          <div style={{ position: "absolute", top: 3, width: 10, height: 10, borderRadius: "50%", background: C.gamePurple, opacity: cdNum === 0 ? 0 : 1, left: dotPos, transition: "left 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s" }} />
        </div>
        {myScore > 0 && <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Score: <strong style={{ color: C.orange }}>{myScore.toLocaleString()}</strong></p>}
      </div>
    );
  }

  if (phase === "answered" || phase === "reveal") {
    const showResult  = phase === "reveal";
    const hasAnswer   = selectedIdx !== null || openSubmitted;
    const answerLabel = selectedIdx !== null
      ? question?.options?.[selectedIdx]
      : openText || "—";
    const answerBadge = selectedIdx !== null
      ? String.fromCharCode(65 + selectedIdx)
      : "✎";
    return (
      <div style={{ minHeight: "100%", background: C.cream, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: mobile ? 16 : 32 }}>
        {hasAnswer ? (
          <>
            <div style={{ padding: "16px 24px", borderRadius: 16, background: C.cardBg, border: `1.5px solid ${showResult ? (isCorrect ? "#BBF7D0" : isCorrect === false ? "#FECACA" : C.creamBorder) : C.creamBorder}`, textAlign: "center", maxWidth: 360, width: "100%" }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: C.textMuted, textTransform: "uppercase", marginBottom: 8 }}>Your answer</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: showResult ? (isCorrect ? C.trueGreenBg : isCorrect === false ? "#FEF2F2" : C.cream) : C.cream, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, color: showResult ? (isCorrect ? C.trueGreen : isCorrect === false ? C.red : C.orange) : C.orange, flexShrink: 0 }}>
                  {showResult && selectedIdx !== null ? (isCorrect ? "✓" : "✗") : answerBadge}
                </div>
                <span style={{ fontSize: 15, fontWeight: 700, color: C.text, textAlign: "left" }}>{answerLabel}</span>
              </div>
            </div>
            {!showResult && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.orange, animation: "pulse 1s infinite" }} />
                <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.textSub }}>Locked in — waiting for others</p>
              </div>
            )}
            {showResult && (
              <>
                <div style={{ textAlign: "center" }}>
                  {isCorrect === null
                    ? <><div style={{ fontSize: 32, fontWeight: 900, color: myDelta > 0 ? C.trueGreen : C.textMuted, marginBottom: 4 }}>{myDelta > 0 ? "Full marks!" : "Not awarded"}</div>
                        <div style={{ fontSize: 13, color: C.textMuted }}>Host graded your response</div></>
                    : <div style={{ fontSize: 32, fontWeight: 900, color: isCorrect ? C.trueGreen : C.red }}>{isCorrect ? "Correct!" : "Wrong"}</div>
                  }
                  {myDelta > 0 && <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, color: C.orange }}>+{myDelta.toLocaleString()} pts</div>}
                </div>
                <div style={{ padding: "10px 22px", borderRadius: 12, background: C.cardBg, border: `1px solid ${C.creamBorder}` }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{myScore.toLocaleString()} pts</span>
                  {myRank && <span style={{ fontSize: 13, color: C.textMuted, marginLeft: 10 }}>· Rank #{myRank}</span>}
                </div>
                <p style={{ margin: 0, fontSize: 13, color: C.textMuted }}>Waiting for host…</p>
              </>
            )}
          </>
        ) : (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 28, fontWeight: 900, color: C.text, marginBottom: 8 }}>Time's up!</div>
            <div style={{ fontSize: 14, color: C.textMuted }}>No answer recorded</div>
          </div>
        )}
      </div>
    );
  }

  // phase === "open-waiting" — host is grading open-ended responses
  if (phase === "open-waiting") {
    return (
      <div style={{ minHeight: "100%", background: C.cream, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32 }}>
        
        <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>Responses submitted!</p>
        <p style={{ margin: 0, fontSize: 14, color: C.textSub, textAlign: "center" }}>Host is reviewing answers — hang tight</p>
        <div style={{ marginTop: 8, padding: "7px 18px", borderRadius: 99, background: `rgba(139,92,246,0.12)`, border: `1px solid rgba(139,92,246,0.25)` }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: PURPLE }}>Grading in progress...</span>
        </div>
      </div>
    );
  }

  // phase === "question"
  const isOpen = question?.type === "open";

  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", background: C.cream, position: "relative" }}>
      {leaveModal}
      {/* Top bar */}
      <div style={{ padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: C.cardBg }}>
        <button onClick={() => setShowLeaveConfirm(true)} style={{ padding: "5px 12px", borderRadius: 99, border: `1px solid ${C.border}`, background: "transparent", color: C.textSub, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>← Leave</button>
        {isOpen
          ? <div style={{ fontSize: 11, fontWeight: 700, color: PURPLE, letterSpacing: "0.08em" }}>OPEN ENDED</div>
          : <div style={{ width: 36, height: 36, borderRadius: "50%", background: gamePaused ? "rgba(255,255,255,0.15)" : timerColor, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 14, color: "#fff", transition: "background 0.3s" }}>{gamePaused ? "⏸" : timeLeft}</div>
        }
        <div style={{ fontSize: 13, fontWeight: 800, color: C.orangeDeep }}>{myScore.toLocaleString()} pts</div>
      </div>
      {/* Paused overlay */}
      {gamePaused && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, zIndex: 50, backdropFilter: "blur(3px)" }}>
          <div style={{ fontSize: 48 }}>⏸</div>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 900, color: "#fff" }}>Game Paused</p>
          <p style={{ margin: 0, fontSize: 13, color: "rgba(255,255,255,0.45)" }}>Host will resume shortly</p>
        </div>
      )}

      {/* Timer bar — hidden for open-ended */}
      {!isOpen && (
        <div style={{ height: 4, background: C.border, flexShrink: 0 }}>
          <div style={{ height: "100%", width: `${timerPct}%`, background: timerColor, transition: "width 1s linear, background 0.3s" }} />
        </div>
      )}

      {/* Question */}
      <div style={{ padding: "20px 20px 14px", flexShrink: 0 }}>
        <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: C.textMuted, textTransform: "uppercase" }}>{Q_TYPE_LABELS[question?.type] ?? "Question"}</p>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900, color: C.text, lineHeight: 1.3 }}>{question?.q}</h2>
      </div>

      {/* Answer input — varies by question type */}
      {isOpen ? (
        /* Open-ended — large textarea */
        <div style={{ flex: 1, padding: "0 16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
          <textarea
            value={openText}
            onChange={e => !openSubmitted && setOpenText(e.target.value)}
            placeholder="Type your response…"
            readOnly={openSubmitted}
            style={{
              flex: 1, minHeight: 140, padding: "16px", borderRadius: 14, resize: "none",
              background: openSubmitted ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.07)",
              border: `2px solid ${openSubmitted ? "rgba(139,92,246,0.4)" : openText.trim() ? "rgba(253,191,36,0.5)" : "rgba(255,255,255,0.1)"}`,
              color: "#fff", fontSize: 15, fontFamily: "inherit", outline: "none",
              transition: "border-color 0.2s",
            }}
          />
          {!openSubmitted ? (
            <button onClick={() => {
              if (!openText.trim()) return;
              const timeMs = Date.now() - (qStartMs ?? Date.now());
              setOpenSubmitted(true);
              broadcast({ type: GM.ANSWER, playerId, name: playerName, text: openText.trim(), optionIdx: null, timeMs });
            }} style={{ padding: "14px", borderRadius: 14, border: "none", background: openText.trim() ? C.orange : "rgba(255,255,255,0.08)", color: openText.trim() ? "#fff" : "rgba(255,255,255,0.3)", fontWeight: 900, fontSize: 15, cursor: openText.trim() ? "pointer" : "not-allowed", transition: "background 0.2s" }}>
              {openText.trim() ? "Submit Response →" : "Type something to submit"}
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 12, background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.25)" }}>
              <p style={{ margin: 0, fontSize: 14, color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>Submitted — waiting for host to review</p>
            </div>
          )}
        </div>
      ) : question?.type === "type" ? (
        /* Type-answer — single text input */
        <div style={{ flex: 1, padding: "0 16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="text"
            value={openText}
            onChange={e => !openSubmitted && setOpenText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && openText.trim() && !openSubmitted) {
                const timeMs = Date.now() - (qStartMs ?? Date.now());
                setOpenSubmitted(true);
                setPhase("answered");
                broadcast({ type: GM.ANSWER, playerId, name: playerName, text: openText.trim(), optionIdx: null, timeMs });
              }
            }}
            placeholder="Type your answer…"
            readOnly={openSubmitted}
            style={{
              padding: "18px 20px", borderRadius: 14, outline: "none", fontFamily: "inherit",
              background: openSubmitted ? "#F5F3FF" : "#fff",
              border: `2px solid ${openSubmitted ? PURPLE + "60" : openText.trim() ? C.orange : C.border}`,
              color: C.text, fontSize: 17, fontWeight: 600, transition: "border-color 0.2s",
              boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
            }}
          />
          {!openSubmitted ? (
            <button onClick={() => {
              if (!openText.trim()) return;
              const timeMs = Date.now() - (qStartMs ?? Date.now());
              setOpenSubmitted(true);
              setPhase("answered");
              broadcast({ type: GM.ANSWER, playerId, name: playerName, text: openText.trim(), optionIdx: null, timeMs });
            }} style={{ padding: "14px", borderRadius: 14, border: "none", background: openText.trim() ? C.orange : C.muted, color: openText.trim() ? "#fff" : C.textMuted, fontWeight: 900, fontSize: 15, cursor: openText.trim() ? "pointer" : "not-allowed", transition: "background 0.2s" }}>
              {openText.trim() ? "Submit Answer →" : "Type something to submit"}
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 12, background: "#F5F3FF", border: `1px solid ${PURPLE}44` }}>
              <p style={{ margin: 0, fontSize: 14, color: PURPLE, fontWeight: 700 }}>✓ Submitted — waiting for host</p>
            </div>
          )}
        </div>
      ) : (question?.options ?? []).length > 0 ? (
        /* MC / TF — options grid */
        <div style={{ flex: 1, padding: "0 16px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
          {question.options.map((opt, i) => {
            const OPTION_COLORS = ["#EF4444", "#3B82F6", "#F59E0B", "#22C55E"];
            const optColor = OPTION_COLORS[i % OPTION_COLORS.length];
            const isSelected = selectedIdx === i;
            const isLocked = selectedIdx !== null;
            return (
              <button key={i} onClick={() => handleAnswer(i)} style={{
                width: "100%", padding: "16px 18px", borderRadius: 14,
                border: `3px solid ${isSelected ? "#fff" : "transparent"}`,
                background: optColor,
                color: "#fff", cursor: isLocked ? "default" : "pointer",
                display: "flex", alignItems: "center", gap: 12, textAlign: "left",
                opacity: isLocked && !isSelected ? 0.45 : 1,
                transform: isSelected ? "scale(1.02)" : "scale(1)",
                transition: "opacity 0.2s, transform 0.15s, border-color 0.15s",
                boxShadow: isSelected ? `0 0 0 3px ${optColor}55, 0 4px 16px rgba(0,0,0,0.3)` : "0 2px 8px rgba(0,0,0,0.2)",
              }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: "rgba(0,0,0,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, color: "#fff" }}>
                  {String.fromCharCode(65 + i)}
                </div>
                <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>{opt}</span>
              </button>
            );
          })}
        </div>
      ) : (
        /* Fallback: question type not fully supported in player view */
        <div style={{ flex: 1, padding: "0 16px 24px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 14, color: "rgba(255,255,255,0.45)", textAlign: "center" }}>
            Answer on host screen · type: {question?.type ?? "unknown"}
          </p>
        </div>
      )}
    </div>
  );
}

// ── RANKD GAME SCREEN ────────────────────────────────────────

function RankdGameScreen({ onNav, sessionName, role, playerName, questions = GAME_QUESTIONS, demoMode = true, pin, sessionDbId, tenantId, broadcast, chMsg, chAnswers, chPlayers, playerId, onGameEnd, setChAnswers }) {
  // Real multiplayer mode — route to Kahoot views
  if (!demoMode && role === "admin") {
    return <KahootHostView onNav={onNav} sessionName={sessionName} pin={pin} sessionDbId={sessionDbId} tenantId={tenantId} questions={questions} broadcast={broadcast} chAnswers={chAnswers} chPlayers={chPlayers} onGameEnd={onGameEnd} setChAnswers={setChAnswers} />;
  }
  if (!demoMode && role !== "admin") {
    return <KahootPlayerView onNav={onNav} playerName={playerName} playerId={playerId} pin={pin} sessionDbId={sessionDbId} broadcast={broadcast} chMsg={chMsg} />;
  }

  const mobile = useMobile();
  const TOTAL = questions.length;

  const [phase,         setPhase]         = useState("countdown");
  // phases: countdown | question | reveal | open-review | scoreboard
  const [qIdx,          setQIdx]          = useState(0);
  const [cdNum,         setCdNum]         = useState(3);
  const [timeLeft,      setTimeLeft]      = useState(0);
  const [selectedIdx,    setSelectedIdx]    = useState(null);
  const [lockedAtTime,   setLockedAtTime]   = useState(null);
  const [answeredCount,  setAnsweredCount]  = useState(0);
  const [hasRevealed,    setHasRevealed]    = useState(false);
  // type-specific answer state
  const [typedAnswer,    setTypedAnswer]    = useState("");
  const [typeSubmitted,  setTypeSubmitted]  = useState(false);
  // open-ended state
  const [openResponses,  setOpenResponses]  = useState([]); // [{ text, id }]
  const [openGrades,     setOpenGrades]     = useState({}); // { idx: "correct"|"incorrect" }
  const [openSubmitted,  setOpenSubmitted]  = useState(false);
  const [sliderValue,    setSliderValue]    = useState(5);
  const [sliderSubmitted,setSliderSubmitted]= useState(false);
  const [pinPoint,       setPinPoint]       = useState(null);
  const [pinSubmitted,   setPinSubmitted]   = useState(false);
  const [shuffledRight,  setShuffledRight]  = useState([]);
  // Host controls
  const [paused,         setPaused]         = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [matchPairs,     setMatchPairs]     = useState([]);  // [{leftIdx, rightIdx}]
  const [matchSelLeft,   setMatchSelLeft]   = useState(null);
  const [scores, setScores] = useState(
    LOBBY_PLAYERS.map(p => ({ ...p, score: 0, delta: 0, wasCorrect: false }))
  );

  const userName = playerName ?? "You";

  const q        = questions[qIdx];
  const remaining = TOTAL - qIdx - 1;
  const isFinalQ  = qIdx === TOTAL - 1;
  const timerPct  = timeLeft > 0 ? (timeLeft / q.timeLimit) * 100 : 0;
  const timerColor = timerPct > 50 ? C.green : timerPct > 25 ? C.orange : C.red;

  // ── Countdown (start + between questions + final) ──
  useEffect(() => {
    if (phase !== "countdown") return;
    if (cdNum <= 0) {
      if (phase === "countdown") {
        setPhase("question");
        setTimeLeft(q.timeLimit);
        setAnsweredCount(0);
        setSelectedIdx(null);
        setLockedAtTime(null);
        setHasRevealed(false);
        setTypedAnswer(""); setTypeSubmitted(false);
        setOpenResponses([]); setOpenGrades({}); setOpenSubmitted(false);
        setSliderValue(Math.round(((q.min ?? 0) + (q.max ?? 10)) / 2));
        setSliderSubmitted(false);
        setPinPoint(null); setPinSubmitted(false);
        setMatchPairs([]); setMatchSelLeft(null);
        if (q.type === "match" && q.pairs?.length) {
          setShuffledRight([...q.pairs].sort(() => Math.random() - 0.5));
        }
      } else {
        onNav("rankd-results");
      }
      return;
    }
    const t = setTimeout(() => setCdNum(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, cdNum]);

  // ── Question timer ──
  useEffect(() => {
    if (phase !== "question" || paused) return;
    if (timeLeft <= 0) { doReveal(); return; }
    const t = setTimeout(() => setTimeLeft(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, timeLeft, paused]);

  // ── Simulate players answering ──
  useEffect(() => {
    if (phase !== "question") return;
    const total = LOBBY_PLAYERS.length;
    let count = 0;
    const interval = setInterval(() => {
      count = Math.min(count + 1, total);
      setAnsweredCount(count);
      if (count >= total) clearInterval(interval);
    }, Math.max(700, (q.timeLimit * 1000) / (total + 1)));
    return () => clearInterval(interval);
  }, [phase, qIdx]);

  const doReveal = () => {
    if (hasRevealed) return;
    setHasRevealed(true);

    // Open-ended: go to review phase instead of reveal
    if (q.type === "open") {
      // Demo: use canned responses with author names. Real: store actual player submission.
      const responses = demoMode
        ? OPEN_DEMO_RESPONSES.slice(0, 4 + Math.floor(Math.random() * 2)).map((r, i) => ({ text: r.text, author: r.author, id: i }))
        : openSubmitted ? [{ text: typedAnswer, author: playerName, id: 0 }] : [];
      setOpenResponses(responses);
      setPhase("open-review");
      return;
    }

    setPhase("reveal");

    const speedPct = lockedAtTime !== null ? lockedAtTime / q.timeLimit : 0;

    const computeUser = () => {
      switch (q.type) {
        case "mc":
        case "tf": {
          const ok = selectedIdx === q.correct;
          return { wasCorrect: ok, delta: ok ? Math.round(400 + speedPct * 600) : 0 };
        }
        case "type": {
          const ok = typeSubmitted && (q.acceptedAnswers ?? []).some(a =>
            a.trim().toLowerCase() === typedAnswer.trim().toLowerCase()
          );
          return { wasCorrect: ok, delta: ok ? Math.round(400 + speedPct * 600) : 0 };
        }
        case "slider": {
          if (!sliderSubmitted) return { wasCorrect: false, delta: 0 };
          const diff = Math.abs(sliderValue - (q.correct ?? 5));
          const tol  = q.tolerance ?? 1;
          const ok   = diff <= tol;
          return { wasCorrect: ok, delta: ok ? Math.round(400 + Math.max(0, 1 - diff / tol) * 600) : 0 };
        }
        case "pin": {
          if (!pinSubmitted || !pinPoint || q.correctX === undefined) return { wasCorrect: false, delta: 0 };
          const dist = Math.sqrt(Math.pow(pinPoint.x - q.correctX, 2) + Math.pow(pinPoint.y - q.correctY, 2));
          const tol  = q.tolerance ?? 15;
          const ok   = dist <= tol;
          return { wasCorrect: ok, delta: ok ? Math.round(400 + Math.max(0, 1 - dist / tol) * 600) : 0 };
        }
        case "match": {
          if (!q.pairs?.length || matchPairs.length === 0) return { wasCorrect: false, delta: 0 };
          const correct = matchPairs.filter(mp => {
            const correctRight = q.pairs[mp.leftIdx]?.right;
            const chosenRight  = shuffledRight[mp.rightIdx]?.right;
            return correctRight === chosenRight;
          }).length;
          const total = q.pairs.length;
          const ok    = correct === total;
          return { wasCorrect: ok, delta: Math.round((correct / total) * (400 + speedPct * 600)) };
        }
        case "open": {
          // Graded manually — won't score here (scores applied in handleOpenGradeDone)
          return { wasCorrect: false, delta: 0 };
        }
        default: return { wasCorrect: false, delta: 0 };
      }
    };

    const updated = LOBBY_PLAYERS.map(p => {
      const prev = scores.find(s => s.name === p.name)?.score ?? 0;
      let wasCorrect, delta;
      if (p.name === userName) {
        ({ wasCorrect, delta } = computeUser());
      } else {
        wasCorrect = Math.random() > 0.38;
        delta = wasCorrect ? Math.round(400 + Math.random() * 600) : 0;
      }
      return { ...p, score: prev + delta, delta, wasCorrect };
    });
    updated.sort((a, b) => b.score - a.score);
    setScores(updated);
    // host manually reveals leaderboard via "Reveal Leaderboard" button
  };

  const handleNext = () => {
    if (isFinalQ) {
      if (onGameEnd) onGameEnd({ scores, questions, questionHistory: [] });
      onNav("rankd-results");
      return;
    } else {
      setQIdx(n => n + 1);
      setCdNum(3);
      setPhase("countdown");
    }
  };

  // Admin finishes grading open-ended → compute scores → go to scoreboard
  const handleOpenGradeDone = () => {
    const correctCount = Object.values(openGrades).filter(g => g === "correct").length;
    const updated = LOBBY_PLAYERS.map(p => {
      const prev = scores.find(s => s.name === p.name)?.score ?? 0;
      const wasCorrect = demoMode ? Math.random() > 0.4 : false;
      const delta = wasCorrect ? 500 : 0;
      return { ...p, score: prev + delta, delta, wasCorrect };
    });
    updated.sort((a, b) => b.score - a.score);
    setScores(updated);
    setPhase("scoreboard");
    void correctCount; // used for future real grading
  };

  const doTogglePause = () => {
    const next = !paused;
    setPaused(next);
    broadcast({ type: next ? GM.PAUSE : GM.RESUME });
  };
  const doForceEnd = () => {
    broadcast({ type: GM.FORCE_END, scores });
    setShowEndConfirm(false);
    if (onGameEnd) {
      // onGameEnd sets gameResultsData and navigates to rankd-results
      onGameEnd({ scores, questions, questionHistory: [] });
    } else {
      onNav("rankd-results");
    }
  };

  // ──────────────────────────────────────────────────────────
  // PHASE: COUNTDOWN
  // ──────────────────────────────────────────────────────────
  if (phase === "countdown") {
    const label = qIdx === 0
      ? "Game starting in"
      : `Question ${qIdx + 1} of ${TOTAL} in`;
    // ring: 2π×60 ≈ 376.99
    const CIRC = 376.99;
    // dot position: 3→left, 2→center, 1→right
    const dotPos = cdNum === 3 ? 0 : cdNum === 2 ? 35 : 70;

    return (
      <div style={{
        minHeight: "100%", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        background: C.cream,
      }}>
        <style>{`@keyframes cdRing{from{stroke-dashoffset:${CIRC}}to{stroke-dashoffset:0}}`}</style>

        <p style={{
          margin: "0 0 20px", fontSize: 12, fontWeight: 700, letterSpacing: "0.12em",
          color: C.textMuted, textTransform: "uppercase",
        }}>{label}</p>

        {/* Ring + number */}
        <div key={cdNum} style={{ position: "relative", width: 140, height: 140, flexShrink: 0 }}>
          <svg viewBox="0 0 140 140" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
            {/* Track */}
            <circle cx="70" cy="70" r="60" fill="none" stroke={C.creamBorder} strokeWidth="6" />
            {/* Animated fill */}
            {cdNum > 0 && (
              <circle
                cx="70" cy="70" r="60" fill="none"
                stroke={C.gamePurple} strokeWidth="6"
                strokeDasharray={CIRC}
                strokeDashoffset={CIRC}
                strokeLinecap="round"
                style={{ animation: "cdRing 1s linear forwards" }}
              />
            )}
          </svg>
          {/* Number */}
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{
              fontSize: cdNum === 0 ? 48 : 68, fontWeight: 900, lineHeight: 1,
              color: cdNum === 0 ? C.trueGreen : C.text, userSelect: "none",
              transition: "color 0.2s",
            }}>
              {cdNum === 0 ? "GO!" : cdNum}
            </span>
          </div>
        </div>

        {cdNum > 0 && (
          <p style={{ marginTop: 16, fontSize: 13, color: C.textSub }}>{sessionName}</p>
        )}

        {/* Moving dot indicator */}
        <div style={{ position: "relative", width: 80, height: 16, marginTop: 32, flexShrink: 0 }}>
          <div style={{
            position: "absolute", top: 3, width: 10, height: 10, borderRadius: "50%",
            background: C.gamePurple, opacity: cdNum === 0 ? 0 : 1,
            left: dotPos,
            transition: "left 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s",
          }} />
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────
  // PHASE: OPEN-REVIEW (everyone sees responses; admin grades)
  // ──────────────────────────────────────────────────────────
  if (phase === "open-review") {
    const purple = "#8B5CF6";
    const pad = mobile ? "16px" : "40px";
    return (
      <div style={{
        minHeight: "100%", display: "flex", flexDirection: "column",
        background: C.cream,
      }}>
        {/* Header */}
        <div style={{ padding: `20px ${pad} 16px`, borderBottom: `1px solid ${C.border}`, background: "rgba(255,255,255,0.6)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#7C3AED", letterSpacing: "0.1em" }}>OPEN-ENDED RESPONSES</span>
            </div>
            {/* Admin: toggle showing author names */}
            {role === "admin" && openResponses.length > 0 && (
              <button
                onClick={() => setOpenGrades(g => ({ ...g, __showNames: !g.__showNames }))}
                style={{
                  padding: "4px 10px", borderRadius: 8, border: `1px solid ${purple}44`, cursor: "pointer",
                  background: openGrades.__showNames ? purple + "33" : "transparent",
                  color: openGrades.__showNames ? purple : "rgba(255,255,255,0.4)",
                  fontSize: 11, fontWeight: 700,
                }}
              >{openGrades.__showNames ? "Hide Names" : "Show Names"}</button>
            )}
          </div>
          <p style={{ margin: 0, fontSize: mobile ? 16 : 20, fontWeight: 800, color: C.text }}>{q.text || q.q}</p>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            {openResponses.length} response{openResponses.length !== 1 ? "s" : ""} collected · anonymous to players
          </p>
        </div>

        {/* Responses — visible to everyone */}
        <div style={{ flex: 1, padding: `16px ${pad}`, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          {openResponses.length === 0 && (
            <div style={{ textAlign: "center", padding: 60, color: "rgba(255,255,255,0.3)", fontSize: 14 }}>
              No responses were submitted.
            </div>
          )}
          {openResponses.map((r, i) => {
            const grade = openGrades[i];
            const showAuthor = role === "admin" && openGrades.__showNames;
            return (
              <div key={i} style={{
                padding: mobile ? "12px 14px" : "14px 18px", borderRadius: 14,
                background: grade === "correct" ? "rgba(34,197,94,0.1)" : grade === "incorrect" ? "rgba(239,68,68,0.08)" : C.cardBg,
                border: `1px solid ${grade === "correct" ? "rgba(34,197,94,0.4)" : grade === "incorrect" ? "rgba(239,68,68,0.35)" : C.border}`,
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  {/* Number badge */}
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
                    background: C.muted, display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 700, color: C.textSub, marginTop: 2,
                  }}>{i + 1}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Author name — only visible to admin when toggled */}
                    {showAuthor && (
                      <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 700, color: purple, opacity: 0.9 }}>
                        {r.author}
                      </p>
                    )}
                    <p style={{ margin: 0, fontSize: 14, color: C.text, lineHeight: 1.45 }}>{r.text}</p>
                  </div>
                  {/* Admin grading buttons */}
                  {role === "admin" && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: mobile ? "wrap" : "nowrap" }}>
                      <button onClick={() => setOpenGrades(g => ({ ...g, [i]: g[i] === "correct" ? undefined : "correct" }))} style={{
                        padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
                        background: grade === "correct" ? C.green : "rgba(34,197,94,0.15)",
                        color: grade === "correct" ? "#fff" : C.green, minWidth: 44, minHeight: 36,
                      }}>✓</button>
                      <button onClick={() => setOpenGrades(g => ({ ...g, [i]: g[i] === "incorrect" ? undefined : "incorrect" }))} style={{
                        padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
                        background: grade === "incorrect" ? C.red : "rgba(239,68,68,0.12)",
                        color: grade === "incorrect" ? "#fff" : C.red, minWidth: 44, minHeight: 36,
                      }}>✗</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Admin: continue button */}
          {role === "admin" && (
            <button onClick={handleOpenGradeDone} style={{
              marginTop: 8, padding: "14px", borderRadius: 12, border: "none", cursor: "pointer",
              background: C.orange, color: "#fff", fontSize: 14, fontWeight: 800,
              boxShadow: "0 0 24px rgba(253,191,36,0.35)",
            }}>
              {isFinalQ ? "Finish & See Results →" : "Continue to Next Question →"}
            </button>
          )}

          {/* Player: waiting message */}
          {role !== "admin" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, padding: "10px 14px", borderRadius: 10, background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.25)" }}>
                            <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>Waiting for host to finish grading...</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────
  // PHASE: SCOREBOARD (between questions)
  // ──────────────────────────────────────────────────────────
  if (phase === "scoreboard") {
    const top4       = scores.slice(0, 4);
    const rankBadges = ["1st", "2nd", "3rd", "4th"];

    return (
      <div style={{
        minHeight: "100%", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        background: C.cream, padding: "32px 24px",
      }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textMuted }}>
            After Question {qIdx + 1} of {TOTAL}
          </p>
          <h2 style={{ margin: "0 0 12px", fontSize: 26, fontWeight: 900, color: C.text }}>Leaderboard</h2>
          {!isFinalQ && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 16px", borderRadius: 99,
              background: C.cardBg, border: `1px solid ${remaining === 1 ? "#FCA5A5" : C.creamBorder}`,
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: remaining === 1 ? C.red : C.textSub }}>
                {remaining} question{remaining !== 1 ? "s" : ""} to go
              </span>
            </div>
          )}
        </div>

        {/* Rankings */}
        {(() => {
          const userRankIdx = scores.findIndex(s => s.name === userName);
          const userInTop4  = userRankIdx < 4;
          return (
            <>
              <div style={{ width: "100%", maxWidth: 540, display: "flex", flexDirection: "column", gap: 8, marginBottom: userInTop4 ? 28 : 10 }}>
                {top4.map((p, i) => {
                  const isUser = p.name === userName;
                  return (
                    <div key={p.name} style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderRadius: 14,
                      background: C.cardBg,
                      border: `1.5px solid ${isUser ? C.creamBorder : C.cardBorder}`,
                      boxShadow: isUser ? `0 2px 12px rgba(253,191,36,0.12)` : "0 1px 4px rgba(0,0,0,0.04)",
                    }}>
                      <div style={{ width: 32, textAlign: "center", fontSize: i < 3 ? 20 : 13, fontWeight: 700, color: C.textMuted, flexShrink: 0 }}>
                        {rankBadges[i]}
                      </div>
                      <span style={{ fontSize: 24, flexShrink: 0 }}>{p.emoji}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>{p.name}</p>
                          {isUser && role === "user" && (
                            <span style={{ fontSize: 10, fontWeight: 800, padding: "1px 7px", borderRadius: 99, background: C.orange, color: "#fff" }}>YOU</span>
                          )}
                        </div>
                        <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>{p.score.toLocaleString()} pts total</p>
                      </div>
                      {p.delta > 0 ? (
                        <div style={{ padding: "4px 12px", borderRadius: 99, background: C.trueGreenBg }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: C.trueGreen }}>+{p.delta.toLocaleString()}</span>
                        </div>
                      ) : (
                        <div style={{ padding: "4px 12px", borderRadius: 99, background: "#F3F4F6" }}>
                          <span style={{ fontSize: 12, color: C.textMuted }}>+0</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {!userInTop4 && role === "user" && (() => {
                const u = scores[userRankIdx];
                return (
                  <div style={{ width: "100%", maxWidth: 540, marginBottom: 20 }}>
                    <div style={{ height: 1, background: C.creamBorder, marginBottom: 10 }} />
                    <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", textAlign: "center" }}>Your position</p>
                    <div style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderRadius: 14,
                      background: C.cardBg, border: `1.5px solid ${C.creamBorder}`,
                      boxShadow: "0 2px 12px rgba(253,191,36,0.1)",
                    }}>
                      <div style={{ width: 32, textAlign: "center", fontSize: 13, fontWeight: 700, color: C.orange, flexShrink: 0 }}>
                        #{userRankIdx + 1}
                      </div>
                      <span style={{ fontSize: 24, flexShrink: 0 }}>{u.emoji}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>{u.name}</p>
                          <span style={{ fontSize: 10, fontWeight: 800, padding: "1px 7px", borderRadius: 99, background: C.orange, color: "#fff" }}>YOU</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>{u.score.toLocaleString()} pts total</p>
                      </div>
                      {u.delta > 0 ? (
                        <div style={{ padding: "4px 12px", borderRadius: 99, background: C.trueGreenBg }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: C.trueGreen }}>+{u.delta.toLocaleString()}</span>
                        </div>
                      ) : (
                        <div style={{ padding: "4px 12px", borderRadius: 99, background: "#F3F4F6" }}>
                          <span style={{ fontSize: 12, color: C.textMuted }}>+0</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </>
          );
        })()}

        {/* CTA */}
        {role === "admin" && (
          <button onClick={handleNext} style={{
            padding: "13px 40px", borderRadius: 14, border: "none", cursor: "pointer",
            fontSize: 15, fontWeight: 900, color: "#fff", background: C.orange,
            boxShadow: "0 4px 20px rgba(253,191,36,0.35)",
          }}>
            {isFinalQ ? "End Game & View Results →" : `Next Question (${qIdx + 2} / ${TOTAL}) →`}
          </button>
        )}
        {role === "user" && (
          <p style={{ fontSize: 13, color: C.textSub }}>Waiting for host to continue…</p>
        )}
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────
  // PHASE: QUESTION + REVEAL
  // ──────────────────────────────────────────────────────────
  const isReveal = phase === "reveal";
  const isTF     = q.type === "tf";

  return (
    <div style={{
      minHeight: "100%", display: "flex", flexDirection: "column",
      background: C.cream,
    }}>

      {/* ── Top bar ── */}
      <div style={{
        padding: mobile ? "10px 14px" : "14px 28px", display: "flex", alignItems: "center", gap: mobile ? 10 : 16,
        borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: C.cardBg,
      }}>
        {/* Question badge */}
        <div style={{
          padding: mobile ? "4px 10px" : "5px 14px", borderRadius: 10,
          background: C.cream, border: `1px solid ${C.creamBorder}`,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 12, fontWeight: 900, color: C.text }}>Q{qIdx + 1}</span>
          <span style={{ fontSize: 12, color: C.textMuted }}> / {TOTAL}</span>
        </div>

        {/* Progress track */}
        <div style={{ flex: 1, display: "flex", gap: 3 }}>
          {GAME_QUESTIONS.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: 5, borderRadius: 99, transition: "background 0.4s",
              background: i < qIdx ? C.trueGreen : i === qIdx ? C.orange : "#E5E7EB",
            }} />
          ))}
        </div>

        {/* "X to go" — hide on mobile to save space */}
        {remaining > 0 && !mobile && (
          <span style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, flexShrink: 0, whiteSpace: "nowrap" }}>
            {remaining} to go
          </span>
        )}

        {/* Timer circle */}
        {!isReveal ? (
          <div style={{
            width: mobile ? 40 : 46, height: mobile ? 40 : 46, borderRadius: "50%", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            border: `3px solid ${timerColor}`,
            background: `${timerColor}14`,
            boxShadow: timeLeft <= 5 ? `0 0 20px ${timerColor}66` : "none",
            transition: "border-color 0.5s, background 0.5s, box-shadow 0.5s",
          }}>
            <span style={{ fontSize: mobile ? 14 : 16, fontWeight: 900, color: timerColor }}>{timeLeft}</span>
          </div>
        ) : (
          <div style={{
            padding: mobile ? "4px 10px" : "6px 16px", borderRadius: 10, flexShrink: 0,
            background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)",
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.green }}>✓ Time's up</span>
          </div>
        )}

        {/* Host controls — admin only */}
        {role === "admin" && (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button onClick={doTogglePause} title={paused ? "Resume" : "Pause"} style={{ width: 36, height: 36, borderRadius: "50%", border: `1px solid ${C.border}`, background: paused ? C.orange : C.cardBg, color: paused ? "#fff" : C.text, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{paused ? "▶" : "⏸"}</button>
            <button onClick={() => setShowEndConfirm(true)} title="End game" style={{ width: 36, height: 36, borderRadius: "50%", border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.07)", color: "#ef4444", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>■</button>
          </div>
        )}
      </div>

      {/* End confirm modal */}
      {showEndConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ background: C.cardBg, border: `1px solid ${C.creamBorder}`, borderRadius: 20, padding: "32px 40px", textAlign: "center", maxWidth: 340 }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 900, color: C.text }}>End game now?</h2>
            <p style={{ margin: "0 0 24px", fontSize: 14, color: C.textSub }}>Current scores will be shown as the final leaderboard.</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowEndConfirm(false)} style={{ flex: 1, padding: "11px", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.text, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
              <button onClick={doForceEnd} style={{ flex: 1, padding: "11px", borderRadius: 12, border: "none", background: "#ef4444", color: "#fff", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>End Game</button>
            </div>
          </div>
        </div>
      )}

      {/* Paused overlay */}
      {paused && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)", pointerEvents: "none" }}>
          <div style={{ fontSize: 52, marginBottom: 12 }}>⏸</div>
          <p style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#fff" }}>Game Paused</p>
        </div>
      )}

      {/* Timer bar */}
      {!isReveal && (
        <div style={{ height: 3, background: C.border, flexShrink: 0 }}>
          <div style={{
            height: "100%", background: timerColor, transition: "width 0.95s linear, background 0.5s",
            width: `${timerPct}%`,
          }} />
        </div>
      )}

      {/* ── Question ── */}
      <div style={{ padding: mobile ? "16px 14px 10px" : "28px 40px 16px", textAlign: "center", flexShrink: 0 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8, padding: "4px 12px", borderRadius: 99, marginBottom: 10,
          background: "rgba(255,255,255,0.7)", border: `1px solid ${C.border}`,
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {Q_TYPE_LABELS[q.type] ?? "Question"} · {q.timeLimit}s
          </span>
        </div>
        <h2 style={{
          margin: 0, fontSize: mobile ? 17 : 22, fontWeight: 900, color: C.text,
          lineHeight: 1.4, maxWidth: 680, marginLeft: "auto", marginRight: "auto",
        }}>{q.q}</h2>
      </div>

      {/* ── Answer options (type-aware) ── */}
      {(q.type === "mc" || q.type === "tf") && (() => {
        const isLocked = selectedIdx !== null;
        return (
          <div style={{
            flex: 1, padding: mobile ? "8px 12px 12px" : "12px 40px 16px",
            display: "grid",
            gridTemplateColumns: mobile && !isTF ? "1fr" : "1fr 1fr",
            gridTemplateRows: isTF ? "1fr" : (mobile ? "auto" : "1fr 1fr"),
            gap: mobile ? 8 : 12, maxWidth: 820, margin: "0 auto", width: "100%", boxSizing: "border-box",
          }}>
            {q.options.map((opt, i) => {
              const oc        = OPTION_COLORS[i];
              const isCorrect = i === q.correct;
              const isSel     = i === selectedIdx;
              const isUserLock = role === "user" && isSel && !isReveal;

              let borderColor = oc.bg, bgColor = `${oc.bg}18`, opacity = 1, glow = "none";
              if (isReveal) {
                if (isCorrect)    { borderColor = C.green; bgColor = "rgba(16,185,129,0.15)"; glow = "0 0 32px rgba(16,185,129,0.3)"; }
                else if (isSel)   { borderColor = C.red;   bgColor = "rgba(239,68,68,0.13)"; }
                else              { opacity = 0.28; }
              } else if (isSel && role === "user") {
                borderColor = oc.bg; bgColor = `${oc.bg}30`; glow = `0 0 24px ${oc.glow}`;
              } else if (isLocked && role === "user" && !isSel) {
                opacity = 0.45;
              }

              return (
                <button key={i} onClick={() => {
                  if (!isReveal && role === "user" && selectedIdx === null) {
                    setSelectedIdx(i); setLockedAtTime(timeLeft);
                  }
                }} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: mobile ? "12px 14px" : (isTF ? "20px 28px" : "16px 20px"),
                  borderRadius: 14, border: `2px solid ${borderColor}`,
                  background: isReveal && !isCorrect && !isSel ? "rgba(255,252,240,0.7)" : (isReveal && isCorrect ? bgColor : C.cardBg), cursor: (!isReveal && !isLocked && role === "user") ? "pointer" : "default",
                  textAlign: "left", opacity, boxShadow: glow, transition: "all 0.25s",
                  minHeight: 52,
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: (isReveal && isCorrect) ? C.green : (isReveal && isSel) ? C.red : oc.bg,
                    fontSize: 13, fontWeight: 900, color: "#fff", transition: "background 0.3s",
                  }}>
                    {isReveal ? (isCorrect ? "✓" : isSel ? "✗" : String.fromCharCode(65+i)) : (isUserLock ? "✓" : String.fromCharCode(65+i))}
                  </div>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: mobile ? 13 : (isTF ? 17 : 14), fontWeight: 600, color: isReveal && isCorrect ? "#059669" : C.text, lineHeight: 1.4 }}>{opt}</span>
                    {isUserLock && <p style={{ margin: "4px 0 0", fontSize: 10, fontWeight: 700, color: oc.bg, letterSpacing: "0.08em" }}>LOCKED IN ✓</p>}
                  </div>
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* ── Type Answer ── */}
      {q.type === "type" && (
        <div style={{ flex: 1, padding: mobile ? "16px" : "20px 60px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, maxWidth: 680, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
          <input
            value={typedAnswer}
            onChange={e => !typeSubmitted && !isReveal && setTypedAnswer(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && typedAnswer.trim() && !typeSubmitted && role === "user") {
                setTypeSubmitted(true); setLockedAtTime(timeLeft);
              }
            }}
            placeholder="Type your answer…"
            disabled={typeSubmitted || isReveal || role === "admin"}
            style={{
              width: "100%", textAlign: "center", fontSize: 20, fontWeight: 700, boxSizing: "border-box",
              borderRadius: 16, padding: "18px 24px",
              background: typeSubmitted ? "rgba(16,185,129,0.08)" : C.cardBg,
              color: C.text, border: `2px solid ${typeSubmitted ? "rgba(16,185,129,0.5)" : typedAnswer ? C.orange : C.border}`,
              outline: "none", fontFamily: "inherit",
            }}
          />
          {isReveal && (
            <div style={{ padding: "12px 24px", borderRadius: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}>
              <p style={{ margin: 0, fontSize: 12, color: C.textMuted, textAlign: "center" }}>
                Accepted: {(q.acceptedAnswers ?? []).join(" / ")}
              </p>
            </div>
          )}
          {!typeSubmitted && !isReveal && role === "user" && (
            <button onClick={() => { if (typedAnswer.trim()) { setTypeSubmitted(true); setLockedAtTime(timeLeft); } }} style={{
              padding: "12px 40px", borderRadius: 14, border: "none", cursor: typedAnswer.trim() ? "pointer" : "not-allowed",
              fontSize: 14, fontWeight: 900, background: typedAnswer.trim() ? C.orange : "rgba(255,255,255,0.1)",
              color: typedAnswer.trim() ? "#fff" : "rgba(255,255,255,0.3)",
            }}>Submit Answer →</button>
          )}
          {typeSubmitted && !isReveal && (
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.green }}>✓ Answer locked — waiting for reveal…</p>
          )}
        </div>
      )}

      {/* ── Open Ended ── */}
      {q.type === "open" && (
        <div style={{ flex: 1, padding: mobile ? "16px" : "20px 60px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, maxWidth: 680, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
          {role === "user" ? (
            <>
              <textarea
                value={typedAnswer}
                onChange={e => !openSubmitted && setTypedAnswer(e.target.value)}
                placeholder="Type your response here…"
                disabled={openSubmitted}
                rows={4}
                style={{
                  width: "100%", fontSize: 15, fontWeight: 500, boxSizing: "border-box",
                  borderRadius: 16, padding: "16px 20px", resize: "none",
                  background: openSubmitted ? "rgba(139,92,246,0.08)" : C.cardBg,
                  color: C.text, border: `2px solid ${openSubmitted ? "rgba(139,92,246,0.5)" : typedAnswer ? "#8B5CF6" : C.border}`,
                  outline: "none", fontFamily: "inherit", lineHeight: 1.5,
                }}
              />
              {!openSubmitted ? (
                <button onClick={() => { if (typedAnswer.trim()) { setOpenSubmitted(true); setLockedAtTime(timeLeft); } }} style={{
                  padding: "12px 40px", borderRadius: 14, border: "none", cursor: typedAnswer.trim() ? "pointer" : "not-allowed",
                  fontSize: 14, fontWeight: 900, background: typedAnswer.trim() ? "#8B5CF6" : "rgba(255,255,255,0.1)",
                  color: typedAnswer.trim() ? "#fff" : "rgba(255,255,255,0.3)",
                }}>Submit Response →</button>
              ) : (
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#8B5CF6" }}>✓ Response submitted — waiting for host to review…</p>
              )}
            </>
          ) : (
            <div style={{ textAlign: "center" }}>
              
              <p style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: C.text }}>Collecting open-ended responses</p>
              <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>
                {answeredCount} of {LOBBY_PLAYERS.length} responded · Timer will reveal all responses
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Slider Scale ── */}
      {q.type === "slider" && (
        <div style={{ flex: 1, padding: "20px 60px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, maxWidth: 700, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
          <div style={{ fontSize: 48, fontWeight: 900, color: isReveal ? (Math.abs(sliderValue - (q.correct ?? 5)) <= (q.tolerance ?? 1) ? C.green : C.red) : C.orange }}>
            {sliderValue}
          </div>
          <div style={{ width: "100%", position: "relative" }}>
            {/* Track */}
            <div style={{ position: "relative", height: 8, borderRadius: 99, background: "rgba(255,255,255,0.15)", marginBottom: 8 }}>
              <div style={{
                position: "absolute", left: 0, top: 0, height: "100%", borderRadius: 99,
                background: sliderSubmitted ? C.orange : "rgba(253,191,36,0.5)",
                width: `${((sliderValue - (q.min ?? 0)) / ((q.max ?? 10) - (q.min ?? 0))) * 100}%`,
              }} />
              {/* Correct marker (on reveal) */}
              {isReveal && (
                <div style={{
                  position: "absolute", top: "50%", transform: "translateY(-50%)",
                  left: `${((q.correct ?? 5) - (q.min ?? 0)) / ((q.max ?? 10) - (q.min ?? 0)) * 100}%`,
                  width: 16, height: 16, borderRadius: "50%", background: C.green,
                  border: "3px solid #fff", marginLeft: -8,
                }} />
              )}
            </div>
            <input
              type="range" min={q.min ?? 0} max={q.max ?? 10} step={1}
              value={sliderValue}
              disabled={sliderSubmitted || isReveal || role === "admin"}
              onChange={e => !sliderSubmitted && !isReveal && setSliderValue(Number(e.target.value))}
              style={{ width: "100%", accentColor: C.orange, cursor: sliderSubmitted ? "default" : "pointer" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
              <span>{q.minLabel || (q.min ?? 0)}</span>
              {isReveal && <span style={{ color: C.green, fontWeight: 700 }}>✓ {q.correct}</span>}
              <span>{q.maxLabel || (q.max ?? 10)}</span>
            </div>
          </div>
          {!sliderSubmitted && !isReveal && role === "user" && (
            <button onClick={() => { setSliderSubmitted(true); setLockedAtTime(timeLeft); }} style={{
              padding: "12px 40px", borderRadius: 14, border: "none", cursor: "pointer",
              fontSize: 14, fontWeight: 900, background: C.orange, color: "#fff",
            }}>Lock In {sliderValue} →</button>
          )}
          {sliderSubmitted && !isReveal && (
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.green }}>✓ {sliderValue} locked — waiting for reveal…</p>
          )}
        </div>
      )}

      {/* ── Pin Answer ── */}
      {q.type === "pin" && (
        <div style={{ flex: 1, padding: "16px 40px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, maxWidth: 680, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
          <div
            onClick={e => {
              if (pinSubmitted || isReveal || role === "admin") return;
              const rect = e.currentTarget.getBoundingClientRect();
              const x = Math.round(((e.clientX - rect.left) / rect.width) * 100);
              const y = Math.round(((e.clientY - rect.top) / rect.height) * 100);
              setPinPoint({ x, y });
            }}
            style={{
              position: "relative", width: "100%", height: 220, borderRadius: 16,
              cursor: (pinSubmitted || isReveal || role === "admin") ? "default" : "crosshair",
              background: q.imageUrl
                ? `url(${q.imageUrl}) center/cover no-repeat`
                : `linear-gradient(135deg, rgba(27,45,82,0.8), rgba(22,40,68,0.9))`,
              border: "2px solid rgba(255,255,255,0.1)", overflow: "hidden",
            }}
          >
            {/* Grid lines */}
            {[33,66].map(p => <div key={`v${p}`} style={{ position:"absolute", left:`${p}%`, top:0, bottom:0, width:1, background:"rgba(255,255,255,0.1)" }} />)}
            {[33,66].map(p => <div key={`h${p}`} style={{ position:"absolute", top:`${p}%`, left:0, right:0, height:1, background:"rgba(255,255,255,0.1)" }} />)}

            {!q.imageUrl && !pinPoint && (
              <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
                <span style={{ fontSize:32 }}>●</span>
                <p style={{ margin:0, fontSize:13, color:"rgba(255,255,255,0.4)", fontWeight:600 }}>Click to place your pin</p>
              </div>
            )}

            {/* User's pin */}
            {pinPoint && (
              <div style={{ position:"absolute", left:`${pinPoint.x}%`, top:`${pinPoint.y}%`, transform:"translate(-50%,-100%)", fontSize:28, pointerEvents:"none" }}>
                ●
              </div>
            )}

            {/* Correct zone on reveal */}
            {isReveal && q.correctX !== undefined && (
              <>
                <div style={{
                  position:"absolute", left:`${q.correctX}%`, top:`${q.correctY}%`,
                  transform:"translate(-50%,-50%)",
                  width: (q.tolerance ?? 15) * 2 + "%",
                  height: (q.tolerance ?? 15) * 2 * (220/680) + "%",
                  borderRadius:"50%", background:"rgba(16,185,129,0.25)", border:"2px solid rgba(16,185,129,0.6)",
                  pointerEvents:"none",
                }} />
                <div style={{ position:"absolute", left:`${q.correctX}%`, top:`${q.correctY}%`, transform:"translate(-50%,-100%)", fontSize:28, filter:"hue-rotate(100deg)", pointerEvents:"none" }}>
                  ●
                </div>
              </>
            )}
          </div>

          {!pinSubmitted && !isReveal && role === "user" && (
            <button onClick={() => { if (pinPoint) { setPinSubmitted(true); setLockedAtTime(timeLeft); } }} style={{
              padding: "10px 32px", borderRadius: 12, border: "none", cursor: pinPoint ? "pointer" : "not-allowed",
              fontSize: 13, fontWeight: 900, background: pinPoint ? C.orange : "rgba(255,255,255,0.1)",
              color: pinPoint ? "#fff" : "rgba(255,255,255,0.3)",
            }}>{pinPoint ? "Confirm Pin →" : "Click the image to place pin"}</button>
          )}
          {pinSubmitted && !isReveal && (
            <p style={{ margin:0, fontSize:13, fontWeight:700, color:C.green }}>✓ Pin placed — waiting for reveal…</p>
          )}
        </div>
      )}

      {/* ── Matching ── */}
      {q.type === "match" && (() => {
        const PAIR_COLORS = ["#7C3AED","#0284C7","#059669","#DC2626","#D97706","#EC4899"];
        const allMatched  = q.pairs && matchPairs.length >= q.pairs.length;
        const autoLock    = allMatched && !isReveal;

        const getPairForLeft  = (li) => matchPairs.find(mp => mp.leftIdx === li);
        const getPairForRight = (ri) => matchPairs.find(mp => mp.rightIdx === ri);

        const handleLeftClick  = (li) => {
          if (allMatched || isReveal || role === "admin") return;
          setMatchSelLeft(li === matchSelLeft ? null : li);
        };
        const handleRightClick = (ri) => {
          if (allMatched || isReveal || role === "admin" || matchSelLeft === null) return;
          if (getPairForRight(ri)) return; // already matched
          const newPairs = [...matchPairs.filter(mp => mp.leftIdx !== matchSelLeft), { leftIdx: matchSelLeft, rightIdx: ri }];
          setMatchPairs(newPairs);
          setMatchSelLeft(null);
          if (newPairs.length >= (q.pairs?.length ?? 0) && !lockedAtTime) setLockedAtTime(timeLeft);
        };

        return (
          <div style={{ flex:1, padding:"12px 32px 16px", display:"flex", gap:16, maxWidth:820, margin:"0 auto", width:"100%", boxSizing:"border-box", alignItems:"stretch" }}>
            {/* Left: prompts */}
            <div style={{ flex:1, display:"flex", flexDirection:"column", gap:8 }}>
              <p style={{ margin:"0 0 6px", fontSize:10, fontWeight:700, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:"0.1em" }}>Prompts</p>
              {(q.pairs ?? []).map((pair, li) => {
                const pairInfo  = getPairForLeft(li);
                const pairColor = pairInfo !== undefined ? PAIR_COLORS[li % PAIR_COLORS.length] : null;
                const isSelLeft = matchSelLeft === li;
                const isRevealCorrect = isReveal && pairInfo && shuffledRight[pairInfo.rightIdx]?.right === pair.right;
                const isRevealWrong   = isReveal && pairInfo && shuffledRight[pairInfo.rightIdx]?.right !== pair.right;
                return (
                  <div key={li} onClick={() => !pairInfo && handleLeftClick(li)} style={{
                    flex:1, padding:"12px 16px", borderRadius:12, cursor: pairInfo ? "default" : "pointer",
                    border: `2px solid ${isReveal ? (isRevealCorrect ? C.green : isRevealWrong ? C.red : "rgba(255,255,255,0.1)") : isSelLeft ? C.orange : pairColor || "rgba(255,255,255,0.1)"}`,
                    background: isReveal ? (isRevealCorrect ? "rgba(16,185,129,0.15)" : isRevealWrong ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.04)") : isSelLeft ? "rgba(253,191,36,0.15)" : pairColor ? `${pairColor}18` : "rgba(255,255,255,0.04)",
                    display:"flex", alignItems:"center", gap:10, transition:"all 0.2s",
                    boxShadow: isSelLeft ? "0 0 20px rgba(253,191,36,0.25)" : "none",
                  }}>
                    <div style={{
                      width:24, height:24, borderRadius:8, flexShrink:0, fontSize:11, fontWeight:900,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      background: isReveal ? (isRevealCorrect ? C.green : isRevealWrong ? C.red : "rgba(255,255,255,0.1)") : pairColor || "rgba(255,255,255,0.15)",
                      color:"#fff",
                    }}>{isSelLeft ? "●" : pairInfo !== undefined ? String.fromCharCode(65+li) : String.fromCharCode(65+li)}</div>
                    <span style={{ fontSize:13, fontWeight:600, color:"#fff" }}>{pair.left}</span>
                  </div>
                );
              })}
            </div>

            {/* Right: answers (shuffled) */}
            <div style={{ flex:1, display:"flex", flexDirection:"column", gap:8 }}>
              <p style={{ margin:"0 0 6px", fontSize:10, fontWeight:700, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:"0.1em" }}>Matches</p>
              {(shuffledRight.length ? shuffledRight : q.pairs ?? []).map((pair, ri) => {
                const pairInfo  = getPairForRight(ri);
                const pairColor = pairInfo !== undefined ? PAIR_COLORS[pairInfo.leftIdx % PAIR_COLORS.length] : null;
                const isRevealCorrect = isReveal && pairInfo && pair.right === (q.pairs ?? [])[pairInfo.leftIdx]?.right;
                const isRevealWrong   = isReveal && pairInfo && pair.right !== (q.pairs ?? [])[pairInfo.leftIdx]?.right;
                const canClick = role === "user" && !isReveal && !pairInfo && matchSelLeft !== null && !allMatched;
                return (
                  <div key={ri} onClick={() => canClick && handleRightClick(ri)} style={{
                    flex:1, padding:"12px 16px", borderRadius:12, cursor: canClick ? "pointer" : "default",
                    border: `2px solid ${isReveal ? (isRevealCorrect ? C.green : isRevealWrong ? C.red : "rgba(255,255,255,0.1)") : pairColor || (canClick ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)")}`,
                    background: isReveal ? (isRevealCorrect ? "rgba(16,185,129,0.15)" : isRevealWrong ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.04)") : pairColor ? `${pairColor}18` : "rgba(255,255,255,0.04)",
                    display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, transition:"all 0.2s",
                  }}>
                    <span style={{ fontSize:13, fontWeight:600, color:"#fff" }}>{pair.right}</span>
                    {isReveal && isRevealCorrect && <span style={{ fontSize:14, color:C.green }}>✓</span>}
                    {isReveal && isRevealWrong   && <span style={{ fontSize:14, color:C.red   }}>✗</span>}
                    {pairColor && !isReveal && <div style={{ width:8, height:8, borderRadius:"50%", background:pairColor, flexShrink:0 }} />}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── User result banner ── */}
      {role === "user" && isReveal && (() => {
        // Compute correctness for result banner
        let wasCorrect = false, pts = 0, detail = "";
        const speedPct = lockedAtTime !== null ? lockedAtTime / q.timeLimit : 0;
        const noAnswer = (q.type === "mc" || q.type === "tf") ? selectedIdx === null
          : q.type === "type" ? !typeSubmitted
          : q.type === "open" ? !openSubmitted
          : q.type === "slider" ? !sliderSubmitted
          : q.type === "pin" ? !pinSubmitted
          : matchPairs.length === 0;

        if (!noAnswer) {
          if (q.type === "mc" || q.type === "tf") {
            wasCorrect = selectedIdx === q.correct;
            pts = wasCorrect ? Math.round(400 + speedPct * 600) : 0;
            if (!wasCorrect) detail = `Correct: ${String.fromCharCode(65 + q.correct)} — ${q.options[q.correct]}`;
          } else if (q.type === "type") {
            wasCorrect = (q.acceptedAnswers ?? []).some(a => a.trim().toLowerCase() === typedAnswer.trim().toLowerCase());
            pts = wasCorrect ? Math.round(400 + speedPct * 600) : 0;
            if (!wasCorrect) detail = `Accepted: ${(q.acceptedAnswers ?? []).join(" / ")}`;
          } else if (q.type === "slider") {
            const diff = Math.abs(sliderValue - (q.correct ?? 5));
            wasCorrect = diff <= (q.tolerance ?? 1);
            pts = wasCorrect ? Math.round(400 + Math.max(0, 1 - diff / (q.tolerance ?? 1)) * 600) : 0;
            if (!wasCorrect) detail = `Correct: ${q.correct} (±${q.tolerance ?? 1})`;
          } else if (q.type === "pin") {
            if (pinPoint && q.correctX !== undefined) {
              const dist = Math.sqrt(Math.pow(pinPoint.x - q.correctX, 2) + Math.pow(pinPoint.y - q.correctY, 2));
              wasCorrect = dist <= (q.tolerance ?? 15);
              pts = wasCorrect ? Math.round(400 + speedPct * 600) : 0;
            }
            if (!wasCorrect) detail = "Pin not in the correct zone";
          } else if (q.type === "match") {
            const correct = matchPairs.filter(mp => shuffledRight[mp.rightIdx]?.right === (q.pairs ?? [])[mp.leftIdx]?.right).length;
            wasCorrect = correct === (q.pairs?.length ?? 0);
            pts = Math.round((correct / (q.pairs?.length ?? 1)) * (400 + speedPct * 600));
            if (!wasCorrect) detail = `${correct}/${q.pairs?.length ?? 0} pairs correct`;
          }
        }

        return (
          <div style={{
            padding: "14px 28px", flexShrink: 0,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            background: noAnswer ? "rgba(255,255,255,0.04)" : wasCorrect ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.1)",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 20,
          }}>
            {noAnswer ? (
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "rgba(255,255,255,0.45)" }}>Time's up — no answer</p>
            ) : wasCorrect ? (
              <>
                <div>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 900, color: C.green }}>Correct!</p>
                  {lockedAtTime !== null && <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>Speed bonus: {lockedAtTime}s left</p>}
                </div>
                <div style={{ padding: "6px 18px", borderRadius: 99, background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.35)", marginLeft: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 900, color: C.green }}>+{pts} pts</span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 900, color: C.red }}>{pts > 0 ? "Partial credit" : "Incorrect"}</p>
                  {detail && <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>{detail}</p>}
                </div>
                <div style={{ padding: "6px 18px", borderRadius: 99, background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)" }}>
                  <span style={{ fontSize: 16, fontWeight: 900, color: pts > 0 ? C.orange : C.red }}>+{pts} pts</span>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ── User: waiting for leaderboard after reveal ── */}
      {role === "user" && isReveal && (
        <div style={{ padding: "10px 28px", flexShrink: 0, borderTop: `1px solid ${C.creamBorder}`, background: C.cardBg, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {[0,0.2,0.4].map((d,i) => <div key={i} style={{ width:5,height:5,borderRadius:"50%",background:C.orange,animation:`lobbyPulse 1.4s ease-in-out ${d}s infinite` }} />)}
          </div>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: C.textSub }}>Waiting for host to reveal leaderboard…</p>
        </div>
      )}

      {/* ── User waiting message during question ── */}
      {role === "user" && !isReveal && (() => {
        const hasAnswered = (q.type === "mc" || q.type === "tf") ? selectedIdx !== null
          : q.type === "type" ? typeSubmitted
          : q.type === "open" ? openSubmitted
          : q.type === "slider" ? sliderSubmitted
          : q.type === "pin" ? pinSubmitted
          : matchPairs.length >= (q.pairs?.length ?? 999);
        if (!hasAnswered) return null;
        return (
          <div style={{
            padding: "12px 28px", flexShrink: 0,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            background: "rgba(0,0,0,0.15)",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          }}>
            <div style={{ display: "flex", gap: 5 }}>
              {[0, 0.2, 0.4].map((delay, i) => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: "50%", background: C.orange,
                  animation: `lobbyPulse 1.4s ease-in-out ${delay}s infinite`,
                }} />
              ))}
            </div>
            <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.4)" }}>
              Answer locked — waiting for others…
            </p>
          </div>
        );
      })()}

      {/* ── Admin bottom bar ── */}
      {role === "admin" && (
        <div style={{
          padding: mobile ? "10px 14px" : "12px 28px", flexShrink: 0,
          borderTop: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(0,0,0,0.25)",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          {/* Answered progress */}
          {!mobile && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 100, height: 5, borderRadius: 99, overflow: "hidden", background: "rgba(255,255,255,0.08)" }}>
                <div style={{
                  height: "100%", borderRadius: 99, background: C.green,
                  width: `${(answeredCount / LOBBY_PLAYERS.length) * 100}%`,
                  transition: "width 0.4s",
                }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.4)", whiteSpace: "nowrap" }}>
                {answeredCount} / {LOBBY_PLAYERS.length} answered
              </span>
            </div>
          )}
          {mobile && <span style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>{answeredCount}/{LOBBY_PLAYERS.length} answered</span>}

          <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            {/* Skip timer (only during question) */}
            {!isReveal && (
              <button onClick={doReveal} style={{
                padding: mobile ? "10px 16px" : "8px 18px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 700,
                background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.4)",
                border: "1px solid rgba(255,255,255,0.1)", minHeight: 40,
              }}>
                {q.type === "open" ? "End responses" : "Skip timer"}
              </button>
            )}
            {/* Reveal leaderboard (after reveal) — not shown for open-ended (handled in open-review phase) */}
            {isReveal && q.type !== "open" && (
              <button onClick={() => setPhase("scoreboard")} style={{
                padding: mobile ? "10px 20px" : "8px 24px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 900,
                background: C.orange, color: "#fff", border: "none", minHeight: 40,
              }}>
                Reveal Leaderboard
              </button>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes popIn {
          from { transform: scale(0.85); opacity: 0; }
          to   { transform: scale(1);    opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ── SESSION DETAIL VIEW ──────────────────────────────────────

// Topic → lesson IDs mapping for recommendations. Production: drive from tags/taxonomy API.
const TOPIC_LESSON_MAP = {
  "Objection Handling": ["ll2", "ll4"],
  "Negotiation":        ["ll2"],
  "Discovery":          ["ll3"],
  "Pipeline":           ["ll5", "ll8"],
  "Forecasting":        ["ll8"],
  "Prospecting":        ["ll1"],
  "Competitive":        ["ll6"],
  "Executive Outreach": ["ll7"],
};

// Topic → quiz title keywords for recommendations
const TOPIC_QUIZ_MAP = {
  "Objection Handling": ["Objection"],
  "Discovery":          ["Discovery","SDR"],
  "Pipeline":           ["Pipeline","Forecasting"],
  "Negotiation":        ["Objection","Value"],
  "Forecasting":        ["Pipeline","Forecasting"],
};

function SessionDetailView({ session, onBack }) {
  const [tab, setTab] = useState("overview");

  const qs = session.questions ?? [];
  const correctQs  = qs.filter(q => q.isCorrect);
  const incorrectQs = qs.filter(q => !q.isCorrect);

  // Per-topic accuracy
  const topicMap = {};
  qs.forEach(q => {
    if (!topicMap[q.topic]) topicMap[q.topic] = { correct: 0, total: 0 };
    topicMap[q.topic].total++;
    if (q.isCorrect) topicMap[q.topic].correct++;
  });
  const topics = Object.entries(topicMap).map(([name, { correct, total }]) => ({
    name, correct, total, pct: Math.round((correct / Math.max(total, 1)) * 100),
  })).sort((a, b) => b.pct - a.pct);
  const strongTopics = topics.filter(t => t.pct >= 80);
  const weakTopics   = topics.filter(t => t.pct < 70);
  const hardestQ     = [...qs].sort((a, b) => (a.isCorrect ? 1 : 0) - (b.isCorrect ? 1 : 0)
    || b.responseMs - a.responseMs)[0];

  // Speed vs accuracy
  const fastCorrect  = qs.filter(q => q.isCorrect  && q.responseMs < session.avgResponseMs);
  const slowIncorrect= qs.filter(q => !q.isCorrect && q.responseMs > session.avgResponseMs);

  // Recommendations — lessons + quizzes from weak topics
  const recLessonIds = [...new Set(weakTopics.flatMap(t => TOPIC_LESSON_MAP[t.name] ?? []))];
  const recLessons   = recLessonIds.map(id => INITIAL_LEARN_LESSONS.find(l => l.id === id)).filter(Boolean);

  const allQuizzes = (typeof USER_QUIZ_ASSIGNMENTS_SEED !== "undefined") ? USER_QUIZ_ASSIGNMENTS_SEED : [];
  const recQuizzes = allQuizzes.filter(qz =>
    weakTopics.some(t => (TOPIC_QUIZ_MAP[t.name] ?? []).some(kw => qz.title.toLowerCase().includes(kw.toLowerCase())))
  ).slice(0, 3);

  const scoreColor = session.scorePercent >= 85 ? C.green : session.scorePercent >= 70 ? C.orange : C.red;

  const TABS = [
    { id: "overview",     label: "Overview" },
    { id: "answers",      label: "Answer Review" },
    { id: "performance",  label: "Performance" },
    { id: "recs",         label: "Recommendations" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Back */}
      <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.textSub, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, padding: 0, alignSelf: "flex-start" }}>
        ← Back to My Scores
      </button>

      {/* Header card */}
      <div style={{ background: C.white, borderRadius: 14, padding: 24, border: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: C.text }}>{session.sessionName}</h2>
            <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>{session.date} · {qs.length} questions · {session.totalPlayers} players</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ textAlign: "center", padding: "8px 16px", borderRadius: 10, background: scoreColor + "14", border: `1px solid ${scoreColor}30` }}>
              <div style={{ fontSize: 28, fontWeight: 900, color: scoreColor, lineHeight: 1 }}>{session.scorePercent}%</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: scoreColor, letterSpacing: "0.06em" }}>SCORE</div>
            </div>
            <div style={{ textAlign: "center", padding: "8px 16px", borderRadius: 10, background: session.rank === 1 ? C.orangeLight : C.muted }}>
              <div style={{ fontSize: 28, fontWeight: 900, color: session.rank === 1 ? C.orange : C.text, lineHeight: 1 }}>#{session.rank}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em" }}>RANK</div>
            </div>
          </div>
        </div>
        {/* Stat row */}
        <div style={{ display: "flex", gap: 24, marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
          {[
            { label: "Accuracy",          value: `${session.accuracy}%`,                  color: session.accuracy >= 80 ? C.green : session.accuracy >= 60 ? C.orange : C.red },
            { label: "Correct",           value: `${correctQs.length} / ${qs.length}`,    color: C.text },
            { label: "Avg Response Time", value: `${(session.avgResponseMs / 1000).toFixed(1)}s`, color: C.text },
            { label: "Points Earned",     value: session.scoreRaw.toLocaleString(),        color: C.orange },
          ].map(s => (
            <div key={s.label}>
              <div style={{ fontSize: 16, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: C.textSub }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "10px 16px", border: "none", cursor: "pointer", background: "transparent",
            fontWeight: tab === t.id ? 700 : 500, color: tab === t.id ? C.orange : C.textSub,
            borderBottom: `2px solid ${tab === t.id ? C.orange : "transparent"}`,
            fontSize: 13, marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Mini stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
            {[
              { label: "Best Topic",   value: strongTopics[0]?.name ?? "—", sub: strongTopics[0] ? `${strongTopics[0].pct}% accuracy` : "No strong topics", color: C.green  },
              { label: "Needs Work",   value: weakTopics[0]?.name   ?? "—", sub: weakTopics[0]   ? `${weakTopics[0].pct}% accuracy`  : "All topics strong",  color: C.orange },
              { label: "Fastest Answer", value: `${((qs.reduce((a,b)=>a.responseMs<b.responseMs?a:b, qs[0])?.responseMs??0)/1000).toFixed(1)}s`, sub: qs.reduce((a,b)=>a.responseMs<b.responseMs?a:b, qs[0])?.text?.slice(0,28)+"…" ?? "—", color: C.blue },
              { label: "XP Earned",    value: `+${qs.reduce((s,q)=>s+(q.pointsEarned??0),0).toLocaleString()}`, sub: "from this session", color: C.orange },
            ].map(m => (
              <div key={m.label} style={{ borderRadius: 12, padding: "14px 16px", background: C.white, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: m.color, marginBottom: 4 }}>{m.value}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 2 }}>{m.label}</div>
                <div style={{ fontSize: 10, color: C.textSub }}>{m.sub}</div>
              </div>
            ))}
          </div>
          {/* Question-by-question summary table */}
          <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
            <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}`, background: "#FFF7ED" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Question Summary</span>
            </div>
            {qs.map((q, i) => (
              <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderBottom: i < qs.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, width: 20, flexShrink: 0 }}>Q{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text || q.q}</div>
                  <div style={{ fontSize: 10, color: C.textSub, marginTop: 1 }}>{q.topic}</div>
                </div>
                <span style={{ fontSize: 11, color: C.textSub, flexShrink: 0 }}>{(q.responseMs / 1000).toFixed(1)}s</span>
                <span style={{ fontSize: 11, fontWeight: 700, flexShrink: 0, color: C.textSub }}>{q.pointsEarned > 0 ? `+${q.pointsEarned}` : "0"}</span>
                <span style={{ width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0, background: q.isCorrect ? C.greenBg : C.redBg, color: q.isCorrect ? C.green : C.red }}>
                  {q.isCorrect ? "✓" : "✗"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ANSWER REVIEW ── */}
      {tab === "answers" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {qs.map((q, i) => {
            const typeLabel = q.type === "tf" ? "True / False" : "Multiple Choice";
            const typeColor = q.type === "tf" ? C.green : C.blue;
            return (
              <div key={q.id} style={{ background: C.white, borderRadius: 12, border: `1px solid ${q.isCorrect ? C.green + "40" : C.red + "40"}`, overflow: "hidden" }}>
                {/* Question header */}
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, background: q.isCorrect ? C.greenBg : C.redBg, color: q.isCorrect ? C.green : C.red }}>
                    {i + 1}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: typeColor + "15", color: typeColor }}>{typeLabel}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: C.muted, color: C.textSub }}>{q.topic}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.4 }}>{q.text || q.q}</p>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: q.isCorrect ? C.green : C.red }}>{q.isCorrect ? "Correct" : "Incorrect"}</div>
                    <div style={{ fontSize: 10, color: C.textSub }}>{(q.responseMs / 1000).toFixed(1)}s · {q.pointsEarned > 0 ? `+${q.pointsEarned} pts` : "0 pts"}</div>
                  </div>
                </div>
                {/* Answer detail */}
                <div style={{ padding: "12px 18px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                  {q.options.map((opt, oi) => {
                    const isCorrectOpt = oi === q.correctIndex;
                    const isUserOpt    = oi === q.userAnswerIndex;
                    let bg = C.pageBg, border = C.border, color = C.text;
                    if (isCorrectOpt)          { bg = C.greenBg;  border = C.green;  color = C.green; }
                    else if (isUserOpt && !q.isCorrect) { bg = C.redBg; border = C.red; color = C.red; }
                    return (
                      <div key={oi} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8, background: bg, border: `1.5px solid ${border}` }}>
                        <span style={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, background: border + "20", color: border }}>
                          {isCorrectOpt ? "✓" : isUserOpt && !q.isCorrect ? "✗" : String.fromCharCode(65 + oi)}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: isCorrectOpt || isUserOpt ? 700 : 500, color, flex: 1 }}>{opt}</span>
                        <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                          {isCorrectOpt && <span style={{ fontSize: 10, fontWeight: 700, color: C.green }}>Correct</span>}
                          {isUserOpt    && <span style={{ fontSize: 10, fontWeight: 700, color: isCorrectOpt ? C.green : C.red }}>Your answer</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── PERFORMANCE INSIGHTS ── */}
      {tab === "performance" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Topic breakdown */}
          <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
            <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}`, background: "#FFF7ED" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Accuracy by Topic</span>
            </div>
            {topics.map((t, i) => {
              const color = t.pct >= 80 ? C.green : t.pct >= 60 ? C.orange : C.red;
              return (
                <div key={t.name} style={{ padding: "12px 18px", borderBottom: i < topics.length - 1 ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{t.name}</span>
                      {t.pct >= 80 && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: C.greenBg, color: C.green }}>STRONG</span>}
                      {t.pct < 60  && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: C.redBg, color: C.red }}>NEEDS WORK</span>}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 700, color }}>{t.correct}/{t.total} · {t.pct}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 99, background: C.muted, overflow: "hidden" }}>
                    <div style={{ height: "100%", borderRadius: 99, width: `${t.pct}%`, background: color, transition: "width 0.4s" }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Hardest question */}
          {hardestQ && (
            <div style={{ background: C.white, borderRadius: 12, border: `1px solid rgba(239,68,68,0.25)`, padding: "16px 18px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.red, letterSpacing: "0.08em", marginBottom: 6 }}>HARDEST QUESTION</div>
              <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: C.text }}>{hardestQ.text}</p>
              <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.textSub }}>
                <span style={{ color: C.red }}>{hardestQ.isCorrect ? "You got this right" : "You got this wrong"}</span>
                <span>Response time: {(hardestQ.responseMs / 1000).toFixed(1)}s</span>
                <span>{hardestQ.topic}</span>
              </div>
            </div>
          )}

          {/* Speed vs accuracy */}
          <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: "16px 18px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 12 }}>Speed vs. Accuracy</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ padding: "12px", borderRadius: 10, background: C.greenBg, border: `1px solid ${C.green}30` }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.green, marginBottom: 4 }}>{fastCorrect.length}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.green }}>Fast & Correct</div>
                <div style={{ fontSize: 11, color: C.textSub }}>Under avg time, right answer</div>
              </div>
              <div style={{ padding: "12px", borderRadius: 10, background: C.redBg, border: `1px solid ${C.red}30` }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.red, marginBottom: 4 }}>{slowIncorrect.length}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.red }}>Slow & Incorrect</div>
                <div style={{ fontSize: 11, color: C.textSub }}>Over avg time, wrong answer</div>
              </div>
            </div>
            <p style={{ margin: "12px 0 0", fontSize: 12, color: C.textSub, lineHeight: 1.5 }}>
              {fastCorrect.length > slowIncorrect.length
                ? "Your speed reflects confidence in your knowledge — keep it up."
                : slowIncorrect.length > 2
                  ? "Taking more time on uncertain answers is dragging your score. Review the weak topics below."
                  : "Your speed and accuracy are balanced. Focus on the topics where you're missing questions."}
            </p>
          </div>

          {/* Areas for improvement */}
          {weakTopics.length > 0 && (
            <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.orange}30`, padding: "16px 18px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.orange, letterSpacing: "0.06em", marginBottom: 10 }}>AREAS FOR IMPROVEMENT</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {weakTopics.map(t => (
                  <div key={t.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 8, background: C.orangeLight, border: `1px solid ${C.orange}20` }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: C.textSub }}>{t.correct}/{t.total} correct · {t.pct}% accuracy</div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: C.orange }}>Needs work</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── RECOMMENDATIONS ── */}
      {tab === "recs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {weakTopics.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", background: C.white, borderRadius: 12, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>No weak areas detected</div>
              <div style={{ fontSize: 13, color: C.textSub }}>You scored well across all topics in this session.</div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: C.textSub }}>
                Based on your performance, focus on: <strong style={{ color: C.text }}>{weakTopics.map(t => t.name).join(", ")}</strong>
              </div>
              {recLessons.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.textSub, letterSpacing: "0.08em", marginBottom: 10 }}>RECOMMENDED LESSONS</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {recLessons.map(l => {
                      const typeColor = LESSON_TYPE_COLORS[l.type] ?? C.orange;
                      return (
                        <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", background: C.white, borderRadius: 12, border: `1px solid ${C.border}` }}>
                          <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: typeColor + "18", border: `1px solid ${typeColor}25`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
                            {LESSON_TYPE_ICONS[l.type]}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: typeColor, letterSpacing: "0.06em", marginBottom: 2 }}>{l.type.toUpperCase()} · {l.duration}</div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{l.title}</div>
                            <div style={{ fontSize: 11, color: C.textSub, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.description?.slice(0, 70)}…</div>
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.orange, flexShrink: 0 }}>{l.xp} XP</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {recQuizzes.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.textSub, letterSpacing: "0.08em", marginBottom: 10 }}>RECOMMENDED QUIZZES</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {recQuizzes.map(qz => (
                      <div key={qz.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", background: C.white, borderRadius: 12, border: `1px solid ${C.border}` }}>
                        <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: C.purple + "15", border: `1px solid ${C.purple}25`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, color: C.purple }}>Q</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: C.purple, letterSpacing: "0.06em", marginBottom: 2 }}>QUIZ · {qz.questions?.length ?? 0} QUESTIONS</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{qz.title}</div>
                          <div style={{ fontSize: 11, color: C.textSub, marginTop: 1 }}>{qz.track}</div>
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.orange, flexShrink: 0 }}>{qz.xp} XP</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {recLessons.length === 0 && recQuizzes.length === 0 && (
                <div style={{ padding: 32, textAlign: "center", background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, color: C.textSub, fontSize: 13 }}>
                  No specific content mapped to these topics yet.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── RANKD JOIN PANEL (user view) ────────────────────────────

function RankdJoinPanel({ onJoin, sessions, currentUser }) {
  const [pin, setPin]                       = useState("");
  const [pinError, setPinError]             = useState("");  // empty = no error
  const [joining, setJoining]               = useState(false);
  const [tab, setTab]                       = useState("join");
  const [activeHistorySession, setActiveHistorySession] = useState(null);
  const [dbHistory, setDbHistory]           = useState(null); // null = not yet loaded

  // Load real game history when My Scores tab is opened
  useEffect(() => {
    if (tab !== "scores" || dbHistory !== null || !currentUser?.id) return;
    getPlayerGameHistory(currentUser.id).then(({ data }) => {
      setDbHistory(data ?? []);
    });
  }, [tab, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleJoin = async (overridePin) => {
    const p = overridePin ?? pin;
    if (p.length < 4) { setPinError("Enter a valid game PIN"); return; }
    setPinError("");
    setJoining(true);
    const sessionName = sessions.find(s => s.code === p)?.name ?? "live game";
    const err = await onJoin(p, sessionName);
    setJoining(false);
    if (err) setPinError(err);
  };

  return (
    <div style={{ padding: 32, maxWidth: 900 }}>
      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
        {["join", "scores"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "8px 20px", borderRadius: 12, border: "none", cursor: "pointer",
            fontSize: 13, fontWeight: 700,
            ...(tab === t
              ? { background: C.orange, color: "#fff" }
              : { background: C.white, color: C.textSub, border: `1px solid ${C.border}` }),
          }}>
            {t === "join" ? "Join a Game" : "My Scores"}
          </button>
        ))}
      </div>

      {tab === "join" && (
        <div style={{ display: "flex", gap: 32, alignItems: "flex-start" }}>
          {/* PIN card */}
          <div style={{
            width: 300, flexShrink: 0, borderRadius: 24, padding: 32, textAlign: "center",
            background: C.white, border: `1px solid ${C.border}`,
            boxShadow: "0 8px 40px rgba(253,191,36,0.08)",
          }}>
            <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 900, color: C.text }}>Enter Game PIN</h2>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textSub }}>Ask your host for the PIN</p>
            <input
              type="text" inputMode="numeric" maxLength={8} value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, "")); setPinError(""); }}
              placeholder="000000"
              style={{
                width: "100%", textAlign: "center", fontSize: 28, fontWeight: 900,
                borderRadius: 16, padding: "14px 20px", marginBottom: 8, boxSizing: "border-box",
                background: pinError ? C.redBg : C.inputBg, color: C.text,
                border: `2px solid ${pinError ? C.red : C.border}`,
                letterSpacing: "0.25em", outline: "none",
              }}
            />
            {pinError && <p style={{ fontSize: 12, color: C.red, marginBottom: 8, fontWeight: 600 }}>{pinError}</p>}
            <button onClick={() => handleJoin()} disabled={joining} style={{
              width: "100%", padding: 14, borderRadius: 16, border: "none", cursor: joining ? "default" : "pointer",
              fontSize: 14, fontWeight: 900, marginTop: 8,
              background: pin.length >= 4 && !joining ? C.orange : C.muted,
              color: pin.length >= 4 && !joining ? "#fff" : C.textMuted,
            }}>{joining ? "Checking…" : "Let's Go! →"}</button>
          </div>

          {/* Active sessions */}
          <div style={{ flex: 1 }}>
            <p style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, color: C.text }}>Active sessions right now</p>
            {sessions.filter(s => s.status === "waiting").length === 0 && (
              <p style={{ fontSize: 13, color: C.textSub }}>No active sessions at the moment. Check back soon!</p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {sessions.filter(s => s.status === "waiting").map(s => (
                <button key={s.code} onClick={() => handleJoin(s.code)} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "16px 20px", borderRadius: 16, cursor: "pointer", textAlign: "left",
                  background: C.white, border: `1px solid rgba(253,191,36,0.2)`,
                  boxShadow: "0 2px 8px rgba(253,191,36,0.05)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text }}>{s.name}</p>
                      <p style={{ margin: 0, fontSize: 11, color: C.textSub }}>{s.questionCount} questions</p>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{
                      fontSize: 13, fontWeight: 900, letterSpacing: "0.2em", fontFamily: "monospace",
                      padding: "6px 12px", borderRadius: 10, background: C.orange, color: "#fff",
                    }}>{s.code}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: C.green }}>Tap to join →</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "scores" && (
        activeHistorySession ? (
          <SessionDetailView session={activeHistorySession} onBack={() => setActiveHistorySession(null)} />
        ) : (() => {
          // Real users: use DB history if loaded; demo users: use seed data
          const useDb       = currentUser?._isReal && dbHistory !== null;
          const isLoading   = currentUser?._isReal && dbHistory === null;
          const historyData = useDb ? dbHistory : USER_GAME_HISTORY;

          if (isLoading) {
            return <p style={{ fontSize: 13, color: C.textSub, padding: "20px 0" }}>Loading your game history…</p>;
          }
          if (useDb && historyData.length === 0) {
            return (
              <div style={{ textAlign: "center", padding: "48px 0", color: C.textSub }}>
                <p style={{ fontSize: 22, margin: "0 0 8px" }}>🎮</p>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>No games yet</p>
                <p style={{ margin: "4px 0 0", fontSize: 12 }}>Join a game to start tracking your scores.</p>
              </div>
            );
          }

          // Map DB rows to display shape (mirrors USER_GAME_HISTORY shape)
          const displayHistory = useDb
            ? historyData.map((row, i) => ({
                id:          row.id,
                sessionName: row.game_sessions?.name ?? "Game",
                date:        row.game_sessions?.ended_at ? new Date(row.game_sessions.ended_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—",
                rank:        row.final_rank ?? i + 1,
                totalPlayers: null,
                score:       row.final_score ?? 0,
                scorePercent: null, // not stored in game_players
                accuracy:    null,
                pin:         row.game_sessions?.pin ?? "—",
                questionCount: row.game_sessions?.question_count ?? "—",
                questions:   [],
              }))
            : historyData;

          if (!useDb) {
            // Legacy demo path — unchanged
            const bestScore  = Math.max(...USER_GAME_HISTORY.map(s => s.scorePercent));
            const bestRankS  = USER_GAME_HISTORY.reduce((a, b) => a.rank <= b.rank ? a : b);
            const bestScoreS = USER_GAME_HISTORY.reduce((a, b) => a.scorePercent >= b.scorePercent ? a : b);
            return (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
                  {[
                    { label: "Best Score",   value: `${bestScore}%`,       sub: bestScoreS.sessionName.split(" ").slice(0, 3).join(" "),  color: C.orange },
                    { label: "Games Played", value: String(USER_GAME_HISTORY.length), sub: "sessions completed",                           color: C.orange },
                    { label: "Best Rank",    value: `#${bestRankS.rank}`,  sub: `of ${bestRankS.totalPlayers} players`,                   color: C.green  },
                  ].map(m => (
                    <div key={m.label} style={{ borderRadius: 16, padding: 20, background: C.white, border: `1px solid ${C.border}` }}>
                      <p style={{ margin: 0, fontSize: 24, fontWeight: 900, color: C.text }}>{m.value}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 11, color: C.textSub }}>{m.label}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 10, fontWeight: 600, color: C.textMuted }}>{m.sub}</p>
                    </div>
                  ))}
                </div>
                <div style={{ borderRadius: 16, overflow: "hidden", background: C.white, border: `1px solid ${C.border}` }}>
                  <div style={{ padding: "12px 20px", borderBottom: `1px solid ${C.border}`, background: "#FFF7ED", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text }}>Session History</h3>
                    <span style={{ fontSize: 11, color: C.textSub }}>Click a session to see details</span>
                  </div>
                  {USER_GAME_HISTORY.map((s, idx) => {
                    const scoreColor = s.scorePercent >= 85 ? C.green : s.scorePercent >= 70 ? C.orange : C.red;
                    return (
                      <button key={s.id} onClick={() => setActiveHistorySession(s)} style={{
                        width: "100%", padding: "16px 20px", display: "flex", alignItems: "center", gap: 16,
                        borderBottom: idx < USER_GAME_HISTORY.length - 1 ? `1px solid ${C.border}` : "none",
                        background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                        transition: "background 0.15s",
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = C.pageBg}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, background: s.rank === 1 ? C.orange : C.muted, color: s.rank === 1 ? "#fff" : C.textSub }}>
                          #{s.rank}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text }}>{s.sessionName}</p>
                          <p style={{ margin: "2px 0 0", fontSize: 11, color: C.textSub }}>{s.date} · {s.questions.length} questions · {s.totalPlayers} players</p>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <p style={{ margin: 0, fontSize: 18, fontWeight: 900, color: scoreColor }}>{s.scorePercent}%</p>
                          <p style={{ margin: 0, fontSize: 10, color: C.textMuted }}>{s.accuracy}% accuracy</p>
                        </div>
                        <div style={{ width: 64, flexShrink: 0 }}>
                          <div style={{ height: 6, borderRadius: 99, overflow: "hidden", background: C.muted }}>
                            <div style={{ height: "100%", borderRadius: 99, width: `${s.scorePercent}%`, background: scoreColor }} />
                          </div>
                        </div>
                        <span style={{ fontSize: 14, color: C.textMuted, flexShrink: 0 }}>›</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }

          // Real user DB history display
          const bestRank = displayHistory.reduce((a, b) => (a.rank <= b.rank ? a : b), displayHistory[0]);
          return (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 28 }}>
                {[
                  { label: "Games Played", value: String(displayHistory.length), sub: "sessions completed", color: C.orange },
                  { label: "Best Rank",    value: bestRank ? `#${bestRank.rank}` : "—", sub: bestRank?.sessionName ?? "", color: C.green },
                ].map(m => (
                  <div key={m.label} style={{ borderRadius: 16, padding: 20, background: C.white, border: `1px solid ${C.border}` }}>
                    <p style={{ margin: 0, fontSize: 24, fontWeight: 900, color: C.text }}>{m.value}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 11, color: C.textSub }}>{m.label}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 10, fontWeight: 600, color: C.textMuted }}>{m.sub}</p>
                  </div>
                ))}
              </div>
              <div style={{ borderRadius: 16, overflow: "hidden", background: C.white, border: `1px solid ${C.border}` }}>
                <div style={{ padding: "12px 20px", borderBottom: `1px solid ${C.border}`, background: "#FFF7ED" }}>
                  <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text }}>Session History</h3>
                </div>
                {displayHistory.map((s, idx) => (
                  <div key={s.id} style={{
                    padding: "16px 20px", display: "flex", alignItems: "center", gap: 16,
                    borderBottom: idx < displayHistory.length - 1 ? `1px solid ${C.border}` : "none",
                  }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, background: s.rank === 1 ? C.orange : C.muted, color: s.rank === 1 ? "#fff" : C.textSub }}>
                      #{s.rank}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text }}>{s.sessionName}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 11, color: C.textSub }}>{s.date} · PIN: {s.pin}</p>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <p style={{ margin: 0, fontSize: 18, fontWeight: 900, color: C.orange }}>{(s.score ?? 0).toLocaleString()} pts</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()
      )}
    </div>
  );
}

// ── RANKD ADMIN PANEL ────────────────────────────────────────

function RankdAdminPanel({ onNav, sessions, onLaunch, onViewResults, onRelaunch }) {
  const [tab, setTab] = useState("active");

  // All statuses that can appear from the DB or local state
  const statusColors = {
    waiting:   { bg: C.limeBg,       text: "#059669",  label: "Waiting"   },
    live:      { bg: C.orangeLight,   text: C.orange,   label: "Live"      },
    started:   { bg: C.orangeLight,   text: C.orange,   label: "Live"      },
    active:    { bg: C.orangeLight,   text: C.orange,   label: "Live"      },
    paused:    { bg: "#FEF3C7",       text: "#D97706",  label: "Paused"    },
    ended:     { bg: C.muted,         text: C.textSub,  label: "Ended"     },
    completed: { bg: C.muted,         text: C.textSub,  label: "Completed" },
    canceled:  { bg: C.muted,         text: C.textSub,  label: "Canceled"  },
    archived:  { bg: C.muted,         text: C.textSub,  label: "Archived"  },
  };

  const TERMINAL_STATUSES = new Set(["ended", "completed", "canceled", "archived"]);
  const activeSessions = sessions.filter(s => !TERMINAL_STATUSES.has(s.status));
  const pastSessions   = sessions.filter(s =>  TERMINAL_STATUSES.has(s.status));

  // Determine the correct CTA label based on session status
  const getSessionActionLabel = (status) => {
    if (status === "waiting")                                      return "Open Lobby";
    if (status === "live" || status === "started" ||
        status === "active" || status === "paused")                return "Resume";
    return "Open";
  };

  const SessionRow = ({ s }) => {
    const sc  = statusColors[s.status] ?? { bg: C.muted, text: C.textSub, label: s.status ?? "Unknown" };
    const isPast = TERMINAL_STATUSES.has(s.status);
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 16, padding: 20, borderRadius: 16,
        background: C.white, border: `1px solid ${C.border}`,
        boxShadow: "0 2px 8px rgba(27,45,82,0.04)",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text }}>{s.name}</h3>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: sc.bg, color: sc.text }}>{sc.label}</span>
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 11, color: C.textSub }}>
            <span>{s.playerCount ?? 0} players</span>
            <span>{s.questionCount} questions</span>
            <span style={{ fontWeight: 900, letterSpacing: "0.12em", fontFamily: "monospace", color: C.textMuted }}>PIN: {s.code}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {isPast ? (
            <>
              <button onClick={() => onViewResults(s.code)} style={{ padding: "8px 16px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", background: C.white, color: C.textSub, border: `1px solid ${C.border}` }}>View Results</button>
              <button onClick={() => onRelaunch(s)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", background: C.dark, color: "#fff", border: "none" }}>▶ Re-launch</button>
            </>
          ) : (
            <button onClick={() => onLaunch(s)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", background: C.green, color: "#fff", border: "none" }}>▶ {getSessionActionLabel(s.status)}</button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: 32, maxWidth: 900 }}>
      {/* Header row — tabs left, New Game button right */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 4, background: C.muted, borderRadius: 10, padding: 4 }}>
          {[
            { id: "active", label: "Active"        },
            { id: "past",   label: "Past Sessions" },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer",
              fontSize: 13, fontWeight: 700,
              background: tab === t.id ? C.white : "transparent",
              color:      tab === t.id ? C.text  : C.textSub,
              boxShadow:  tab === t.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              transition: "all 0.12s",
            }}>{t.label}</button>
          ))}
        </div>
        <button onClick={() => onNav("rankd-new")} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 12, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#fff", background: C.orange }}>+ New Game</button>
      </div>

      {/* Active tab */}
      {tab === "active" && (
        <>
          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 11, color: C.textSub }}>{activeSessions.length} active session{activeSessions.length !== 1 ? "s" : ""}</p>
          </div>
          {activeSessions.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 24px", background: C.pageBg, borderRadius: 14, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🎮</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>No active sessions</div>
              <p style={{ margin: "0 0 20px", fontSize: 13, color: C.textSub }}>Create a new game to get started.</p>
              <button onClick={() => onNav("rankd-new")} style={{ padding: "10px 24px", borderRadius: 10, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>+ New Game</button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {activeSessions.map(s => <SessionRow key={s.code} s={s} />)}
            </div>
          )}
        </>
      )}

      {/* Past Sessions tab */}
      {tab === "past" && (
        <>
          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 11, color: C.textSub }}>{pastSessions.length} completed session{pastSessions.length !== 1 ? "s" : ""}</p>
          </div>
          {pastSessions.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 24px", background: C.pageBg, borderRadius: 14, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>No past sessions yet</div>
              <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>Completed games will appear here with full analytics, player results, and question breakdowns.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {pastSessions.map(s => <SessionRow key={s.code} s={s} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── RANKD SCREEN (hub, role-aware) ──────────────────────────

function RankdScreen({ onNav, onJoin, sessions, onLaunch, onViewResults, onRelaunch, role, currentUser }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Hero */}
      <div style={{
        background: C.cream,
        borderRadius: "12px 12px 0 0", padding: "28px 32px 24px",
        position: "relative", overflow: "hidden",
      }}>
        {[...Array(18)].map((_, i) => (
          <div key={i} style={{
            position: "absolute", borderRadius: "50%", pointerEvents: "none",
            width: 8+(i%5)*6, height: 8+(i%5)*6,
            top: `${10+(i*37)%80}%`, left: `${(i*13)%95}%`,
            background: i%3===0 ? "#fff" : i%3===1 ? C.orangeDark : "#0B1220",
            opacity: 0.08,
          }} />
        ))}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 14, background: C.orange,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color: "#fff", fontWeight: 900,
            }}>G</div>
            <div>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 900, color: C.text }}>ralli games</h1>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: C.orangeDark, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Live Sales Games
              </p>
            </div>
          </div>
          {role === "admin" && (
            <button onClick={() => onNav("rankd-new")} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 20px",
              borderRadius: 12, border: "none", cursor: "pointer",
              fontSize: 13, fontWeight: 700, color: "#fff", background: C.text,
            }}>✚ New Game</button>
          )}
        </div>
        <p style={{ margin: "12px 0 0", fontSize: 13, color: C.orangeDark, position: "relative" }}>
          {role === "admin"
            ? "Host live training battles — create sessions, manage questions, and launch in real time."
            : "Jump into a live ralli session and compete with your team."}
        </p>
      </div>

      {/* Content */}
      <div style={{ background: C.white, borderRadius: "0 0 12px 12px", border: `1px solid ${C.border}`, borderTop: "none" }}>
        {role === "admin"
          ? <RankdAdminPanel onNav={onNav} sessions={sessions} onLaunch={onLaunch} onViewResults={onViewResults} onRelaunch={onRelaunch} />
          : <RankdJoinPanel onJoin={onJoin} sessions={sessions} currentUser={currentUser} />}
      </div>
    </div>
  );
}

// ── RANKD NAME ENTRY SCREEN ──────────────────────────────────

function RankdNameEntryScreen({ onNav, pin, sessionName, onConfirm, defaultName, defaultAvatar = null }) {
  const [name, setName]       = useState(defaultName ?? "");
  const [emoji, setEmoji]     = useState(defaultAvatar); // null = no avatar selected (optional)
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);
  const ACCENT                = [C.orange, C.green, "#0EA5E9", "#8B5CF6", "#F43F5E", "#F59E0B"];

  const handleConfirm = async () => {
    if (!name.trim() || joining) return;
    setJoining(true);
    setJoinError(null);
    const err = await onConfirm(name.trim(), emoji);
    if (err) {
      setJoinError(err);
      setJoining(false);
    }
    // On success onConfirm navigates away — no need to reset joining state.
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "100%", position: "relative", overflow: "hidden",
      background: C.cream,
    }}>
      {[...Array(20)].map((_, i) => (
        <div key={i} style={{
          position: "absolute", borderRadius: "50%", pointerEvents: "none",
          width: 8+(i%5)*7, height: 8+(i%5)*7,
          top: `${(i*23)%88}%`, left: `${(i*17)%93}%`,
          background: ACCENT[i % ACCENT.length], opacity: 0.08 + (i%3)*0.04,
        }} />
      ))}

      <div style={{ position: "relative", zIndex: 10, width: "100%", maxWidth: 360, padding: "0 24px" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px",
            borderRadius: 99, marginBottom: 12,
            background: "rgba(255,255,255,0.7)", border: `1px solid ${C.border}`,
          }}>
            <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.1em", color: C.dark }}>PIN: {pin}</span>
          </div>
          <h1 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 900, color: C.dark }}>{sessionName}</h1>
          <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>You're in! Just one more step.</p>
        </div>

        <div style={{
          borderRadius: 24, padding: 28, textAlign: "center",
          background: "rgba(255,255,255,0.85)", border: `1px solid ${C.border}`,
        }}>
          {/* Avatar picker — optional */}
          <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", padding: "4px 0" }}>
              {/* None / skip option */}
              <button onClick={() => setEmoji(null)} style={{
                width: 44, height: 44, borderRadius: 12,
                border: `2px solid ${emoji === null ? C.orange : C.creamBorder}`,
                background: emoji === null ? C.orangeLight : C.cardBg,
                fontSize: 11, fontWeight: 700, color: emoji === null ? C.orange : C.textMuted,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.15s", flexShrink: 0,
              }}>None</button>
              {AVATARS.map((av) => (
                <button key={av} onClick={() => setEmoji(av)} style={{
                  width: 44, height: 44, borderRadius: 12,
                  border: `2px solid ${emoji === av ? C.orange : C.creamBorder}`,
                  background: emoji === av ? C.orangeLight : C.cardBg,
                  fontSize: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.15s", flexShrink: 0,
                }}>{av}</button>
              ))}
            </div>
          </div>
          <p style={{ margin: "0 0 12px", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: C.textMuted, textTransform: "uppercase" }}>Avatar <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></p>
          <input
            type="text" maxLength={24} value={name} autoFocus
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleConfirm()}
            placeholder="Your name or nickname…"
            style={{
              width: "100%", textAlign: "center", fontSize: 18, fontWeight: 700, boxSizing: "border-box",
              borderRadius: 16, padding: "14px 20px", marginBottom: 4,
              background: C.cardBg, color: C.text,
              border: `2px solid ${name.trim() ? C.orange : C.border}`,
              outline: "none",
            }}
          />
          <p style={{ margin: "0 0 20px", fontSize: 10, color: C.textMuted }}>
            {defaultName ? `Your name — feel free to add a nickname` : "This is how you'll appear to others"}
          </p>
          <button onClick={handleConfirm} disabled={!name.trim() || joining} style={{
            width: "100%", padding: 14, borderRadius: 16, border: "none",
            fontSize: 14, fontWeight: 900,
            background: name.trim() && !joining ? C.orange : C.muted,
            color: name.trim() && !joining ? "#fff" : C.textMuted,
            cursor: name.trim() && !joining ? "pointer" : "not-allowed",
          }}>
            {joining ? "Joining…" : name.trim() ? `Enter as ${name}${emoji ? " " + emoji : ""} →` : "Type your name to continue"}
          </button>
          {joinError && (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: C.red, fontWeight: 600, textAlign: "center" }}>
              {joinError}
            </p>
          )}
        </div>

        <button onClick={() => onNav("rankd")} style={{
          width: "100%", textAlign: "center", marginTop: 16, padding: 8,
          fontSize: 13, color: C.textSub, background: "transparent", border: "none", cursor: "pointer",
        }}>← Back</button>
      </div>
    </div>
  );
}

// ── RANKD LOBBY SCREEN ───────────────────────────────────────

function RankdLobbyScreen({ onNav, pin, playerName, playerEmoji, sessionName, role, sessions = [], currentUser, onGameStart, chPlayers, broadcast, playerId, chMsg, onHostEnd }) {
  const mobile = useMobile();
  const session     = sessions.find(s => s.code === pin);
  const sessionDbId = session?.dbId ?? null;

  // demoMode: true only when admin has explicitly created a demo session.
  // A real tenant session always has demoMode: false (set in handleCreateSession).
  const isDemoMode = role === "admin" && session?.demoMode !== false;

  // Demo mode: animated fake players
  const [visibleCount, setVisibleCount] = useState(role === "admin" ? 3 : 1);
  const [dots, setDots]                 = useState(".");
  const [pulse, setPulse]               = useState(false);

  // DB-backed participant list for the manager lobby.
  // Source of truth: game_session_participants rows for this session.
  const [dbPlayers, setDbPlayers] = useState([]);

  const normParticipant = (p) => ({
    id:     p.player_id ?? p.id,
    name:   p.name,
    emoji:  p.emoji  ?? PLAYER_EMOJIS[0],
    color:  p.color  ?? PLAYER_COLORS[0],
    score:  0,
    status: p.status ?? "active",
  });

  // ── Admin: load initial participants from DB ────────────────────────────────
  useEffect(() => {
    if (role !== "admin" || !sessionDbId || isDemoMode) return;
    getLobbyParticipants(sessionDbId).then(({ data, error }) => {
      if (error) console.error("[ralli:lobby] getLobbyParticipants FAILED:", error);
      if (data) setDbPlayers(data.map(normParticipant));
    });
  }, [sessionDbId, isDemoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Admin: subscribe to realtime INSERTs on game_session_participants ───────
  // Fires immediately when a player calls joinGameSession(), cross-device.
  useEffect(() => {
    if (role !== "admin" || !sessionDbId || isDemoMode) return;
    const channel = subscribeToLobbyParticipants(sessionDbId, (row) => {
      setDbPlayers(prev => {
        if (prev.some(p => p.id === row.player_id)) return prev; // already present
        return [...prev, normParticipant(row)];
      });
    });
    return () => { supabase.removeChannel(channel); };
  }, [sessionDbId, isDemoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Admin: poll every 4s as fallback when realtime isn't enabled ────────────
  useEffect(() => {
    if (role !== "admin" || !sessionDbId || isDemoMode) return;
    const interval = setInterval(() => {
      getLobbyParticipants(sessionDbId).then(({ data }) => {
        if (data) setDbPlayers(data.map(normParticipant));
      });
    }, 4000);
    return () => clearInterval(interval);
  }, [sessionDbId, isDemoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Player: load participants from DB + subscribe to INSERTs ─────────────────
  // Mirrors the admin side so the player sees the same live count.
  useEffect(() => {
    if (role === "admin" || isDemoMode || !sessionDbId) return;

    // Optimistic self-entry: show player count ≥ 1 immediately without waiting
    // for joinGameSession() (fire-and-forget) or presence subscription to complete.
    const pidx = Math.abs((playerId ?? "").charCodeAt(0) + ((playerId ?? "").charCodeAt(1) || 0)) % PLAYER_EMOJIS.length;
    const selfEntry = normParticipant({
      player_id: currentUser?.id ?? playerId,
      name:      playerName,
      emoji:     playerEmoji ?? PLAYER_EMOJIS[pidx],
      color:     PLAYER_COLORS[pidx % PLAYER_COLORS.length],
      status:    "active",
    });
    setDbPlayers([selfEntry]);

    // Helper: merge DB rows, keeping self if not yet persisted
    const mergeWithSelf = (rows) => {
      const selfId   = selfEntry.id;
      const selfInDb = rows.some(p => p.id === selfId);
      return selfInDb ? rows : [selfEntry, ...rows];
    };

    // Initial load
    getLobbyParticipants(sessionDbId).then(({ data }) => {
      if (data) setDbPlayers(mergeWithSelf(data.map(normParticipant)));
    });
    // Realtime INSERT subscription
    const channel = subscribeToLobbyParticipants(sessionDbId, (row) => {
      setDbPlayers(prev => {
        if (prev.some(p => p.id === (row.player_id ?? row.id))) return prev;
        return [...prev, normParticipant(row)];
      });
    });
    // Poll every 3s as fallback
    const interval = setInterval(() => {
      getLobbyParticipants(sessionDbId).then(({ data }) => {
        if (data) setDbPlayers(mergeWithSelf(data.map(normParticipant)));
      });
    }, 3000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [sessionDbId, isDemoMode, role]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Player: poll game_sessions.phase as countdown/start fallback ─────────────
  // Broadcast (GM.GAME_START / GM.SHOW_QUESTION) can be missed in race conditions.
  // If the session phase advances past 'waiting', navigate to game.
  useEffect(() => {
    if (role === "admin" || isDemoMode || !sessionDbId) return;
    const interval = setInterval(() => {
      supabase
        .from("game_sessions")
        .select("phase, status")
        .eq("id", sessionDbId)
        .single()
        .then(({ data }) => {
          if (!data) return;
          const started = data.status === "started" || (data.phase && data.phase !== "waiting");
          if (started) onNav("rankd-game");
        });
    }, 2000);
    return () => clearInterval(interval);
  }, [sessionDbId, isDemoMode, role]); // eslint-disable-line react-hooks/exhaustive-deps

  const basePlayer = role === "admin"
    ? { name: currentUser?.name ?? "Host", emoji: "🦁", color: C.green }
    : { name: playerName || "You", emoji: playerEmoji ?? "🦊", color: C.orange };

  const demoAllPlayers = [basePlayer, ...LOBBY_PLAYERS.filter(p => p.name !== basePlayer.name)];

  // Real mode: merge DB participants (source of truth) with Presence players (belt-and-suspenders).
  // Deduplicate by id. Exclude DB players with status='left' or 'disconnected'.
  const combinedRealPlayers = (() => {
    if (isDemoMode) return [];
    const map = new Map();
    // DB players first (includes status); only keep active ones
    dbPlayers.filter(p => p.status !== "left" && p.status !== "disconnected").forEach(p => { if (p.id) map.set(p.id, p); });
    // Presence players add any not yet in DB (belt-and-suspenders)
    chPlayers.forEach(p => { if (p.id && !map.has(p.id)) map.set(p.id, p); });
    return Array.from(map.values());
  })();

  const realPlayers    = isDemoMode ? [] : combinedRealPlayers;
  const displayPlayers = isDemoMode ? demoAllPlayers.slice(0, visibleCount) : realPlayers;

  // Player side: announce join via channel
  useEffect(() => {
    if (isDemoMode || role === "admin" || !pin || !playerId) return;
    const pidx = Math.abs(playerId.charCodeAt(0) + playerId.charCodeAt(1)) % PLAYER_EMOJIS.length;
    broadcast({ type: GM.PLAYER_JOIN, player: { id: playerId, name: playerName, emoji: playerEmoji ?? PLAYER_EMOJIS[pidx], color: PLAYER_COLORS[pidx % PLAYER_COLORS.length] } });
  }, [isDemoMode, pin, playerId, role]);

  // Player side: watch for GAME_START or first SHOW_QUESTION → navigate to game
  useEffect(() => {
    if (isDemoMode || role === "admin") return;
    if (chMsg?.type === GM.SHOW_QUESTION || chMsg?.type === GM.GAME_START) onNav("rankd-game");
  }, [chMsg, isDemoMode, role]);

  useEffect(() => {
    if (!isDemoMode) return;
    const joinTimer = setInterval(() => {
      setVisibleCount(n => {
        if (n >= demoAllPlayers.length) { clearInterval(joinTimer); return n; }
        setPulse(true);
        setTimeout(() => setPulse(false), 600);
        return n + 1;
      });
    }, 1600);
    const dotTimer = setInterval(() => setDots(d => d.length >= 3 ? "." : d + "."), 500);
    return () => { clearInterval(joinTimer); clearInterval(dotTimer); };
  }, [isDemoMode]);

  // Real mode user: auto-navigate when host starts
  useEffect(() => {
    if (isDemoMode || role === "admin") return;
    if (session?.status === "started") {
      onNav("rankd-game");
    }
  }, [session?.status, isDemoMode, role]);

  const playerCount = isDemoMode ? displayPlayers.length : realPlayers.length;

  return (
    <div style={{
      display: "flex", flexDirection: "column", minHeight: "100%",
      background: C.cream,
    }}>
      {/* Header — preserves original PIN-prominent layout */}
      <div style={{
        position: "relative", zIndex: 10, padding: mobile ? "16px 16px 12px" : "20px 28px 16px",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        background: C.cardBg, borderBottom: `1px solid ${C.creamBorder}`,
        flexWrap: mobile ? "wrap" : "nowrap",
      }}>
        <div>
          <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: "0.1em", textTransform: "uppercase" }}>Game PIN</p>
          <p style={{ margin: 0, fontSize: mobile ? 26 : 32, fontWeight: 900, color: C.text, letterSpacing: "0.12em" }}>{pin || "482901"}</p>
        </div>
        <div style={{ textAlign: "center" }}>
          <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 800, color: C.text }}>{sessionName}</p>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <div style={{
              width: 7, height: 7, borderRadius: "50%", background: C.trueGreen,
              transform: pulse ? "scale(1.4)" : "scale(1)", transition: "transform 0.3s",
            }} />
            <span style={{ fontSize: 12, color: C.textSub }}>
              {playerCount} player{playerCount !== 1 ? "s" : ""} joined
            </span>
          </div>
        </div>
        {role === "admin" ? (
          <button onClick={onGameStart} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: mobile ? "10px 18px" : "12px 24px", borderRadius: 12, border: "none", cursor: "pointer",
            fontSize: 13, fontWeight: 800, color: "#fff", background: C.orange, minHeight: 44,
          }}>▶ Start Game</button>
        ) : (
          <div style={{ textAlign: "right" }}>
            <p style={{ margin: "0 0 6px", fontSize: 12, color: C.textMuted }}>Waiting for host{dots}</p>
            <div style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
              {[0, 0.2, 0.4].map((_, i) => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: "50%", background: C.orange,
                  animation: `lobbyPulse 1.4s ease-in-out ${i*0.2}s infinite`,
                }} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* My card (player only) */}
      {role === "user" && (
        <div style={{ padding: mobile ? "12px 16px 0" : "16px 28px 0" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
            borderRadius: 12, maxWidth: 380, background: C.cardBg,
            border: `1.5px solid ${C.creamBorder}`,
          }}>
            <span style={{ fontSize: 24 }}>{basePlayer.emoji}</span>
            <div>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: C.text }}>{basePlayer.name}</p>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: C.orange }}>That's you!</p>
            </div>
          </div>
        </div>
      )}

      {/* Player grid */}
      <div style={{ flex: 1, padding: mobile ? "16px" : "20px 28px" }}>
        {role === "admin" && (
          <p style={{ margin: "0 0 12px", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Players in lobby
          </p>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
          {displayPlayers.map((p, i) => {
            const isMe = !isDemoMode ? p.id === currentUser?.id : i === 0;
            const EMOJIS = ["🦊","🐯","🦁","🐼","🦊","🐸","🐧","🦄","🦋","🐙"];
            const emoji = p.emoji ?? EMOJIS[i % EMOJIS.length];
            const color = p.color ?? [C.orange, C.green, "#3B82F6", "#8B5CF6", "#F43F5E", "#F59E0B"][i % 6];
            return (
              <div key={p.name ?? i} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 12,
                background: C.cardBg,
                border: `1.5px solid ${isMe && role === "user" ? C.creamBorder : C.cardBorder}`,
                animation: isDemoMode && i === visibleCount - 1 ? "fadeSlideIn 0.4s ease" : undefined,
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 9, flexShrink: 0, fontSize: 18,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: color + "18", border: `1.5px solid ${color}30`,
                }}>{emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</p>
                  {isMe && role === "user"  && <p style={{ margin: 0, fontSize: 10, fontWeight: 600, color: C.orange }}>You</p>}
                  {isMe && role === "admin" && <p style={{ margin: 0, fontSize: 10, fontWeight: 600, color: C.orange }}>Host</p>}
                </div>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.trueGreen, flexShrink: 0 }} />
              </div>
            );
          })}
          {!isDemoMode && displayPlayers.length === 0 && (
            <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "40px 0", color: C.textMuted, fontSize: 13 }}>
              No players yet — share the PIN!
            </div>
          )}
          {isDemoMode && displayPlayers.length < 4 && [...Array(4 - displayPlayers.length)].map((_, i) => (
            <div key={`e${i}`} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 12,
              background: C.cardBg, border: "1.5px dashed #E5E7EB",
            }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: "#F3F4F6" }} />
              <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>Waiting…</p>
            </div>
          ))}
        </div>

        {/* Admin info strip */}
        {role === "admin" && (
          <div style={{
            marginTop: 20, display: "flex", alignItems: "center", gap: 16, padding: "14px 18px", borderRadius: 12,
            background: C.cardBg, border: `1px solid ${C.creamBorder}`,
          }}>
            <div style={{ flex: 1 }}>
              <p style={{ margin: "0 0 2px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Session</p>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.text }}>{sessionName}</p>
            </div>
            <div style={{ textAlign: "center", padding: "0 14px", borderLeft: `1px solid ${C.creamBorder}`, borderRight: `1px solid ${C.creamBorder}` }}>
              <p style={{ margin: "0 0 2px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Players</p>
              <p style={{ margin: 0, fontSize: 20, fontWeight: 900, color: C.text }}>{playerCount}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ margin: "0 0 2px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>PIN</p>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 900, letterSpacing: "0.15em", color: C.orange }}>{pin}</p>
            </div>
          </div>
        )}
      </div>

      {/* Leave / End */}
      <div style={{ padding: "0 28px 24px", textAlign: "center" }}>
        {role === "admin" ? (
          <button onClick={() => { if (onHostEnd) onHostEnd(); else onNav("rankd"); }} style={{
            fontSize: 13, color: C.red, background: "transparent",
            border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 18px", cursor: "pointer",
          }}>End Session</button>
        ) : (
          <button onClick={() => onNav("rankd")} style={{
            fontSize: 13, color: C.textMuted, background: "transparent",
            border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5,
          }}>✕ Leave game</button>
        )}
      </div>

      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes lobbyPulse {
          0%, 100% { opacity: 0.4; transform: scale(0.8); }
          50%       { opacity: 1;   transform: scale(1.2); }
        }
      `}</style>
    </div>
  );
}

// ── RANKD RESULTS SCREEN ─────────────────────────────────────

function RankdResultsScreen({ onNav, sessionCode, sessions, gameData }) {
  const mobile    = useMobile();
  const session   = sessions.find(s => s.code === sessionCode);
  const [tab, setTab] = useState("summary");
  const [dbScores, setDbScores] = useState(null);

  // Load from DB if gameData not in memory (e.g. host refreshed after game ended)
  useEffect(() => {
    if (gameData?.scores || !session?.dbId) return;
    getSessionPlayers(session.dbId).then(({ data }) => {
      if (data?.length) {
        setDbScores(data.map((p) => ({
          id:    p.player_id,
          name:  p.name,
          emoji: p.emoji ?? "🙂",
          color: p.color ?? C.orange,
          score: p.final_score ?? 0,
          delta: 0,
        })));
      }
    });
  }, [session?.dbId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real data only — no mock fallbacks
  const realScores    = gameData?.scores ?? dbScores ?? null;
  const realQuestions = gameData?.questions ?? null;
  const realQHistory  = gameData?.questionHistory ?? null;

  const leaderboard = realScores
    ? realScores.map((p, i) => ({ rank: i+1, name: p.name, emoji: p.emoji ?? "🙂", score: p.score }))
    : [];

  const questionBreakdown = realQHistory?.length
    ? realQHistory.map((q, i) => ({
        q:       q.q ?? `Question ${i+1}`,
        type:    Q_TYPE_LABELS[realQuestions?.[q.qIdx]?.type] ?? "Question",
        correct: q.correctCount ?? 0,
        total:   q.totalAnswers ?? leaderboard.length,
        avgMs:   Math.round(q.avgTimeMs ?? 0),
      }))
    : [];

  const podium  = [...leaderboard].sort((a,b) => a.rank - b.rank).slice(0,3);
  const podiumDisplay = podium.length >= 3 ? [podium[1], podium[0], podium[2]] : podium;
  const podiumStyles = [
    { bg: C.orange, glow: "rgba(245,158,11,0.3)",  medal: "1st", height: 110 },
    { bg: C.dark,   glow: "rgba(27,45,82,0.3)",    medal: "2nd", height: 80  },
    { bg: C.orange, glow: "rgba(253,191,36,0.25)", medal: "3rd", height: 64  },
  ];

  const avgAccuracy   = questionBreakdown.length
    ? Math.round(questionBreakdown.reduce((s,q) => s + Math.round((q.correct / Math.max(q.total,1)) * 100), 0) / questionBreakdown.length)
    : null;
  const hardestQ      = questionBreakdown.length
    ? questionBreakdown.reduce((a, b) => (a.correct/Math.max(a.total,1)) <= (b.correct/Math.max(b.total,1)) ? a : b)
    : null;
  const avgResponseMs = questionBreakdown.length
    ? Math.round(questionBreakdown.reduce((s,q) => s + (q.avgMs||0), 0) / questionBreakdown.length)
    : null;
  const totalPlayers  = leaderboard.length;

  const typeColors = {
    "Multiple Choice": { bg: C.blueBg,     text: "#0284C7" },
    "True / False":    { bg: C.limeBg,     text: "#059669" },
    "Type Answer":     { bg: C.orangeLight, text: C.orange  },
    "Open Ended":      { bg: C.purpleBg,   text: "#7C3AED" },
    "Slider":          { bg: C.purpleBg,   text: "#7C3AED" },
    "Question":        { bg: C.muted,      text: C.textSub },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{
        background: C.cream,
        borderRadius: "12px 12px 0 0", padding: "24px 32px 0", position: "relative", overflow: "hidden",
      }}>
        {[...Array(16)].map((_, i) => (
          <div key={i} style={{
            position: "absolute", borderRadius: "50%", pointerEvents: "none", opacity: 0.1,
            width: 8+(i%5)*6, height: 8+(i%5)*6,
            top: `${10+(i*37)%80}%`, left: `${(i*13)%95}%`,
            background: i%3===0 ? C.orange : i%3===1 ? C.green : "#38BDF8",
          }} />
        ))}
        <div style={{ position: "relative" }}>
          <button onClick={() => onNav("rankd")} style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 12,
            color: C.textSub, background: "transparent", border: "none",
            cursor: "pointer", marginBottom: 12, padding: 0,
          }}>‹ Back to Sessions</button>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <h1 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 900, color: C.dark }}>{session.name}</h1>
              <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.textMuted }}>
                <span>{totalPlayers || session?.playerCount || 0} players</span>
                <span>{session.questionCount} questions</span>
                <span style={{ fontWeight: 900, letterSpacing: "0.1em", fontFamily: "monospace", color: C.dark }}>PIN: {sessionCode}</span>
              </div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "4px 12px", borderRadius: 99,
              background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)",
              color: C.textSub,
            }}>Session Ended</span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[
              { id: "summary",   label: "Overview" },
              { id: "leaderboard", label: "Leaderboard" },
              { id: "players",   label: "Player Breakdown" },
              { id: "questions",   label: "Questions" },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: "10px 20px", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700,
                borderRadius: "10px 10px 0 0",
                ...(tab === t.id
                  ? { background: C.pageBg, color: C.text }
                  : { background: "rgba(255,255,255,0.4)", color: C.textSub }),
              }}>{t.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ background: C.pageBg, borderRadius: "0 0 12px 12px", padding: "28px 32px" }}>
        {tab === "summary" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Overview stats */}
            <div style={{ display: "grid", gridTemplateColumns: mobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 14 }}>
              {[
                { label: "Total Players",       value: totalPlayers > 0 ? String(totalPlayers) : "—",  icon: "", color: C.blue },
                { label: "Avg Accuracy",        value: avgAccuracy != null ? `${avgAccuracy}%` : "—", icon: "", color: "#059669" },
                { label: "Avg Response Speed",  value: avgResponseMs != null ? (avgResponseMs >= 1000 ? `${(avgResponseMs/1000).toFixed(1)}s` : `${avgResponseMs}ms`) : "—", icon: "", color: C.orange },
                { label: "Questions",           value: String(questionBreakdown.length || session?.questionCount || 0), icon: "", color: "#7C3AED" },
              ].map(m => (
                <Card key={m.label}>
                  {m.icon && <div style={{ width: 32, height: 32, borderRadius: 10, background: m.color + "18", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, marginBottom: 10 }}>{m.icon}</div>}
                  <p style={{ margin: 0, fontSize: 24, fontWeight: 900, color: C.text }}>{m.value}</p>
                  <p style={{ margin: "3px 0 0", fontSize: 11, color: C.textSub }}>{m.label}</p>
                </Card>
              ))}
            </div>
            {/* Toughest question */}
            {hardestQ && (
              <Card style={{ border: `1px solid rgba(239,68,68,0.2)` }}>
                <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, color: C.red, textTransform: "uppercase", letterSpacing: "0.1em" }}>Toughest Question</p>
                <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: C.text }}>{hardestQ.q}</p>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, height: 8, borderRadius: 99, background: C.muted, overflow: "hidden" }}>
                    <div style={{ height: "100%", borderRadius: 99, width: `${Math.round((hardestQ.correct/Math.max(hardestQ.total,1))*100)}%`, background: C.red }} />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.red, flexShrink: 0 }}>{hardestQ.correct}/{hardestQ.total} correct</span>
                </div>
              </Card>
            )}
            {/* Question accuracy breakdown */}
            <Card>
              <p style={{ margin: "0 0 14px", fontSize: 10, fontWeight: 700, color: C.textSub, textTransform: "uppercase", letterSpacing: "0.08em" }}>Question Accuracy</p>
              {questionBreakdown.map((q, i) => {
                const pct = Math.round((q.correct / Math.max(q.total, 1)) * 100);
                const color = pct >= 80 ? "#059669" : pct >= 60 ? C.orange : C.red;
                return (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: C.textSub, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginRight: 8 }}>Q{i+1}: {q.q}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color, flexShrink: 0 }}>{pct}%</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 99, background: C.muted }}>
                      <div style={{ height: "100%", borderRadius: 99, width: `${pct}%`, background: color, transition: "width 0.5s" }} />
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>
        )}

        {tab === "players" && (
          leaderboard.length === 0
            ? <div style={{ textAlign: "center", padding: 60, color: C.textMuted, fontSize: 14 }}>No player data available</div>
            : <Card style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 80px 80px", padding: "10px 20px", borderBottom: `1px solid ${C.border}`, fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", background: C.muted }}>
                  <div>#</div><div>Player</div><div style={{ textAlign: "right" }}>Score</div><div style={{ textAlign: "right" }}>Rank</div>
                </div>
                {leaderboard.map((p) => (
                  <div key={p.name} style={{ display: "grid", gridTemplateColumns: "40px 1fr 80px 80px", padding: "12px 20px", borderBottom: `1px solid ${C.border}`, alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 900, color: p.rank <= 3 ? C.orange : C.textMuted }}>{p.rank}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18 }}>{p.emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{p.name}</span>
                    </div>
                    <div style={{ textAlign: "right", fontSize: 14, fontWeight: 900, color: C.text }}>{p.score.toLocaleString()}</div>
                    <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: p.rank <= 3 ? C.orange : C.textMuted }}>#{p.rank}</div>
                  </div>
                ))}
              </Card>
        )}

        {tab === "leaderboard" && (
          <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "7fr 5fr", gap: 24 }}>
            {/* Left: stats + podium + table */}
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
                {[
                  { label: "Avg Accuracy", value: avgAccuracy != null ? `${avgAccuracy}%` : "—", icon: "", color: C.green },
                  { label: "Top Score",    value: leaderboard[0]?.score != null ? leaderboard[0].score.toLocaleString() : "—", icon: "", color: C.orange },
                  { label: "Questions",    value: String(questionBreakdown.length || session?.questionCount || 0), icon: "", color: C.orange },
                ].map(m => (
                  <Card key={m.label}>
                    {m.icon && (
                      <div style={{
                        width: 28, height: 28, borderRadius: 8, background: m.color,
                        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, marginBottom: 8,
                      }}>{m.icon}</div>
                    )}
                    <p style={{ margin: 0, fontSize: 22, fontWeight: 900, color: C.text }}>{m.value}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 10, color: C.textSub }}>{m.label}</p>
                  </Card>
                ))}
              </div>

              {/* Podium */}
              <Card style={{ marginBottom: 20 }}>
                <p style={{ margin: "0 0 20px", fontSize: 10, fontWeight: 700, color: C.textSub, textTransform: "uppercase", letterSpacing: "0.08em" }}>Top 3</p>
                <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 16, paddingBottom: 8 }}>
                  {podiumDisplay.map((p, idx) => {
                    const rankIdx = idx === 0 ? 1 : idx === 1 ? 0 : 2;
                    const pc = podiumStyles[rankIdx];
                    return (
                      <div key={p.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 110 }}>
                        <span style={{ fontSize: 28 }}>{p.emoji}</span>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: C.text, textAlign: "center" }}>{p.name.split(" ")[0]}</p>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 900, color: C.orange }}>{p.score.toLocaleString()}</p>
                        <div style={{
                          width: "100%", height: pc.height, borderRadius: "8px 8px 0 0",
                          background: pc.bg, boxShadow: `0 4px 20px ${pc.glow}`,
                          display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 8,
                        }}>
                          <span style={{ fontSize: 22 }}>{pc.medal}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* Full table */}
              <Card style={{ padding: 0, overflow: "hidden" }}>
                <div style={{
                  display: "grid", gridTemplateColumns: "40px 1fr 80px 80px",
                  padding: "10px 20px", borderBottom: `1px solid ${C.border}`,
                  fontSize: 10, fontWeight: 700, color: C.textMuted,
                  letterSpacing: "0.06em", textTransform: "uppercase", background: C.muted,
                }}>
                  <div>#</div><div>Player</div>
                  <div style={{ textAlign: "right" }}>Score</div>
                  <div style={{ textAlign: "right" }}>Rank</div>
                </div>
                {leaderboard.map(p => (
                  <div key={p.name} style={{
                    display: "grid", gridTemplateColumns: "40px 1fr 80px 80px",
                    padding: "12px 20px", borderBottom: `1px solid ${C.border}`, alignItems: "center",
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 900, color: p.rank <= 3 ? C.orange : C.textMuted }}>{p.rank}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18 }}>{p.emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{p.name}</span>
                    </div>
                    <div style={{ textAlign: "right", fontSize: 14, fontWeight: 900, color: C.text }}>{p.score.toLocaleString()}</div>
                    <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: p.rank <= 3 ? C.orange : C.textMuted }}>#{p.rank}</div>
                  </div>
                ))}
              </Card>
            </div>

            {/* Right: highlights */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{
                borderRadius: 16, padding: 20,
                background: `linear-gradient(135deg, ${C.orange}, #FFD86A)`,
                border: `1px solid ${C.orangeBorder}`,
              }}>
                <p style={{ margin: "0 0 12px", fontSize: 10, fontWeight: 700, color: C.dark, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.7 }}>MVP</p>
                {leaderboard[0] ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 40 }}>{leaderboard[0].emoji}</span>
                    <div>
                      <p style={{ margin: 0, fontSize: 15, fontWeight: 900, color: C.dark }}>{leaderboard[0].name}</p>
                      <p style={{ margin: 0, fontSize: 11, color: C.dark, opacity: 0.65 }}>{leaderboard[0].score.toLocaleString()} pts</p>
                    </div>
                  </div>
                ) : <p style={{ margin: 0, fontSize: 13, color: C.dark, opacity: 0.5 }}>No data yet</p>}
              </div>

              {hardestQ && (
                <Card style={{ border: "1px solid rgba(244,63,94,0.2)" }}>
                  <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, color: "#E11D48", textTransform: "uppercase", letterSpacing: "0.1em" }}>Toughest Question</p>
                  <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600, color: C.text }}>{hardestQ.q}</p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 8, borderRadius: 99, overflow: "hidden", background: C.muted }}>
                      <div style={{ height: "100%", borderRadius: 99, width: `${Math.round((hardestQ.correct/Math.max(hardestQ.total,1))*100)}%`, background: C.red }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#E11D48", flexShrink: 0 }}>{hardestQ.correct}/{hardestQ.total}</span>
                  </div>
                </Card>
              )}

              {avgResponseMs != null && (
                <Card style={{ border: "1px solid rgba(132,204,22,0.2)" }}>
                  <p style={{ margin: "0 0 10px", fontSize: 10, fontWeight: 700, color: "#059669", textTransform: "uppercase", letterSpacing: "0.1em" }}>Avg Response Time</p>
                  <p style={{ margin: 0, fontSize: 22, fontWeight: 900, color: C.text }}>{avgResponseMs >= 1000 ? `${(avgResponseMs/1000).toFixed(1)}s` : `${avgResponseMs}ms`}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: C.textSub }}>per question across all players</p>
                </Card>
              )}

              {leaderboard.length > 0 && (() => {
                const maxScore = leaderboard[0]?.score || 1;
                const dist = [
                  { range: "Top 25%",  players: leaderboard.filter(p => p.score >= maxScore * 0.75), color: C.green   },
                  { range: "50–75%",   players: leaderboard.filter(p => p.score >= maxScore * 0.5 && p.score < maxScore * 0.75), color: C.orange },
                  { range: "25–50%",   players: leaderboard.filter(p => p.score >= maxScore * 0.25 && p.score < maxScore * 0.5), color: "#F59E0B" },
                  { range: "< 25%",    players: leaderboard.filter(p => p.score < maxScore * 0.25), color: C.red      },
                ];
                return (
                  <Card>
                    <p style={{ margin: "0 0 12px", fontSize: 10, fontWeight: 700, color: C.textSub, textTransform: "uppercase", letterSpacing: "0.08em" }}>Score Distribution</p>
                    {dist.map(d => (
                      <div key={d.range} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, marginBottom: 8 }}>
                        <span style={{ width: 52, textAlign: "right", color: C.textSub, fontWeight: 500 }}>{d.range}</span>
                        <div style={{ flex: 1, height: 16, borderRadius: 6, overflow: "hidden", background: C.muted }}>
                          <div style={{
                            height: "100%", borderRadius: 6, minWidth: d.players.length > 0 ? 28 : 0,
                            width: `${(d.players.length / leaderboard.length) * 100}%`, background: d.color,
                            display: "flex", alignItems: "center", paddingLeft: 8,
                            color: "#fff", fontSize: 10, fontWeight: 700,
                          }}>{d.players.length > 0 ? d.players.length : ""}</div>
                        </div>
                      </div>
                    ))}
                  </Card>
                );
              })()}
            </div>
          </div>
        )}

        {tab === "questions" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {questionBreakdown.length === 0 && <div style={{ textAlign: "center", padding: 60, color: C.textMuted, fontSize: 14 }}>No question data available</div>}
            {questionBreakdown.map((q, i) => {
              const pct   = Math.round((q.correct / Math.max(q.total,1)) * 100);
              const color = pct >= 80 ? "#059669" : pct >= 60 ? C.orange : C.red;
              const tc    = typeColors[q.type] ?? { bg: C.muted, text: C.textSub };
              return (
                <Card key={i}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 10, background: C.dark, color: "#fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 900, flexShrink: 0,
                    }}>Q{i+1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 12 }}>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: C.text }}>{q.q}</p>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 8, flexShrink: 0,
                          background: tc.bg, color: tc.text,
                        }}>{q.type}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                            <span style={{ color: C.textSub }}>{q.correct}/{q.total} correct</span>
                            <span style={{ fontWeight: 700, color }}>{pct}%</span>
                          </div>
                          <div style={{ height: 8, borderRadius: 99, overflow: "hidden", background: C.muted }}>
                            <div style={{ height: "100%", borderRadius: 99, width: `${pct}%`, background: color }} />
                          </div>
                        </div>
                        {q.avgMs > 0 && (
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <p style={{ margin: 0, fontSize: 10, color: C.textMuted }}>Avg time</p>
                            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>{(q.avgMs / 1000).toFixed(1)}s</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── NEW SESSION SCREEN ───────────────────────────────────────

function NewSessionScreen({ onNav, quizzes, onCreateSession }) {
  const [selectedId,  setSelectedId]  = useState(quizzes[0]?.id ?? null);
  const [sessionName, setSessionName] = useState(quizzes[0]?.name ?? "");
  const [demoMode,    setDemoMode]    = useState(false);
  const [creating,    setCreating]    = useState(false);

  const selectedQuiz = quizzes.find(q => q.id === selectedId);

  const selectQuiz = (quiz) => {
    setSelectedId(quiz.id);
    setSessionName(quiz.name);
  };

  const handleCreate = async () => {
    if (!selectedQuiz || !sessionName.trim() || creating) return;
    setCreating(true);
    try {
      await onCreateSession({
        code: String(Math.floor(100000 + Math.random() * 900000)),
        name: sessionName.trim(),
        quizId: selectedQuiz.id,
        questionCount: selectedQuiz.questions.length,
        status: "waiting",
        playerCount: 0,
        demoMode,
        players: [],
      });
    } finally {
      // Navigation fires setScreen inside onCreateSession; setCreating(false) is a
      // safety reset in case of an error (component stays mounted on failure).
      setCreating(false);
    }
  };

  return (
    <div style={{ maxWidth: 680, display: "flex", flexDirection: "column", gap: 28 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button onClick={() => onNav("rankd")} style={{
          padding: "8px 14px", borderRadius: 10, border: `1px solid ${C.border}`,
          background: C.white, color: C.textSub, fontSize: 13, fontWeight: 600, cursor: "pointer",
        }}>← Back</button>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900, color: C.text }}>New Game Session</h2>
          <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>Pick a quiz, name your session, generate a PIN</p>
        </div>
      </div>

      {/* Quiz picker */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Choose Quiz
          </label>
          <button onClick={() => onNav("rankd-quiz-builder")} style={{
            fontSize: 13, fontWeight: 700, color: C.orange, background: "transparent",
            border: "none", cursor: "pointer",
          }}>+ Build new quiz</button>
        </div>

        {quizzes.length === 0 ? (
          <div style={{
            padding: 40, borderRadius: 16, border: `2px dashed ${C.border}`,
            textAlign: "center", background: C.white,
          }}>
            
            <p style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "0 0 4px" }}>No quizzes yet</p>
            <p style={{ fontSize: 13, color: C.textSub, margin: "0 0 20px" }}>Build one first to launch a session</p>
            <button onClick={() => onNav("rankd-quiz-builder")} style={{
              padding: "10px 24px", borderRadius: 12, border: "none", cursor: "pointer",
              fontSize: 14, fontWeight: 700, background: C.orange, color: "#fff",
            }}>Build Your First Quiz →</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {quizzes.map(quiz => (
              <button key={quiz.id} onClick={() => selectQuiz(quiz)} style={{
                display: "flex", alignItems: "center", gap: 16, padding: "16px 20px", borderRadius: 14,
                border: `2px solid ${selectedId === quiz.id ? C.orange : C.border}`,
                background: selectedId === quiz.id ? C.orangeLight : C.white,
                cursor: "pointer", textAlign: "left",
              }}>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: selectedId === quiz.id ? C.orange : C.text }}>{quiz.name}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: C.textSub }}>
                    {quiz.questions.length} question{quiz.questions.length !== 1 ? "s" : ""} · Created {quiz.createdAt}
                  </p>
                </div>
                {selectedId === quiz.id && (
                  <div style={{
                    width: 24, height: 24, borderRadius: "50%", background: C.orange,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, color: "#fff", fontWeight: 900, flexShrink: 0,
                  }}>✓</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Session name */}
      {selectedQuiz && (
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", textTransform: "uppercase", display: "block", marginBottom: 8 }}>
            Session Name
          </label>
          <input
            value={sessionName}
            onChange={e => setSessionName(e.target.value)}
            placeholder="e.g. Q2 Battle Cards Blitz"
            style={{
              width: "100%", padding: "14px 16px", boxSizing: "border-box",
              borderRadius: 12, border: `2px solid ${sessionName.trim() ? C.orange : C.border}`,
              background: C.white, color: C.text, fontSize: 15, fontWeight: 700,
              outline: "none", fontFamily: "inherit",
            }}
          />
        </div>
      )}

      {/* Demo vs Real toggle */}
      {selectedQuiz && (
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", textTransform: "uppercase", display: "block", marginBottom: 10 }}>
            Session Mode
          </label>
          <div style={{ display: "flex", gap: 10 }}>
            {[
              { value: true,  label: "Demo Mode", desc: "Simulated players, instant launch" },
              { value: false, label: "Live Mode",  desc: "Real participants join via PIN" },
            ].map(opt => (
              <button key={String(opt.value)} onClick={() => setDemoMode(opt.value)} style={{
                flex: 1, padding: "14px 16px", borderRadius: 14, cursor: "pointer", textAlign: "left",
                border: `2px solid ${demoMode === opt.value ? C.orange : C.border}`,
                background: demoMode === opt.value ? C.orangeLight : C.white,
              }}>
                <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 800, color: demoMode === opt.value ? C.orange : C.text }}>{opt.label}</p>
                <p style={{ margin: 0, fontSize: 11, color: C.textSub }}>{opt.desc}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Create CTA */}
      {selectedQuiz && sessionName.trim() && (
        <div style={{
          padding: 20, borderRadius: 16, background: C.pageBg, border: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", gap: 16,
        }}>
          <div style={{ flex: 1 }}>
            <p style={{ margin: "0 0 2px", fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>Ready to go</p>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>{sessionName}</p>
            <p style={{ margin: 0, fontSize: 12, color: C.textSub }}>
              {selectedQuiz.questions.length} questions · {demoMode ? "Demo mode" : "Live mode"} · PIN auto-generated on create
            </p>
          </div>
          <button onClick={handleCreate} disabled={creating} style={{
            padding: "12px 28px", borderRadius: 14, border: "none",
            cursor: creating ? "not-allowed" : "pointer",
            fontSize: 14, fontWeight: 900,
            background: creating ? C.orange + "99" : C.orange,
            color: "#fff",
            boxShadow: creating ? "none" : "0 4px 20px rgba(253,191,36,0.28)",
            flexShrink: 0,
          }}>
            {creating ? "Launching…" : "Create Session →"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── QUIZ BUILDER SCREEN ──────────────────────────────────────

function QuizBuilderScreen({ onNav, onSave, initialQuiz }) {
  const mobile  = useMobile();
  const makeBlank = (type = "mc") => {
    const base = { id: `q_${Date.now()}_${Math.random().toString(36).slice(2)}`, q: "", type, timeLimit: 20 };
    switch (type) {
      case "mc":     return { ...base, options: ["","","",""], correct: 0, timeLimit: 20 };
      case "tf":     return { ...base, options: ["True","False"], correct: 0, timeLimit: 10 };
      case "type":   return { ...base, acceptedAnswers: [""], timeLimit: 30 };
      case "open":   return { ...base, timeLimit: 60 };
      case "slider": return { ...base, min: 0, max: 10, minLabel: "", maxLabel: "", correct: 5, tolerance: 1, timeLimit: 20 };
      case "pin":    return { ...base, imageUrl: "", correctX: 50, correctY: 50, tolerance: 15, timeLimit: 30 };
      case "match":  return { ...base, pairs: [{left:"",right:""},{left:"",right:""}], timeLimit: 45 };
      default: return base;
    }
  };

  const [name,      setName]      = useState(initialQuiz?.name ?? "");
  const [qs,        setQs]        = useState(
    initialQuiz?.questions?.length
      ? initialQuiz.questions.map(q => ({ ...q, id: q.id ?? `q_${Date.now()}_${Math.random()}` }))
      : [makeBlank()]
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const activeQ = qs[activeIdx];

  const updateQ  = (updates) => setQs(prev => prev.map((q, i) => i === activeIdx ? { ...q, ...updates } : q));
  const changeType = (type)  => { const b = makeBlank(type); updateQ({ ...b, q: activeQ.q, id: activeQ.id }); };
  const addQ     = ()        => { const nq = makeBlank(); setQs(prev => [...prev, nq]); setActiveIdx(qs.length); };
  const removeQ  = (idx)     => { if (qs.length <= 1) return; setQs(prev => prev.filter((_, i) => i !== idx)); setActiveIdx(Math.max(0, Math.min(activeIdx, qs.length - 2))); };
  const moveQ    = (from, to) => {
    if (to < 0 || to >= qs.length) return;
    setQs(prev => { const a = [...prev]; [a[from], a[to]] = [a[to], a[from]]; return a; });
    setActiveIdx(to);
  };

  const isQComplete = (q) => {
    // After dbToQuiz normalization both q.text and q.q are set. Check either so the
    // builder works with quizzes loaded from DB (which have text) and with freshly
    // created questions (which have q).
    if (!((q.text || q.q) ?? "").trim()) return false;
    switch (q.type) {
      case "mc":     return q.options?.length >= 2 && q.options.every(o => typeof o === "string" && o.trim());
      case "tf":     return true;
      case "type":   return q.acceptedAnswers?.some(a => a.trim());
      case "open":   return true;
      case "slider": return (q.min ?? 0) < (q.max ?? 10);
      case "pin":    return true;
      case "match":  return q.pairs?.length >= 2 && q.pairs.every(p => p.left.trim() && p.right.trim());
      default: return false;
    }
  };

  const canSave = name.trim() && qs.length > 0 && qs.every(isQComplete);

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      ...(initialQuiz ?? {}),
      id: initialQuiz?.id ?? Date.now().toString(),
      name: name.trim(),
      questions: qs,
      createdAt: initialQuiz?.createdAt ?? new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    });
  };

  const optLetters = ["A","B","C","D"];

  const renderTypeEditor = () => {
    if (!activeQ) return null;
    switch (activeQ.type) {
      // ── Multiple Choice ──
      case "mc": return (
        <div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
            <label style={{ fontSize:11, fontWeight:700, color:C.textSub, letterSpacing:"0.06em", textTransform:"uppercase" }}>Options — click ◯ to mark correct</label>
            {activeQ.options.length < 4 && (
              <button onClick={() => updateQ({ options: [...activeQ.options,""] })} style={{ fontSize:12, fontWeight:700, color:C.orange, background:"transparent", border:"none", cursor:"pointer" }}>+ option</button>
            )}
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {activeQ.options.map((opt, i) => (
              <div key={i} style={{ display:"flex", alignItems:"center", gap:8 }}>
                <button onClick={() => updateQ({ correct: i })} style={{
                  width:20, height:20, borderRadius:"50%", flexShrink:0, cursor:"pointer", padding:0, border:`2px solid ${activeQ.correct===i ? C.green : C.border}`,
                  background: activeQ.correct===i ? C.green : "transparent", display:"flex", alignItems:"center", justifyContent:"center",
                }}>
                  {activeQ.correct===i && <div style={{ width:7, height:7, borderRadius:"50%", background:"#fff" }} />}
                </button>
                <div style={{ width:28, height:28, borderRadius:8, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", background:OPTION_COLORS[i]?.bg ?? C.textSub, fontSize:11, fontWeight:900, color:"#fff" }}>{optLetters[i]}</div>
                <input value={opt} onChange={e => { const n=[...activeQ.options]; n[i]=e.target.value; updateQ({options:n}); }}
                  placeholder={`Option ${optLetters[i]}…`} style={{
                    flex:1, padding:"9px 12px", borderRadius:8, fontFamily:"inherit",
                    border:`2px solid ${activeQ.correct===i ? C.green : opt.trim() ? C.border : C.muted}`,
                    background: activeQ.correct===i ? C.greenBg : C.pageBg, color:C.text, fontSize:13, fontWeight:600, outline:"none",
                  }}
                />
                {activeQ.options.length > 2 && (
                  <button onClick={() => { const n=activeQ.options.filter((_,oi)=>oi!==i); updateQ({options:n, correct:activeQ.correct>=n.length?0:activeQ.correct}); }} style={{ width:26, height:26, borderRadius:6, border:"none", cursor:"pointer", background:C.pageBg, color:C.textMuted, fontSize:14, flexShrink:0 }}>×</button>
                )}
              </div>
            ))}
          </div>
        </div>
      );

      // ── True / False ──
      case "tf": return (
        <div style={{ display:"flex", gap:10 }}>
          {["True","False"].map((opt, i) => (
            <button key={opt} onClick={() => updateQ({ correct: i })} style={{
              flex:1, padding:16, borderRadius:12, cursor:"pointer",
              border:`2px solid ${activeQ.correct===i ? C.green : C.border}`,
              background: activeQ.correct===i ? C.greenBg : C.pageBg,
              fontSize:15, fontWeight:700, color: activeQ.correct===i ? C.green : C.text,
            }}>
              {i===0 ? "✓ " : "✗ "}{opt}
              {activeQ.correct===i && <span style={{ display:"block", fontSize:10, marginTop:4, color:C.green }}>Correct answer</span>}
            </button>
          ))}
        </div>
      );

      // ── Type Answer ──
      case "type": return (
        <div>
          <label style={{ fontSize:11, fontWeight:700, color:C.textSub, letterSpacing:"0.06em", textTransform:"uppercase", display:"block", marginBottom:10 }}>Accepted Answers (case-insensitive)</label>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {(activeQ.acceptedAnswers ?? [""]).map((ans, i) => (
              <div key={i} style={{ display:"flex", gap:8 }}>
                <div style={{ width:28, height:36, borderRadius:8, flexShrink:0, background:C.green, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:900, color:"#fff" }}>✓</div>
                <input value={ans} onChange={e => { const n=[...(activeQ.acceptedAnswers??[])]; n[i]=e.target.value; updateQ({acceptedAnswers:n}); }}
                  placeholder={`Accepted answer ${i+1}…`} style={{
                    flex:1, padding:"8px 12px", borderRadius:8, fontFamily:"inherit",
                    border:`2px solid ${ans.trim() ? C.green : C.border}`,
                    background: ans.trim() ? C.greenBg : C.pageBg, color:C.text, fontSize:13, fontWeight:600, outline:"none",
                  }}
                />
                {(activeQ.acceptedAnswers?.length ?? 1) > 1 && (
                  <button onClick={() => { const n=(activeQ.acceptedAnswers??[]).filter((_,ai)=>ai!==i); updateQ({acceptedAnswers:n}); }} style={{ width:28, height:36, borderRadius:8, border:"none", cursor:"pointer", background:C.pageBg, color:C.textMuted, fontSize:14, flexShrink:0 }}>×</button>
                )}
              </div>
            ))}
            <button onClick={() => updateQ({acceptedAnswers:[...(activeQ.acceptedAnswers??[]),""]}) } style={{ padding:"8px 16px", borderRadius:8, border:`1px dashed ${C.border}`, background:"transparent", color:C.textSub, fontSize:12, fontWeight:700, cursor:"pointer" }}>+ Add alternate answer</button>
          </div>
          <p style={{ margin:"10px 0 0", fontSize:11, color:C.textMuted }}>Add common variations and typos as alternates</p>
        </div>
      );

      // ── Open Ended ──
      case "open": return (
        <div style={{ padding: "16px 20px", borderRadius: 14, background: "#F5F3FF", border: "2px solid #DDD6FE" }}>
          <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 800, color: "#7C3AED" }}>Open-ended question</p>
          <p style={{ margin: 0, fontSize: 12, color: "#6D28D9" }}>Players type a free-form response. You grade all submissions manually before moving to the next question.</p>
        </div>
      );

      // ── Slider ──
      case "slider": return (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {[{key:"min",label:"Min Value",ph:"0"},{key:"max",label:"Max Value",ph:"10"}].map(f => (
              <div key={f.key}>
                <label style={{ fontSize:11, fontWeight:700, color:C.textSub, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:6 }}>{f.label}</label>
                <input type="number" value={activeQ[f.key] ?? (f.key==="min"?0:10)} onChange={e => updateQ({[f.key]:Number(e.target.value)})}
                  style={{ width:"100%", boxSizing:"border-box", padding:"9px 12px", borderRadius:8, border:`1px solid ${C.border}`, background:C.pageBg, color:C.text, fontSize:14, fontWeight:700, outline:"none", fontFamily:"inherit" }}
                />
              </div>
            ))}
            {[{key:"minLabel",label:"Min Label",ph:"Not at all"},{key:"maxLabel",label:"Max Label",ph:"Extremely"}].map(f => (
              <div key={f.key}>
                <label style={{ fontSize:11, fontWeight:700, color:C.textSub, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:6 }}>{f.label}</label>
                <input value={activeQ[f.key]??""} onChange={e => updateQ({[f.key]:e.target.value})} placeholder={f.ph}
                  style={{ width:"100%", boxSizing:"border-box", padding:"9px 12px", borderRadius:8, border:`1px solid ${C.border}`, background:C.pageBg, color:C.text, fontSize:13, outline:"none", fontFamily:"inherit" }}
                />
              </div>
            ))}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div>
              <label style={{ fontSize:11, fontWeight:700, color:C.textSub, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:6 }}>Correct Value</label>
              <input type="number" value={activeQ.correct??5} onChange={e => updateQ({correct:Number(e.target.value)})} min={activeQ.min??0} max={activeQ.max??10}
                style={{ width:"100%", boxSizing:"border-box", padding:"9px 12px", borderRadius:8, border:`2px solid ${C.green}`, background:C.greenBg, color:C.text, fontSize:14, fontWeight:700, outline:"none", fontFamily:"inherit" }}
              />
            </div>
            <div>
              <label style={{ fontSize:11, fontWeight:700, color:C.textSub, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:6 }}>Tolerance (±)</label>
              <input type="number" value={activeQ.tolerance??1} min={0} onChange={e => updateQ({tolerance:Number(e.target.value)})}
                style={{ width:"100%", boxSizing:"border-box", padding:"9px 12px", borderRadius:8, border:`1px solid ${C.border}`, background:C.pageBg, color:C.text, fontSize:14, fontWeight:700, outline:"none", fontFamily:"inherit" }}
              />
            </div>
          </div>
          <div style={{ padding:14, borderRadius:12, background:C.pageBg, border:`1px solid ${C.border}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.textSub, marginBottom:6 }}>
              <span>{activeQ.minLabel||"Min"} ({activeQ.min??0})</span>
              <span style={{ fontWeight:700, color:C.orange }}>✓ {activeQ.correct??5}</span>
              <span>{activeQ.maxLabel||"Max"} ({activeQ.max??10})</span>
            </div>
            <div style={{ position:"relative", height:6 }}>
              <div style={{ position:"absolute", inset:0, borderRadius:99, background:C.muted }} />
              <div style={{ position:"absolute", left:0, height:"100%", borderRadius:99, background:C.green,
                width:`${((activeQ.correct??5)-(activeQ.min??0))/((activeQ.max??10)-(activeQ.min??0))*100}%` }} />
            </div>
          </div>
        </div>
      );

      // ── Pin Answer ──
      case "pin": return (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:700, color:C.textSub, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:6 }}>Image URL (optional)</label>
            <input value={activeQ.imageUrl??""} onChange={e => updateQ({imageUrl:e.target.value})} placeholder="https://example.com/image.jpg"
              style={{ width:"100%", boxSizing:"border-box", padding:"9px 12px", borderRadius:8, border:`1px solid ${C.border}`, background:C.pageBg, color:C.text, fontSize:13, outline:"none", fontFamily:"inherit" }}
            />
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:700, color:C.textSub, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:8 }}>Click to set correct answer location</label>
            <div
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                updateQ({ correctX: Math.round(((e.clientX-rect.left)/rect.width)*100), correctY: Math.round(((e.clientY-rect.top)/rect.height)*100) });
              }}
              style={{
                position:"relative", height:180, borderRadius:12, cursor:"crosshair", overflow:"hidden",
                background: activeQ.imageUrl ? `url(${activeQ.imageUrl}) center/cover no-repeat` : `linear-gradient(135deg,${C.dark}33,${C.dark}66)`,
                border:`2px dashed ${C.border}`,
              }}
            >
              {[33,66].map(p => <div key={`v${p}`} style={{ position:"absolute",left:`${p}%`,top:0,bottom:0,width:1,background:"rgba(0,0,0,0.1)" }} />)}
              {[33,66].map(p => <div key={`h${p}`} style={{ position:"absolute",top:`${p}%`,left:0,right:0,height:1,background:"rgba(0,0,0,0.1)" }} />)}
              {!activeQ.imageUrl && (
                <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:6 }}>
                  <span style={{ fontSize:22 }}>●</span>
                  <p style={{ margin:0,fontSize:12,color:C.textMuted }}>Click to set the correct spot</p>
                </div>
              )}
              {activeQ.correctX !== undefined && (
                <div style={{ position:"absolute",left:`${activeQ.correctX}%`,top:`${activeQ.correctY}%`,transform:"translate(-50%,-100%)",fontSize:22,pointerEvents:"none" }}>●</div>
              )}
            </div>
            {activeQ.correctX !== undefined && (
              <p style={{ margin:"6px 0 0", fontSize:11, color:"#059669", fontWeight:600 }}>✓ Set at ({activeQ.correctX}%, {activeQ.correctY}%)</p>
            )}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <label style={{ fontSize:11, fontWeight:700, color:C.textSub, textTransform:"uppercase", letterSpacing:"0.06em", whiteSpace:"nowrap" }}>Tolerance radius (%)</label>
            <input type="number" min={1} max={50} value={activeQ.tolerance??15} onChange={e => updateQ({tolerance:Number(e.target.value)})}
              style={{ width:70, padding:"7px 10px", borderRadius:8, border:`1px solid ${C.border}`, background:C.pageBg, color:C.text, fontSize:13, fontWeight:700, outline:"none", fontFamily:"inherit" }}
            />
          </div>
        </div>
      );

      // ── Matching ──
      case "match": return (
        <div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
            <label style={{ fontSize:11, fontWeight:700, color:C.textSub, letterSpacing:"0.06em", textTransform:"uppercase" }}>Matching Pairs</label>
            <button onClick={() => updateQ({pairs:[...(activeQ.pairs??[]),{left:"",right:""}]})} style={{ fontSize:12, fontWeight:700, color:C.orange, background:"transparent", border:"none", cursor:"pointer" }}>+ Add pair</button>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr auto", gap:"6px 8px", alignItems:"center", marginBottom:8 }}>
            <span style={{ fontSize:10, fontWeight:700, color:C.textMuted, textTransform:"uppercase", letterSpacing:"0.06em" }}>Prompt</span>
            <div />
            <span style={{ fontSize:10, fontWeight:700, color:C.textMuted, textTransform:"uppercase", letterSpacing:"0.06em" }}>Match</span>
            <div />
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {(activeQ.pairs ?? []).map((pair, i) => (
              <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr auto", gap:"0 8px", alignItems:"center" }}>
                <input value={pair.left} onChange={e => { const p=[...(activeQ.pairs??[])]; p[i]={...p[i],left:e.target.value}; updateQ({pairs:p}); }}
                  placeholder={`Prompt ${i+1}…`} style={{
                    padding:"9px 12px", borderRadius:8, fontFamily:"inherit",
                    border:`2px solid ${pair.left.trim() ? C.border : C.muted}`, background:C.pageBg, color:C.text, fontSize:13, fontWeight:600, outline:"none",
                  }}
                />
                <div style={{ fontSize:16, color:C.orange, fontWeight:900, textAlign:"center", padding:"0 4px" }}>↔</div>
                <input value={pair.right} onChange={e => { const p=[...(activeQ.pairs??[])]; p[i]={...p[i],right:e.target.value}; updateQ({pairs:p}); }}
                  placeholder={`Match ${i+1}…`} style={{
                    padding:"9px 12px", borderRadius:8, fontFamily:"inherit",
                    border:`2px solid ${pair.right.trim() ? C.green : C.muted}`,
                    background: pair.right.trim() ? C.greenBg : C.pageBg, color:C.text, fontSize:13, fontWeight:600, outline:"none",
                  }}
                />
                {(activeQ.pairs?.length ?? 0) > 2 ? (
                  <button onClick={() => { const p=(activeQ.pairs??[]).filter((_,pi)=>pi!==i); updateQ({pairs:p}); }} style={{ width:28, height:36, borderRadius:6, border:"none", cursor:"pointer", background:C.pageBg, color:C.textMuted, fontSize:14 }}>×</button>
                ) : <div />}
              </div>
            ))}
          </div>
          <p style={{ margin:"10px 0 0", fontSize:11, color:C.textMuted }}>Pairs will be scrambled for players to match</p>
        </div>
      );

      default: return null;
    }
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", gap:0 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:14, paddingBottom:20, marginBottom:20, borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <button onClick={() => onNav("quizzes")} style={{ padding:"8px 14px", borderRadius:10, border:`1px solid ${C.border}`, background:C.white, color:C.textSub, fontSize:13, fontWeight:600, cursor:"pointer", flexShrink:0 }}>← Back</button>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Quiz name…" style={{
          flex:1, fontSize:20, fontWeight:900, color:C.text, border:"none", background:"transparent", outline:"none", fontFamily:"inherit",
          borderBottom:`2px solid ${name.trim() ? C.orange : C.border}`, paddingBottom:4,
        }} />
        <div style={{ fontSize:12, color: canSave ? "#059669" : C.textMuted, fontWeight:600, flexShrink:0 }}>
          {canSave ? `✓ ${qs.length} q${qs.length!==1?"s":""} ready` : `${qs.filter(isQComplete).length} / ${qs.length} complete`}
        </div>
        <button onClick={handleSave} disabled={!canSave} style={{ padding:"10px 24px", borderRadius:12, border:"none", cursor:canSave?"pointer":"not-allowed", fontSize:14, fontWeight:700, color:"#fff", background:canSave?C.orange:C.muted, flexShrink:0 }}>Save Quiz</button>
      </div>

      {/* Two-panel */}
      <div style={{ flex:1, display:"grid", gridTemplateColumns: mobile ? "1fr" : "240px 1fr", gridTemplateRows: mobile ? "auto 1fr" : undefined, gap:20, minHeight:0 }}>

        {/* Left: question list */}
        <div style={{ background:C.white, borderRadius:16, border:`1px solid ${C.border}`, display:"flex", flexDirection:"column", overflow:"hidden", maxHeight: mobile ? 220 : undefined }}>
          <div style={{ padding:"12px 14px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
            <span style={{ fontSize:12, fontWeight:700, color:C.textSub }}>{qs.length} Question{qs.length!==1?"s":""}</span>
            <button onClick={addQ} style={{ padding:"4px 10px", borderRadius:8, border:"none", cursor:"pointer", fontSize:12, fontWeight:700, background:C.orange, color:"#fff" }}>+ Add</button>
          </div>
          <div style={{ flex:1, overflowY:"auto" }}>
            {qs.map((q, i) => {
              const done = isQComplete(q), active = i === activeIdx;
              const qt   = Q_TYPES.find(t => t.id === q.type);
              return (
                <div key={q.id} onClick={() => setActiveIdx(i)} style={{
                  display:"flex", alignItems:"center", gap:8, padding:"10px 12px", cursor:"pointer",
                  borderBottom:`1px solid ${C.border}`, borderLeft:`3px solid ${active?C.orange:"transparent"}`,
                  background: active ? C.orangeLight : "transparent",
                }}>
                  <div style={{ width:22, height:22, borderRadius:7, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:900, background:done?C.green:active?C.orange:C.muted, color:(done||active)?"#fff":C.textMuted }}>
                    {done ? "✓" : i+1}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:11, fontWeight:600, color:active?C.orange:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{q.q||"Untitled"}</p>
                    <p style={{ margin:0, fontSize:10, color:C.textMuted }}>{qt?.label} · {q.timeLimit}s</p>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:1 }}>
                    <button onClick={e=>{e.stopPropagation();moveQ(i,i-1);}} style={{ padding:0,width:14,height:12,border:"none",background:"transparent",cursor:i>0?"pointer":"default",fontSize:8,color:i>0?C.textSub:C.muted }}>▲</button>
                    <button onClick={e=>{e.stopPropagation();moveQ(i,i+1);}} style={{ padding:0,width:14,height:12,border:"none",background:"transparent",cursor:i<qs.length-1?"pointer":"default",fontSize:8,color:i<qs.length-1?C.textSub:C.muted }}>▼</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: editor */}
        {activeQ ? (
          <div style={{ background:C.white, borderRadius:16, border:`1px solid ${C.border}`, padding:24, overflowY:"auto", display:"flex", flexDirection:"column", gap:22 }}>
            {/* Q number + remove */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:34, height:34, borderRadius:10, background:C.dark, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:900 }}>Q{activeIdx+1}</div>
                <span style={{ fontSize:13, fontWeight:700, color:C.textSub }}>of {qs.length}</span>
              </div>
              {qs.length > 1 && (
                <button onClick={() => removeQ(activeIdx)} style={{ padding:"6px 12px", borderRadius:8, border:`1px solid ${C.border}`, background:C.white, color:C.red, fontSize:12, fontWeight:700, cursor:"pointer" }}>Remove</button>
              )}
            </div>

            {/* Question type grid */}
            <div>
              <label style={{ fontSize:11, fontWeight:700, color:C.textSub, letterSpacing:"0.06em", textTransform:"uppercase", display:"block", marginBottom:10 }}>Question Type</label>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
                {Q_TYPES.map(t => (
                  <button key={t.id} onClick={() => changeType(t.id)} style={{
                    display:"flex", alignItems:"center", gap:8, padding:"10px 12px", borderRadius:10,
                    border:`2px solid ${activeQ.type===t.id ? t.color : C.border}`,
                    background: activeQ.type===t.id ? `${t.color}12` : C.pageBg,
                    cursor:"pointer", textAlign:"left",
                  }}>
                    {t.icon && <span style={{ fontSize:15 }}>{t.icon}</span>}
                    <span style={{ fontSize:11, fontWeight:700, color:activeQ.type===t.id?t.color:C.text, lineHeight:1.2 }}>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Question text */}
            <div>
              <label style={{ fontSize:11, fontWeight:700, color:C.textSub, letterSpacing:"0.06em", textTransform:"uppercase" }}>Question</label>
              <textarea value={activeQ.q} onChange={e => updateQ({q:e.target.value})} placeholder="Type your question here…" rows={2}
                style={{ width:"100%", marginTop:8, padding:"12px 14px", boxSizing:"border-box", borderRadius:10, border:`2px solid ${activeQ.q.trim()?C.orange:C.border}`, background:C.pageBg, color:C.text, fontSize:14, fontWeight:600, lineHeight:1.5, resize:"vertical", outline:"none", fontFamily:"inherit" }}
              />
            </div>

            {/* Type-specific editor */}
            {renderTypeEditor()}

            {/* Time limit */}
            <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
              <span style={{ fontSize:12, fontWeight:700, color:C.textSub, whiteSpace:"nowrap" }}>⏱ Time</span>
              {[10,15,20,30,45,60].map(t => (
                <button key={t} onClick={() => updateQ({timeLimit:t})} style={{
                  padding:"5px 11px", borderRadius:8, border:"none", cursor:"pointer", fontSize:12, fontWeight:700,
                  background: activeQ.timeLimit===t ? C.orange : C.pageBg,
                  color: activeQ.timeLimit===t ? "#fff" : C.textSub,
                }}>{t}s</button>
              ))}
              <button
                onClick={() => setQs(prev => prev.map(q => ({ ...q, timeLimit: activeQ.timeLimit })))}
                title={`Apply ${activeQ.timeLimit}s to all questions`}
                style={{
                  padding:"5px 11px", borderRadius:8, border:`1px dashed ${C.border}`, cursor:"pointer", fontSize:11, fontWeight:700,
                  background:"transparent", color:C.textSub, whiteSpace:"nowrap",
                }}
              >Apply all</button>
            </div>

            {isQComplete(activeQ) && (
              <div style={{ padding:"10px 14px", borderRadius:10, background:C.greenBg, border:`1px solid rgba(16,185,129,0.2)` }}>
                <p style={{ margin:0, fontSize:12, fontWeight:700, color:"#059669" }}>✓ Question complete</p>
              </div>
            )}
          </div>
        ) : (
          <div style={{ background:C.white, borderRadius:16, border:`1px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <div style={{ textAlign:"center" }}>
              
              <p style={{ fontSize:14, color:C.textSub, margin:0 }}>Add a question to get started</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── LEARN SCREEN ────────────────────────────────────────────

const lessons = [
  { num: 1, title: "Prospecting Fundamentals", duration: "22 min", xp: 120, done: true },
  { num: 2, title: "Discovery Call Framework", duration: "18 min", xp: 100, done: true },
  { num: 3, title: "Building a Value Proposition", duration: "25 min", xp: 130, done: false },
  { num: 4, title: "Handling Price Objections", duration: "30 min", xp: 150, active: true },
  { num: 5, title: "Competitive Differentiation", duration: "20 min", xp: 120, done: false },
  { num: 6, title: "Executive Stakeholder Mapping", duration: "28 min", xp: 140, done: false },
  { num: 7, title: "Multi-threading Deals", duration: "22 min", xp: 110, done: false },
];

const frameworkSteps = [
  { num: "01", title: "Acknowledge", desc: "Validate the concern without agreeing with it" },
  { num: "02", title: "Reframe Value", desc: "Connect to the business outcome they care about most" },
  { num: "03", title: "Anchor to ROI", desc: "Make the price feel small relative to the outcome" },
];

// ── LEARN DATA ─────────────────────────────────────────────

const INITIAL_LEARN_LESSONS = [
  { id: "ll1", title: "Cold Call Opening Framework", type: "video", duration: "20 min", xp: 120, status: "active",
    description: "Master the first 15 seconds of every cold call. Frameworks for pattern-interrupts, permission-based openers, and instant rapport.",
    content: { videoUrl: "", // Production: replace with CDN video URL
      notes: "The Cold Call Opening Framework\n\nThe first 15 seconds determine whether you get a conversation or a hangup. Most reps blow it with a weak opener.\n\nThe Pattern-Interrupt Opener\nAvoid: \"Hi, is this a bad time?\" or \"I know you're busy but...\"\nInstead, use confident directness: \"Hey [Name], this is [Your Name] from [Company]. I'll be brief.\"\n\nPermission-Based Opening\nAsk for 27 seconds: \"I promise I'll be under 30 seconds — if it's not relevant I'll hang up first. Fair?\"\nThis disarms resistance and demonstrates respect for their time.\n\nThe 15-Second Value Frame\nStructure: [Who you help] + [Problem you solve] + [Proof point]\nExample: \"We help enterprise sales teams cut ramp time by 40%. We just did it for a team of 85 reps at Gong. Worth a 20-minute call?\"\n\nKey Rules\n- Never apologize for calling\n- Use their first name once, early\n- End every opener with a yes/no question\n- If they say \"not interested\" — that's your starting point, not your ending point" } },
  { id: "ll2", title: "Price Objection Response Playbook", type: "text", duration: "25 min", xp: 150, status: "active",
    description: "The 3-step reframe: Acknowledge → Value Bridge → ROI Anchor. Includes word-for-word scripts for common pushbacks.",
    content: { body: "Price Objection Response Playbook\n\nPrice objections are almost never about price. They're about unclear value. Here's how to reframe every time.\n\nThe 3-Step Framework\n\n1. Acknowledge\nNever argue. Never get defensive. Validate the concern first.\n\"I hear you — at first glance the number does feel significant.\"\n\n2. Value Bridge\nConnect the investment back to the outcome they said they care about.\n\"You mentioned that rep ramp time is costing you 60-90 days of productivity per hire. What's that worth annually?\"\n\n3. ROI Anchor\nMake the price feel small next to the outcome.\n\"At [Price], you're looking at 3-4 months to break even — if we cut ramp by even 30%, you're positive in month one.\"\n\nCommon Objections and Scripts\n\n\"It's too expensive.\"\n→ \"Compared to what? Let's figure out the baseline cost of the problem first.\"\n\n\"We don't have budget.\"\n→ \"Is it a budget timing issue or a priority issue? Those have different solutions.\"\n\n\"I need to think about it.\"\n→ \"Totally fair. What specifically would make this a clear yes or no for you?\"\n\n\"Your competitor is cheaper.\"\n→ \"They might be. Are you optimizing for lowest cost or best outcome? Let's look at both.\"\n\nPractice This\nRecord yourself handling price objections. Play it back. Do you sound confident or apologetic? Confidence in price is a leading indicator of close rate." } },
  { id: "ll3", title: "Discovery Call Structure", type: "video", duration: "30 min", xp: 175, status: "active",
    description: "SPICED framework for structured discovery. Situation, Pain, Impact, Critical Event, Decision.",
    content: { videoUrl: "", // Production: replace with CDN video URL
      notes: "SPICED Discovery Framework\n\nMost discovery calls are interrogations. SPICED turns them into consultations.\n\nS — Situation\nUnderstand the current state before diagnosing anything.\nQuestions: \"Walk me through how your team handles [X] today.\" / \"What does your current stack look like?\"\nPitfall: Spending too long here. 2-3 questions max.\n\nP — Pain\nSurface the specific, felt problem — not just the symptom.\nQuestions: \"Where does that process break down?\" / \"What does that cost you in time or headcount?\"\nRule: Don't move forward until you can articulate their pain in their own language.\n\nI — Impact\nQuantify the pain. This becomes your ROI anchor later.\nQuestions: \"How often does this happen?\" / \"If you fixed this, what would that unlock?\"\nTarget: A number. Revenue, time, headcount, risk.\n\nC — Critical Event\nFind the forcing function. What happens if they do nothing?\nQuestions: \"Is there a date or event that makes this more urgent?\" / \"What's the cost of waiting another quarter?\"\nNote: No critical event = no deal urgency.\n\nE — Decision\nMap the buying process before you propose anything.\nQuestions: \"Who else is involved?\" / \"What does your evaluation process look like?\" / \"What would need to be true to move forward?\"\n\nRunning the Call\nOpen with agenda, time check, and permission to ask direct questions.\nClose with: summarize their pain, confirm the impact, ask \"Do you see value in a deeper look?\"" } },
  { id: "ll4", title: "Handling the 'Not Interested' Objection", type: "text", duration: "15 min", xp: 100, status: "active",
    description: "Turn early rejections into conversations with curiosity-based redirects.",
    content: { body: "Handling \"Not Interested\"\n\n\"Not interested\" is not a no. It's an untriggered yes. Here's how to turn it around.\n\nWhy They Say It\n- They don't know why it's relevant yet\n- They've been pitched badly before\n- They're testing to see if you'll fight for the conversation\n- They actually aren't interested (rare in a well-targeted call)\n\nThe Core Technique: Curious, Not Defensive\nMost reps hear \"not interested\" and either fold or get pushy. Do neither. Get curious.\n\nScript 1 — The Honest Redirect\n\"Fair enough. Before I let you go — I don't want to waste your time or mine. Can I ask what [problem area] looks like for you? If it's not a fit, I'll tell you.\"\n\nScript 2 — The Specificity Challenge\n\"That's fine. What part aren't you interested in? The timing, the category, or how we specifically help [their role]?\"\nThis forces them to be specific, which opens a real conversation.\n\nScript 3 — The Concession Close\n\"Understood. One quick question first: what would have to be different for a conversation like this to be worth your time?\"\nThis reframes the interaction as future-focused.\n\nWhen to Let Go\nIf they've said no twice with specificity, respect it. Log the call, set a 90-day follow-up, and move on.\n\nPractice Drill\nPair up. One rep says \"not interested\" after every opener. Practice landing on question 3 every time without sounding scripted." } },
  { id: "ll5", title: "Multi-Threading Your Deals", type: "interactive", duration: "35 min", xp: 200, status: "active",
    description: "Map stakeholders, build a champion, and create internal urgency across the buying committee.",
    content: { body: "Multi-Threading Your Deals\n\nSingle-threaded deals die. If your only contact leaves, gets promoted, or goes dark — your deal is gone. Multi-threading is insurance and acceleration.\n\nThe Stakeholder Map\nEvery deal has four types:\n- Champion: Wants you to win. Coaches you, sells internally.\n- Economic Buyer: Writes the check. Often not in the first call.\n- Technical Evaluator: Vets the solution. Blockers if ignored.\n- End User: Uses the product daily. Their voice matters in PoC reviews.\n\nBuilding Your Champion\nA champion needs three things:\n1. Pain — they feel the problem personally\n2. Power — they can influence the decision\n3. Motivation — they have something to gain from your solution\n\nScript: \"I want to make sure you look good through this process. Here's what I need to make a strong case internally — can we build that together?\"\n\nHow to Multi-Thread Without Burning Your Champion\n- Always ask permission: \"Would it make sense to loop in [Economic Buyer] directly?\"\n- Give your champion the agenda before any multi-stakeholder call\n- Never go around your champion — go through them\n\nCreating Internal Urgency\nGive your champion tools to sell when you're not in the room:\n- A one-pager they can forward\n- ROI numbers in their language\n- Answers to the top 3 objections their boss will raise\n\nDeal Health Check\nIf you can't name a champion, an economic buyer, and a critical event — the deal is not real." } },
  { id: "ll6", title: "Competitive Positioning vs. Salesforce", type: "text", duration: "20 min", xp: 130, status: "active",
    description: "Battlecard-style positioning guide for the most common competitive displacement scenario.",
    content: { body: "Competitive Positioning vs. Salesforce\n\nSalesforce wins on brand recognition and integration breadth. You win on specificity, speed, and outcomes.\n\nWhere Salesforce Is Weak\n- Complexity: Average implementation takes 6-18 months and requires dedicated admins\n- Cost: License + implementation + customization = 3-5x sticker price\n- Adoption: 40%+ of seats go unused within 12 months (Gartner)\n- Sales insight: SFDC is a data warehouse, not a coaching tool\n\nYour Positioning Wedge\nDon't attack Salesforce — attack the gap Salesforce leaves.\n\"Salesforce tells you what happened. We help your reps get better at what's happening next.\"\n\nWhen a Prospect Uses Salesforce\n\"We actually integrate with Salesforce — this isn't either/or. Your ops team keeps SFDC, your reps get ralli on top of it. We fill the coaching and readiness gap that SFDC doesn't touch.\"\n\nHead-to-Head Questions\n\"Are your reps actually logging calls in Salesforce, or is that a battle every quarter?\"\n\"What does your rep onboarding look like? How long until a new hire is ramped?\"\n\"If Salesforce is solving the problem, why are we talking?\"\n\nCommon SFDC Objections\n\"We already have Salesforce for this.\"\n→ \"SFDC is your system of record. We're a system of action — complementary, not competing.\"\n\n\"We don't want another tool.\"\n→ \"What if it lived inside Salesforce? Would that change the conversation?\"\n\nWin Signals\n- 50-500 reps, growing fast\n- High rep turnover or long ramp times\n- Manager-to-rep ratio above 1:12\n- Recent SFDC implementation that didn't stick" } },
  { id: "ll7", title: "Executive Outreach Messaging", type: "video", duration: "25 min", xp: 150, status: "inactive",
    description: "Board-level language, brevity, and outcome framing for VP+ outbound.",
    content: { videoUrl: "", // Production: replace with CDN video URL
      notes: "Executive Outreach Messaging\n\nVPs and C-suite get 200+ cold emails per week. Here's how to be the one they read.\n\nThe Fundamental Rule\nExecutives care about three things: revenue, risk, and time. Write to one of those. Nothing else.\n\nSubject Line Formula\n- \"[Outcome] for [Company]\" — \"Pipeline velocity for Momence\"\n- \"[Peer company] result\" — \"How Gong cut rep ramp by 6 weeks\"\n- \"Quick question\" — only works when your question is specific and truly quick\n\nThe 4-Sentence Email\n1. Who you help and what outcome (one sentence)\n2. Relevant proof point or peer company (one sentence)\n3. Specific hypothesis about their situation (one sentence)\n4. Low-friction ask (one sentence)\n\nExample\n\"We help VP Sales at mid-market SaaS companies cut rep ramp from 4 months to 6 weeks.\nWe just did this for Rippling's 80-person sales org.\nBased on your recent SDR hire announcements, I'd guess ramp is on your radar.\nWorth a 20-minute call this week or next?\"\n\nWhat Not to Do\n- Don't start with \"I\" — start with them or an outcome\n- Don't list features\n- Don't attach anything\n- Don't ask for \"a quick 15 minutes to learn about your needs\"\n\nFollow-Up Cadence\nDay 1: Email. Day 3: LinkedIn connect. Day 7: Follow-up email. Day 14: Phone + voicemail. Day 21: Final breakup email.\nNo response after 5 touches over 21 days → 90-day recycle." } },
  { id: "ll8", title: "Forecasting Accuracy Fundamentals", type: "text", duration: "20 min", xp: 120, status: "active",
    description: "CRM hygiene, stage progression criteria, and deal health signals that matter.",
    content: { body: "Forecasting Accuracy Fundamentals\n\nBad forecasting is a trust problem. Reps who can't forecast accurately lose credibility with managers. Here's how to fix it.\n\nWhy Forecasts Are Wrong\n- Reps are optimistic by nature\n- Stage criteria are subjective or undefined\n- No forcing functions (critical events) are identified\n- Deals sit in a stage too long without a decision\n\nThe Four Forecast Categories\n- Commit: You will close this. You'd bet your quota on it.\n- Most Likely: You expect to close it. One thing could move it out.\n- Upside: Real opportunity, but needs a push to close this period.\n- Pipeline: Active, but not closing this quarter.\n\nStage Progression Criteria\nA deal should not advance without a specific action completed:\n- Stage 2: Pain confirmed, next step set\n- Stage 3: Economic buyer identified and met\n- Stage 4: Technical validation complete, champion confirmed\n- Stage 5: Proposal sent and reviewed (not just sent)\n- Stage 6: Legal/procurement engaged, verbal close received\n\nDeal Health Red Flags\n- Single-threaded (one contact only)\n- No critical event identified\n- \"Following up\" as the only next step\n- Last activity over 14 days ago\n- Discount requested before Stage 4\n\nCRM Hygiene Rules\n- Update stage the day it changes, not the day before 1:1\n- Close dates should reflect when the customer will decide, not when you want to hit your number\n- Add a note after every call — one sentence minimum\n\nThe Weekly Forecast Review\nCome prepared with: deal history, next step, critical event, and what could kill it. \"It's moving forward\" is not a forecast — it's a hope." } },
];

const INITIAL_LEARN_COURSES = [
  {
    id: "lc1",
    title: "Objection Handling Mastery",
    description: "A complete playbook for the most common sales objections — from price and timing to competitor and authority objections.",
    lessonIds: ["ll1", "ll2", "ll4"],
    status: "active",
    createdAt: "Jun 1",
    emoji: "",
    color: C.orange,
  },
  {
    id: "lc2",
    title: "SDR Core Fundamentals",
    description: "The foundational skill set every SDR needs to ramp faster, book more meetings, and build pipeline that actually closes.",
    lessonIds: ["ll1", "ll3", "ll5"],
    status: "active",
    createdAt: "May 20",
    emoji: "",
    color: C.blue,
  },
  {
    id: "lc3",
    title: "Enterprise Deal Strategy",
    description: "Navigate complex buying committees, build champions, and multi-thread across stakeholders to win larger deals.",
    lessonIds: ["ll5", "ll6", "ll7", "ll8"],
    status: "active",
    createdAt: "Jun 10",
    emoji: "",
    color: C.purple,
  },
];

const INITIAL_ASSIGNMENTS = [
  { id: "a1", contentType: "course",  contentId: "lc1", assignedTo: { type: "group",      orgId: "org_momence" },  assignedAt: "Jun 15", dueAt: "Jun 30" },
  { id: "a2", contentType: "lesson",  contentId: "ll3", assignedTo: { type: "individual", userId: "marcus"       }, assignedAt: "Jun 18", dueAt: "Jun 25" },
  { id: "a3", contentType: "course",  contentId: "lc2", assignedTo: { type: "group",      orgId: "org_finpilot"  }, assignedAt: "Jun 20", dueAt: "Jul 5"  },
  { id: "a4", contentType: "lesson",  contentId: "ll6", assignedTo: { type: "individual", userId: "devon"        }, assignedAt: "Jun 21", dueAt: "Jun 28" },
];

const LESSON_TYPE_ICONS  = { video:"", text:"", image:"", flipcard:"", quiz:"", recording:"", interactive:"" };
const LESSON_TYPE_COLORS = { video:C.blue, text:C.green, image:C.blue, flipcard:C.purple, quiz:C.purple, recording:C.red, interactive:C.orange };

function LearnScreen({ role, user, orgUsers = [], orgs = [], onNav, onAwardXp, pendingLessonId, onClearPendingLesson, pendingCourseId, onClearPendingCourse, canCreate = true, canEdit = true, canDelete = true, canAssign = true, tenantId = null, isReal = false, quizzes = [] }) {
  const isAdmin = role === "admin";
  const toast   = useToast();
  const [tab, setTab]           = useState(isAdmin ? "courses" : "assigned");
  // Real users start with empty arrays — seed data would flash before DB load completes
  const [courses, setCourses]   = useState(isReal ? [] : INITIAL_LEARN_COURSES);
  const [lessons, setLessons]   = useState(isReal ? [] : INITIAL_LEARN_LESSONS);
  const [assignments, setAssignments] = useState(isReal ? [] : INITIAL_ASSIGNMENTS);
  const [isLearnLoading, setIsLearnLoading] = useState(isReal); // cleared once DB load resolves

  // Modals
  const [courseModal, setCourseModal]   = useState(null); // null | "new" | course object
  const [lessonModal, setLessonModal]   = useState(null); // null | "new" | lesson object
  const [assignModal, setAssignModal]   = useState(null); // null | { contentType, contentId }
  const [activeLesson, setActiveLesson] = useState(null); // { lesson, courseTitle?, nextLesson? }
  const [activeCourse, setActiveCourse] = useState(null); // course object for detail view
  // Progress — for real users Supabase is the sole source of truth (loaded below).
  // For demo users, localStorage provides persistence across page refreshes.
  const [completedLessons, setCompletedLessons] = useState(() => {
    if (isReal) return new Set(); // avoid seeding with stale localStorage IDs
    try {
      const saved = localStorage.getItem(`ralli_learn_progress_${user?.id ?? "guest"}`);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [userTab,    setUserTab]    = useState("assigned");
  const [learnFilter, setLearnFilter] = useState("due"); // "due" | "complete" | "all"
  const [search,     setSearch]     = useState("");
  const [archivedCourses,   setArchivedCourses]   = useState([]);
  const [archivedLessons,   setArchivedLessons]   = useState([]);
  const [confirmArchive,    setConfirmArchive]    = useState(null); // { type: "course"|"lesson", id, title }
  const [archiveInFlight,  setArchiveInFlight]  = useState(new Set()); // IDs currently being archived/restored
  const [tenantCompletions, setTenantCompletions] = useState([]); // manager/admin only
  const [selectedAssignmentId, setSelectedAssignmentId] = useState(null); // manager click-through
  const [assignTimeframe,  setAssignTimeframe]  = useState("all"); // "all" | "week" | "month" | "custom"
  const [assignDateRange,  setAssignDateRange]  = useState({ start: "", end: "" }); // ISO date strings for custom range

  // ── Load content from Supabase for real users ────────────────────────────
  useEffect(() => {
    if (!isReal || !tenantId) return;
    Promise.all([
      getTenantCourses(tenantId),
      getTenantLessons(tenantId),
      getTenantAssignments(tenantId),
    ]).then(([{ data: dbCourses }, { data: dbLessons }, { data: dbAssignments }]) => {
      // Real tenants always start blank — replace seed data (empty array if no content yet)
      setCourses(dbCourses ?? []);
      setLessons(dbLessons ?? []);
      setAssignments(dbAssignments ?? []);
      setIsLearnLoading(false);
    }).catch(() => setIsLearnLoading(false));
    // Load archived content and all tenant completions for manager view
    if (isAdmin) {
      getArchivedContent(tenantId).then(({ data }) => {
        if (data) { setArchivedCourses(data.courses ?? []); setArchivedLessons(data.lessons ?? []); }
      });
      getTenantLessonCompletions(tenantId).then(({ data }) => {
        if (data) setTenantCompletions(data);
      });
    }
  }, [tenantId, isReal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load lesson completions from Supabase for real users ─────────────────
  useEffect(() => {
    if (!isReal || !user?.id) return;
    getLessonCompletions(user.id).then(({ data: dbCompleted }) => {
      if (!dbCompleted) return;
      // Replace entirely — do not merge with any prior localStorage state.
      setCompletedLessons(new Set(dbCompleted));
    });
  }, [user?.id, isReal]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCompleteLesson = (id) => {
    if (completedLessons.has(id)) return;
    setCompletedLessons(prev => {
      const next = new Set([...prev, id]);
      // Real users: Supabase is source of truth — skip localStorage to avoid stale data accumulation.
      if (!isReal) {
        try { localStorage.setItem(`ralli_learn_progress_${user?.id ?? "guest"}`, JSON.stringify([...next])); } catch {}
      }
      return next;
    });
    const lessonXp = lessons.find(l => l.id === id)?.xp ?? 0;
    if (lessonXp) onAwardXp?.(lessonXp);
    // Persist to Supabase for real users (fire-and-forget)
    if (isReal && user?.id) {
      const uid = user.id;
      const tid = tenantId ?? null;
      markLessonComplete(uid, id, tid)
        .then(({ error }) => { if (error) console.error("[ralli] markLessonComplete failed:", error); });

      // Award lesson XP — find any assignment for this lesson to check dueAt
      const userTeamId = orgUsers.find(u => u.id === uid)?.teamId ?? null;
      const lessonAssignment = assignments.find(a =>
        a.contentType === "lesson" && a.contentId === id && (
          (a.assignedTo.type === "group"      && a.assignedTo.orgId === user?.orgId) ||
          (a.assignedTo.type === "individual" && a.assignedTo.userId === uid)        ||
          (a.assignedTo.type === "team"       && userTeamId && a.assignedTo.teamId === userTeamId)
        )
      );
      if (tid) {
        // Snapshot the completed-lesson set before any state update resolves,
        // so the course-completion check below uses a stable value.
        const updatedCompleted = new Set([...completedLessons, id]);

        awardLessonPoints(tid, uid, id, { dueAt: lessonAssignment?.dueAt })
          .then(() => {
            // Lesson XP is now committed — safe to recalculate readiness.
            triggerReadinessUpdate(tid, uid);

            // Detect course completion: any course containing this lesson that
            // wasn't already complete before this lesson is now fully done.
            courses.forEach(course => {
              if (!course.lessonIds?.includes(id)) return;
              const wasComplete = course.lessonIds.every(lid => completedLessons.has(lid));
              if (wasComplete) return;
              const nowComplete = course.lessonIds.every(lid => updatedCompleted.has(lid));
              if (!nowComplete) return;
              const courseAssignment = assignments.find(a =>
                a.contentType === "course" && a.contentId === course.id && (
                  (a.assignedTo.type === "group"      && a.assignedTo.orgId === user?.orgId) ||
                  (a.assignedTo.type === "individual" && a.assignedTo.userId === uid)        ||
                  (a.assignedTo.type === "team"       && userTeamId && a.assignedTo.teamId === userTeamId)
                )
              );
              // Award course XP, then trigger a second readiness update so the
              // final score includes both lesson and course XP.
              awardCoursePoints(tid, uid, course.id, { dueAt: courseAssignment?.dueAt })
                .then(() => triggerReadinessUpdate(tid, uid))
                .catch(e => console.error("[ralli] awardCoursePoints failed:", e));
            });
          })
          .catch(e => console.error("[ralli] awardLessonPoints failed:", e));
      }
    }
  };

  // Helper: given a lesson and a course, return the next uncompleted lesson in the course
  const getNextInCourse = (currentLesson, course) => {
    if (!course) return null;
    const cls = course.lessonIds.map(id => lessons.find(l => l.id === id)).filter(Boolean);
    const idx = cls.findIndex(l => l.id === currentLesson.id);
    return idx >= 0 && idx < cls.length - 1 ? cls[idx + 1] : null;
  };

  const openLesson = (lesson, course = null) => {
    setActiveLesson({
      lesson,
      courseTitle: course?.title ?? null,
      course,
      nextLesson: course ? getNextInCourse(lesson, course) : null,
    });
    setActiveCourse(null);
  };

  // Deep-link: if navigated here from HomeScreen with a pending lesson, open it.
  // For real users: wait for Supabase data before resolving — never fall back to seed content.
  // For demo users: seed data is the only source, so resolve immediately.
  useEffect(() => {
    if (!pendingLessonId || isAdmin) return;
    // Block until tenant lessons are loaded so we never open seed content for real users.
    if (isReal && isLearnLoading) return;
    const lesson = lessons.find(l => l.id === pendingLessonId)
      ?? (isReal ? null : INITIAL_LEARN_LESSONS.find(l => l.id === pendingLessonId));
    if (lesson) {
      openLesson(lesson);
      onClearPendingLesson?.();
    } else if (!isLearnLoading) {
      // Load finished and lesson not found (invalid ID or not accessible) — clear to prevent loops.
      onClearPendingLesson?.();
    }
  }, [pendingLessonId, lessons, isLearnLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-link: open a specific course from HomeScreen assignment card.
  // Retries when courses load (courses may not be ready on first render).
  useEffect(() => {
    if (!pendingCourseId || isAdmin) return;
    const course = courses.find(c => c.id === pendingCourseId);
    if (course) { setActiveCourse(course); onClearPendingCourse?.(); }
  }, [pendingCourseId, courses]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ARCHIVE / RESTORE HANDLERS (admin view) ──────────────
  const handleArchiveCourse = async (courseId) => {
    const course = courses.find(c => c.id === courseId);
    if (!course) return;
    if (!isReal) {
      setCourses(prev => prev.filter(c => c.id !== courseId));
      setArchivedCourses(prev => [{ ...course, status: "archived" }, ...prev]);
      return;
    }
    if (archiveInFlight.has(courseId)) return;
    setArchiveInFlight(prev => new Set([...prev, courseId]));
    const { error } = await archiveCourseService(courseId);
    setArchiveInFlight(prev => { const s = new Set(prev); s.delete(courseId); return s; });
    if (error) { console.error("[ralli] archiveCourse failed:", error); toast.error("Failed to archive course. Please try again."); return; }
    setCourses(prev => prev.filter(c => c.id !== courseId));
    setArchivedCourses(prev => [{ ...course, status: "archived" }, ...prev]);
  };

  const handleArchiveLesson = async (lessonId) => {
    const lesson = lessons.find(l => l.id === lessonId);
    if (!lesson) return;
    if (!isReal) {
      setLessons(prev => prev.filter(l => l.id !== lessonId));
      setArchivedLessons(prev => [{ ...lesson, status: "archived" }, ...prev]);
      return;
    }
    if (archiveInFlight.has(lessonId)) return;
    setArchiveInFlight(prev => new Set([...prev, lessonId]));
    const { error } = await archiveLessonService(lessonId);
    setArchiveInFlight(prev => { const s = new Set(prev); s.delete(lessonId); return s; });
    if (error) { console.error("[ralli] archiveLesson failed:", error); toast.error("Failed to archive lesson. Please try again."); return; }
    setLessons(prev => prev.filter(l => l.id !== lessonId));
    setArchivedLessons(prev => [{ ...lesson, status: "archived" }, ...prev]);
  };

  const handleRestoreCourse = async (courseId) => {
    const course = archivedCourses.find(c => c.id === courseId);
    if (!course) return;
    if (!isReal) {
      setArchivedCourses(prev => prev.filter(c => c.id !== courseId));
      setCourses(prev => [{ ...course, status: "active" }, ...prev]);
      return;
    }
    if (archiveInFlight.has(courseId)) return;
    setArchiveInFlight(prev => new Set([...prev, courseId]));
    const { error } = await restoreCourseService(courseId);
    setArchiveInFlight(prev => { const s = new Set(prev); s.delete(courseId); return s; });
    if (error) { console.error("[ralli] restoreCourse failed:", error); toast.error("Failed to restore course. Please try again."); return; }
    setArchivedCourses(prev => prev.filter(c => c.id !== courseId));
    setCourses(prev => [{ ...course, status: "active" }, ...prev]);
  };

  const handleRestoreLesson = async (lessonId) => {
    const lesson = archivedLessons.find(l => l.id === lessonId);
    if (!lesson) return;
    if (!isReal) {
      setArchivedLessons(prev => prev.filter(l => l.id !== lessonId));
      setLessons(prev => [{ ...lesson, status: "active" }, ...prev]);
      return;
    }
    if (archiveInFlight.has(lessonId)) return;
    setArchiveInFlight(prev => new Set([...prev, lessonId]));
    const { error } = await restoreLessonService(lessonId);
    setArchiveInFlight(prev => { const s = new Set(prev); s.delete(lessonId); return s; });
    if (error) { console.error("[ralli] restoreLesson failed:", error); toast.error("Failed to restore lesson. Please try again."); return; }
    setArchivedLessons(prev => prev.filter(l => l.id !== lessonId));
    setLessons(prev => [{ ...lesson, status: "active" }, ...prev]);
  };

  // ── USER VIEW ─────────────────────────────────────────────
  if (!isAdmin) {
    // Guard: real users wait for DB load rather than seeing seed data flash
    if (isLearnLoading) return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>My Learning</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Loading your assignments…</p>
        </div>
        <div style={{ padding: 60, textAlign: "center", color: C.textMuted, fontSize: 14 }}>Loading…</div>
      </div>
    );

    const userTeamId = orgUsers.find(u => u.id === user?.id)?.teamId ?? null;
    const myAssignments = assignments.filter(a =>
      (a.assignedTo.type === "group"      && a.assignedTo.orgId === user?.orgId)  ||
      (a.assignedTo.type === "individual" && a.assignedTo.userId === user?.id)    ||
      (a.assignedTo.type === "team"       && userTeamId && userTeamId === a.assignedTo.teamId)
    );
    const xpEarned = [...completedLessons].reduce((s, id) => s + (lessons.find(x => x.id === id)?.xp ?? 0), 0);

    if (activeLesson) {
      return (
        <LessonViewerScreen
          lesson={activeLesson.lesson}
          courseTitle={activeLesson.courseTitle}
          onBack={() => {
            if (activeLesson.course) { setActiveCourse(activeLesson.course); }
            setActiveLesson(null);
          }}
          completed={completedLessons.has(activeLesson.lesson.id)}
          onComplete={handleCompleteLesson}
          nextLesson={activeLesson.nextLesson}
          onNextLesson={(next) => openLesson(next, activeLesson.course)}
        />
      );
    }

    // Course detail view
    if (activeCourse) {
      const cls = activeCourse.lessonIds.map(id => lessons.find(l => l.id === id)).filter(Boolean);
      const doneCount = cls.filter(l => completedLessons.has(l.id)).length;
      // Availability timing: find this user's assignment for the course and compute per-lesson unlock dates
      const courseAssignment = myAssignments.find(a => a.contentType === "course" && a.contentId === activeCourse.id);
      const assignedDate = courseAssignment?.assignedAtRaw
        ? new Date(courseAssignment.assignedAtRaw)
        : courseAssignment?.assignedAt ? new Date(courseAssignment.assignedAt) : null;
      const todayMs = new Date().setHours(0, 0, 0, 0);
      const lessonSchedule = activeCourse.lessonSchedule ?? {};
      const getLessonAvailability = (lessonId) => {
        const days = lessonSchedule[lessonId]?.available_after_days ?? 0;
        if (!assignedDate || days === 0) return { locked: false, availableDate: null };
        const base = new Date(assignedDate); base.setHours(0, 0, 0, 0);
        const availMs = base.getTime() + days * 86400000;
        return { locked: todayMs < availMs, availableDate: new Date(availMs) };
      };
      const pct = Math.round((doneCount / Math.max(cls.length, 1)) * 100);
      const totalXp = cls.reduce((s, l) => s + (l.xp || 0), 0);
      const bonusXp = Math.round(totalXp * 0.2);
      const isComplete = pct === 100;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <button onClick={() => setActiveCourse(null)} style={{ background: "none", border: "none", cursor: "pointer", color: C.textSub, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, padding: 0, alignSelf: "flex-start" }}>
            ← Back to My Learning
          </button>
          <div style={{ background: C.white, borderRadius: 14, padding: 24, border: `1px solid ${C.border}` }}>
            <div style={{ height: 4, background: activeCourse.color, borderRadius: 2, marginBottom: 18 }} />
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: activeCourse.color, letterSpacing: "0.06em", marginBottom: 4 }}>COURSE · {cls.length} LESSONS</div>
                <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 800, color: C.text }}>{activeCourse.title}</h2>
                <p style={{ margin: "0 0 12px", fontSize: 13, color: C.textSub, lineHeight: 1.5 }}>{activeCourse.description}</p>
                <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.textSub }}>
                  <span>⏱ {cls.reduce((s, l) => s + (parseInt(l.duration) || 0), 0)} min</span>
                  <span style={{ color: C.orange, fontWeight: 700 }}>{totalXp} XP{isComplete ? ` +${bonusXp} bonus` : ""}</span>
                  {isComplete && <span style={{ color: C.green, fontWeight: 700 }}>✓ Complete</span>}
                </div>
              </div>
              {!isComplete && cls.find(l => !completedLessons.has(l.id) && !getLessonAvailability(l.id).locked) && (
                <button onClick={() => openLesson(cls.find(l => !completedLessons.has(l.id) && !getLessonAvailability(l.id).locked), activeCourse)} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
                  {doneCount > 0 ? "Continue →" : "Start →"}
                </button>
              )}
            </div>
            {pct > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: C.textSub }}>{doneCount} / {cls.length} lessons complete</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.orange }}>{pct}%</span>
                </div>
                <ProgressBar value={pct} color={isComplete ? C.green : C.orange} height={5} />
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {cls.map((l, i) => {
              const done = completedLessons.has(l.id);
              const { locked, availableDate } = getLessonAvailability(l.id);
              const isNextUp = !done && !locked && (i === 0 || completedLessons.has(cls[i - 1]?.id));
              const typeColor = LESSON_TYPE_COLORS[l.type] ?? C.orange;
              const availLabel = availableDate
                ? availableDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })
                : null;
              return (
                <Card key={l.id} style={{ display: "flex", alignItems: "center", gap: 14, opacity: done ? 0.75 : locked ? 0.5 : 1 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0, background: locked ? C.muted : typeColor + "20", border: `1px solid ${locked ? C.border : typeColor + "30"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>
                    {done ? <span style={{ color: C.green, fontWeight: 800, fontSize: 14 }}>✓</span> : locked ? <span style={{ fontSize: 13 }}>🔒</span> : null}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: locked ? C.textMuted : typeColor, letterSpacing: "0.06em", marginBottom: 1 }}>{l.type.toUpperCase()} · {l.duration}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    <span style={{ fontSize: 12, color: locked ? C.textMuted : C.orange, fontWeight: 700 }}>{locked ? "" : `${l.xp} XP`}</span>
                    {locked
                      ? <span style={{ fontSize: 11, color: C.textSub, fontWeight: 600, padding: "7px 10px", borderRadius: 7, background: C.muted, border: `1px solid ${C.border}` }}>
                          {availLabel ? `Available ${availLabel}` : "Locked"}
                        </span>
                      : <button onClick={() => openLesson(l, activeCourse)} style={{ padding: "7px 14px", borderRadius: 7, border: done ? `1px solid ${C.border}` : "none", background: done ? C.white : isNextUp ? C.orange : C.text, color: done ? C.textSub : "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                          {done ? "Review" : isNextUp ? (i === 0 && doneCount === 0 ? "Start" : "Continue") : "View"}
                        </button>
                    }
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      );
    }

    // Knowledge Base: all content, filterable
    const allContent = [
      ...courses.map(c => ({ ...c, _kind: "course" })),
      ...lessons.filter(l => l.status === "active").map(l => ({ ...l, _kind: "lesson" })),
    ];
    const sq = search.toLowerCase();
    const browseResults = sq
      ? allContent.filter(x => x.title.toLowerCase().includes(sq) || (x.description ?? "").toLowerCase().includes(sq))
      : allContent;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>My Learning</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>
              {myAssignments.length} assigned · <span style={{ color: C.orange, fontWeight: 700 }}>{xpEarned.toLocaleString()} XP earned</span>
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}` }}>
          {[{ id: "assigned", label: "Assigned", count: myAssignments.length }, { id: "browse", label: "Knowledge Base" }].map(t => (
            <button key={t.id} onClick={() => { setUserTab(t.id); setSearch(""); }} style={{
              padding: "10px 18px", border: "none", cursor: "pointer", background: "transparent",
              fontWeight: userTab === t.id ? 700 : 500, color: userTab === t.id ? C.orange : C.textSub,
              borderBottom: `2px solid ${userTab === t.id ? C.orange : "transparent"}`, fontSize: 14, marginBottom: -1,
              display: "flex", alignItems: "center", gap: 6,
            }}>
              {t.label}
              {t.count !== undefined && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: userTab === t.id ? C.orangeLight : C.muted, color: userTab === t.id ? C.orange : C.textSub }}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* ASSIGNED TAB */}
        {userTab === "assigned" && (() => {
          // ── Deduplicate by contentType:contentId ──────────────────────────────
          // The same content can be assigned to a user via multiple paths
          // (individual + group + team). Count and display it only once.
          const seenKeys = new Set();
          const dedupedAssignments = myAssignments.filter(a => {
            const key = `${a.contentType}:${a.contentId}`;
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
          });

          // ── Enrich each assignment with completion + availability ──────────────
          const todayMsForFilter = new Date().setHours(0, 0, 0, 0);
          const enrichedAssigned = dedupedAssignments.map(a => {
            const isCourse = a.contentType === "course";
            const content  = isCourse ? courses.find(c => c.id === a.contentId) : lessons.find(l => l.id === a.contentId);
            if (!content) return null;
            const courseLessons = isCourse ? content.lessonIds.map(id => lessons.find(l => l.id === id)).filter(Boolean) : [];
            const doneCount = isCourse ? courseLessons.filter(l => completedLessons.has(l.id)).length : 0;
            const pct = isCourse
              ? Math.round((doneCount / Math.max(courseLessons.length, 1)) * 100)
              : (completedLessons.has(content.id) ? 100 : 0);
            const isComplete = pct === 100;
            // Availability: does the user have at least one lesson they can act on now?
            // Locked-only courses are excluded from Due but still shown in All.
            let isAvailable = true;
            if (isCourse && !isComplete) {
              const assignedDate = a.assignedAtRaw ? new Date(a.assignedAtRaw)
                : a.assignedAt ? new Date(a.assignedAt) : null;
              const lessonSched = content.lessonSchedule ?? {};
              const isLockedForFilter = (lessonId) => {
                const days = lessonSched[lessonId]?.available_after_days ?? 0;
                if (!assignedDate || days === 0) return false;
                const base = new Date(assignedDate); base.setHours(0, 0, 0, 0);
                return todayMsForFilter < base.getTime() + days * 86400000;
              };
              isAvailable = courseLessons.some(l => !completedLessons.has(l.id) && !isLockedForFilter(l.id));
            }
            return { a, content, isCourse, courseLessons, doneCount, pct, isComplete, isAvailable };
          }).filter(Boolean);

          const dueItems      = enrichedAssigned.filter(e => !e.isComplete && e.isAvailable);
          const completeItems = enrichedAssigned.filter(e => e.isComplete);
          // Locked: assigned, not complete, but no lessons are available yet (schedule lock)
          const lockedItems   = enrichedAssigned.filter(e => !e.isComplete && !e.isAvailable);
          const filterItems   = learnFilter === "due" ? dueItems : learnFilter === "complete" ? completeItems : enrichedAssigned;

          const AssignedCard = ({ a, content, isCourse, courseLessons, doneCount, pct, isComplete }) => {
            const totalXp   = isCourse ? courseLessons.reduce((s, l) => s + (l.xp || 0), 0) : (content.xp || 0);
            const bonusXp   = isCourse ? Math.round(totalXp * 0.2) : 0;
            const estMin    = isCourse ? courseLessons.reduce((s, l) => s + (parseInt(l.duration) || 0), 0) : (parseInt(content.duration) || 0);
            const typeColor = isCourse ? content.color : LESSON_TYPE_COLORS[content.type];
            return (
              <Card key={a.id}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                  <div style={{
                    width: 52, height: 52, borderRadius: 12, flexShrink: 0,
                    background: typeColor + "20", border: `1px solid ${typeColor}30`,
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24,
                    opacity: isComplete ? 0.55 : 1,
                  }}>
                    {isCourse ? content.emoji : LESSON_TYPE_ICONS[content.type]}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: typeColor, letterSpacing: "0.06em" }}>
                        {isCourse ? `COURSE · ${courseLessons.length} LESSONS` : `LESSON · ${content.type.toUpperCase()}`}
                      </span>
                      {a.required && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: C.redBg, color: C.red }}>REQUIRED</span>}
                      {isComplete && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: C.greenBg, color: C.green }}>COMPLETE</span>}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{content.title}</div>
                    <div style={{ display: "flex", gap: 12, fontSize: 12, color: C.textSub, flexWrap: "wrap" }}>
                      <span>⏱ {estMin} min</span>
                      <span>Due {a.dueAt}</span>
                      <span style={{ color: C.orange, fontWeight: 700 }}>{totalXp}{bonusXp ? ` +${bonusXp} bonus` : ""} XP</span>
                    </div>
                    {pct > 0 && !isComplete && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: C.textSub }}>{isCourse ? `${doneCount} / ${courseLessons.length} lessons` : "Progress"}</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: C.orange }}>{pct}%</span>
                        </div>
                        <ProgressBar value={pct} color={C.orange} height={5} />
                      </div>
                    )}
                  </div>
                  {isCourse ? (
                    <button
                      onClick={() => {
                        if (isComplete) { setActiveCourse(content); }
                        else {
                          // Respect per-lesson availability schedule — don't open locked lessons
                          const assignedDate = a.assignedAtRaw ? new Date(a.assignedAtRaw)
                            : a.assignedAt ? new Date(a.assignedAt) : null;
                          const todayMs = new Date().setHours(0, 0, 0, 0);
                          const lessonSched = content.lessonSchedule ?? {};
                          const isLockedLesson = (lessonId) => {
                            const days = lessonSched[lessonId]?.available_after_days ?? 0;
                            if (!assignedDate || days === 0) return false;
                            const base = new Date(assignedDate); base.setHours(0, 0, 0, 0);
                            return todayMs < base.getTime() + days * 86400000;
                          };
                          const next = courseLessons.find(l => !completedLessons.has(l.id) && !isLockedLesson(l.id));
                          if (next) openLesson(next, content);
                          else setActiveCourse(content); // all next lessons are still locked — show course detail
                        }
                      }}
                      style={{ padding: "9px 18px", borderRadius: 8, border: isComplete ? `1px solid ${C.border}` : "none", cursor: "pointer", background: isComplete ? C.white : pct > 0 ? C.text : C.orange, color: isComplete ? C.textSub : "#fff", fontSize: 12, fontWeight: 700, flexShrink: 0 }}
                    >
                      {isComplete ? "Review" : pct > 0 ? "Continue →" : "Start →"}
                    </button>
                  ) : !isComplete && content.type === "recording" ? (
                    <div style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.pageBg, color: C.textMuted, fontSize: 11, fontWeight: 700, textAlign: "center", flexShrink: 0, lineHeight: 1.3 }}>
                      Coming<br/>soon
                    </div>
                  ) : !isComplete ? (
                    <button
                      onClick={() => openLesson(content)}
                      style={{ padding: "9px 18px", borderRadius: 8, border: "none", cursor: "pointer", background: pct > 0 ? C.text : C.orange, color: "#fff", fontSize: 12, fontWeight: 700, flexShrink: 0 }}
                    >
                      {pct > 0 ? "Resume →" : "Start →"}
                    </button>
                  ) : (
                    <button onClick={() => openLesson(content)} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.border}`, cursor: "pointer", background: C.white, color: C.textSub, fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                      Review
                    </button>
                  )}
                </div>
              </Card>
            );
          };

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Empty state — no assignments at all */}
              {dedupedAssignments.length === 0 && (
                <div style={{ padding: 60, textAlign: "center", background: C.white, borderRadius: 12, border: `1px solid ${C.border}` }}>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.text }}>No assignments yet</p>
                  <p style={{ margin: "6px 0 0", fontSize: 13, color: C.textSub }}>Your manager will assign courses and lessons here</p>
                </div>
              )}

              {/* Due / Complete / All pills */}
              {dedupedAssignments.length > 0 && (
                <div style={{ display: "flex", gap: 6 }}>
                  {[
                    ["due",      `Due (${dueItems.length})`],
                    ["complete", `Complete (${completeItems.length})`],
                    ["all",      `All (${enrichedAssigned.length})`],
                  ].map(([id, label]) => (
                    <button key={id} onClick={() => setLearnFilter(id)} style={{
                      padding: "7px 14px", borderRadius: 8,
                      border: `1px solid ${learnFilter === id ? C.orange : C.border}`,
                      background: learnFilter === id ? C.orangeLight : C.white,
                      color: learnFilter === id ? C.orange : C.textSub,
                      fontSize: 13, fontWeight: 600, cursor: "pointer",
                    }}>{label}</button>
                  ))}
                </div>
              )}

              {/* Per-tab empty state */}
              {dedupedAssignments.length > 0 && filterItems.length === 0 && (
                <div style={{ padding: 48, textAlign: "center", background: C.white, borderRadius: 16, border: `1px solid ${C.border}` }}>
                  <p style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "0 0 4px" }}>
                    {learnFilter === "complete"
                      ? "Nothing completed yet"
                      : (learnFilter === "due" && lockedItems.length > 0)
                        ? "Nothing due right now"
                        : "All caught up!"}
                  </p>
                  <p style={{ fontSize: 13, color: C.textSub, margin: 0 }}>
                    {learnFilter === "complete"
                      ? "Complete a lesson or course to see it here."
                      : (learnFilter === "due" && lockedItems.length > 0)
                        ? `${lockedItems.length} assignment${lockedItems.length === 1 ? "" : "s"} unlock on a schedule — check the All tab to see what's coming.`
                        : learnFilter === "all"
                          ? "No assignments found."
                          : "No pending work — you're all done!"}
                  </p>
                </div>
              )}

              {/* Assignment cards */}
              {filterItems.map(e => <AssignedCard key={e.a.id} {...e} />)}

              {/* Course suggestions — only in Due and All tabs */}
              {(learnFilter === "due" || learnFilter === "all") && (() => {
                const suggestions = courses.filter(c => !myAssignments.some(a => a.contentType === "course" && a.contentId === c.id)).slice(0, 3);
                if (!suggestions.length) return null;
                return (
                  <div style={{ marginTop: 4 }}>
                    <h3 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 800, color: C.text }}>Recommended for you</h3>
                    <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
                      {suggestions.map(c => {
                        const cls = c.lessonIds.map(id => lessons.find(l => l.id === id)).filter(Boolean);
                        return (
                          <Card key={c.id} style={{ minWidth: 200, flexShrink: 0, cursor: "pointer" }} onClick={() => setActiveCourse(c)}>
                            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                              <span style={{ fontSize: 26 }}>{c.emoji}</span>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 3 }}>{c.title}</div>
                                <div style={{ fontSize: 11, color: C.textSub }}>{cls.length} lessons · {cls.reduce((s,l) => s+(l.xp||0),0)} XP</div>
                              </div>
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* KNOWLEDGE BASE TAB */}
        {userTab === "browse" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search courses, lessons, and content..."
              autoFocus
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.border}`,
                fontSize: 14, color: C.text, background: C.white, boxSizing: "border-box",
              }}
            />
            {search && browseResults.length === 0 && (
              <div style={{ padding: 40, textAlign: "center", color: C.textSub }}>No results for "{search}"</div>
            )}
            {browseResults.map(item => (
              <Card key={item.id} style={{ display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}
                onClick={() => item._kind === "lesson" ? openLesson(item) : setActiveCourse(item)}>
                <div style={{
                  width: 44, height: 44, borderRadius: 10, flexShrink: 0,
                  background: ((item._kind === "course" ? item.color : LESSON_TYPE_COLORS[item.type]) ?? C.orange) + "20",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22,
                }}>
                  {item._kind === "course" ? item.emoji : LESSON_TYPE_ICONS[item.type]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.06em", marginBottom: 2 }}>
                    {item._kind === "course" ? `COURSE · ${item.lessonIds?.length ?? 0} LESSONS` : `LESSON · ${(item.type ?? "").toUpperCase()}`}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{item.title}</div>
                  <div style={{ fontSize: 12, color: C.textSub, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.description?.slice(0, 90)}{(item.description?.length ?? 0) > 90 ? "…" : ""}
                  </div>
                </div>
                {item._kind === "lesson" && <span style={{ fontSize: 12, color: C.textSub, flexShrink: 0 }}>⏱ {item.duration}</span>}
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── ADMIN VIEW ────────────────────────────────────────────
  const sq = search.toLowerCase();
  const filteredCourses = courses.filter(c => c.status !== "archived" && (!sq || c.title.toLowerCase().includes(sq) || c.description.toLowerCase().includes(sq)));
  const filteredLessons = lessons.filter(l => l.status !== "archived" && (!sq || l.title.toLowerCase().includes(sq) || l.description.toLowerCase().includes(sq)));
  // Dedup by (contentType, contentId, assignedTo.type, targetId) — neutralises historical duplicate rows
  const uniqueAssignments = (() => {
    const seen = new Set();
    return assignments.filter(a => {
      const at = a.assignedTo;
      const tid = at?.type === "team"       ? (at.teamId   ?? "")
                : at?.type === "individual" ? (at.userId   ?? "")
                : (at?.orgId ?? "");
      const key = `${a.contentType}:${a.contentId}:${at?.type ?? ""}:${tid}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();
  const filteredAssign  = uniqueAssignments.filter(a => {
    if (!sq) return true;
    const content = a.contentType === "course" ? courses.find(c => c.id === a.contentId) : lessons.find(l => l.id === a.contentId);
    return content?.title.toLowerCase().includes(sq);
  });

  // Count only non-fully-completed assignments for the tab badge
  const activeAssignmentCount = uniqueAssignments.filter(a => {
    let users = [];
    if (a.assignedTo?.type === "individual") {
      const u = orgUsers.find(x => x.id === a.assignedTo.userId);
      if (u) users = [u];
    } else if (a.assignedTo?.type === "team") {
      users = a.assignedTo.teamId ? orgUsers.filter(u => u.teamId === a.assignedTo.teamId) : [];
    } else if (a.assignedTo?.type === "group") {
      users = orgUsers.filter(u => !["ralli_admin", "superadmin", "orgAdmin"].includes(u.role));
    }
    if (!users.length) return true;
    if (a.contentType === "quiz") return true;
    return users.some(u => {
      const comps = tenantCompletions.filter(c => c.profileId === u.id);
      if (a.contentType === "lesson") return !comps.some(c => c.lessonId === a.contentId);
      const course = courses.find(c => c.id === a.contentId);
      if (!course) return true;
      const cls = (course.lessonIds ?? []).map(id => lessons.find(l => l.id === id)).filter(Boolean);
      return cls.some(l => !comps.some(c => c.lessonId === l.id));
    });
  }).length;

  const TABS = [
    { id: "courses",     label: "Courses",     count: filteredCourses.length },
    { id: "lessons",     label: "Lessons",     count: filteredLessons.length },
    { id: "assignments", label: "Assignments", count: activeAssignmentCount },
    { id: "archived",    label: "Archived",    count: archivedCourses.length + archivedLessons.length },
  ];

  const getAssignedLabel = (a) => {
    const t = a.assignedTo?.type;
    if (t === "team") return `Team: ${a.assignedTo.teamName ?? a.assignedTo.teamId ?? "Unknown"}`;
    if (t === "group") {
      const org = orgs.find(o => o.id === a.assignedTo.orgId);
      return `All users · ${org?.name ?? "Unknown org"}`;
    }
    // individual
    const name = a.assignedTo?.userName;
    if (name) return name;
    const u = orgUsers.find(u => u.id === a.assignedTo?.userId);
    return u ? u.name : "Unknown user";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Learn</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Create and assign courses and lessons to your reps</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1, justifyContent: "flex-end", minWidth: 260 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search courses, lessons..."
            style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text, background: C.pageBg, minWidth: 0, flex: 1 }}
          />
          {tab === "courses" && canCreate && (
            <button onClick={() => setCourseModal("new")} style={{
              padding: "9px 18px", borderRadius: 8, border: "none", cursor: "pointer",
              background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, flexShrink: 0,
            }}>+ New Course</button>
          )}
          {tab === "lessons" && canCreate && (
            <button onClick={() => setLessonModal("new")} style={{
              padding: "9px 18px", borderRadius: 8, border: "none", cursor: "pointer",
              background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, flexShrink: 0,
            }}>+ New Lesson</button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "10px 18px", border: "none", cursor: "pointer",
            background: "transparent", fontWeight: tab === t.id ? 700 : 500,
            color: tab === t.id ? C.orange : C.textSub,
            borderBottom: `2px solid ${tab === t.id ? C.orange : "transparent"}`,
            fontSize: 14, display: "flex", alignItems: "center", gap: 6, marginBottom: -1,
          }}>
            {t.label}
            <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: tab === t.id ? C.orangeLight : C.muted, color: tab === t.id ? C.orange : C.textSub }}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* COURSES TAB */}
      {tab === "courses" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
          {filteredCourses.map(course => {
            const courseLessons = course.lessonIds.map(id => lessons.find(l => l.id === id)).filter(Boolean);
            const totalMin = courseLessons.reduce((sum, l) => sum + (parseInt(l.duration) || 0), 0);
            return (
              <Card key={course.id} style={{ display: "flex", flexDirection: "column", gap: 0, padding: 0, overflow: "hidden" }}>
                {/* Color header */}
                <div style={{ height: 5, background: course.color }} />
                <div style={{ padding: 20, display: "flex", flexDirection: "column", flex: 1 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 700, color: C.text, lineHeight: 1.3 }}>{course.title}</h3>
                  <p style={{ margin: "0 0 12px", fontSize: 12, color: C.textMuted, lineHeight: 1.55 }}>{course.description}</p>
                  <div style={{ display: "flex", gap: 12, fontSize: 12, color: C.textSub, marginBottom: 14 }}>
                    <span>{courseLessons.length} lessons</span>
                    <span>{totalMin} min</span>
                    <span>{courseLessons.reduce((s, l) => s + (l.xp || 0), 0)} XP</span>
                  </div>
                  {/* Lesson list preview */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 16 }}>
                    {courseLessons.map((l, i) => (
                      <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: C.pageBg, borderRadius: 8, border: `1px solid ${C.border}` }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, width: 16, flexShrink: 0 }}>{i + 1}</span>
                        <span style={{ fontSize: 12, fontWeight: 500, color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</span>
                        <span style={{ fontSize: 11, color: C.textMuted, flexShrink: 0 }}>{l.duration}</span>
                      </div>
                    ))}
                  </div>
                  {/* Actions — bottom aligned */}
                  <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 4 }}>
                    {canEdit && <button onClick={() => setCourseModal(course)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSub, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Edit</button>}
                    {canAssign && <button onClick={() => setAssignModal({ contentType: "course", contentId: course.id })} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Assign</button>}
                    {canEdit && <button onClick={() => setConfirmArchive({ type: "course", id: course.id, title: course.title })} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: `1px solid rgba(239,68,68,0.2)`, background: "transparent", color: C.red, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Archive</button>}
                  </div>
                </div>
              </Card>
            );
          })}

          {/* Empty state new course prompt */}
          {courses.length === 0 && (
            <button onClick={() => setCourseModal("new")} style={{
              padding: 40, borderRadius: 12, border: `2px dashed ${C.border}`, background: "transparent",
              color: C.textSub, fontSize: 14, cursor: "pointer", textAlign: "center", gridColumn: "1/-1",
            }}>
              <div style={{ fontWeight: 700, color: C.text, marginBottom: 4 }}>No courses yet</div>
              <div>Click "+ New Course" to create your first course</div>
            </button>
          )}
        </div>
      )}

      {/* LESSONS TAB */}
      {tab === "lessons" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
          {filteredLessons.map(lesson => (
            <Card key={lesson.id} style={{ opacity: lesson.status === "inactive" ? 0.6 : 1, display: "flex", flexDirection: "column" }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 700, color: C.text, lineHeight: 1.3 }}>{lesson.title}</h3>
              <p style={{ margin: "0 0 12px", fontSize: 12, color: C.textMuted, lineHeight: 1.55, flex: 1 }}>{lesson.description}</p>
              <div style={{ display: "flex", gap: 12, fontSize: 12, color: C.textSub, marginBottom: 14 }}>
                <span>{lesson.duration}</span>
                <span>{lesson.xp} XP</span>
              </div>
              {/* Actions — bottom aligned */}
              <div style={{ display: "flex", gap: 6 }}>
                {canEdit && <button onClick={() => setLessonModal(lesson)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSub, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Edit</button>}
                {canAssign && lesson.type !== "recording" && <button onClick={() => setAssignModal({ contentType: "lesson", contentId: lesson.id })} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Assign</button>}
                {canEdit && <button onClick={() => setConfirmArchive({ type: "lesson", id: lesson.id, title: lesson.title })} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: `1px solid rgba(239,68,68,0.2)`, background: "transparent", color: C.red, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Archive</button>}
              </div>
            </Card>
          ))}

          {lessons.length === 0 && (
            <button onClick={() => setLessonModal("new")} style={{
              padding: 40, borderRadius: 12, border: `2px dashed ${C.border}`, background: "transparent",
              color: C.textSub, fontSize: 14, cursor: "pointer", textAlign: "center", gridColumn: "1/-1",
            }}>
              <div style={{ fontWeight: 700, color: C.text, marginBottom: 4 }}>No lessons yet</div>
              <div>Click "+ New Lesson" to create a standalone lesson</div>
            </button>
          )}
        </div>
      )}

      {/* ASSIGNMENTS TAB — manager assignment portal */}
      {tab === "assignments" && (() => {
        const STATUS_CONFIG = {
          not_started: { label: "Not Started", bg: C.muted,    text: C.textSub  },
          in_progress: { label: "In Progress", bg: C.blueBg,   text: C.blue     },
          completed:   { label: "Completed",   bg: C.greenBg,  text: C.green    },
          overdue:     { label: "Overdue",     bg: C.redBg,    text: C.red      },
        };

        // Expand assignments into per-rep rows
        const allRows = uniqueAssignments.flatMap(a => {
          const isCourse = a.contentType === "course";
          const isQuiz   = a.contentType === "quiz";
          const content  = isCourse
            ? courses.find(c => c.id === a.contentId)
            : isQuiz
              ? quizzes.find(q => q.id === a.contentId)
              : lessons.find(l => l.id === a.contentId);
          if (!content) return [];

          let users = [];
          if (a.assignedTo?.type === "individual") {
            const u = orgUsers.find(u => u.id === a.assignedTo.userId);
            if (u) users = [u];
            else if (a.assignedTo.userName) users = [{ id: a.assignedTo.userId ?? "__ind__", name: a.assignedTo.userName, initials: (a.assignedTo.userName[0] ?? "?").toUpperCase(), color: C.orange }];
          } else if (a.assignedTo?.type === "group") {
            users = orgUsers.filter(u => u.role !== "ralli_admin" && u.role !== "superadmin" && u.role !== "orgAdmin");
            if (!users.length) users = [{ id: "__group__", name: "All users", initials: "ALL", color: C.blue }];
          } else if (a.assignedTo?.type === "team") {
            users = a.assignedTo.teamId ? orgUsers.filter(u => u.teamId === a.assignedTo.teamId) : [];
            if (!users.length) users = [{ id: "__team__", name: a.assignedTo.teamName ?? "Team", initials: "T", color: C.purple, _isAggregate: true }];
          }

          return users.map(u => {
            const userComps = tenantCompletions.filter(c => c.profileId === u.id);
            let progress = 0, completedAt = null, status = "not_started";

            if (!u._isAggregate) {
              if (isCourse) {
                const cls = (content.lessonIds ?? []).map(id => lessons.find(l => l.id === id)).filter(Boolean);
                const done = cls.filter(l => userComps.some(c => c.lessonId === l.id));
                progress = cls.length ? Math.round((done.length / cls.length) * 100) : 0;
                if (progress === 100) {
                  status = "completed";
                  const dates = done.map(l => userComps.find(c => c.lessonId === l.id)?.completedAt).filter(Boolean).sort();
                  completedAt = dates[dates.length - 1] ?? null;
                } else if (progress > 0) { status = "in_progress"; }
              } else if (!isQuiz) {
                // Lesson
                const comp = userComps.find(c => c.lessonId === a.contentId);
                if (comp) { progress = 100; status = "completed"; completedAt = comp.completedAt; }
              }
              // Quiz: no completion table yet — shows as not_started (overdue check still applies)
              if (status !== "completed" && a.dueAt && a.dueAt !== "Open") {
                const d = new Date(a.dueAt);
                if (!isNaN(d) && d < new Date()) status = "overdue";
              }
            }

            return { a, content, isCourse, isQuiz, u, progress, status, completedAt };
          });
        });

        if (allRows.length === 0 && !sq) {
          return (
            <div style={{ padding: 60, textAlign: "center", background: C.white, borderRadius: 12, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.text }}>No assignments yet</p>
              <p style={{ margin: "6px 0 0", fontSize: 13, color: C.textSub }}>Use the "Assign" button on a course or lesson to assign content to your reps</p>
            </div>
          );
        }

        // ── Timeframe filter ───────────────────────────────────────────────
        // Filters rows by the assignment's created date (assignedAtRaw).
        // Rows with no date are always included.
        const timeframeFilter = (row) => {
          if (assignTimeframe === "all") return true;
          const raw = row.a.assignedAtRaw;
          if (!raw) return true;
          const d   = new Date(raw);
          if (isNaN(d)) return true;
          const now = Date.now();
          if (assignTimeframe === "week")  return d >= new Date(now - 7  * 86400000);
          if (assignTimeframe === "month") return d >= new Date(now - 30 * 86400000);
          if (assignTimeframe === "custom") {
            const start = assignDateRange.start ? new Date(assignDateRange.start) : null;
            const end   = assignDateRange.end   ? new Date(assignDateRange.end + "T23:59:59") : null;
            if (start && d < start) return false;
            if (end   && d > end)   return false;
            return true;
          }
          return true;
        };

        const filteredRows = allRows.filter(timeframeFilter);

        // Summary stats — computed from timeframe-filtered rows (not raw assignment count).
        // "Active" = not_started + in_progress + overdue (excludes completed).
        const statCounts = {
          active:      filteredRows.filter(r => r.status !== "completed").length,
          not_started: filteredRows.filter(r => r.status === "not_started").length,
          in_progress: filteredRows.filter(r => r.status === "in_progress").length,
          completed:   filteredRows.filter(r => r.status === "completed").length,
          overdue:     filteredRows.filter(r => r.status === "overdue").length,
        };

        // Detail view when an assignment is selected
        const detailAssignment = selectedAssignmentId ? assignments.find(a => a.id === selectedAssignmentId) : null;
        const detailContent = detailAssignment
          ? (detailAssignment.contentType === "course" ? courses.find(c => c.id === detailAssignment.contentId) : lessons.find(l => l.id === detailAssignment.contentId))
          : null;

        // Rows to show: timeframe + search filtered, or detail-drilled
        const searchedRows = sq
          ? filteredRows.filter(r => r.content?.title.toLowerCase().includes(sq) || r.u?.name?.toLowerCase().includes(sq))
          : filteredRows;
        const visibleRows = selectedAssignmentId
          ? filteredRows.filter(r => r.a.id === selectedAssignmentId)
          : searchedRows;

        const renderTable = (rows) => (
          <div style={{ borderRadius: 12, overflow: "hidden", border: `1px solid ${C.border}` }}>
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <div style={{ minWidth: 620, display: "grid", gridTemplateColumns: "2fr 1.2fr 0.8fr 1fr 0.8fr 80px", gap: 10, padding: "10px 16px", background: C.pageBg, fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.05em" }}>
              <span>CONTENT</span><span>REP</span><span>DUE DATE</span><span>STATUS</span><span>PROGRESS</span><span>DONE</span>
            </div>
            {rows.map(({ a, content, isCourse, isQuiz, u, progress, status, completedAt }, i) => {
              const sc     = STATUS_CONFIG[status] ?? STATUS_CONFIG.not_started;
              const tColor = isCourse ? (content.color ?? C.orange) : isQuiz ? C.purple : (LESSON_TYPE_COLORS[content.type] ?? C.orange);
              const contentLabel = isCourse ? "Course" : isQuiz ? "Quiz" : "Lesson";
              const contentIcon  = isCourse ? content.emoji : isQuiz ? "📋" : LESSON_TYPE_ICONS[content.type];
              const contentTitle = content.title ?? content.name ?? "Untitled";
              const dueLabel = a.dueAt && a.dueAt !== "Open"
                ? (() => { try { return new Date(a.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return a.dueAt; } })()
                : "Open";
              return (
                <div key={`${a.id}-${u.id}-${i}`} style={{ minWidth: 620, display: "grid", gridTemplateColumns: "2fr 1.2fr 0.8fr 1fr 0.8fr 80px", gap: 10, padding: "13px 16px", background: C.white, borderTop: `1px solid ${C.border}`, alignItems: "center" }}>
                  {/* Content — clickable to drill into this assignment */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    {contentIcon && (
                      <div style={{ width: 30, height: 30, borderRadius: 7, background: tColor + "20", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>
                        {contentIcon}
                      </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <button
                        onClick={() => setSelectedAssignmentId(selectedAssignmentId === a.id ? null : a.id)}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "underline", textDecorationColor: C.border }}>{contentTitle}</div>
                      </button>
                      <div style={{ fontSize: 11, color: C.textSub }}>{contentLabel}{a.required ? " · Required" : ""}</div>
                    </div>
                  </div>
                  {/* Rep */}
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <div style={{ width: 24, height: 24, borderRadius: "50%", background: u.color ?? C.orange, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                      {(u.initials ?? u.name?.[0] ?? "?").toUpperCase()}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</span>
                  </div>
                  {/* Due */}
                  <span style={{ fontSize: 13, color: status === "overdue" ? C.red : C.textSub, fontWeight: status === "overdue" ? 700 : 400 }}>{dueLabel}</span>
                  {/* Status badge */}
                  <div><span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: sc.bg, color: sc.text }}>{sc.label}</span></div>
                  {/* Progress bar */}
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ flex: 1, height: 5, background: C.muted, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${progress}%`, background: status === "completed" ? C.green : status === "overdue" ? C.red : C.orange, borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: C.textSub, flexShrink: 0 }}>{progress}%</span>
                  </div>
                  {/* Completed at */}
                  <span style={{ fontSize: 12, color: C.textSub }}>
                    {completedAt ? (() => { try { return new Date(completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return "—"; } })() : "—"}
                  </span>
                </div>
              );
            })}
            </div>
          </div>
        );

        return (
          <div>
            {/* Timeframe filters + summary stats — list view only */}
            {!selectedAssignmentId && (
              <>
                {/* Timeframe filter row */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                  {[
                    { id: "all",   label: "All time" },
                    { id: "week",  label: "This week" },
                    { id: "month", label: "This month" },
                    { id: "custom", label: "Custom range" },
                  ].map(({ id, label }) => (
                    <button key={id} onClick={() => setAssignTimeframe(id)} style={{
                      padding: "5px 12px", borderRadius: 99, border: `1.5px solid ${assignTimeframe === id ? C.orange : C.border}`,
                      background: assignTimeframe === id ? C.orangeLight : C.white,
                      fontSize: 12, fontWeight: 600, color: assignTimeframe === id ? C.orange : C.textSub,
                      cursor: "pointer", transition: "all 0.15s",
                    }}>{label}</button>
                  ))}
                  {assignTimeframe === "custom" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
                      <input
                        type="date" value={assignDateRange.start}
                        onChange={e => setAssignDateRange(p => ({ ...p, start: e.target.value }))}
                        style={{ padding: "4px 8px", borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 12, color: C.text, background: C.white }}
                      />
                      <span style={{ fontSize: 12, color: C.textSub }}>to</span>
                      <input
                        type="date" value={assignDateRange.end}
                        onChange={e => setAssignDateRange(p => ({ ...p, end: e.target.value }))}
                        style={{ padding: "4px 8px", borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 12, color: C.text, background: C.white }}
                      />
                    </div>
                  )}
                </div>

                {/* Summary stat cards */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 20 }}>
                  {[
                    { label: "Active",      count: statCounts.active,       color: C.text,    title: "Not started + in progress + overdue" },
                    { label: "Not Started", count: statCounts.not_started,  color: C.textSub, title: "Assigned, no progress yet" },
                    { label: "In Progress", count: statCounts.in_progress,  color: C.blue,    title: "Started but not complete" },
                    { label: "Completed",   count: statCounts.completed,    color: C.green,   title: "Finished" },
                    { label: "Overdue",     count: statCounts.overdue,      color: C.red,     title: "Past due date, not complete" },
                  ].map(({ label, count, color, title }) => (
                    <div key={label} title={title} style={{ background: C.white, borderRadius: 10, padding: "14px 16px", border: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color, marginBottom: 3 }}>{count}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: C.textSub, lineHeight: 1.3 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Detail view header */}
            {selectedAssignmentId && detailContent && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: "12px 16px", background: C.white, borderRadius: 10, border: `1px solid ${C.border}` }}>
                <button onClick={() => setSelectedAssignmentId(null)} style={{ background: "none", border: "none", cursor: "pointer", color: C.textSub, fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, padding: 0, flexShrink: 0 }}>← All Assignments</button>
                <span style={{ color: C.border, fontSize: 18 }}>|</span>
                {(detailAssignment?.contentType === "quiz" || (detailAssignment?.contentType === "course" && detailContent.emoji)) && (
                  <span style={{ fontSize: 15 }}>{detailAssignment?.contentType === "course" ? detailContent.emoji : "📋"}</span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{detailContent.title ?? detailContent.name}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>{detailAssignment?.contentType === "course" ? "Course" : detailAssignment?.contentType === "quiz" ? "Quiz" : "Lesson"}{detailAssignment?.required ? " · Required" : ""} · {visibleRows.length} rep{visibleRows.length !== 1 ? "s" : ""}</div>
                </div>
              </div>
            )}

            {/* Row count label */}
            {!selectedAssignmentId && (
              <p style={{ margin: "0 0 14px", fontSize: 13, color: C.textSub }}>{visibleRows.length} rep assignment{visibleRows.length !== 1 ? "s" : ""}</p>
            )}

            {visibleRows.length === 0
              ? <div style={{ padding: 40, textAlign: "center", color: C.textMuted, fontSize: 14 }}>No matching assignments</div>
              : renderTable(visibleRows)
            }
          </div>
        );
      })()}

      {/* ARCHIVED TAB */}
      {tab === "archived" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {archivedCourses.length === 0 && archivedLessons.length === 0 && (
            <div style={{ padding: 60, textAlign: "center", background: C.white, borderRadius: 12, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📦</div>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.text }}>Nothing archived</p>
              <p style={{ margin: "6px 0 0", fontSize: 13, color: C.textSub }}>Archived courses and lessons will appear here. Use the Archive button on any course or lesson to move it here.</p>
            </div>
          )}
          {archivedCourses.length > 0 && (
            <div>
              <h3 style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 800, color: C.textMuted, letterSpacing: "0.06em" }}>COURSES ({archivedCourses.length})</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {archivedCourses.map(c => (
                  <Card key={c.id} style={{ display: "flex", alignItems: "center", gap: 14, opacity: 0.72 }}>
                    {c.emoji && <div style={{ width: 36, height: 36, borderRadius: 8, background: (c.color ?? C.orange) + "20", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{c.emoji}</div>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{c.title}</div>
                      <div style={{ fontSize: 11, color: C.textSub }}>Course · {c.lessonIds?.length ?? 0} lessons</div>
                    </div>
                    <button onClick={() => handleRestoreCourse(c.id)} disabled={archiveInFlight.has(c.id)} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: archiveInFlight.has(c.id) ? C.textMuted : C.textSub, fontSize: 12, fontWeight: 700, cursor: archiveInFlight.has(c.id) ? "not-allowed" : "pointer", flexShrink: 0 }}>{archiveInFlight.has(c.id) ? "Restoring…" : "Restore"}</button>
                  </Card>
                ))}
              </div>
            </div>
          )}
          {archivedLessons.length > 0 && (
            <div>
              <h3 style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 800, color: C.textMuted, letterSpacing: "0.06em" }}>LESSONS ({archivedLessons.length})</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {archivedLessons.map(l => (
                  <Card key={l.id} style={{ display: "flex", alignItems: "center", gap: 14, opacity: 0.72 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{l.title}</div>
                      <div style={{ fontSize: 11, color: C.textSub }}>{(l.type ?? "").toUpperCase()} · {l.duration}</div>
                    </div>
                    <button onClick={() => handleRestoreLesson(l.id)} disabled={archiveInFlight.has(l.id)} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: archiveInFlight.has(l.id) ? C.textMuted : C.textSub, fontSize: 12, fontWeight: 700, cursor: archiveInFlight.has(l.id) ? "not-allowed" : "pointer", flexShrink: 0 }}>{archiveInFlight.has(l.id) ? "Restoring…" : "Restore"}</button>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ARCHIVE CONFIRMATION MODAL */}
      {confirmArchive && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmArchive(null); }}>
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: "min(400px, calc(100vw - 32px))", boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>⚠️</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: C.text, textAlign: "center" }}>Archive {confirmArchive.type === "course" ? "Course" : "Lesson"}?</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textSub, textAlign: "center", lineHeight: 1.6 }}>
              <strong>{confirmArchive.title}</strong> will be archived and learners will lose access. You can restore it from the Archived tab.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmArchive(null)} style={{ flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => { if (confirmArchive.type === "course") handleArchiveCourse(confirmArchive.id); else handleArchiveLesson(confirmArchive.id); setConfirmArchive(null); }} style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: "#ef4444", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Archive</button>
            </div>
          </div>
        </div>
      )}

      {/* COURSE BUILDER MODAL */}
      {courseModal && (
        <CourseBuilderModal
          course={courseModal === "new" ? null : courseModal}
          lessons={lessons}
          onSave={async (c) => {
            if (isReal && tenantId) {
              const { data: saved, error } = await upsertCourse(tenantId, c, user?.id);
              if (error) { console.error("[ralli] upsertCourse failed:", error); toast.error("Failed to save course. Please try again."); }
              const canonical = saved ?? { ...c, id: c.id || "lc" + Date.now() };
              setCourses(prev => courseModal === "new"
                ? [...prev, canonical]
                : prev.map(x => x.id === c.id ? canonical : x));
            } else {
              if (courseModal === "new") {
                setCourses(prev => [...prev, { ...c, id: "lc" + Date.now(), createdAt: "Today" }]);
              } else {
                setCourses(prev => prev.map(x => x.id === c.id ? c : x));
              }
            }
            toast.success("Course saved.");
            setCourseModal(null);
          }}
          onClose={() => setCourseModal(null)}
          onCreateLesson={async (newLesson) => {
            if (isReal && tenantId) {
              const { data: saved, error } = await upsertLesson(tenantId, newLesson, user?.id);
              if (error) { console.error("[ralli] upsertLesson (inline) failed:", error); toast.error("Failed to create lesson. Please try again."); }
              const withId = saved ?? { ...newLesson, id: "ll" + Date.now() };
              setLessons(prev => [...prev, withId]);
              return withId.id;
            }
            const withId = { ...newLesson, id: "ll" + Date.now() };
            setLessons(prev => [...prev, withId]);
            return withId.id;
          }}
        />
      )}

      {/* LESSON BUILDER MODAL */}
      {lessonModal && (
        <LessonBuilderModal
          lesson={lessonModal === "new" ? null : (typeof lessonModal === "string" ? null : lessonModal)}
          onSave={async (l) => {
            if (isReal && tenantId) {
              const { data: saved, error } = await upsertLesson(tenantId, l, user?.id);
              if (error) { console.error("[ralli] upsertLesson failed:", error); toast.error("Failed to save lesson. Please try again."); }
              const canonical = saved ?? { ...l, id: l.id || "ll" + Date.now() };
              setLessons(prev => prev.some(x => x.id === l.id)
                ? prev.map(x => x.id === l.id ? canonical : x)
                : [...prev, canonical]);
            } else {
              const withId = { ...l, id: "ll" + Date.now() };
              if (!l.id) {
                setLessons(prev => [...prev, withId]);
              } else {
                setLessons(prev => prev.map(x => x.id === l.id ? l : x));
              }
            }
            toast.success("Lesson saved.");
            setLessonModal(null);
          }}
          onClose={() => setLessonModal(null)}
        />
      )}

      {/* ASSIGN MODAL */}
      {assignModal && (
        <AssignContentModal
          contentType={assignModal.contentType}
          contentId={assignModal.contentId}
          content={assignModal.contentType === "course" ? courses.find(c => c.id === assignModal.contentId) : lessons.find(l => l.id === assignModal.contentId)}
          orgUsers={orgUsers}
          orgs={orgs}
          currentUser={user}
          tenantId={tenantId}
          isReal={isReal}
          onAssign={async (assignment) => {
            if (isReal && tenantId) {
              const { data: saved, error } = await dbCreateAssignment(tenantId, assignment, user?.id);
              if (error) { console.error("[ralli] createAssignment failed:", error); toast.error("Failed to create assignment. Please try again."); }
              else { toast.success("Assignment created."); }
              const canonical = saved ?? { ...assignment, id: "a" + Date.now(), assignedAt: "Today" };
              // Guard: if createAssignment returned an existing row, don't add it twice to state
              setAssignments(prev => prev.some(a => a.id === canonical.id) ? prev : [...prev, canonical]);
            } else {
              setAssignments(prev => [...prev, { ...assignment, id: "a" + Date.now(), assignedAt: "Today" }]);
              toast.success("Assignment created.");
            }
            setAssignModal(null);
            setTab("assignments");
          }}
          onClose={() => setAssignModal(null)}
        />
      )}
    </div>
  );
}

// ── LESSON VIEWER (user) ────────────────────────────────────
const FlipIcon = ({ color }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
    <path d="M21 3v5h-5"/>
  </svg>
);

function FlipCard({ front, back }) {
  const [flipped, setFlipped] = React.useState(false);
  const accentColor = flipped ? LESSON_TYPE_COLORS.flipcard : C.textMuted;
  return (
    <div onClick={() => setFlipped(f => !f)} style={{
      cursor: "pointer", minHeight: 200, borderRadius: 14, padding: 32,
      background: flipped ? LESSON_TYPE_COLORS.flipcard + "12" : C.white,
      border: `2px solid ${flipped ? LESSON_TYPE_COLORS.flipcard : C.border}`,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, textAlign: "center",
      transition: "background 0.2s, border-color 0.2s",
      userSelect: "none",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: accentColor, letterSpacing: "0.1em" }}>
        {flipped ? "BACK" : "FRONT"}
        <FlipIcon color={accentColor} />
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text, lineHeight: 1.5, maxWidth: 440 }}>
        {flipped ? back : front}
      </div>
    </div>
  );
}

function LessonQuiz({ question, options, correctIdx }) {
  const [selected, setSelected] = React.useState(null);
  const submitted = selected !== null;
  return (
    <div style={{ background: C.white, borderRadius: 14, padding: 28, border: `1px solid ${C.border}` }}>
      <p style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700, color: C.text, lineHeight: 1.5 }}>{question}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {(options ?? []).map((opt, i) => {
          const isCorrect = i === correctIdx;
          const isSelected = i === selected;
          let bg = C.pageBg, border = C.border, color = C.text;
          if (submitted) {
            if (isCorrect)  { bg = C.greenBg;  border = C.green;  color = C.green; }
            else if (isSelected) { bg = C.redBg; border = C.red;   color = C.red; }
          } else if (isSelected) {
            bg = C.orangeLight; border = C.orange; color = C.orange;
          }
          return (
            <button key={i} onClick={() => !submitted && setSelected(i)} style={{
              padding: "12px 16px", borderRadius: 10, border: `2px solid ${border}`,
              background: bg, color, fontSize: 14, fontWeight: 600, cursor: submitted ? "default" : "pointer",
              display: "flex", alignItems: "center", gap: 10, textAlign: "left",
            }}>
              <span style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, background: border + "20", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>
                {submitted && isCorrect ? "✓" : submitted && isSelected ? "✗" : String.fromCharCode(65 + i)}
              </span>
              {opt}
            </button>
          );
        })}
      </div>
      {submitted && (
        <p style={{ margin: "16px 0 0", fontSize: 13, color: selected === correctIdx ? C.green : C.red, fontWeight: 700 }}>
          {selected === correctIdx ? "Correct!" : `Incorrect — the correct answer is ${String.fromCharCode(65 + correctIdx)}.`}
        </p>
      )}
    </div>
  );
}

// Converts a lesson to an ordered block array.
// New lessons: content.blocks = [{ id, type, content }]
// Legacy lessons: synthesise a single block from the old flat content + type fields.
function getBlocks(lesson) {
  const c = lesson?.content ?? {};
  if (Array.isArray(c.blocks) && c.blocks.length > 0) return c.blocks;
  // Legacy single-type lesson
  const type = lesson?.type ?? "text";
  return [{ id: "legacy", type, content: c }];
}

// Render a single content block. Used by both viewer and previews.
function LessonBlock({ block, cardStyle }) {
  const c = block.content ?? {};
  const style = cardStyle ?? { background: "#fff", borderRadius: 14, padding: 28, border: "1px solid #E5E7EB" };
  const header = block.header?.trim() || null;

  const withHeader = (node) => {
    if (!node) return null;
    if (!header) return node;
    return (
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10, letterSpacing: "-0.01em" }}>{header}</div>
        {node}
      </div>
    );
  };

  if (block.type === "text") {
    if (!c.body) return null;
    // Minimal markdown renderer: **bold**, *italic*, __underline__, - bullets, 1. numbered
    const parseInline = (text) => {
      const parts = [];
      let rest = text, k = 0;
      while (rest) {
        const m = rest.match(/(\*\*(.+?)\*\*)|(__(.+?)__)|(\*(.+?)\*)/);
        if (!m) { parts.push(rest); break; }
        if (m.index > 0) parts.push(rest.slice(0, m.index));
        if (m[1]) parts.push(<strong key={k++}>{m[2]}</strong>);
        else if (m[3]) parts.push(<u key={k++}>{m[4]}</u>);
        else parts.push(<em key={k++}>{m[6]}</em>);
        rest = rest.slice(m.index + m[0].length);
      }
      return parts;
    };
    const renderBody = (text) => {
      const lines = text.split("\n");
      const out = [];
      let i = 0;
      while (i < lines.length) {
        if (lines[i].startsWith("- ")) {
          const items = [];
          while (i < lines.length && lines[i].startsWith("- ")) { items.push(lines[i].slice(2)); i++; }
          out.push(<ul key={i} style={{ margin: "4px 0 8px", paddingLeft: 22 }}>{items.map((t, j) => <li key={j} style={{ fontSize: 14, lineHeight: 1.8, color: C.text }}>{parseInline(t)}</li>)}</ul>);
        } else if (/^\d+\.\s/.test(lines[i])) {
          const items = [];
          while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s/, "")); i++; }
          out.push(<ol key={i} style={{ margin: "4px 0 8px", paddingLeft: 22 }}>{items.map((t, j) => <li key={j} style={{ fontSize: 14, lineHeight: 1.8, color: C.text }}>{parseInline(t)}</li>)}</ol>);
        } else if (lines[i] === "") {
          out.push(<br key={i} />);
          i++;
        } else {
          out.push(<p key={i} style={{ margin: "0 0 6px", fontSize: 14, lineHeight: 1.8, color: C.text }}>{parseInline(lines[i])}</p>);
          i++;
        }
      }
      return out;
    };
    return withHeader(
      <div style={style}>
        <div style={{ wordBreak: "break-word" }}>{renderBody(c.body)}</div>
      </div>
    );
  }
  if (block.type === "image") {
    if (!c.imageUrl) return null;
    return withHeader(
      <div style={{ ...style, textAlign: "center" }}>
        <img src={c.imageUrl} alt={c.caption ?? ""} style={{ maxWidth: "100%", maxHeight: 420, borderRadius: 8, objectFit: "contain" }} />
        {c.caption && <p style={{ margin: "12px 0 0", fontSize: 13, color: C.textSub }}>{c.caption}</p>}
      </div>
    );
  }
  if (block.type === "video") {
    const url = c.videoUrl ?? "";
    const embedUrl = url.replace("watch?v=", "embed/").replace("youtu.be/", "youtube.com/embed/");
    return withHeader(
      <div style={style}>
        {url ? (
          <div style={{ position: "relative", paddingBottom: "56.25%", height: 0, marginBottom: c.notes ? 20 : 0 }}>
            <iframe src={embedUrl} title="video" frameBorder="0" allowFullScreen
              style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", borderRadius: 8 }} />
          </div>
        ) : null}
        {c.notes && (
          <>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textSub, marginBottom: 8, letterSpacing: "0.06em" }}>LESSON NOTES</div>
            <pre style={{ margin: 0, fontSize: 13, color: C.text, lineHeight: 1.7, fontFamily: "inherit", whiteSpace: "pre-wrap" }}>{c.notes}</pre>
          </>
        )}
      </div>
    );
  }
  if (block.type === "flipcard") {
    if (!c.front && !c.back) return null;
    return withHeader(<FlipCard front={c.front ?? ""} back={c.back ?? ""} />);
  }
  if (block.type === "quiz") {
    if (!c.question) return null;
    return withHeader(<LessonQuiz question={c.question} options={c.options ?? []} correctIdx={c.correctIdx ?? 0} />);
  }
  if (block.type === "recording") {
    return withHeader(
      <div style={style}>
        {c.prompt && (
          <>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textSub, marginBottom: 8, letterSpacing: "0.06em" }}>PROMPT</div>
            <p style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 600, color: C.text, lineHeight: 1.6 }}>{c.prompt}</p>
          </>
        )}
        {c.criteria && (
          <>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textSub, marginBottom: 8, letterSpacing: "0.06em" }}>EVALUATION CRITERIA</div>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: C.textSub, lineHeight: 1.6 }}>{c.criteria}</p>
          </>
        )}
        <div style={{ padding: "18px 20px", borderRadius: 10, background: C.orangeLight, border: `1px solid ${C.orange}30`, display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span style={{ fontSize: 22, flexShrink: 0, lineHeight: 1.4 }}>🎙️</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>Practice your delivery</div>
            <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.55 }}>
              Use the prompt above to rehearse. Recording submission will be available in an upcoming update — for now, practice on your own and mark this lesson complete when ready.
            </div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function LessonViewerScreen({ lesson, courseTitle, onBack, completed, onComplete, nextLesson, onNextLesson }) {
  const [isDone, setIsDone] = React.useState(completed ?? false);
  const [showXp,  setShowXp]  = React.useState(false);

  const handleComplete = () => {
    if (!isDone) {
      setIsDone(true);
      setShowXp(true);
      onComplete?.(lesson.id);
      setTimeout(() => setShowXp(false), 3000);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Back nav */}
      <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.textSub, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, padding: 0, alignSelf: "flex-start" }}>
        ← {courseTitle ? `Back to ${courseTitle}` : "Back to My Learning"}
      </button>

      {/* Lesson header */}
      <div style={{ background: C.white, borderRadius: 14, padding: 28, border: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: (LESSON_TYPE_COLORS[lesson.type] ?? C.orange) + "20",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0,
          }}>
            {LESSON_TYPE_ICONS[lesson.type]}
          </div>
          <div style={{ flex: 1 }}>
            {courseTitle && <div style={{ fontSize: 12, fontWeight: 700, color: C.orange, letterSpacing: "0.08em", marginBottom: 4 }}>{courseTitle.toUpperCase()}</div>}
            <h2 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800, color: C.text }}>{lesson.title}</h2>
            <div style={{ display: "flex", gap: 16, fontSize: 13, color: C.textSub }}>
              <span>⏱ {lesson.duration}</span>
              <span style={{ color: C.orange, fontWeight: 700 }}>{lesson.xp} XP</span>
            </div>
          </div>
          {isDone && (
            <span style={{ fontSize: 12, fontWeight: 700, padding: "5px 10px", borderRadius: 8, background: C.greenBg, color: C.green, flexShrink: 0 }}>✓ Complete</span>
          )}
        </div>
      </div>

      {/* XP flash */}
      {showXp && (
        <div style={{ padding: "14px 20px", borderRadius: 12, background: C.orangeLight, border: `1px solid ${C.orange}40`, display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.orange }}>+{lesson.xp} XP earned!</div>
            <div style={{ fontSize: 12, color: C.textSub }}>Lesson complete</div>
          </div>
        </div>
      )}

      {/* Content blocks — renders all blocks in order */}
      {(() => {
        const cardStyle = { background: C.white, borderRadius: 14, padding: 28, border: `1px solid ${C.border}` };
        const blocks = getBlocks(lesson);
        const rendered = blocks.map((block, i) => {
          const node = <LessonBlock key={block.id ?? i} block={block} cardStyle={cardStyle} />;
          return node;
        }).filter(Boolean);
        if (rendered.length === 0) {
          return (
            <div style={{ ...cardStyle, textAlign: "center", color: C.textSub, fontSize: 14, padding: 48 }}>
              No content yet.
            </div>
          );
        }
        return <>{rendered}</>;
      })()}

      {/* Actions */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button onClick={onBack} style={{ padding: "10px 20px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          Back
        </button>
        {(() => {
          const isRecordingLesson = lesson?.type === "recording" || getBlocks(lesson).some(b => b.type === "recording");
          if (!isDone && isRecordingLesson) {
            return (
              <div style={{ padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.pageBg, fontSize: 13, color: C.textMuted, fontWeight: 600, textAlign: "center" }}>
                Recording submission coming soon
              </div>
            );
          }
          if (!isDone) {
            return (
              <button onClick={handleComplete} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Mark Complete · +{lesson.xp} XP
              </button>
            );
          }
          if (nextLesson) {
            return (
              <button onClick={() => onNextLesson?.(nextLesson)} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Next: {nextLesson.title.length > 28 ? nextLesson.title.slice(0, 28) + "…" : nextLesson.title} →
              </button>
            );
          }
          return (
            <button onClick={onBack} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: C.green, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              ✓ Done
            </button>
          );
        })()}
      </div>
    </div>
  );
}


function CourseBuilderModal({ course, lessons, onSave, onClose, onCreateLesson }) {
  const EMOJIS = ["", "", "", "", "", "", "", ""];
  const COLORS = [C.orange, C.blue, C.purple, C.green, C.red, "#F59E0B"];
  const [title,    setTitle]    = useState(course?.title ?? "");
  const [desc,     setDesc]     = useState(course?.description ?? "");
  const [emoji,    setEmoji]    = useState(course?.emoji ?? "");
  const [color,    setColor]    = useState(course?.color ?? C.orange);
  const [required, setRequired] = useState(course?.required ?? false);
  // Initialise from saved lessonIds: dedupe + filter to IDs that exist in the
  // current lesson list, matching the same logic used by the course card count.
  const [selectedLessons, setSelectedLessons] = useState(() => {
    const knownIds = new Set(lessons.map(l => l.id));
    return [...new Set(course?.lessonIds ?? [])].filter(id => knownIds.has(id));
  });
  // schedule: { [lessonId]: { available_after_days: number } }
  const [schedule, setSchedule] = useState(() => {
    const s = course?.lessonSchedule ?? {};
    // Normalise any old string-timing format to integer days
    const result = {};
    for (const [id, val] of Object.entries(s)) {
      if (typeof val?.available_after_days === "number") {
        result[id] = { available_after_days: val.available_after_days };
      } else if (val?.timing) {
        const dayMap = { immediately: 0, day1: 1, day2: 2, week1: 7, custom: val.customDays ?? 1 };
        result[id] = { available_after_days: dayMap[val.timing] ?? 0 };
      }
    }
    return result;
  });
  const [localLessons, setLocalLessons] = useState(lessons); // includes newly-created ones
  const [showNewLesson, setShowNewLesson] = useState(false);
  const [showExistingPicker, setShowExistingPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");

  // Always dedupe on write so count is always accurate
  const toggleLesson = (id) => setSelectedLessons(prev => {
    if (prev.includes(id)) return prev.filter(x => x !== id);
    return [...new Set([...prev, id])];
  });
  const removeLesson = (id) => setSelectedLessons(prev => prev.filter(x => x !== id));

  const setDays = (id, days) => setSchedule(prev => ({ ...prev, [id]: { available_after_days: Math.max(0, parseInt(days, 10) || 0) } }));

  // Dedupe before saving
  const handleSave = () => {
    if (!title.trim()) return;
    onSave({ ...(course || {}), title, description: desc, emoji, color, required, lessonIds: [...new Set(selectedLessons)], lessonSchedule: schedule });
  };

  // Dedupe for display
  const uniqueSelected = [...new Set(selectedLessons)];

  if (showNewLesson) {
    return (
      <LessonBuilderModal
        lesson={null}
        onSave={async (l) => {
          // onCreateLesson is async for real users (awaits Supabase insert).
          // Must await here so newId is a UUID string, not a Promise.
          const newId = onCreateLesson
            ? await onCreateLesson(l)
            : ("ll" + Date.now());
          const created = { ...l, id: newId };
          setLocalLessons(prev => {
            if (prev.some(x => x.id === newId)) return prev;
            return [...prev, created];
          });
          setSelectedLessons(prev => [...new Set([...prev, newId])]);
          setShowNewLesson(false);
        }}
        onClose={() => setShowNewLesson(false)}
      />
    );
  }

  if (showExistingPicker) {
    const q = pickerSearch.toLowerCase();
    const filtered = localLessons.filter(l =>
      !q || l.title?.toLowerCase().includes(q) || l.description?.toLowerCase().includes(q)
    );
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
        <div style={{ background: C.white, borderRadius: 16, padding: 24, width: "100%", maxWidth: 560, maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 60px rgba(0,0,0,0.2)" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>Add Existing Lesson</h3>
            <button onClick={() => setShowExistingPicker(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
          </div>
          {/* Search */}
          <input
            autoFocus
            value={pickerSearch}
            onChange={e => setPickerSearch(e.target.value)}
            placeholder="Search lessons by title or description…"
            style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text, background: C.pageBg, marginBottom: 12, boxSizing: "border-box" }}
          />
          {/* Lesson list */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 2 }}>
            {filtered.length === 0 && (
              <div style={{ padding: 32, textAlign: "center", color: C.textSub, fontSize: 13 }}>
                {localLessons.length === 0 ? "No lessons yet — create one first." : "No lessons match your search."}
              </div>
            )}
            {filtered.map(l => {
              const sel = selectedLessons.includes(l.id);
              const typeColor = LESSON_TYPE_COLORS[l.type] ?? C.orange;
              return (
                <div key={l.id} onClick={() => toggleLesson(l.id)} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 10, cursor: "pointer",
                  border: `2px solid ${sel ? C.orange : C.border}`, background: sel ? C.orangeLight : C.pageBg,
                }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                    background: sel ? C.orange : C.muted, border: `2px solid ${sel ? C.orange : C.border}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {sel && <span style={{ fontSize: 10, color: "#fff", fontWeight: 800 }}>✓</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: sel ? C.orange : C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</div>
                    <div style={{ fontSize: 11, color: C.textSub }}>{(l.type ?? "").toUpperCase()} · {l.duration} · {l.xp} XP</div>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Done */}
          <button
            onClick={() => { setShowExistingPicker(false); setPickerSearch(""); }}
            style={{ marginTop: 16, padding: "11px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
          >
            Done — {uniqueSelected.length} lesson{uniqueSelected.length !== 1 ? "s" : ""} selected
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.white, borderRadius: 16, padding: 28, width: "100%", maxWidth: 600, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.text }}>{course ? "Edit Course" : "New Course"}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
        </div>

        {/* Classification */}
        <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 8 }}>CLASSIFICATION</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {[{ val: false, label: "Recommended" }, { val: true, label: "Required" }].map(opt => (
            <button key={String(opt.val)} onClick={() => setRequired(opt.val)} style={{
              padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700,
              border: `2px solid ${required === opt.val ? (opt.val ? C.red : C.orange) : C.border}`,
              background: required === opt.val ? (opt.val ? C.redBg : C.orangeLight) : C.pageBg,
              color: required === opt.val ? (opt.val ? C.red : C.orange) : C.textSub,
            }}>{opt.label}</button>
          ))}
        </div>

        {/* Color picker */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 8 }}>COLOR</label>
          <div style={{ display: "flex", gap: 6 }}>
            {COLORS.map(col => (
              <button key={col} onClick={() => setColor(col)} style={{
                width: 28, height: 28, borderRadius: "50%", border: `3px solid ${color === col ? C.text : "transparent"}`,
                background: col, cursor: "pointer",
              }} />
            ))}
          </div>
        </div>

        <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6 }}>COURSE TITLE</label>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Objection Handling Mastery" style={{
          width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
          fontSize: 14, fontWeight: 600, color: C.text, background: C.pageBg, marginBottom: 16, boxSizing: "border-box",
        }} />

        <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6 }}>DESCRIPTION</label>
        <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="What will reps learn from this course?" rows={3} style={{
          width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
          fontSize: 13, color: C.text, background: C.pageBg, resize: "vertical", marginBottom: 20, boxSizing: "border-box", lineHeight: 1.5,
        }} />

        <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 10 }}>
          LESSONS ({uniqueSelected.length} selected)
        </label>

        {/* Selected lessons — compact ordered list with schedule + remove */}
        {uniqueSelected.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {uniqueSelected.map((id, i) => {
              const l = localLessons.find(x => x.id === id);
              if (!l) return null;
              return (
                <div key={id} style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.pageBg, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                      background: C.orange, display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, fontWeight: 800, color: "#fff",
                    }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</div>
                      <div style={{ fontSize: 11, color: C.textSub }}>{l.duration} · {l.xp} XP</div>
                    </div>
                    <button onClick={() => removeLesson(id)} style={{ background: "none", border: "none", color: C.textMuted, fontSize: 16, cursor: "pointer", padding: "0 4px", lineHeight: 1, flexShrink: 0 }}>×</button>
                  </div>
                  {/* Availability timing */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px 10px 44px" }}>
                    <span style={{ fontSize: 11, color: C.textSub, fontWeight: 600 }}>Available after</span>
                    <input
                      type="number" min={0} max={365}
                      value={schedule[id]?.available_after_days ?? 0}
                      onChange={e => setDays(id, e.target.value)}
                      style={{ width: 48, fontSize: 11, padding: "3px 6px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.white, textAlign: "center" }}
                    />
                    <span style={{ fontSize: 11, color: C.textSub }}>
                      {(schedule[id]?.available_after_days ?? 0) === 0 ? "days (immediately)" : "days after assignment"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add lesson buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowExistingPicker(true)} style={{
            flex: 1, padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
            background: C.pageBg, color: C.text, fontSize: 12, fontWeight: 700, cursor: "pointer", textAlign: "center",
          }}>+ Add Existing Lesson</button>
          {onCreateLesson && (
            <button onClick={() => setShowNewLesson(true)} style={{
              flex: 1, padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.orange}`,
              background: C.orangeLight, color: C.orange, fontSize: 12, fontWeight: 700, cursor: "pointer", textAlign: "center",
            }}>+ Create New Lesson</button>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "11px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} disabled={!title.trim()} style={{
            flex: 2, padding: "11px", borderRadius: 8, border: "none",
            background: title.trim() ? C.orange : C.muted, color: title.trim() ? "#fff" : C.textMuted,
            fontSize: 13, fontWeight: 700, cursor: title.trim() ? "pointer" : "default",
          }}>
            {course ? "Save Changes" : "Create Course"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── LESSON BUILDER MODAL ────────────────────────────────────
// Inline block editor — renders type-specific fields for one block.
// ─── WYSIWYG rich-text helpers (text block editor) ──────────────────────────
// Converts our markdown subset ↔ contenteditable innerHTML.
// Supported: **bold**, *italic*, __underline__, - bullets, 1. numbered.
function mdToHtml(text) {
  if (!text) return "<p><br></p>";
  const inline = (s) => s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
  const lines = text.split("\n");
  let out = "", inUl = false, inOl = false;
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (inOl) { out += "</ol>"; inOl = false; }
      if (!inUl) { out += "<ul>"; inUl = true; }
      out += `<li>${inline(line.slice(2))}</li>`;
    } else if (/^\d+\.\s/.test(line)) {
      if (inUl) { out += "</ul>"; inUl = false; }
      if (!inOl) { out += "<ol>"; inOl = true; }
      out += `<li>${inline(line.replace(/^\d+\.\s/, ""))}</li>`;
    } else {
      if (inUl) { out += "</ul>"; inUl = false; }
      if (inOl) { out += "</ol>"; inOl = false; }
      out += line === "" ? "<p><br></p>" : `<p>${inline(line)}</p>`;
    }
  }
  if (inUl) out += "</ul>";
  if (inOl) out += "</ol>";
  return out;
}
function htmlToMd(el) {
  function walk(node) {
    if (node.nodeType === 3) {
      return node.textContent;
    }
    const tag = node.nodeName;
    const inner = () => Array.from(node.childNodes).map(walk).join("");
    if (tag === "BR")                    return "\n";
    if (tag === "STRONG" || tag === "B") return `**${inner()}**`;
    if (tag === "EM"     || tag === "I") return `*${inner()}*`;
    if (tag === "U")                     return `__${inner()}__`;
    if (tag === "P" || tag === "DIV") {
      const text = inner();
      // <p><br></p> or <div><br></div> = blank line
      if (text === "\n" || text === "") return "\n";
      return text + "\n";
    }
    if (tag === "SPAN") return inner();
    if (tag === "UL") {
      return Array.from(node.children).map(li => `- ${htmlToMd(li)}`).join("\n") + "\n";
    }
    if (tag === "OL") {
      return Array.from(node.children).map((li, i) => `${i + 1}. ${htmlToMd(li)}`).join("\n") + "\n";
    }
    if (tag === "LI") return inner();
    return inner();
  }
  const raw = Array.from(el.childNodes).map(walk).join("");
  return raw.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

// Used inside LessonBuilderModal.
function BlockEditor({ block, onChange, onRemove, onMoveUp, onMoveDown, isFirst, isLast }) {
  const BLOCK_TYPES   = ["text", "image", "video", "flipcard", "quiz", "recording"];
  const BLOCK_LABELS  = { text: "Text", image: "Image", video: "Video", flipcard: "Flip Card", quiz: "Quiz", recording: "Recording" };
  const c             = block.content ?? {};
  const setC          = (key, val) => onChange({ ...block, content: { ...c, [key]: val } });
  const setHeader     = (val)      => onChange({ ...block, header: val });
  const setType       = (t)        => onChange({ ...block, type: t, content: {} });

  // WYSIWYG rich-text for text blocks — contenteditable + execCommand
  const editRef   = React.useRef(null);
  // Initialize (or re-initialize when block type switches to "text")
  React.useEffect(() => {
    if (block.type !== "text" || !editRef.current) return;
    editRef.current.innerHTML = mdToHtml(c.body ?? "");
  }, [block.type]); // eslint-disable-line react-hooks/exhaustive-deps
  // Sync contenteditable DOM → markdown state
  const syncToMd = () => {
    if (!editRef.current) return;
    setC("body", htmlToMd(editRef.current));
  };
  const execFmt = (cmd) => {
    editRef.current?.focus();
    document.execCommand(cmd, false, null);
    setTimeout(syncToMd, 0);
  };
  const fmtBtn = (label, title, action) => (
    <button key={title} type="button" onClick={action} title={title} style={{
      padding: "3px 8px", borderRadius: 5, border: `1px solid ${C.border}`,
      background: C.white, fontSize: 12, cursor: "pointer", color: C.textSub, lineHeight: 1.4,
    }}>{label}</button>
  );

  const inputStyle = { width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text, background: C.pageBg, boxSizing: "border-box" };
  const taStyle    = { ...inputStyle, resize: "vertical", lineHeight: 1.5 };
  const blockColor = LESSON_TYPE_COLORS[block.type] ?? C.orange;

  return (
    <div style={{ border: `1.5px solid ${blockColor}30`, borderRadius: 12, padding: 16, background: C.pageBg, position: "relative" }}>
      {/* Block header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 6, height: 6, borderRadius: 2, background: blockColor, flexShrink: 0 }} />
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
          {BLOCK_TYPES.map(t => {
            const isActive = block.type === t;
            const isSoon   = t === "recording" && !isActive;
            return (
              <button key={t} onClick={() => { if (!isSoon) setType(t); }}
                title={isSoon ? "Recording coming soon" : undefined}
                style={{
                  padding: "3px 8px", borderRadius: 6,
                  border: `1.5px solid ${isActive ? blockColor : C.border}`,
                  background: isActive ? blockColor + "15" : C.white,
                  fontSize: 11, fontWeight: 700,
                  color: isSoon ? C.textMuted : isActive ? blockColor : C.textSub,
                  cursor: isSoon ? "not-allowed" : "pointer",
                  opacity: isSoon ? 0.55 : 1,
                }}>
                {BLOCK_LABELS[t]}{isSoon ? " ·  soon" : ""}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {!isFirst  && <button onClick={onMoveUp}   title="Move up"   style={{ padding: "3px 7px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.white, cursor: "pointer", fontSize: 13, color: C.textSub }}>↑</button>}
          {!isLast   && <button onClick={onMoveDown} title="Move down" style={{ padding: "3px 7px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.white, cursor: "pointer", fontSize: 13, color: C.textSub }}>↓</button>}
          <button onClick={onRemove} title="Remove block" style={{ padding: "3px 7px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.white, cursor: "pointer", fontSize: 13, color: C.red }}>✕</button>
        </div>
      </div>

      {/* Optional section header */}
      <input
        value={block.header ?? ""}
        onChange={e => setHeader(e.target.value)}
        placeholder="Section header (optional)"
        style={{ ...inputStyle, marginBottom: 12, fontWeight: 600 }}
      />

      {/* Type-specific fields */}
      {block.type === "text" && (
        <>
          <div style={{ display: "flex", gap: 5, marginBottom: 6, flexWrap: "wrap" }}>
            {fmtBtn(<b>B</b>,  "Bold",          () => execFmt("bold"))}
            {fmtBtn(<i>I</i>,  "Italic",        () => execFmt("italic"))}
            {fmtBtn(<u>U</u>,  "Underline",     () => execFmt("underline"))}
            {fmtBtn("•—",      "Bullet list",   () => execFmt("insertUnorderedList"))}
            {fmtBtn("1.",      "Numbered list", () => execFmt("insertOrderedList"))}
          </div>
          <div
            ref={editRef}
            contentEditable
            suppressContentEditableWarning
            onInput={syncToMd}
            onBlur={syncToMd}
            style={{
              ...inputStyle,
              minHeight: 120,
              outline: "none",
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.7,
              cursor: "text",
            }}
          />
        </>
      )}
      {block.type === "image" && (
        <>
          <input value={c.imageUrl ?? ""} onChange={e => setC("imageUrl", e.target.value)}
            placeholder="Image URL — https://example.com/image.png" style={{ ...inputStyle, marginBottom: 8 }} />
          {c.imageUrl && <img src={c.imageUrl} alt="preview" onError={e => { e.target.style.display = "none"; }}
            style={{ width: "100%", maxHeight: 160, objectFit: "cover", borderRadius: 8, marginBottom: 8 }} />}
          <input value={c.caption ?? ""} onChange={e => setC("caption", e.target.value)}
            placeholder="Caption (optional)" style={inputStyle} />
        </>
      )}
      {block.type === "video" && (
        <>
          <input value={c.videoUrl ?? ""} onChange={e => setC("videoUrl", e.target.value)}
            placeholder="YouTube or Vimeo URL" style={{ ...inputStyle, marginBottom: 8 }} />
          <textarea value={c.notes ?? ""} onChange={e => setC("notes", e.target.value)}
            placeholder="Notes / transcript (optional)" rows={3} style={taStyle} />
        </>
      )}
      {block.type === "flipcard" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textSub, marginBottom: 5 }}>FRONT</div>
            <textarea value={c.front ?? ""} onChange={e => setC("front", e.target.value)}
              placeholder="Question, term, or prompt" rows={4} style={taStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textSub, marginBottom: 5 }}>BACK</div>
            <textarea value={c.back ?? ""} onChange={e => setC("back", e.target.value)}
              placeholder="Answer, definition, or explanation" rows={4} style={taStyle} />
          </div>
        </div>
      )}
      {block.type === "quiz" && (() => {
        const opts    = c.options    ?? ["", "", "", ""];
        const correct = c.correctIdx ?? 0;
        const setOpt  = (i, val) => setC("options", opts.map((o, j) => j === i ? val : o));
        return (
          <>
            <input value={c.question ?? ""} onChange={e => setC("question", e.target.value)}
              placeholder="Question" style={{ ...inputStyle, marginBottom: 10 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {opts.map((opt, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => setC("correctIdx", i)} style={{
                    width: 22, height: 22, borderRadius: "50%", flexShrink: 0, cursor: "pointer",
                    border: `2px solid ${correct === i ? C.green : C.border}`,
                    background: correct === i ? C.green : C.pageBg,
                  }} />
                  <input value={opt} onChange={e => setOpt(i, e.target.value)}
                    placeholder={`Option ${String.fromCharCode(65 + i)}`} style={{ ...inputStyle, flex: 1 }} />
                </div>
              ))}
            </div>
          </>
        );
      })()}
      {block.type === "recording" && (
        <>
          <textarea value={c.prompt ?? ""} onChange={e => setC("prompt", e.target.value)}
            placeholder="Recording prompt — what should the rep record?" rows={3}
            style={{ ...taStyle, marginBottom: 8 }} />
          <textarea value={c.criteria ?? ""} onChange={e => setC("criteria", e.target.value)}
            placeholder="Evaluation criteria (optional)" rows={2} style={taStyle} />
        </>
      )}
    </div>
  );
}

function LessonBuilderModal({ lesson, onSave, onClose }) {
  const inputStyle = { width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text, background: C.pageBg, boxSizing: "border-box" };
  const taStyle    = { ...inputStyle, resize: "vertical", lineHeight: 1.5 };

  const [title,  setTitle]  = useState(lesson?.title ?? "");
  const [desc,   setDesc]   = useState(lesson?.description ?? "");
  const [dur,    setDur]    = useState(lesson?.duration ?? "15 min");
  const [xp,     setXp]     = useState(lesson?.xp ?? 100);
  const [status, setStatus] = useState(lesson?.status ?? "active");
  const [preview, setPreview] = useState(false);

  // Blocks — load from lesson (new format) or synthesise from legacy content
  const [blocks, setBlocks] = useState(() => getBlocks(lesson ?? {}));

  const addBlock = (type) => setBlocks(prev => [...prev, { id: "b" + Date.now(), type, content: {} }]);
  const updateBlock = (i, updated) => setBlocks(prev => prev.map((b, j) => j === i ? updated : b));
  const removeBlock = (i) => setBlocks(prev => prev.filter((_, j) => j !== i));
  const moveBlock   = (i, dir) => setBlocks(prev => {
    const arr = [...prev];
    const target = i + dir;
    if (target < 0 || target >= arr.length) return arr;
    [arr[i], arr[target]] = [arr[target], arr[i]];
    return arr;
  });

  const handleSave = () => {
    if (!title.trim()) return;
    // primary type = first block's type (used for card icon/color)
    const primaryType = blocks[0]?.type ?? "text";
    onSave({ ...(lesson || {}), title, type: primaryType, description: desc, duration: dur, xp: Number(xp), status, content: { blocks } });
  };

  const ADD_TYPES = [
    { type: "text",     label: "+ Text" },
    { type: "image",    label: "+ Image" },
    { type: "video",    label: "+ Video" },
    { type: "flipcard", label: "+ Flip Card" },
    { type: "quiz",     label: "+ Quiz" },
    // recording omitted — not yet implemented
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.white, borderRadius: 16, padding: 28, width: "100%", maxWidth: 620, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.2)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.text }}>{lesson ? "Edit Lesson" : "New Lesson"}</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setPreview(p => !p)} style={{
              padding: "6px 14px", borderRadius: 8, border: `1px solid ${C.border}`,
              background: preview ? C.orange : C.white, color: preview ? "#fff" : C.textSub,
              fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}>{preview ? "← Edit" : "Preview"}</button>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
          </div>
        </div>

        {/* Preview mode */}
        {preview && (
          <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.pageBg, padding: "20px 24px", marginBottom: 20, minHeight: 200 }}>
            <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 800, color: C.text }}>{title || "Untitled Lesson"}</h2>
            {desc && <p style={{ margin: "0 0 20px", fontSize: 13, color: C.textSub }}>{desc}</p>}
            {blocks.length === 0 && <p style={{ color: C.textMuted, fontSize: 13 }}>No content blocks yet.</p>}
            {blocks.map((block, i) => (
              <LessonBlock key={block.id ?? i} block={block} />
            ))}
          </div>
        )}

        {/* Metadata (hidden in preview) */}
        {!preview && <>
        <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6 }}>LESSON TITLE</label>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Cold Call Opening Framework"
          style={{ ...inputStyle, fontWeight: 600, fontSize: 14, marginBottom: 14 }} />

        <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6 }}>DESCRIPTION / OBJECTIVES</label>
        <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="What will reps learn?" rows={2}
          style={{ ...taStyle, marginBottom: 22 }} />

        {/* Content blocks */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub }}>CONTENT BLOCKS ({blocks.length})</label>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
          {blocks.map((block, i) => (
            <BlockEditor
              key={block.id ?? i}
              block={block}
              onChange={(updated) => updateBlock(i, updated)}
              onRemove={() => removeBlock(i)}
              onMoveUp={() => moveBlock(i, -1)}
              onMoveDown={() => moveBlock(i, 1)}
              isFirst={i === 0}
              isLast={i === blocks.length - 1}
            />
          ))}
          {blocks.length === 0 && (
            <div style={{ padding: "24px", borderRadius: 10, border: `1.5px dashed ${C.border}`, textAlign: "center", color: C.textSub, fontSize: 13 }}>
              No content blocks yet. Add one below.
            </div>
          )}
        </div>

        {/* Add block buttons */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 22 }}>
          {ADD_TYPES.map(({ type, label }) => (
            <button key={type} onClick={() => addBlock(type)} style={{
              padding: "6px 12px", borderRadius: 8,
              border: `1.5px solid ${LESSON_TYPE_COLORS[type] ?? C.border}`,
              background: (LESSON_TYPE_COLORS[type] ?? C.orange) + "10",
              color: LESSON_TYPE_COLORS[type] ?? C.text,
              fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}>{label}</button>
          ))}
        </div>

        {/* Settings row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 22 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6 }}>DURATION</label>
            <input value={dur} onChange={e => setDur(e.target.value)} placeholder="20 min" style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6 }}>XP REWARD</label>
            <input type="number" value={xp} onChange={e => setXp(e.target.value)} min={0} max={500} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6 }}>STATUS</label>
            <select value={status} onChange={e => setStatus(e.target.value)} style={inputStyle}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
        </>}

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "11px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} disabled={!title.trim()} style={{
            flex: 2, padding: "11px", borderRadius: 8, border: "none",
            background: title.trim() ? C.orange : C.muted, color: title.trim() ? "#fff" : C.textMuted,
            fontSize: 13, fontWeight: 700, cursor: title.trim() ? "pointer" : "default",
          }}>
            {lesson ? "Save Changes" : "Create Lesson"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ASSIGN CONTENT MODAL ────────────────────────────────────
function AssignContentModal({ contentType, contentId, content, orgUsers, orgs, currentUser, onAssign, onClose, tenantId, isReal }) {
  const isSuperAdmin = isRalliAdmin(currentUser?.role);
  // "team" for org-scoped users (orgAdmin/manager), "group" (org-wide) for superadmin
  const defaultType  = isSuperAdmin ? "group" : "team";
  const [assignType, setAssignType] = useState(defaultType);
  const [selectedOrgId,  setSelectedOrgId]  = useState(currentUser?.orgId ?? orgs[0]?.id ?? "");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [dueDate, setDueDate]   = useState("");
  const [required, setRequired] = useState(false);

  // Loaded from Supabase for real users; fall back to passed props for demo
  const [tenantUsers,  setTenantUsers]  = useState(null); // null = loading
  const [tenantTeams,  setTenantTeams]  = useState(null);

  useEffect(() => {
    if (!isReal || !tenantId) return;
    // Load users
    supabase.from("profiles")
      .select("id, name, email, role, color")
      .eq("tenant_id", tenantId)
      .neq("status", "inactive")
      .then(({ data }) => {
        if (!data) return;
        setTenantUsers(data.map(m => ({
          id:       m.id,
          name:     m.name ?? m.email?.split("@")[0] ?? "User",
          initials: (m.name ?? m.email ?? "U").split(" ").map(p => p[0] ?? "").join("").toUpperCase().slice(0, 2) || "U",
          role:     m.role ?? "user",
          color:    m.color ?? "#F97316",
          orgId:    tenantId,
        })));
      });
    // Load teams
    supabase.from("tenant_teams")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .order("name")
      .then(({ data }) => { setTenantTeams(data ?? []); });
  }, [tenantId, isReal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolved lists: prefer freshly-loaded Supabase data, fall back to passed props
  const availableUsers = tenantUsers !== null
    ? tenantUsers.filter(u => u.id !== currentUser?.id)
    : (isSuperAdmin
        ? orgUsers.filter(u => u.role === "user" || u.role === "orgAdmin")
        : orgUsers.filter(u => u.orgId === currentUser?.orgId && u.id !== currentUser?.id));

  const availableOrgs  = isSuperAdmin
    ? orgs.filter(o => o.status === "active")
    : orgs.filter(o => o.id === currentUser?.orgId);

  const availableTeams = tenantTeams ?? [];

  const handleAssign = () => {
    const base = { contentType, contentId, required, dueAt: dueDate || "Open" };
    if (assignType === "team") {
      if (!selectedTeamId) return;
      const team = availableTeams.find(t => t.id === selectedTeamId);
      onAssign({ ...base, assignedTo: { type: "team", teamId: selectedTeamId, teamName: team?.name ?? "" } });
    } else if (assignType === "group") {
      onAssign({ ...base, assignedTo: { type: "group", orgId: selectedOrgId } });
    } else {
      if (!selectedUserId) return;
      const u = availableUsers.find(x => x.id === selectedUserId);
      onAssign({ ...base, assignedTo: { type: "individual", userId: selectedUserId, userName: u?.name ?? "" } });
    }
  };

  const canSubmit = assignType === "team"
    ? !!selectedTeamId
    : assignType === "group"
      ? !!selectedOrgId
      : !!selectedUserId;

  // Toggle options: superadmin sees Group + Individual, org users see Team + Individual
  const toggleOptions = isSuperAdmin
    ? [["group", "Group", "All users in an org"], ["individual", "Individual", "One specific rep"]]
    : [["team", "Team", "All members of a team"], ["individual", "Individual", "One specific rep"]];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.white, borderRadius: 16, padding: 28, width: "100%", maxWidth: 480, boxShadow: "0 24px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.text }}>Assign {contentType === "course" ? "Course" : contentType === "quiz" ? "Quiz" : "Lesson"}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
        </div>

        {content && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: C.pageBg, borderRadius: 10, marginBottom: 24 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{content.title ?? content.name}</div>
              <div style={{ fontSize: 11, color: C.textSub }}>{contentType === "course" ? `${content.lessonIds?.length ?? 0} lessons` : contentType === "quiz" ? `${content.questions?.length ?? 0} questions` : `${content.duration} · ${content.type}`}</div>
            </div>
          </div>
        )}

        {/* Assign type toggle */}
        <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 8 }}>ASSIGN TO</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
          {toggleOptions.map(([id, label, sub]) => (
            <button key={id} onClick={() => setAssignType(id)} style={{
              padding: "12px 14px", borderRadius: 10, cursor: "pointer", textAlign: "left",
              border: `2px solid ${assignType === id ? C.orange : C.border}`,
              background: assignType === id ? C.orangeLight : C.pageBg,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: assignType === id ? C.orange : C.text }}>{label}</div>
              <div style={{ fontSize: 11, color: C.textSub }}>{sub}</div>
            </button>
          ))}
        </div>

        {assignType === "team" ? (
          <>
            <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 8 }}>SELECT TEAM</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto", marginBottom: 20 }}>
              {tenantTeams === null && <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>Loading teams…</p>}
              {tenantTeams !== null && availableTeams.length === 0 && (
                <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>No teams yet. Create one in the Team tab first.</p>
              )}
              {availableTeams.map(team => (
                <button key={team.id} onClick={() => setSelectedTeamId(team.id)} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10,
                  border: `2px solid ${selectedTeamId === team.id ? C.orange : C.border}`,
                  background: selectedTeamId === team.id ? C.orangeLight : C.pageBg, cursor: "pointer", textAlign: "left",
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: selectedTeamId === team.id ? C.orange : C.text }}>{team.name}</div>
                  </div>
                  {selectedTeamId === team.id && <span style={{ color: C.orange }}>✓</span>}
                </button>
              ))}
            </div>
          </>
        ) : assignType === "group" ? (
          <>
            <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 8 }}>SELECT ORGANIZATION</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
              {availableOrgs.map(org => (
                <button key={org.id} onClick={() => setSelectedOrgId(org.id)} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10,
                  border: `2px solid ${selectedOrgId === org.id ? C.orange : C.border}`,
                  background: selectedOrgId === org.id ? C.orangeLight : C.pageBg, cursor: "pointer", textAlign: "left",
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: selectedOrgId === org.id ? C.orange : C.text }}>{org.name}</div>
                    <div style={{ fontSize: 11, color: C.textSub }}>{orgUsers.filter(u => u.orgId === org.id).length} users · {org.plan}</div>
                  </div>
                  {selectedOrgId === org.id && <span style={{ color: C.orange }}>✓</span>}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 8 }}>SELECT USER</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto", marginBottom: 20 }}>
              {tenantUsers === null && isReal && <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>Loading users…</p>}
              {availableUsers.length === 0 && (tenantUsers !== null || !isReal) && (
                <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>No other users in this tenant yet.</p>
              )}
              {availableUsers.map(u => (
                <button key={u.id} onClick={() => setSelectedUserId(u.id)} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10,
                  border: `2px solid ${selectedUserId === u.id ? C.orange : C.border}`,
                  background: selectedUserId === u.id ? C.orangeLight : C.pageBg, cursor: "pointer", textAlign: "left",
                }}>
                  <Avatar initials={u.initials ?? (u.name?.[0] ?? "U").toUpperCase()} size={32} color={u.color} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: selectedUserId === u.id ? C.orange : C.text }}>{u.name}</div>
                    <div style={{ fontSize: 11, color: C.textSub }}>{u.role}</div>
                  </div>
                  {selectedUserId === u.id && <span style={{ color: C.orange }}>✓</span>}
                </button>
              ))}
            </div>
          </>
        )}

        <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6 }}>DUE DATE (optional)</label>
        <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={{
          width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
          fontSize: 13, color: C.text, background: C.pageBg, marginBottom: 20, boxSizing: "border-box",
        }} />

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "11px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleAssign} disabled={!canSubmit} style={{
            flex: 2, padding: "11px", borderRadius: 8, border: "none",
            background: canSubmit ? C.orange : C.muted, color: canSubmit ? "#fff" : C.textMuted,
            fontSize: 13, fontWeight: 700, cursor: canSubmit ? "pointer" : "default",
          }}>
            Assign {contentType === "course" ? "Course" : contentType === "quiz" ? "Quiz" : "Lesson"} →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── QUIZZES SCREEN stub for old static (removed) ────────────
function _RemovedLearnStatic() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 0, background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden", minHeight: 560 }}>
      {/* Left: lesson list */}
      <div style={{ borderRight: `1px solid ${C.border}` }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 4 }}>SDR CORE TRACK</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>Objection Handling</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: C.textSub }}>4 of 7 complete</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.orange }}>57%</span>
          </div>
          <ProgressBar value={57} color={C.orange} height={5} />
        </div>
        <div>
          {lessons.map(l => (
            <div
              key={l.num}
              onClick={() => setActiveLesson(l.num)}
              style={{
                display: "flex", alignItems: "center", gap: 12, padding: "14px 20px",
                cursor: "pointer", borderBottom: `1px solid ${C.border}`,
                background: l.active || activeLesson === l.num ? C.orangeLight : "transparent",
                borderLeft: `3px solid ${l.active || activeLesson === l.num ? C.orange : "transparent"}`,
              }}
            >
              <div style={{
                width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                background: l.done ? C.green : l.active || activeLesson === l.num ? C.orange : C.pageBg,
                border: `2px solid ${l.done ? C.green : l.active || activeLesson === l.num ? C.orange : C.border}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 700,
                color: l.done || l.active || activeLesson === l.num ? "#fff" : C.textSub,
              }}>
                {l.done ? "✓" : l.num}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, fontWeight: l.active || activeLesson === l.num ? 700 : 500,
                  color: l.active || activeLesson === l.num ? C.orange : C.text,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>
                  {l.title}
                </div>
                <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>⏱ {l.duration}</div>
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.orange, flexShrink: 0 }}>+{l.xp} XP</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: lesson content */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 28px", flex: 1, overflowY: "auto" }}>
          {/* Breadcrumb */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, marginBottom: 16 }}>
            <span>SDR Core Track</span>
            <span style={{ color: C.textMuted }}>›</span>
            <span style={{ color: C.orange, fontWeight: 600 }}>Handling Price Objections</span>
          </div>

          <h2 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: "0 0 10px" }}>
            Handling Price Objections
          </h2>
          <div style={{ display: "flex", gap: 20, fontSize: 12, color: C.textSub, marginBottom: 24 }}>
            <span>⏱ 30 min</span>
            <span>Objection Handling</span>
            <span style={{ color: C.orange, fontWeight: 600 }}>+150 XP on completion</span>
          </div>

          {/* Overview */}
          <div style={{
            padding: 18, borderRadius: 10, background: C.orangeLight,
            border: `1px solid ${C.orangeBorder}`, marginBottom: 20,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <div style={{ width: 3, height: 16, background: C.orange, borderRadius: 2 }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Overview</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                "Price objections are the #1 reason deals stall in mid-market",
                "Prospects use price as a proxy for perceived value — not actual cost",
                "Your goal: reframe value before defending the number",
              ].map((pt, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, color: C.text }}>
                  <span style={{ color: C.orange, flexShrink: 0, marginTop: 1 }}>•</span>
                  {pt}
                </div>
              ))}
            </div>
          </div>

          {/* Framework */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <div style={{ width: 3, height: 16, background: C.blue, borderRadius: 2 }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>The 3-Step Framework</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {frameworkSteps.map((s, i) => (
                <div key={i} style={{
                  padding: "14px 18px", borderRadius: 10,
                  background: C.pageBg, border: `1px solid ${C.border}`,
                  display: "flex", gap: 14, alignItems: "flex-start",
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 800, color: C.orange,
                    background: C.orangeLight, padding: "3px 8px", borderRadius: 6, flexShrink: 0,
                  }}>
                    {s.num}
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: C.textSub, marginTop: 3 }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div style={{
          padding: "14px 28px", borderTop: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: C.white,
        }}>
          <div style={{ fontSize: 13, color: C.textSub }}>
            Lesson 4 of 7 · Earn <span style={{ color: C.orange, fontWeight: 700 }}>+150 XP</span> on completion
          </div>
          <button style={{
            padding: "10px 22px", borderRadius: 8, border: "none",
            background: C.orange, color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            Start Quiz
          </button>
        </div>
      </div>
    </div>
  );
}

// ── QUIZZES SCREEN ──────────────────────────────────────────

// ── USER QUIZ CATALOG ────────────────────────────────────────────────────────
// Production hook: replace with /api/users/:id/quiz-assignments
// Data model: attempts are appended after each quiz completion.
// ─────────────────────────────────────────────────────────────────────────────

// Generate due dates relative to today so mock data is always realistic
const _today = () => new Date();
const _dateStr = (offsetDays) => {
  const d = _today();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const USER_QUIZ_ASSIGNMENTS_SEED = [
  {
    id: "qa1",
    title: "Objection Handling: Price & Value",
    description: "Learn to handle the most common price and value objections in the field.",
    track: "SDR Core Track",
    tags: ["objections", "pricing", "value"],
    difficulty: "Medium",
    xp: 150,
    dueAt: _dateStr(0),   // due today
    assignedAt: _dateStr(-13),
    passingScore: 90,
    questions: [
      { id: "q1", type: "mc", text: "A prospect says 'your price is too high'. What is the best first response?", options: ["Offer a discount immediately", "Ask what they're comparing it to", "Defend the price by listing features", "Agree and ask what budget they have"], correct: 1, explanation: "Understanding the comparison point helps you reframe value before conceding on price." },
      { id: "q2", type: "tf", text: "You should always lead with price when a prospect asks about cost.", options: ["True", "False"], correct: 1, explanation: "Lead with value and outcomes first. Price lands better once the prospect understands what they're getting." },
      { id: "q3", type: "mc", text: "Which reframe is most effective when a prospect says your ROI is unclear?", options: ["Tell them to trust the process", "Ask what a single additional closed deal is worth to them", "Lower the price to reduce risk", "Send a case study and follow up"], correct: 1, explanation: "Anchoring to a specific dollar outcome the prospect controls is far more persuasive than generic ROI claims." },
      { id: "q4", type: "mc", text: "When a prospect says 'we don't have budget right now', you should:", options: ["End the call politely", "Ask when the next budget cycle opens", "Offer a free trial immediately", "Escalate to their manager"], correct: 1, explanation: "Timing objections are often real — exploring the next budget cycle keeps the deal alive without discounting." },
      { id: "q5", type: "tf", text: "Discounting early in negotiations sets a healthy precedent with buyers.", options: ["True", "False"], correct: 1, explanation: "Early discounting trains buyers to always push for a lower price and signals that your initial price was inflated." },
    ],
    attempts: [],
  },
  {
    id: "qa2",
    title: "MEDDIC Qualification Framework",
    description: "Master the MEDDIC framework for qualifying enterprise deals.",
    track: "Enterprise Sales",
    tags: ["meddic", "qualification", "enterprise"],
    difficulty: "Hard",
    xp: 200,
    dueAt: _dateStr(3),   // due in 3 days
    assignedAt: _dateStr(-7),
    passingScore: 90,
    questions: [
      { id: "q1", type: "mc", text: "What does the 'M' in MEDDIC stand for?", options: ["Manager", "Metrics", "Mandate", "Method"], correct: 1, explanation: "Metrics — the quantified business impact the buyer expects from the purchase." },
      { id: "q2", type: "mc", text: "An 'Economic Buyer' in MEDDIC is best described as:", options: ["The person who uses the product daily", "The person who controls the budget and can say yes", "A champion who advocates internally", "The technical evaluator"], correct: 1, explanation: "The Economic Buyer has final budget authority and can approve the deal without additional sign-off." },
      { id: "q3", type: "tf", text: "A Champion in MEDDIC is someone who likes your product but has no internal influence.", options: ["True", "False"], correct: 1, explanation: "A true Champion both likes your product AND has the internal credibility and influence to advocate for it." },
      { id: "q4", type: "mc", text: "Which MEDDIC element involves mapping the steps needed to close the deal?", options: ["Metrics", "Economic Buyer", "Decision Process", "Identify Pain"], correct: 2, explanation: "Decision Process — understanding the exact steps, stakeholders, and timeline the buyer will follow to make a decision." },
      { id: "q5", type: "mc", text: "If you can't identify the Identify Pain element, you should:", options: ["Move forward and hope value becomes clear", "Dig deeper with discovery questions", "Introduce pricing early to create urgency", "Skip to the demo"], correct: 1, explanation: "Without a clear articulated pain, the prospect has no compelling reason to change. Discovery must continue." },
    ],
    attempts: [],
  },
  {
    id: "qa3",
    title: "Prospecting Fundamentals",
    description: "Core prospecting techniques for top-of-funnel pipeline generation.",
    track: "SDR Core Track",
    tags: ["prospecting", "outreach", "pipeline"],
    difficulty: "Easy",
    xp: 100,
    dueAt: _dateStr(-5),  // overdue
    assignedAt: _dateStr(-19),
    passingScore: 90,
    questions: [
      { id: "q1", type: "mc", text: "What is the primary goal of a cold call opening?", options: ["Close the deal", "Qualify the budget", "Earn 30 seconds to explain why you called", "Book a demo immediately"], correct: 2, explanation: "The opening of a cold call has one job: earn permission to continue the conversation for 30 more seconds." },
      { id: "q2", type: "tf", text: "Personalization in outreach emails consistently improves reply rates.", options: ["True", "False"], correct: 0, explanation: "Research consistently shows that relevant, personalized outreach outperforms generic sequences." },
      { id: "q3", type: "mc", text: "Which prospecting channel typically yields the highest response rates for warm leads?", options: ["Cold email", "LinkedIn DM", "Phone call", "All channels equally"], correct: 2, explanation: "Phone calls — when the prospect is warm and expecting contact — still yield the highest immediate engagement." },
      { id: "q4", type: "mc", text: "The 'triple touch' in prospecting refers to:", options: ["Calling three times before giving up", "Reaching a prospect via phone, email, and social before moving on", "Following up three times after a demo", "Sending three different value props in one email"], correct: 1, explanation: "Multi-channel outreach (phone + email + social) significantly increases the probability of reaching a prospect." },
    ],
    attempts: [
      { id: "at1", date: _dateStr(-10), score: 75, passed: false, answers: [
        { questionId: "q1", selected: 2, correct: 2 },
        { questionId: "q2", selected: 0, correct: 0 },
        { questionId: "q3", selected: 0, correct: 2 },
        { questionId: "q4", selected: 1, correct: 1 },
      ]},
    ],
  },
  {
    id: "qa4",
    title: "Competitor Positioning: Salesforce vs. ralli",
    description: "How to position against Salesforce in competitive deals.",
    track: "Battle Cards",
    tags: ["competitor", "salesforce", "positioning"],
    difficulty: "Medium",
    xp: 150,
    dueAt: _dateStr(9),   // due next week
    assignedAt: _dateStr(-5),
    passingScore: 90,
    questions: [
      { id: "q1", type: "mc", text: "When a prospect says they're evaluating Salesforce, your first move should be:", options: ["Immediately list Salesforce's weaknesses", "Ask what specific capabilities they need from a CRM", "Offer a lower price", "Ask who their current vendor is"], correct: 1, explanation: "Understanding requirements first lets you position precisely rather than making generic competitive claims." },
      { id: "q2", type: "tf", text: "Salesforce is generally considered the best fit for small-to-medium sales teams.", options: ["True", "False"], correct: 1, explanation: "Salesforce is built for enterprise complexity. SMB teams consistently struggle with adoption, admin overhead, and cost." },
      { id: "q3", type: "mc", text: "Which is the most common Salesforce objection you'll face in a competitive deal?", options: ["Their mobile app is better", "They have a larger marketplace", "Brand trust — 'everyone uses Salesforce'", "Their reporting is more advanced"], correct: 2, explanation: "'Everyone uses Salesforce' is the most common objection. Acknowledge it and pivot to the total cost of ownership and adoption rate." },
    ],
    attempts: [
      { id: "at1", date: _dateStr(-4), score: 93, passed: true, answers: [
        { questionId: "q1", selected: 1, correct: 1 },
        { questionId: "q2", selected: 1, correct: 1 },
        { questionId: "q3", selected: 2, correct: 2 },
      ]},
    ],
  },
  {
    id: "qa5",
    title: "Discovery Call Framework",
    description: "Structure discovery calls to uncover pain, impact, and decision criteria.",
    track: "SDR Core Track",
    tags: ["discovery", "calls", "qualification"],
    difficulty: "Easy",
    xp: 80,
    dueAt: _dateStr(14),  // due in 2 weeks
    assignedAt: _dateStr(-3),
    passingScore: 90,
    questions: [
      { id: "q1", type: "mc", text: "The primary goal of a discovery call is:", options: ["Pitch the product in detail", "Understand the prospect's situation, pain, and goals", "Get to a demo as quickly as possible", "Qualify budget before anything else"], correct: 1, explanation: "Discovery is about understanding, not selling. The more you learn, the more relevant your pitch becomes." },
      { id: "q2", type: "tf", text: "You should send a full proposal during or immediately after a discovery call.", options: ["True", "False"], correct: 1, explanation: "A proposal before you understand the full decision process, stakeholders, and budget is premature and often ignored." },
      { id: "q3", type: "mc", text: "Which question best uncovers the impact of a prospect's pain?", options: ["How long have you had this problem?", "What happens if you don't solve this in the next 6 months?", "Have you looked at any solutions?", "Who makes the final decision?"], correct: 1, explanation: "Future-impact questions force the prospect to articulate urgency and cost of inaction in their own words." },
    ],
    attempts: [
      { id: "at1", date: _dateStr(-2), score: 100, passed: true, answers: [
        { questionId: "q1", selected: 1, correct: 1 },
        { questionId: "q2", selected: 1, correct: 1 },
        { questionId: "q3", selected: 1, correct: 1 },
      ]},
    ],
  },
];

const diffColors = { Easy: C.green, Medium: C.orange, Hard: C.red };

// ── Due-date helpers ──────────────────────────────────────────────────────────
function getDueStatus(dueAtStr) {
  if (!dueAtStr) return null;
  const now   = new Date(); now.setHours(0,0,0,0);
  const due   = new Date(dueAtStr); due.setHours(0,0,0,0);
  const diff  = Math.round((due - now) / 86400000); // days
  const thisMonday  = new Date(now); thisMonday.setDate(now.getDate()  - now.getDay() + 1);
  const nextSunday  = new Date(thisMonday); nextSunday.setDate(thisMonday.getDate() + 13);
  const nextSaturday = new Date(thisMonday); nextSaturday.setDate(thisMonday.getDate() + 12);

  if (diff < 0)  return { label: "Overdue",        color: C.red,    urgent: true  };
  if (diff === 0)return { label: "Due today",       color: C.red,    urgent: true  };
  if (diff <= 6) return { label: `Due in ${diff} day${diff!==1?"s":""}`, color: C.orange, urgent: diff<=2 };
  if (diff <= 7) return { label: "Due this week",   color: C.orange, urgent: false };
  if (diff <= 14)return { label: "Due next week",   color: C.textSub,urgent: false };
  return           { label: `Due in ${diff} days`,  color: C.textSub,urgent: false };
}

function getDueProgress(assignedAtStr, dueAtStr) {
  if (!assignedAtStr || !dueAtStr) return 0;
  const assigned = new Date(assignedAtStr); assigned.setHours(0,0,0,0);
  const due      = new Date(dueAtStr);      due.setHours(0,0,0,0);
  const now      = new Date();              now.setHours(0,0,0,0);
  const total    = due - assigned;
  const elapsed  = now - assigned;
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}

// ── QuizTakingView ────────────────────────────────────────────────────────────
function QuizTakingView({ quiz, onComplete, onExit }) {
  const [qIdx,        setQIdx]        = useState(0);
  const [answers,     setAnswers]     = useState({});
  const [revealed,    setRevealed]    = useState(false);
  const [sliderDraft, setSliderDraft] = useState(null);
  const [textDraft,   setTextDraft]   = useState(""); // type-answer draft

  const q        = quiz.questions[qIdx];
  const total    = quiz.questions.length;
  const selected = answers[q.id] ?? null;
  const isLast   = qIdx === total - 1;
  const isSlider = q.type === "slider";
  const isType   = q.type === "type";

  // Reset draft state when question changes
  useEffect(() => {
    setSliderDraft(null);
    setTextDraft("");
  }, [qIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Slider helpers
  const sliderMin = q.min ?? 0;
  const sliderMax = q.max ?? 10;
  const sliderVal = sliderDraft !== null ? sliderDraft
    : (selected !== null ? selected : Math.round((sliderMin + sliderMax) / 2));

  // Correctness per type
  const sliderCorrect = isSlider && revealed && selected !== null
    && Math.abs(selected - (q.correct ?? 5)) <= (q.tolerance ?? 1);
  const typeCorrect = isType && revealed && typeof selected === "string"
    && (q.acceptedAnswers ?? []).some(a =>
        a.trim().toLowerCase() === selected.trim().toLowerCase());
  const isCorrect = isSlider ? sliderCorrect
    : isType   ? typeCorrect
    : (revealed && selected === q.correct);
  const isWrong = revealed && !isCorrect && selected !== null;

  const choose = (idx) => {
    if (revealed) return;
    setAnswers(prev => ({ ...prev, [q.id]: idx }));
    setRevealed(true);
  };

  const commitSlider = () => {
    if (revealed) return;
    setAnswers(prev => ({ ...prev, [q.id]: sliderVal }));
    setRevealed(true);
  };

  const commitType = () => {
    if (revealed || !textDraft.trim()) return;
    setAnswers(prev => ({ ...prev, [q.id]: textDraft }));
    setRevealed(true);
  };

  const next = () => {
    if (isLast) {
      const answerList = quiz.questions.map(ques => ({
        questionId: ques.id,
        selected:   answers[ques.id] ?? null,
        correct:    ques.correct,
      }));
      const correctCount = answerList.filter((a, i) => {
        const ques = quiz.questions[i];
        if (ques.type === "slider") return a.selected !== null
          && Math.abs(a.selected - (ques.correct ?? 5)) <= (ques.tolerance ?? 1);
        if (ques.type === "type") return typeof a.selected === "string"
          && (ques.acceptedAnswers ?? []).some(aa =>
              aa.trim().toLowerCase() === a.selected.trim().toLowerCase());
        return a.selected === a.correct;
      }).length;
      const score   = Math.round((correctCount / total) * 100);
      const attempt = { id: `at${Date.now()}`, date: new Date().toISOString().slice(0,10), score, passed: score >= (quiz.passingScore ?? 90), answers: answerList };
      onComplete(attempt);
    } else {
      setQIdx(i => i + 1);
      setRevealed(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onExit} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, color: C.textSub, padding: 0 }}>← Exit</button>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted }}>{qIdx + 1} / {total}</span>
      </div>

      {/* Progress bar */}
      <div style={{ height: 6, borderRadius: 99, background: C.muted, overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 99, background: C.orange, width: `${((qIdx + (revealed ? 1 : 0)) / total) * 100}%`, transition: "width 0.3s" }} />
      </div>

      {/* Question */}
      <Card>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Question {qIdx + 1}</div>
        <p style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700, color: C.text, lineHeight: 1.5 }}>{q.text || q.q}</p>

        {isType ? (
          /* ── Type Answer ── */
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              type="text"
              placeholder="Type your answer…"
              value={revealed ? (typeof selected === "string" ? selected : "") : textDraft}
              disabled={revealed}
              onChange={e => !revealed && setTextDraft(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !revealed && commitType()}
              autoFocus
              style={{
                width: "100%", boxSizing: "border-box", padding: "14px 16px", borderRadius: 12,
                border: `2px solid ${revealed ? (isCorrect ? C.trueGreen : "#EF4444") : C.creamBorder}`,
                background: revealed ? (isCorrect ? "#DCFCE7" : "#FEE2E2") : C.pageBg,
                color: C.text, fontSize: 15, fontWeight: 600, outline: "none", fontFamily: "inherit",
              }}
            />
            {revealed && (
              <div style={{ padding: "10px 14px", borderRadius: 10, background: isCorrect ? "#F0FDF4" : "#FFF7ED", border: `1px solid ${isCorrect ? "#86EFAC" : C.creamBorder}`, fontSize: 13 }}>
                {isCorrect
                  ? <strong style={{ color: "#166534" }}>Correct!</strong>
                  : <><strong style={{ color: C.orange }}>Accepted: </strong><span style={{ color: C.textSub }}>{(q.acceptedAnswers ?? []).join(", ")}</span></>
                }
                {q.explanation && <p style={{ margin: "6px 0 0", fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>{q.explanation}</p>}
              </div>
            )}
            {!revealed && (
              <button onClick={commitType} disabled={!textDraft.trim()} style={{
                padding: "12px 28px", borderRadius: 12, border: "none", alignSelf: "flex-end",
                background: textDraft.trim() ? C.orange : C.muted,
                color: textDraft.trim() ? "#fff" : C.textMuted,
                fontSize: 14, fontWeight: 700, cursor: textDraft.trim() ? "pointer" : "default",
              }}>
                Check Answer
              </button>
            )}
          </div>
        ) : isSlider ? (
          /* ── Slider ── */
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ textAlign: "center" }}>
              <span style={{ fontSize: 36, fontWeight: 900, lineHeight: 1, color: revealed ? (isCorrect ? "#166534" : C.red) : C.orange }}>{sliderVal}</span>
              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{sliderMin} – {sliderMax}</div>
            </div>
            <input type="range" min={sliderMin} max={sliderMax} step={q.step ?? 1} value={sliderVal} disabled={revealed}
              onChange={e => !revealed && setSliderDraft(Number(e.target.value))}
              style={{ width: "100%", accentColor: C.orange, cursor: revealed ? "default" : "pointer" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.textMuted }}>
              <span>{q.minLabel ? `${q.minLabel} (${sliderMin})` : sliderMin}</span>
              <span>{q.maxLabel ? `${q.maxLabel} (${sliderMax})` : sliderMax}</span>
            </div>
            {revealed && (
              <div style={{ padding: "10px 14px", borderRadius: 10, background: isCorrect ? "#F0FDF4" : "#FFF7ED", border: `1px solid ${isCorrect ? "#86EFAC" : C.creamBorder}`, fontSize: 13, color: C.text }}>
                <strong style={{ color: isCorrect ? "#166534" : C.orange }}>
                  {isCorrect ? `Correct! Target: ${q.correct ?? 5} ±${q.tolerance ?? 1}` : `Target was ${q.correct ?? 5} ±${q.tolerance ?? 1}.`}
                </strong>
                {!isCorrect && <span style={{ color: C.textSub }}> You answered {selected}.</span>}
              </div>
            )}
            {revealed && q.explanation && (
              <div style={{ padding: "12px 16px", borderRadius: 10, background: C.pageBg, border: `1px solid ${C.creamBorder}` }}>
                <p style={{ margin: 0, fontSize: 13, color: C.text, lineHeight: 1.6 }}>{q.explanation}</p>
              </div>
            )}
            {!revealed && (
              <button onClick={commitSlider} style={{ padding: "12px 28px", borderRadius: 12, border: "none", background: C.orange, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", alignSelf: "flex-end" }}>
                Check Answer
              </button>
            )}
          </div>
        ) : (
          /* ── MC / TF ── */
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(q.options ?? []).map((opt, i) => {
              const optLabel = typeof opt === "string" ? opt.trim()
                : opt !== null && typeof opt === "object"
                  ? String(opt.text || opt.label || opt.answer || opt.option || opt.value || "").trim()
                : String(opt ?? "").trim();
              const isBlank     = !optLabel.trim();
              const isSelected  = selected === i;
              const isRight     = revealed && i === q.correct;
              const isThisWrong = revealed && isSelected && i !== q.correct;
              if (isBlank) console.warn("[ralli] Invalid quiz option", { quizId: quiz.id, questionId: q.id, optionIndex: i, originalOption: opt });
              let bg = C.cardBg, border = C.creamBorder, color = C.text;
              if (isRight)                 { bg = "#DCFCE7"; border = C.trueGreen; color = "#166534"; }
              if (isThisWrong)             { bg = "#FEE2E2"; border = "#EF4444";   color = "#991B1B"; }
              if (!revealed && isSelected) { bg = C.orangeLight; border = C.orange; }
              if (isBlank)                 { bg = C.pageBg;  border = C.muted; }
              return (
                <button key={i} onClick={() => !isBlank && choose(i)} disabled={isBlank} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderRadius: 12,
                  border: `2px solid ${border}`, background: bg,
                  cursor: revealed || isBlank ? "default" : "pointer", textAlign: "left", width: "100%",
                  transition: "all 0.15s", opacity: isBlank ? 0.45 : 1,
                }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, background: isRight ? C.trueGreen : isThisWrong ? "#EF4444" : (!revealed && isSelected) ? C.orange : C.muted, color: (isRight || isThisWrong || (!revealed && isSelected)) ? "#fff" : C.textMuted }}>
                    {isRight ? "✓" : isThisWrong ? "✗" : String.fromCharCode(65 + i)}
                  </div>
                  {isBlank
                    ? <span style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, fontStyle: "italic" }}>Answer option missing</span>
                    : <span style={{ fontSize: 14, fontWeight: 600, color }}>{optLabel}</span>
                  }
                </button>
              );
            })}
          </div>
        )}

        {/* Explanation — MC/TF only (slider and type show feedback inline) */}
        {revealed && !isSlider && !isType && q.explanation && (
          <div style={{ marginTop: 16, padding: "12px 16px", borderRadius: 10, background: isCorrect ? "#F0FDF4" : "#FFF7ED", border: `1px solid ${isCorrect ? "#86EFAC" : C.creamBorder}` }}>
            <p style={{ margin: 0, fontSize: 13, color: C.text, lineHeight: 1.6 }}><strong style={{ color: isCorrect ? "#166534" : C.orange }}>{isCorrect ? "Correct" : "Not quite"}.</strong> {q.explanation}</p>
          </div>
        )}
      </Card>

      {/* Next / Finish — shown after reveal */}
      {revealed && (
        <button onClick={next} style={{ alignSelf: "flex-end", padding: "12px 28px", borderRadius: 12, border: "none", background: C.orange, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
          {isLast ? "See Results →" : "Next Question →"}
        </button>
      )}
    </div>
  );
}

// ── QuizResultsView ───────────────────────────────────────────────────────────
function QuizResultsView({ quiz, attempt, onRetake, onBack }) {
  const total   = quiz.questions.length;
  // Slider: tolerance. Type: case-insensitive string match. MC/TF: index equality.
  const correct = attempt.answers.filter((a, i) => {
    const q = quiz.questions[i];
    if (q?.type === "slider") return a.selected !== null
      && Math.abs(a.selected - (q.correct ?? 5)) <= (q.tolerance ?? 1);
    if (q?.type === "type") return typeof a.selected === "string"
      && (q.acceptedAnswers ?? []).some(aa =>
          aa.trim().toLowerCase() === a.selected.trim().toLowerCase());
    return a.selected === a.correct;
  }).length;
  const passed  = attempt.passed;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Back */}
      <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, color: C.textSub, padding: 0, alignSelf: "flex-start" }}>← Back to Quizzes</button>

      {/* Score card */}
      <Card style={{ textAlign: "center", padding: "32px 24px" }}>
        <div style={{ fontSize: 52, fontWeight: 900, color: passed ? C.trueGreen : C.red, lineHeight: 1 }}>{attempt.score}%</div>
        <div style={{ marginTop: 8, marginBottom: 4, fontSize: 16, fontWeight: 800, color: C.text }}>{quiz.title}</div>
        <div style={{ fontSize: 13, color: C.textSub, marginBottom: 16 }}>{correct} of {total} correct · {attempt.date}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 16px", borderRadius: 99, background: passed ? "#DCFCE7" : "#FEE2E2", border: `1px solid ${passed ? "#86EFAC" : "#FCA5A5"}` }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: passed ? "#166534" : "#991B1B" }}>{passed ? "Passed" : "Retry"}</span>
        </div>
        {!passed && <p style={{ margin: "12px 0 0", fontSize: 12, color: C.textMuted }}>Score 90% or higher to pass. You've got this.</p>}
        <button onClick={onRetake} style={{ marginTop: 20, padding: "10px 24px", borderRadius: 10, border: `1px solid ${C.orange}`, background: C.orangeLight, color: C.orange, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          Retake Quiz
        </button>
      </Card>

      {/* Per-question breakdown */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Question Review</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {quiz.questions.map((q, i) => {
            const ans       = attempt.answers.find(a => a.questionId === q.id);
            const isSliderQ = q.type === "slider";
            const isTypeQ   = q.type === "type";

            const wasRight = isSliderQ
              ? (ans?.selected !== null && ans?.selected !== undefined
                  && Math.abs(ans.selected - (q.correct ?? 5)) <= (q.tolerance ?? 1))
              : isTypeQ
              ? (typeof ans?.selected === "string"
                  && (q.acceptedAnswers ?? []).some(aa =>
                      aa.trim().toLowerCase() === ans.selected.trim().toLowerCase()))
              : ans?.selected === q.correct;

            const answerLabel = isSliderQ
              ? (ans?.selected != null ? String(ans.selected) : null)
              : isTypeQ
              ? (typeof ans?.selected === "string" ? ans.selected : null)
              : ((q.options ?? [])[ans?.selected] || null);

            const correctLabel = isSliderQ
              ? `${q.correct ?? 5} ±${q.tolerance ?? 1}`
              : isTypeQ
              ? ((q.acceptedAnswers ?? []).join(", ") || null)
              : ((q.options ?? [])[q.correct] || null);

            return (
              <Card key={q.id} style={{ borderLeft: `4px solid ${wasRight ? C.trueGreen : C.red}` }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.text, lineHeight: 1.5 }}>{i+1}. {q.text || q.q}</p>
                  <span style={{ fontSize: 12, fontWeight: 700, color: wasRight ? "#166534" : "#991B1B", flexShrink: 0, padding: "2px 8px", borderRadius: 99, background: wasRight ? "#DCFCE7" : "#FEE2E2" }}>{wasRight ? "Correct" : "Incorrect"}</span>
                </div>

                {/* User answer */}
                {ans?.selected !== null && ans?.selected !== undefined && (
                  <div style={{ fontSize: 13, color: wasRight ? "#166534" : "#991B1B", marginBottom: wasRight ? 0 : 4 }}>
                    <strong>Your answer:</strong> {answerLabel || <em style={{ color: C.textMuted }}>—</em>}
                  </div>
                )}

                {/* Correct answer (only if wrong and a target exists) */}
                {!wasRight && correctLabel && (
                  <div style={{ fontSize: 13, color: "#166534", marginBottom: q.explanation ? 8 : 0 }}>
                    <strong>Correct answer:</strong> {correctLabel}
                  </div>
                )}

                {/* Explanation */}
                {q.explanation && (
                  <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 8, background: C.pageBg, border: `1px solid ${C.creamBorder}` }}>
                    <p style={{ margin: 0, fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>{q.explanation}</p>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── QuizLibraryGrid ──────────────────────────────────────────────────────────
// Admin/Manager quiz list. Displays each quiz with edit, delete, favorite, and
// active-toggle actions. Production hook: replace callbacks with API mutations.
function QuizLibraryGrid({ quizzes, onEditQuiz, onNav, onDeleteQuiz, onToggleFavorite, onToggleActive, onAssign, onLaunchQuiz, canEdit = true, canDelete = true, canAssign = true, canLaunch = false }) {
  const [confirmDelete, setConfirmDelete] = useState(null); // quiz id pending delete confirm

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {quizzes.map(quiz => {
        const qCount   = quiz.questions?.length ?? 0;
        const inactive = quiz.status === "inactive";
        const fav      = !!quiz.favorite;
        return (
          <div key={quiz.id} style={{
            display: "flex", alignItems: "center", gap: 16,
            padding: "16px 20px", borderRadius: 14,
            border: `1.5px solid ${C.border}`, background: C.white,
            opacity: inactive ? 0.6 : 1, transition: "opacity 0.15s",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{quiz.name}</span>
                {fav && <span style={{ fontSize: 11, color: C.orange }}>★</span>}
                {inactive && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: C.muted, color: C.textMuted }}>Inactive</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>
                {qCount} question{qCount !== 1 ? "s" : ""} · Created {quiz.createdAt}
                {quiz.track ? ` · ${quiz.track}` : ""}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {/* Favorite */}
              <button
                onClick={() => onToggleFavorite(quiz.id)}
                title={fav ? "Unfavorite" : "Favorite"}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: fav ? C.orange : C.textMuted, padding: "4px 6px", borderRadius: 6 }}
              >{fav ? "★" : "☆"}</button>

              {/* Active toggle */}
              <button
                onClick={() => onToggleActive(quiz.id)}
                title={inactive ? "Set active" : "Set inactive"}
                style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: inactive ? C.muted : C.greenBg, color: inactive ? C.textMuted : C.trueGreen, cursor: "pointer" }}
              >{inactive ? "Inactive" : "Active"}</button>

              {/* Launch */}
              {canLaunch && onLaunchQuiz && (
                <button
                  onClick={() => onLaunchQuiz(quiz)}
                  title="Launch as live game"
                  style={{ fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 8, border: "none", background: C.green, color: "#fff", cursor: "pointer" }}
                >▶ Launch</button>
              )}

              {/* Assign */}
              {canAssign && onAssign && (
                <button
                  onClick={() => onAssign(quiz)}
                  style={{ fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 8, border: `1px solid ${C.orange}`, background: C.orangeLight, color: C.orange, cursor: "pointer" }}
                >Assign</button>
              )}

              {/* Edit */}
              {canEdit && (
                <button
                  onClick={() => { onEditQuiz(quiz); onNav("rankd-quiz-builder"); }}
                  style={{ fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, cursor: "pointer" }}
                >Edit</button>
              )}

              {/* Delete */}
              {canDelete && (confirmDelete === quiz.id ? (
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() => { onDeleteQuiz(quiz.id); setConfirmDelete(null); }}
                    style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, border: "none", background: C.red, color: "#fff", cursor: "pointer" }}
                  >Confirm</button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.white, color: C.textSub, cursor: "pointer" }}
                  >Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(quiz.id)}
                  style={{ fontSize: 12, fontWeight: 700, padding: "6px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.red, cursor: "pointer" }}
                >✕</button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── QuizzesScreen (user branch rewritten, admin branch preserved) ─────────────
function QuizzesScreen({ role, onNav, quizzes, onEditQuiz, onDeleteQuiz, onToggleFavorite, onToggleActive, pendingQuizId, onClearPendingQuiz, canCreate = true, canEdit = true, canDelete = true, canLaunch = true, canAssign = true, onAssignQuiz, onLaunchQuiz, orgUsers = [], orgs = [], currentUser = null, tenantId = null, isReal = false, quizzesReady = false }) {

  // ── USER VIEW ─────────────────────────────────────────────────────────────
  if (role === "user") {
    // Assignment state — seed for demo; replaced with real data when isReal
    const [assignments, setAssignments] = useState(isReal ? [] : USER_QUIZ_ASSIGNMENTS_SEED);
    const [assignmentsLoaded, setAssignmentsLoaded] = useState(!isReal);
    // Attempt history keyed by quiz_id — source of truth for retake detection
    const [userQuizAttempts, setUserQuizAttempts] = useState({});

    // Load quiz assignments from Supabase for real users.
    // Gated on quizzesReady so the merge always has access to the full quizzes array —
    // prevents the race where assignments resolve before getTenantQuizzes finishes.
    useEffect(() => {
      if (!isReal || !tenantId || !currentUser) return;
      if (!quizzesReady) return; // wait for App-level quiz load to complete first
      getTenantAssignments(tenantId).then(({ data }) => {
        if (!data) { setAssignmentsLoaded(true); return; }
        const userTeamId = currentUser.teamId ?? null;
        const myQuizAssignments = data.filter(a =>
          a.contentType === "quiz" && (
            (a.assignedTo.type === "group"      && a.assignedTo.orgId === currentUser.orgId)  ||
            (a.assignedTo.type === "individual" && a.assignedTo.userId === currentUser.id)    ||
            (a.assignedTo.type === "team"       && userTeamId && userTeamId === a.assignedTo.teamId)
          )
        );
        // Merge with quiz data from the quizzes prop (which has questions)
        const merged = myQuizAssignments.map(a => {
          const quiz = quizzes.find(q => q.id === a.contentId);
          if (!quiz) return null;
          return {
            ...quiz,
            id:         quiz.id,
            title:      quiz.name,
            dueAt:      a.dueAt === "Open" ? null : a.dueAt,
            assignedAt: a.assignedAt,
            required:   a.required,
            attempts:   [],
          };
        }).filter(Boolean);
        setAssignments(merged);
        setAssignmentsLoaded(true);
      });
    }, [tenantId, isReal, currentUser?.id, quizzesReady]); // eslint-disable-line react-hooks/exhaustive-deps

    // Load quiz attempt history from Supabase (for retake detection / attemptNum)
    useEffect(() => {
      if (!isReal || !tenantId || !currentUser?.id) return;
      getUserQuizAttempts(tenantId, currentUser.id).then(({ data }) => {
        if (!data) return;
        const byQuiz = {};
        data.forEach(a => {
          if (!byQuiz[a.quiz_id]) byQuiz[a.quiz_id] = [];
          byQuiz[a.quiz_id].push(a);
        });
        setUserQuizAttempts(byQuiz);
      });
    }, [tenantId, isReal, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    // view: "list" | "taking" | "results"
    const [view,         setView]         = useState("list");
    const [activeId,     setActiveId]     = useState(null);
    const [activeAttempt,setActiveAttempt]= useState(null);
    const [tab,          setTab]          = useState("todo");
    const [search,       setSearch]       = useState("");

    const activeQuiz = assignments.find(q => q.id === activeId);

    const startQuiz  = (id) => { setActiveId(id); setView("taking"); };
    const retakeQuiz = (id) => { setActiveId(id); setActiveAttempt(null); setView("taking"); };
    const viewResults= (id, attempt) => { setActiveId(id); setActiveAttempt(attempt); setView("results"); };

    const toast = useToast();

    // Deep-link: open a specific quiz navigated here from HomeScreen.
    // For real users, assignments arrive async — hold until assignmentsLoaded is true
    // before resolving so the lookup runs against a populated list.
    // Demo users have assignmentsLoaded = true from mount (initialized to !isReal).
    // pendingQuizId is cleared only after a definitive outcome:
    //   found  → open the quiz, then clear
    //   loaded + not found → surface an error, then clear
    // Re-runs when pendingQuizId changes (new deep-link) or assignmentsLoaded flips (data ready).
    useEffect(() => {
      if (!pendingQuizId) return;
      if (!assignmentsLoaded) return; // real users: wait for Supabase assignments to resolve

      const found = assignments.find(q => q.id === pendingQuizId)
                 ?? (!isReal ? USER_QUIZ_ASSIGNMENTS_SEED.find(q => q.id === pendingQuizId) : null);

      if (found) {
        startQuiz(pendingQuizId);
      } else {
        toast.error("That quiz isn't assigned to your account or is no longer available.");
      }
      onClearPendingQuiz?.(); // clear only after definitive outcome
    }, [pendingQuizId, assignmentsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

    const onComplete = (attempt) => {
      setAssignments(prev => prev.map(q => q.id === activeId
        ? { ...q, attempts: [...q.attempts, attempt] }
        : q
      ));
      setActiveAttempt(attempt);
      setView("results");
      // Award quiz XP + persist attempt for real users
      if (isReal && currentUser?.id && tenantId) {
        // previousAttempts from DB — not assignments[].attempts (which is always [])
        const previousAttempts = userQuizAttempts[activeId] ?? [];
        const isRetake = previousAttempts.length > 0;
        awardQuizPoints(tenantId, currentUser.id, activeId, attempt, { isRetake })
          .catch(e => console.error("[ralli] awardQuizPoints failed:", e));
        saveQuizAttempt(tenantId, currentUser.id, activeId, {
          score:      attempt.score,
          passed:     attempt.passed,
          attemptNum: previousAttempts.length + 1,
          answers:    attempt.answers ?? [],
        }).catch(e => console.error("[ralli] saveQuizAttempt failed:", e));
        // Optimistically update local attempt map so immediate re-open shows correct retake state.
        // Prepend (DESC order to match DB) and include answers so QuizResultsView works from the list.
        setUserQuizAttempts(prev => ({
          ...prev,
          [activeId]: [
            { quiz_id: activeId, score: attempt.score, passed: attempt.passed, answers: attempt.answers ?? [] },
            ...(prev[activeId] ?? []),
          ],
        }));
        triggerReadinessUpdate(tenantId, currentUser.id);
      }
    };

    // ── Quiz taking ──
    if (view === "taking" && activeQuiz) {
      return <QuizTakingView quiz={activeQuiz} onComplete={onComplete} onExit={() => setView("list")} />;
    }

    // ── Results ──
    if (view === "results" && activeQuiz && activeAttempt) {
      return <QuizResultsView quiz={activeQuiz} attempt={activeAttempt} onRetake={() => retakeQuiz(activeId)} onBack={() => setView("list")} />;
    }

    // ── Loading state for real users ──
    if (!assignmentsLoaded) {
      return <LoadingState rows={3} message="Loading quizzes…" />;
    }

    // ── Empty state for real users with no assignments ──
    if (isReal && assignments.length === 0) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Quizzes</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Test your knowledge and earn XP</p>
          </div>
          <div style={{ padding: 48, textAlign: "center", background: C.white, borderRadius: 16, border: `1px solid ${C.border}` }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "0 0 4px" }}>No quizzes assigned yet</p>
            <p style={{ fontSize: 13, color: C.textSub, margin: 0 }}>Your manager will assign quizzes here when they're ready.</p>
          </div>
        </div>
      );
    }

    // ── Search filter ──
    const q = search.trim().toLowerCase();
    const searchFiltered = q
      ? assignments.filter(quiz =>
          (quiz.title ?? quiz.name ?? "").toLowerCase().includes(q) ||
          (quiz.description ?? "").toLowerCase().includes(q) ||
          (quiz.track ?? "").toLowerCase().includes(q) ||
          quiz.tags?.some(t => t.includes(q))        ||
          quiz.questions?.some(qs => qs.text?.toLowerCase().includes(q))
        )
      : assignments;

    // ── Tab filter ──
    // For real users, attempt history comes from userQuizAttempts (DB-backed).
    // quiz.attempts is always [] for real users — only used as demo fallback.
    const tabFiltered = searchFiltered.filter(quiz => {
      const attempts = userQuizAttempts[quiz.id] ?? quiz.attempts;
      const isDone   = attempts.some(a => a.passed);
      if (tab === "todo")      return !isDone;
      if (tab === "completed") return isDone;
      return true;
    });

    const todoCount      = searchFiltered.filter(q => !(userQuizAttempts[q.id] ?? q.attempts).some(a => a.passed)).length;
    const completedCount = searchFiltered.filter(q =>  (userQuizAttempts[q.id] ?? q.attempts).some(a => a.passed)).length;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Quizzes</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Test your knowledge and earn XP</p>
          </div>
          {/* Search */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 10, background: C.cardBg, border: `1px solid ${C.creamBorder}`, minWidth: 240 }}>
            <span style={{ fontSize: 13, color: C.textMuted, flexShrink: 0 }}>Search</span>
            <input
              type="text" value={search} placeholder="Title, topic, tag…"
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, border: "none", background: "transparent", fontSize: 13, color: C.text, outline: "none", fontFamily: "inherit" }}
            />
            {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: C.textMuted, padding: 0, lineHeight: 1 }}>✕</button>}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 6 }}>
          {[
            ["todo",      `To Do (${todoCount})`],
            ["completed", `Completed (${completedCount})`],
            ["all",       `All (${searchFiltered.length})`],
          ].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: "7px 14px", borderRadius: 8,
              border: `1px solid ${tab === id ? C.orange : C.border}`,
              background: tab === id ? C.orangeLight : C.white,
              color: tab === id ? C.orange : C.textSub,
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>{label}</button>
          ))}
        </div>

        {/* Empty state */}
        {tabFiltered.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", background: C.white, borderRadius: 16, border: `1px solid ${C.border}` }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "0 0 4px" }}>
              {search ? `No results for "${search}"` : tab === "completed" ? "No completed quizzes yet" : "All caught up!"}
            </p>
            <p style={{ fontSize: 13, color: C.textSub, margin: 0 }}>
              {search ? "Try a different search term." : tab === "completed" ? "Complete a quiz to see it here." : "Nothing left to do."}
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {tabFiltered.map(quiz => {
              // For real users, use DB-backed attempt history (keyed by quiz_id, ordered DESC).
              // For demo users, fall back to quiz.attempts (ordered ascending, last = most recent).
              const attempts    = userQuizAttempts[quiz.id] ?? quiz.attempts;
              const lastAttempt = attempts.length > 0
                ? (userQuizAttempts[quiz.id] != null ? attempts[0] : attempts[attempts.length - 1])
                : null;
              const isPassed    = lastAttempt?.passed ?? false;
              const hasTried    = attempts.length > 0;
              const dueStatus   = getDueStatus(quiz.dueAt);
              const progress    = getDueProgress(quiz.assignedAt, quiz.dueAt);

              return (
                <Card key={quiz.id} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{quiz.title}</span>
                        {isPassed && (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: "#DCFCE7", color: "#166534", border: "1px solid #86EFAC" }}>Passed</span>
                        )}
                        {hasTried && !isPassed && (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: "#FEE2E2", color: "#991B1B", border: "1px solid #FCA5A5" }}>Retry</span>
                        )}
                      </div>
                      {quiz.description && <p style={{ margin: "0 0 6px", fontSize: 12, color: C.textSub }}>{quiz.description}</p>}
                      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, color: C.textMuted }}>{quiz.track}</span>
                        <span style={{ fontSize: 12, color: C.textMuted }}>{quiz.questions.length} questions</span>
                        <span style={{ fontSize: 12, color: diffColors[quiz.difficulty] ?? C.textMuted, fontWeight: 700 }}>{quiz.difficulty}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.orange }}>+{quiz.xp} XP</span>
                        {lastAttempt && <span style={{ fontSize: 12, color: C.textMuted }}>Last score: {lastAttempt.score}%</span>}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
                      {isPassed && (
                        <button onClick={() => viewResults(quiz.id, lastAttempt)} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.cardBg, fontSize: 12, fontWeight: 600, cursor: "pointer", color: C.text }}>
                          View Results
                        </button>
                      )}
                      <button onClick={() => hasTried ? retakeQuiz(quiz.id) : startQuiz(quiz.id)} style={{
                        padding: "8px 18px", borderRadius: 8, border: "none",
                        background: isPassed ? C.orange + "CC" : C.orange,
                        color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
                      }}>
                        {isPassed ? "Retake" : hasTried ? "Resume →" : "Start →"}
                      </button>
                    </div>
                  </div>

                  {/* Due date row — only for todo/all tabs with a due date */}
                  {quiz.dueAt && !isPassed && (
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.creamBorder}` }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: dueStatus?.color ?? C.textSub }}>{dueStatus?.label}</span>
                        <span style={{ fontSize: 11, color: C.textMuted }}>Due {quiz.dueAt}</span>
                      </div>
                      <div style={{ height: 5, borderRadius: 99, background: C.muted, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", borderRadius: 99,
                          background: progress >= 100 ? C.red : progress >= 80 ? C.orange : C.trueGreen,
                          width: `${progress}%`, transition: "width 0.3s",
                        }} />
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── ADMIN VIEW ────────────────────────────────────────────────────────────
  const [assignModal, setAssignModal] = useState(null); // null | quiz object

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Quiz Library</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>
            {quizzes.length} quiz{quizzes.length !== 1 ? "zes" : ""} — use these in ralli sessions
          </p>
        </div>
        {canCreate && (
          <button onClick={() => { onEditQuiz(null); onNav("rankd-quiz-builder"); }} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 20px",
            borderRadius: 12, border: "none", cursor: "pointer",
            fontSize: 13, fontWeight: 700, color: "#fff", background: C.orange,
          }}>✚ Create Quiz</button>
        )}
      </div>

      {quizzes.length === 0 ? (
        <div style={{ padding: 60, borderRadius: 16, border: `2px dashed ${C.border}`, textAlign: "center", background: C.white }}>
          <p style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: "0 0 6px" }}>No quizzes yet</p>
          <p style={{ fontSize: 13, color: C.textSub, margin: "0 0 24px" }}>Build quizzes here, then launch them as ralli sessions</p>
          {canCreate && (
            <button onClick={() => { onEditQuiz(null); onNav("rankd-quiz-builder"); }} style={{
              padding: "12px 28px", borderRadius: 14, border: "none", cursor: "pointer",
              fontSize: 14, fontWeight: 700, background: C.orange, color: "#fff",
            }}>Build Your First Quiz →</button>
          )}
        </div>
      ) : (
        <QuizLibraryGrid
          quizzes={quizzes}
          onEditQuiz={onEditQuiz}
          onNav={onNav}
          onDeleteQuiz={onDeleteQuiz}
          onToggleFavorite={onToggleFavorite}
          onToggleActive={onToggleActive}
          onAssign={canAssign ? (quiz) => setAssignModal(quiz) : null}
          canEdit={canEdit}
          canDelete={canDelete}
          canAssign={canAssign}
          canLaunch={canLaunch}
          onLaunchQuiz={canLaunch && onLaunchQuiz ? (quiz) => onLaunchQuiz({
            code:          String(Math.floor(100000 + Math.random() * 900000)),
            name:          quiz.name,
            quizId:        quiz.id,
            questionCount: quiz.questions?.length ?? 0,
            status:        "waiting",
            playerCount:   0,
            demoMode:      false,
            players:       [],
          }) : null}
        />
      )}

      {/* Assign modal */}
      {assignModal && (
        <AssignContentModal
          contentType="quiz"
          contentId={assignModal.id}
          content={assignModal}
          orgUsers={orgUsers}
          orgs={orgs}
          currentUser={currentUser}
          tenantId={tenantId}
          isReal={isReal}
          onAssign={async (assignment) => {
            if (onAssignQuiz) {
              await onAssignQuiz(assignment);
            }
            setAssignModal(null);
          }}
          onClose={() => setAssignModal(null)}
        />
      )}
    </div>
  );
}

// ── BATTLE CARDS SCREEN ─────────────────────────────────────
//
// Data model (production-ready):
//   BC_CATEGORIES — { id, label, description }
//   BATTLE_CARDS  — { id, categoryId, title, subtitle, summary,
//                     strength, weakness, ourWin, talkTrack,
//                     content: [{ heading, body }], tags, updatedAt }
//
// Admin/Manager creation tools can be added later without restructuring
// this data shape. Replace module-level consts with API fetches when
// the backend is ready.
// ──────────────────────────────────────────────────────────────────────

const INITIAL_BC_CATEGORIES = [
  { id: "competitor", label: "Competitor Knowledge", description: "Head-to-head comparisons and positioning against competing products." },
  { id: "product",    label: "Product Knowledge",    description: "Deep dives into ralli features, use cases, and value props." },
  { id: "industry",   label: "Industry Knowledge",   description: "Market context, buyer trends, and vertical-specific insights." },
  { id: "misc",       label: "Misc.",                description: "Objection handling, pricing talk tracks, and one-offs." },
];

// Production hook: replace with API response from /api/battle-cards
const INITIAL_BATTLE_CARDS = [
  {
    id: "salesforce",
    categoryId: "competitor",
    title: "Salesforce",
    subtitle: "CRM",
    summary: "Legacy enterprise CRM with strong brand recognition but high complexity and cost.",
    strength: "Brand recognition, massive ecosystem, deep integrations",
    weakness: "Complex, expensive, over-engineered for SMB. Long implementation timelines and heavy admin overhead.",
    ourWin: "Faster implementation, lower TCO, better UX. Reps actually use it.",
    talkTrack: "I understand you're evaluating Salesforce. Many of our customers came from there. What they found was that the complexity and cost didn't match what they actually needed. With ralli, you get faster time-to-value, cleaner rep experience, and less admin overhead. Can I show you a side-by-side?",
    tags: ["crm", "enterprise", "salesforce"],
    updatedAt: "2025-06-01",
    content: [
      {
        heading: "Why Reps Leave Salesforce",
        body: "Salesforce is built for admins, not reps. The UI is dense, workflows require constant clicking, and mobile experience is poor. Studies show rep adoption is consistently below 50% without significant training investment. This creates data gaps that undermine the very reporting Salesforce is sold on.",
      },
      {
        heading: "Total Cost of Ownership",
        body: "Beyond license fees, Salesforce implementations typically require a dedicated admin (or expensive consultants), custom development for anything non-standard, and ongoing training. For SMB and mid-market, this adds 40–70% to the visible license cost. ralli is priced all-in and deploys in days, not months.",
      },
      {
        heading: "When Salesforce Is the Right Choice",
        body: "Be honest with prospects: Salesforce is appropriate for large enterprises with complex, custom process requirements, dedicated Salesforce admins on staff, and deep integrations across many departments. If the deal is with a company that matches this profile, ralli may not be the right fit — and saying so builds credibility.",
      },
    ],
  },
  {
    id: "hubspot",
    categoryId: "competitor",
    title: "HubSpot",
    subtitle: "CRM + Marketing",
    summary: "Popular with marketing-led teams, but sales analytics and enterprise workflow are its weak points.",
    strength: "Ease of use, marketing automation, freemium entry point",
    weakness: "Limited reporting for enterprise, weak sales analytics, siloed from advanced revenue operations",
    ourWin: "Deeper sales analytics, stronger enterprise workflow, unified rep + manager experience",
    talkTrack: "HubSpot is great for inbound marketing. But once sales teams scale past 10 reps, they hit the ceiling fast — reporting is shallow, pipeline management gets messy, and the CRM and marketing tools feel disconnected. ralli gives your sales team what HubSpot's CRM can't: real readiness data and performance coaching.",
    tags: ["crm", "marketing", "smb", "hubspot"],
    updatedAt: "2025-06-01",
    content: [
      {
        heading: "HubSpot's Core Strength — and Its Limit",
        body: "HubSpot's freemium model and ease of use make it a natural first CRM. The marketing automation is genuinely excellent for inbound-led businesses. But sales teams that grow past the basics quickly find the reporting insufficient, the pipeline tools clunky, and no clear path for coaching or readiness. ralli fills exactly that gap.",
      },
      {
        heading: "The Upgrade Cliff",
        body: "HubSpot's pricing tiers are aggressive. Moving from Starter to Professional to Enterprise multiplies costs quickly, and many features sales teams expect (custom reporting, advanced sequences, playbooks) are locked behind the top tier. Prospects frustrated by this cliff are natural ralli candidates.",
      },
    ],
  },
  {
    id: "outreach",
    categoryId: "competitor",
    title: "Outreach",
    subtitle: "Sales Engagement",
    summary: "Strong sequencing and dialer, but operates in isolation from CRM and is expensive per seat.",
    strength: "Sequences, dialer, analytics, strong enterprise adoption",
    weakness: "Siloed from CRM, high per-seat cost, passive tool — it doesn't coach reps",
    ourWin: "Native CRM integration, unified rep experience, proactive coaching layer built in",
    talkTrack: "Outreach is great for outbound volume. But it runs in parallel to your CRM, which means duplicate data entry, disconnected analytics, and no shared view between reps and managers. ralli integrates the engagement layer with coaching and readiness so your team is aligned, not just busy.",
    tags: ["engagement", "sequences", "outbound", "outreach"],
    updatedAt: "2025-06-01",
    content: [
      {
        heading: "The Silo Problem",
        body: "Outreach is a powerful outbound execution tool, but it creates a data silo. Activity happens in Outreach, deals live in Salesforce or HubSpot, and managers get a fragmented view. Reps have to context-switch constantly. ralli's design starts with a unified view so reps and managers always work from the same data.",
      },
      {
        heading: "Cost Efficiency",
        body: "Outreach is priced per seat and adds on top of whatever CRM the customer already runs. For mid-market sales teams, the combined stack cost can exceed $300/rep/month. ralli consolidates readiness, coaching, and game-based training in a single platform at a fraction of that cost.",
      },
    ],
  },
  {
    id: "gong",
    categoryId: "competitor",
    title: "Gong",
    subtitle: "Revenue Intelligence",
    summary: "Leading call intelligence platform, but passive by nature — it records and reports, it doesn't coach or train.",
    strength: "Call recording, deal intelligence, strong AI-driven insights",
    weakness: "Passive tool — no coaching triggers, no training integration, insight without action",
    ourWin: "Proactive coaching triggers, real-time guidance, training built into the workflow",
    talkTrack: "Gong shows you what happened. ralli changes what happens next. If you're spending on Gong to identify coachable moments but have no structured way to act on them, you're leaving money on the table. ralli closes the loop — from insight to coaching to behavior change.",
    tags: ["intelligence", "coaching", "calls", "gong"],
    updatedAt: "2025-06-01",
    content: [
      {
        heading: "Insight Without Action",
        body: "Gong's AI surfaces patterns from calls and deals — deal risk signals, talk ratio analysis, topic trends. This is genuinely valuable. But Gong stops at the insight. There's no built-in mechanism to turn a coaching observation into a training moment, a quiz, or a behavior change. That's exactly what ralli does.",
      },
      {
        heading: "Complementary, Not Competing",
        body: "In accounts that already have Gong, position ralli as the activation layer. Gong finds the gaps; ralli closes them. Many customers run both — Gong for revenue intelligence, ralli for readiness and coaching execution. This is a partnership play, not a displacement play.",
      },
      {
        heading: "Pricing Context",
        body: "Gong is priced well above mid-market thresholds, typically $100–200+ per user per year with volume commitments. This creates budget pressure that ralli can relieve by offering coaching and readiness at a lower total cost, especially for teams that don't need full call intelligence.",
      },
    ],
  },
  {
    id: "ralli-product",
    categoryId: "product",
    title: "ralli Platform Overview",
    subtitle: "Product Knowledge",
    summary: "Core platform capabilities: LMS, gamification, coaching, and readiness insights in one place.",
    strength: "Unified platform — training, games, coaching, and analytics without tool sprawl",
    weakness: "Newer to market — less brand recognition than incumbents",
    ourWin: "Built for modern sales teams: fast, engaging, and tied directly to performance outcomes",
    talkTrack: "ralli is the first platform that combines structured learning, gamified training, and manager coaching in a single rep-facing experience. Reps actually want to use it — and that means the data is real.",
    tags: ["product", "platform", "overview"],
    updatedAt: "2025-06-01",
    content: [
      {
        heading: "Core Modules",
        body: "ralli has four core modules: Learn (structured course and lesson content), ralli Sessions (live game-based training with real-time leaderboards), Battle Cards (competitive and product knowledge), and Insights (rep and team performance analytics). Each module works standalone or together.",
      },
      {
        heading: "Why Gamification Works",
        body: "Gamification in sales training isn't gimmicky — it's grounded in behavioral science. Competition, immediate feedback, and visible progress all drive engagement and retention. ralli's game sessions have 3–5x higher completion rates than traditional e-learning modules in comparable deployments.",
      },
      {
        heading: "The Manager Experience",
        body: "Managers see rep readiness scores, game participation rates, knowledge gaps by topic, and coaching opportunities flagged automatically. Instead of guessing who needs help, managers get a prioritized list. This changes 1:1s from status updates to actual coaching conversations.",
      },
    ],
  },
  {
    id: "sales-cycle",
    categoryId: "industry",
    title: "Modern B2B Sales Cycles",
    subtitle: "Industry Knowledge",
    summary: "How enterprise B2B buying has changed and what modern reps need to know.",
    strength: "Buyers are more informed, cycles are longer, consensus buying is the norm",
    weakness: "Reps trained on old techniques underperform in modern committee-driven deals",
    ourWin: "ralli trains reps on modern selling: multi-threading, champion building, and value-based conversations",
    talkTrack: "The average enterprise deal now involves 6–10 stakeholders. A rep who can only sell to a single champion will lose to a competitor who can multi-thread. ralli's training modules are built around how modern deals actually work.",
    tags: ["industry", "b2b", "buying", "enterprise"],
    updatedAt: "2025-06-01",
    content: [
      {
        heading: "The Consensus Buying Era",
        body: "Gartner research shows enterprise buying groups average 6–10 stakeholders, each with different priorities and risk thresholds. Deals stall not because the champion loses interest, but because consensus breaks down. Reps need to be trained to identify and engage all stakeholders, not just their primary contact.",
      },
      {
        heading: "The Self-Serve Buyer",
        body: "67% of the buyer journey happens before a rep is ever involved (Forrester). By the time a prospect takes a call, they've read the reviews, compared pricing pages, and often already have a shortlist. Reps who can add insight beyond what's on the website close more deals. ralli's training is built around this insight-driven selling motion.",
      },
    ],
  },
  {
    id: "price-objection",
    categoryId: "misc",
    title: "Handling the Price Objection",
    subtitle: "Objection Handling",
    summary: "Tactical talk tracks and reframes for when a prospect says your price is too high.",
    strength: "Price objections almost always mask an unresolved value question",
    weakness: "Reps who discount immediately destroy margin and signal low confidence",
    ourWin: "Anchor to ROI: cost-per-rep-per-month vs. what a single closed deal is worth",
    talkTrack: "When you say the price feels high, I want to make sure I understand — is it a budget issue, or is it that you're not yet sure the ROI is there? Most of our customers find that when a single additional deal closes because of better rep readiness, the platform pays for itself for the year. Can we look at that math together?",
    tags: ["objections", "pricing", "negotiation"],
    updatedAt: "2025-06-01",
    content: [
      {
        heading: "Price vs. Value",
        body: "A price objection is almost never actually about price. It's about unresolved value. The prospect doesn't yet believe the outcome is worth the cost. Your job isn't to lower the price — it's to sharpen the value story. Ask: 'What would it be worth to your team to close one additional deal per quarter?' Then anchor the platform cost against that number.",
      },
      {
        heading: "When Budget Is Real",
        body: "Sometimes it is actually a budget constraint — the money isn't there this cycle. In this case, explore timing: 'When does your next budget cycle open?' or 'Is there a department that might co-sponsor this?' Don't discount prematurely. Discounting trains buyers to wait for it every time.",
      },
      {
        heading: "Tactical Phrases",
        body: "Use these phrases to shift the conversation: 'Help me understand — is it about the total number, or about the per-seat cost?' / 'If the ROI was clear, would the budget be findable?' / 'What does your current solution cost you — including the time your managers spend coaching manually?' These questions redirect from price to value.",
      },
    ],
  },
];


// ── BATTLE CARDS ADMIN SCREEN ────────────────────────────────────────────────
// Admin/Manager: create, edit, delete categories and battle cards.
// Production hook: replace onSave*/onDelete* callbacks with API calls.
// ─────────────────────────────────────────────────────────────────────────────

function BattleCardsAdminScreen({ categories, cards, onSaveCategory, onDeleteCategory, onSaveCard, onDeleteCard }) {
  // view: "home" | "category" | "detail" | "editCard"
  const mobile         = useMobile();
  const [view,         setView]         = useState("home");
  const [activeCatId,  setActiveCatId]  = useState(null);
  const [activeCardId, setActiveCardId] = useState(null);
  const [search,       setSearch]       = useState("");
  const [editingCard,  setEditingCard]  = useState(null);
  const [editingCat,   setEditingCat]   = useState(null);
  const [showCatForm,  setShowCatForm]  = useState(false);
  const [confirmDel,   setConfirmDel]   = useState(null); // { type, id }

  // ── Navigation ──────────────────────────────────────────────────────────────
  const openCategory = (catId) => { setActiveCatId(catId); setView("category"); };
  const openCard     = (cardId) => { setActiveCardId(cardId); setView("detail"); };
  const goHome       = () => { setView("home"); setActiveCatId(null); setActiveCardId(null); setSearch(""); };
  const goCategory   = () => { setView("category"); setActiveCardId(null); };

  const selectedCard   = cards.find(c => c.id === activeCardId);
  const selectedCat    = categories.find(c => c.id === activeCatId);
  const cardsInCat     = cards.filter(c => c.categoryId === activeCatId).sort((a, b) => a.title.localeCompare(b.title));
  const allCardsSorted = [...cards].sort((a, b) => a.title.localeCompare(b.title));
  const filtered = search.trim()
    ? allCardsSorted.filter(c =>
        c.title.toLowerCase().includes(search.toLowerCase()) ||
        c.subtitle.toLowerCase().includes(search.toLowerCase()) ||
        c.summary.toLowerCase().includes(search.toLowerCase()) ||
        c.tags?.some(t => t.includes(search.toLowerCase()))
      )
    : allCardsSorted;

  // ── Card editor state ───────────────────────────────────────────────────────
  const blankCard = () => ({
    id: `card-${Date.now()}`,
    categoryId: activeCatId ?? categories[0]?.id ?? "",
    title: "", subtitle: "", summary: "",
    strength: "", weakness: "", ourWin: "", talkTrack: "",
    tags: [], updatedAt: new Date().toISOString().slice(0,10), content: [],
  });
  const [draft, setDraft] = useState(blankCard);
  const [cardSaving, setCardSaving] = useState(false);
  const setF = (field) => (e) => setDraft(d => ({ ...d, [field]: e.target.value }));

  const openNewCard  = () => { setDraft(blankCard()); setEditingCard("new"); setView("editCard"); };
  const openEditCard = (card) => { setDraft({ ...card }); setEditingCard(card.id); setView("editCard"); };
  const saveCard = async () => {
    if (!draft.title.trim() || cardSaving) return;
    setCardSaving(true);
    const ok = await onSaveCard({ ...draft, title: draft.title.trim(), updatedAt: new Date().toISOString().slice(0,10) });
    setCardSaving(false);
    if (ok) setView(activeCatId ? "category" : "home");
  };
  const cancelEditCard = () => setView(activeCardId ? "detail" : activeCatId ? "category" : "home");

  // content sections
  const addSection    = () => setDraft(d => ({ ...d, content: [...d.content, { heading: "", body: "" }] }));
  const removeSection = (i) => setDraft(d => ({ ...d, content: d.content.filter((_,j) => j !== i) }));
  const setSection    = (i, field, val) => setDraft(d => ({
    ...d, content: d.content.map((s, j) => j === i ? { ...s, [field]: val } : s),
  }));
  const moveSection   = (i, dir) => setDraft(d => {
    const c = [...d.content];
    const target = i + dir;
    if (target < 0 || target >= c.length) return d;
    [c[i], c[target]] = [c[target], c[i]];
    return { ...d, content: c };
  });

  // ── Category editor state ───────────────────────────────────────────────────
  const blankCat = () => ({ id: `cat-${Date.now()}`, label: "", description: "" });
  const [catDraft, setCatDraft] = useState(blankCat);
  const openNewCat  = () => { setCatDraft(blankCat()); setEditingCat("new"); setShowCatForm(true); };
  const openEditCat = (cat) => { setCatDraft({ ...cat }); setEditingCat(cat.id); setShowCatForm(true); };
  const saveCat     = async () => {
    if (!catDraft.label.trim()) return;
    const saved = await onSaveCategory({ ...catDraft, label: catDraft.label.trim() });
    setShowCatForm(false);
    if (editingCat === "new") setActiveCatId(saved?.id ?? catDraft.id);
  };

  // ── Confirm delete ──────────────────────────────────────────────────────────
  const doDelete = () => {
    if (!confirmDel) return;
    if (confirmDel.type === "card") {
      onDeleteCard(confirmDel.id);
      if (activeCardId === confirmDel.id) goCategory();
    }
    if (confirmDel.type === "category") {
      onDeleteCategory(confirmDel.id);
      if (activeCatId === confirmDel.id) goHome();
    }
    setConfirmDel(null);
  };

  const inputStyle = { width:"100%", boxSizing:"border-box", padding:"10px 14px", borderRadius:10, border:`1.5px solid ${C.border}`, background:C.cardBg, fontSize:14, color:C.text, outline:"none", fontFamily:"inherit" };
  const taStyle    = { ...inputStyle, resize:"vertical", minHeight:90, lineHeight:1.6 };
  const lbl        = (txt, req) => (
    <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.textMuted, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>
      {txt}{req && <span style={{ color:C.red }}> *</span>}
    </label>
  );

  // Shared modals (appended to every view)
  const modals = (
    <>
      {showCatForm && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999 }}
          onClick={e => { if (e.target === e.currentTarget) setShowCatForm(false); }}>
          <div style={{ background:C.cardBg, borderRadius:20, padding:"32px 36px", width:420, maxWidth:"90vw", border:`1px solid ${C.creamBorder}` }}>
            <h3 style={{ margin:"0 0 20px", fontSize:18, fontWeight:900, color:C.text }}>{editingCat === "new" ? "New Category" : "Edit Category"}</h3>
            <div style={{ marginBottom:14 }}>
              <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.textMuted, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>Name <span style={{ color:C.red }}>*</span></label>
              <input style={{ width:"100%", boxSizing:"border-box", padding:"10px 14px", borderRadius:10, border:`1.5px solid ${C.border}`, background:C.white, fontSize:14, color:C.text, outline:"none", fontFamily:"inherit" }}
                value={catDraft.label} onChange={e => setCatDraft(d => ({ ...d, label: e.target.value }))} placeholder="e.g. Competitor Knowledge"
                autoFocus />
            </div>
            <div style={{ marginBottom:24 }}>
              <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.textMuted, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>Description</label>
              <textarea style={{ width:"100%", boxSizing:"border-box", padding:"10px 14px", borderRadius:10, border:`1.5px solid ${C.border}`, background:C.white, fontSize:13, color:C.text, outline:"none", fontFamily:"inherit", resize:"vertical", minHeight:72, lineHeight:1.6 }}
                value={catDraft.description} onChange={e => setCatDraft(d => ({ ...d, description: e.target.value }))} placeholder="Short description shown to reps" />
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={() => setShowCatForm(false)} style={{ flex:1, padding:"11px 0", borderRadius:10, border:`1px solid ${C.border}`, background:C.cardBg, fontSize:13, fontWeight:700, cursor:"pointer", color:C.text }}>Cancel</button>
              <button onClick={saveCat} disabled={!catDraft.label.trim()} style={{ flex:2, padding:"11px 0", borderRadius:10, border:"none", background:catDraft.label.trim()?C.orange:C.muted, color:catDraft.label.trim()?"#fff":C.textMuted, fontSize:13, fontWeight:700, cursor:catDraft.label.trim()?"pointer":"not-allowed" }}>
                {editingCat === "new" ? "Create Category" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDel && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999 }}>
          <div style={{ background:C.cardBg, borderRadius:20, padding:"32px 36px", width:360, maxWidth:"90vw", textAlign:"center", border:`1px solid ${C.creamBorder}` }}>
            <h3 style={{ margin:"0 0 8px", fontSize:18, fontWeight:900, color:C.text }}>Delete {confirmDel.type === "card" ? "card" : "category"}?</h3>
            <p style={{ margin:"0 0 24px", fontSize:13, color:C.textSub }}>
              {confirmDel.type === "category"
                ? "This will delete the category. Cards inside it will lose their category assignment."
                : "This card will be permanently removed."}
            </p>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={() => setConfirmDel(null)} style={{ flex:1, padding:"11px 0", borderRadius:10, border:`1px solid ${C.border}`, background:C.cardBg, fontSize:13, fontWeight:700, cursor:"pointer", color:C.text }}>Cancel</button>
              <button onClick={doDelete} style={{ flex:1, padding:"11px 0", borderRadius:10, border:"none", background:"#ef4444", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // ── CARD EDITOR VIEW ────────────────────────────────────────────────────────
  if (view === "editCard") {
    const isNew = editingCard === "new";
    return (
      <div style={{ maxWidth: 740, display:"flex", flexDirection:"column", gap:0 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12, marginBottom:24 }}>
          <div>
            <button onClick={cancelEditCard} style={{ background:"none", border:"none", cursor:"pointer", fontSize:13, fontWeight:600, color:C.textSub, padding:0, display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>← Battle Cards</button>
            <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:C.text }}>{isNew ? "New Battle Card" : `Edit: ${cards.find(c => c.id === editingCard)?.title ?? ""}`}</h2>
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={cancelEditCard} style={{ padding:"10px 18px", borderRadius:10, border:`1px solid ${C.border}`, background:C.cardBg, fontSize:13, fontWeight:700, cursor:"pointer", color:C.text }}>Cancel</button>
            <button onClick={saveCard} disabled={!draft.title.trim() || cardSaving} style={{ padding:"10px 20px", borderRadius:10, border:"none", background:draft.title.trim()&&!cardSaving?C.orange:C.muted, color:draft.title.trim()&&!cardSaving?"#fff":C.textMuted, fontSize:13, fontWeight:700, cursor:draft.title.trim()&&!cardSaving?"pointer":"not-allowed" }}>
              {cardSaving ? "Saving…" : isNew ? "Create Card" : "Save Changes"}
            </button>
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <Card>
            <div style={{ fontSize:13, fontWeight:800, color:C.text, marginBottom:16 }}>Basic Info</div>
            <div style={{ display:"grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap:14, marginBottom:14 }}>
              <div>{lbl("Title", true)}<input style={inputStyle} value={draft.title} onChange={setF("title")} placeholder="e.g. Salesforce" /></div>
              <div>{lbl("Subtitle / Type")}<input style={inputStyle} value={draft.subtitle} onChange={setF("subtitle")} placeholder="e.g. CRM" /></div>
            </div>
            <div style={{ marginBottom:14 }}>
              {lbl("Category", true)}
              <select value={draft.categoryId} onChange={setF("categoryId")} style={{ ...inputStyle }}>
                {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div>{lbl("Summary")}<input style={inputStyle} value={draft.summary} onChange={setF("summary")} placeholder="One-line description shown in lists" /></div>
          </Card>

          <Card>
            <div style={{ fontSize:13, fontWeight:800, color:C.text, marginBottom:16 }}>Competitive Detail</div>
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <div>{lbl("Their Strengths", true)}<textarea style={taStyle} value={draft.strength} onChange={setF("strength")} placeholder="What they do well..." /></div>
              <div>{lbl("Their Weaknesses", true)}<textarea style={taStyle} value={draft.weakness} onChange={setF("weakness")} placeholder="Where they fall short..." /></div>
              <div>{lbl("Why We Win", true)}<textarea style={taStyle} value={draft.ourWin} onChange={setF("ourWin")} placeholder="Our differentiated value..." /></div>
              <div>{lbl("Talk Track")}<textarea style={{ ...taStyle, minHeight:110 }} value={draft.talkTrack} onChange={setF("talkTrack")} placeholder="The rep's suggested script..." /></div>
            </div>
          </Card>

          <Card>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
              <div style={{ fontSize:13, fontWeight:800, color:C.text }}>In-Depth Content</div>
              <button onClick={addSection} style={{ padding:"7px 14px", borderRadius:9, border:`1px solid ${C.orange}`, background:C.orangeLight, color:C.orange, fontSize:12, fontWeight:700, cursor:"pointer" }}>+ Add Section</button>
            </div>
            {draft.content.length === 0 ? (
              <div style={{ padding:"28px 0", textAlign:"center", borderRadius:10, border:`2px dashed ${C.creamBorder}`, background:C.pageBg }}>
                <p style={{ margin:0, fontSize:13, color:C.textSub }}>No sections yet. Add sections to give reps deeper context.</p>
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {draft.content.map((sec, i) => (
                  <div key={i} style={{ borderRadius:12, border:`1px solid ${C.creamBorder}`, padding:16, background:C.pageBg }}>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                      <span style={{ fontSize:11, fontWeight:700, color:C.textMuted }}>SECTION {i+1}</span>
                      <div style={{ display:"flex", gap:6 }}>
                        {i > 0                      && <button onClick={() => moveSection(i,-1)} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:6, width:26, height:26, cursor:"pointer", fontSize:12, color:C.textSub }}>↑</button>}
                        {i < draft.content.length-1 && <button onClick={() => moveSection(i, 1)} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:6, width:26, height:26, cursor:"pointer", fontSize:12, color:C.textSub }}>↓</button>}
                        <button onClick={() => removeSection(i)} style={{ background:"none", border:`1px solid rgba(239,68,68,0.3)`, borderRadius:6, width:26, height:26, cursor:"pointer", fontSize:12, color:"#ef4444" }}>✕</button>
                      </div>
                    </div>
                    <input style={{ ...inputStyle, marginBottom:8 }} value={sec.heading} onChange={e => setSection(i,"heading",e.target.value)} placeholder="Section heading" />
                    <textarea style={{ ...taStyle, minHeight:80 }} value={sec.body} onChange={e => setSection(i,"body",e.target.value)} placeholder="Section body..." />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
        {modals}
      </div>
    );
  }

  // ── DETAIL VIEW ─────────────────────────────────────────────────────────────
  if (view === "detail" && selectedCard) {
    return (
      <>
        <BattleCardDetail
          card={selectedCard}
          onBack={activeCatId ? goCategory : goHome}
          actions={
            <>
              <button onClick={() => openEditCard(selectedCard)} style={{ padding:"7px 16px", borderRadius:8, border:`1px solid ${C.border}`, background:C.white, fontSize:12, fontWeight:700, cursor:"pointer", color:C.text }}>Edit</button>
              <button onClick={() => setConfirmDel({ type:"card", id:selectedCard.id })} style={{ padding:"7px 16px", borderRadius:8, border:"1px solid rgba(239,68,68,0.3)", background:"rgba(239,68,68,0.05)", fontSize:12, fontWeight:700, cursor:"pointer", color:"#ef4444" }}>Delete</button>
            </>
          }
        />
        {modals}
      </>
    );
  }

  // ── CATEGORY VIEW ───────────────────────────────────────────────────────────
  if (view === "category" && selectedCat) {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
        <div>
          <button onClick={goHome} style={{ background:"none", border:"none", cursor:"pointer", padding:0, fontSize:13, fontWeight:600, color:C.textSub, display:"flex", alignItems:"center", gap:6, marginBottom:16 }}>← Battle Cards</button>
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
            <div>
              <h2 style={{ margin:0, fontSize:22, fontWeight:900, color:C.text }}>{selectedCat.label}</h2>
              <p style={{ margin:"4px 0 0", fontSize:13, color:C.textSub }}>{selectedCat.description}</p>
            </div>
            <div style={{ display:"flex", gap:8, flexShrink:0 }}>
              <button onClick={() => openEditCat(selectedCat)} style={{ padding:"9px 16px", borderRadius:10, border:`1px solid ${C.border}`, background:C.white, fontSize:12, fontWeight:700, cursor:"pointer", color:C.text }}>Edit Category</button>
              <button onClick={openNewCard} style={{ padding:"9px 16px", borderRadius:10, border:"none", background:C.orange, color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer" }}>+ New Card</button>
            </div>
          </div>
        </div>

        {cardsInCat.length === 0 ? (
          <div style={{ padding:"48px 32px", textAlign:"center", borderRadius:16, border:`2px dashed ${C.creamBorder}`, background:C.cardBg }}>
            <p style={{ margin:"0 0 6px", fontSize:14, fontWeight:700, color:C.text }}>No cards in this category yet</p>
            <p style={{ margin:"0 0 20px", fontSize:13, color:C.textSub }}>Create the first card for {selectedCat.label}.</p>
            <button onClick={openNewCard} style={{ padding:"10px 22px", borderRadius:10, border:"none", background:C.orange, color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>+ New Card</button>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {cardsInCat.map(card => (
              <div key={card.id} style={{ display:"flex", alignItems:"center", gap:8 }}>
                <button onClick={() => openCard(card.id)} style={{
                  flex:1, display:"flex", alignItems:"center", justifyContent:"space-between",
                  padding:"16px 20px", borderRadius:14,
                  border:`1px solid ${C.creamBorder}`, background:C.cardBg,
                  cursor:"pointer", textAlign:"left",
                  transition:"border-color 0.12s, background 0.12s",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = C.orangeLight; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.creamBorder; e.currentTarget.style.background = C.cardBg; }}
                >
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{card.title}</div>
                    <div style={{ fontSize:12, color:C.textSub, marginTop:2 }}>{card.subtitle}</div>
                    {card.summary && <div style={{ fontSize:12, color:C.textMuted, marginTop:4, maxWidth:520 }}>{card.summary}</div>}
                  </div>
                  <span style={{ fontSize:16, color:C.textMuted, flexShrink:0, marginLeft:16 }}>→</span>
                </button>
                <button onClick={() => openEditCard(card)} title="Edit" style={{ width:34, height:34, borderRadius:8, border:`1px solid ${C.border}`, background:C.white, fontSize:12, cursor:"pointer", color:C.textSub, flexShrink:0 }}>✎</button>
                <button onClick={() => setConfirmDel({ type:"card", id:card.id })} title="Delete" style={{ width:34, height:34, borderRadius:8, border:"1px solid rgba(239,68,68,0.3)", background:"rgba(239,68,68,0.05)", fontSize:12, cursor:"pointer", color:"#ef4444", flexShrink:0 }}>✕</button>
              </div>
            ))}
          </div>
        )}
        {modals}
      </div>
    );
  }

  // ── HOME VIEW ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
        <div>
          <h2 style={{ margin:0, fontSize:22, fontWeight:800, color:C.text }}>Battle Cards</h2>
          <p style={{ margin:"4px 0 0", fontSize:13, color:C.textSub }}>Manage competitive intelligence for your team</p>
        </div>
        <div style={{ display:"flex", gap:8, flexShrink:0 }}>
          <button onClick={openNewCat} style={{ padding:"10px 18px", borderRadius:12, border:`1px solid ${C.border}`, background:C.white, color:C.text, fontSize:13, fontWeight:700, cursor:"pointer" }}>+ New Category</button>
          <button onClick={openNewCard} style={{ padding:"10px 20px", borderRadius:12, border:"none", background:C.orange, color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>+ New Card</button>
        </div>
      </div>

      {/* Search */}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:10, background:C.cardBg, border:`1px solid ${C.creamBorder}`, maxWidth:420 }}>
        <span style={{ fontSize:13, color:C.textMuted }}>Search</span>
        <input
          type="text" value={search} placeholder="Cards, topics, competitors…"
          onChange={e => setSearch(e.target.value)}
          style={{ flex:1, border:"none", background:"transparent", fontSize:13, color:C.text, outline:"none", fontFamily:"inherit" }}
        />
        {search && <button onClick={() => setSearch("")} style={{ background:"none", border:"none", cursor:"pointer", fontSize:13, color:C.textMuted, padding:0, lineHeight:1 }}>✕</button>}
      </div>

      {/* Search results */}
      {search.trim() ? (
        <div>
          <p style={{ margin:"0 0 12px", fontSize:12, fontWeight:700, color:C.textMuted, letterSpacing:"0.06em", textTransform:"uppercase" }}>
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
          </p>
          {filtered.length === 0 ? (
            <div style={{ padding:"40px 32px", textAlign:"center", borderRadius:16, border:`2px dashed ${C.creamBorder}`, background:C.cardBg }}>
              <p style={{ margin:0, fontSize:14, fontWeight:700, color:C.text }}>No results for "{search}"</p>
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {filtered.map(card => (
                <div key={card.id} style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <button onClick={() => { setActiveCatId(card.categoryId); openCard(card.id); }} style={{
                    flex:1, display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"14px 18px", borderRadius:12, border:`1px solid ${C.creamBorder}`,
                    background:C.cardBg, cursor:"pointer", textAlign:"left",
                    transition:"border-color 0.12s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = C.orangeLight; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = C.creamBorder; e.currentTarget.style.background = C.cardBg; }}
                  >
                    <div>
                      <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{card.title}</div>
                      <div style={{ fontSize:12, color:C.textSub, marginTop:2 }}>{card.subtitle} · {categories.find(c => c.id === card.categoryId)?.label}</div>
                    </div>
                    <span style={{ fontSize:16, color:C.textMuted, flexShrink:0, marginLeft:16 }}>→</span>
                  </button>
                  <button onClick={() => { setActiveCatId(card.categoryId); openEditCard(card); }} title="Edit" style={{ width:34, height:34, borderRadius:8, border:`1px solid ${C.border}`, background:C.white, fontSize:12, cursor:"pointer", color:C.textSub, flexShrink:0 }}>✎</button>
                  <button onClick={() => setConfirmDel({ type:"card", id:card.id })} title="Delete" style={{ width:34, height:34, borderRadius:8, border:"1px solid rgba(239,68,68,0.3)", background:"rgba(239,68,68,0.05)", fontSize:12, cursor:"pointer", color:"#ef4444", flexShrink:0 }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Category grid */}
          <div>
            <p style={{ margin:"0 0 12px", fontSize:12, fontWeight:700, color:C.textMuted, letterSpacing:"0.06em", textTransform:"uppercase" }}>Categories</p>
            {categories.length === 0 ? (
              <div style={{ padding:"48px 32px", textAlign:"center", borderRadius:16, border:`2px dashed ${C.creamBorder}`, background:C.cardBg }}>
                <p style={{ margin:"0 0 6px", fontSize:14, fontWeight:700, color:C.text }}>No categories yet</p>
                <p style={{ margin:"0 0 20px", fontSize:13, color:C.textSub }}>Create a category to organize your battle cards.</p>
                <button onClick={openNewCat} style={{ padding:"10px 22px", borderRadius:10, border:"none", background:C.orange, color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>+ New Category</button>
              </div>
            ) : (
              <div style={{ display:"grid", gridTemplateColumns: mobile ? "1fr" : "repeat(2, 1fr)", gap:12 }}>
                {categories.map(cat => {
                  const count = cards.filter(c => c.categoryId === cat.id).length;
                  return (
                    <div key={cat.id} style={{ position:"relative" }}>
                      <button onClick={() => openCategory(cat.id)} style={{
                        display:"block", width:"100%", padding:"18px 20px", borderRadius:14, textAlign:"left", cursor:"pointer",
                        border:`1.5px solid ${C.creamBorder}`, background:C.cardBg,
                        transition:"border-color 0.12s, background 0.12s",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = C.orangeLight; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = C.creamBorder; e.currentTarget.style.background = C.cardBg; }}
                      >
                        <div style={{ fontSize:14, fontWeight:800, color:C.text, marginBottom:4, paddingRight:56 }}>{cat.label}</div>
                        <div style={{ fontSize:12, color:C.textSub, lineHeight:1.4, marginBottom:10 }}>{cat.description}</div>
                        <div style={{ fontSize:11, fontWeight:700, color:C.orange }}>{count} card{count !== 1 ? "s" : ""} →</div>
                      </button>
                      {/* Manager edit/delete overlay */}
                      <div style={{ position:"absolute", top:10, right:10, display:"flex", gap:4, zIndex:1 }}>
                        <button onClick={e => { e.stopPropagation(); openEditCat(cat); }} title="Edit category" style={{ width:26, height:26, borderRadius:6, border:`1px solid ${C.border}`, background:"rgba(255,255,255,0.92)", fontSize:11, cursor:"pointer", color:C.textSub }}>✎</button>
                        <button onClick={e => { e.stopPropagation(); setConfirmDel({ type:"category", id:cat.id }); }} title="Delete category" style={{ width:26, height:26, borderRadius:6, border:"1px solid rgba(239,68,68,0.3)", background:"rgba(255,255,255,0.92)", fontSize:11, cursor:"pointer", color:"#ef4444" }}>✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* All cards A–Z */}
          {allCardsSorted.length > 0 && (
            <div>
              <p style={{ margin:"0 0 12px", fontSize:12, fontWeight:700, color:C.textMuted, letterSpacing:"0.06em", textTransform:"uppercase" }}>All Cards — A to Z</p>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {allCardsSorted.map(card => (
                  <div key={card.id} style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <button onClick={() => { setActiveCatId(card.categoryId); openCard(card.id); }} style={{
                      flex:1, display:"flex", alignItems:"center", justifyContent:"space-between",
                      padding:"14px 18px", borderRadius:12, border:`1px solid ${C.creamBorder}`,
                      background:C.cardBg, cursor:"pointer", textAlign:"left",
                      transition:"border-color 0.12s, background 0.12s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = C.orangeLight; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = C.creamBorder; e.currentTarget.style.background = C.cardBg; }}
                    >
                      <div>
                        <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{card.title}</div>
                        <div style={{ fontSize:12, color:C.textSub, marginTop:2 }}>{card.subtitle} · {categories.find(c => c.id === card.categoryId)?.label}</div>
                      </div>
                      <span style={{ fontSize:16, color:C.textMuted, flexShrink:0, marginLeft:16 }}>→</span>
                    </button>
                    <button onClick={() => { setActiveCatId(card.categoryId); openEditCard(card); }} title="Edit" style={{ width:34, height:34, borderRadius:8, border:`1px solid ${C.border}`, background:C.white, fontSize:12, cursor:"pointer", color:C.textSub, flexShrink:0 }}>✎</button>
                    <button onClick={() => setConfirmDel({ type:"card", id:card.id })} title="Delete" style={{ width:34, height:34, borderRadius:8, border:"1px solid rgba(239,68,68,0.3)", background:"rgba(239,68,68,0.05)", fontSize:12, cursor:"pointer", color:"#ef4444", flexShrink:0 }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {modals}
    </div>
  );
}

// ── BattleCardsScreen ─────────────────────────────────────────────────────────
// Navigation: home → category view → card detail
// All navigation is internal state (no router needed for this screen)

function BattleCardDetail({ card, onBack, actions }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Back + header */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <button onClick={onBack} style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            fontSize: 13, fontWeight: 600, color: C.textSub, display: "flex", alignItems: "center", gap: 6,
          }}>← Back</button>
          {actions && <div style={{ display: "flex", gap: 8 }}>{actions}</div>}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: C.text }}>{card.title}</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>{card.subtitle}</p>
          </div>
          {card.updatedAt && (
            <span style={{ fontSize: 11, color: C.textMuted, padding: "4px 10px", borderRadius: 99, background: C.cardBg, border: `1px solid ${C.creamBorder}` }}>
              Updated {card.updatedAt}
            </span>
          )}
        </div>
        {card.summary && (
          <p style={{ margin: "10px 0 0", fontSize: 14, color: C.text, lineHeight: 1.6, maxWidth: 640 }}>{card.summary}</p>
        )}
      </div>

      {/* ── PRESERVED DETAIL UI ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
        <Card style={{ borderTop: `3px solid ${C.red}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.red, letterSpacing: "0.06em", marginBottom: 12 }}>THEIR STRENGTHS</div>
          <p style={{ margin: 0, fontSize: 14, color: C.text, lineHeight: 1.6 }}>{card.strength}</p>
        </Card>
        <Card style={{ borderTop: `3px solid ${C.yellow}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.yellow, letterSpacing: "0.06em", marginBottom: 12 }}>THEIR WEAKNESSES</div>
          <p style={{ margin: 0, fontSize: 14, color: C.text, lineHeight: 1.6 }}>{card.weakness}</p>
        </Card>
        <Card style={{ borderTop: `3px solid ${C.green}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.green, letterSpacing: "0.06em", marginBottom: 12 }}>WHY WE WIN</div>
          <p style={{ margin: 0, fontSize: 14, color: C.text, lineHeight: 1.6 }}>{card.ourWin}</p>
        </Card>
      </div>

      <Card style={{ background: C.pageBg }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 12 }}>TALK TRACK</div>
        <p style={{ margin: 0, fontSize: 14, color: C.text, lineHeight: 1.7, fontStyle: "italic" }}>
          "{card.talkTrack}"
        </p>
      </Card>

      {/* ── IN-DEPTH CONTENT ── */}
      {card.content?.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>
            In-Depth
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {card.content.map((section, i) => (
              <Card key={i}>
                <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 800, color: C.text }}>{section.heading}</h3>
                <p style={{ margin: 0, fontSize: 14, color: C.text, lineHeight: 1.7 }}>{section.body}</p>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BattleCardsScreen({ categories = INITIAL_BC_CATEGORIES, cards = INITIAL_BATTLE_CARDS, isLoading = false, isReal = false }) {
  // view: "home" | "category" | "detail"
  const mobile       = useMobile();
  const [view,       setView]       = useState("home");
  const [activeCat,  setActiveCat]  = useState(null); // BC_CATEGORIES id
  const [activeCard, setActiveCard] = useState(null); // BATTLE_CARDS id
  const [search,     setSearch]     = useState("");

  const openCategory = (catId) => { setActiveCat(catId); setView("category"); };
  const openCard     = (cardId) => { setActiveCard(cardId); setView("detail"); };
  const goHome       = ()       => { setView("home"); setActiveCat(null); setActiveCard(null); setSearch(""); };
  const goCategory   = ()       => { setView("category"); setActiveCard(null); };

  const selectedCard = cards.find(c => c.id === activeCard);
  const selectedCat  = categories.find(c => c.id === activeCat);
  const cardsInCat   = cards.filter(c => c.categoryId === activeCat).sort((a, b) => a.title.localeCompare(b.title));
  const allCardsSorted = [...cards].sort((a, b) => a.title.localeCompare(b.title));

  const filtered = search.trim()
    ? (() => {
        const q = search.toLowerCase();
        return allCardsSorted.filter(c => {
          const catLabel = categories.find(cat => cat.id === c.categoryId)?.label ?? "";
          return (
            c.title?.toLowerCase().includes(q) ||
            c.subtitle?.toLowerCase().includes(q) ||
            c.summary?.toLowerCase().includes(q) ||
            catLabel.toLowerCase().includes(q) ||
            c.talkTrack?.toLowerCase().includes(q) ||
            c.strength?.toLowerCase().includes(q) ||
            c.weakness?.toLowerCase().includes(q) ||
            c.ourWin?.toLowerCase().includes(q) ||
            c.tags?.some(t => t.toLowerCase().includes(q)) ||
            c.content?.some(s => s.heading?.toLowerCase().includes(q) || s.body?.toLowerCase().includes(q))
          );
        });
      })()
    : allCardsSorted;

  // ── DETAIL VIEW ──
  if (view === "detail" && selectedCard) {
    return (
      <BattleCardDetail
        card={selectedCard}
        onBack={activeCat ? goCategory : goHome}
      />
    );
  }

  // ── CATEGORY VIEW ──
  if (view === "category" && selectedCat) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <button onClick={goHome} style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            fontSize: 13, fontWeight: 600, color: C.textSub, display: "flex", alignItems: "center", gap: 6, marginBottom: 16,
          }}>← Battle Cards</button>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: C.text }}>{selectedCat.label}</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>{selectedCat.description}</p>
        </div>

        {cardsInCat.length === 0 ? (
          <div style={{ padding: "48px 32px", textAlign: "center", borderRadius: 16, border: `2px dashed ${C.creamBorder}`, background: C.cardBg }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>No cards in this category yet</p>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: C.textSub }}>Check back when more content is added.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {cardsInCat.map(card => (
              <button key={card.id} onClick={() => openCard(card.id)} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "16px 20px", borderRadius: 14,
                border: `1px solid ${C.creamBorder}`, background: C.cardBg,
                cursor: "pointer", textAlign: "left", width: "100%",
                transition: "border-color 0.12s, background 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = C.orangeLight; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = C.creamBorder; e.currentTarget.style.background = C.cardBg; }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{card.title}</div>
                  <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{card.subtitle}</div>
                  {card.summary && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, maxWidth: 520 }}>{card.summary}</div>}
                </div>
                <span style={{ fontSize: 16, color: C.textMuted, flexShrink: 0, marginLeft: 16 }}>→</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── LOADING / EMPTY GUARDS (real users only) ──
  if (isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Battle Cards</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Competitive intelligence at your fingertips</p>
        </div>
        <LoadingState rows={4} message="Loading battle cards…" />
      </div>
    );
  }

  if (isReal && categories.length === 0 && cards.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Battle Cards</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Competitive intelligence at your fingertips</p>
        </div>
        <EmptyState
          icon="🃏"
          title="No battle cards yet"
          message="Your admin hasn't added any battle cards. Check back after your team configures your content library."
        />
      </div>
    );
  }

  // ── HOME VIEW ──
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Header */}
      <div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Battle Cards</h2>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Competitive intelligence at your fingertips</p>
      </div>

      {/* Search */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: C.cardBg, border: `1px solid ${C.creamBorder}`, maxWidth: 420 }}>
        <span style={{ fontSize: 13, color: C.textMuted }}>Search</span>
        <input
          type="text" value={search} placeholder="Search battle cards…"
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, border: "none", background: "transparent", fontSize: 13, color: C.text, outline: "none", fontFamily: "inherit" }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: C.textMuted, padding: 0, lineHeight: 1 }}>✕</button>
        )}
      </div>

      {/* Search results */}
      {search.trim() ? (
        <div>
          <p style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
          </p>
          {filtered.length === 0 ? (
            <EmptyState
              icon="🔍"
              title={`No results for "${search}"`}
              message="Try a competitor name, category, or keyword from the card content."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map(card => (
                <button key={card.id} onClick={() => { setActiveCat(card.categoryId); openCard(card.id); }} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "14px 18px", borderRadius: 12, border: `1px solid ${C.creamBorder}`,
                  background: C.cardBg, cursor: "pointer", textAlign: "left", width: "100%",
                  transition: "border-color 0.12s",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = C.orangeLight; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.creamBorder; e.currentTarget.style.background = C.cardBg; }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{card.title}</div>
                    <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{card.subtitle} · {categories.find(c => c.id === card.categoryId)?.label}</div>
                  </div>
                  <span style={{ fontSize: 16, color: C.textMuted, flexShrink: 0, marginLeft: 16 }}>→</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Categories */}
          <div>
            <p style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Categories</p>
            <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "repeat(2, 1fr)", gap: 12 }}>
              {categories.map(cat => {
                const count = cards.filter(c => c.categoryId === cat.id).length;
                return (
                  <button key={cat.id} onClick={() => openCategory(cat.id)} style={{
                    padding: "18px 20px", borderRadius: 14, textAlign: "left", cursor: "pointer",
                    border: `1.5px solid ${C.creamBorder}`, background: C.cardBg, width: "100%",
                    transition: "border-color 0.12s, background 0.12s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = C.orangeLight; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = C.creamBorder; e.currentTarget.style.background = C.cardBg; }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 4 }}>{cat.label}</div>
                    <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.4, marginBottom: 10 }}>{cat.description}</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.orange }}>{count} card{count !== 1 ? "s" : ""} →</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* All cards A–Z */}
          <div>
            <p style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>All Cards — A to Z</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {allCardsSorted.map(card => (
                <button key={card.id} onClick={() => { setActiveCat(card.categoryId); openCard(card.id); }} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "14px 18px", borderRadius: 12, border: `1px solid ${C.creamBorder}`,
                  background: C.cardBg, cursor: "pointer", textAlign: "left", width: "100%",
                  transition: "border-color 0.12s, background 0.12s",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = C.orangeLight; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.creamBorder; e.currentTarget.style.background = C.cardBg; }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{card.title}</div>
                    <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>
                      {card.subtitle} · {categories.find(c => c.id === card.categoryId)?.label}
                    </div>
                  </div>
                  <span style={{ fontSize: 16, color: C.textMuted, flexShrink: 0, marginLeft: 16 }}>→</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── LEADERSHIP DASHBOARD ─────────────────────────────────────
//
// SALES READINESS SCORE MODEL
// ─────────────────────────────────────────────────────────────
// Score is a weighted composite across platform activities.
// Production hook: replace mock data with /api/orgs/:id/readiness or
// computed columns in the analytics DB. Each contributor can be weighted
// independently and new sources can be added without restructuring the model.
//
// Score contributors (0-100 each):
//   lessons       — % of assigned lessons completed
//   quizzes       — average quiz pass rate
//   games         — average game score percentile
//   battlecards   — % of battle cards reviewed
//   certifications— % of active certs current
//   coaching      — % of coaching sessions attended
//   assignments   — % of assignments completed on time
//   aiScore       — AI-inferred readiness from engagement patterns (future)
//
const READINESS_SCORE_WEIGHTS = {
  lessons:        0.20,
  quizzes:        0.25,
  games:          0.15,
  battlecards:    0.10,
  certifications: 0.10,
  coaching:       0.10,
  assignments:    0.10,
  aiScore:        0.00, // reserved for future AI contribution
};

// computeReadinessScore(contributions) → number 0-100
// contributions: { lessons, quizzes, games, ... } each 0-100
// Returns null if no data. Extensible: unknown keys are ignored.
function computeReadinessScore(contributions = {}) {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const [key, weight] of Object.entries(READINESS_SCORE_WEIGHTS)) {
    if (contributions[key] != null && weight > 0) {
      weightedSum += contributions[key] * weight;
      totalWeight  += weight;
    }
  }
  if (totalWeight === 0) return null;
  return Math.round(weightedSum / totalWeight);
}

// ── LEADERSHIP SEED DATA ──────────────────────────────────────
// Production hook: replace with /api/orgs/:id/readiness-dashboard
// All shapes here match the final API response model so the component
// can be wired to real data with minimal changes.

const LEADERSHIP_SEED = {
  // Company-level readiness
  company: {
    readinessScore:   87,
    previousScore:    82,
    targetScore:      90,
    period:           "Jun 2026",
    contributions: {
      lessons: 88, quizzes: 91, games: 84,
      battlecards: 79, certifications: 82, coaching: 86, assignments: 90,
    },
  },

  // Teams (supports any team structure — team.id is org-defined)
  teams: [
    {
      id: "smb",  name: "SMB Outbound",    headcount: 6,
      readinessScore: 94, previousScore: 90,
      contributions: { lessons: 96, quizzes: 95, games: 92, battlecards: 91, certifications: 94, coaching: 93, assignments: 96 },
    },
    {
      id: "mid",  name: "Mid-Market",      headcount: 5,
      readinessScore: 89, previousScore: 85,
      contributions: { lessons: 90, quizzes: 92, games: 87, battlecards: 85, certifications: 88, coaching: 90, assignments: 91 },
    },
    {
      id: "ent",  name: "Enterprise AE",   headcount: 4,
      readinessScore: 72, previousScore: 74,
      contributions: { lessons: 70, quizzes: 74, games: 68, battlecards: 62, certifications: 71, coaching: 75, assignments: 73 },
    },
    {
      id: "bdr",  name: "BDR / SDR",       headcount: 8,
      readinessScore: 81, previousScore: 78,
      contributions: { lessons: 82, quizzes: 83, games: 79, battlecards: 76, certifications: 80, coaching: 82, assignments: 84 },
    },
  ],

  // Knowledge heatmap — topics × dimensions
  heatmap: [
    { topic: "Product Knowledge",     score: 91, prev: 86, trend: "up"   },
    { topic: "Discovery",             score: 88, prev: 82, trend: "up"   },
    { topic: "Objection Handling",    score: 80, prev: 78, trend: "up"   },
    { topic: "Competitive Positioning", score: 64, prev: 70, trend: "down" },
    { topic: "Pricing",               score: 76, prev: 73, trend: "up"   },
    { topic: "Negotiation",           score: 69, prev: 68, trend: "flat" },
  ],

  // Trends — each period has a score for company and each team
  // Production hook: query readiness_snapshots table for range
  trends: {
    weekly: [
      { label: "W21", company: 79, smb: 88, mid: 83, ent: 68, bdr: 75 },
      { label: "W22", company: 81, smb: 90, mid: 84, ent: 69, bdr: 76 },
      { label: "W23", company: 83, smb: 91, mid: 86, ent: 70, bdr: 78 },
      { label: "W24", company: 85, smb: 92, mid: 87, ent: 71, bdr: 79 },
      { label: "W25", company: 87, smb: 94, mid: 89, ent: 72, bdr: 81 },
    ],
    monthly: [
      { label: "Feb",  company: 74, smb: 82, mid: 78, ent: 63, bdr: 70 },
      { label: "Mar",  company: 77, smb: 85, mid: 80, ent: 65, bdr: 72 },
      { label: "Apr",  company: 80, smb: 88, mid: 84, ent: 68, bdr: 76 },
      { label: "May",  company: 82, smb: 90, mid: 86, ent: 70, bdr: 78 },
      { label: "Jun",  company: 87, smb: 94, mid: 89, ent: 72, bdr: 81 },
    ],
    quarterly: [
      { label: "Q2 '25", company: 68, smb: 76, mid: 72, ent: 57, bdr: 64 },
      { label: "Q3 '25", company: 73, smb: 81, mid: 76, ent: 61, bdr: 69 },
      { label: "Q4 '25", company: 78, smb: 86, mid: 82, ent: 66, bdr: 74 },
      { label: "Q1 '26", company: 83, smb: 90, mid: 86, ent: 70, bdr: 78 },
      { label: "Q2 '26", company: 87, smb: 94, mid: 89, ent: 72, bdr: 81 },
    ],
  },

  // AI-generated summary — production: replace with LLM call against aggregated data
  aiSummary: {
    generatedAt:  "Jun 28, 2026",
    improvements: [
      "Product Knowledge improved 5 pts — strongest driver of company-wide gain.",
      "Discovery scores up 6 pts. Reps are applying the discovery framework from the June session.",
      "SMB Outbound team hit 94% readiness — highest score in 6 months.",
    ],
    declines: [
      "Competitive Positioning dropped 6 pts. Likely gap: recent competitor updates not yet covered.",
      "Enterprise AE team slipped 2 pts — Negotiation and Pricing scores below target.",
    ],
    attention: [
      "3 Enterprise AEs below 70% readiness — suggest prioritized coaching.",
      "2 reps have overdue certifications expiring within 14 days.",
    ],
    recommendations: [
      "Assign updated Competitive Positioning course to all AEs.",
      "Schedule a Negotiation refresher for Enterprise AE team.",
      "Run a ralli game session focused on pricing objections this week.",
    ],
  },

  // People insights
  people: [
    { id: "p1",  name: "Mia Chen",       initials: "MC", title: "Enterprise AE",     team: "ent", color: "#8B5CF6", score: 98, prev: 93, certsCurrent: true,  coachingAttendance: 100, tag: "promotion",  daysStreak: 21 },
    { id: "p2",  name: "Dev Patel",       initials: "DP", title: "Mid-Market AE",     team: "mid", color: "#3B82F6", score: 95, prev: 88, certsCurrent: true,  coachingAttendance: 90,  tag: "top",        daysStreak: 18 },
    { id: "p3",  name: "Jordan Rivera",   initials: "JR", title: "Senior AE",         team: "smb", color: C.orange,  score: 91, prev: 84, certsCurrent: true,  coachingAttendance: 85,  tag: "improved",   daysStreak: 7  },
    { id: "p4",  name: "Sara Kim",        initials: "SK", title: "SDR Team Lead",     team: "bdr", color: "#22C55E", score: 88, prev: 86, certsCurrent: true,  coachingAttendance: 95,  tag: "top",        daysStreak: 10 },
    { id: "p5",  name: "Tom Walsh",       initials: "TW", title: "SDR",               team: "bdr", color: "#64748B", score: 84, prev: 76, certsCurrent: false, coachingAttendance: 80,  tag: "improved",   daysStreak: 5  },
    { id: "p6",  name: "Nina Barnes",     initials: "NB", title: "BDR",               team: "bdr", color: "#EC4899", score: 78, prev: 75, certsCurrent: false, coachingAttendance: 70,  tag: null,         daysStreak: 8  },
    { id: "p7",  name: "Carlos Reyes",    initials: "CR", title: "SDR",               team: "bdr", color: "#14B8A6", score: 74, prev: 78, certsCurrent: false, coachingAttendance: 60,  tag: "coaching",   daysStreak: 2  },
    { id: "p8",  name: "Alex Liu",        initials: "AL", title: "AE",                team: "ent", color: "#F59E0B", score: 81, prev: 84, certsCurrent: true,  coachingAttendance: 65,  tag: null,         daysStreak: 3  },
    { id: "p9",  name: "Elena Torres",    initials: "ET", title: "Enterprise AE",     team: "ent", color: "#6366F1", score: 67, prev: 71, certsCurrent: false, coachingAttendance: 50,  tag: "coaching",   daysStreak: 1  },
    { id: "p10", name: "Brendan Walsh",   initials: "BW", title: "Enterprise AE",     team: "ent", color: "#F87171", score: 63, prev: 69, certsCurrent: false, coachingAttendance: 45,  tag: "coaching",   daysStreak: 0  },
  ],

  // Company risk
  risk: {
    overdueAssignments:    7,
    overdueAssignmentReps: ["Carlos Reyes", "Elena Torres", "Brendan Walsh", "Alex Liu", "Tom Walsh", "Nina Barnes", "Dev Patel"],
    overdueCertifications: 4,
    certExpiringSoon:      ["Elena Torres", "Carlos Reyes", "Nina Barnes", "Brendan Walsh"],
    lowReadinessReps:      [{ name: "Brendan Walsh", score: 63 }, { name: "Elena Torres", score: 67 }, { name: "Carlos Reyes", score: 74 }],
    teamsBelowTarget:      [{ name: "Enterprise AE", score: 72, target: 85 }],
    coachingGaps:          [{ name: "Brendan Walsh", attendance: 45 }, { name: "Elena Torres", attendance: 50 }, { name: "Carlos Reyes", attendance: 60 }],
  },
};

// ── LeadershipDashboardScreen ─────────────────────────────────
// ─────────────────────────────────────────────────────────────
// RepDrillDownModal — per-rep readiness detail for managers
// ─────────────────────────────────────────────────────────────
function RepDrillDownModal({ rep, tenantId, onClose }) {
  const [topicScores,  setTopicScores]  = useState(null);
  const [quizHistory,  setQuizHistory]  = useState(null);
  const [quizNames,    setQuizNames]    = useState({});
  const [assignments,  setAssignments]  = useState(null); // Fix 8
  const [loading,      setLoading]      = useState(true);

  useEffect(() => {
    if (!rep || !tenantId) return;
    setLoading(true);
    const repId = rep.id ?? rep.user_id;

    Promise.all([
      getRepTopicScores(tenantId, repId),
      supabase
        .from("quiz_attempts")
        .select("id, quiz_id, score, passed, attempt_num, created_at")
        .eq("tenant_id", tenantId)
        .eq("user_id", repId)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("tenant_quizzes")
        .select("id, name")
        .eq("tenant_id", tenantId),
      // Fix 8: fetch assignments + completions for this rep
      supabase
        .from("tenant_assignments")
        .select("id, content_type, content_id, assigned_to, due_at, required")
        .eq("tenant_id", tenantId),
      supabase
        .from("lesson_completions")
        .select("lesson_id, completed_at")
        .eq("tenant_id", tenantId)
        .eq("profile_id", repId),
      supabase.from("tenant_courses").select("id, name").eq("tenant_id", tenantId),
      supabase.from("tenant_lessons").select("id, name").eq("tenant_id", tenantId),
    ]).then(([topics, { data: attempts }, { data: quizzes }, { data: allAssignments }, { data: completions }, { data: courses }, { data: lessons }]) => {
      setTopicScores(topics ?? []);
      setQuizHistory(attempts ?? []);

      const names = {};
      (quizzes ?? []).forEach(q => { names[q.id] = q.name; });
      setQuizNames(names);

      // Fix 8: filter to individual assignments for this rep
      const repAssignments = (allAssignments ?? []).filter(a => {
        const at = a.assigned_to ?? {};
        return at.type === "individual" && (at.userId === repId || at.user_id === repId);
      });

      // Build content name maps
      const courseNames = {};
      (courses ?? []).forEach(c => { courseNames[c.id] = c.name; });
      const lessonNames = {};
      (lessons ?? []).forEach(l => { lessonNames[l.id] = l.name; });
      const completedLessons = new Set((completions ?? []).map(c => c.lesson_id));
      const passedQuizzes   = new Set((attempts  ?? []).filter(a => a.passed).map(a => a.quiz_id));

      const enriched = repAssignments.map(a => {
        const title =
          a.content_type === "course" ? (courseNames[a.content_id] || "Course") :
          a.content_type === "lesson" ? (lessonNames[a.content_id] || "Lesson") :
          a.content_type === "quiz"   ? (names[a.content_id]       || "Quiz")   : "Content";
        const status =
          a.content_type === "quiz"   ? (passedQuizzes.has(a.content_id)    ? "Passed"   : "Pending") :
          a.content_type === "lesson" ? (completedLessons.has(a.content_id) ? "Complete" : "Pending") :
          "Assigned";
        return { ...a, title, status };
      });

      setAssignments(enriched);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [rep?.id, rep?.user_id, tenantId]);

  if (!rep) return null;

  const name     = rep.name || rep.full_name || rep.initials || "Rep";
  const score    = rep.score ?? rep.readiness_score ?? 0;
  const band     = score >= 85 ? { label: "High",     color: C.trueGreen } :
                   score >= 65 ? { label: "On Track",  color: C.blue      } :
                                 { label: "At Risk",   color: C.red       };

  // Coaching recommendations based on topic gaps
  const recs = [];
  if (topicScores) {
    const weakTopics = topicScores.filter(t => t.avgScore < 65);
    if (weakTopics.length) {
      recs.push(`Focus coaching on: ${weakTopics.slice(0, 3).map(t => t.topic).join(", ")}.`);
    }
    if (topicScores.length && topicScores[0]?.avgScore < 50) {
      recs.push("Consider re-assigning foundational quizzes before next pipeline review.");
    }
  }
  if (score < 65) recs.push("Schedule a 1:1 coaching session this week.");
  if (!recs.length) recs.push("Rep is performing well — maintain current cadence.");

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(11,18,32,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: C.white, borderRadius: C.radius, width: "100%", maxWidth: 620,
          maxHeight: "90vh", overflowY: "auto",
          boxShadow: "0 8px 40px rgba(11,18,32,0.18)",
        }}
      >
        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar initials={rep.initials || name.slice(0, 2).toUpperCase()} size={44} color={C.white} bg={C.orange} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 17, color: C.text }}>{name}</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{rep.email || rep.role || "Team Member"}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: band.color }}>{score}%</div>
            <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>{band.label}</div>
          </div>
          <button onClick={onClose} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.textMuted, lineHeight: 1 }}>✕</button>
        </div>

        {loading ? (
          <div style={{ padding: 32 }}><LoadingState rows={4} message="Loading rep details…" /></div>
        ) : (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>

            {/* Topic Breakdown */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>Topic Readiness</div>
              {topicScores?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {topicScores.map(t => {
                    const tColor = t.avgScore >= 85 ? C.trueGreen : t.avgScore >= 65 ? C.blue : C.red;
                    return (
                      <div key={t.topic}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 13, color: C.text, textTransform: "capitalize" }}>{t.topic}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: tColor }}>{t.avgScore}%</span>
                        </div>
                        <ProgressBar value={t.avgScore} max={100} color={tColor} height={6} />
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{t.attempts} quiz{t.attempts !== 1 ? "zes" : ""} · {t.passed} passed</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: C.textMuted }}>No tagged quiz data available yet.</div>
              )}
            </div>

            {/* Quiz History */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>Recent Quiz Activity</div>
              {quizHistory?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {quizHistory.slice(0, 8).map(a => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: C.pageBg, borderRadius: C.radiusSm }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{quizNames[a.quiz_id] || "Quiz"}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{new Date(a.created_at).toLocaleDateString()}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: a.score >= 65 ? C.trueGreen : C.red }}>{a.score}%</span>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: a.passed ? C.trueGreenBg : C.redBg, color: a.passed ? C.trueGreen : C.red, fontWeight: 600 }}>{a.passed ? "Passed" : "Failed"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: C.textMuted }}>No quiz attempts recorded yet.</div>
              )}
            </div>

            {/* Fix 8: Assigned Learning */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>Assigned Learning</div>
              {assignments === null ? (
                <div style={{ fontSize: 13, color: C.textMuted }}>Loading…</div>
              ) : assignments.length === 0 ? (
                <div style={{ fontSize: 13, color: C.textMuted }}>No individual assignments for this rep.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {assignments.map(a => {
                    const statusColor =
                      a.status === "Passed"   ? C.trueGreen :
                      a.status === "Complete" ? C.blue      : C.textMuted;
                    const typeLabel =
                      a.content_type === "course" ? "Course" :
                      a.content_type === "lesson" ? "Lesson" :
                      a.content_type === "quiz"   ? "Quiz"   : a.content_type;
                    return (
                      <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: C.pageBg, borderRadius: C.radiusSm }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{a.title}</div>
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                            {typeLabel}
                            {a.due_at && a.due_at !== "Open" ? ` · Due ${new Date(a.due_at).toLocaleDateString()}` : ""}
                            {a.required ? " · Required" : ""}
                          </div>
                        </div>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 600, background: a.status === "Pending" ? C.pageBg : `${statusColor}18`, color: statusColor, border: `1px solid ${statusColor}44` }}>
                          {a.status}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Battle Card Engagement — placeholder until BC tracking is built */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 8 }}>Battle Card Engagement</div>
              <div style={{ padding: "12px 14px", background: C.pageBg, borderRadius: C.radiusSm, fontSize: 13, color: C.textMuted }}>
                Battle card engagement tracking coming soon.
              </div>
            </div>

            {/* Coaching Recommendations */}
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>Coaching Recommendations</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {recs.map((r, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, padding: "10px 14px", background: C.orangeLight, borderRadius: C.radiusSm, borderLeft: `3px solid ${C.orange}` }}>
                    <span style={{ fontSize: 13, color: C.text }}>{r}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

// Available to: orgAdmin, superadmin
// Production hook: replace LEADERSHIP_SEED with API fetch on mount.
// All data shapes mirror the final backend response model.
// ─────────────────────────────────────────────────────────────
function LeadershipDashboardScreen({ currentOrg, orgUsers = [], isReal = false }) {
  const mobile      = useMobile();
  const realMembers = orgUsers.filter(u => u._isReal);
  const hasRealData = !isReal || realMembers.length > 0;
  const [liveData,     setLiveData]     = useState(null);   // null = not yet loaded
  const [loading,      setLoading]      = useState(isReal); // true while Supabase fetch in flight
  const [trendPeriod,  setTrendPeriod]  = useState("weekly");
  const [peopleFilter, setPeopleFilter] = useState("all"); // all | top | improved | promotion | coaching
  const [teamFilter,   setTeamFilter]   = useState("all"); // all | team id
  const [selectedRep,  setSelectedRep]  = useState(null);  // rep object for drill-down modal
  const [orgMetrics,   setOrgMetrics]   = useState(null);  // getOrgMetrics result
  const [topicFilter,  setTopicFilter]  = useState(null);  // string | null — filter people by weak topic

  // Load readiness scores + topic heatmap + org metrics from Supabase
  useEffect(() => {
    const tid = currentOrg?.id;
    if (!isReal || !tid) { setLoading(false); return; }

    Promise.all([
      supabase
        .from("readiness_scores")
        .select("user_id, score, computed_at")
        .eq("tenant_id", tid)
        .order("computed_at", { ascending: false }),
      getTopicHeatmap(tid),
      getOrgMetrics(tid),
    ]).then(([{ data: rows }, heatmap, metrics]) => {
      // Org metrics are independent of whether scores exist
      if (metrics) setOrgMetrics(metrics);

      if (!rows || rows.length === 0) { setLoading(false); return; }

      // Deduplicate — take the most recent row per user (handles pre-migration multi-row data)
      const seen = new Set();
      const unique = rows.filter(r => { if (seen.has(r.user_id)) return false; seen.add(r.user_id); return true; });

      // Build people array from orgUsers + readiness_scores rows
      const people = unique.map((r, i) => {
        const member = orgUsers.find(u => u.id === r.user_id);
        return {
          id:            r.user_id,
          name:          member?.name ?? "Team Member",
          title:         member?.title ?? member?.role ?? "Rep",
          email:         member?.email ?? "",
          readinessScore: r.score ?? 0,
          previousScore:  r.score ?? 0,
          trend:         0,
          color:         ["#6366f1","#f59e0b","#10b981","#ec4899","#3b82f6"][i % 5],
        };
      });

      const avg = people.length ? Math.round(people.reduce((s, p) => s + p.readinessScore, 0) / people.length) : 0;

      setLiveData({
        company: { readinessScore: avg, previousScore: avg, targetScore: 90, trend: [], period: "Current" },
        teams:   [],
        people: people.map(p => ({
          ...p,
          score:    p.readinessScore,
          prev:     p.previousScore,
          initials: (p.name ?? "").split(" ").map(w => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "TM",
        })),
        heatmap:   heatmap ?? [],
        trends:    {},
        aiSummary: null,
        risk: {
          overdueAssignments:    0,
          overdueCertifications: 0,
          overdueAssignmentReps: [],
          certExpiringSoon:      [],
          lowReadinessReps:      people.filter(p => p.readinessScore < 65).map(p => p.id),
          teamsBelowTarget:      [],
          coachingGaps:          [],
        },
      });
      setLoading(false);
    }).catch(e => { console.error("[ralli] LeadershipDashboard fetch failed:", e); setLoading(false); });
  }, [isReal, currentOrg?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Loading / empty guards — real users only. Demo always falls through to LEADERSHIP_SEED.
  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Leadership Dashboard</h2>
        <LoadingState rows={5} message="Loading readiness data…" />
      </div>
    );
  }
  if (isReal && !liveData) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Leadership Dashboard</h2>
        <EmptyState
          icon="📊"
          title="No readiness data yet"
          message="Readiness scores appear after your team completes lessons, quizzes, and games. Check back soon."
        />
      </div>
    );
  }

  // Use live data when available; fall back to LEADERSHIP_SEED for demo / no data yet
  const data = liveData ?? LEADERSHIP_SEED;

  // ── helpers ──
  const scoreColor = (s) => s >= 85 ? C.trueGreen : s >= 70 ? C.orange : C.red;
  const scoreBg    = (s) => s >= 85 ? C.trueGreenBg : s >= 70 ? C.orangeLight : C.redBg;
  const delta      = (curr, prev) => curr - prev;
  const deltaLabel = (d) => d > 0 ? `+${d}` : `${d}`;
  const deltaColor = (d) => d > 0 ? C.trueGreen : d < 0 ? C.red : C.textMuted;
  // Fix 1: safe accessor handles both real data (avgScore) and seed data (score)
  const getTopicScore = (t) => Number(t?.avgScore ?? t?.score ?? 0);

  const trendPoints = data.trends?.[trendPeriod] ?? [];
  const maxTrendVal = 100;

  // Fix 4: topic filter — when active, show below-threshold reps; if none, show all measured reps
  const topicFilterOnTrack = (() => {
    if (!topicFilter || !data.heatmap.length) return false;
    const entry = data.heatmap.find(t => t.topic === topicFilter);
    if (!entry?.repScores?.length) return false;
    return entry.repScores.filter(r => r.score < 65).length === 0;
  })();

  const filteredPeople = (() => {
    let list = peopleFilter === "all" ? data.people : data.people.filter(p => p.tag === peopleFilter);
    if (topicFilter && data.heatmap.length > 0) {
      const topicEntry = data.heatmap.find(t => t.topic === topicFilter);
      if (topicEntry?.repScores?.length) {
        const belowIds = new Set(topicEntry.repScores.filter(r => r.score < 65).map(r => r.userId));
        if (belowIds.size > 0) {
          // Some reps below threshold — show only them
          list = list.filter(p => belowIds.has(p.id));
        } else {
          // Everyone on track — show all reps who have data for this topic
          const measuredIds = new Set(topicEntry.repScores.map(r => r.userId));
          if (measuredIds.size > 0) list = list.filter(p => measuredIds.has(p.id));
        }
      }
    }
    return list;
  })();

  const promotionReps  = data.people.filter(p => p.tag === "promotion").length;
  const coachingReps   = data.people.filter(p => p.tag === "coaching").length;
  const topRep         = data.people.find(p => p.tag === "top");
  const mostImproved   = [...data.people].sort((a, b) => delta(b.score, b.prev) - delta(a.score, a.prev))[0];
  // Fix 1: use getTopicScore() so real data (avgScore) and seed data (score) both work
  const weakestTopic   = data.heatmap.length > 0 ? [...data.heatmap].sort((a, b) => getTopicScore(a) - getTopicScore(b))[0] : null;
  const strongestTopic = data.heatmap.length > 0 ? [...data.heatmap].sort((a, b) => getTopicScore(b) - getTopicScore(a))[0] : null;

  // section header style
  const SH = (title, sub) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  // mini pill badge
  const Pill = ({ label, color, bg }) => (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
      background: bg || color + "18", color: color, letterSpacing: "0.04em", textTransform: "uppercase" }}>
      {label}
    </span>
  );

  // score badge
  const ScoreBadge = ({ score, size = 14 }) => (
    <span style={{ fontSize: size, fontWeight: 800, color: scoreColor(score),
      background: scoreBg(score), padding: "2px 8px", borderRadius: 6 }}>
      {score}%
    </span>
  );

  // ── SECTION 1 — Company Readiness ──────────────────────────
  const company = data.company;
  const companyDelta = delta(company.readinessScore, company.previousScore);
  const toTarget     = company.targetScore - company.readinessScore;

  // ── SECTION 5 — Trend Chart (pure CSS bars) ────────────────
  const TREND_SERIES = [
    { key: "company", label: "Company",      color: C.orange },
    { key: "smb",     label: "SMB Outbound", color: C.trueGreen },
    { key: "ent",     label: "Enterprise",   color: C.red },
    { key: "bdr",     label: "BDR / SDR",    color: C.blue },
  ];

  if (!hasRealData) {
    const emptyCard = (icon, title, sub) => (
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: "24px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 22 }}>{icon}</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{title}</div>
        <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.5 }}>{sub}</div>
      </div>
    );
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Dashboard</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>
            Team performance and learning progress{currentOrg ? ` · ${currentOrg.name}` : ""}
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
          {emptyCard("", "Team Performance", "Readiness scores appear once your team starts completing lessons and quizzes.")}
          {emptyCard("", "Assignments", "Assign courses and quizzes to see completion progress here.")}
          {emptyCard("", "Learning Progress", "Lesson and course completion data will appear as your team engages with content.")}
          {emptyCard("", "Quiz Scores", "Quiz performance and averages will show once reps start taking quizzes.")}
        </div>
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: "32px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.6 }}>
            Invite your first team members to get started. Data populates automatically as they complete content.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* ── Page header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Leadership Dashboard</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>
            Sales Readiness · {company.period}{currentOrg ? ` · ${currentOrg.name}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <ScoreBadge score={company.readinessScore} size={16} />
          <span style={{ fontSize: 13, fontWeight: 600, color: deltaColor(companyDelta) }}>
            {deltaLabel(companyDelta)} pts
          </span>
        </div>
      </div>

      {/* ── SECTION 1 — Organization Metrics ── */}
      {(() => {
        const m = orgMetrics;
        const readiness  = m?.overallReadiness  ?? company.readinessScore;
        const quizScore  = m?.avgQuizScore      ?? null;
        const completion = m?.completionPct     ?? null;
        const below      = m?.belowThreshold    ?? coachingReps;
        const active     = m?.activeLearners    ?? null;
        const cards = [
          {
            label: "Overall Readiness",
            value: `${readiness}%`,
            sub: m ? `${m.totalMembersScored} members scored` : `${deltaLabel(companyDelta)} pts vs last period`,
            color: scoreColor(readiness),
          },
          {
            label: "Avg Quiz Score",
            value: quizScore !== null ? `${quizScore}%` : "—",
            sub: "Across all quiz attempts",
            color: quizScore !== null ? scoreColor(quizScore) : C.textMuted,
          },
          {
            label: "Content Completion",
            value: completion !== null ? `${completion}%` : "—",
            sub: "Reps with ≥1 lesson complete",
            color: completion !== null ? scoreColor(completion) : C.textMuted,
          },
          {
            label: "Below Threshold",
            value: `${below}`,
            sub: "Reps below 65% readiness",
            color: below > 0 ? C.red : C.trueGreen,
          },
          {
            label: "Active Learners",
            value: active !== null ? `${active}` : "—",
            sub: "Engaged in last 30 days",
            color: C.blue,
          },
        ];
        return (
          <div style={{ display: "grid", gridTemplateColumns: mobile ? "repeat(2, 1fr)" : "repeat(5, 1fr)", gap: 14 }}>
            {cards.map((s, i) => (
              <Card key={i}>
                <div style={{ fontSize: 26, fontWeight: 900, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginTop: 4 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>{s.sub}</div>
              </Card>
            ))}
          </div>
        );
      })()}

      {/* ── Threshold Alert Banner — real orgs only (Fix 5: suppress for demo) ── */}
      {isReal && (() => {
        const atRisk = (liveData ?? data).people?.filter(p => (p.score ?? p.readinessScore ?? 0) < 65) ?? [];
        if (!atRisk.length) return null;
        return (
          <div style={{
            background: C.redBg, border: `1px solid ${C.red}33`,
            borderRadius: C.radiusMd, padding: "14px 18px",
            display: "flex", alignItems: "flex-start", gap: 12,
          }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.red }}>
                {atRisk.length} rep{atRisk.length !== 1 ? "s" : ""} below readiness threshold (65%)
              </div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>
                {atRisk.slice(0, 5).map(p => p.name || p.initials).join(", ")}
                {atRisk.length > 5 ? ` +${atRisk.length - 5} more` : ""}
                {" — "}
                <span
                  onClick={() => {
                    setPeopleFilter("all");
                    setTopicFilter(null);
                    // Fix 6: scroll to People Insights section
                    setTimeout(() => {
                      document.getElementById("people-insights-section")
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }, 50);
                  }}
                  style={{ color: C.red, cursor: "pointer", textDecoration: "underline", fontWeight: 600 }}
                >
                  View in People Insights
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── SECTION 2 — Highlights row ── */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr", gap: 14 }}>
        {/* Top team — guard for empty teams array (real orgs with no team assignments yet) */}
        {(() => {
          const top = data.teams.length > 0 ? [...data.teams].sort((a, b) => b.readinessScore - a.readinessScore)[0] : null;
          return top ? (
            <Card style={{ background: `linear-gradient(135deg, ${C.trueGreenBg}, #fff)`, borderColor: C.trueGreen + "44" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.trueGreen, letterSpacing: "0.06em", marginBottom: 6 }}>TOP TEAM</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{top.name}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: C.trueGreen, margin: "6px 0" }}>{top.readinessScore}%</div>
              <div style={{ fontSize: 11, color: C.textSub }}>{deltaLabel(delta(top.readinessScore, top.previousScore))} pts vs last period</div>
            </Card>
          ) : (
            <Card style={{ borderColor: C.border }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, letterSpacing: "0.06em", marginBottom: 6 }}>TOP TEAM</div>
              <div style={{ fontSize: 13, color: C.textSub }}>No teams configured yet</div>
            </Card>
          );
        })()}

        {/* Needs attention team — guard for empty teams array */}
        {(() => {
          const bot = data.teams.length > 0 ? [...data.teams].sort((a, b) => a.readinessScore - b.readinessScore)[0] : null;
          return bot ? (
            <Card style={{ background: `linear-gradient(135deg, ${C.redBg}, #fff)`, borderColor: C.red + "44" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.red, letterSpacing: "0.06em", marginBottom: 6 }}>NEEDS ATTENTION</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{bot.name}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: C.red, margin: "6px 0" }}>{bot.readinessScore}%</div>
              <div style={{ fontSize: 11, color: C.textSub }}>{deltaLabel(delta(bot.readinessScore, bot.previousScore))} pts vs last period</div>
            </Card>
          ) : (
            <Card style={{ borderColor: C.border }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, letterSpacing: "0.06em", marginBottom: 6 }}>NEEDS ATTENTION</div>
              <div style={{ fontSize: 13, color: C.textSub }}>No teams configured yet</div>
            </Card>
          );
        })()}

        {/* Weakest + Most improved topics — guard for empty heatmap */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.red, letterSpacing: "0.06em", marginBottom: 4 }}>WEAKEST SKILL</div>
              {weakestTopic ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{weakestTopic.topic}</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: C.red }}>{getTopicScore(weakestTopic)}%</div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: C.textSub }}>No skill data yet</div>
              )}
            </div>
            <div style={{ height: 1, background: C.border }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.trueGreen, letterSpacing: "0.06em", marginBottom: 4 }}>MOST IMPROVED SKILL</div>
              {strongestTopic ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{strongestTopic.topic}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 20, fontWeight: 900, color: C.trueGreen }}>{getTopicScore(strongestTopic)}%</span>
                    {strongestTopic.prev != null && (
                      <span style={{ fontSize: 12, color: C.trueGreen, fontWeight: 600 }}>
                        {deltaLabel(delta(getTopicScore(strongestTopic), strongestTopic.prev))} pts
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: C.textSub }}>No skill data yet</div>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* ── SECTION 3 — Team Readiness ── */}
      <Card>
        {SH("Team Readiness", "Readiness score by team. Click a team to filter People Insights.")}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {data.teams.map(team => {
            const d = delta(team.readinessScore, team.previousScore);
            const isActive = teamFilter === team.id;
            return (
              <div
                key={team.id}
                onClick={() => setTeamFilter(isActive ? "all" : team.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 16, padding: "14px 16px",
                  borderRadius: 10, cursor: "pointer",
                  border: `1.5px solid ${isActive ? C.orange : C.border}`,
                  background: isActive ? C.orangeLight : C.pageBg,
                  transition: "all 0.12s",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{team.name}</span>
                    <span style={{ fontSize: 11, color: C.textSub }}>{team.headcount} reps</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: deltaColor(d), marginLeft: "auto" }}>
                      {deltaLabel(d)} pts
                    </span>
                    <ScoreBadge score={team.readinessScore} />
                  </div>
                  <ProgressBar
                    value={team.readinessScore} max={100}
                    color={scoreColor(team.readinessScore)}
                    trackColor={C.border}
                    height={7}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: C.textSub, marginTop: 12 }}>
          Target: {company.targetScore}% · Colors: green ≥ 85 · orange ≥ 70 · red &lt; 70
        </div>
      </Card>

      {/* ── SECTION 4 — Knowledge Heatmap ── */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          {SH("Knowledge Heatmap", "Readiness by topic across the company. Click a topic to filter reps.")}
          {topicFilter && (
            <button
              onClick={() => setTopicFilter(null)}
              style={{ fontSize: 12, fontWeight: 600, color: C.orange, background: C.orangeLight, border: `1px solid ${C.orange}44`, borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}
            >
              Clear filter: {topicFilter} ✕
            </button>
          )}
        </div>
        {data.heatmap.length > 0 ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[...data.heatmap].sort((a, b) => (b.avgScore ?? b.score ?? 0) - (a.avgScore ?? a.score ?? 0)).map(topic => {
                const score      = topic.avgScore ?? topic.score ?? 0;
                const repsBelow  = topic.repsBelow ?? 0;
                const repsTotal  = topic.repsTotal ?? 0;
                const isSelected = topicFilter === topic.topic;
                const d          = topic.prev != null ? delta(score, topic.prev) : null;
                return (
                  <div
                    key={topic.topic}
                    onClick={() => setTopicFilter(isSelected ? null : topic.topic)}
                    style={{
                      display: "flex", alignItems: "center", gap: 14,
                      padding: "8px 10px", borderRadius: C.radiusSm, cursor: "pointer",
                      background: isSelected ? C.orangeLight : "transparent",
                      border: `1px solid ${isSelected ? C.orange + "66" : "transparent"}`,
                      transition: "background 0.15s",
                    }}
                  >
                    <div style={{ width: 160, flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, textTransform: "capitalize" }}>
                        {topic.topic}
                      </div>
                      {repsTotal > 0 && (
                        <div style={{ fontSize: 11, color: repsBelow > 0 ? C.red : C.textMuted, marginTop: 2 }}>
                          {repsBelow > 0 ? `${repsBelow} below threshold` : "All on track"} · {repsTotal} rep{repsTotal !== 1 ? "s" : ""}
                        </div>
                      )}
                    </div>
                    <div style={{ flex: 1 }}>
                      <ProgressBar value={score} max={100} color={scoreColor(score)} trackColor={C.border} height={10} />
                    </div>
                    <div style={{ width: 40, textAlign: "right", fontSize: 13, fontWeight: 700, color: scoreColor(score) }}>{score}%</div>
                    {d != null && (
                      <div style={{ width: 44, textAlign: "right", fontSize: 12, fontWeight: 600, color: deltaColor(d) }}>{deltaLabel(d)} pts</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Weak Topic Summary — bottom 3 topics */}
            {(() => {
              const weak = [...data.heatmap]
                .sort((a, b) => (a.avgScore ?? a.score ?? 0) - (b.avgScore ?? b.score ?? 0))
                .slice(0, 3)
                .filter(t => (t.avgScore ?? t.score ?? 0) < 75);
              if (!weak.length) return null;
              return (
                <div style={{ marginTop: 20, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>Weak Topics</div>
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(weak.length, 3)}, 1fr)`, gap: 10 }}>
                    {weak.map(t => {
                      const s = t.avgScore ?? t.score ?? 0;
                      return (
                        <div
                          key={t.topic}
                          onClick={() => setTopicFilter(topicFilter === t.topic ? null : t.topic)}
                          style={{
                            padding: "12px 14px", borderRadius: C.radiusSm, cursor: "pointer",
                            background: s < 65 ? C.redBg : C.orangeLight,
                            border: `1px solid ${s < 65 ? C.red + "33" : C.orange + "44"}`,
                          }}
                        >
                          <div style={{ fontSize: 12, fontWeight: 700, color: s < 65 ? C.red : C.orangeDeep, textTransform: "capitalize" }}>{t.topic}</div>
                          <div style={{ fontSize: 20, fontWeight: 900, color: s < 65 ? C.red : C.orange, margin: "4px 0" }}>{s}%</div>
                          {t.repsBelow > 0 && <div style={{ fontSize: 11, color: C.textMuted }}>{t.repsBelow} rep{t.repsBelow !== 1 ? "s" : ""} need coaching</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </>
        ) : (
          <div style={{ padding: "24px 0", textAlign: "center", color: C.textSub, fontSize: 13 }}>
            Skill data will appear here after reps complete tagged quizzes.
          </div>
        )}
      </Card>

      {/* ── SECTION 5 — Readiness Trends ── */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          {SH("Readiness Trends", "Scores over time by team.")}
          <div style={{ display: "flex", gap: 6 }}>
            {[
              { id: "weekly", label: "Weekly" },
              { id: "monthly", label: "Monthly" },
              { id: "quarterly", label: "Quarterly" },
            ].map(p => (
              <button key={p.id} onClick={() => setTrendPeriod(p.id)} style={{
                padding: "6px 12px", borderRadius: 8,
                border: `1px solid ${trendPeriod === p.id ? C.orange : C.border}`,
                background: trendPeriod === p.id ? C.orangeLight : C.white,
                color: trendPeriod === p.id ? C.orange : C.textSub,
                fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>{p.label}</button>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
          {TREND_SERIES.map(s => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color }} />
              <span style={{ fontSize: 11, color: C.textSub }}>{s.label}</span>
            </div>
          ))}
        </div>

        {/* Bar chart */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 140, overflowX: "auto" }}>
          {trendPoints.map((pt, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, flex: 1, minWidth: 48 }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 110 }}>
                {TREND_SERIES.map(s => (
                  <div key={s.key} style={{
                    width: 10, borderRadius: "3px 3px 0 0",
                    height: `${(pt[s.key] / maxTrendVal) * 110}px`,
                    background: s.color, opacity: 0.85,
                    flexShrink: 0,
                  }} title={`${s.label}: ${pt[s.key]}%`} />
                ))}
              </div>
              <div style={{ fontSize: 10, color: C.textSub, fontWeight: 600, whiteSpace: "nowrap" }}>{pt.label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── SECTION 6 — Performance Summary — only rendered when available ── */}
      {data.aiSummary && (
        <Card style={{ border: `1.5px solid ${C.orange}44`, background: `linear-gradient(135deg, ${C.orangeLight}50, #fff)` }}>
          {SH("Performance Summary", `Generated ${data.aiSummary.generatedAt} · Based on platform activity`)}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            {[
              { title: "Improvements",         items: data.aiSummary.improvements,    color: C.trueGreen, icon: "↑" },
              { title: "Declines",              items: data.aiSummary.declines,        color: C.red,       icon: "↓" },
              { title: "Needs Attention",       items: data.aiSummary.attention,       color: C.orange,    icon: "" },
              { title: "Recommended Actions",   items: data.aiSummary.recommendations, color: C.blue,      icon: "" },
            ].map(sec => (
              <div key={sec.title}>
                <div style={{ fontSize: 12, fontWeight: 800, color: sec.color, marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
                  <span>{sec.icon}</span>{sec.title.toUpperCase()}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {sec.items.map((item, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <div style={{ width: 4, height: 4, borderRadius: "50%", background: sec.color, marginTop: 6, flexShrink: 0 }} />
                      <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.5 }}>{item}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── SECTION 7 — People Insights ── */}
      <Card id="people-insights-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            {SH("People Insights", topicFilter ? `Filtered: reps below threshold on "${topicFilter}"` : "Individual readiness scores. Click a rep to view details.")}
            {topicFilter && (
              <button
                onClick={() => setTopicFilter(null)}
                style={{ fontSize: 11, fontWeight: 600, color: C.orange, background: C.orangeLight, border: `1px solid ${C.orange}44`, borderRadius: 6, padding: "3px 8px", cursor: "pointer", marginTop: -8, display: "inline-block" }}
              >
                Clear topic filter ✕
              </button>
            )}
            {/* Fix 4: on-track message when all measured reps are above threshold */}
            {topicFilterOnTrack && (
              <div style={{ marginTop: 8, fontSize: 13, color: C.trueGreen, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 15 }}>✓</span>
                Everyone measured for <strong>"{topicFilter}"</strong> is on track.
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              { id: "all",       label: "All" },
              { id: "top",       label: "Highest" },
              { id: "improved",  label: "Most Improved" },
              { id: "promotion", label: "Promotion Ready" },
              { id: "coaching",  label: "Needs Coaching" },
            ].map(f => (
              <button key={f.id} onClick={() => setPeopleFilter(f.id)} style={{
                padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                border: `1px solid ${peopleFilter === f.id ? C.orange : C.border}`,
                background: peopleFilter === f.id ? C.orangeLight : C.white,
                color: peopleFilter === f.id ? C.orange : C.textSub,
              }}>{f.label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 10, overflow: "hidden", border: `1px solid ${C.border}` }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: C.pageBg }}>
            <div style={{ width: 36 }} />
            <div style={{ flex: 1, fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.04em" }}>REP</div>
            <div style={{ width: 80, fontSize: 11, fontWeight: 700, color: C.textMuted, textAlign: "right" }}>READINESS</div>
            <div style={{ width: 60, fontSize: 11, fontWeight: 700, color: C.textMuted, textAlign: "right" }}>CHANGE</div>
            <div style={{ width: 100, fontSize: 11, fontWeight: 700, color: C.textMuted, textAlign: "right" }}>STATUS</div>
          </div>

          {filteredPeople
            .filter(p => teamFilter === "all" || p.team === teamFilter)
            .sort((a, b) => b.score - a.score)
            .map((p, i, arr) => {
              const d = delta(p.score, p.prev);
              const tagConfig = {
                promotion: { label: "Promotion Ready", color: C.trueGreen },
                top:        { label: "Top Rep",         color: C.blue      },
                improved:   { label: "Most Improved",   color: C.orange    },
                coaching:   { label: "Needs Coaching",  color: C.red       },
              };
              const tag = tagConfig[p.tag];
              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedRep(p)}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                    background: C.white, borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                    cursor: "pointer", transition: "background 0.1s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = C.pageBg}
                  onMouseLeave={e => e.currentTarget.style.background = C.white}
                >
                  <Avatar initials={p.initials} color={p.color} size={36} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: C.textSub }}>{p.title}</div>
                  </div>
                  <div style={{ width: 80, textAlign: "right" }}>
                    <ScoreBadge score={p.score} />
                  </div>
                  <div style={{ width: 60, textAlign: "right", fontSize: 13, fontWeight: 700, color: deltaColor(d) }}>
                    {deltaLabel(d)} pts
                  </div>
                  <div style={{ width: 100, textAlign: "right" }}>
                    {tag
                      ? <Pill label={tag.label} color={tag.color} />
                      : <span style={{ fontSize: 11, color: C.textMuted }}>—</span>
                    }
                  </div>
                </div>
              );
            })}

          {filteredPeople.filter(p => teamFilter === "all" || p.team === teamFilter).length === 0 && (
            <div style={{ padding: 32, textAlign: "center", fontSize: 13, color: C.textSub }}>
              No reps match this filter.
            </div>
          )}
        </div>
      </Card>

      {/* ── SECTION 8 — Company Risk ── */}
      <Card style={{ border: `1.5px solid ${C.red}33` }}>
        {SH("Company Risk", "Active risks that require manager action.")}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

          {/* Overdue assignments */}
          <div style={{ padding: 16, borderRadius: 10, background: C.redBg, border: `1px solid ${C.red}33` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Overdue Assignments</span>
              <span style={{ fontSize: 22, fontWeight: 900, color: C.red }}>{data.risk.overdueAssignments}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {data.risk.overdueAssignmentReps.slice(0, 4).map(name => (
                <div key={name} style={{ fontSize: 11, color: C.textSub }}>{name}</div>
              ))}
              {data.risk.overdueAssignmentReps.length > 4 && (
                <div style={{ fontSize: 11, color: C.textMuted }}>+{data.risk.overdueAssignmentReps.length - 4} more</div>
              )}
            </div>
          </div>

          {/* Expiring certs */}
          <div style={{ padding: 16, borderRadius: 10, background: C.orangeLight, border: `1px solid ${C.orange}33` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Expiring Certifications</span>
              <span style={{ fontSize: 22, fontWeight: 900, color: C.orange }}>{data.risk.overdueCertifications}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {data.risk.certExpiringSoon.map(name => (
                <div key={name} style={{ fontSize: 11, color: C.textSub }}>{name}</div>
              ))}
            </div>
          </div>

          {/* Low-readiness reps */}
          <div style={{ padding: 16, borderRadius: 10, background: C.redBg, border: `1px solid ${C.red}33` }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>Low-Readiness Reps</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {data.risk.lowReadinessReps.map(r => (
                <div key={r.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: C.textSub }}>{r.name}</span>
                  <ScoreBadge score={r.score} />
                </div>
              ))}
            </div>
          </div>

          {/* Teams below target + coaching gaps */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ padding: 16, borderRadius: 10, background: C.redBg, border: `1px solid ${C.red}33` }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>Teams Below Target</div>
              {data.risk.teamsBelowTarget.map(t => (
                <div key={t.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: C.textSub }}>{t.name}</span>
                  <span style={{ fontSize: 12, color: C.red, fontWeight: 700 }}>{t.score}% / {t.target}% target</span>
                </div>
              ))}
            </div>
            <div style={{ padding: 16, borderRadius: 10, background: C.pageBg, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>Coaching Gaps</div>
              {data.risk.coachingGaps.map(r => (
                <div key={r.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: C.textSub }}>{r.name}</span>
                  <span style={{ fontSize: 12, color: C.red, fontWeight: 700 }}>{r.attendance}% attendance</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Rep Drill-Down Modal */}
      {selectedRep && (
        <RepDrillDownModal
          rep={selectedRep}
          tenantId={currentOrg?.id}
          onClose={() => setSelectedRep(null)}
        />
      )}

    </div>
  );
}

// ── PROGRESS SCREEN ─────────────────────────────────────────

function ProgressScreen({ currentUser = null, isReal = false, tenantId = null }) {
  const mobile = useMobile();
  const DEMO_WEEKS = [
    { week: "W20", xp: 820 }, { week: "W21", xp: 1100 }, { week: "W22", xp: 950 },
    { week: "W23", xp: 1340 }, { week: "W24", xp: 680 },
  ];
  const [loading,   setLoading]   = useState(isReal);
  const [error,     setError]     = useState(null);
  const [weeklyXp,  setWeeklyXp]  = useState(DEMO_WEEKS);
  const [stats, setStats] = useState({
    xp:            currentUser?.xp      ?? 2340,
    streak:        currentUser?.streak  ?? 7,
    level:         currentUser?.level   ?? 14,
    xpNext:        currentUser?.xpNext  ?? 3000,
    lessonsDone:   4,
    lessonsTotal:  7,
    quizzesPassed: 3,
  });

  useEffect(() => {
    if (!isReal || !currentUser?.id || !tenantId) { setLoading(false); return; }
    const uid = currentUser.id;

    Promise.all([
      getLessonCompletions(uid),
      getUserQuizAttempts(tenantId, uid),
      supabase.from("tenant_lessons").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
      supabase.from("user_point_events")
        .select("points, created_at")
        .eq("tenant_id", tenantId)
        .eq("user_id", uid)
        .gte("created_at", new Date(Date.now() - 35 * 86_400_000).toISOString()),
    ]).then(([
      { data: completedSet },
      { data: attempts },
      { count: totalLessons },
      { data: recentEvents },
    ]) => {
      const lessonsDone   = completedSet?.size ?? 0;
      const lessonsTotal  = totalLessons ?? 0;
      const quizzesPassed = new Set((attempts ?? []).filter(a => a.passed).map(a => a.quiz_id)).size;

      setStats({
        xp:            currentUser.xp      ?? 0,
        streak:        currentUser.streak  ?? 0,
        level:         currentUser.level   ?? 1,
        xpNext:        currentUser.xpNext  ?? 1000,
        lessonsDone,
        lessonsTotal,
        quizzesPassed,
      });

      // Build weekly XP buckets (last 5 ISO weeks)
      if (recentEvents?.length) {
        const buckets = {};
        recentEvents.forEach(e => {
          const d = new Date(e.created_at);
          // Simple ISO week: day-of-year / 7
          const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
          const wk = Math.ceil(((d - start) / 86_400_000 + start.getUTCDay() + 1) / 7);
          const key = `W${String(wk).padStart(2, "0")}`;
          buckets[key] = (buckets[key] ?? 0) + (e.points ?? 0);
        });
        const sorted = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).slice(-5);
        if (sorted.length > 0) setWeeklyXp(sorted.map(([week, xp]) => ({ week, xp })));
      } else {
        setWeeklyXp([]);
      }

      setLoading(false);
    }).catch(() => {
      setError("Could not load your progress. Please refresh and try again.");
      setLoading(false);
    });
  }, [isReal, tenantId, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxXp    = Math.max(...weeklyXp.map(w => w.xp), 1);
  const xpToNext = Math.max((stats.xpNext - stats.xp), 0);

  if (loading) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>My Progress</h2>
      <LoadingState rows={4} message="Loading your progress…" />
    </div>
  );

  if (error) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>My Progress</h2>
      <ErrorState message={error} />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>My Progress</h2>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 14 }}>
        {[
          { label: "Total XP",       value: stats.xp.toLocaleString(), icon: "", color: C.orange },
          { label: "Lessons Done",   value: stats.lessonsTotal ? `${stats.lessonsDone}/${stats.lessonsTotal}` : `${stats.lessonsDone}`, icon: "", color: C.blue },
          { label: "Quizzes Passed", value: String(stats.quizzesPassed), icon: "✅", color: C.green },
          { label: "Current Streak", value: `${stats.streak} ${stats.streak === 1 ? "day" : "days"}`, icon: "", color: C.red },
        ].map((s, i) => (
          <Card key={i}>
            {s.icon && <div style={{ fontSize: 22, marginBottom: 8 }}>{s.icon}</div>}
            <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>{s.label}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 16 }}>
        {/* XP Chart */}
        <Card>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 20 }}>Weekly XP</div>
          {weeklyXp.length === 0 ? (
            <div style={{ padding: "40px 0", textAlign: "center", color: C.textMuted, fontSize: 13 }}>No XP earned yet — complete a lesson or quiz to get started.</div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 120 }}>
              {weeklyXp.map((w, i) => (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{
                    width: "100%", background: i === weeklyXp.length - 1 ? C.orangeLight : C.orange,
                    border: `2px solid ${C.orange}`,
                    borderRadius: "6px 6px 0 0",
                    height: `${Math.max((w.xp / maxXp) * 100, 4)}px`,
                    display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 6,
                  }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: i === weeklyXp.length - 1 ? C.orange : "#fff" }}>
                      {w.xp}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: C.textSub }}>{w.week}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Level progress */}
        <Card>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 20 }}>Level Progress</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 32, fontWeight: 900, color: C.orange }}>{stats.level}</div>
              <div style={{ fontSize: 12, color: C.textSub }}>Current Level</div>
            </div>
            <div style={{ fontSize: 32, color: C.textMuted }}>→</div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 32, fontWeight: 900, color: C.textSub }}>{stats.level + 1}</div>
              <div style={{ fontSize: 12, color: C.textSub }}>Next Level</div>
            </div>
          </div>
          <ProgressBar value={stats.xp % 1000} max={1000} color={C.orange} height={10} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.textSub, marginTop: 8 }}>
            <span>{stats.xp.toLocaleString()} XP</span>
            <span style={{ color: C.orange, fontWeight: 600 }}>{xpToNext.toLocaleString()} XP to go</span>
            <span>{stats.xpNext.toLocaleString()} XP</span>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── LEADERBOARD SCREEN ──────────────────────────────────────

const fullLeaderboard = [
  { rank: 1, initials: "MC", name: "Mia Chen", title: "Enterprise AE", score: 98, weeklyXp: 1420, streak: 21, color: "#8B5CF6" },
  { rank: 2, initials: "DP", name: "Dev Patel", title: "Mid-Market AE", score: 95, weeklyXp: 1280, streak: 18, color: "#3B82F6" },
  { rank: 3, initials: "JR", name: "Jordan Rivera", title: "Senior AE", score: 91, weeklyXp: 960, streak: 7, color: C.orange, isMe: true },
  { rank: 4, initials: "SK", name: "Sara Kim", title: "SDR Team Lead", score: 88, weeklyXp: 890, streak: 10, color: "#22C55E" },
  { rank: 5, initials: "TW", name: "Tom Walsh", title: "SDR", score: 84, weeklyXp: 750, streak: 5, color: C.textSub },
  { rank: 6, initials: "AL", name: "Alex Liu", title: "AE", score: 81, weeklyXp: 720, streak: 3, color: "#F59E0B" },
  { rank: 7, initials: "NB", name: "Nina Barnes", title: "BDR", score: 78, weeklyXp: 680, streak: 8, color: "#EC4899" },
  { rank: 8, initials: "CR", name: "Carlos Reyes", title: "SDR", score: 74, weeklyXp: 610, streak: 2, color: "#14B8A6" },
];

function LeaderboardScreen({ currentUser, isReal = false, tenantId = null }) {
  const mobile = useMobile();
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(isReal);

  useEffect(() => {
    if (!isReal || !tenantId) { setLoading(false); return; }
    // Inline import to avoid circular dep — scoringService is not imported at the module level for this component
    import("./src/lib/scoringService.js").then(({ getLeaderboard }) => {
      getLeaderboard(tenantId, currentUser?.id).then(({ data }) => {
        setRows(data ?? []);
        setLoading(false);
      });
    });
  }, [tenantId, isReal, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const leaderboard = isReal ? rows : fullLeaderboard.map(p => ({ ...p, isMe: p.userId ? p.userId === currentUser?.id : !!p.isMe }));

  const colGrid = "48px 1fr 90px 80px 80px 72px 72px 72px";
  const colHeader = ["#", "MEMBER", "TOTAL", "QUIZ PTS", "GAME PTS", "LEARN XP", "GAMES", "QUIZZES"];

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Leaderboard</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Team rankings based on total points earned</p>
        </div>
        <LoadingState rows={5} message="Loading rankings…" />
      </div>
    );
  }

  if (isReal && leaderboard.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Leaderboard</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Team rankings based on total points earned</p>
        </div>
        <EmptyState
          icon="🏆"
          title="No rankings yet"
          message="Rankings appear once your team starts completing lessons, quizzes, and live games."
        />
      </div>
    );
  }

  const podium = leaderboard.slice(0, 3);
  const podiumOrder = podium.length >= 3 ? [podium[1], podium[0], podium[2]] : podium;
  const podiumMedals = ["2nd", "1st", "3rd"];
  const podiumColors = [C.orange, "#F5A623", "#CD7F32"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Leaderboard</h2>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>Team rankings based on total points earned</p>
      </div>

      {/* Top 3 podium */}
      {podiumOrder.length >= 2 && (
        <Card style={{ background: `linear-gradient(135deg, ${C.dark}, #1F2937)`, border: "none" }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 20, padding: "20px 0 8px" }}>
            {podiumOrder.map((p, i) => {
              if (!p) return null;
              const isFirst = i === 1;
              const scoreColor = podiumColors[i] ?? "#A8B2C0";
              return (
                <div key={p.userId ?? p.rank} style={{ textAlign: "center", flex: 1 }}>
                  <div style={{ fontSize: isFirst ? 28 : 20, marginBottom: 8 }}>{podiumMedals[i]}</div>
                  <Avatar initials={p.initials} size={isFirst ? 60 : 48} color={scoreColor} bg={scoreColor + "33"} />
                  <div style={{ fontSize: isFirst ? 14 : 12, fontWeight: 700, color: "#fff", marginTop: 8 }}>
                    {(p.name ?? "").split(" ")[0]}{p.isMe ? " (you)" : ""}
                  </div>
                  <div style={{ fontSize: isFirst ? 22 : 18, fontWeight: 800, color: scoreColor, marginTop: 4 }}>
                    {(isReal ? p.total : p.score ?? p.total ?? 0).toLocaleString()}
                  </div>
                  <div style={{ height: isFirst ? 80 : i === 0 ? 60 : 50, background: "rgba(255,255,255,0.06)", borderRadius: "6px 6px 0 0", marginTop: 10, border: "1px solid rgba(255,255,255,0.1)" }} />
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Full table — horizontal scroll on mobile */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: mobile ? "auto" : "visible", WebkitOverflowScrolling: "touch" }}>
          <div style={{ minWidth: mobile ? 600 : "auto" }}>
            {/* Header */}
            <div style={{
              padding: "10px 20px",
              borderBottom: `1px solid ${C.border}`,
              display: "grid",
              gridTemplateColumns: colGrid,
              gap: 6,
              fontSize: 10,
              fontWeight: 700,
              color: C.textMuted,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}>
              {colHeader.map((h, i) => (
                <div key={h} style={{ textAlign: i >= 2 ? "right" : "left" }}>{h}</div>
              ))}
            </div>

            {/* Rows */}
            {leaderboard.map((p, i) => {
              const total        = isReal ? p.total        : (p.score ?? 0);
              const quizPoints   = isReal ? p.quizPoints   : 0;
              const gamePoints   = isReal ? p.gamePoints   : 0;
              const learningXp   = isReal ? p.learningXp   : (p.weeklyXp ?? 0);
              const gamesPlayed  = isReal ? p.gamesPlayed  : 0;
              const quizzesDone  = isReal ? p.quizzesCompleted : 0;
              return (
                <div key={p.userId ?? p.rank} style={{
                  padding: "12px 20px",
                  display: "grid",
                  gridTemplateColumns: colGrid,
                  gap: 6,
                  alignItems: "center",
                  background: p.isMe ? C.orangeLight : "transparent",
                  borderBottom: i < leaderboard.length - 1 ? `1px solid ${C.border}` : "none",
                  borderLeft: `3px solid ${p.isMe ? C.orange : "transparent"}`,
                }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: p.rank <= 3 ? C.orange : C.textSub }}>#{p.rank}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <Avatar initials={p.initials} size={34} color={p.color ?? C.orange} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: p.isMe ? 700 : 500, color: p.isMe ? C.orange : C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}{p.isMe ? " (you)" : ""}
                      </div>
                      {p.title && <div style={{ fontSize: 12, color: C.textSub }}>{p.title}</div>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 15, fontWeight: 800, color: C.text }}>{total.toLocaleString()}</div>
                  <div style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: C.purple ?? "#8B5CF6" }}>{quizPoints.toLocaleString()}</div>
                  <div style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: C.orange }}>{gamePoints.toLocaleString()}</div>
                  <div style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: C.green ?? "#22C55E" }}>{learningXp.toLocaleString()}</div>
                  <div style={{ textAlign: "right", fontSize: 13, color: C.textSub }}>{gamesPlayed}</div>
                  <div style={{ textAlign: "right", fontSize: 13, color: C.textSub }}>{quizzesDone}</div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}

// ── LOGIN SCREEN ───────────────────────────────────────────

// ── ORGANIZATIONS SCREEN (super admin only) ────────────────
function OrganizationsScreen({ orgs, onInviteOrg, onSelectOrg, onRefresh, onDeactivateOrg, onReactivateOrg, onDeleteOrg, onCancelOrg }) {
  const [showInvite, setShowInvite] = useState(false);
  const [form, setForm] = useState({ name: "", adminEmail: "", domain: "", plan: "Starter", seats: 10 });
  const [submitted, setSubmitted] = useState(false);
  const [inviteUrl, setInviteUrl] = useState(null);
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState(null);
  const toast = useToast();

  const resetModal = () => {
    setShowInvite(false);
    setSubmitted(false);
    setInviteUrl(null);
    setEmailSent(false);
    setEmailError(null);
    setProvisioning(false);
    setProvisionError(null);
    setForm({ name: "", adminEmail: "", domain: "", plan: "Starter", seats: 10 });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name || !form.adminEmail) return;
    const slug = form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    setProvisioning(true);
    try {
      const result = await onInviteOrg({
        slug,
        name:       form.name.trim(),
        domain:     form.domain.trim() || null,
        adminEmail: form.adminEmail.trim(),
        plan:       form.plan,
        seats:      Number(form.seats),
        seatLimit:  Number(form.seats),
        status:     "invited",
        createdAt:  new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        updatedAt:  new Date().toISOString().split("T")[0],
      });
      // result is { inviteUrl, emailSent, emailError } or null
      if (result && typeof result === "object") {
        setInviteUrl(result.inviteUrl ?? null);
        setEmailSent(result.emailSent ?? false);
        setEmailError(result.emailError ?? null);
      } else {
        setInviteUrl(result ?? null); // backward compat
      }
    } catch (err) {
      console.error("[ralli] provision failed:", err);
      setProvisionError(err?.message || "Provisioning failed. Check the console for details.");
    } finally {
      setProvisioning(false);
      setSubmitted(true);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState(null); // org to confirm deletion
  const [confirmCancel, setConfirmCancel] = useState(null); // org to confirm cancel
  const [actionLoading, setActionLoading] = useState(null); // orgId currently being actioned

  const handleOrgAction = async (action, org, e) => {
    e.stopPropagation();
    if (action === "delete")  { setConfirmDelete(org); return; }
    if (action === "cancel")  { setConfirmCancel(org); return; }
    setActionLoading(org.id);
    try {
      if (action === "deactivate") await onDeactivateOrg(org.id);
      if (action === "reactivate") await onReactivateOrg(org.id);
    } catch (err) {
      toast.error("Action failed.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setActionLoading(confirmDelete.id);
    try {
      await onDeleteOrg(confirmDelete.id);
      setConfirmDelete(null);
    } catch (err) {
      toast.error("Failed to delete organization.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleConfirmCancel = async () => {
    if (!confirmCancel) return;
    setActionLoading(confirmCancel.id);
    try {
      await onCancelOrg(confirmCancel.id);
      setConfirmCancel(null);
    } catch (err) {
      toast.error("Failed to cancel organization.");
    } finally {
      setActionLoading(null);
    }
  };

  const planColors = { Starter: C.blue, Growth: C.orange, Enterprise: C.purple };
  const statusColors = {
    active:        C.green,
    invited:       C.blue,
    pending:       C.yellow,
    pending_setup: C.yellow,
    onboarding:    C.purple,
    suspended:     "#ef4444",
    canceled:      C.textMuted,
    deleted:       C.textMuted,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: C.text }}>Organizations</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>{orgs.length} organizations · Ralli Platform</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {onRefresh && (
            <button
              onClick={onRefresh}
              style={{ padding: "10px 16px", borderRadius: 10, border: `1px solid ${C.border}`, cursor: "pointer", background: C.white, color: C.text, fontSize: 13, fontWeight: 600 }}
              title="Reload organization list from server"
            >
              ↻ Refresh
            </button>
          )}
          <button
            onClick={() => setShowInvite(true)}
            style={{ padding: "10px 20px", borderRadius: 10, border: "none", cursor: "pointer", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700 }}
          >
            + Invite Organization
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        {[
          { label: "Total Orgs",    value: orgs.length,                              icon: "",    color: C.blue   },
          { label: "Active",        value: orgs.filter(o => o.status === "active").length,  icon: "✅", color: C.green  },
          { label: "Pending Setup", value: orgs.filter(o => ["invited","onboarding","pending"].includes(o.status)).length, icon: "", color: C.yellow },
          { label: "Total Seats",   value: orgs.reduce((s, o) => s + (o.seats || o.seatLimit || 0), 0), icon: "", color: C.purple },
        ].map((s, i) => (
          <div key={i} style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: "16px 20px" }}>
            {s.icon && <div style={{ fontSize: 22, marginBottom: 8 }}>{s.icon}</div>}
            <div style={{ fontSize: 26, fontWeight: 800, color: C.text }}>{s.value}</div>
            <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Orgs table */}
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>All Organizations</span>
        </div>
        {orgs.map((org, i) => (
          <div key={org.id} style={{
            display: "flex", alignItems: "center", gap: 16, padding: "14px 20px",
            borderBottom: i < orgs.length - 1 ? `1px solid ${C.border}` : "none",
            transition: "background 0.1s",
          }}
            onMouseEnter={e => e.currentTarget.style.background = C.pageBg}
            onMouseLeave={e => e.currentTarget.style.background = ""}
          >
            {/* Avatar */}
            <div style={{
              width: 42, height: 42, borderRadius: 10, background: C.orange + "18",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 800, color: C.orange, flexShrink: 0,
            }}>{org.name.slice(0,2).toUpperCase()}</div>

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => onSelectOrg(org)}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{org.name}</div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{org.adminEmail} · {org.seats} seats</div>
            </div>

            {/* Badges */}
            <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: (planColors[org.plan] ?? C.blue) + "18", color: planColors[org.plan] ?? C.blue, flexShrink: 0 }}>{org.plan}</span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: (statusColors[org.status] ?? C.textMuted) + "20", color: statusColors[org.status] ?? C.textMuted, flexShrink: 0 }}>{org.status}</span>

            {/* Actions — shown based on current status */}
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
              <button
                onClick={() => onSelectOrg(org)}
                style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}
              >View</button>

              {/* Reactivate: suspended or canceled orgs */}
              {["suspended","canceled"].includes(org.status) ? (
                <button
                  onClick={e => handleOrgAction("reactivate", org, e)}
                  disabled={actionLoading === org.id}
                  style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.green}`, background: C.green + "15", color: C.green, fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                >{actionLoading === org.id ? "…" : "Reactivate"}</button>
              ) : (
                /* Suspend: active / onboarding / invited */
                <button
                  onClick={e => handleOrgAction("deactivate", org, e)}
                  disabled={actionLoading === org.id}
                  style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.white, color: C.textSub, fontSize: 11, fontWeight: 600, cursor: "pointer" }}
                >{actionLoading === org.id ? "…" : "Suspend"}</button>
              )}

              {/* Cancel: only for non-canceled, non-deleted orgs */}
              {!["canceled","deleted"].includes(org.status) && (
                <button
                  onClick={e => handleOrgAction("cancel", org, e)}
                  disabled={actionLoading === org.id}
                  style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #fbbf24", background: "#fffbeb", color: "#b45309", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                >Cancel</button>
              )}

              <button
                onClick={e => handleOrgAction("delete", org, e)}
                disabled={actionLoading === org.id}
                style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #fca5a5", background: "#fef2f2", color: "#ef4444", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              >Delete</button>
            </div>
          </div>
        ))}
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmDelete(null); }}
        >
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: "min(400px, calc(100vw - 32px))", boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>⚠️</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: C.text, textAlign: "center" }}>Delete {confirmDelete.name}?</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textSub, textAlign: "center", lineHeight: 1.6 }}>
              This permanently removes the organization and all its data. Existing users will be unlinked from this tenant. This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{ flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >Cancel</button>
              <button
                onClick={handleConfirmDelete}
                disabled={actionLoading === confirmDelete.id}
                style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: "#ef4444", color: "#fff", fontSize: 13, fontWeight: 700, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.7 : 1 }}
              >{actionLoading === confirmDelete.id ? "Deleting…" : "Yes, delete"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel confirmation modal */}
      {confirmCancel && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmCancel(null); }}
        >
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: "min(400px, calc(100vw - 32px))", boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>⛔</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: C.text, textAlign: "center" }}>Cancel {confirmCancel.name}?</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textSub, textAlign: "center", lineHeight: 1.6 }}>
              This marks the organization as <strong>canceled</strong>. Members will lose access. The org can be reactivated later if needed.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setConfirmCancel(null)}
                style={{ flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >Keep Active</button>
              <button
                onClick={handleConfirmCancel}
                disabled={actionLoading === confirmCancel.id}
                style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: "#b45309", color: "#fff", fontSize: 13, fontWeight: 700, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.7 : 1 }}
              >{actionLoading === confirmCancel.id ? "Canceling…" : "Yes, cancel org"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Invite modal */}
      {showInvite && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex",
          alignItems: "center", justifyContent: "center", zIndex: 1000,
        }}
          onClick={e => { if (e.target === e.currentTarget) resetModal(); }}
        >
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: 440, boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            {submitted ? (
              <div style={{ padding: "20px 0" }}>
                {provisionError ? (
                  <div style={{ textAlign: "center", marginBottom: 20 }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>❌</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#ef4444", marginBottom: 8 }}>Provisioning failed</div>
                    <p style={{ fontSize: 13, color: C.textSub, margin: 0, background: C.pageBg, borderRadius: 8, padding: "10px 14px", textAlign: "left" }}>{provisionError}</p>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", marginBottom: 16 }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>Organization provisioned!</div>
                    {emailSent
                      ? <p style={{ fontSize: 13, color: C.textSub, margin: "6px 0 0" }}>Invite email sent to <strong>{form.adminEmail}</strong></p>
                      : <p style={{ fontSize: 13, color: emailError ? "#F59E0B" : C.textSub, margin: "6px 0 0" }}>
                          {emailError ? `⚠️ Email failed — copy the link below` : "Tenant created. Copy the link below to send manually."}
                        </p>
                    }
                  </div>
                )}
                {!provisionError && (inviteUrl ? (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 8 }}>
                      {emailSent ? "INVITE LINK — ALSO AVAILABLE TO COPY" : "INVITE LINK — COPY AND SEND TO ADMIN"}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        readOnly
                        value={inviteUrl}
                        style={{ flex: 1, padding: "9px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 11, color: C.textSub, background: C.pageBg, outline: "none", overflow: "hidden", textOverflow: "ellipsis" }}
                        onClick={e => e.target.select()}
                      />
                      <button
                        onClick={() => { navigator.clipboard.writeText(inviteUrl); }}
                        style={{ padding: "9px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
                      >Copy</button>
                    </div>
                    {emailSent && (
                      <p style={{ margin: "6px 0 0", fontSize: 11, color: C.textSub }}>
                        This link is also saved on the org's detail page if you need to resend later.
                      </p>
                    )}
                  </div>
                ) : null)}
                <button onClick={resetModal} style={{ width: "100%", padding: "11px", borderRadius: 8, border: "none", cursor: "pointer", background: C.muted, color: C.text, fontSize: 13, fontWeight: 700 }}>
                  {provisionError ? "Try Again" : "Done"}
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.text }}>Invite Organization</h3>
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>They'll receive a setup email to activate their workspace.</p>
                  </div>
                  <button onClick={resetModal} style={{ background: C.muted, border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 16, color: C.textSub }}>✕</button>
                </div>
                <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {[
                    { label: "ORGANIZATION NAME", key: "name",       type: "text",  placeholder: "e.g. Acme Corp", required: true },
                    { label: "ADMIN EMAIL",        key: "adminEmail", type: "email", placeholder: "admin@company.com", required: true },
                    { label: "COMPANY DOMAIN",     key: "domain",     type: "text",  placeholder: "acme.com (optional)", required: false },
                  ].map(f => (
                    <div key={f.key}>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.06em" }}>{f.label}</label>
                      <input
                        type={f.type} value={form[f.key]} placeholder={f.placeholder} required={f.required}
                        onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                        style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, boxSizing: "border-box", outline: "none", color: C.text, background: C.inputBg }}
                      />
                    </div>
                  ))}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.06em" }}>PLAN</label>
                      <select value={form.plan} onChange={e => setForm(p => ({ ...p, plan: e.target.value }))} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.inputBg, outline: "none" }}>
                        {["Starter", "Growth", "Enterprise"].map(p => <option key={p}>{p}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.06em" }}>SEATS</label>
                      <input type="number" min="1" value={form.seats} onChange={e => setForm(p => ({ ...p, seats: e.target.value }))} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.inputBg, outline: "none", boxSizing: "border-box" }} />
                    </div>
                  </div>
                  <button type="submit" disabled={provisioning} style={{ marginTop: 4, padding: "12px", borderRadius: 8, border: "none", cursor: provisioning ? "not-allowed" : "pointer", background: C.orange, color: "#fff", fontSize: 14, fontWeight: 700, opacity: provisioning ? 0.7 : 1 }}>
                    {provisioning ? "Provisioning…" : "Send Invitation →"}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ORG SETUP SCREEN (new org admin onboarding wizard) ──────
function OrgSetupScreen({ user, onComplete }) {
  const [step, setStep] = useState(1);
  const [orgName, setOrgName] = useState(user.orgName ?? "");
  const [brandColor, setBrandColor] = useState(C.orange);
  const [features, setFeatures] = useState({
    learn:       true,
    quizzes:     true,
    games:       true,
    battlecards: true,
    leaderboard: true,
  });
  const [emailInput, setEmailInput]   = useState("");
  const [invites, setInvites]         = useState([]); // [{ email, inviteUrl, status }]
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState(null);
  const [inviteError, setInviteError] = useState(null);

  const PRESET_COLORS = [C.orange, "#3B82F6", "#8B5CF6", "#10B981", "#F43F5E", "#F59E0B"];

  const FEATURE_LIST = [
    { key: "learn",       label: "Learn",        desc: "LMS & course assignments" },
    { key: "quizzes",     label: "Quizzes",       desc: "Knowledge checks & assessments" },
    { key: "games",       label: "Games",         desc: "Live competitive learning sessions" },
    { key: "battlecards", label: "Battle Cards",  desc: "Sales objection handling library" },
    { key: "leaderboard", label: "Leaderboard",   desc: "Team rankings & competition" },
  ];

  const handleSaveBranding = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (user.orgId) {
        const { error: nameErr } = await supabase
          .from("tenants")
          .update({ name: orgName.trim() || user.orgName })
          .eq("id", user.orgId);
        if (nameErr) throw nameErr;

        const { error: brandErr } = await supabase
          .from("tenant_settings")
          .update({ branding: { primaryColor: brandColor } })
          .eq("tenant_id", user.orgId);
        if (brandErr) throw brandErr;
      }
      setStep(2);
    } catch (err) {
      console.error("[OrgSetup] branding save failed:", err);
      const msg = err?.message ?? "Failed to save branding. Please try again.";
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveFeatures = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (user.orgId) {
        const { error: featErr } = await supabase
          .from("tenant_settings")
          .update({ features })
          .eq("tenant_id", user.orgId);
        if (featErr) throw featErr;
      }
      setStep(3);
    } catch (err) {
      console.error("[OrgSetup] features save failed:", err);
      const msg = err?.message ?? "Failed to save features. Please try again.";
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleSendInvite = async () => {
    const email = emailInput.trim().toLowerCase();
    if (!email || invites.find(i => i.email === email)) return;
    setInviteError(null);
    setSaving(true);
    try {
      const result = await createMemberInvite(email, "user");
      setInvites(prev => [...prev, { email, inviteUrl: result.inviteUrl, status: "invited" }]);
      setEmailInput("");
    } catch (err) {
      setInviteError(err?.message ?? "Failed to create invite. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleComplete = async () => {
    try {
      // Direct UPDATE is blocked by RLS (tenants_update_admin = ralli_admin only).
      // Use complete_onboarding() SECURITY DEFINER RPC instead — scoped to caller's tenant.
      const { error } = await supabase.rpc("complete_onboarding");
      if (error) console.error("[OrgSetup] complete_onboarding failed:", error);
    } catch (err) {
      console.error("[OrgSetup] failed to mark tenant active:", err);
    }
    onComplete();
  };

  const inputStyle = {
    width: "100%", padding: "10px 12px", borderRadius: 8,
    border: `1.5px solid ${C.border}`, fontSize: 14, color: C.text,
    background: C.white, outline: "none", boxSizing: "border-box",
  };

  const stepLabels = ["Branding", "Features", "Team"];

  return (
    <div style={{
      minHeight: "100vh", background: C.pageBg,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }}>
      <div style={{
        background: C.white, borderRadius: 16, border: `1px solid ${C.border}`,
        padding: "36px 40px", width: "100%", maxWidth: 480,
      }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>
            Set up {user.orgName || "your organization"}
          </div>
          <div style={{ fontSize: 13, color: C.textSub }}>
            Takes about 2 minutes. You can change any of this later.
          </div>
        </div>

        {/* Step indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 32 }}>
          {stepLabels.map((label, i) => {
            const n = i + 1;
            const done    = step > n;
            const active  = step === n;
            return (
              <React.Fragment key={n}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%",
                    background: done ? C.green : active ? C.orange : C.muted,
                    color: (done || active) ? "#fff" : C.textSub,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 800,
                  }}>
                    {done ? "✓" : n}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: active ? 700 : 500, color: active ? C.orange : C.textSub }}>
                    {label}
                  </div>
                </div>
                {i < stepLabels.length - 1 && (
                  <div style={{ flex: 1, height: 2, background: step > n ? C.green : C.border, margin: "0 8px", marginBottom: 18 }} />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* ── Step 1: Branding ── */}
        {step === 1 && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 16 }}>Branding</div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 6, letterSpacing: "0.05em" }}>
                ORGANIZATION NAME
              </label>
              <input
                style={inputStyle}
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                placeholder={user.orgName ?? "Acme Corp"}
              />
            </div>

            <div style={{ marginBottom: 28 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.textSub, display: "block", marginBottom: 10, letterSpacing: "0.05em" }}>
                BRAND COLOR
              </label>
              <div style={{ display: "flex", gap: 10 }}>
                {PRESET_COLORS.map(color => (
                  <button
                    key={color}
                    onClick={() => setBrandColor(color)}
                    style={{
                      width: 34, height: 34, borderRadius: "50%", background: color,
                      border: brandColor === color ? `3px solid ${C.text}` : "3px solid transparent",
                      cursor: "pointer", outline: "none",
                    }}
                  />
                ))}
              </div>
            </div>

            <button
              onClick={handleSaveBranding}
              disabled={saving}
              style={{
                width: "100%", padding: "12px", borderRadius: 10, border: "none",
                cursor: saving ? "not-allowed" : "pointer",
                background: C.orange, color: "#fff", fontSize: 14, fontWeight: 700,
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? "Saving…" : "Continue →"}
            </button>
            {saveError && (
              <div style={{ marginTop: 10, fontSize: 12, color: C.red ?? "#EF4444", textAlign: "center" }}>
                {saveError}
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Features ── */}
        {step === 2 && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>Features</div>
            <div style={{ fontSize: 13, color: C.textSub, marginBottom: 18 }}>
              Choose what your team can access. You can change this anytime in settings.
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
              {FEATURE_LIST.map(f => (
                <div
                  key={f.key}
                  onClick={() => setFeatures(prev => ({ ...prev, [f.key]: !prev[f.key] }))}
                  style={{
                    display: "flex", alignItems: "center", gap: 14, padding: "12px 14px",
                    borderRadius: 10, border: `1.5px solid ${features[f.key] ? C.orange : C.border}`,
                    background: features[f.key] ? C.orangeLight : C.white,
                    cursor: "pointer",
                  }}
                >
                  {/* Toggle */}
                  <div style={{
                    width: 36, height: 20, borderRadius: 10, flexShrink: 0,
                    background: features[f.key] ? C.orange : C.muted,
                    position: "relative", transition: "background 0.15s",
                  }}>
                    <div style={{
                      position: "absolute", top: 2, left: features[f.key] ? 18 : 2,
                      width: 16, height: 16, borderRadius: "50%", background: "#fff",
                      transition: "left 0.15s",
                    }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{f.label}</div>
                    <div style={{ fontSize: 11, color: C.textSub }}>{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setStep(1); setSaveError(null); }}
                style={{ flex: 1, padding: "12px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >
                ← Back
              </button>
              <button
                onClick={handleSaveFeatures}
                disabled={saving}
                style={{ flex: 2, padding: "12px", borderRadius: 10, border: "none", cursor: saving ? "not-allowed" : "pointer", background: C.orange, color: "#fff", fontSize: 14, fontWeight: 700, opacity: saving ? 0.7 : 1 }}
              >
                {saving ? "Saving…" : "Continue →"}
              </button>
            </div>
            {saveError && (
              <div style={{ marginTop: 10, fontSize: 12, color: C.red ?? "#EF4444", textAlign: "center" }}>
                {saveError}
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Invite team ── */}
        {step === 3 && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>Invite your team</div>
            <div style={{ fontSize: 13, color: C.textSub, marginBottom: 18 }}>
              Add email addresses and copy invite links to send to your reps. Skip this and invite later from the Team screen.
            </div>

            {/* Email input */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                style={{ ...inputStyle, flex: 1 }}
                value={emailInput}
                onChange={e => setEmailInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSendInvite()}
                placeholder="rep@yourcompany.com"
                type="email"
              />
              <button
                onClick={handleSendInvite}
                disabled={saving || !emailInput.trim()}
                style={{
                  padding: "10px 16px", borderRadius: 8, border: "none",
                  background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700,
                  cursor: (saving || !emailInput.trim()) ? "not-allowed" : "pointer",
                  opacity: (saving || !emailInput.trim()) ? 0.6 : 1, whiteSpace: "nowrap",
                }}
              >
                {saving ? "…" : "+ Add"}
              </button>
            </div>

            {inviteError && (
              <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 12, padding: "8px 12px", background: "#fef2f2", borderRadius: 8 }}>
                {inviteError}
              </div>
            )}

            {/* Invite list */}
            {invites.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                {invites.map((inv, i) => (
                  <div key={i} style={{ background: C.pageBg, borderRadius: 10, padding: "10px 12px", border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>{inv.email}</div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        readOnly
                        value={inv.inviteUrl}
                        style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 10, color: C.textSub, background: C.white, outline: "none" }}
                        onClick={e => e.target.select()}
                      />
                      <button
                        onClick={() => navigator.clipboard.writeText(inv.inviteUrl)}
                        style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: C.orange, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: invites.length === 0 ? 8 : 0 }}>
              <button
                onClick={() => setStep(2)}
                style={{ flex: 1, padding: "12px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >
                ← Back
              </button>
              <button
                onClick={handleComplete}
                style={{ flex: 2, padding: "12px", borderRadius: 10, border: "none", cursor: "pointer", background: C.green, color: "#fff", fontSize: 14, fontWeight: 700 }}
              >
                {invites.length > 0 ? "Done — go to dashboard →" : "Skip for now →"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ORG DETAIL SCREEN (ralli admin only) ─────────────────────────────────────
// Full lifecycle: view, edit, manage members, manage invitations.
function OrgDetailScreen({ org, orgUsers, onBack, onAddUser, onDeactivateOrg, onReactivateOrg, onDeleteOrg, onCancelOrg, onUpdateOrg, onUpdateMember, onRemoveMember, onCancelInvite, onResendMemberInvite }) {
  const mobile = useMobile();
  const [realMembers, setRealMembers]       = useState(null);   // profiles[]
  const [invitations, setInvitations]       = useState(null);   // all tenant_invitations[]
  const [tenantSettings, setTenantSettings] = useState(null);   // tenant_settings row
  const [tenantTeams, setTenantTeams]       = useState([]);     // tenant_teams[]
  const [localOrg, setLocalOrg]             = useState(org);    // optimistic local copy
  const [actionLoading, setActionLoading]   = useState(null);
  const [confirmDelete, setConfirmDelete]   = useState(false);
  const [confirmCancel, setConfirmCancel]   = useState(false);

  // Feature toggle state
  const [featureSaving, setFeatureSaving] = useState(false);
  const [featureError, setFeatureError]   = useState(null);

  // Edit org state
  const [showEdit, setShowEdit]       = useState(false);
  const [editForm, setEditForm]       = useState({});
  const [editSaving, setEditSaving]   = useState(false);
  const [editError, setEditError]     = useState(null);

  // Member management state
  const [editMember, setEditMember]           = useState(null); // profile being edited
  const [editMemberForm, setEditMemberForm]   = useState({});
  const [memberSaving, setMemberSaving]       = useState(false);
  const [memberError, setMemberError]         = useState(null);
  const [confirmRemove, setConfirmRemove]     = useState(null); // profile to remove

  // Inline member invite (for ralli admin adding a member)
  const [showInviteForm, setShowInviteForm]   = useState(false);
  const [inviteForm, setInviteForm]           = useState({ email: "", role: "user" });
  const [inviteLoading, setInviteLoading]     = useState(false);
  const [inviteError, setInviteError]         = useState(null);
  const [newInviteUrl, setNewInviteUrl]       = useState(null);
  const [inviteEmailSent,  setInviteEmailSent]  = useState(null); // true | false | null
  const [inviteEmailError, setInviteEmailError] = useState(null); // string | null

  const toast = useToast();

  // Resend admin invite
  const [resendStatus, setResendStatus] = useState(null);

  // Load all members + all invitations on mount
  const refreshData = async () => {
    if (!org.id || org.id.startsWith("org_temp_")) return;
    try {
      const [{ data: memberData }, { data: invData }, { data: settingsData }, { data: teamsData }] = await Promise.all([
        supabase.from("profiles").select("*").eq("tenant_id", org.id).neq("status", "inactive"),
        supabase.rpc("get_tenant_invitations", { p_tenant_id: org.id }),
        supabase.from("tenant_settings").select("*").eq("tenant_id", org.id).single(),
        supabase.from("tenant_teams").select("id, name").eq("tenant_id", org.id),
      ]);
      setRealMembers(memberData ?? []);
      const invArr = Array.isArray(invData) ? invData : (typeof invData === "string" ? JSON.parse(invData) : invData ?? []);
      setInvitations(invArr);
      if (settingsData) setTenantSettings(settingsData);
      setTenantTeams(teamsData ?? []);
    } catch (err) {
      console.error("[OrgDetailScreen] load failed:", err);
      setRealMembers([]);
      setInvitations([]);
    }
  };

  useEffect(() => { refreshData(); }, [org.id]);

  // Sync localOrg when parent org changes (e.g. after handleUpdateOrg updates orgs state)
  useEffect(() => { setLocalOrg(org); }, [org]);

  const adminInvite = invitations?.find(i => i.role === "orgAdmin" || i.role === "superadmin") ?? null;
  const memberInvites = (invitations ?? []).filter(i => !["orgAdmin","superadmin"].includes(i.role) && !["accepted","canceled"].includes(i.status));
  const memberInviteHistory = (invitations ?? []).filter(i => !["orgAdmin","superadmin"].includes(i.role) && ["accepted","canceled"].includes(i.status));

  const handleResendAdminEmail = async () => {
    if (!adminInvite) return;
    setResendStatus("sending");
    try {
      await sendInviteEmail({ to: adminInvite.email, orgName: localOrg.name, inviteUrl: buildInviteUrl(adminInvite.token) });
      setResendStatus("sent");
    } catch (err) {
      console.error("[OrgDetailScreen] resend failed:", err);
      setResendStatus("error");
    }
  };

  const handleFeatureToggle = async (featureKey, enabled) => {
    if (!tenantSettings) return;
    setFeatureSaving(true);
    setFeatureError(null);
    const newFeatures = { ...(tenantSettings.feature_access ?? {}), [featureKey]: enabled };
    try {
      const { error } = await supabase.from("tenant_settings")
        .update({ feature_access: newFeatures })
        .eq("tenant_id", localOrg.id);
      if (error) throw error;
      setTenantSettings(prev => ({ ...prev, feature_access: newFeatures }));
    } catch (err) {
      setFeatureError(err?.message ?? "Failed to update feature.");
    } finally {
      setFeatureSaving(false);
    }
  };

  const handleSuspend = async () => {
    setActionLoading("suspend");
    try {
      await onDeactivateOrg(localOrg.id);
      setLocalOrg(prev => ({ ...prev, status: "suspended" }));
    } catch (err) { toast.error("Failed to suspend organization."); }
    finally { setActionLoading(null); }
  };

  const handleReactivate = async () => {
    setActionLoading("reactivate");
    try {
      await onReactivateOrg(localOrg.id);
      setLocalOrg(prev => ({ ...prev, status: "active" }));
    } catch (err) { toast.error("Failed to reactivate organization."); }
    finally { setActionLoading(null); }
  };

  const handleDelete = async () => {
    setActionLoading("delete");
    try {
      await onDeleteOrg(localOrg.id);
      onBack();
    } catch (err) {
      toast.error("Failed to delete organization.");
      setActionLoading(null);
      setConfirmDelete(false);
    }
  };

  const handleCancel = async () => {
    setActionLoading("cancel");
    try {
      await onCancelOrg(localOrg.id);
      setLocalOrg(prev => ({ ...prev, status: "canceled" }));
      setConfirmCancel(false);
    } catch (err) {
      toast.error("Failed to cancel organization.");
    } finally {
      setActionLoading(null);
    }
  };

  // ── Edit org ──────────────────────────────────────────────────────────────
  const openEdit = () => {
    setEditForm({
      name:      localOrg.name      ?? "",
      plan:      (localOrg.plan     ?? "Starter").charAt(0).toUpperCase() + (localOrg.plan ?? "Starter").slice(1),
      seats:     localOrg.seatLimit ?? localOrg.seats ?? 10,
      status:    localOrg.status    ?? "active",
      domain:    localOrg.domain    ?? "",
      adminEmail: localOrg.adminEmail ?? "",
    });
    setEditError(null);
    setShowEdit(true);
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    setEditSaving(true);
    setEditError(null);
    try {
      await onUpdateOrg(localOrg.id, {
        name:      editForm.name      || null,
        plan:      editForm.plan      || null,
        seatLimit: parseInt(editForm.seats) || null,
        status:    editForm.status    || null,
        domain:    editForm.domain    !== undefined ? editForm.domain : null,
        adminEmail: editForm.adminEmail !== undefined ? editForm.adminEmail : null,
      });
      // Merge edit into localOrg
      setLocalOrg(prev => ({
        ...prev,
        name:      editForm.name   || prev.name,
        plan:      editForm.plan   || prev.plan,
        seatLimit: parseInt(editForm.seats) || prev.seatLimit,
        seats:     parseInt(editForm.seats) || prev.seats,
        status:    editForm.status || prev.status,
        domain:    editForm.domain,
        adminEmail: editForm.adminEmail,
      }));
      setShowEdit(false);
    } catch (err) {
      setEditError(err?.message ?? "Failed to save changes.");
    } finally {
      setEditSaving(false);
    }
  };

  // ── Member management ─────────────────────────────────────────────────────
  const openEditMember = (member) => {
    setEditMember(member);
    setEditMemberForm({ name: member.name ?? "", role: member.role ?? "user", status: member.status ?? "active" });
    setMemberError(null);
  };

  const handleEditMemberSubmit = async (e) => {
    e.preventDefault();
    setMemberSaving(true);
    setMemberError(null);
    try {
      const updated = await onUpdateMember(editMember.id, {
        name:   editMemberForm.name   || null,
        role:   editMemberForm.role   || null,
        status: editMemberForm.status || null,
      });
      setRealMembers(prev => prev.map(m => m.id === editMember.id ? {
        ...m,
        name:   updated?.name   ?? editMemberForm.name   ?? m.name,
        role:   updated?.role   ?? editMemberForm.role   ?? m.role,
        status: updated?.status ?? editMemberForm.status ?? m.status,
      } : m));
      setEditMember(null);
    } catch (err) {
      setMemberError(err?.message ?? "Failed to update member.");
    } finally {
      setMemberSaving(false);
    }
  };

  const handleConfirmRemove = async () => {
    if (!confirmRemove) return;
    setActionLoading("remove_" + confirmRemove.id);
    try {
      await onRemoveMember(confirmRemove.id);
      setRealMembers(prev => prev.filter(m => m.id !== confirmRemove.id));
      setConfirmRemove(null);
    } catch (err) {
      toast.error("Failed to remove member.");
    } finally {
      setActionLoading(null);
    }
  };

  // ── Member invite ─────────────────────────────────────────────────────────
  const handleAddMemberSubmit = async (e) => {
    e.preventDefault();
    setInviteLoading(true);
    setInviteError(null);
    setNewInviteUrl(null);
    try {
      const { data, error } = await supabase.rpc("create_member_invite_admin", {
        p_tenant_id: localOrg.id,
        p_email:     inviteForm.email.trim().toLowerCase(),
        p_role:      inviteForm.role,
      });
      if (error) throw error;
      const url = buildInviteUrl(data.token);
      setNewInviteUrl(url);
      setInviteEmailSent(null);
      setInviteEmailError(null);
      // Await email — surface delivery status to admin
      try {
        await sendInviteEmail({ to: inviteForm.email.trim().toLowerCase(), orgName: localOrg.name, inviteUrl: url, type: "member", role: inviteForm.role });
        setInviteEmailSent(true);
      } catch (emailErr) {
        console.warn("[ralli] Member invite email failed:", emailErr.message);
        setInviteEmailSent(false);
        setInviteEmailError(emailErr.message ?? "Email delivery failed.");
      }
      setInviteForm({ email: "", role: "user" });
      await refreshData(); // reload invitations list
    } catch (err) {
      setInviteError(err?.message ?? "Failed to create invite.");
    } finally {
      setInviteLoading(false);
    }
  };

  // ── Invite actions ────────────────────────────────────────────────────────
  const handleCancelMemberInvite = async (invId) => {
    setActionLoading("cancel_" + invId);
    try {
      await onCancelInvite(invId);
      setInvitations(prev => prev.map(i => i.id === invId ? { ...i, status: "canceled" } : i));
    } catch (err) {
      toast.error("Failed to cancel invite.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleResendMemberInviteLocal = async (inv) => {
    setActionLoading("resend_" + inv.id);
    try {
      const data = await onResendMemberInvite(inv.id);
      const freshToken = data?.token ?? inv.token;
      setInvitations(prev => prev.map(i => i.id === inv.id ? { ...i, status: "pending", token: freshToken } : i));
      try {
        await sendInviteEmail({ to: inv.email, orgName: localOrg.name, inviteUrl: buildInviteUrl(freshToken), type: "member", role: inv.role });
        toast.success(`Invitation sent to ${inv.email}.`);
      } catch (emailErr) {
        console.warn("[ralli] Resend invite email failed:", emailErr.message);
        toast.warning("Invitation created, but the email could not be delivered. Copy the link below and send it manually.");
      }
    } catch (err) {
      toast.error("Failed to resend invite.");
    } finally {
      setActionLoading(null);
    }
  };

  const members = realMembers ?? orgUsers.filter(u => u.orgId === localOrg.id);
  const statusColor = {
    active:        C.green,
    "live-active": C.green,
    "live-trial":  C.green,
    invited:       C.blue,
    "invite sent": C.blue,
    onboarding:    C.purple,
    suspended:     "#ef4444",
    canceled:      C.textMuted,
    deleted:       C.textMuted,
    inactive:      C.textMuted,
  };
  const ROLE_LABELS = { user: "Rep", manager: "Manager", orgAdmin: "Org Admin", ralli_admin: "Ralli Admin" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button onClick={onBack} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>← Back</button>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>{localOrg.name}</h1>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: C.textSub }}>
            {localOrg.plan} · {members.length}/{localOrg.seatLimit ?? localOrg.seats ?? "—"} seats ·{" "}
            <span style={{ fontWeight: 700, color: statusColor[localOrg.status] ?? C.textSub }}>{localOrg.status}</span>
            {localOrg.domain ? ` · ${localOrg.domain}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={openEdit} disabled={!!actionLoading} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            Edit
          </button>

          {/* Reactivate: for suspended or canceled orgs */}
          {["suspended","canceled"].includes(localOrg.status) ? (
            <button onClick={handleReactivate} disabled={!!actionLoading} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.green}`, background: C.green + "15", color: C.green, fontSize: 12, fontWeight: 700, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.6 : 1 }}>
              {actionLoading === "reactivate" ? "…" : "Reactivate"}
            </button>
          ) : (
            /* Suspend: for active / onboarding / invited */
            <button onClick={handleSuspend} disabled={!!actionLoading} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSub, fontSize: 12, fontWeight: 600, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.6 : 1 }}>
              {actionLoading === "suspend" ? "…" : "Suspend"}
            </button>
          )}

          {/* Cancel: only when org is not already canceled */}
          {!["canceled","deleted"].includes(localOrg.status) && (
            <button onClick={() => setConfirmCancel(true)} disabled={!!actionLoading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #fbbf24", background: "#fffbeb", color: "#b45309", fontSize: 12, fontWeight: 700, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.6 : 1 }}>
              Cancel Org
            </button>
          )}

          <button onClick={() => setConfirmDelete(true)} disabled={!!actionLoading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #fca5a5", background: "#fef2f2", color: "#ef4444", fontSize: 12, fontWeight: 700, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.6 : 1 }}>
            Delete Org
          </button>
        </div>
      </div>

      {/* Edit org panel */}
      {showEdit && (
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Edit Organization</div>
            <button onClick={() => setShowEdit(false)} style={{ background: "none", border: "none", fontSize: 18, color: C.textSub, cursor: "pointer", lineHeight: 1 }}>✕</button>
          </div>
          <form onSubmit={handleEditSubmit}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              {[
                { label: "NAME", key: "name", type: "text" },
                { label: "ADMIN EMAIL", key: "adminEmail", type: "email" },
                { label: "DOMAIN", key: "domain", type: "text" },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 5 }}>{f.label}</label>
                  <input
                    type={f.type} value={editForm[f.key] ?? ""}
                    onChange={e => setEditForm(p => ({ ...p, [f.key]: e.target.value }))}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.inputBg, outline: "none", boxSizing: "border-box" }}
                  />
                </div>
              ))}
              <div>
                <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 5 }}>PLAN</label>
                <select value={editForm.plan ?? "Starter"} onChange={e => setEditForm(p => ({ ...p, plan: e.target.value }))} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.inputBg, outline: "none" }}>
                  {["Starter","Growth","Enterprise"].map(p => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 5 }}>SEATS</label>
                <input type="number" min="1" value={editForm.seats ?? 10} onChange={e => setEditForm(p => ({ ...p, seats: e.target.value }))} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.inputBg, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 5 }}>STATUS</label>
                <select value={editForm.status ?? "active"} onChange={e => setEditForm(p => ({ ...p, status: e.target.value }))} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.inputBg, outline: "none" }}>
                  {["invited","onboarding","active","suspended","canceled"].map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
            {editError && <div style={{ padding: "8px 12px", borderRadius: 8, background: "#fef2f2", color: "#ef4444", fontSize: 12, marginBottom: 12 }}>{editError}</div>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setShowEdit(false)} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button type="submit" disabled={editSaving} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: editSaving ? "not-allowed" : "pointer", opacity: editSaving ? 0.7 : 1 }}>
                {editSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Org summary + Features ───────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 16 }}>

        {/* Summary card */}
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: "18px 20px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.textSub, letterSpacing: "0.05em", marginBottom: 12 }}>ORGANIZATION</div>
          {[
            { label: "Status",    value: <span style={{ color: localOrg.status === "active" ? C.green : localOrg.status === "suspended" ? "#ef4444" : C.textSub, fontWeight: 700, textTransform: "capitalize" }}>{localOrg.status}</span> },
            { label: "Plan",      value: <span style={{ fontWeight: 700, color: C.orange }}>{localOrg.plan}</span> },
            { label: "Seats",     value: `${members.length} used / ${localOrg.seatLimit ?? localOrg.seats ?? "—"} limit` },
            { label: "Admin",     value: localOrg.adminEmail ?? "—" },
            { label: "Domain",    value: localOrg.domain ?? "—" },
            { label: "Created",   value: localOrg.createdAt ?? "—" },
          ].map(({ label, value }) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 8, marginBottom: 8, borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 12, color: C.textSub }}>{label}</span>
              <span style={{ fontSize: 12, color: C.text }}>{value}</span>
            </div>
          ))}
        </div>

        {/* Feature access */}
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: "18px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textSub, letterSpacing: "0.05em" }}>FEATURE ACCESS</div>
            {featureSaving && <span style={{ fontSize: 11, color: C.textSub }}>Saving…</span>}
            {featureError && <span style={{ fontSize: 11, color: "#ef4444" }}>{featureError}</span>}
          </div>
          {tenantSettings === null ? (
            <div style={{ fontSize: 12, color: C.textSub }}>Loading…</div>
          ) : (
            [
              { key: "games",           label: "Games (ralli)" },
              { key: "learn",           label: "Learn & Quizzes" },
              { key: "battle_cards",    label: "Battle Cards" },
              { key: "analytics",       label: "Analytics" },
              { key: "integrations",    label: "Integrations" },
              { key: "custom_branding", label: "Custom Branding" },
            ].map(({ key, label }) => {
              const enabled = !!(tenantSettings.feature_access ?? {})[key];
              return (
                <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: C.text }}>{label}</span>
                  <button
                    disabled={featureSaving}
                    onClick={() => handleFeatureToggle(key, !enabled)}
                    style={{
                      width: 40, height: 22, borderRadius: 11, border: "none", cursor: featureSaving ? "not-allowed" : "pointer",
                      background: enabled ? C.orange : C.border, position: "relative", transition: "background 0.15s",
                    }}
                  >
                    <span style={{
                      position: "absolute", top: 3, left: enabled ? 20 : 3, width: 16, height: 16,
                      borderRadius: "50%", background: "#fff", transition: "left 0.15s",
                    }} />
                  </button>
                </div>
              );
            })
          )}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.textSub }}>
            Plan defaults: {localOrg.plan}. Toggle overrides plan defaults per feature.
          </div>
        </div>
      </div>

      {/* Admin invite banner */}
      {adminInvite && (
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Admin Invite Link</div>
              <div style={{ fontSize: 11, color: C.textSub, marginTop: 1 }}>
                Sent to <strong>{adminInvite.email}</strong> · Status:{" "}
                <span style={{ color: adminInvite.status === "accepted" ? C.green : C.orange, fontWeight: 700 }}>{adminInvite.status}</span>
              </div>
            </div>
            {adminInvite.status !== "accepted" && (
              <button
                onClick={handleResendAdminEmail}
                disabled={resendStatus === "sending"}
                style={{
                  padding: "7px 14px", borderRadius: 8, border: `1px solid ${C.border}`,
                  background: resendStatus === "sent" ? C.green : C.white,
                  color: resendStatus === "sent" ? "#fff" : C.text,
                  fontSize: 12, fontWeight: 700, cursor: resendStatus === "sending" ? "not-allowed" : "pointer",
                  opacity: resendStatus === "sending" ? 0.6 : 1, whiteSpace: "nowrap",
                }}
              >
                {resendStatus === "sending" ? "Sending…" : resendStatus === "sent" ? "✓ Sent" : resendStatus === "error" ? "⚠ Retry" : "Resend Email"}
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input readOnly value={buildInviteUrl(adminInvite.token)} onClick={e => e.target.select()}
              style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 11, color: C.textSub, background: C.pageBg, outline: "none" }}
            />
            <button onClick={() => navigator.clipboard.writeText(buildInviteUrl(adminInvite.token))}
              style={{ padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700 }}>
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Members */}
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Members {realMembers === null ? "" : `(${members.length})`}</div>
          <button onClick={() => { setShowInviteForm(p => !p); setNewInviteUrl(null); setInviteError(null); setInviteForm({ email: "", role: "user" }); }}
            style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            + Invite Member
          </button>
        </div>

        {/* Inline invite form */}
        {showInviteForm && (
          <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, background: C.pageBg }}>
            {newInviteUrl ? (
              <div>
                {inviteEmailSent === false ? (
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#92400E", marginBottom: 4 }}>⚠ Invitation created, but the email could not be delivered. Copy the link below and send it manually.</div>
                ) : (
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.green, marginBottom: 4 }}>✓ Invitation sent</div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, marginTop: 8 }}>
                  <input readOnly value={newInviteUrl} onClick={e => e.target.select()}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 11, color: C.textSub, background: C.white, outline: "none" }}
                  />
                  <button onClick={() => navigator.clipboard.writeText(newInviteUrl)}
                    style={{ padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700 }}>
                    Copy
                  </button>
                </div>
                <button onClick={() => { setNewInviteUrl(null); setInviteEmailSent(null); setInviteEmailError(null); setShowInviteForm(false); }}
                  style={{ fontSize: 12, color: C.textSub, background: "none", border: "none", cursor: "pointer", padding: 0 }}>Done</button>
              </div>
            ) : (
              <form onSubmit={handleAddMemberSubmit} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                <div style={{ flex: 2 }}>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 4 }}>EMAIL</label>
                  <input type="email" required value={inviteForm.email} onChange={e => setInviteForm(p => ({ ...p, email: e.target.value }))} placeholder="rep@company.com"
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.white, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 4 }}>ROLE</label>
                  <select value={inviteForm.role} onChange={e => setInviteForm(p => ({ ...p, role: e.target.value }))}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.white, outline: "none" }}>
                    <option value="user">Rep</option>
                    <option value="manager">Manager</option>
                    <option value="orgAdmin">Org Admin</option>
                  </select>
                </div>
                <button type="submit" disabled={inviteLoading}
                  style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: inviteLoading ? "not-allowed" : "pointer", opacity: inviteLoading ? 0.7 : 1, whiteSpace: "nowrap" }}>
                  {inviteLoading ? "Sending…" : "Send Invite"}
                </button>
                <button type="button" onClick={() => setShowInviteForm(false)}
                  style={{ padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSub, fontSize: 13, cursor: "pointer" }}>✕</button>
              </form>
            )}
            {inviteError && <div style={{ marginTop: 8, fontSize: 12, color: "#ef4444" }}>{inviteError}</div>}
          </div>
        )}

        {/* Column headers */}
        {realMembers !== null && members.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 20px", background: C.pageBg, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ width: 36, flexShrink: 0 }} />
            <div style={{ flex: 1, fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.05em" }}>MEMBER</div>
            <div style={{ minWidth: 80, fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.05em", textAlign: "right" }}>TEAM</div>
            <div style={{ minWidth: 68, fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.05em" }}>JOINED</div>
            <div style={{ width: 60, fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.05em" }}>ROLE</div>
            <div style={{ width: 60, fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.05em" }}>STATUS</div>
            <div style={{ width: 110 }} />
          </div>
        )}

        {/* Members list */}
        {realMembers === null ? (
          <div style={{ padding: 32, textAlign: "center", color: C.textSub, fontSize: 13 }}>Loading members…</div>
        ) : members.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: C.textSub, fontSize: 13 }}>No active members yet.</div>
        ) : <div style={{ overflowX: mobile ? "auto" : "visible", WebkitOverflowScrolling: "touch" }}>{members.map((m, i) => {
          const initials = (m.name || m.email || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
          const isEditingThis = editMember?.id === m.id;
          return (
            <div key={m.id} style={{ borderBottom: i < members.length - 1 ? `1px solid ${C.border}` : "none" }}>
              {isEditingThis ? (
                <form onSubmit={handleEditMemberSubmit} style={{ padding: "14px 20px", display: "flex", gap: 10, alignItems: "flex-end", flexWrap: mobile ? "wrap" : "nowrap", background: C.pageBg }}>
                  <div style={{ flex: 2, flexBasis: mobile ? "100%" : "auto" }}>
                    <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 4 }}>NAME</label>
                    <input value={editMemberForm.name} onChange={e => setEditMemberForm(p => ({ ...p, name: e.target.value }))}
                      style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.white, outline: "none", boxSizing: "border-box" }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 4 }}>ROLE</label>
                    <select value={editMemberForm.role} onChange={e => setEditMemberForm(p => ({ ...p, role: e.target.value }))}
                      style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.white, outline: "none" }}>
                      <option value="user">Rep</option>
                      <option value="manager">Manager</option>
                      <option value="orgAdmin">Org Admin</option>
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.textSub, letterSpacing: "0.06em", marginBottom: 4 }}>STATUS</label>
                    <select value={editMemberForm.status} onChange={e => setEditMemberForm(p => ({ ...p, status: e.target.value }))}
                      style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.white, outline: "none" }}>
                      <option value="active">Active</option>
                      <option value="suspended">Suspended</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                  <button type="submit" disabled={memberSaving}
                    style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    {memberSaving ? "Saving…" : "Save"}
                  </button>
                  <button type="button" onClick={() => setEditMember(null)}
                    style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSub, fontSize: 12, cursor: "pointer" }}>Cancel</button>
                  {memberError && <div style={{ fontSize: 11, color: "#ef4444" }}>{memberError}</div>}
                </form>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 20px", minWidth: 540 }}>
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: m.color ?? C.orange, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#fff", flexShrink: 0 }}>{initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{m.name || "—"}</div>
                    <div style={{ fontSize: 11, color: C.textSub }}>{m.email}</div>
                  </div>
                  {/* Team */}
                  <span style={{ fontSize: 11, color: C.textSub, minWidth: 80, textAlign: "right" }}>
                    {tenantTeams.find(t => t.id === m.team_id)?.name ?? <span style={{ color: C.border }}>No team</span>}
                  </span>
                  {/* Created */}
                  <span style={{ fontSize: 11, color: C.textSub, minWidth: 68 }}>
                    {m.created_at ? new Date(m.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : "—"}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: C.orange + "18", color: C.orange }}>{ROLE_LABELS[m.role] ?? m.role}</span>
                  <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: m.status === "active" ? C.green + "15" : C.muted, color: m.status === "active" ? C.green : C.textSub, fontWeight: 600 }}>{m.status}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => openEditMember(m)}
                      style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Edit</button>
                    <button onClick={() => setConfirmRemove(m)}
                      style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #fca5a5", background: "#fef2f2", color: "#ef4444", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Remove</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}</div>}
      </div>

      {/* Pending member invites */}
      {memberInvites.length > 0 && (
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Pending Invitations ({memberInvites.length})</div>
          </div>
          {memberInvites.map((inv, i) => {
            const isExpired = inv.expiresAt && new Date(inv.expiresAt) < new Date();
            const isCanceling = actionLoading === "cancel_" + inv.id;
            const isResending = actionLoading === "resend_" + inv.id;
            return (
              <div key={inv.id} style={{ display: "flex", alignItems: mobile ? "flex-start" : "center", flexWrap: mobile ? "wrap" : "nowrap", gap: 14, padding: "13px 20px", borderBottom: i < memberInvites.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{inv.email}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>
                    {ROLE_LABELS[inv.role] ?? inv.role} ·{" "}
                    {isExpired ? <span style={{ color: "#ef4444" }}>Expired</span> : `Expires ${new Date(inv.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: isExpired ? C.muted : C.orange + "18", color: isExpired ? C.textSub : C.orange }}>{isExpired ? "expired" : inv.status}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => { const url = buildInviteUrl(inv.token); navigator.clipboard.writeText(url); }}
                    style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Copy Link</button>
                  <button
                    onClick={() => handleResendMemberInviteLocal(inv)}
                    disabled={!!actionLoading}
                    style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 11, fontWeight: 600, cursor: actionLoading ? "not-allowed" : "pointer", opacity: isResending ? 0.6 : 1 }}>
                    {isResending ? "…" : "Resend"}
                  </button>
                  <button
                    onClick={() => handleCancelMemberInvite(inv.id)}
                    disabled={!!actionLoading}
                    style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #fca5a5", background: "#fef2f2", color: "#ef4444", fontSize: 11, fontWeight: 600, cursor: actionLoading ? "not-allowed" : "pointer", opacity: isCanceling ? 0.6 : 1 }}>
                    {isCanceling ? "…" : "Cancel"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Invite history (accepted + canceled) */}
      {memberInviteHistory.length > 0 && (
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Invite History ({memberInviteHistory.length})</div>
          </div>
          {memberInviteHistory.map((inv, i) => {
            const statusColor = inv.status === "accepted" ? C.green : C.textMuted;
            return (
              <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", borderBottom: i < memberInviteHistory.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{inv.email}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>
                    {ROLE_LABELS[inv.role] ?? inv.role}
                    {inv.acceptedAt ? ` · Accepted ${new Date(inv.acceptedAt).toLocaleDateString()}` : ""}
                    {inv.createdAt ? ` · Invited ${new Date(inv.createdAt).toLocaleDateString()}` : ""}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: statusColor + "18", color: statusColor }}>
                  {inv.status}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Remove member confirmation modal */}
      {confirmRemove && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmRemove(null); }}>
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: "min(400px, calc(100vw - 32px))", boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>⚠️</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: C.text, textAlign: "center" }}>Remove {confirmRemove.name}?</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textSub, textAlign: "center", lineHeight: 1.6 }}>
              This removes them from the organization. Their account is preserved — they can be re-invited later.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmRemove(null)} style={{ flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
              <button onClick={handleConfirmRemove} disabled={!!actionLoading} style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: "#ef4444", color: "#fff", fontSize: 13, fontWeight: 700, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.7 : 1 }}>
                {actionLoading ? "Removing…" : "Yes, remove"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete org confirmation modal */}
      {confirmDelete && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmDelete(false); }}>
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: "min(400px, calc(100vw - 32px))", boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>⚠️</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: C.text, textAlign: "center" }}>Delete {localOrg.name}?</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textSub, textAlign: "center", lineHeight: 1.6 }}>
              Permanently removes the organization and all its data. Existing users will be unlinked. This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Keep</button>
              <button onClick={handleDelete} disabled={actionLoading === "delete"} style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: "#ef4444", color: "#fff", fontSize: 13, fontWeight: 700, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.7 : 1 }}>
                {actionLoading === "delete" ? "Deleting…" : "Yes, delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel org confirmation modal */}
      {confirmCancel && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmCancel(false); }}>
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: "min(400px, calc(100vw - 32px))", boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>⛔</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: C.text, textAlign: "center" }}>Cancel {localOrg.name}?</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textSub, textAlign: "center", lineHeight: 1.6 }}>
              Marks this organization as <strong>canceled</strong>. Members lose access immediately. The org can be reactivated later.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmCancel(false)} style={{ flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Keep Active</button>
              <button onClick={handleCancel} disabled={actionLoading === "cancel"} style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: "#b45309", color: "#fff", fontSize: 13, fontWeight: 700, cursor: actionLoading ? "not-allowed" : "pointer", opacity: actionLoading ? 0.7 : 1 }}>
                {actionLoading === "cancel" ? "Canceling…" : "Yes, cancel org"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TEAM SCREEN (org admin manages their users) ────────────
function TeamScreen({ orgId, orgName, orgUsers, onAddUser, onMemberInvited }) {
  const [localMembers, setLocalMembers] = useState(null); // null = loading

  useEffect(() => {
    if (!orgId) return;
    supabase
      .from("profiles")
      .select("id, name, email, role, color, status, team_id")
      .eq("tenant_id", orgId)
      .then(({ data }) => {
        if (!data) { setLocalMembers([]); return; }
        setLocalMembers(data.map(m => ({
          id: m.id,
          email: m.email,
          name: m.name ?? m.email?.split("@")[0] ?? "User",
          initials: (m.name ?? m.email ?? "U").split(" ").map(p => p[0] ?? "").join("").toUpperCase().slice(0, 2) || "U",
          role: m.role ?? "user",
          color: m.color ?? "#F97316",
          status: m.status ?? "active",
          _isReal: true,
        })));
      });
  }, [orgId]); // eslint-disable-line

  const members = localMembers !== null ? localMembers : orgUsers.filter(u => u.orgId === orgId);

  const toast = useToast();

  // ── Invite modal state ─────────────────────────────────────────────────────
  const [showAdd, setShowAdd]     = useState(false);
  const [form, setForm]           = useState({ email: "", role: "user", teamId: "" });
  const [submitted, setSubmitted] = useState(false);
  const [inviteUrl, setInviteUrl] = useState(null);
  const [emailSent,  setEmailSent]  = useState(null); // true | false | null
  const [emailError, setEmailError] = useState(null); // string | null
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError]     = useState(null);

  // ── Invitation list ────────────────────────────────────────────────────────
  const [invitations, setInvitations]           = useState(null); // null = loading
  const [invActionLoading, setInvActionLoading] = useState(null);
  const [showHistory, setShowHistory]           = useState(false);

  // ── Teams state ────────────────────────────────────────────────────────────
  const [teams, setTeams]               = useState(null);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [teamName, setTeamName]         = useState("");
  const [teamSaving, setTeamSaving]     = useState(false);
  const [teamError, setTeamError]       = useState(null);
  const [editTeam, setEditTeam]         = useState(null);
  const [editTeamName, setEditTeamName] = useState("");
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState(null);

  // ── Team detail state ──────────────────────────────────────────────────────
  const [selectedTeam, setSelectedTeam]       = useState(null); // team row object
  const [teamMembers, setTeamMembers]         = useState(null); // null = loading
  const [allTenantMembers, setAllTenantMembers] = useState([]); // full tenant profiles
  const [addMemberId, setAddMemberId]         = useState("");   // selected profile id to add
  const [memberAssigning, setMemberAssigning] = useState(false);
  const [memberRemoving, setMemberRemoving]   = useState(null);  // profile id being removed

  const loadTeams = async () => {
    if (!orgId) return;
    const { data } = await supabase.from("tenant_teams").select("*").eq("tenant_id", orgId).order("created_at");
    setTeams(data ?? []);
  };

  useEffect(() => { loadTeams(); }, [orgId]); // eslint-disable-line

  // Load team members + all tenant profiles when a team is selected
  const openTeamDetail = async (team) => {
    setSelectedTeam(team);
    setTeamMembers(null);
    setAddMemberId("");

    const [{ data: inTeam }, { data: all }] = await Promise.all([
      supabase.from("profiles").select("id, name, email, role, color, team_id").eq("team_id", team.id),
      supabase.from("profiles").select("id, name, email, role, color, team_id").eq("tenant_id", orgId),
    ]);
    setTeamMembers(inTeam ?? []);
    setAllTenantMembers(all ?? []);
  };

  const handleAssignMember = async () => {
    if (!addMemberId || !selectedTeam) return;
    setMemberAssigning(true);
    try {
      await supabase.rpc("assign_member_team", { p_user_id: addMemberId, p_team_id: selectedTeam.id });
      // Refresh
      const { data } = await supabase.from("profiles").select("id, name, email, role, color, team_id").eq("team_id", selectedTeam.id);
      setTeamMembers(data ?? []);
      const { data: all } = await supabase.from("profiles").select("id, name, email, role, color, team_id").eq("tenant_id", orgId);
      setAllTenantMembers(all ?? []);
      setAddMemberId("");
    } catch (err) {
      toast.error("Failed to add member to team.");
    } finally { setMemberAssigning(false); }
  };

  const handleRemoveMember = async (profileId) => {
    setMemberRemoving(profileId);
    try {
      await supabase.rpc("assign_member_team", { p_user_id: profileId, p_team_id: null });
      setTeamMembers(prev => (prev ?? []).filter(m => m.id !== profileId));
      const { data: all } = await supabase.from("profiles").select("id, name, email, role, color, team_id").eq("tenant_id", orgId);
      setAllTenantMembers(all ?? []);
    } catch (err) {
      toast.error("Failed to remove member from team.");
    } finally { setMemberRemoving(null); }
  };

  const handleCreateTeam = async (e) => {
    e.preventDefault();
    const name = teamName.trim();
    if (!name) { setTeamError("Team name is required."); return; }
    setTeamSaving(true); setTeamError(null);
    try {
      const { error } = await supabase.from("tenant_teams").insert({ tenant_id: orgId, name });
      if (error) throw error;
      setTeamName(""); setShowCreateTeam(false);
      await loadTeams();
    } catch (err) {
      setTeamError(err.message ?? "Failed to create team.");
    } finally { setTeamSaving(false); }
  };

  const handleUpdateTeam = async (e) => {
    e.preventDefault();
    const name = editTeamName.trim();
    if (!name || !editTeam) return;
    setTeamSaving(true);
    try {
      const { error } = await supabase.from("tenant_teams").update({ name }).eq("id", editTeam.id);
      if (error) throw error;
      setEditTeam(null); setEditTeamName("");
      await loadTeams();
      // Keep selectedTeam name in sync if we're in detail view
      if (selectedTeam?.id === editTeam.id) setSelectedTeam(t => ({ ...t, name }));
    } catch (err) {
      toast.error("Failed to update team.");
    } finally { setTeamSaving(false); }
  };

  const handleDeleteTeam = (team) => { setConfirmDeleteTeam(team); };

  const executeDeleteTeam = async () => {
    if (!confirmDeleteTeam) return;
    const team = confirmDeleteTeam;
    setConfirmDeleteTeam(null);
    try {
      const { error } = await supabase.from("tenant_teams").delete().eq("id", team.id);
      if (error) throw error;
      if (selectedTeam?.id === team.id) setSelectedTeam(null);
      await loadTeams();
    } catch (err) {
      toast.error("Failed to delete team.");
    }
  };

  const refreshInvitations = async () => {
    try {
      const { data, error } = await supabase.rpc("get_my_tenant_invitations");
      if (error) throw error;
      const arr = Array.isArray(data) ? data : (typeof data === "string" ? JSON.parse(data) : data ?? []);
      setInvitations(arr);
    } catch (err) {
      console.error("[TeamScreen] load invitations failed:", err);
      setInvitations([]);
    }
  };

  useEffect(() => { if (orgId) refreshInvitations(); }, [orgId]); // eslint-disable-line

  const resetModal = () => {
    setShowAdd(false); setSubmitted(false); setInviteUrl(null);
    setInviteError(null); setEmailSent(null); setEmailError(null);
    setForm({ email: "", role: "user", teamId: "" });
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    setInviteLoading(true);
    setInviteError(null);
    try {
      const result = await createMemberInvite(form.email.trim(), form.role, form.teamId || null);
      setInviteUrl(result.inviteUrl);
      setEmailSent(null);
      setEmailError(null);
      onMemberInvited?.();
      refreshInvitations();
      // Await email — surface delivery status in modal
      try {
        await sendInviteEmail({ to: form.email.trim(), orgName, inviteUrl: result.inviteUrl, type: "member", role: form.role });
        setEmailSent(true);
      } catch (emailErr) {
        console.warn("[ralli] Member invite email failed:", emailErr.message);
        setEmailSent(false);
        setEmailError(emailErr.message ?? "Email delivery failed.");
      }
      setSubmitted(true);
    } catch (err) {
      setInviteError(err?.message ?? "Failed to create invite. Try again.");
    } finally {
      setInviteLoading(false);
    }
  };

  const handleCancelInvite = async (invId) => {
    setInvActionLoading("cancel_" + invId);
    try {
      await supabase.rpc("cancel_member_invite", { p_invitation_id: invId });
      setInvitations(prev => prev.map(i => i.id === invId ? { ...i, status: "canceled" } : i));
    } catch (err) {
      toast.error("Failed to cancel invite.");
    } finally {
      setInvActionLoading(null);
    }
  };

  const handleResendInvite = async (inv) => {
    setInvActionLoading("resend_" + inv.id);
    try {
      const { data, error } = await supabase.rpc("resend_member_invite", { p_invitation_id: inv.id });
      if (error) throw error;
      const freshToken = data?.token ?? inv.token;
      setInvitations(prev => prev.map(i => i.id === inv.id ? { ...i, status: "pending", token: freshToken } : i));
      try {
        await sendInviteEmail({ to: inv.email, orgName, inviteUrl: buildInviteUrl(freshToken), type: "member", role: inv.role });
        toast.success(`Invitation sent to ${inv.email}.`);
      } catch (emailErr) {
        console.warn("[ralli] Resend invite email failed:", emailErr.message);
        toast.warning("Invitation created, but the email could not be delivered. Copy the link below and send it manually.");
      }
    } catch (err) {
      toast.error("Failed to resend invite.");
    } finally {
      setInvActionLoading(null);
    }
  };

  const pendingInvites = (invitations ?? []).filter(i => !["accepted","canceled"].includes(i.status));
  const historyInvites = (invitations ?? []).filter(i =>  ["accepted","canceled"].includes(i.status));

  const ROLE_COLORS = { user: C.orange, orgAdmin: C.green, superadmin: C.purple };
  const ROLE_LABELS = { user: "Rep", orgAdmin: "Manager", superadmin: "Super Admin" };
  const STATUS_COLORS = { active: "#22c55e", inactive: C.textMuted, invited: C.orange };
  const STATUS_LABELS = { active: "Active", inactive: "Inactive", invited: "Invited" };

  // ── Team detail view ────────────────────────────────────────────────────────
  if (selectedTeam) {
    const unassigned = allTenantMembers.filter(m => !m.team_id || m.team_id !== selectedTeam.id);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setSelectedTeam(null)}
            style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            ← Back
          </button>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>{selectedTeam.name}</h2>
            {selectedTeam.is_default && <div style={{ fontSize: 12, color: C.textSub }}>Default team</div>}
          </div>
        </div>

        {/* Members in this team */}
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
              Members {teamMembers !== null ? `(${teamMembers.length})` : ""}
            </div>
          </div>

          {/* Add member to team */}
          {unassigned.length > 0 && (
            <div style={{ padding: "12px 20px", borderBottom: `1px solid ${C.border}`, background: C.pageBg, display: "flex", gap: 8, alignItems: "center" }}>
              <select value={addMemberId} onChange={e => setAddMemberId(e.target.value)}
                style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.white, outline: "none" }}>
                <option value="">Select a member to add…</option>
                {unassigned.map(m => (
                  <option key={m.id} value={m.id}>{m.name} ({ROLE_LABELS[m.role] ?? m.role})</option>
                ))}
              </select>
              <button onClick={handleAssignMember} disabled={!addMemberId || memberAssigning}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700, cursor: !addMemberId || memberAssigning ? "not-allowed" : "pointer", opacity: !addMemberId || memberAssigning ? 0.6 : 1, whiteSpace: "nowrap" }}>
                {memberAssigning ? "Adding…" : "Add to Team"}
              </button>
            </div>
          )}

          {teamMembers === null && (
            <div style={{ padding: 24, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>
          )}
          {teamMembers !== null && teamMembers.length === 0 && (
            <div style={{ padding: "32px 20px", textAlign: "center", color: C.textMuted, fontSize: 13 }}>
              No members in this team yet.{unassigned.length > 0 ? " Use the selector above to add someone." : ""}
            </div>
          )}
          {(teamMembers ?? []).map((m, i) => {
            const initials = m.name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() ?? "?";
            const isRemoving = memberRemoving === m.id;
            return (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 20px", borderBottom: i < teamMembers.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: m.color ?? C.orange, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#fff", flexShrink: 0 }}>{initials}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{m.name}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>{m.email}</div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: (ROLE_COLORS[m.role] ?? C.textMuted) + "18", color: ROLE_COLORS[m.role] ?? C.textMuted }}>
                  {ROLE_LABELS[m.role] ?? m.role}
                </span>
                <button onClick={() => handleRemoveMember(m.id)} disabled={isRemoving}
                  style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #fca5a5", background: "#fef2f2", color: "#ef4444", fontSize: 11, fontWeight: 600, cursor: isRemoving ? "not-allowed" : "pointer", opacity: isRemoving ? 0.6 : 1 }}>
                  {isRemoving ? "…" : "Remove"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Team list view (default) ────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>Team · {orgName}</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>
            {localMembers === null ? "Loading…" : `${members.length} member${members.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          style={{ padding: "10px 18px", borderRadius: 10, border: "none", cursor: "pointer", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700 }}
        >
          + Invite Member
        </button>
      </div>

      {/* Teams */}
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: (teams?.length || showCreateTeam) ? `1px solid ${C.border}` : "none" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
            Teams {teams === null ? "" : `(${teams.length})`}
          </div>
          <button onClick={() => { setShowCreateTeam(p => !p); setTeamName(""); setTeamError(null); }}
            style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: showCreateTeam ? C.border : C.orange, color: showCreateTeam ? C.text : "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            {showCreateTeam ? "Cancel" : "+ New Team"}
          </button>
        </div>

        {showCreateTeam && (
          <form onSubmit={handleCreateTeam} style={{ padding: "12px 20px", borderBottom: `1px solid ${C.border}`, background: C.pageBg, display: "flex", gap: 8, alignItems: "flex-start", flexDirection: "column" }}>
            <div style={{ display: "flex", gap: 8, width: "100%" }}>
              <input autoFocus value={teamName} onChange={e => setTeamName(e.target.value)}
                placeholder="e.g. SDR, AE, US SDR, APAC AE"
                style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${teamError ? "#ef4444" : C.border}`, fontSize: 13, outline: "none", color: C.text }} />
              <button type="submit" disabled={teamSaving}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700, cursor: teamSaving ? "not-allowed" : "pointer", opacity: teamSaving ? 0.7 : 1, whiteSpace: "nowrap" }}>
                {teamSaving ? "Creating…" : "Create"}
              </button>
            </div>
            {teamError && <div style={{ fontSize: 11, color: "#ef4444" }}>{teamError}</div>}
          </form>
        )}

        {teams === null && <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>}
        {teams !== null && teams.length === 0 && !showCreateTeam && (
          <div style={{ padding: "24px 20px", textAlign: "center", color: C.textMuted, fontSize: 13 }}>
            No teams yet. Create one to organize your members.
          </div>
        )}

        {(teams ?? []).map((team, i) => (
          <div key={team.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: i < (teams.length - 1) ? `1px solid ${C.border}` : "none" }}>
            {editTeam?.id === team.id ? (
              <form onSubmit={handleUpdateTeam} style={{ flex: 1, display: "flex", gap: 8 }}>
                <input autoFocus value={editTeamName} onChange={e => setEditTeamName(e.target.value)}
                  style={{ flex: 1, padding: "6px 10px", borderRadius: 7, border: `1.5px solid ${C.orange}`, fontSize: 13, outline: "none", color: C.text }} />
                <button type="submit" disabled={teamSaving}
                  style={{ padding: "6px 12px", borderRadius: 7, border: "none", background: C.orange, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  {teamSaving ? "…" : "Save"}
                </button>
                <button type="button" onClick={() => setEditTeam(null)}
                  style={{ padding: "6px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                {/* Clickable team name — opens detail view */}
                <button onClick={() => openTeamDetail(team)}
                  style={{ flex: 1, background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{team.name}</div>
                  {team.is_default && <div style={{ fontSize: 11, color: C.textMuted }}>Default team · click to manage members</div>}
                  {!team.is_default && <div style={{ fontSize: 11, color: C.textSub }}>Click to manage members</div>}
                </button>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { setEditTeam(team); setEditTeamName(team.name); }}
                    style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                    Edit
                  </button>
                  {!team.is_default && (
                    <button onClick={() => handleDeleteTeam(team)}
                      style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #fca5a5", background: "#fef2f2", color: "#ef4444", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                      Delete
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Members list */}
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", borderBottom: members.length ? `1px solid ${C.border}` : "none" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Members</div>
        </div>
        {localMembers === null && (
          <div style={{ padding: 24, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>
        )}
        {localMembers !== null && members.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: C.textMuted, fontSize: 14 }}>No members yet. Invite your first rep.</div>
        )}
        {members.map((u, i) => (
          <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px", borderBottom: i < members.length - 1 ? `1px solid ${C.border}` : "none" }}>
            <div style={{ width: 38, height: 38, borderRadius: "50%", background: u.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#fff", flexShrink: 0 }}>{u.initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{u.name}</div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 1 }}>{u.email}</div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: (ROLE_COLORS[u.role] ?? C.textMuted) + "18", color: ROLE_COLORS[u.role] ?? C.textMuted }}>
              {ROLE_LABELS[u.role] ?? u.role}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: (STATUS_COLORS[u.status] ?? C.textMuted) + "18", color: STATUS_COLORS[u.status] ?? C.textMuted }}>
              {STATUS_LABELS[u.status] ?? u.status}
            </span>
          </div>
        ))}
      </div>

      {/* Pending invitations */}
      {pendingInvites.length > 0 && (
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Pending Invitations ({pendingInvites.length})</div>
          </div>
          {pendingInvites.map((inv, i) => {
            const isExpired = inv.expiresAt && new Date(inv.expiresAt) < new Date();
            const url = buildInviteUrl(inv.token);
            const isCanceling = invActionLoading === "cancel_" + inv.id;
            const isResending = invActionLoading === "resend_" + inv.id;
            const teamName_ = inv.team_id ? (teams ?? []).find(t => t.id === inv.team_id)?.name : null;
            return (
              <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 20px", borderBottom: i < pendingInvites.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{inv.email}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>
                    {ROLE_LABELS[inv.role] ?? inv.role}
                    {teamName_ ? ` · ${teamName_}` : ""}
                    {" ·"}{" "}
                    {isExpired
                      ? <span style={{ color: "#ef4444" }}>Expired</span>
                      : inv.expiresAt ? `Expires ${new Date(inv.expiresAt).toLocaleDateString()}` : "No expiry"}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: isExpired ? C.muted : C.orange + "18", color: isExpired ? C.textSub : C.orange }}>
                  {isExpired ? "expired" : inv.status}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => navigator.clipboard.writeText(url)}
                    style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                    Copy Link
                  </button>
                  <button onClick={() => handleResendInvite(inv)} disabled={!!invActionLoading}
                    style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 11, fontWeight: 600, cursor: invActionLoading ? "not-allowed" : "pointer", opacity: isResending ? 0.6 : 1 }}>
                    {isResending ? "…" : "Resend"}
                  </button>
                  <button onClick={() => handleCancelInvite(inv.id)} disabled={!!invActionLoading}
                    style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #fca5a5", background: "#fef2f2", color: "#ef4444", fontSize: 11, fontWeight: 600, cursor: invActionLoading ? "not-allowed" : "pointer", opacity: isCanceling ? 0.6 : 1 }}>
                    {isCanceling ? "…" : "Cancel"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Invite history */}
      {historyInvites.length > 0 && (
        <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
          <button onClick={() => setShowHistory(p => !p)}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Invite History ({historyInvites.length})</div>
            <span style={{ fontSize: 12, color: C.textSub }}>{showHistory ? "▲ Hide" : "▼ Show"}</span>
          </button>
          {showHistory && historyInvites.map((inv, i) => {
            const statusColor = inv.status === "accepted" ? C.green : C.textMuted;
            return (
              <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", borderTop: `1px solid ${C.border}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{inv.email}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>
                    {ROLE_LABELS[inv.role] ?? inv.role}
                    {inv.acceptedAt ? ` · Accepted ${new Date(inv.acceptedAt).toLocaleDateString()}` : ""}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: statusColor + "18", color: statusColor }}>
                  {inv.status}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Invite member modal */}
      {showAdd && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget) resetModal(); }}>
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: 440, boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            {submitted ? (
              <div style={{ textAlign: "center", padding: "8px 0 0" }}>
                {emailSent === false ? (
                  <>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#92400E", marginBottom: 8 }}>Invitation created, but the email could not be delivered.</div>
                    <p style={{ fontSize: 13, color: C.textSub, margin: "0 0 20px" }}>
                      Copy the link below and send it to <strong>{form.email}</strong> manually. They'll set a password and join {orgName}.
                    </p>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: C.green, marginBottom: 8 }}>Invitation sent</div>
                    <p style={{ fontSize: 13, color: C.textSub, margin: "0 0 20px" }}>
                      An email was sent to <strong>{form.email}</strong>. You can also copy and share this link directly.
                    </p>
                  </>
                )}
                {inviteUrl && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
                    <input readOnly value={inviteUrl}
                      style={{ flex: 1, padding: "9px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 11, color: C.textSub, background: C.pageBg, outline: "none" }}
                      onClick={e => e.target.select()} />
                    <button onClick={() => navigator.clipboard.writeText(inviteUrl)}
                      style={{ padding: "9px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: C.orange, color: "#fff", fontSize: 12, fontWeight: 700 }}>
                      Copy
                    </button>
                  </div>
                )}
                <button onClick={resetModal} style={{ width: "100%", padding: "11px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Done</button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
                  <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.text }}>Invite Member</h3>
                  <button onClick={resetModal} style={{ background: "none", border: "none", fontSize: 18, color: C.textSub, cursor: "pointer" }}>✕</button>
                </div>
                <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.06em" }}>EMAIL ADDRESS</label>
                    <input type="email" required value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="rep@company.com"
                      style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, boxSizing: "border-box", outline: "none", color: C.text, background: C.white }} />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.06em" }}>ROLE</label>
                    <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                      style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.white, outline: "none" }}>
                      <option value="user">Rep (User)</option>
                      <option value="orgAdmin">Manager (Admin)</option>
                    </select>
                  </div>
                  {/* Team selector — only shown when teams exist */}
                  {teams !== null && teams.length > 0 && (
                    <div>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.06em" }}>TEAM (OPTIONAL)</label>
                      <select value={form.teamId} onChange={e => setForm(p => ({ ...p, teamId: e.target.value }))}
                        style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.white, outline: "none" }}>
                        <option value="">No team assigned</option>
                        {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                  )}
                  {inviteError && <p style={{ margin: 0, fontSize: 12, color: "#ef4444" }}>{inviteError}</p>}
                  <button type="submit" disabled={inviteLoading}
                    style={{ marginTop: 4, padding: "12px", borderRadius: 8, border: "none", cursor: inviteLoading ? "not-allowed" : "pointer", background: C.orange, color: "#fff", fontSize: 14, fontWeight: 700, opacity: inviteLoading ? 0.7 : 1 }}>
                    {inviteLoading ? "Creating invite…" : "Generate Invite Link →"}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete team confirmation modal */}
      {confirmDeleteTeam && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmDeleteTeam(null); }}>
          <div style={{ background: C.white, borderRadius: 16, padding: 32, width: "min(400px, calc(100vw - 32px))", boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>⚠️</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: C.text, textAlign: "center" }}>Delete {confirmDeleteTeam.name}?</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textSub, textAlign: "center", lineHeight: 1.6 }}>This will remove the team. Members will remain in the org but lose their team assignment. This cannot be undone.</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmDeleteTeam(null)} style={{ flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
              <button onClick={executeDeleteTeam} style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: "#ef4444", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Yes, delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── INVITE SCREEN ────────────────────────────────────────────
// Shown when a user visits /invite/:token before they have an account.
// Validates the token, shows the org they're joining, collects name + password,
// creates their Supabase Auth account, assigns them to the tenant via accept_invitation(),
// then calls onSuccess() to log them in.
function InviteScreen({ token, onSuccess }) {
  const [inv,      setInv]      = useState(null);   // invitation data from DB
  const [status,   setStatus]   = useState("loading"); // loading|ready|error|expired|accepted|submitting|done
  const [errMsg,   setErrMsg]   = useState("");
  const [name,     setName]     = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");

  // Fetch invitation on mount
  useEffect(() => {
    supabase.rpc("get_invitation_by_token", { p_token: token }).then(({ data, error }) => {
      if (error || !data) { setStatus("error"); setErrMsg("Invitation not found."); return; }
      if (data.error === "expired")          { setStatus("expired");  return; }
      if (data.error === "already_accepted") { setStatus("accepted"); return; }
      setInv(data);
      setStatus("ready");
    });
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setErrMsg("Passwords don't match."); return; }
    if (password.length < 8)  { setErrMsg("Password must be at least 8 characters."); return; }
    setErrMsg("");
    setStatus("submitting");

    // 1. Create Supabase Auth account (or sign in if email already exists)
    let authData;
    const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
      email:   inv.adminEmail,
      password,
      options: { data: { name: name.trim() || inv.adminEmail.split("@")[0] } },
    });

    if (signUpErr) {
      // "User already registered" happens when a tenant was deleted but the auth.users
      // record persists. Allow re-assignment by signing in with existing credentials.
      const isExisting = signUpErr.status === 422 ||
        signUpErr.message.toLowerCase().includes("already") ||
        signUpErr.message.toLowerCase().includes("registered");
      if (isExisting) {
        const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
          email:    inv.adminEmail,
          password,
        });
        if (signInErr) {
          setErrMsg("This email already has an account — enter your existing password to accept this invitation.");
          setStatus("ready");
          return;
        }
        authData = signInData;
      } else {
        setErrMsg(signUpErr.message);
        setStatus("ready");
        return;
      }
    } else {
      authData = signUpData;
    }

    // 2. Wait for profile trigger (or accept_invitation will upsert it)
    await new Promise(r => setTimeout(r, 600));

    // 3. Accept invitation — assigns tenant + role, marks accepted, advances tenant status
    const { error: acceptErr } = await supabase.rpc("accept_invitation", {
      p_token: token,
      p_name:  name.trim() || null,
    });

    if (acceptErr) {
      setErrMsg(`Setup failed: ${acceptErr.message}`);
      setStatus("ready");
      return;
    }

    // 4. Fetch full profile and log in
    const { getProfile } = await import("./src/lib/profileService.js");
    const profile = await getProfile(authData.user.id);
    if (!profile) {
      setErrMsg("Account created but profile could not be loaded. Try logging in.");
      setStatus("ready");
      return;
    }

    setStatus("done");
    setTimeout(() => onSuccess(profile), 800);
  };

  const inputStyle = {
    width: "100%", padding: "11px 14px", borderRadius: 8,
    border: `1.5px solid ${C.border}`, fontSize: 14, boxSizing: "border-box",
    outline: "none", color: C.text, background: C.white, fontFamily: "inherit",
  };
  const labelStyle = {
    display: "block", fontSize: 11, fontWeight: 700, color: C.textSub,
    marginBottom: 6, letterSpacing: "0.06em",
  };

  return (
    <div style={{
      minHeight: "100vh", background: C.pageBg,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, fontFamily: "'Plus Jakarta Sans', sans-serif",
    }}>
      <div style={{ width: "100%", maxWidth: 420 }}>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, background: C.orange,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 22, fontWeight: 900, color: "#fff", marginBottom: 12,
          }}>r</div>
          <div style={{ fontSize: 13, color: C.textSub, fontWeight: 500 }}>ralli</div>
        </div>

        <div style={{
          background: C.white, borderRadius: 16, padding: 32,
          boxShadow: "0 4px 24px rgba(0,0,0,0.07)", border: `1px solid ${C.border}`,
        }}>

          {/* Loading */}
          {status === "loading" && (
            <div style={{ textAlign: "center", padding: "20px 0", color: C.textSub }}>
              Checking your invitation...
            </div>
          )}

          {/* Expired */}
          {status === "expired" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>⏰</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>Invitation expired</div>
              <p style={{ fontSize: 13, color: C.textSub, margin: 0 }}>This link is no longer valid. Ask your admin to resend the invitation.</p>
            </div>
          )}

          {/* Already accepted */}
          {status === "accepted" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>✅</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>Already accepted</div>
              <p style={{ fontSize: 13, color: C.textSub, margin: "0 0 16px" }}>This invitation has already been used. Log in to access your workspace.</p>
              <a href="/" style={{ fontSize: 13, color: C.orange, fontWeight: 600, textDecoration: "none" }}>Go to login →</a>
            </div>
          )}

          {/* Error */}
          {status === "error" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>Invalid invitation</div>
              <p style={{ fontSize: 13, color: C.textSub, margin: 0 }}>{errMsg || "This link is invalid. Contact your admin."}</p>
            </div>
          )}

          {/* Done */}
          {status === "done" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>🎉</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.green, marginBottom: 8 }}>You're in!</div>
              <p style={{ fontSize: 13, color: C.textSub, margin: 0 }}>Setting up your workspace...</p>
            </div>
          )}

          {/* Ready: sign-up form */}
          {(status === "ready" || status === "submitting") && inv && (
            <>
              <div style={{ marginBottom: 24 }}>
                {/* Org badge */}
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  background: C.orange + "12", borderRadius: 8, padding: "6px 12px", marginBottom: 16,
                }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: 6, background: C.orange,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 800, color: "#fff",
                  }}>{(inv.tenantName ?? "?").slice(0, 2).toUpperCase()}</div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.orange }}>{inv.tenantName}</span>
                </div>

                <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 800, color: C.text }}>
                  Create your account
                </h2>
                <p style={{ margin: 0, fontSize: 13, color: C.textSub }}>
                  You've been invited to join <b style={{ color: C.text }}>{inv.tenantName}</b> on Ralli.
                </p>
              </div>

              <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Email — read-only, from invitation */}
                <div>
                  <label style={labelStyle}>EMAIL</label>
                  <input
                    type="email" value={inv.adminEmail} readOnly
                    style={{ ...inputStyle, background: C.pageBg, color: C.textSub, cursor: "default" }}
                  />
                </div>

                <div>
                  <label style={labelStyle}>YOUR NAME</label>
                  <input
                    type="text" value={name} placeholder="First Last"
                    onChange={e => setName(e.target.value)}
                    style={inputStyle} autoFocus
                  />
                </div>

                <div>
                  <label style={labelStyle}>PASSWORD</label>
                  <input
                    type="password" value={password} placeholder="At least 8 characters"
                    onChange={e => setPassword(e.target.value)} required minLength={8}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label style={labelStyle}>CONFIRM PASSWORD</label>
                  <input
                    type="password" value={confirm} placeholder="Repeat password"
                    onChange={e => setConfirm(e.target.value)} required
                    style={inputStyle}
                  />
                </div>

                {errMsg && (
                  <div style={{ fontSize: 13, color: "#ef4444", fontWeight: 500, padding: "8px 12px", background: "#fef2f2", borderRadius: 8 }}>
                    {errMsg}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={status === "submitting"}
                  style={{
                    marginTop: 4, padding: "13px", borderRadius: 8, border: "none",
                    cursor: status === "submitting" ? "not-allowed" : "pointer",
                    background: status === "submitting" ? C.textMuted : C.orange,
                    color: "#fff", fontSize: 14, fontWeight: 700, transition: "background 0.15s",
                  }}
                >
                  {status === "submitting" ? "Creating account..." : "Create Account →"}
                </button>
              </form>

              <p style={{ textAlign: "center", marginTop: 16, fontSize: 12, color: C.textSub }}>
                Already have an account?{" "}
                <a href="/" style={{ color: C.orange, fontWeight: 600, textDecoration: "none" }}>Log in</a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── RESET PASSWORD SCREEN ───────────────────────────────────
// Rendered when a Supabase PASSWORD_RECOVERY link is opened.
// Calls supabase.auth.updateUser({ password }) then signs the user out so
// they log in fresh — ensuring the recovery session is fully cleared.
function ResetPasswordScreen({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [done,     setDone]     = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8)    { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm)    { setError("Passwords don't match."); return; }

    setLoading(true);
    const { error: updateErr } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateErr) {
      const m = updateErr.message?.toLowerCase() ?? "";
      if (m.includes("same password")) {
        setError("New password must be different from your current password.");
      } else if (m.includes("expired") || m.includes("invalid") || m.includes("token")) {
        setError("This reset link has expired. Please request a new one from the login screen.");
      } else {
        setError("Failed to update password. Please try again or request a new reset link.");
      }
      return;
    }

    setDone(true);
    // Sign out clears the recovery session so the user must log in fresh with the new password.
    await supabase.auth.signOut();
    setTimeout(() => onSuccess(), 2500);
  };

  const inputStyle = {
    width: "100%", padding: "11px 14px", borderRadius: 8, fontSize: 14,
    border: `1.5px solid ${error ? C.red : C.border}`,
    outline: "none", boxSizing: "border-box", color: C.text,
    background: C.inputBg,
  };

  return (
    <div style={{
      height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: C.cream,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "24px 20px",
    }}>
      <div style={{ width: "100%", maxWidth: 400, margin: "0 auto" }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 40, justifyContent: "center" }}>
          <RalliLogo size={44} />
          <div>
            <div style={{ fontSize: 26, fontWeight: 900, color: C.text, letterSpacing: "-0.5px" }}>ralli</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.orangeDark, letterSpacing: "0.1em" }}>Focus. Grow. Succeed.</div>
          </div>
        </div>

        <div style={{ background: "#fff", borderRadius: 16, padding: 32, boxShadow: "0 24px 64px rgba(0,0,0,0.3)" }}>
          {done ? (
            <div style={{ textAlign: "center", padding: "16px 0" }}>
              <div style={{ fontSize: 36, marginBottom: 16 }}>✅</div>
              <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 800, color: C.text }}>Password updated</h2>
              <p style={{ margin: 0, fontSize: 14, color: C.textSub }}>Signing you out… you can now log in with your new password.</p>
            </div>
          ) : (
            <>
              <h2 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800, color: C.text }}>Set a new password</h2>
              <p style={{ margin: "0 0 24px", fontSize: 14, color: C.textSub }}>Choose a strong password for your account.</p>
              <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.04em" }}>NEW PASSWORD</label>
                  <input
                    type="password" value={password} autoFocus
                    onChange={e => { setPassword(e.target.value); setError(""); }}
                    placeholder="Min. 8 characters"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.04em" }}>CONFIRM PASSWORD</label>
                  <input
                    type="password" value={confirm}
                    onChange={e => { setConfirm(e.target.value); setError(""); }}
                    placeholder="Re-enter your password"
                    style={inputStyle}
                  />
                </div>
                {error && (
                  <div style={{ padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 13, color: C.red }}>
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loading || !password || !confirm}
                  style={{
                    width: "100%", padding: "12px", borderRadius: 10, border: "none", marginTop: 4,
                    background: loading || !password || !confirm ? C.muted : C.orange,
                    color: loading || !password || !confirm ? C.textMuted : "#fff",
                    fontSize: 14, fontWeight: 700,
                    cursor: loading || !password || !confirm ? "not-allowed" : "pointer",
                    transition: "background 0.15s",
                  }}
                >
                  {loading ? "Updating…" : "Update password"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── LOGIN SCREEN ────────────────────────────────────────────

// Maps raw Supabase auth error messages to customer-safe strings.
// Never expose error codes, table names, or RLS details to users.
function mapAuthError(message) {
  if (!message) return "Sign in failed. Please try again.";
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials") || m.includes("invalid password") || m.includes("user not found")) {
    return "Incorrect email or password. Please try again.";
  }
  if (m.includes("email not confirmed")) {
    return "Please confirm your email before signing in. Check your inbox for a verification link.";
  }
  if (m.includes("too many requests") || m.includes("rate limit")) {
    return "Too many sign-in attempts. Please wait a moment and try again.";
  }
  if (m.includes("network") || m.includes("fetch") || m.includes("failed to fetch")) {
    return "Connection error. Check your internet connection and try again.";
  }
  return "Sign in failed. Please try again.";
}

function LoginScreen({ onLogin, users = USERS }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Forgot password state
  const [showForgot, setShowForgot]     = useState(false);
  const [resetEmail, setResetEmail]     = useState("");
  const [resetSent, setResetSent]       = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError]     = useState("");

  const handleForgotPw = async (e) => {
    e.preventDefault();
    if (!resetEmail.trim()) { setResetError("Enter your email."); return; }
    setResetLoading(true);
    setResetError("");
    const { error: pwErr } = await supabase.auth.resetPasswordForEmail(
      resetEmail.trim().toLowerCase(),
      { redirectTo: `${window.location.origin}/reset` }
    );
    setResetLoading(false);
    if (pwErr) { setResetError(pwErr.message); return; }
    setResetSent(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    // Demo accounts are only accessible via the quick-login cards below — never via this form.
    // A failed Supabase auth never falls back to seed data regardless of the email.
    const { data, error: authErr } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (data?.user) {
      // Auth succeeded — fetch profile
      let profile = await getProfile(data.user.id);
      if (!profile) {
        // Give trigger a moment on first-ever login
        await new Promise(r => setTimeout(r, 800));
        profile = await getProfile(data.user.id);
      }
      if (profile) { onLogin(profile); return; }
      // Auth worked but no profile row — trigger didn't fire, create it now
      try {
        const created = await createMissingProfile(data.user);
        if (created) { onLogin(created); return; }
      } catch {
        setError("We couldn't load your account. Please contact support if this continues.");
        setLoading(false);
        return;
      }
      setError("We couldn't load your account. Please contact support if this continues.");
      setLoading(false);
      return;
    }

    setError(mapAuthError(authErr?.message));
    setLoading(false);
  };

  const quickLogin = (user) => {
    setLoading(true);
    setTimeout(() => onLogin(user), 400);
  };

  // Group demo accounts by org for display
  const orgMap = Object.fromEntries(INITIAL_ORGS.map(o => [o.id, o.name]));
  const groupedUsers = users.reduce((acc, u) => {
    const key = u.orgId ? (orgMap[u.orgId] ?? u.orgId) : "ralli platform";
    (acc[key] = acc[key] || []).push(u);
    return acc;
  }, {});

  return (
    <div style={{
      height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: C.cream,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "24px 20px", overflowY: "auto",
    }}>
      <div style={{ width: "100%", maxWidth: 400, margin: "0 auto" }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 40, justifyContent: "center" }}>
          <RalliLogo size={44} />
          <div>
            <div style={{ fontSize: 26, fontWeight: 900, color: C.text, letterSpacing: "-0.5px" }}>ralli</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.orangeDark, letterSpacing: "0.1em" }}>Focus. Grow. Succeed.</div>
          </div>
        </div>

        {/* Card */}
        <div style={{
          background: "#fff", borderRadius: 16, padding: 32,
          boxShadow: "0 24px 64px rgba(0,0,0,0.3)",
        }}>
          <h2 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800, color: C.text }}>Sign in</h2>
          <p style={{ margin: "0 0 24px", fontSize: 14, color: C.textSub }}>Welcome back to your team's leaderboard.</p>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.04em" }}>
                EMAIL
              </label>
              <input
                type="email"
                value={email}
                onChange={e => { setEmail(e.target.value); setError(""); }}
                placeholder="you@ralli.com"
                style={{
                  width: "100%", padding: "11px 14px", borderRadius: 8, fontSize: 14,
                  border: `1.5px solid ${error ? C.red : C.border}`,
                  outline: "none", boxSizing: "border-box", color: C.text,
                  background: C.inputBg,
                }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: C.textSub, marginBottom: 6, letterSpacing: "0.04em" }}>
                PASSWORD
              </label>
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setError(""); }}
                placeholder="••••••••"
                style={{
                  width: "100%", padding: "11px 14px", borderRadius: 8, fontSize: 14,
                  border: `1.5px solid ${error ? C.red : C.border}`,
                  outline: "none", boxSizing: "border-box", color: C.text,
                  background: C.inputBg,
                }}
              />
            </div>

            {error && (
              <div style={{ fontSize: 13, color: C.red, fontWeight: 600 }}>{error}</div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: 4, padding: "12px", borderRadius: 8, border: "none",
                background: loading ? C.textMuted : C.orange, color: "#fff",
                fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {loading ? "Signing in..." : "Sign In →"}
            </button>
          </form>

          {/* Forgot password */}
          {!showForgot ? (
            <button
              onClick={() => { setShowForgot(true); setResetEmail(email); }}
              style={{
                marginTop: 12, display: "block", width: "100%", background: "none",
                border: "none", cursor: "pointer", fontSize: 13, color: C.textSub,
                textAlign: "center", padding: "4px 0",
              }}
            >
              Forgot password?
            </button>
          ) : (
            <div style={{ marginTop: 14, padding: "16px", borderRadius: 12, background: C.pageBg, border: `1px solid ${C.border}` }}>
              {resetSent ? (
                <p style={{ margin: 0, fontSize: 13, color: C.green, fontWeight: 600, textAlign: "center" }}>
                  Check your email — reset link sent.
                </p>
              ) : (
                <form onSubmit={handleForgotPw} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: C.textSub }}>RESET PASSWORD</p>
                  <input
                    type="email"
                    value={resetEmail}
                    onChange={e => { setResetEmail(e.target.value); setResetError(""); }}
                    placeholder="your@email.com"
                    style={{
                      width: "100%", padding: "10px 12px", borderRadius: 8, fontSize: 14,
                      border: `1.5px solid ${resetError ? C.red : C.border}`,
                      outline: "none", boxSizing: "border-box", color: C.text, background: C.white,
                    }}
                  />
                  {resetError && <p style={{ margin: 0, fontSize: 12, color: C.red }}>{resetError}</p>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setShowForgot(false)}
                      style={{ flex: 1, padding: "9px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSub, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                    >Cancel</button>
                    <button
                      type="submit"
                      disabled={resetLoading}
                      style={{ flex: 2, padding: "9px", borderRadius: 8, border: "none", background: C.orange, color: "#fff", fontSize: 13, fontWeight: 700, cursor: resetLoading ? "default" : "pointer", opacity: resetLoading ? 0.7 : 1 }}
                    >{resetLoading ? "Sending…" : "Send Reset Link"}</button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Test accounts grouped by org */}
          <div style={{ marginTop: 28, borderTop: `1px solid ${C.border}`, paddingTop: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 12 }}>
              DEMO ACCOUNTS — any password works
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {Object.entries(groupedUsers).map(([orgName, orgUserList]) => (
                <div key={orgName}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 6, paddingLeft: 2 }}>
                    {orgName.toUpperCase()}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {orgUserList.map(u => {
                      const roleColor = u.role === "superadmin" ? "#8B5CF6" : u.role === "orgAdmin" ? C.green : C.orange;
                      const roleLabel = u.role === "superadmin" ? "SUPER ADMIN" : u.role === "orgAdmin" ? "MANAGER" : "REP";
                      return (
                        <button
                          key={u.id}
                          onClick={() => quickLogin(u)}
                          disabled={loading}
                          style={{
                            display: "flex", alignItems: "center", gap: 12, padding: "10px 12px",
                            borderRadius: 8, border: `1px solid ${C.border}`, background: C.pageBg,
                            cursor: loading ? "default" : "pointer", textAlign: "left",
                            transition: "border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = u.color; e.currentTarget.style.background = u.color + "10"; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.pageBg; }}
                        >
                          <div style={{
                            width: 32, height: 32, borderRadius: "50%", background: u.color,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 11, fontWeight: 900, color: "#fff", flexShrink: 0,
                          }}>{u.initials}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{u.name}</div>
                            <div style={{ fontSize: 11, color: C.textSub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
                          </div>
                          <span style={{
                            fontSize: 9, padding: "2px 6px", borderRadius: 4, fontWeight: 800,
                            background: roleColor, color: "#fff",
                            letterSpacing: "0.04em", flexShrink: 0,
                          }}>{roleLabel}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── OrgAdminSettingsScreen ────────────────────────────────────────────────────
// Tabbed settings for Organization Admin: Role Access + Team Settings
// ─────────────────────────────────────────────────────────────────────────────
function OrgAdminSettingsScreen({ rolePermissions, onSaveRolePermissions, currentOrg, orgId, orgName, orgUsers, onAddUser }) {
  const [tab, setTab] = useState("roles"); // "roles" | "team"
  const tabs = [
    { id: "roles", label: "Role Access" },
    { id: "team",  label: "Team Settings" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, paddingBottom: 0 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "8px 16px", border: "none", cursor: "pointer", background: "none",
            fontSize: 13, fontWeight: 700,
            color: tab === t.id ? C.orange : C.textSub,
            borderBottom: `2px solid ${tab === t.id ? C.orange : "transparent"}`,
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>
      {tab === "roles" && <RoleAccessScreen rolePermissions={rolePermissions} onSave={onSaveRolePermissions} currentOrg={currentOrg} />}
      {tab === "team"  && <TeamScreen orgId={orgId} orgName={orgName} orgUsers={orgUsers} onAddUser={onAddUser} />}
    </div>
  );
}

// ── APP SHELL ──────────────────────────────────────────────

// ── SEED DATA ─────────────────────────────────────────────────────────────────
// Imported from src/data/seeds.js (see that file for full schema documentation).
// SEED_TENANTS   — full Tenant schema: id, slug, logo, domain, plan, seatLimit, ...
// SEED_USERS     — full User schema:   tenantId (+ orgId alias), status, createdAt, ...
// SEED_TENANT_SETTINGS — per-tenant branding, enabledFeatures, rolePermissions
//
// Production: replace these constants with Supabase queries on app init.
//   const { data: tenants } = await supabase.from('tenants').select('*');
//   const { data: users }   = await supabase.from('users').select('*').eq('tenant_id', tenantId);

const INITIAL_ORGS     = SEED_TENANTS;       // alias — app screens reference INITIAL_ORGS
const INITIAL_ORG_USERS = SEED_USERS;        // alias — app screens reference INITIAL_ORG_USERS
const USERS             = SEED_USERS;        // alias — used by LoginScreen


// ── InsightsScreen ────────────────────────────────────────────────────────────
// Role-aware AI Insights screen.
// User: personal readiness score + recommendations
// Manager/Admin: team overview + per-member readiness
//
// Data flow:
//   1. Fetch aggregated performance via insightsService
//   2. Compute rules-based recommendations (client-side, always works)
//   3. Optionally fetch AI prose summary via /api/ai-insights (graceful fallback)
//   4. Cache AI result in ai_insights table to avoid redundant calls
// ─────────────────────────────────────────────────────────────────────────────
function InsightsScreen({ user, isReal = false, tenantId = null, orgUsers = [], isAdmin = false }) {
  const mobile     = useMobile();
  const [loading,  setLoading]  = useState(isReal);
  const [perf,     setPerf]     = useState(null);
  const [teamData, setTeamData] = useState(null);
  const [recs,     setRecs]     = useState([]);
  const [aiSummary,     setAiSummary]     = useState(null);
  const [aiAvailable,   setAiAvailable]   = useState(false);
  const [aiLoading,     setAiLoading]     = useState(false);
  const [error,    setError]    = useState(null);

  // Lazy import to avoid circular deps at module load time
  const [insightsSvc, setInsightsSvc] = useState(null);
  useEffect(() => {
    import("./src/lib/insightsService.js").then(m => setInsightsSvc(m));
  }, []);

  // Load performance data
  useEffect(() => {
    if (!isReal || !tenantId || !user?.id || !insightsSvc) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const load = async () => {
      try {
        if (isAdmin) {
          // Manager/Admin: fetch team insights
          const { data: team, error: teamErr } = await insightsSvc.getTeamInsights(tenantId);
          if (teamErr) { setError("Could not load team insights."); return; }
          setTeamData(team);
          // Also load own perf if available
          const { data: myPerf } = await insightsSvc.getUserPerformance(tenantId, user.id);
          if (myPerf) {
            setPerf(myPerf);
            setRecs(insightsSvc.getRecommendations(myPerf));
          }
        } else {
          const { data: myPerf, error: perfErr } = await insightsSvc.getUserPerformance(tenantId, user.id);
          if (perfErr || !myPerf) { setError("Could not load your insights."); return; }
          setPerf(myPerf);
          setRecs(insightsSvc.getRecommendations(myPerf));

          // Persist readiness score in background (non-blocking)
          insightsSvc.computeAndSaveReadinessScore(tenantId, user.id)
            .catch(() => {});

          // Try cached AI insight first
          const { data: cached } = await insightsSvc.getCachedInsight(tenantId, "user", user.id);
          if (cached?.summary) {
            setAiSummary(cached.summary);
            setAiAvailable(true);
            return;
          }

          // Request fresh AI summary
          setAiLoading(true);
          try {
            const res = await fetch("/api/ai-insights", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scope: "user", data: myPerf, recs: insightsSvc.getRecommendations(myPerf) }),
            });
            if (res.ok) {
              const json = await res.json();
              setAiAvailable(json.aiAvailable ?? false);
              if (json.summary) {
                setAiSummary(json.summary);
                insightsSvc.saveInsightCache(tenantId, "user", user.id, { summary: json.summary, recommendations: json.recommendations ?? [] })
                  .catch(() => {});
              }
            }
          } catch (_) { /* AI unavailable — silent fail, recs still shown */ }
          setAiLoading(false);
        }
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isReal, tenantId, user?.id, insightsSvc, isAdmin]);

  const band = insightsSvc?.getReadinessBand ?? (s => ({ label: s >= 85 ? "High" : s >= 65 ? "On Track" : "At Risk", color: s >= 85 ? "#22c55e" : s >= 65 ? "#f59e0b" : "#ef4444", bg: s >= 85 ? "#f0fdf4" : s >= 65 ? "#fffbeb" : "#fef2f2" }));

  // ── Mock data for demo users ──
  const mockPerf = {
    score: 72, learningScore: 68, quizScore: 79, gameScore: 65,
    totalXp: 540, recentXp: 240, lessonsCompleted: 5, coursesCompleted: 1,
    quizzesAttempted: 4, quizzesPassed: 3, avgQuizScore: 77, passRate: 75, gamesPlayed: 2,
  };
  const mockRecs = [
    { priority: "high",   type: "quiz",   action: "Retake your lowest-scoring quiz", reason: "Raising quiz scores has the biggest impact on your readiness score." },
    { priority: "medium", type: "lesson", action: "Complete 2 more lessons this week", reason: "You've completed 5 lessons — 10 is the baseline for a high learning score." },
    { priority: "low",    type: "game",   action: "Join a live game session", reason: "Live games reinforce knowledge and contribute to your readiness score." },
  ];
  const displayPerf = perf ?? (isReal ? null : mockPerf);
  const displayRecs = recs.length > 0 ? recs : (isReal ? [] : mockRecs);

  const cardStyle = { background: C.white, borderRadius: 14, padding: 24, border: `1px solid ${C.border}` };
  const sectionHead = { fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 16 };
  const PRIORITY_COLOR = { high: "#ef4444", medium: "#f59e0b", low: "#22c55e" };

  if (loading) {
    return (
      <div style={{ flex: 1, overflow: "auto", padding: mobile ? "16px 16px 80px" : "32px 32px 80px", maxWidth: 860, margin: "0 auto", width: "100%" }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 20 }}>Insights</div>
        <LoadingState rows={3} message="Loading your performance data…" />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ flex: 1, overflow: "auto", padding: mobile ? "16px 16px 80px" : "32px 32px 80px", maxWidth: 860, margin: "0 auto", width: "100%" }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 20 }}>Insights</div>
        <ErrorState message={error} />
      </div>
    );
  }

  // Guard: real user with no org context or data not yet available
  if (isReal && !displayPerf) {
    return (
      <div style={{ flex: 1, overflow: "auto", padding: mobile ? "16px 16px 80px" : "32px 32px 80px", maxWidth: 860, margin: "0 auto", width: "100%" }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 20 }}>Insights</div>
        <EmptyState
          icon="📈"
          title="No data yet"
          message="Complete a lesson, quiz, or game to see your readiness score and performance insights."
        />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: mobile ? "16px 16px 80px" : "32px 32px 80px", maxWidth: 860, margin: "0 auto", width: "100%" }}>

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 4 }}>Insights</div>
        <div style={{ color: C.textSub, fontSize: 13 }}>
          {isAdmin ? "Team readiness overview based on real activity data." : "Your readiness score and recommended actions."}
        </div>
      </div>

      {/* ── USER VIEW ── */}
      {!isAdmin && displayPerf && (() => {
        const b = band(displayPerf.score);
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Readiness score card */}
            <div style={{ ...cardStyle, display: "flex", gap: 32, alignItems: "flex-start", flexWrap: "wrap" }}>
              {/* Score ring */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, minWidth: 100 }}>
                <div style={{ width: 96, height: 96, borderRadius: "50%", background: b.bg, border: `4px solid ${b.color}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 26, fontWeight: 800, color: b.color }}>{displayPerf.score}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: b.color, background: b.bg, padding: "2px 10px", borderRadius: 99 }}>{b.label}</span>
              </div>

              {/* Component breakdown */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, minWidth: 200 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>Readiness Score</div>
                {[
                  { label: "Learning", score: displayPerf.learningScore, detail: `${displayPerf.lessonsCompleted} lesson${displayPerf.lessonsCompleted !== 1 ? "s" : ""}, ${displayPerf.coursesCompleted} course${displayPerf.coursesCompleted !== 1 ? "s" : ""}`, weight: "35%" },
                  { label: "Quizzes",  score: displayPerf.quizScore,    detail: `${displayPerf.avgQuizScore}% avg, ${displayPerf.quizzesPassed}/${displayPerf.quizzesAttempted} passed`, weight: "40%" },
                  { label: "Games",    score: displayPerf.gameScore,    detail: `${displayPerf.gamesPlayed} game${displayPerf.gamesPlayed !== 1 ? "s" : ""} played`, weight: "25%" },
                ].map(({ label, score, detail, weight }) => (
                  <div key={label}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{label} <span style={{ fontSize: 11, fontWeight: 400, color: C.textMuted }}>({weight})</span></span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{score}</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 99, background: C.muted, overflow: "hidden" }}>
                      <div style={{ height: "100%", borderRadius: 99, background: C.orange, width: `${score}%`, transition: "width 0.5s" }} />
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{detail}</div>
                  </div>
                ))}
              </div>

              {/* XP */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end", minWidth: 80 }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{displayPerf.totalXp.toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>Total XP</div>
                </div>
                {displayPerf.recentXp > 0 && (
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#22c55e", background: "#f0fdf4", padding: "2px 8px", borderRadius: 99 }}>
                    +{displayPerf.recentXp} this period
                  </div>
                )}
              </div>
            </div>

            {/* Performance Summary */}
            <div style={cardStyle}>
              <div style={sectionHead}>Performance Summary</div>
              {aiLoading ? (
                <div style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic" }}>Generating summary…</div>
              ) : aiSummary ? (
                <div style={{ fontSize: 14, color: C.text, lineHeight: 1.6 }}>{aiSummary}</div>
              ) : (
                <div style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic" }}>
                  {isReal
                    ? "Performance summary unavailable. Complete more activity to generate your summary."
                    : "Performance summaries are based on real activity data. Complete lessons and quizzes to see yours."}
                </div>
              )}
            </div>

            {/* Recommendations */}
            {displayRecs.length > 0 && (
              <div style={cardStyle}>
                <div style={sectionHead}>Recommended Actions</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {displayRecs.map((rec, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: PRIORITY_COLOR[rec.priority] ?? C.orange, flexShrink: 0, marginTop: 5 }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 2 }}>{rec.action}</div>
                        <div style={{ fontSize: 12, color: C.textSub }}>{rec.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Activity stats */}
            <div style={{ ...cardStyle }}>
              <div style={sectionHead}>Activity Summary</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
                {[
                  { label: "Lessons Done",  value: displayPerf.lessonsCompleted },
                  { label: "Courses Done",  value: displayPerf.coursesCompleted },
                  { label: "Quizzes Taken", value: displayPerf.quizzesAttempted },
                  { label: "Quizzes Passed",value: displayPerf.quizzesPassed },
                  { label: "Avg Quiz Score",value: `${displayPerf.avgQuizScore}%` },
                  { label: "Games Played",  value: displayPerf.gamesPlayed },
                ].map(({ label, value }) => (
                  <div key={label} style={{ textAlign: "center", padding: "12px 8px", background: C.pageBg, borderRadius: 10 }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{value}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── ADMIN / MANAGER VIEW ── */}
      {isAdmin && (() => {
        const team = teamData;
        if (!team) {
          return (
            <div style={{ ...cardStyle, textAlign: "center", padding: 48, color: C.textSub }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}></div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>No readiness data yet</div>
              <div style={{ fontSize: 13, color: C.textMuted }}>Readiness scores appear once team members start completing lessons and quizzes.</div>
            </div>
          );
        }
        const distribution = team.distribution ?? { high: 0, onTrack: 0, atRisk: 0 };
        const distBars = [
          { label: "High (85+)",    count: distribution.high,    color: "#22c55e" },
          { label: "On Track (65+)",count: distribution.onTrack, color: "#f59e0b" },
          { label: "At Risk (<65)", count: distribution.atRisk,  color: "#ef4444" },
        ];

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Team summary */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
              {[
                { label: "Team Avg Score",   value: team.avgScore ?? 0,          suffix: "/100" },
                { label: "Members Tracked",  value: team.totalMembers ?? 0 },
                { label: "At Risk",          value: team.atRisk?.length ?? 0,    color: "#ef4444" },
                { label: "Top Performers",   value: team.topPerformers?.length ?? 0, color: "#22c55e" },
              ].map(({ label, value, suffix = "", color }) => (
                <div key={label} style={{ ...cardStyle, textAlign: "center" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: color ?? C.text }}>{value}{suffix}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Score distribution */}
            <div style={cardStyle}>
              <div style={sectionHead}>Score Distribution</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {distBars.map(({ label, count, color }) => {
                  const pct = team.totalMembers ? Math.round((count / team.totalMembers) * 100) : 0;
                  return (
                    <div key={label}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{label}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color }}>{count} ({pct}%)</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 99, background: C.muted, overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: 99, background: color, width: `${pct}%`, transition: "width 0.5s" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Member list */}
            {team.members?.length > 0 && (
              <div style={cardStyle}>
                <div style={sectionHead}>Member Scores</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {[...team.members]
                    .sort((a, b) => b.score - a.score)
                    .map((m, i) => {
                      const mb = band(m.score);
                      const memberProfile = orgUsers.find(u => u.id === m.user_id);
                      const name = memberProfile?.name ?? memberProfile?.email ?? `User ${i + 1}`;
                      const initials = name.split(" ").map(w => w[0] ?? "").join("").slice(0, 2).toUpperCase();
                      return (
                        <div key={m.user_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: i < team.members.length - 1 ? `1px solid ${C.border}` : "none" }}>
                          <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.orangeLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: C.orange, flexShrink: 0 }}>{initials}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
                            <div style={{ fontSize: 11, color: C.textMuted }}>{m.quizzes_passed ?? 0}/{m.quizzes_attempted ?? 0} quizzes passed · {m.lessons_completed ?? 0} lessons</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                            <span style={{ fontSize: 15, fontWeight: 800, color: mb.color }}>{m.score}</span>
                            <span style={{ fontSize: 10, fontWeight: 600, color: mb.color, background: mb.bg, padding: "2px 6px", borderRadius: 99 }}>{mb.label}</span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Empty state for new teams */}
            {!team.members?.length && (
              <div style={{ ...cardStyle, textAlign: "center", padding: 40, color: C.textSub }}>
                <div style={{ fontSize: 13 }}>No readiness scores computed yet. Scores are generated as team members complete lessons, quizzes, and games.</div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Demo user without mock data */}
      {!isReal && !displayPerf && (
        <div style={{ ...cardStyle, textAlign: "center", padding: 48 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}></div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>Insights powered by real data</div>
          <div style={{ fontSize: 13, color: C.textMuted }}>Complete lessons, quizzes, and games to generate your readiness score and personalized recommendations.</div>
        </div>
      )}
    </div>
  );
}


// featureKey  — gates by subscription plan (FEATURE_CONFIG)
// permKey     — gates by admin-controlled role permission (rolePermissions.features)
//               defaults to item.id when not specified
const NAV_ITEMS = [
  { id: "home",        label: "Home",         icon: "", featureKey: "dashboard", permKey: "home" },
  { id: "rankd",       label: "ralli",        icon: "", badge: "LIVE", featureKey: "games", permKey: "games" },
  { id: "learn",       label: "Learn",        icon: "", featureKey: "learn",     permKey: "learn" },
  { id: "quizzes",     label: "Quizzes",      icon: "", featureKey: "learn",     permKey: "quizzes" },
  { id: "battlecards", label: "Battle Cards", icon: "", featureKey: "learn",     permKey: "battlecards" },
  { id: "insights",    label: "Insights",     icon: "", featureKey: "progress",  permKey: "progress" },
  { id: "progress",    label: "Progress",     adminLabel: "Leadership",  icon: "", featureKey: "progress",    permKey: "progress" },
  { id: "leaderboard", label: "Leaderboard",  icon: "", badge: "#3", featureKey: "leaderboard", permKey: "leaderboard" },
  { id: "settings",    label: "Settings",     icon: "", permKey: "settings" },
];

const FULL_SCREEN_ROUTES = new Set(["rankd-name-entry", "rankd-lobby", "rankd-game", "org-setup"]);


// ── RoleAccessScreen ─────────────────────────────────────────────────────────
// Admin-only UI for controlling per-role feature visibility and action access.
// Data model: rolePermissions { user: { features: {}, actions: {} }, orgAdmin: { ... } }
// Production hook: on save, PATCH /api/orgs/:id/role-permissions instead of localStorage.
// ─────────────────────────────────────────────────────────────────────────────
function RoleAccessScreen({ rolePermissions, onSave, currentOrg }) {
  const [draft, setDraft]   = useState(() => JSON.parse(JSON.stringify(rolePermissions)));
  const [roleTab, setRoleTab] = useState("user"); // "user" | "orgAdmin"
  const [saved, setSaved]   = useState(false);

  const FEATURE_LABELS = [
    { key: "home",        label: "Home",         desc: "Dashboard and activity overview" },
    { key: "games",       label: "Games",        desc: "Live ralli game sessions" },
    { key: "learn",       label: "Learn",        desc: "Courses and lessons" },
    { key: "quizzes",     label: "Quizzes",      desc: "Quiz library" },
    { key: "battlecards", label: "Battle Cards", desc: "Competitor and product cards" },
    { key: "progress",    label: "Progress",     desc: "Personal progress tracking" },
    { key: "leaderboard", label: "Leaderboard",  desc: "Team rankings" },
    { key: "settings",    label: "Settings",     desc: "Account and notification settings" },
  ];

  const ACTION_LABELS = [
    { key: "view",           label: "View",            desc: "View content assigned to or visible by this role" },
    { key: "create",         label: "Create",          desc: "Create new courses, lessons, quizzes, and cards" },
    { key: "edit",           label: "Edit",            desc: "Edit existing content" },
    { key: "delete",         label: "Delete",          desc: "Delete content" },
    { key: "assign",         label: "Assign",          desc: "Assign content to users or groups" },
    { key: "launch",         label: "Launch",          desc: "Launch and host live game sessions" },
    { key: "manageResults",  label: "Manage Results",  desc: "View and manage game results and analytics" },
    { key: "manageSettings", label: "Manage Settings", desc: "Access org-level settings and configurations" },
  ];

  const toggle = (scope, key) => {
    setDraft(prev => ({
      ...prev,
      [roleTab]: {
        ...prev[roleTab],
        [scope]: { ...prev[roleTab][scope], [key]: !prev[roleTab][scope][key] },
      },
    }));
    setSaved(false);
  };

  const handleSave = () => {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const isDirty = JSON.stringify(draft) !== JSON.stringify(rolePermissions);

  const ROLE_TABS = [
    { id: "user",     label: "Rep (User)",       color: C.orange },
    { id: "orgAdmin", label: "Manager",           color: C.green  },
  ];

  const Toggle = ({ on, onToggle, disabled }) => (
    <button
      onClick={!disabled ? onToggle : undefined}
      style={{
        width: 40, height: 22, borderRadius: 11, border: "none", cursor: disabled ? "default" : "pointer",
        background: on ? C.orange : C.muted, position: "relative", flexShrink: 0,
        transition: "background 0.2s", opacity: disabled ? 0.4 : 1,
      }}
    >
      <div style={{
        position: "absolute", top: 3, left: on ? 21 : 3,
        width: 16, height: 16, borderRadius: "50%", background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );

  const Section = ({ title, desc, items, scope }) => (
    <div style={{ marginBottom: 28 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: C.text, letterSpacing: "0.04em", textTransform: "uppercase" }}>{title}</div>
        <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{desc}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 12, overflow: "hidden", border: `1px solid ${C.border}` }}>
        {items.map((item, i) => {
          const on = draft[roleTab][scope][item.key] === true;
          // "view" is always required if any other action is on
          const viewLocked = scope === "actions" && item.key === "view" &&
            Object.entries(draft[roleTab].actions).some(([k, v]) => k !== "view" && v === true);
          return (
            <div key={item.key} style={{
              display: "flex", alignItems: "center", gap: 16, padding: "13px 18px",
              background: C.white,
              borderBottom: i < items.length - 1 ? `1px solid ${C.border}` : "none",
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{item.label}</div>
                <div style={{ fontSize: 11, color: C.textSub, marginTop: 1 }}>{item.desc}</div>
              </div>
              <Toggle on={on} onToggle={() => toggle(scope, item.key)} disabled={viewLocked} />
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 680 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Role Access</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>
            Control which features and actions each role can access{currentOrg ? ` for ${currentOrg.name}` : ""}.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {saved && <span style={{ fontSize: 12, color: C.trueGreen, fontWeight: 600 }}>✓ Saved</span>}
          <button
            onClick={handleSave}
            disabled={!isDirty}
            style={{
              padding: "9px 20px", borderRadius: 10, border: "none", cursor: isDirty ? "pointer" : "default",
              background: isDirty ? C.orange : C.muted, color: isDirty ? "#fff" : C.textMuted,
              fontSize: 13, fontWeight: 700, transition: "all 0.15s",
            }}
          >Save Changes</button>
        </div>
      </div>

      {/* Superadmin note */}
      <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)", fontSize: 12, color: "#7C3AED" }}>
        Superadmin always has full access to all features and actions regardless of these settings.
      </div>

      {/* Role tabs */}
      <div style={{ display: "flex", gap: 8 }}>
        {ROLE_TABS.map(r => (
          <button
            key={r.id}
            onClick={() => setRoleTab(r.id)}
            style={{
              padding: "8px 20px", borderRadius: 8, border: `2px solid ${roleTab === r.id ? r.color : C.border}`,
              background: roleTab === r.id ? r.color + "18" : C.white,
              color: roleTab === r.id ? r.color : C.textSub,
              fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "all 0.12s",
            }}
          >{r.label}</button>
        ))}
      </div>

      {/* Permission sections */}
      <Section title="Feature Visibility" desc="Controls whether this role sees the section in navigation." items={FEATURE_LABELS} scope="features" />
      <Section title="Action Permissions" desc="Controls what this role can do across all accessible features." items={ACTION_LABELS} scope="actions" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UserSettingsScreen
// Data model: userProfile { userId, nickname, avatarEmoji, profilePicUrl }
//             notifPrefs  { quizAssigned, courseAssigned, lessonAssigned,
//                           gameResults, dueSoon, overdue }
// Production hook: replace localStorage reads/writes with API calls to
// /api/users/:id/profile and /api/users/:id/notification-prefs
// ─────────────────────────────────────────────────────────────────────────────
function UserSettingsScreen({ user, profile, notifPrefs, onSaveProfile, onSaveNotifs, currentOrg, onSignOut }) {
  // Local draft state so unsaved changes don't immediately affect the app
  const [nick,   setNick]   = useState(profile.nickname ?? "");
  const [avatar, setAvatar] = useState(profile.avatarEmoji ?? null);
  const [notifs, setNotifs] = useState({ ...notifPrefs });
  const [saved,  setSaved]  = useState(null); // "profile" | "notifs" | null

  const profileDirty = nick !== (profile.nickname ?? "") || avatar !== (profile.avatarEmoji ?? null);
  const notifsDirty  = JSON.stringify(notifs) !== JSON.stringify(notifPrefs);

  const saveProfile = () => {
    onSaveProfile({ nickname: nick.trim(), avatarEmoji: avatar, profilePicUrl: profile.profilePicUrl ?? null });
    setSaved("profile");
    setTimeout(() => setSaved(null), 2000);
  };

  const saveNotifs = () => {
    onSaveNotifs(notifs);
    setSaved("notifs");
    setTimeout(() => setSaved(null), 2000);
  };

  const toggle = (key) => setNotifs(prev => ({ ...prev, [key]: !prev[key] }));

  const NOTIF_ITEMS = [
    { key: "quizAssigned",    label: "Quiz assigned to me" },
    { key: "courseAssigned",  label: "Course assigned to me" },
    { key: "lessonAssigned",  label: "Lesson assigned to me" },
    { key: "gameResults",     label: "Game results and insights after a game" },
    { key: "dueSoon",         label: "Assignment due soon" },
    { key: "overdue",         label: "Assignment is overdue" },
  ];

  const roleLabel = { user: "Rep", orgAdmin: "Manager", superadmin: "ralli Admin" }[user.role] ?? user.role;

  const SectionHeader = ({ title, subtitle }) => (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>{title}</h2>
      {subtitle && <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSub }}>{subtitle}</p>}
    </div>
  );

  const inputStyle = {
    width: "100%", boxSizing: "border-box",
    padding: "10px 14px", borderRadius: 10,
    border: `1.5px solid ${C.border}`, background: C.cardBg,
    fontSize: 14, color: C.text, outline: "none",
    fontFamily: "inherit",
  };

  const readOnlyStyle = { ...inputStyle, background: C.pageBg, color: C.textSub, cursor: "default" };

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "32px 24px" }}>
      <h1 style={{ margin: "0 0 32px", fontSize: 22, fontWeight: 900, color: C.text }}>Settings</h1>

      {/* ── PROFILE ── */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader title="Profile" subtitle="Used across ralli and pre-filled when you join a game." />

        {/* Avatar row */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
            Game Avatar <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: C.textSub }}>(optional)</span>
          </label>
          <div style={{ maxHeight: 140, overflowY: "auto" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "2px 0" }}>
              {/* None option */}
              <button onClick={() => setAvatar(null)} style={{
                width: 44, height: 44, borderRadius: 12,
                border: `2px solid ${avatar === null ? C.orange : C.creamBorder}`,
                background: avatar === null ? C.orangeLight : C.cardBg,
                fontSize: 11, fontWeight: 700, color: avatar === null ? C.orange : C.textMuted,
                cursor: "pointer", flexShrink: 0,
              }}>None</button>
              {AVATARS.map(av => (
                <button key={av} onClick={() => setAvatar(av)} style={{
                  width: 44, height: 44, borderRadius: 12,
                  border: `2px solid ${avatar === av ? C.orange : C.creamBorder}`,
                  background: avatar === av ? C.orangeLight : C.cardBg,
                  fontSize: 24, cursor: "pointer", flexShrink: 0,
                }}>{av}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Nickname */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            Preferred Nickname
          </label>
          <input
            type="text" value={nick} maxLength={32}
            onChange={e => setNick(e.target.value)}
            placeholder={user.name}
            style={inputStyle}
          />
          <p style={{ margin: "6px 0 0", fontSize: 11, color: C.textMuted }}>
            Leave blank to use your real name ({user.name}).
          </p>
        </div>

        {/* Profile picture — placeholder for future upload */}
        <div style={{ marginBottom: 24, opacity: 0.5 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            Profile Picture
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 52, height: 52, borderRadius: "50%",
              background: user.color, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18, fontWeight: 800, color: "#fff", flexShrink: 0,
            }}>{user.initials}</div>
            <div>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: C.text }}>Photo upload coming soon</p>
              <p style={{ margin: "2px 0 0", fontSize: 12, color: C.textSub }}>Your initials avatar is used in the meantime.</p>
            </div>
          </div>
        </div>

        <button
          onClick={saveProfile}
          disabled={!profileDirty}
          style={{
            padding: "10px 20px", borderRadius: 10, border: "none",
            background: saved === "profile" ? C.trueGreen : profileDirty ? C.orange : C.muted,
            color: profileDirty || saved === "profile" ? "#fff" : C.textMuted,
            fontSize: 13, fontWeight: 700, cursor: profileDirty ? "pointer" : "not-allowed",
            transition: "all 0.15s",
          }}
        >
          {saved === "profile" ? "Saved" : "Save Profile"}
        </button>
      </Card>

      {/* ── NOTIFICATIONS ── */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader title="Notifications" subtitle="Choose which emails you receive from ralli." />
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {NOTIF_ITEMS.map(({ key, label }, i) => (
            <div key={key} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "14px 0",
              borderBottom: i < NOTIF_ITEMS.length - 1 ? `1px solid ${C.creamBorder}` : "none",
            }}>
              <span style={{ fontSize: 14, color: C.text }}>{label}</span>
              {/* Toggle */}
              <button onClick={() => toggle(key)} style={{
                width: 44, height: 24, borderRadius: 99, border: "none",
                background: notifs[key] ? C.orange : C.muted,
                cursor: "pointer", position: "relative", flexShrink: 0,
                transition: "background 0.2s",
              }}>
                <div style={{
                  position: "absolute", top: 3,
                  left: notifs[key] ? 23 : 3,
                  width: 18, height: 18, borderRadius: "50%", background: "#fff",
                  transition: "left 0.2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }} />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={saveNotifs}
          disabled={!notifsDirty}
          style={{
            marginTop: 20, padding: "10px 20px", borderRadius: 10, border: "none",
            background: saved === "notifs" ? C.trueGreen : notifsDirty ? C.orange : C.muted,
            color: notifsDirty || saved === "notifs" ? "#fff" : C.textMuted,
            fontSize: 13, fontWeight: 700, cursor: notifsDirty ? "pointer" : "not-allowed",
            transition: "all 0.15s",
          }}
        >
          {saved === "notifs" ? "Saved" : "Save Preferences"}
        </button>
      </Card>

      {/* ── ACCOUNT ── */}
      <Card>
        <SectionHeader title="Account" subtitle="Your account details. Contact your admin to make changes." />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[
            { label: "Name",    value: user.name },
            { label: "Email",   value: user.email },
            { label: "Role",    value: roleLabel },
            { label: "Company", value: currentOrg?.name ?? "—" },
          ].map(({ label, value }) => (
            <div key={label}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
                {label}
              </label>
              <input type="text" readOnly value={value} style={readOnlyStyle} />
            </div>
          ))}
        </div>
        {onSignOut && (
          <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${C.creamBorder}` }}>
            <button
              onClick={onSignOut}
              style={{
                padding: "10px 20px", borderRadius: 10, border: `1px solid ${C.border}`,
                background: "transparent", color: C.textMuted,
                fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = C.pageBg; e.currentTarget.style.color = C.text; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; }}
            >Sign out</button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── TOAST SYSTEM ──────────────────────────────────────────────────────────────
// Provider-free: module-level event bus so useToast() works from any component
// without a wrapping ToastProvider. Render <ToastContainer /> once at App root.

const _toastSubs = new Set();
let   _toastId   = 0;

function _emitToast(type, message) {
  const id = ++_toastId;
  _toastSubs.forEach(fn => fn({ id, type, message }));
}

function useToast() {
  return {
    success: (msg) => _emitToast("success", msg),
    error:   (msg) => _emitToast("error",   msg),
    warning: (msg) => _emitToast("warning", msg),
    info:    (msg) => _emitToast("info",    msg),
  };
}

const TOAST_CFG = {
  success: { bg: "#F0FDF4", border: "#86EFAC", fg: "#15803D", icon: "✓" },
  error:   { bg: "#FEF2F2", border: "#FCA5A5", fg: "#B91C1C", icon: "✕" },
  warning: { bg: "#FFFBEB", border: "#FCD34D", fg: "#92400E", icon: "!" },
  info:    { bg: "#EFF6FF", border: "#93C5FD", fg: "#1D4ED8", icon: "i" },
};

function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const sub = (t) => {
      setToasts(prev => [...prev, t]);
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== t.id)), 4000);
    };
    _toastSubs.add(sub);
    return () => _toastSubs.delete(sub);
  }, []);

  const dismiss = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  if (!toasts.length) return null;
  return (
    <>
      <style>{`@keyframes ralliToastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{
        position: "fixed", bottom: 24, right: 24, zIndex: 9999,
        display: "flex", flexDirection: "column", gap: 10,
        pointerEvents: "none",
      }}>
        {toasts.map(t => {
          const c = TOAST_CFG[t.type] ?? TOAST_CFG.info;
          return (
            <div key={t.id} role="alert" style={{
              pointerEvents: "auto",
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "11px 14px", borderRadius: 10,
              background: c.bg, border: `1px solid ${c.border}`,
              boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
              maxWidth: 360, minWidth: 240,
              animation: "ralliToastIn 0.2s ease",
              fontFamily: "'Plus Jakarta Sans',sans-serif",
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: "50%",
                background: c.border, color: c.fg,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 900, flexShrink: 0, marginTop: 1,
              }}>{c.icon}</span>
              <span style={{ flex: 1, fontSize: 13, lineHeight: 1.45, color: c.fg, fontWeight: 500 }}>
                {t.message}
              </span>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: c.fg, opacity: 0.45, padding: 0, fontSize: 14,
                  lineHeight: 1, flexShrink: 0, marginTop: 1,
                }}
              >✕</button>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── App Error Boundary ────────────────────────────────────────────────────────
// Prevents render crashes (e.g. undefined field access) from showing a blank page.
// Shows a recovery screen with the error message and a reload button instead.
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("[ralli] Render error:", error, info?.componentStack);
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#F9FAFB", fontFamily: "'Inter', sans-serif", padding: 24,
      }}>
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <div style={{ fontSize: 36, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: "#0B1220", margin: "0 0 8px" }}>Something went wrong</h2>
          <p style={{ fontSize: 14, color: "#64748B", margin: "0 0 24px" }}>
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "10px 24px", borderRadius: 8, border: "none", cursor: "pointer", background: "#F97316", color: "#fff", fontSize: 14, fontWeight: 700 }}
          >Reload</button>
        </div>
      </div>
    );
  }
}

export default function App() {
  React.useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&display=swap";
    document.head.appendChild(link);
    document.body.style.fontFamily = "'Plus Jakarta Sans', sans-serif";
  }, []);
  const mobile = useMobile();
  const toast  = useToast();
  const [currentUser,      setCurrentUser]      = useState(null);
  const [lastSeenAt,       setLastSeenAt]       = useState(null);   // ISO string from profiles.last_seen_assignments_at
  const [newAssignmentCount, setNewAssignmentCount] = useState(0);  // drives "Learn" nav badge
  // Password-recovery mode — true when the user opened a Supabase recovery link.
  // Initialized synchronously from the URL so it's set before getSession() resolves,
  // preventing the recovery session from being treated as a normal login.
  // recoveryRef gives the getSession() closure a stable reference that doesn't go stale.
  const recoveryRef = useRef(
    window.location.hash.includes("type=recovery") ||
    new URLSearchParams(window.location.search).get("type") === "recovery"
  );
  const [recoveryMode, setRecoveryMode] = useState(recoveryRef.current);
  const [screen,           setScreen]           = useState("home");
  const [sessions,         setSessions]         = useState(INITIAL_SESSIONS);
  const [lobbyPin,         setLobbyPin]         = useState(null);
  const [lobbySessionName, setLobbySessionName] = useState(null);
  const [lobbyPlayerName,  setLobbyPlayerName]  = useState(null);
  const [lobbyPlayerEmoji, setLobbyPlayerEmoji] = useState(null);
  const [viewResultsCode,  setViewResultsCode]  = useState(null);
  const [gameResultsData,  setGameResultsData]  = useState(null);
  const [gameQuestions,    setGameQuestions]    = useState(null);
  const [editingQuiz,      setEditingQuiz]      = useState(null);
  // Deep-link pending actions from HomeScreen
  const [pendingLessonId,  setPendingLessonId]  = useState(null);
  const [pendingCourseId,  setPendingCourseId]  = useState(null);
  const [pendingQuizId,    setPendingQuizId]    = useState(null);
  const deletingQuizIdsRef = useRef(new Set()); // tracks IDs with an in-flight DB delete
  const [orgs,             setOrgs]             = useState(INITIAL_ORGS);
  const [orgUsers,         setOrgUsers]         = useState(INITIAL_ORG_USERS);
  const [selectedOrg,      setSelectedOrg]      = useState(null);
  const [inviteToken,      setInviteToken]      = useState(() => {
    const m = window.location.pathname.match(/^\/invite\/([a-f0-9]{64})$/);
    return m ? m[1] : null;
  });
  // User profile prefs — production hook: replace with API /api/users/:id/profile
  const [userProfile, setUserProfile] = useState(() => {
    try {
      const saved = localStorage.getItem(`ralli_profile_${currentUser?.id ?? "guest"}`);
      return saved ? JSON.parse(saved) : { nickname: "", avatarEmoji: null, profilePicUrl: null };
    } catch { return { nickname: "", avatarEmoji: null, profilePicUrl: null }; }
  });

  // Notification prefs — production hook: replace with API /api/users/:id/notification-prefs
  const DEFAULT_NOTIF_PREFS = { quizAssigned: true, courseAssigned: true, lessonAssigned: true, gameResults: true, dueSoon: true, overdue: true };
  const [notifPrefs, setNotifPrefs] = useState(() => {
    try {
      const saved = localStorage.getItem(`ralli_notifs_${currentUser?.id ?? "guest"}`);
      return saved ? { ...DEFAULT_NOTIF_PREFS, ...JSON.parse(saved) } : DEFAULT_NOTIF_PREFS;
    } catch { return DEFAULT_NOTIF_PREFS; }
  });

  // Stable player ID for this session
  const [playerId] = useState(() => Math.random().toString(36).slice(2));

  // Quizzes — demo users: persist to localStorage; real users: Supabase only
  const [quizzes, setQuizzes] = useState(() => {
    try {
      const saved = localStorage.getItem("ralli_quizzes");
      return saved ? JSON.parse(saved) : SAMPLE_QUIZZES;
    } catch { return SAMPLE_QUIZZES; }
  });
  // True once getTenantQuizzes has resolved for the current real user session.
  // QuizzesScreen waits for this before merging assignments so the race is avoided.
  const [quizzesReady, setQuizzesReady] = useState(false);

  // Battle card categories — demo: localStorage; real users: Supabase tenant_bc_categories
  const [bcCategories, setBcCategories] = useState(() => {
    if (/* real user check deferred to useEffect */ false) return [];
    try {
      const saved = localStorage.getItem("ralli_bc_categories");
      return saved ? JSON.parse(saved) : INITIAL_BC_CATEGORIES;
    } catch { return INITIAL_BC_CATEGORIES; }
  });

  // Battle cards — demo: localStorage; real users: Supabase tenant_battle_cards
  const [battleCards, setBattleCards] = useState(() => {
    try {
      const saved = localStorage.getItem("ralli_battle_cards");
      return saved ? JSON.parse(saved) : INITIAL_BATTLE_CARDS;
    } catch { return INITIAL_BATTLE_CARDS; }
  });
  // Loading flag for BattleCardsScreen — true while Supabase BC fetch is in flight.
  const [bcLoading, setBcLoading] = useState(false);

  // BC data loaded after const user/currentOrg are declared (see useEffect below line 13866)

  const user = currentUser;
  const role = user?.role;
  // isRalliAdmin() handles both "superadmin" (legacy) and "ralli_admin" (canonical).
  // Production: role comes from JWT claims — update to "ralli_admin" when migrating.
  const isSuperAdmin = isRalliAdmin(role);
  const isOrgAdmin   = role === "orgAdmin";
  const isAdminType  = isSuperAdmin || isOrgAdmin; // any admin-type user
  const currentOrg   = orgs.find(o => o.id === user?.orgId) ?? null;
  // Normalized role for game/lobby screens — they only need "admin" vs "user"
  const gameRole = isAdminType ? "admin" : "user";
  // Effective plan for feature gating. Superadmins always get enterprise access.
  // Production hook: replace with billing provider plan lookup (e.g. Stripe subscription).
  const userPlan = isSuperAdmin ? "enterprise" : normalizePlan(currentOrg?.plan);

  // Tenant feature_access overrides — loaded from tenant_settings for real users.
  // Ralli Admin can toggle these per-tenant; they override the plan-based defaults.
  const [tenantFeatureAccess, setTenantFeatureAccess] = useState(null); // null = not yet loaded

  // ── Load BC data from Supabase for real users ─────────────────────────────
  // Placed here so user + currentOrg are already declared above.
  // Clear demo/localStorage data immediately so real users never see seed categories,
  // even if the DB call fails — empty state is safer than misleading demo content.
  useEffect(() => {
    const tid = currentOrg?.id ?? user?.orgId ?? null;
    if (!user?._isReal || !tid) return;
    setBcCategories([]);  // clear seed immediately; DB result fills in below
    setBattleCards([]);
    setBcLoading(true);
    Promise.allSettled([
      getTenantBcCategories(tid).then(({ data }) => { if (data) setBcCategories(data); }),
      getTenantBattleCards(tid).then(({ data }) => { if (data) setBattleCards(data); }),
    ]).finally(() => setBcLoading(false));
  }, [user?._isReal, currentOrg?.id, user?.orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map NAV featureKey → tenant_settings.feature_access key
  const FEATURE_KEY_MAP = { games: "games", learn: "learn", leaderboard: "learn", progress: "analytics", battlecards: "battle_cards", quizzes: "learn", dashboard: null };

  // Feature access check: tenant_settings overrides take priority over plan defaults.
  // Superadmin and demo accounts bypass overrides.
  const canAccessTenant = (featureKey) => {
    if (isSuperAdmin) return true;
    const settKey = FEATURE_KEY_MAP[featureKey];
    if (settKey && tenantFeatureAccess !== null && settKey in tenantFeatureAccess) {
      return !!tenantFeatureAccess[settKey];
    }
    return canAccess(featureKey, userPlan);
  };

  // Role permissions — admin-controlled, org-scoped, localStorage-backed.
  // Production hook: replace loadRolePermissions with API fetch on mount.
  const [rolePermissions, setRolePermissions] = useState(() =>
    loadRolePermissions(currentOrg?.id)
  );

  const handleSaveRolePermissions = (updated) => {
    setRolePermissions(updated);
    saveRolePermissions(currentOrg?.id, updated); // localStorage — demo users + offline fallback
    if (user?._isReal && currentOrg?.id) {
      supabase.from("tenant_settings")
        .update({ role_permissions: updated })
        .eq("tenant_id", currentOrg.id)
        .then(({ error }) => {
          if (error) { console.error("[ralli] save rolePermissions failed:", error); toast.error("Failed to save permissions."); }
          else { toast.success("Permissions saved."); }
        });
    } else {
      toast.success("Permissions saved.");
    }
  };

  // Convenience: check permission for the current user's role.
  // Superadmin always passes. Use this throughout the render tree.
  const perm = (scope, key) => hasPermission(rolePermissions, role, scope, key);

  const navigate = (s) => setScreen(s);

  // ── Supabase Auth session restore ─────────────────────────────────────────
  // On mount: check for an existing Supabase session (survives page refresh).
  // Also subscribe to auth state changes so sign-out clears the user globally.
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      // If a recovery link was opened, do not log the user in normally.
      // The PASSWORD_RECOVERY event (below) owns this flow.
      if (recoveryRef.current) return;
      if (session?.user && !currentUser) {
        let profile = await getProfile(session.user.id);
        if (!profile) profile = await createMissingProfile(session.user);
        if (profile) {
          // Load real XP, level, xpNext, streak from user_point_events (canonical source)
          if (profile.orgId) {
            getLeaderboard(profile.orgId, profile.id).then(({ data }) => {
              const row = data?.find(r => r.userId === profile.id || r.id === profile.id);
              if (row?.total != null) {
                const { level, xpNext } = computeUserMeta(row.total);
                setCurrentUser(prev => prev ? { ...prev, xp: row.total, level, xpNext } : prev);
              }
            }).catch(() => {});
            getUserStreak(profile.orgId, profile.id).then(streak => {
              setCurrentUser(prev => prev ? { ...prev, streak } : prev);
            }).catch(() => {});
          }
          // Pre-compute level/xpNext from profile.xp so first render is consistent.
          // Async patches (getLeaderboard, getUserStreak) will update with real values.
          const { level: profileLevel, xpNext: profileXpNext } = computeUserMeta(profile.xp ?? 0);
          setCurrentUser({ ...profile, level: profileLevel, xpNext: profileXpNext });
          // Seed last-seen timestamp for assignment "NEW" badge logic
          setLastSeenAt(profile.lastSeenAssignmentsAt ?? null);
          if (isRalliAdmin(profile.role)) {
            setScreen("organizations");
            setOrgs([]); // clear seed/mock orgs — ralli admin sees only real Supabase tenants
            supabase.from("tenants").select("*").order("created_at", { ascending: false })
              .then(({ data }) => { setOrgs(data ? data.map(t => ({ ...t, adminEmail: t.admin_email, seatLimit: t.seat_limit ?? 10, seats: t.seat_limit ?? 10, createdAt: t.created_at?.split("T")[0], updatedAt: t.updated_at?.split("T")[0] })) : []); });
          } else if (profile.role === "orgAdmin") {
            // Check tenant status — if still onboarding, show setup; otherwise go to team
            if (profile.orgId) {
              const { data: tenant } = await supabase.from("tenants").select("status").eq("id", profile.orgId).single();
              setScreen(tenant?.status === "onboarding" ? "org-setup" : "team");
            } else {
              setScreen("home");
            }
          } else {
            setScreen("home");
          }
        }
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "PASSWORD_RECOVERY") {
        // User opened a valid recovery link. Lock the UI to the reset form.
        // Don't log them into the normal app — they must set a new password first.
        recoveryRef.current = true;
        setRecoveryMode(true);
        return;
      }
      if (event === "SIGNED_OUT") {
        setCurrentUser(null);
        setLastSeenAt(null);
        setNewAssignmentCount(0);
        setPendingLessonId(null);  // clear any in-flight deep-link nav from prior session
        setPendingCourseId(null);
        setPendingQuizId(null);
        setOrgs(INITIAL_ORGS);     // restore seed tenants so demo accounts work
        setOrgUsers(INITIAL_ORG_USERS);
        setQuizzesReady(false);    // reset so next real user waits for their quiz load
        setSessions(INITIAL_SESSIONS);           // prevent real sessions leaking to next demo user
        setBattleCards(INITIAL_BATTLE_CARDS);    // prevent real BC data leaking to next demo user
        setBcCategories(INITIAL_BC_CATEGORIES);  // prevent real BC categories leaking to next demo user
        window.location.replace("/login");        // hard-navigate so URL matches the login screen
      }
    });

    return () => subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load Supabase content for real users on login ──────────────────────────
  // Fires when a real (Supabase-authenticated) user logs in.
  // Replaces INITIAL_SESSIONS with their tenant's real sessions.
  // Replaces localStorage quizzes with their tenant's quizzes from DB.
  // Demo users keep INITIAL_SESSIONS and localStorage quizzes.
  useEffect(() => {
    if (!currentUser?._isReal) return;
    const tenantId = currentUser.orgId ?? null;
    if (!tenantId) return;

    // Sessions
    getActiveSessions(tenantId).then(({ data }) => {
      if (data) setSessions(data);
    });

    // Quizzes — real users: clear seed/demo data immediately, then load from Supabase.
    // Clearing prevents demo quiz flash while the DB fetch is in-flight.
    // setQuizzesReady(true) signals QuizzesScreen that quizzes are resolved so it
    // can safely merge quiz assignments without hitting a race condition.
    setQuizzes([]);
    getTenantQuizzes(tenantId).then(({ data, error }) => {
      if (error) console.error("[ralli] getTenantQuizzes failed:", error);
      if (data !== null) setQuizzes(data);
      setQuizzesReady(true); // signal even on error so QuizzesScreen doesn't hang
    });

    // Profile prefs — load from Supabase (nickname, avatarEmoji, notifPrefs)
    // BC data is loaded in a separate useEffect keyed on currentOrg.id
    supabase.from("profiles")
      .select("nickname, avatar_emoji, profile_pic_url, notif_prefs")
      .eq("id", currentUser.id)
      .single()
      .then(({ data: p }) => {
        if (!p) return;
        if (p.nickname || p.avatar_emoji || p.profile_pic_url) {
          setUserProfile(prev => ({
            ...prev,
            ...(p.nickname        ? { nickname:      p.nickname }        : {}),
            ...(p.avatar_emoji    ? { avatarEmoji:   p.avatar_emoji }    : {}),
            ...(p.profile_pic_url ? { profilePicUrl: p.profile_pic_url } : {}),
          }));
        }
        if (p.notif_prefs && typeof p.notif_prefs === "object") {
          setNotifPrefs(prev => ({ ...prev, ...p.notif_prefs }));
        }
      })
      .catch(e => console.error("[ralli] load profile prefs failed:", e));

    // Feature access + role permissions — load from tenant_settings for real users.
    // role_permissions was localStorage-only; now persisted in the DB column added in migration 004.
    supabase.from("tenant_settings").select("feature_access, role_permissions").eq("tenant_id", tenantId).single()
      .then(({ data: ts }) => {
        if (ts?.feature_access) setTenantFeatureAccess(ts.feature_access);
        // Deep-merge: DB values take precedence, but any new default keys are always present.
        if (ts?.role_permissions && Object.keys(ts.role_permissions).length > 0) {
          const db = ts.role_permissions;
          setRolePermissions({
            user: {
              features: { ...DEFAULT_ROLE_PERMISSIONS.user.features,     ...(db.user?.features    ?? {}) },
              actions:  { ...DEFAULT_ROLE_PERMISSIONS.user.actions,      ...(db.user?.actions     ?? {}) },
            },
            orgAdmin: {
              features: { ...DEFAULT_ROLE_PERMISSIONS.orgAdmin.features, ...(db.orgAdmin?.features ?? {}) },
              actions:  { ...DEFAULT_ROLE_PERMISSIONS.orgAdmin.actions,  ...(db.orgAdmin?.actions  ?? {}) },
            },
          });
        }
      });
  }, [currentUser?.id, currentUser?._isReal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load orgAdmin's own tenant into orgs[] ────────────────────────────────
  // Root cause fix: both login paths only fetched tenant.status, never the full row.
  // Without this, orgs.find(o => o.id === user.orgId) returns null → currentOrg = null
  // → userPlan = "demo" → Starter nav items hidden.
  // This effect fires on every login (session restore or fresh login) and ensures
  // the orgAdmin's tenant is always present in orgs[] with its real plan.
  useEffect(() => {
    if (!currentUser?._isReal || currentUser.role !== "orgAdmin" || !currentUser.orgId) return;
    if (orgs.find(o => o.id === currentUser.orgId)) return; // already loaded
    supabase.from("tenants").select("*").eq("id", currentUser.orgId).single()
      .then(({ data: t }) => {
        if (!t) return;
        const norm = { ...t, adminEmail: t.admin_email, seatLimit: t.seat_limit ?? 10, seats: t.seat_limit ?? 10, createdAt: t.created_at?.split("T")[0], updatedAt: t.updated_at?.split("T")[0] };
        setOrgs(prev => [norm, ...prev.filter(o => o.id !== t.id)]);
      });
  }, [currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load tenant + orgUsers for all real users ────────────────────────────
  // Runs for any _isReal user (role=user, orgAdmin, etc.) so that orgUsers
  // is populated for HomeScreen leaderboard, InsightsScreen, and Assign modals.
  useEffect(() => {
    if (!currentUser?._isReal || !currentUser.orgId) return;
    const tenantId = currentUser.orgId;

    // Load tenant row → currentOrg, userPlan
    if (!orgs.find(o => o.id === tenantId)) {
      supabase.from("tenants").select("*").eq("id", tenantId).single()
        .then(({ data: t }) => {
          if (!t) return;
          const norm = { ...t, adminEmail: t.admin_email, seatLimit: t.seat_limit ?? 10, seats: t.seat_limit ?? 10, createdAt: t.created_at?.split("T")[0], updatedAt: t.updated_at?.split("T")[0] };
          setOrgs(prev => [norm, ...prev.filter(o => o.id !== t.id)]);
        });
    }

    // Load tenant members → orgUsers (for leaderboard, assign screens, etc.)
    // XP is loaded from profiles first (fast), then patched from user_point_events (canonical).
    supabase.from("profiles").select("*").eq("tenant_id", tenantId).neq("status", "inactive")
      .then(({ data: members }) => {
        if (!members?.length) return;
        const realMembers = members.map(m => ({
          id: m.id, email: m.email,
          name: m.name ?? m.email?.split("@")[0] ?? "User",
          initials: (m.name ?? m.email ?? "U").split(" ").map(p => p[0] ?? "").join("").toUpperCase().slice(0, 2) || "U",
          role: m.role ?? "user",
          orgId: m.tenant_id,
          teamId: m.team_id ?? null,
          color: m.color ?? "#F97316",
          xp: m.xp ?? 0,  // patched below from user_point_events
          streak: m.streak ?? 0,
          status: m.status ?? "active",
          _isReal: true,
        }));
        // Replace any seed members from this tenant, keep members from other (seed) tenants
        setOrgUsers(prev => [
          ...prev.filter(u => u.orgId !== tenantId && !u._isReal),
          ...realMembers,
        ]);
        // Patch XP from user_point_events (canonical source; profiles.xp is stale)
        getLeaderboard(tenantId).then(({ data: lbRows }) => {
          if (!lbRows?.length) return;
          const xpMap = Object.fromEntries(lbRows.map(r => [r.userId, r.total]));
          setOrgUsers(prev => prev.map(u =>
            u.orgId === tenantId && u._isReal && xpMap[u.id] != null
              ? { ...u, xp: xpMap[u.id] }
              : u
          ));
        }).catch(e => console.error("[ralli] orgUsers XP patch failed:", e));
      });
  }, [currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Refresh active sessions when user opens the Games screen ─────────────────
  // Sessions are loaded once at login, but a manager may create a session after
  // the user has already logged in. This effect re-queries Supabase each time
  // the user navigates to "rankd" so the active sessions list stays current.
  // Also polls every 10s while on that screen to pick up newly launched sessions.
  // Scoped to real users only — demo users use INITIAL_SESSIONS.
  useEffect(() => {
    if (screen !== "rankd" || !currentUser?._isReal || !currentUser.orgId) return;
    const tenantId = currentUser.orgId;

    const refresh = () => {
      getActiveSessions(tenantId).then(({ data, error }) => {
        if (error) console.error("[ralli:game] getActiveSessions error:", error);
        if (data) setSessions(data);
      });
    };

    refresh(); // immediate on screen entry
    const interval = setInterval(refresh, 10000); // poll every 10s
    return () => clearInterval(interval);
  }, [screen, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // BroadcastChannel — only active when a game is running
  const isInGame = ["rankd-lobby", "rankd-game"].includes(screen);
  const { chPlayers, chAnswers, setChAnswers, chMsg, broadcast } = useGameChannel(isInGame ? lobbyPin : null, gameRole);

  // Recovery mode takes priority over normal routing — show the reset form regardless
  // of whether a session exists. This prevents the app from routing past the form if
  // getSession() resolved before the PASSWORD_RECOVERY event fired.
  if (recoveryMode) {
    return (
      <ResetPasswordScreen onSuccess={() => {
        recoveryRef.current = false;
        setRecoveryMode(false);
        // SIGNED_OUT from signOut() inside ResetPasswordScreen clears the rest of the state
      }} />
    );
  }

  if (!currentUser) {
    const handleLogin = (u) => {
      setCurrentUser(u);
      if (isRalliAdmin(u.role)) {
        setScreen("organizations");
        setOrgs([]); // clear seed/mock orgs immediately — ralli admin sees only real tenants
        supabase.from("tenants").select("*").order("created_at", { ascending: false })
          .then(({ data }) => { setOrgs(data ? data.map(t => ({ ...t, adminEmail: t.admin_email, seatLimit: t.seat_limit ?? 10, seats: t.seat_limit ?? 10, createdAt: t.created_at?.split("T")[0], updatedAt: t.updated_at?.split("T")[0] })) : []); });
      } else if (u.role === "orgAdmin") {
        if (u._isReal) {
          // Real org admin from Supabase — check tenant status
          supabase.from("tenants").select("status").eq("id", u.orgId).single()
            .then(({ data: tenant }) => {
              setScreen(tenant?.status === "onboarding" ? "org-setup" : "home");
            })
            .catch(() => setScreen("home"));
        } else {
          // Demo seed org admin — go straight to home
          setScreen("home");
        }
      } else {
        setScreen("home");
      }
    };
    if (inviteToken) {
      return <InviteScreen token={inviteToken} onSuccess={(u) => {
        setInviteToken(null);
        window.history.replaceState(null, "", "/");
        handleLogin(u);
      }} />;
    }
    return <LoginScreen onLogin={handleLogin} users={orgUsers} />;
  }

  const handleInviteOrg = async (org) => {
    // Optimistic update — UI feels instant
    const tempId = org.id ?? `org_temp_${Date.now()}`;
    const optimistic = { ...org, id: tempId, status: "invited" };
    setOrgs(prev => [optimistic, ...prev]);

    if (!user?._isReal || !isSuperAdmin) return null;

    try {
      // Run full provisioning workflow (atomic DB transaction via provision_tenant RPC)
      const result = await provisionTenant({
        name:       org.name,
        slug:       org.slug,
        plan:       org.plan ?? "starter",
        adminEmail: org.adminEmail,
        seatLimit:  org.seatLimit ?? org.seats ?? 10,
        domain:     org.domain ?? null,
      });

      // Fetch the created tenant row for display normalization
      const { data: tenantRow } = await supabase
        .from("tenants")
        .select("*")
        .eq("id", result.tenantId)
        .single();

      const normalized = normalizeProvisionedOrg(result, tenantRow);
      setOrgs(prev => prev.map(o => o.id === tempId ? normalized : o));

      // Attempt to send invite email — non-blocking, provisioning always succeeds
      let emailSent = false;
      let emailError = null;
      try {
        await sendInviteEmail({ to: org.adminEmail, orgName: org.name, inviteUrl: result.inviteUrl });
        emailSent = true;
      } catch (emailErr) {
        console.warn("[ralli] Invite email failed:", emailErr.message);
        emailError = emailErr.message;
      }

      return { inviteUrl: result.inviteUrl, emailSent, emailError };
    } catch (err) {
      console.error("[ralli] provisionTenant failed:", err);
      // Revert optimistic entry on failure
      setOrgs(prev => prev.filter(o => o.id !== tempId));
      throw err;
    }
  };

  const handleAddUser = (newUser) => {
    setOrgUsers(prev => [...prev, newUser]);
  };

  const handleRefreshOrgs = () => {
    supabase.from("tenants").select("*").order("created_at", { ascending: false })
      .then(({ data }) => { setOrgs(data ? data.map(t => ({ ...t, adminEmail: t.admin_email, seatLimit: t.seat_limit ?? 10, seats: t.seat_limit ?? 10, createdAt: t.created_at?.split("T")[0], updatedAt: t.updated_at?.split("T")[0] })) : []); });
  };

  // UUID guard — seed/demo orgs have string IDs like "org_momence" which Postgres rejects as uuid type
  const isRealTenantId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  const handleDeactivateOrg = async (orgId) => {
    if (!isRealTenantId(orgId)) throw new Error("This organization is a demo record and cannot be modified.");
    const { error } = await supabase.rpc("deactivate_tenant", { p_tenant_id: orgId });
    if (error) { console.error("[ralli] deactivate_tenant failed:", error); throw error; }
    setOrgs(prev => prev.map(o => o.id === orgId ? { ...o, status: "suspended" } : o));
  };

  const handleReactivateOrg = async (orgId) => {
    if (!isRealTenantId(orgId)) throw new Error("This organization is a demo record and cannot be modified.");
    const { error } = await supabase.rpc("reactivate_tenant", { p_tenant_id: orgId });
    if (error) { console.error("[ralli] reactivate_tenant failed:", error); throw error; }
    setOrgs(prev => prev.map(o => o.id === orgId ? { ...o, status: "active" } : o));
  };

  const handleDeleteOrg = async (orgId) => {
    if (!isRealTenantId(orgId)) throw new Error("This organization is a demo record and cannot be deleted.");
    const { error } = await supabase.rpc("delete_tenant", { p_tenant_id: orgId });
    if (error) { console.error("[ralli] delete_tenant failed:", error); throw error; }
    setOrgs(prev => prev.filter(o => o.id !== orgId));
    if (selectedOrg?.id === orgId) setSelectedOrg(null);
  };

  // JS mirror of get_plan_features() SQL function — keeps feature defaults in sync
  // without requiring the update_tenant RPC. Update both when plan tiers change.
  const getPlanFeaturesJS = (plan) => {
    const p = (plan ?? "").toLowerCase();
    if (p === "starter")    return { games: true,  learn: true, quizzes: true, battle_cards: false, analytics: false, integrations: false, custom_branding: false };
    if (p === "growth")     return { games: true,  learn: true, quizzes: true, battle_cards: true,  analytics: true,  integrations: false, custom_branding: false };
    if (p === "enterprise") return { games: true,  learn: true, quizzes: true, battle_cards: true,  analytics: true,  integrations: true,  custom_branding: true  };
    return                         { games: true,  learn: true, quizzes: false, battle_cards: false, analytics: false, integrations: false, custom_branding: false };
  };

  // Cancel org — sets status to 'canceled'.
  // Uses direct table update (update_tenant RPC may not be deployed yet).
  const handleCancelOrg = async (orgId) => {
    if (!isRealTenantId(orgId)) throw new Error("This organization is a demo record and cannot be modified.");
    const { error } = await supabase.from("tenants")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("id", orgId);
    if (error) { console.error("[ralli] cancel_org failed:", error); throw error; }
    setOrgs(prev => prev.map(o => o.id === orgId ? { ...o, status: "canceled" } : o));
  };

  const handleUpdateOrg = async (orgId, fields) => {
    // Use update_tenant RPC (migration 009) — SECURITY DEFINER, accepts both
    // 'ralli_admin' and 'superadmin' role aliases, and handles feature_access
    // reset atomically when plan changes. NULL params leave fields unchanged.
    const { data: result, error } = await supabase.rpc("update_tenant", {
      p_tenant_id:   orgId,
      p_name:        fields.name       != null ? (fields.name.trim() || null)                          : null,
      p_plan:        fields.plan       != null ? fields.plan.toLowerCase()                              : null,
      p_seat_limit:  fields.seatLimit  != null ? (parseInt(fields.seatLimit) || null)                  : null,
      p_status:      fields.status     != null ? fields.status                                          : null,
      p_domain:      fields.domain    !== undefined ? (fields.domain?.trim() ?? null)                  : null,
      p_admin_email: fields.adminEmail !== undefined ? (fields.adminEmail?.trim().toLowerCase() || null): null,
    });
    if (error) { console.error("[ralli] update_tenant RPC failed:", error); throw error; }

    // result is the JSONB object returned by the RPC:
    // { tenantId, name, plan, seatLimit, status, domain, adminEmail, updatedAt }
    setOrgs(prev => prev.map(o => o.id === orgId ? {
      ...o,
      name:       result.name       ?? o.name,
      plan:       result.plan ? (result.plan.charAt(0).toUpperCase() + result.plan.slice(1)) : o.plan,
      seats:      result.seatLimit  ?? o.seats,
      seatLimit:  result.seatLimit  ?? o.seatLimit,
      status:     result.status     ?? o.status,
      domain:     result.domain     ?? o.domain,
      adminEmail: result.adminEmail ?? o.adminEmail,
    } : o));

    return {
      tenantId:   result.tenantId,
      name:       result.name,
      plan:       result.plan,
      seatLimit:  result.seatLimit,
      status:     result.status,
      domain:     result.domain,
      adminEmail: result.adminEmail,
    };
  };

  const handleUpdateMember = async (profileId, fields) => {
    const { data, error } = await supabase.rpc("update_member", {
      p_profile_id: profileId,
      p_name:   fields.name   ?? null,
      p_role:   fields.role   ?? null,
      p_status: fields.status ?? null,
    });
    if (error) { console.error("[ralli] update_member failed:", error); throw error; }
    // RPC succeeded — sync App-level orgUsers with the canonical values it returned.
    // Only runs on success; the throw above prevents reaching this on failure.
    if (data) {
      setOrgUsers(prev => prev.map(u => u.id === profileId ? {
        ...u,                          // preserve all fields not touched by this update
        name:   data.name   ?? u.name,
        role:   data.role   ?? u.role,
        status: data.status ?? u.status,
      } : u));
    }
    return data;
  };

  const handleRemoveMember = async (profileId) => {
    const { error } = await supabase.rpc("remove_member", { p_profile_id: profileId });
    if (error) { console.error("[ralli] remove_member failed:", error); throw error; }
    // RPC succeeded — remove the user from App-level orgUsers immediately.
    // Only runs on success; the throw above prevents reaching this on failure.
    setOrgUsers(prev => prev.filter(u => u.id !== profileId));
  };

  const handleCancelInvite = async (invitationId) => {
    const { error } = await supabase.rpc("cancel_member_invite", { p_invitation_id: invitationId });
    if (error) { console.error("[ralli] cancel_member_invite failed:", error); throw error; }
  };

  const handleResendMemberInvite = async (invitationId) => {
    const { data, error } = await supabase.rpc("resend_member_invite", { p_invitation_id: invitationId });
    if (error) { console.error("[ralli] resend_member_invite failed:", error); throw error; }
    return data;
  };

  // ── XP award — updates in-memory state only.
  // Source of truth for XP is user_point_events (written by scoringService).
  // profiles.xp is legacy — do not write it to avoid divergence with game points.
  const handleAwardXp = (amount) => {
    if (!amount || !currentUser) return;
    const newXp = (currentUser.xp || 0) + amount;
    const { level, xpNext } = computeUserMeta(newXp);
    setCurrentUser(prev => prev ? { ...prev, xp: newXp, level, xpNext } : prev);
  };

  const handleSaveProfile = (updated) => {
    const next = { ...userProfile, ...updated };
    setUserProfile(next);
    try { localStorage.setItem(`ralli_profile_${user.id}`, JSON.stringify(next)); } catch {}
    // Persist to Supabase for real users so prefs survive across devices/sessions
    if (user?._isReal && user.id) {
      dbUpdateUserProfile(user.id, {
        nickname:      updated.nickname      ?? userProfile.nickname,
        avatarEmoji:   updated.avatarEmoji   ?? userProfile.avatarEmoji,
        profilePicUrl: updated.profilePicUrl ?? userProfile.profilePicUrl,
      }).catch(e => console.error("[ralli] updateUserProfile failed:", e));
    }
  };

  const handleSaveNotifs = (updated) => {
    setNotifPrefs(updated);
    try { localStorage.setItem(`ralli_notifs_${user.id}`, JSON.stringify(updated)); } catch {}
    // Persist to Supabase for real users
    if (user?._isReal && user.id) {
      dbUpdateUserProfile(user.id, { notifPrefs: updated })
        .catch(e => console.error("[ralli] updateUserProfile (notifPrefs) failed:", e));
    }
  };

  // ── Battle card category CRUD ──
  const bcCatKey   = currentOrg?.id ? `ralli_bc_categories_${currentOrg.id}` : "ralli_bc_categories";
  const bcCardsKey = currentOrg?.id ? `ralli_bc_cards_${currentOrg.id}`      : "ralli_battle_cards";

  const handleSaveBcCategory = async (cat) => {
    const tid = currentOrg?.id ?? user?.orgId ?? null;
    if (user?._isReal && tid) {
      const { data, error } = await dbSaveBcCategory(tid, cat, user.id);
      if (error) { console.error("[ralli] saveBcCategory failed:", error); toast.error("Failed to save category. Please try again."); return null; }
      // data may be null if RLS blocks SELECT after INSERT; treat as success and use local cat shape
      const canonical = data ?? { ...cat, id: cat.id };
      setBcCategories(prev => {
        const byRealId = data ? prev.find(c => c.id === data.id) : null;
        const byTempId = prev.find(c => c.id === cat.id);
        if (byRealId) return prev.map(c => c.id === canonical.id ? canonical : c);
        if (byTempId) return prev.map(c => c.id === cat.id ? canonical : c);
        return [...prev, canonical];
      });
      toast.success("Category saved.");
      return canonical;
    }
    // Demo fallback
    const canonical = cat;
    setBcCategories(prev => {
      const next = prev.find(c => c.id === cat.id) ? prev.map(c => c.id === cat.id ? canonical : c) : [...prev, canonical];
      try { localStorage.setItem(bcCatKey, JSON.stringify(next)); } catch {}
      return next;
    });
    toast.success("Category saved.");
    return canonical;
  };
  const handleDeleteBcCategory = async (id) => {
    const tid = currentOrg?.id ?? user?.orgId ?? null;
    if (user?._isReal && tid) {
      const { error } = await dbDeleteBcCategory(tid, id);
      if (error) { console.error("[ralli] deleteBcCategory failed:", error); toast.error("Failed to delete category. Please try again."); return; }
    }
    setBcCategories(prev => {
      const next = prev.filter(c => c.id !== id);
      if (!user?._isReal) { try { localStorage.setItem(bcCatKey, JSON.stringify(next)); } catch {} }
      return next;
    });
    toast.success("Category deleted.");
  };

  // ── Battle card CRUD ──
  const handleSaveBattleCard = async (card) => {
    const tid = currentOrg?.id ?? user?.orgId ?? null;
    if (user?._isReal && tid) {
      const { data, error } = await dbSaveBattleCard(tid, card, user.id);
      if (error) { console.error("[ralli] saveBattleCard failed:", error); toast.error("Failed to save battle card. Please try again."); return false; }
      if (data) {
        setBattleCards(prev => prev.find(c => c.id === data.id) ? prev.map(c => c.id === data.id ? data : c) : [...prev, data]);
        toast.success("Battle card saved.");
        return true;
      }
      // !error && !data — silent RLS block or schema mismatch
      console.error("[ralli] saveBattleCard: no data returned (possible RLS block or missing row)");
      toast.error("Failed to save battle card. Please try again.");
      return false;
    }
    // Demo fallback
    setBattleCards(prev => {
      const next = prev.find(c => c.id === card.id) ? prev.map(c => c.id === card.id ? card : c) : [...prev, card];
      try { localStorage.setItem(bcCardsKey, JSON.stringify(next)); } catch {}
      return next;
    });
    toast.success("Battle card saved.");
    return true;
  };
  const handleDeleteBattleCard = async (id) => {
    const tid = currentOrg?.id ?? user?.orgId ?? null;
    if (user?._isReal && tid) {
      const { error } = await dbDeleteBattleCard(tid, id);
      if (error) { console.error("[ralli] deleteBattleCard failed:", error); toast.error("Failed to delete battle card. Please try again."); return; }
    }
    setBattleCards(prev => {
      const next = prev.filter(c => c.id !== id);
      if (!user?._isReal) { try { localStorage.setItem(bcCardsKey, JSON.stringify(next)); } catch {} }
      return next;
    });
    toast.success("Battle card deleted.");
  };

  // ── Quiz CRUD ──
  const handleSaveQuiz = async (quiz) => {
    // For real users, persist to Supabase and get a stable UUID back.
    // Fall back to user.orgId if currentOrg hasn't loaded yet (async race on first login).
    const orgId = currentOrg?.id ?? user?.orgId ?? null;
    if (user?._isReal && orgId) {
      const { data: saved, error } = await upsertQuiz(orgId, quiz, user.id);
      if (error) { console.error("[ralli] upsertQuiz failed:", error); toast.error("Failed to save quiz. Please try again."); }
      // Only use saved (with stable DB UUID) if the upsert succeeded.
      // If it failed, don't silently add a non-persisted quiz to state for real users.
      if (!saved) {
        console.error("[ralli] handleSaveQuiz: upsert returned no data, aborting state update");
        toast.error("Quiz save failed. Please try again.");
        setEditingQuiz(null);
        setScreen("quizzes");
        return;
      }
      const canonical = saved;
      setQuizzes(prev =>
        prev.find(q => q.id === quiz.id || q.id === canonical.id)
          ? prev.map(q => (q.id === quiz.id || q.id === canonical.id) ? canonical : q)
          : [...prev, canonical]
      ); // real users: no localStorage write — Supabase is source of truth
      setEditingQuiz(null);
      toast.success("Quiz saved.");
      setScreen("quizzes");
      return;
    }
    // Demo / offline path
    setQuizzes(prev => {
      const updated = prev.find(q => q.id === quiz.id)
        ? prev.map(q => q.id === quiz.id ? quiz : q)
        : [...prev, quiz];
      try { localStorage.setItem("ralli_quizzes", JSON.stringify(updated)); } catch {}
      return updated;
    });
    setEditingQuiz(null);
    toast.success("Quiz saved.");
    setScreen("quizzes");
  };

  const handleEditQuiz = (quiz) => {
    setEditingQuiz(quiz);
  };

  const handleDeleteQuiz = async (id) => {
    // Demo / non-UUID path: synchronous localStorage behavior unchanged
    if (!user?._isReal || !id || id.startsWith("quiz_") || id.startsWith("sq_")) {
      setQuizzes(prev => {
        const updated = prev.filter(q => q.id !== id);
        if (!user?._isReal) { try { localStorage.setItem("ralli_quizzes", JSON.stringify(updated)); } catch {} }
        return updated;
      });
      toast.success("Quiz deleted.");
      return;
    }
    // Real users: pessimistic — DB must confirm before local state update
    if (deletingQuizIdsRef.current.has(id)) return; // ignore duplicate in-flight request
    deletingQuizIdsRef.current.add(id);
    try {
      const { error } = await dbDeleteQuiz(id);
      if (error) {
        console.error("[ralli] deleteQuiz failed:", error);
        toast.error("Failed to delete quiz. Please try again.");
        return;
      }
      // Only remove from state after DB confirms success
      setQuizzes(prev => prev.filter(q => q.id !== id));
      toast.success("Quiz deleted.");
    } finally {
      deletingQuizIdsRef.current.delete(id);
    }
  };

  const handleToggleFavorite = (id) => {
    const orgId = currentOrg?.id ?? user?.orgId ?? null;
    const current = quizzes.find(q => q.id === id);
    if (!current) return;
    const toggled = { ...current, favorite: !current.favorite };
    setQuizzes(prev => {
      const updated = prev.map(q => q.id === id ? toggled : q);
      if (!user?._isReal) { try { localStorage.setItem("ralli_quizzes", JSON.stringify(updated)); } catch {} }
      return updated;
    });
    if (user?._isReal && orgId) {
      upsertQuiz(orgId, toggled, user?.id)
        .then(({ error }) => { if (error) { console.error("[ralli] toggleFavorite upsert failed:", error); toast.error("Failed to update favorite."); } });
    }
  };

  const handleToggleActive = (id) => {
    const orgId = currentOrg?.id ?? user?.orgId ?? null;
    const current = quizzes.find(q => q.id === id);
    if (!current) return;
    const toggled = { ...current, status: current.status === "inactive" ? "active" : "inactive" };
    setQuizzes(prev => {
      const updated = prev.map(q => q.id === id ? toggled : q);
      if (!user?._isReal) { try { localStorage.setItem("ralli_quizzes", JSON.stringify(updated)); } catch {} }
      return updated;
    });
    if (user?._isReal && orgId) {
      upsertQuiz(orgId, toggled, user?.id)
        .then(({ error }) => { if (error) { console.error("[ralli] toggleActive upsert failed:", error); toast.error("Failed to update quiz status."); } });
    }
  };

  const handleAssignQuiz = async (assignment) => {
    const tenantId = currentOrg?.id ?? null;
    if (user?._isReal && tenantId) {
      const { error } = await dbCreateAssignment(tenantId, assignment, user?.id);
      if (error) { console.error("[ralli] quiz createAssignment failed:", error); toast.error("Failed to assign quiz. Please try again."); return; }
      // No App-level setAssignments — assignments state lives inside LearnScreen and QuizzesScreen.
      // Learners receive the assignment on their next visit to Quizzes or Learn (both re-fetch from Supabase on mount).
      toast.success("Quiz assigned.");
    } else {
      // Demo mode: no DB write, no local state update needed — toast confirms the action.
      toast.success("Quiz assigned.");
    }
  };

  const handleCreateSession = async (session) => {
    // Persist to Supabase first — enables cross-device joins by PIN
    const tenantId = currentOrg?.id ?? user?.orgId ?? null;
    const { data, error } = await createGameSession({
      pin:           session.code,
      name:          session.name,
      quizId:        session.quizId,
      questionCount: session.questionCount,
      demoMode:      session.demoMode ?? false,
      tenantId,
      hostId:        user?.id ?? "anonymous",
    });
    if (error) {
      console.error("[ralli:game] createGameSession FAILED — RLS or network issue:", error);
    }
    // Keep local state (screens still read from sessions array)
    const newSession = { ...session, dbId: data?.id };
    setSessions(prev => [newSession, ...prev]);
    // Route directly to the lobby so host doesn't have to click Launch again
    const quiz = quizzes.find(q => q.id === session.quizId);
    setGameQuestions(quiz?.questions ?? GAME_QUESTIONS);
    setLobbyPin(session.code);
    setLobbySessionName(session.name);
    setScreen("rankd-lobby");
  };

  // User: entered PIN → go to name entry
  // For cross-device joins, the session may not be in local state — fetch from Supabase.
  const handleEnterPin = async (pin, sessionNameHint) => {
    let session    = sessions.find(s => s.code === pin);
    let sessionName = sessionNameHint ?? session?.name ?? "Live Game";
    let quizId      = session?.quizId;

    if (!session) {
      // Player is on a different device — fetch session metadata from Supabase
      const { data: remote, error: pinErr } = await findSessionByPin(pin);
      if (remote) {
        // Cross-tenant protection: real users can only join their own org's sessions
        if (currentUser?._isReal && remote.tenant_id && remote.tenant_id !== currentUser.orgId) {
          console.warn("[ralli:game] handleEnterPin: cross-tenant join BLOCKED — session.tenantId:", remote.tenant_id, "user.orgId:", currentUser.orgId);
          return "This game belongs to a different organization.";
        }
        // Only allow joining sessions that are actively waiting for players
        if (remote.status && remote.status !== "waiting") {
          console.warn("[ralli:game] handleEnterPin: session not accepting players, status:", remote.status);
          return remote.status === "completed" || remote.status === "ended"
            ? "This game has already ended."
            : "This game has already started.";
        }
        const fetched = {
          code:          remote.pin,
          name:          remote.name,
          quizId:        remote.quiz_id,
          questionCount: remote.question_count,
          status:        remote.status,
          playerCount:   remote.player_count,
          demoMode:      remote.demo_mode,
          players:       [],
          dbId:          remote.id,   // DB primary key — used for lobby participant persistence
        };
        setSessions(prev => [...prev, fetched]);
        sessionName = remote.name;
        quizId      = remote.quiz_id;
      } else if (pinErr) {
        console.error("[ralli:game] findSessionByPin FAILED — likely RLS blocking authenticated read:", pinErr);
        return "Couldn't verify that PIN. Check your connection and try again.";
      } else {
        console.warn("[ralli:game] findSessionByPin: no session found for PIN", pin, "— check if session was created in DB");
        return "No active game found for that PIN.";
      }
    }

    // Pre-load questions for this session
    if (quizId) {
      const quiz = quizzes.find(q => q.id === quizId);
      setGameQuestions(quiz?.questions ?? GAME_QUESTIONS);
    } else {
      setGameQuestions(GAME_QUESTIONS);
    }
    setLobbyPin(pin);
    setLobbySessionName(sessionName);
    setScreen("rankd-name-entry");
    return null; // success
  };

  // User: confirmed name → persist participant to Supabase → go to lobby.
  // Returns null on success or an error string on failure.
  // Navigation to rankd-lobby only happens after the DB write succeeds (or is skipped for demo).
  const handleEnterName = async (name, emoji) => {
    setLobbyPlayerName(name);
    // Always compute the same emoji used in DB/presence so My card matches manager view.
    const pidx       = Math.abs(playerId.charCodeAt(0) + (playerId.charCodeAt(1) || 0)) % PLAYER_EMOJIS.length;
    const finalEmoji = emoji ?? PLAYER_EMOJIS[pidx];
    setLobbyPlayerEmoji(finalEmoji);

    // Update local session state (keeps existing local-state consumers working)
    setSessions(prev => prev.map(s =>
      s.code === lobbyPin
        ? { ...s, players: [...(s.players ?? []).filter(p => p.id !== currentUser?.id), { id: currentUser?.id ?? name, name, joinedAt: Date.now() }], playerCount: (s.playerCount ?? 0) + 1 }
        : s
    ));

    // Persist participant to Supabase so manager sees them cross-device.
    const joiningSession = sessions.find(s => s.code === lobbyPin);
    const sessionDbId    = joiningSession?.dbId ?? null;

    if (sessionDbId && currentUser) {
      const pColor = PLAYER_COLORS[pidx % PLAYER_COLORS.length];
      try {
        const { data: jData, error: jErr } = await joinGameSession(sessionDbId, {
          playerId: currentUser.id ?? playerId,
          name,
          emoji:    finalEmoji,
          color:    pColor,
          tenantId: currentUser.orgId ?? null,
        });
        if (jErr) {
          console.error("[ralli:game] joinGameSession FAILED — RLS or schema issue:", jErr);
          return jErr.message ?? "Failed to join the game. Please try again.";
        }
      } catch (e) {
        console.error("[ralli:game] joinGameSession exception:", e);
        return e?.message ?? "Couldn't connect to the game. Check your connection and try again.";
      }
    } else {
      // Demo mode or no DB session — skip write, proceed directly.
      console.warn("[ralli:game] handleEnterName: skipping joinGameSession —", !sessionDbId ? "sessionDbId is null (demo or session not found in DB)" : "currentUser is null (anonymous)");
    }

    setScreen("rankd-lobby");
    return null;
  };

  // Admin: open a session.
  // Routing is determined by the session's actual status — do not overwrite it.
  // Status changes happen only in handleGameStart (waiting→started) and handleGameEnd (→completed).
  //
  // waiting  → lobby: players join, host clicks Start when ready
  // started / live / active / paused → game screen directly
  //   Note: KahootHostView always initialises phase/qIdx/scores from React state (no DB read-back
  //   on mount). Running scores and question index are NOT restored after a refresh or re-entry.
  //   The host reconnects to the BroadcastChannel and can continue broadcasting new questions,
  //   but prior-question scores are lost in memory. Full restoration requires a future migration
  //   to read game_sessions.phase / current_question_index and re-aggregate game_answers on mount.
  const LOBBY_STATUSES = new Set(["waiting"]);
  const handleLaunch = (session) => {
    const quiz = quizzes.find(q => q.id === session.quizId);
    setGameQuestions(quiz?.questions ?? GAME_QUESTIONS);
    setLobbyPin(session.code);
    setLobbySessionName(session.name);
    // Do NOT overwrite session status — preserve the canonical value from Supabase / local state.
    if (LOBBY_STATUSES.has(session.status)) {
      setScreen("rankd-lobby");
    } else {
      // started / live / active / paused — re-enter the game screen directly.
      // Skips lobby so the host is not shown "Start Game" on an already-running session.
      setScreen("rankd-game");
    }
  };

  // Admin: start real game from lobby
  const handleGameStart = () => {
    setSessions(prev => prev.map(s =>
      s.code === lobbyPin ? { ...s, status: "started" } : s
    ));
    // For real mode, broadcast GAME_START so all players navigate to game
    const curSession = sessions.find(s => s.code === lobbyPin);
    if (curSession?.demoMode === false) {
      const quiz = quizzes.find(q => q.id === curSession.quizId);
      const qs = quiz?.questions ?? GAME_QUESTIONS;
      broadcast({ type: GM.GAME_START, questions: qs, totalQ: qs.length });
    }
    // Persist status update to Supabase (fire-and-forget)
    startGameSession(lobbyPin).catch(e => console.error("[ralli] startGameSession failed:", e));
    setScreen("rankd-game");
  };

  // Admin: game over — navigate to results + persist final scores
  const handleGameEnd = (data) => {
    setGameResultsData(data);
    setViewResultsCode(lobbyPin);
    navigate("rankd-results");
    // Immediately mark session as completed in local state so it moves to
    // Past Sessions and is excluded from the active lobby without waiting
    // for the next getActiveSessions poll.
    setSessions(prev => prev.map(s =>
      s.code === lobbyPin ? { ...s, status: "completed" } : s
    ));
    const gameTenantId = currentOrg?.id ?? user?.orgId ?? null;
    // Persist results + mark participants completed in Supabase (fire-and-forget)
    endGameSession(lobbyPin, {
      scores:   data?.scores ?? [],
      tenantId: gameTenantId,
    }).catch(e => console.error("[ralli] endGameSession failed:", e));
    // Award game points for all real participants, then trigger readiness for each.
    // awardGamePointsForSession returns the deduplicated list of authenticated user IDs
    // it awarded points to. Anonymous players have no player_id and are excluded.
    if (user?._isReal && gameTenantId && lobbyPin) {
      awardGamePointsForSession(gameTenantId, lobbyPin, data?.scores ?? [])
        .then(participantUserIds => {
          if (!participantUserIds?.length) return;
          // Each call is independent fire-and-forget — one failure does not block others.
          participantUserIds.forEach(uid => triggerReadinessUpdate(gameTenantId, uid));
        })
        .catch(e => { console.error("[ralli] awardGamePointsForSession failed:", e); toast.warning("Points could not be recorded for this session. Game results have been saved."); });
    }
  };

  const handleViewResults = (code) => {
    setViewResultsCode(code);
    setScreen("rankd-results");
  };

  // Admin: re-launch ended session — create a brand-new session with fresh PIN + empty lobby.
  // The old session stays in sessions[] as "ended" so it stays visible in Past Sessions.
  const handleRelaunch = (session) => {
    const newPin = String(Math.floor(100000 + Math.random() * 900000));
    handleCreateSession({
      code: newPin,
      name: session.name,
      quizId: session.quizId,
      questionCount: session.questionCount,
      status: "waiting",
      playerCount: 0,
      demoMode: session.demoMode ?? false,
      players: [],
    });
  };

  const fullScreen = FULL_SCREEN_ROUTES.has(screen);

  const renderScreen = () => {
    switch (screen) {
      case "org-setup":         return <OrgSetupScreen user={user} onComplete={() => {
        // Refresh tenant after setup so currentOrg reflects "active" status and real plan
        if (user.orgId) {
          supabase.from("tenants").select("*").eq("id", user.orgId).single()
            .then(({ data: t }) => {
              if (!t) return;
              const norm = { ...t, adminEmail: t.admin_email, seatLimit: t.seat_limit ?? 10, seats: t.seat_limit ?? 10, createdAt: t.created_at?.split("T")[0], updatedAt: t.updated_at?.split("T")[0] };
              setOrgs([norm]);
            });
        }
        setScreen("team");
      }} />;
      case "home":              return isOrgAdmin
        ? <LeadershipDashboardScreen currentOrg={currentOrg} orgUsers={orgUsers} isReal={!!user?._isReal} />
        : <HomeScreen user={user} onNav={navigate} quizAssignments={user?._isReal ? [] : USER_QUIZ_ASSIGNMENTS_SEED} onResumeLesson={(id) => { setPendingLessonId(id); navigate("learn"); }} onStartCourse={(id) => { setPendingCourseId(id); navigate("learn"); }} onStartQuiz={(id) => { setPendingQuizId(id); navigate("quizzes"); }} orgUsers={orgUsers} isReal={!!user?._isReal} tenantId={currentOrg?.id ?? null} quizzes={quizzes} lastSeenAt={lastSeenAt} onNewAssignments={(n) => setNewAssignmentCount(n)} />;
      case "rankd":             return <RankdScreen onNav={navigate} onJoin={handleEnterPin} sessions={sessions} onLaunch={handleLaunch} onViewResults={handleViewResults} onRelaunch={handleRelaunch} role={gameRole} currentUser={currentUser} />;
      case "rankd-new":         return <NewSessionScreen onNav={navigate} quizzes={quizzes} onCreateSession={handleCreateSession} />;
      case "rankd-quiz-builder":return <QuizBuilderScreen onNav={navigate} onSave={handleSaveQuiz} initialQuiz={editingQuiz} onEditQuiz={handleEditQuiz} />;
      case "rankd-name-entry":  return <RankdNameEntryScreen onNav={navigate} pin={lobbyPin} sessionName={lobbySessionName} onConfirm={handleEnterName} defaultName={userProfile.nickname?.trim() || user?.name || ""} defaultAvatar={userProfile.avatarEmoji} />;
      case "rankd-lobby":       return <RankdLobbyScreen onNav={navigate} pin={lobbyPin} playerName={lobbyPlayerName} playerEmoji={lobbyPlayerEmoji} sessionName={lobbySessionName} role={gameRole} sessions={sessions} currentUser={currentUser} onGameStart={handleGameStart} chPlayers={chPlayers} broadcast={broadcast} playerId={playerId} chMsg={chMsg} onHostEnd={async () => { await endGameSession(lobbyPin, { tenantId: currentOrg?.id ?? null }); navigate("rankd"); }} />;
      case "rankd-game":        return <RankdGameScreen onNav={navigate} sessionName={lobbySessionName} role={gameRole} playerName={lobbyPlayerName ?? user.name} questions={gameQuestions ?? GAME_QUESTIONS} demoMode={gameRole === "admin" && sessions.find(s => s.code === lobbyPin)?.demoMode !== false} pin={lobbyPin} sessionDbId={sessions.find(s => s.code === lobbyPin)?.dbId ?? null} tenantId={currentOrg?.id ?? user?.orgId ?? null} broadcast={broadcast} chMsg={chMsg} chAnswers={chAnswers} chPlayers={chPlayers} playerId={playerId} onGameEnd={handleGameEnd} setChAnswers={setChAnswers} />;
      case "rankd-results":     return <RankdResultsScreen onNav={navigate} sessionCode={viewResultsCode} sessions={sessions} gameData={gameResultsData} />;
      case "learn":             return <LearnScreen role={gameRole} user={user} orgUsers={orgUsers} orgs={orgs} onNav={navigate} onAwardXp={handleAwardXp} pendingLessonId={pendingLessonId} onClearPendingLesson={() => setPendingLessonId(null)} pendingCourseId={pendingCourseId} onClearPendingCourse={() => setPendingCourseId(null)} canCreate={perm("actions","create")} canEdit={perm("actions","edit")} canDelete={perm("actions","delete")} canAssign={perm("actions","assign")} tenantId={currentOrg?.id ?? null} isReal={!!user?._isReal} quizzes={quizzes} />;
      case "quizzes":           return <QuizzesScreen role={gameRole} onNav={navigate} quizzes={quizzes} onEditQuiz={handleEditQuiz} onDeleteQuiz={handleDeleteQuiz} onToggleFavorite={handleToggleFavorite} onToggleActive={handleToggleActive} pendingQuizId={pendingQuizId} onClearPendingQuiz={() => setPendingQuizId(null)} canCreate={perm("actions","create")} canEdit={perm("actions","edit")} canDelete={perm("actions","delete")} canLaunch={perm("actions","launch")} canAssign={perm("actions","assign")} onAssignQuiz={handleAssignQuiz} onLaunchQuiz={handleCreateSession} orgUsers={orgUsers} orgs={orgs} currentUser={currentUser} tenantId={currentOrg?.id ?? null} isReal={!!user?._isReal} quizzesReady={quizzesReady} />;
      case "battlecards":       return (isAdminType && perm("actions","edit"))
        ? <BattleCardsAdminScreen categories={bcCategories} cards={battleCards} onSaveCategory={handleSaveBcCategory} onDeleteCategory={handleDeleteBcCategory} onSaveCard={handleSaveBattleCard} onDeleteCard={handleDeleteBattleCard} />
        : <BattleCardsScreen categories={bcCategories} cards={battleCards} isLoading={bcLoading} isReal={!!user?._isReal} />;
      case "insights":           return <InsightsScreen user={user} isReal={!!user?._isReal} tenantId={currentOrg?.id ?? null} orgUsers={orgUsers} isAdmin={isAdminType} />;
      case "progress":          return isAdminType
        ? <LeadershipDashboardScreen currentOrg={currentOrg} orgUsers={orgUsers} isReal={!!user?._isReal} />
        : <ProgressScreen currentUser={user} isReal={!!user?._isReal} tenantId={currentOrg?.id ?? null} />;
      case "leaderboard":       return <LeaderboardScreen currentUser={user} isReal={!!user?._isReal} tenantId={currentOrg?.id ?? null} />;
      case "organizations":     return selectedOrg
        ? <OrgDetailScreen org={selectedOrg} orgUsers={orgUsers} onBack={() => setSelectedOrg(null)} onAddUser={handleAddUser} onDeactivateOrg={handleDeactivateOrg} onReactivateOrg={handleReactivateOrg} onDeleteOrg={handleDeleteOrg} onCancelOrg={handleCancelOrg} onUpdateOrg={handleUpdateOrg} onUpdateMember={handleUpdateMember} onRemoveMember={handleRemoveMember} onCancelInvite={handleCancelInvite} onResendMemberInvite={handleResendMemberInvite} />
        : <OrganizationsScreen orgs={orgs} onInviteOrg={handleInviteOrg} onSelectOrg={(org) => setSelectedOrg(org)} onRefresh={handleRefreshOrgs} onDeactivateOrg={handleDeactivateOrg} onReactivateOrg={handleReactivateOrg} onDeleteOrg={handleDeleteOrg} onCancelOrg={handleCancelOrg} />;
      case "team":              return <TeamScreen orgId={user.orgId} orgName={currentOrg?.name ?? "Your Team"} orgUsers={orgUsers} onAddUser={handleAddUser} />;
      case "settings":
        if (isSuperAdmin)  return <RoleAccessScreen rolePermissions={rolePermissions} onSave={handleSaveRolePermissions} currentOrg={currentOrg} />;
        if (isOrgAdmin)    return <OrgAdminSettingsScreen rolePermissions={rolePermissions} onSaveRolePermissions={handleSaveRolePermissions} currentOrg={currentOrg} orgId={user.orgId} orgName={currentOrg?.name ?? "Your Team"} orgUsers={orgUsers} onAddUser={handleAddUser} />;
        return <UserSettingsScreen user={user} profile={userProfile} notifPrefs={notifPrefs} onSaveProfile={handleSaveProfile} onSaveNotifs={handleSaveNotifs} currentOrg={currentOrg} onSignOut={async () => { if (user?._isReal) { await supabase.auth.signOut(); /* SIGNED_OUT handler redirects */ } else { setCurrentUser(null); setLastSeenAt(null); setNewAssignmentCount(0); setPendingLessonId(null); setPendingCourseId(null); setPendingQuizId(null); setOrgs(INITIAL_ORGS); setOrgUsers(INITIAL_ORG_USERS); setQuizzesReady(false); setSessions(INITIAL_SESSIONS); setBattleCards(INITIAL_BATTLE_CARDS); setBcCategories(INITIAL_BC_CATEGORIES); window.location.replace("/login"); } }} />;
      default:                  return <HomeScreen user={user} />;
    }
  };

  return (
    <AppErrorBoundary>
    <div style={{
      display: "flex", height: "100vh",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: 14, background: C.pageBg, overflow: "hidden",
      flexDirection: mobile ? "column" : "row",
    }}>
      {/* Sidebar — desktop only */}
      {!fullScreen && !mobile && (
        <div style={{ width: 220, flexShrink: 0, background: C.sidebar, borderRight: `1px solid ${C.sidebarBorder}`, display: "flex", flexDirection: "column" }}>
          {/* Logo */}
          <div style={{ padding: "20px 18px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <RalliLogo size={34} />
              <div>
                <div style={{ fontSize: 17, fontWeight: 900, color: C.text, letterSpacing: "-0.5px" }}>ralli</div>
                <div style={{ fontSize: 9, fontWeight: 600, color: C.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Sales Readiness</div>
              </div>
            </div>
            {/* Org badge — shown for org users */}
            {currentOrg && (
              <div style={{ marginTop: 12, padding: "5px 10px", background: C.pageBg, borderRadius: 8, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.orange, flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: C.textSub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentOrg.name}</span>
              </div>
            )}
            {isSuperAdmin && (
              <div style={{ marginTop: 12, padding: "5px 10px", background: "rgba(139,92,246,0.06)", borderRadius: 8, border: "1px solid rgba(139,92,246,0.15)", display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#8B5CF6", flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: "#7C3AED" }}>ralli platform</span>
              </div>
            )}

            {/* Level bar — reps only */}
            {user.role === "user" && (
              <div style={{ marginTop: 14, padding: "12px 14px", background: C.pageBg, borderRadius: 12, border: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 7 }}>
                  <span style={{ fontWeight: 700, color: C.text, letterSpacing: "0.02em" }}>{user.level != null ? `Level ${user.level}` : "Level 1"}</span>
                  <span style={{ color: C.orangeDeep, fontWeight: 700 }}>{(user.xp ?? 0).toLocaleString()} XP</span>
                </div>
                <ProgressBar value={(user.xp ?? 0) % 1000} max={1000} color={C.orange} height={4} trackColor="rgba(11,18,32,0.07)" />
                {user.xpNext != null && (
                  <div style={{ fontSize: 10, color: C.textMuted, marginTop: 6 }}>
                    {(user.xpNext - (user.xp ?? 0)).toLocaleString()} XP to Level {(user.level ?? 1) + 1}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Nav */}
          <nav style={{ flex: 1, padding: "4px 10px", overflowY: "auto" }}>
            {[
              // Super admin gets org management nav
              ...(isSuperAdmin ? [
                { id: "organizations", label: "Organizations", icon: "" },
                { id: "rankd",         label: "ralli",   icon: "", badge: "LIVE" },
                { id: "learn",         label: "Learn",         icon: "" },
                { id: "quizzes",       label: "Quizzes",       icon: "" },
                { id: "battlecards",   label: "Battle Cards",  icon: "" },
                { id: "settings",      label: "Settings",      icon: "" },
              ] : [
                // Filter nav items by (1) subscription plan and (2) admin-controlled role permission.
                ...NAV_ITEMS.filter(item =>
                  (!item.featureKey || canAccessTenant(item.featureKey)) &&
                  perm("features", item.permKey ?? item.id)
                ),
                // Team is managed inside Settings for org admins
              ]),
            ].map(item => {
              const active = screen === item.id || (screen.startsWith("rankd-") && item.id === "rankd");
              return (
                <button key={item.id} onClick={() => navigate(item.id)}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.pageBg; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
                  style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", borderRadius: 10, border: "none",
                  cursor: "pointer", marginBottom: 1,
                  background: active ? C.sidebarAccent : "transparent",
                  color: active ? C.textSidebarActive : C.textSidebar,
                  fontSize: 13, fontWeight: active ? 700 : 500, textAlign: "left",
                  transition: "background 0.1s, color 0.1s",
                }}>
                  {active && <div style={{ width: 3, height: 14, borderRadius: 99, background: C.orange, flexShrink: 0, marginRight: -2 }} />}
                  {item.icon && <span style={{ fontSize: 15, opacity: active ? 1 : 0.6 }}>{item.icon}</span>}
                  <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{isAdminType && item.adminLabel ? item.adminLabel : item.label}</span>
                    {/* Static badge (LIVE, #3) — hidden on leaderboard for real users */}
                    {item.badge && !(user?._isReal && item.id === "leaderboard") && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
                        background: item.badge === "LIVE" ? "#22C55E" : C.orange,
                        color: "#fff", letterSpacing: "0.04em",
                      }}>{item.badge}</span>
                    )}
                    {/* Dynamic badge: new-assignment count on Learn nav item (learners only) */}
                    {!isAdminType && item.id === "learn" && newAssignmentCount > 0 && screen !== "home" && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
                        background: C.orange, color: "#fff", letterSpacing: "0.04em",
                      }}>{newAssignmentCount}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Bottom user card */}
          <div style={{ padding: "10px 12px 14px", borderTop: `1px solid ${C.sidebarBorder}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 12, background: C.pageBg }}>
              <div
                onClick={() => navigate("settings")}
                title="Open Settings"
                style={{
                  width: 32, height: 32, borderRadius: "50%",
                  background: user.color, display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 800, color: "#fff", flexShrink: 0,
                  cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                }}>{user.initials}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name}</div>
                <div style={{ fontSize: 10, color: isSuperAdmin ? "#8B5CF6" : isOrgAdmin ? "#059669" : C.textMuted, marginTop: 1 }}>
                  {isSuperAdmin ? "ralli admin" : isOrgAdmin ? "Admin" : `${user.streak ?? 0}-day streak`}
                </div>
              </div>
              <button
                onClick={async () => {
                  if (user?._isReal) {
                    // Real user: signOut() fires the SIGNED_OUT event which handles state cleanup
                    await supabase.auth.signOut();
                  } else {
                    // Seed/demo user: SIGNED_OUT event won't fire — clear all session state manually
                    setCurrentUser(null);
                    setLastSeenAt(null);
                    setNewAssignmentCount(0);
                    setPendingLessonId(null);
                    setPendingCourseId(null);
                    setPendingQuizId(null);
                    setOrgs(INITIAL_ORGS);
                    setOrgUsers(INITIAL_ORG_USERS);
                    setQuizzesReady(false);
                    setSessions(INITIAL_SESSIONS);
                    setBattleCards(INITIAL_BATTLE_CARDS);
                    setBcCategories(INITIAL_BC_CATEGORIES);
                    window.location.replace("/login");
                  }
                  // Real users: SIGNED_OUT event fires window.location.replace("/login")
                }}
                title="Sign out"
                style={{
                  background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7,
                  color: C.textMuted, fontSize: 11, fontWeight: 600, cursor: "pointer",
                  padding: "3px 8px", height: 26, display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0, transition: "all 0.1s", whiteSpace: "nowrap",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = C.white; e.currentTarget.style.color = C.text; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; }}
              >Sign out</button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile top bar */}
      {!fullScreen && mobile && (
        <div style={{
          height: 52, background: C.sidebar, borderBottom: `1px solid ${C.sidebarBorder}`,
          display: "flex", alignItems: "center", padding: "0 16px", gap: 10, flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
            <RalliLogo size={28} />
            <span style={{ fontSize: 16, fontWeight: 900, color: C.text }}>ralli</span>
          </div>
          {role === "user" && (
            <span style={{ fontSize: 12, fontWeight: 700, color: C.orange }}>{user.xp.toLocaleString()} XP</span>
          )}
          {isAdminType && (
            <span style={{ fontSize: 12, fontWeight: 700, color: C.green }}>Admin</span>
          )}
          <div
            onClick={() => navigate("settings")}
            title="Settings & sign out"
            style={{
              width: 30, height: 30, borderRadius: "50%", background: user.color,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, fontWeight: 800, color: "#fff", cursor: "pointer",
              flexShrink: 0,
            }}>{user.initials}</div>
        </div>
      )}

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: C.pageBg, overflow: "hidden", minHeight: 0 }}>
        {/* Desktop top bar */}
        {!fullScreen && !mobile && (
          <div style={{
            height: 56, background: C.white,
            borderBottom: `1px solid ${C.sidebarBorder}`,
            boxShadow: "0 1px 0 rgba(11,18,32,0.04)",
            display: "flex", alignItems: "center", padding: "0 28px", gap: 16, flexShrink: 0,
          }}>
            {/* Company logo for users; search placeholder for ralli admin only.
                Production hook: replace currentOrg?.name with org.logoUrl when
                asset upload is supported — render <img> instead of text. */}
            {role === "user" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  fontSize: 20, fontWeight: 900, letterSpacing: "-0.03em", color: C.text,
                  fontFamily: "system-ui, -apple-system, sans-serif",
                }}>
                  {currentOrg?.name ?? "Your Team"}
                </span>
              </div>
            ) : isSuperAdmin ? (
              <div style={{
                flex: 1, display: "flex", alignItems: "center", gap: 10,
                background: C.inputBg, border: `1px solid ${C.border}`,
                borderRadius: 8, padding: "8px 14px", maxWidth: 400,
              }}>
                <span style={{ fontSize: 13, color: C.textMuted }}>Search battle cards, topics, competitors...</span>
              </div>
            ) : null}
            <div style={{ flex: 1 }} />

            {role === "user" && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 11px", borderRadius: 99, border: `1px solid ${C.border}`, background: C.pageBg }}>
                <span style={{ fontSize: 12, color: C.textMuted }}>🔥</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{user.streak}d</span>
              </div>
            )}
            {role === "user" && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 12px", borderRadius: 99, border: `1px solid ${C.orangeBorder}`, background: C.orangeLight }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.orangeDeep }}>{user.xp.toLocaleString()} XP</span>
              </div>
            )}
            {isSuperAdmin && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 12px", borderRadius: 99, border: "1px solid rgba(139,92,246,0.2)", background: "rgba(139,92,246,0.06)" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#8B5CF6" }}>ralli admin</span>
              </div>
            )}
            {isOrgAdmin && currentOrg && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 12px", borderRadius: 99, border: `1px solid ${C.border}`, background: C.pageBg }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.textSub }}>{currentOrg.name}</span>
              </div>
            )}
            {role === "user" && currentOrg && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 12px", borderRadius: 99, border: `1px solid ${C.border}`, background: C.pageBg }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: C.textMuted }}>{currentOrg.name}</span>
              </div>
            )}
            <div style={{
              width: 32, height: 32, borderRadius: "50%", background: user.color,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, fontWeight: 800, color: "#fff", cursor: "pointer",
              boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            }}>{user.initials}</div>
          </div>
        )}

        {/* Page content */}
        <div style={{
          flex: 1, overflow: "auto", minHeight: 0,
          ...(fullScreen ? {} : { padding: mobile ? "16px 14px" : "28px 32px" }),
        }}>
          {renderScreen()}
        </div>
      </div>

      {/* Mobile bottom nav */}
      {!fullScreen && mobile && (
        <div style={{
          height: 60, background: C.sidebar, borderTop: `1px solid ${C.sidebarBorder}`,
          display: "flex", alignItems: "stretch", flexShrink: 0,
        }}>
          {(isSuperAdmin ? [
            { id: "organizations", label: "Organizations", icon: "" },
            { id: "rankd",         label: "ralli",         icon: "", badge: "LIVE" },
            { id: "learn",         label: "Learn",         icon: "" },
            { id: "quizzes",       label: "Quizzes",       icon: "" },
            { id: "battlecards",   label: "Battle Cards",  icon: "" },
            { id: "settings",      label: "Settings",      icon: "" },
          ] : NAV_ITEMS.filter(item =>
            (!item.featureKey || canAccessTenant(item.featureKey)) &&
            perm("features", item.permKey ?? item.id)
          )).map(item => {
            const active = screen === item.id || (screen.startsWith("rankd-") && item.id === "rankd");
            return (
              <button key={item.id} onClick={() => navigate(item.id)} style={{
                flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                border: "none", cursor: "pointer",
                background: active ? C.sidebarAccent : "transparent",
                borderTop: `2px solid ${active ? C.orange : "transparent"}`,
              }}>
                {item.icon && <span style={{ fontSize: 18, opacity: active ? 1 : 0.55 }}>{item.icon}</span>}
                <span style={{ fontSize: 9, fontWeight: 700, color: active ? C.textSidebarActive : C.textSidebar }}>{isAdminType && item.adminLabel ? item.adminLabel : item.label}</span>
              </button>
            );
          })}
        </div>
      )}
      <ToastContainer />
    </div>
    </AppErrorBoundary>
  );
}
