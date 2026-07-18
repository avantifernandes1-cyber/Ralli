# Ralli Beta Readiness Audit
**Date:** 2026-07-16 | **Reviewer:** Senior Staff Full-Stack / QA / Product Readiness

---

## 🚨 Critical — Blocks Beta

### 1. Open-ended questions are broken in real multiplayer games
**What's wrong:** In live game sessions, `doReveal()` (line 2148) handles `open` questions by building `openResponses` from one of two sources: demo mode uses `OPEN_DEMO_RESPONSES` (canned), real mode uses `openSubmitted ? [{ text: typedAnswer, author: playerName, id: 0 }] : []`. In real mode, only the local player's response is included — the host cannot see other players' answers. There is no broadcast message for player open-ended submissions, no DB table for collecting them, and no grading path that works cross-device.

**Why it happens:** Task #14 ("Open-ended question grading") is still pending. The architecture was scoped to work in demo-only mode.

**Where:** `doReveal()` line 2148, `setOpenResponses`, `phase: "open-review"` render branch, `openGrades` state.

**Recommended fix:** Add a `game_open_responses` table (session_id, player_id, question_idx, response_text). On player submit, write to DB and broadcast a `PLAYER_OPEN_RESPONSE` channel message. Host accumulates them in state during the question phase. On reveal, host fetches remaining responses from DB as fallback.

**Effort:** Large

---

### 2. Course completion does not trigger readiness score update
**What's wrong:** When a user completes the last lesson in a course, `handleCompleteLesson` detects course completion (lines 5681–5699) and calls `awardCoursePoints`. But `triggerReadinessUpdate` is **not** called in this branch — only in the lesson completion path (line 5677). The user's readiness score is never updated to reflect course completion.

**Why it happens:** Task #133 ("Edit rankd-app.jsx — readiness score triggers") is still pending. The course completion branch was added for XP but the readiness trigger wasn't duplicated.

**Where:** `handleCompleteLesson`, lines 5681–5699. The missing call is inside the `courses.forEach` loop, after `awardCoursePoints`.

**Recommended fix:** Add `triggerReadinessUpdate(tid, uid)` immediately after `awardCoursePoints(...)` call inside the `nowComplete` branch (line ~5698).

**Effort:** Small (one line)

---

### 3. Live game readiness update fires for host only, not participants
**What's wrong:** `handleGameEnd` (line 15643) calls `triggerReadinessUpdate(gameTenantId, user.id)` for the host only. The comment reads "individual participant updates happen server-side" but no such server-side trigger exists in any of the 30 migrations. Game participants earn points via `awardGamePointsForSession` but their readiness scores are never refreshed.

**Why it happens:** The comment describes a future architecture that was never implemented.

**Where:** `handleGameEnd`, line 15643.

**Recommended fix:** After `awardGamePointsForSession` resolves, iterate `data?.scores` and call `triggerReadinessUpdate` for each participant who has a real user ID. Alternatively, handle this inside `awardGamePointsForSession` in `scoringService.js`.

**Effort:** Small–Medium

---

### 4. handleDeleteQuiz removes from state before DB delete, no rollback on failure
**What's wrong:** `handleDeleteQuiz` (lines 15401–15411) calls `setQuizzes(prev => prev.filter(...))` synchronously, then fires the DB delete as a fire-and-forget. If the DB delete fails, `toast.error("Failed to delete quiz.")` fires, but the quiz is already gone from local state. The real user's view is permanently stale until refresh — and even then the quiz will reappear if the DB delete failed.

**Why it happens:** The optimistic pattern was applied to delete without adding rollback logic.

**Where:** `handleDeleteQuiz`, lines 15401–15411.

**Recommended fix:** Either await the DB delete before updating state, or capture the removed quiz and re-add it to state on error: `const removed = quizzes.find(q => q.id === id); dbDeleteQuiz(id).then(({ error }) => { if (error) { setQuizzes(prev => [removed, ...prev]); toast.error(...); } });`

**Effort:** Small

---

### 5. HomeScreen deep-link to quiz silently fails for real users
**What's wrong:** The `pendingQuizId` effect in `QuizzesScreen` (lines 8764–8771) has `[]` deps and fires on mount. For real users, `assignments` is initialized to `[]` and is populated asynchronously. The effect fires when assignments haven't loaded yet — `assignments.find(pendingQuizId)` returns `undefined`, the quiz never opens, and `onClearPendingQuiz()` is called anyway, consuming the deep-link.

**Why it happens:** The `[]` dep array was correct for demo users (seed data is synchronous) but breaks for real users with async DB load.

**Where:** `QuizzesScreen`, lines 8764–8771.

**Recommended fix:** Add `assignmentsLoaded` to the effect deps and gate the open: `useEffect(() => { if (!pendingQuizId || !assignmentsLoaded) return; ... }, [pendingQuizId, assignmentsLoaded]);`

**Effort:** Small

---

## ⚠️ High Priority — Fix Before Onboarding Users

### 6. Remove/update member does not update orgUsers state
**What's wrong:** `handleRemoveMember` (line 15227) and `handleUpdateMember` (line 15216) both call Supabase RPCs and return, but neither calls `setOrgUsers`. The removed or updated member remains in local state until page refresh. For `handleRemoveMember` this means a deleted member keeps appearing in the admin's member list.

**Where:** Lines 15216–15230.

**Recommended fix:** After successful RPC, update `orgUsers` state — `setOrgUsers(prev => prev.filter(u => u.id !== profileId))` for remove; `setOrgUsers(prev => prev.map(u => u.id === profileId ? { ...u, ...fields } : u))` for update.

**Effort:** Small

---

### 7. Member invite email failure is invisible to admin
**What's wrong:** `handleInviteOrg` (lines 15102–15111) catches email errors in `emailError` and returns `{ emailSent, emailError }`, but callers display the same success toast regardless. If `RESEND_API_KEY` isn't configured in production, every invite email will silently fail. Admins will believe invites were sent when they weren't.

**Where:** `handleInviteOrg` return value; caller in OrgDetailScreen.

**Recommended fix:** Check `emailSent` in the caller and show a distinct warning: "Invite created, but email failed to send. Share the invite link manually: [url]". Log `emailError` for debugging.

**Effort:** Small

---

### 8. Manager Games tabs (Start New / Past Sessions) broken
**What's wrong:** Task #111 has been in_progress since the game flow refactor. The tab navigation between "Start New" and "Past Sessions" in the manager Games view is broken — exact behavior not re-verified in this audit but known open.

**Where:** Games screen, manager branch.

**Recommended fix:** Trace the tab state and session filter logic; verify `sessions.filter(s => s.status === "waiting")` vs `"completed"` split is wired to the correct tab.

**Effort:** Small–Medium

---

### 9. Recording lesson type shows placeholder to end users
**What's wrong:** `LessonBlock` for `type === "recording"` (lines 7007–7010) renders a placeholder: "Recording submission coming soon." If a manager assigns a recording-type lesson, the rep sees this dead end. They can still mark it complete, but there's no actual submission path.

**Where:** `LessonBlock`, line 7007.

**Recommended fix:** Either disable recording-type lessons from being assigned until the feature is complete, or add a clear UI label at the admin creation level: "Recording submission is not yet available — reps will see a placeholder." Don't silently ship a broken UX.

**Effort:** Small (gating/labeling) or Large (actual recording implementation)

---

### 10. Learn user "assigned" section has no filter UI despite filter state existing
**What's wrong:** `learnFilter` state is initialized to `"due"` (line 6606) but no tab UI or filtering logic is wired to it in the user's assigned view. All assigned content renders unfiltered. Task #149 ("Add Due/Complete/All sub-tabs to Learn user assigned section") is in_progress but not complete.

**Where:** `LearnScreen`, user branch, lines 6605–6607.

**Recommended fix:** Follow the same pattern as `QuizzesScreen` — add Due/Complete/All tab buttons above the assigned content list, compute `dueItems` / `completeItems` based on `completedLessons`, and filter the visible list accordingly.

**Effort:** Small

---

### 11. No PIN collision guard for live game sessions
**What's wrong:** Game session PINs are generated as `String(Math.floor(100000 + Math.random() * 900000))` (line 15460) with no uniqueness check. If two concurrent sessions happen to generate the same PIN (1-in-900k, but non-zero at scale), players will join the wrong session.

**Where:** `handleCreateSession`, line 15460.

**Recommended fix:** After generating a PIN, query `game_sessions` for any active session with that PIN before creating. Retry generation if collision found.

**Effort:** Small

---

### 12. update_tenant RPC bypass in handleCancelOrg
**What's wrong:** `handleCancelOrg` (line 15168) uses a direct table update instead of the `update_tenant` RPC, with the comment "Uses direct table update (update_tenant RPC may not be deployed yet)." Task #94 (in_progress) confirms this RPC has known issues. Until the RPC is verified, plan changes and seat limit updates via `handleUpdateOrg` (which uses the RPC) may also be failing silently in production.

**Where:** Line 15168; `handleUpdateOrg` line 15177.

**Recommended fix:** Verify `update_tenant` RPC is deployed and working in Supabase. Run a test call from the Supabase SQL editor. If it works, remove the bypass comment. If it doesn't, fix the RPC.

**Effort:** Small (verification) to Medium (if RPC needs fixing)

---

## 💡 Medium Priority — Polish Before Scale

### 13. awardGamePointsForSession errors are silent to the host
**What's wrong:** Line 15641: `awardGamePointsForSession(...).catch(e => console.error(...))`. If game points fail to write to `user_point_events` (RLS issue, network error), participants silently lose XP. No toast, no retry.

**Recommended fix:** Surface persistent failures as a warning toast: "Game scores saved, but XP award failed. Contact support if this persists."

**Effort:** Small

---

### 14. No confirmation before archiving course or lesson
**What's wrong:** Single-click archive with no confirmation dialog. Admins can accidentally archive active content that reps are mid-completion.

**Recommended fix:** Add a one-liner confirmation dialog or inline "Are you sure?" prompt before archive fires.

**Effort:** Small

---

### 15. InsightsScreen AI generation fails silently without OPENAI_API_KEY
**What's wrong:** `api/ai-insights.js` requires `OPENAI_API_KEY`. If not set in Vercel environment variables, the "Generate Insights" CTA will fail. Need to verify the component handles this error state gracefully (fallback message vs. broken spinner).

**Recommended fix:** Add a check in `api/ai-insights.js`: if `!process.env.OPENAI_API_KEY` return a 503 with a clear message. Show this in the InsightsScreen as "AI insights unavailable — contact your administrator."

**Effort:** Small

---

### 16. Lesson completions written to localStorage for real users (unnecessary)
**What's wrong:** `handleCompleteLesson` (line 5653) writes to `localStorage` for all users, including real Supabase users. This is harmless but creates a stale local copy that can persist across browsers for the same `user.id`. No functional bug, but adds noise and a divergence risk.

**Recommended fix:** Gate the `localStorage.setItem` behind `!isReal`.

**Effort:** Trivial

---

## ✅ Production Ready

These workflows are complete, production-safe, and can be demoed to beta customers today:

- **Multi-tenant isolation** — `tenant_id` RLS enforced across all 30 migrations. No cross-tenant data exposure verified in code.
- **Auth flow** — Supabase Auth session restore, invite token URL detection, role-based routing (user → home, orgAdmin → setup/home, ralli_admin → organizations).
- **Org provisioning** — `provision_tenant` RPC is atomic; invite email is non-blocking with error capture.
- **Quiz CRUD** — Full Supabase persistence. Optimistic update with hard rollback on failed creates. Delete-on-error is the remaining gap (item #4 above).
- **Lesson + course CRUD** — Full Supabase persistence. Archive/restore workflow. Inline lesson creation from course builder.
- **XP and scoring engine** — `scoringService.js` is centralized, idempotency-keyed (migration 027), canonical source is `user_point_events`. `profiles.xp` is treated as legacy and not written.
- **Leaderboard** — Reads from `user_point_events`, correctly patches `orgUsers` XP from the canonical table.
- **Quiz player** — MC, TF, Slider, and Type Answer all fully implemented: render, submit, score, persist attempt, update retake state, results view.
- **Live game lobby** — BroadcastChannel + Supabase participants, cross-device PIN join works, countdown pulls real player count from DB.
- **Battle cards** — Full CRUD with Supabase for real users; localStorage fallback for demo.
- **Profile preferences** — Nickname, avatar, notification prefs persisted to Supabase for real users.
- **Role-based nav + permissions** — `canAccess()` (plan-gated) + `hasPermission()` (role-gated) applied throughout nav and screen actions.
- **Readiness score model** — `readiness_scores` table, `triggerReadinessUpdate` RPC, InsightsScreen fully wired. Gaps in trigger coverage are listed above (items #2 and #3).
- **Member management** — Invite, cancel invite, resend, remove, update role all wired via RPC. State update gaps listed above (item #6).
- **Password reset** — Wired in LoginScreen.
- **OrgAdmin setup flow** — `org-setup` screen, `complete_onboarding` RPC, tenant status transitions.

---

## Recommended Fix Order for Beta Launch

| Priority | Item | Effort |
|---|---|---|
| 1 | Course completion readiness trigger (#2) | Small |
| 2 | Quiz deep-link race condition (#5) | Small |
| 3 | Delete quiz rollback (#4) | Small |
| 4 | Remove/update member state update (#6) | Small |
| 5 | Invite email failure visibility (#7) | Small |
| 6 | Game readiness for participants (#3) | Small–Medium |
| 7 | Manager Games tabs (#8) | Small–Medium |
| 8 | Learn filter UI (#10) | Small |
| 9 | PIN collision guard (#11) | Small |
| 10 | Verify update_tenant RPC (#12) | Small |
| 11 | Disable/label recording lessons (#9) | Small |
| 12 | Open-ended live game (#1) | Large — defer to v1.1 |
