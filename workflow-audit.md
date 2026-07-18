# Ralli Workflow Audit
**Date:** 2026-07-16 | **Reviewer:** Senior Staff Full-Stack / QA / Product Readiness  
**Scope:** End-to-end workflow tracing from blank org → full product coverage. Every step followed to its lifecycle conclusion. Code-path verified, not assumed.

---

## Methodology

Each step below was traced through the actual code path in `rankd-app.jsx` and supporting services. Status indicators:

- ✅ **Works** — path completes correctly end-to-end
- ⚠️ **Works with caveats** — completes but with a known gap or degraded behavior
- 🔴 **Broken** — path fails, crashes, or produces incorrect results
- ℹ️ **Informational** — observation worth noting, no workflow break

---

## Workflow 1: Org Onboarding (Blank → Active)

### Step 1: Create an organization

**Path:** Sign up → Supabase Auth → `auth.onAuthStateChange` → session restore → orgAdmin routing → `org-setup` screen.

**Code path:** Lines 14816–14869 (auth restore). `provision_tenant` RPC fires on first admin sign-in via `complete_onboarding` at OrgSetupScreen step 4.

**Status:** ✅ Works.

The setup wizard is 4 steps: org info → team size → invite users → done. `provision_tenant` RPC is atomic — tenant row, admin profile row, and plan row created in one call.

---

### Step 2: Invite a manager

**Path:** OrgSetupScreen step 3 → email input → invite created.

**Code path:** Line 11558 — `createMemberInvite(email, "user")` — role is **hardcoded to "user"**.

**Status:** ⚠️ Works with caveats — **cannot invite a manager during setup.**

The role selector does not appear in the setup wizard. The only available role at step 3 is "user." A manager can only be invited after setup is complete via the Team screen (`TeamScreen.handleAdd`, line 12786), where a role dropdown is present.

**Impact:** Orgs that expect to configure their manager hierarchy during onboarding cannot do so. This is a friction point on first-run.

**Fix:** Add a role selector (user / manager) to OrgSetupScreen step 3. Minimum change: pass the role into `createMemberInvite` rather than hardcoding "user".

---

### Step 3: Invite a learner

**Path:** Team screen → "Add Member" → email + role → `handleAdd` → `createMemberInvite` → `sendInviteEmail` (Resend).

**Code path:** Lines 12786–12798, `sendInviteEmail` (fire-and-forget).

**Status:** ⚠️ Works with caveats — **email failure is invisible to admin.**

`sendInviteEmail` is called without `await` and errors are caught with `console.warn` only. If `RESEND_API_KEY` is not configured in the Vercel environment, every invite will fail silently. The admin sees a success toast either way.

**Impact:** Real users may never receive their invite. Admin has no fallback link to share.

**Fix:** Await the email call in `handleAdd`. If `!emailSent`, show a distinct toast: "Invite created. Email failed — share this link manually: [invite url]."

---

### Step 4: Accept an invitation

**Path:** Invitee clicks email link → `?invite_token=...` → `InviteScreen` → `get_invitation_by_token` RPC → `supabase.auth.signUp` → `accept_invitation` RPC → routed to app.

**Code path:** Lines 13185–13441.

**Status:** ✅ Works.

Token resolution, account creation, and invitation acceptance are properly sequenced. Role and tenant are written via `accept_invitation` RPC. Session is set after signUp — user lands in the app with correct role and tenant context.

**Note:** `inv.adminEmail` is used for displaying "Invited by [admin name]" on the invite screen. Verify this field is populated by the `get_invitation_by_token` RPC in production; if the RPC returns `inviter_email` instead, the display will show undefined.

---

## Workflow 2: Content Creation

### Step 5: Build a lesson

**Path:** Learn tab (admin) → "New Lesson" → `LessonBuilderModal` → save → `dbCreateLesson` → optimistic state update.

**Code path:** Lines 5582–6000 (admin Learn branch), `contentService.dbCreateLesson`.

**Status:** ✅ Works.

Lesson types: video, article, recording, quiz-linked. Video and article types are fully functional. Recording type shows "Recording submission coming soon." — a placeholder that admins can create but reps can't actually complete meaningfully (see beta audit item #9).

---

### Step 6: Build a course

**Path:** Learn tab (admin) → "New Course" → `CourseBuilderModal` → add lessons → save → `dbCreateCourse`.

**Code path:** Lines 6000–6200 (CourseBuilderModal).

**Status:** ✅ Works.

Lesson ordering, inline lesson creation from within the course builder, and Supabase persistence all work. Archive/restore is available after creation.

---

### Step 7: Assign content to a learner

**Path:** Learn tab (admin) → select course/lesson → "Assign" → `AssignContentModal` → select users/teams → `dbCreateAssignment`.

**Code path:** Lines 6200–6400.

**Status:** ✅ Works.

Assignments are written to the `content_assignments` table with `tenant_id`, `assignee_id`, and `content_id`. Role-gated — only admins/managers can see the Assign button.

---

## Workflow 3: Learner Experience

### Step 8: Log in as the learner

**Path:** Login → Supabase Auth → `auth.onAuthStateChange` → role check → `"user"` role → routed to `HomeScreen`.

**Code path:** Lines 14816–14869 (auth restore), line 14856: `role === "user"` → `setScreen("home")`.

**Status:** ✅ Works.

Learner lands on HomeScreen with their assignment queue. Assignment loading is async — content pulls from `content_assignments` join.

---

### Step 9: Complete a lesson

**Path:** Learn tab → assigned lesson → watch/read → "Mark Complete" → `handleCompleteLesson` → `awardLessonPoints` → `triggerReadinessUpdate` → DB writes.

**Code path:** Lines 5649–5700.

**Status:** ✅ Works for individual lessons.

`lesson_completions` row written, `user_point_events` row written via `scoringService`, `triggerReadinessUpdate` RPC fires. Completion reflected immediately in UI via optimistic state update backed by localStorage (for speed) and Supabase (for persistence).

---

### Step 10: Complete a course (all lessons)

**Path:** Complete final lesson in a course → `handleCompleteLesson` detects course completion → `awardCoursePoints` → **no readiness trigger**.

**Code path:** Lines 5681–5699.

**Status:** 🔴 **Broken — readiness score not updated on course completion.**

`triggerReadinessUpdate` is called at line 5677 for the lesson completion branch, but the `nowComplete` branch (lines 5681–5699) calls `awardCoursePoints` and does **not** call `triggerReadinessUpdate`. Course completion XP is written correctly, but the readiness score is never recalculated.

**Impact:** A learner who completes a course will earn XP, but their readiness score (used in Insights, Leadership Dashboard, and team reports) will not reflect the course completion. If their only activity was completing that course, their readiness score stays at 0.

**Fix (one line):** Add `triggerReadinessUpdate(tid, uid)` inside the `nowComplete` branch after `awardCoursePoints(...)` on approximately line 5698.

---

## Workflow 4: Quiz Experience

### Step 11: Take a quiz

**Path:** Quizzes tab → assigned quiz → attempt → submit → `handleSubmitAttempt` → score → persist to `quiz_attempts` → results view.

**Code path:** Lines 8700–8960.

**Status:** ✅ Works for MC, TF, Slider, and Type Answer question types.

Open Ended and Pin Answer and Matching types are not yet implemented in the quiz player (separate from the live game context). Players hitting those types will see an incomplete experience.

---

### Step 12: Open assigned quiz from HomeScreen (deep-link)

**Path:** HomeScreen quiz card → "Start" → `onQuizClick(id)` → `setPendingQuizId(id)` → navigate to Quizzes tab → `useEffect` attempts to open quiz.

**Code path:** Lines 8764–8771.

**Status:** 🔴 **Broken for real users — race condition.**

The `pendingQuizId` effect has `[]` as its dependency array. It fires on mount before assignments are loaded from Supabase. `assignments.find(q => q.id === pendingQuizId)` returns `undefined`, the effect calls `onClearPendingQuiz()` consuming the deep-link, and the quiz never opens. Demo users are not affected (seed data is synchronous).

**Fix:** Add `assignmentsLoaded` to the effect deps and guard on it:
```js
useEffect(() => {
  if (!pendingQuizId || !assignmentsLoaded) return;
  // ... existing open logic
}, [pendingQuizId, assignmentsLoaded]);
```

---

## Workflow 5: Live Game

### Step 13: Manager creates a game session

**Path:** Games tab (manager) → select quiz → set name → "Launch" → `handleCreateSession` → `createGameSession` (Supabase) → PIN generated → routed to `rankd-lobby`.

**Code path:** Lines 15460–15487.

**Status:** ✅ Works.

`createGameSession` persists to `game_sessions` table. PIN is generated as `Math.floor(100000 + Math.random() * 900000)`. No collision guard — with concurrent sessions this is a 1-in-900k risk that becomes non-trivial at scale (see beta audit item #11).

---

### Step 14: Learner joins game by PIN

**Path:** Enter PIN screen → `handleEnterPin` → local session lookup → fallback Supabase fetch if cross-device → name entry → join lobby → `useGameChannel` presence.

**Code path:** Lines 15491–15540, `useGameChannel`.

**Status:** ✅ Works.

Cross-device join works via Supabase `game_sessions` table lookup by PIN. Presence is tracked via Supabase Realtime Broadcast. Player count in lobby syncs across host and participants.

---

### Step 15: Run the game (MC, TF, Slider, Type Answer questions)

**Path:** Host starts → questions cycle → players answer → host reveals → scores accumulate → game ends → `handleGameEnd` → `awardGamePointsForSession`.

**Status:** ✅ Works for MC, TF, Slider, Type Answer question types.

Real-time sync via BroadcastChannel. Score accumulation correct. XP written to `user_point_events` on game end.

---

### Step 16: Run the game (Open Ended questions)

**Path:** Host reaches open-ended question → `doReveal()` (line 2148) → `openResponses` built → `phase: "open-review"`.

**Code path:** Lines 2143–2199.

**Status:** 🔴 **Broken — only host/local player's response visible. No cross-device aggregation.**

In real mode, `openResponses` is built as `openSubmitted ? [{ text: typedAnswer, author: playerName, id: 0 }] : []`. Only the local player's own submitted answer is included. There is no `game_open_responses` table, no broadcast message for player open-ended submissions, and no grading path. The host sees at most one response (their own if they're also a player).

**Impact:** Live games using open-ended questions are effectively broken for real multi-device play.

**Fix (Large):** Add `game_open_responses` table. Broadcast `PLAYER_OPEN_RESPONSE` event on player submit. Host accumulates responses in state. Fetch remaining from DB on reveal as fallback.

---

### Step 17: Game ends → readiness update for participants

**Path:** `handleGameEnd` (line 15643) → `triggerReadinessUpdate(gameTenantId, user.id)` — fires for host only.

**Code path:** Lines 15622–15645.

**Status:** 🔴 **Broken — only the host's readiness score updates after a game.**

The comment at line 15643 reads "individual participant updates happen server-side" but no migration or DB trigger implements this. Participants earn XP (written via `awardGamePointsForSession`), but their readiness scores are never recalculated.

**Fix:** After `awardGamePointsForSession` resolves, iterate over `data?.scores` and call `triggerReadinessUpdate` for each participating user. Or: handle inside `scoringService.awardGamePointsForSession` to keep it co-located with the XP write.

---

### Step 18: Manager Games tabs (Start New / Past Sessions)

**Code path:** `RankdAdminPanel`, `activeSessions` / `pastSessions` split by `TERMINAL_STATUSES`.

**Status:** ⚠️ Task #111 is in_progress. Tab state and session filter logic is present in code but behavior is known-broken. Exact runtime failure requires live verification.

---

## Workflow 6: Verification Screens

### Step 19: Verify XP (ProgressScreen)

**Path:** Progress nav → `ProgressScreen` → loads `user_point_events`, `lesson_completions`, `quiz_attempts` → renders XP breakdown.

**Code path:** Lines 10780–10942.

**Status:** ✅ Works.

Full real Supabase data. Weekly XP trend, lesson completions, quiz attempt history, game XP — all sourced from `user_point_events`. No fallback to `profiles.xp` (correctly treated as legacy).

---

### Step 20: Verify leaderboard (LeaderboardScreen)

**Path:** Leaderboard nav → `LeaderboardScreen` → `scoringService.getLeaderboard` → renders rank table.

**Code path:** Lines 10958–11004.

**Status:** ✅ Works.

Breakdown by source type (learning XP, quiz points, game points), games played, quizzes completed — all from `user_point_events`. Tenant-scoped correctly.

---

### Step 21: Verify readiness (InsightsScreen — learner view)

**Path:** Insights nav → `InsightsScreen` → `getUserPerformance` → `computeAndSaveReadinessScore` → renders score breakdown.

**Code path:** Lines 13779–13910, `insightsService.js`.

**Status:** ⚠️ Works with caveats — **readiness score may be stale if triggers missed.**

`computeAndSaveReadinessScore` runs when InsightsScreen loads — this is a reliable fallback that recomputes from canonical sources. However:

1. If a user never visits Insights, their `readiness_scores` row (read by the Leadership Dashboard) is never written.
2. Course completion doesn't trigger readiness update (Step 10 above).
3. Game participants don't get a readiness update (Step 17 above).

The Insights screen itself renders correctly. The underlying score may undercount activity for the reasons above.

---

### Step 22: Verify analytics (LeadershipDashboard — org admin view)

**Path:** Home tab (org admin) → renders `LeadershipDashboardScreen` → loads `readiness_scores` → builds `liveData` → renders dashboard.

**Code path:** Lines 10205–10364.

**Status:** 🔴 **CRASHES with TypeError for real orgs that have readiness data.**

This is a critical new finding not captured in the Beta Readiness Audit.

**Root cause:** `liveData` is built at lines 10243–10247 as:
```js
setLiveData({
  company: { readinessScore: avg, previousScore: avg, targetScore: 90, trend: [] },
  teams:   [],
  people,
});
```
`liveData` has no `heatmap` property and no `trends` property.

At line 10276: `const data = liveData ?? LEADERSHIP_SEED`. When `liveData` is set (real user with data), `data` is `liveData`.

At line 10297: `const weakestTopic = [...data.heatmap].sort(...)`. `data.heatmap` is `undefined`. Spreading `undefined` throws:
```
TypeError: undefined is not iterable
```

**Crash condition:** Only occurs when `isReal === true` AND `readiness_scores` has at least one row for the tenant. Empty orgs show the empty state and never reach this code. Demo uses `LEADERSHIP_SEED` which has `heatmap` populated.

**Line 10285** is safe (`data.trends?.[trendPeriod] ?? []` — optional chaining).  
**Line 10296** is safe (`[...data.people]` — `people` is always an array in `liveData`).  
**Lines 10297–10298** crash.

**Fix (minimal):** Add `heatmap: []` to the `liveData` object at line 10243, and guard the sort callers:
```js
setLiveData({
  company: { ... },
  teams:   [],
  people,
  heatmap: [],   // ← add this
  trends:  {},   // ← add this
});
```
And add null guard at usage:
```js
const weakestTopic   = data.heatmap?.length ? [...data.heatmap].sort((a, b) => a.score - b.score)[0] : null;
const strongestTopic = data.heatmap?.length ? [...data.heatmap].sort((a, b) => b.score - a.score)[0] : null;
```

---

### Step 23: Verify manager views (TeamScreen, member management)

**Path:** Team nav (manager/admin) → orgUsers list → remove member / update role → `handleRemoveMember` / `handleUpdateMember` RPCs.

**Code path:** Lines 15216–15230.

**Status:** ⚠️ Works with caveats — **stale local state after RPC success.**

Both `handleRemoveMember` and `handleUpdateMember` call their respective RPCs. On RPC success, neither calls `setOrgUsers`. The removed/updated member remains in the UI until page refresh.

**Fix:** After RPC success:
- Remove: `setOrgUsers(prev => prev.filter(u => u.id !== profileId))`
- Update: `setOrgUsers(prev => prev.map(u => u.id === profileId ? { ...u, ...fields } : u))`

---

## Workflow 7: Additional Features

### Step 24: Battle Cards (learner view)

**Path:** Battle Cards nav → `BattleCardsScreen` (user branch) → category list → card detail.

**Code path:** Lines 9792–9883.

**Status:** ✅ Works.

Read-only for learners. Proper loading/empty guards for real users. Category filter and card detail navigation work.

---

### Step 25: Battle Cards (admin — CRUD)

**Path:** Battle Cards nav (admin) → create/edit/delete cards → Supabase persist.

**Status:** ✅ Works.

Full CRUD with Supabase for real users. Demo uses localStorage fallback.

---

### Step 26: Profile settings

**Path:** Profile nav → `ProfileScreen` → edit nickname/avatar/notification prefs → save → Supabase `profiles` upsert.

**Status:** ✅ Works.

Preferences persisted to Supabase for real users.

---

### Step 27: Password reset

**Path:** Login screen → "Forgot password" → `supabase.auth.resetPasswordForEmail` → email link → reset.

**Status:** ✅ Works.

---

### Step 28: Org settings (admin)

**Path:** Settings nav → org plan, seat limits, tenant metadata → `handleUpdateOrg` → `update_tenant` RPC.

**Code path:** Line 15177 (`handleUpdateOrg`), line 15168 (`handleCancelOrg` — direct table update bypass).

**Status:** ⚠️ Works with caveats — **`update_tenant` RPC may not be deployed.**

`handleCancelOrg` uses a direct table update with the comment "update_tenant RPC may not be deployed yet" (Task #94, in_progress). If the RPC is also broken, plan changes via `handleUpdateOrg` will fail silently in production.

---

### Step 29: AI Insights generation

**Path:** Insights screen → "Generate Insights" → `api/ai-insights.js` → OpenAI → rendered summary.

**Status:** ⚠️ Works with caveats — **fails silently if `OPENAI_API_KEY` not set.**

No 503 fallback message. Shows a broken spinner if the environment variable isn't configured in Vercel.

---

### Step 30: Role-based nav and plan gating

**Path:** Nav sidebar → `canAccess()` (plan check) + `hasPermission()` (role check) → conditional render.

**Status:** ✅ Works.

`canAccess()` gates features by tenant plan. `hasPermission()` gates by role. Both applied consistently across nav and screen actions. No cross-role data leakage found in nav rendering.

---

## Summary: Workflow Break Points

### 🔴 Critical — Workflow Terminates

| # | Where | What breaks |
|---|---|---|
| W1 | Course completion (`handleCompleteLesson` line 5698) | Readiness score not updated on course completion |
| W2 | LeadershipDashboard (`data.heatmap` line 10297) | **Crashes with TypeError for any real org with readiness data** |
| W3 | Deep-link quiz from HomeScreen (`pendingQuizId` effect) | Quiz never opens; deep-link silently consumed before assignments load |
| W4 | Live game open-ended questions (`doReveal`) | No cross-device response aggregation; host sees 0–1 responses |
| W5 | Game end → participants (`handleGameEnd`) | Only host's readiness score updates; all participants' readiness scores stale |

### ⚠️ Workflow Degrades (Completes with Gaps)

| # | Where | What degrades |
|---|---|---|
| D1 | OrgSetupScreen step 3 (hardcoded "user" role) | Cannot invite manager during onboarding; must do it post-setup |
| D2 | Invite email (`sendInviteEmail` fire-and-forget) | Email failure invisible; admin has no fallback link |
| D3 | Member management (`handleRemoveMember/UpdateMember`) | Stale UI after RPC success; list doesn't reflect change until refresh |
| D4 | Manager Games tabs | Known broken (Task #111) |
| D5 | Learn assigned filter (`learnFilter` state) | Filter state initialized but no tab UI wired; all content shows unfiltered |
| D6 | Readiness score triggers | Stale if user never visits Insights; missed on course completion and game end |
| D7 | `update_tenant` RPC (Task #94) | Plan/org changes may fail silently |
| D8 | AI Insights key missing | Silent spinner failure |
| D9 | Recording lesson type | Placeholder shown to reps; no actual submission path |

### ✅ Workflows Complete Correctly

Auth restore → role routing, org provisioning, lesson CRUD, course CRUD, assign content, learner lesson completion (individual), quiz MC/TF/Slider/TypeAnswer, cross-device game join, leaderboard, ProgressScreen XP, InsightsScreen readiness display, BattleCards read/write, ProfileScreen, password reset, role-based nav gating, multi-tenant isolation.

---

## Prioritized Fix List (Workflow-Ordered)

| Priority | Fix | Effort | Workflow step |
|---|---|---|---|
| **1** | `data.heatmap` crash in LeadershipDashboard | Trivial | Step 22 |
| **2** | Course completion → `triggerReadinessUpdate` | Small (1 line) | Step 10 |
| **3** | `pendingQuizId` race condition — add `assignmentsLoaded` dep | Small | Step 12 |
| **4** | Game end → `triggerReadinessUpdate` for all participants | Small–Medium | Step 17 |
| **5** | `handleRemoveMember/UpdateMember` → update `orgUsers` state | Small | Step 23 |
| **6** | Invite email failure — surface to admin with fallback link | Small | Step 3 |
| **7** | OrgSetupScreen — add role selector to invite step | Small | Step 2 |
| **8** | Manager Games tabs (Task #111) | Small–Medium | Step 18 |
| **9** | Learn filter UI — wire `learnFilter` to tab buttons | Small | Workflow 7 |
| **10** | Verify `update_tenant` RPC in Supabase SQL editor | Small | Step 28 |
| **11** | Open-ended live game aggregation | Large — v1.1 | Step 16 |
