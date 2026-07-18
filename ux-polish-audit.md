# ralli UX Polish Audit — CEO Demo Readiness
**Date:** 2026-07-16 | **Lens:** Would a customer notice this and lose confidence?

Ordered by demo impact. Engineering issues excluded — every item here is copy, layout, or interaction design.

---

## 🔴 Demo-Killers — Fix Before Showing Anyone

### 1. "Knowledge Score" vs "Readiness Score" — same number, two names
HomeScreen stat card calls it **"Knowledge Score."** InsightsScreen calls it **"Readiness Score."** Same metric, same value, two labels. A prospect will notice the number matches, ask which one it is, and start questioning whether the product is coherent.

**Fix:** Pick one name and use it everywhere. "Readiness Score" is more distinctive and already drives the analytics narrative.

**Files:** `HomeScreen` line 648 — change `label: "Knowledge Score"` to `label: "Readiness Score"`. Update tooltip copy to match.

---

### 2. Team Rank shows hardcoded "of 18" for all users
Line 652: `` `#${user.rank} of 18` `` — the **"18" is a hardcoded literal**. A team of 5 would show "#2 of 18." This is immediately visible on the home screen in the stat cards.

**Fix:** Pass the actual team size and compute `of ${orgUsers.length}`. If the count isn't loaded yet, show `#${user.rank}` with no denominator until it resolves.

---

### 3. Internal developer text rendered to end users
When OpenAI isn't configured, InsightsScreen shows real users:
> *"AI summary unavailable. Configure OPENAI_API_KEY in Vercel environment variables to enable."*

This is internal infrastructure copy. A beta customer would screenshot this immediately.

**Fix:** Replace with: *"Performance summary coming soon — check back after completing more lessons and quizzes."* Or hide the section entirely when unavailable.

**File:** InsightsScreen, line 13984.

---

### 4. Login page displays "DEMO ACCOUNTS — any password works"
The login page prominently lists all seed accounts with a callout saying "DEMO ACCOUNTS — any password works." Any real customer visiting the login page sees this and wonders what kind of security posture the product has.

**Fix:** Gate demo accounts behind an environment variable or a collapsible "Development access" link that only shows in dev/staging.

---

## ⚠️ High Confidence Impact — Fix Before First Customer Onboards

### 5. Browser `alert()` and `window.confirm()` used for errors and confirmations
TeamScreen uses `window.confirm()` for delete confirmations and `alert()` for error messages. These are browser-native popups that look completely wrong inside a modern SaaS UI. They break the visual context, can't be styled, and scream "unfinished."

**Fix:** Replace with inline `<ConfirmModal>` for destructive actions and `toast.error()` for failures — the toast utility already exists throughout the app.

**File:** TeamScreen, lines 12701, 12751, 12759.

---

### 6. Nav item for Games is labeled "ralli" — the platform's own name
In the sidebar nav, the Games feature is labeled **"ralli"** with a green "LIVE" badge. This means the nav reads: *Home / Learn / Quizzes / **ralli** / Battle Cards / Leaderboard*. A customer would wonder if clicking "ralli" takes them somewhere meta, or if that's a bug.

**Fix:** Rename the nav item to "Games" or "Live Games." The "LIVE" badge already signals its purpose.

**File:** Nav items array, line 15773 — change `label: "ralli"` to `label: "Games"`.

---

### 7. Sign-out button shows "↩" — looks like a back button
The sign-out control in the sidebar bottom card uses the Unicode character `↩` (leftwards arrow with hook). Without hovering to see the tooltip, a user can't tell if it signs them out or navigates back. This creates a risk of accidental sign-outs in a demo.

**Fix:** Use a clearer label — either the word "Sign out" at small size, a door/exit icon, or a tooltip-revealed action that's less ambiguous.

**File:** Sidebar, line 15850.

---

### 8. "0 tasks remaining" is grammatically wrong and feels unpolished
When a learner has no pending assignments, the home screen subtitle reads: **"Jun 28 · 0 tasks remaining"**. This is factually correct but sounds wrong. The "0" especially looks like a display bug to most users.

**Fix:** 
```js
pendingCount === 0 ? "All caught up ✓" : `${pendingCount} task${pendingCount !== 1 ? "s" : ""} remaining`
```

**File:** HomeScreen, line 638.

---

### 9. Weekly XP chart uses ISO week numbers ("W28") as labels
The ProgressScreen bar chart displays week labels like "W20", "W21", "W28". Most users have no idea what "W28" means. This is the first thing someone looks at when visiting their progress — it should be immediately readable.

**Fix:** Format as short date ranges: "Jun 2–8", "Jun 9–15". Or use relative labels: "4 weeks ago", "3 weeks ago", "Last week", "This week."

**File:** ProgressScreen, line 10842 — update the key format when building `buckets`.

---

### 10. After onboarding setup completes, the user lands on a blank Team page
The `OrgSetupScreen` completes and routes to `setScreen("team")`. The Team screen greets the new admin with an empty member list and no context. There's no "Your org is ready!" message, no next-step guidance, no celebration.

**Fix:** Add a first-run banner on the Team screen when `members.length === 0` and the org was just created: *"Your team is ready. Invite your first rep to get started."* with a CTA to the invite modal.

---

### 11. "Start New Game" tab title conflicts with what the tab actually shows
The Games manager panel has a tab labeled **"Start New Game"** but its content header reads **"Active Sessions."** If there are active sessions, the tab feels mismatched — someone clicks "Start New" expecting a creation form, and instead sees a list of existing sessions.

**Fix:** Rename the tab to **"Active"** and keep "Past Sessions" as-is. Separate the "+ New Game" button visually as the primary action, not a tab concept.

---

## 💡 Polish Opportunities — Small Lifts, Real Impact

### 12. "Not passed" badge on quiz cards
The badge text "Not passed" (QuizzesScreen, line 8936) is grammatically awkward. It reads like the quiz didn't pass a filter, not like the user didn't pass.

**Fix:** Change to "Retry" or "Incomplete." Pairs cleanly with the "Passed" badge.

---

### 13. "Begin →" on HomeScreen vs "Start →" on QuizzesScreen — same action, different labels
HomeScreen assignment CTA says **"Begin →"** (line 712). QuizzesScreen CTA says **"Start →"** (line 8961). Same action. Pick one.

**Fix:** Standardize to "Start →" — it matches the quiz tab label "Start" and is the shortest clear option.

---

### 14. ProgressScreen Level card uses "→" as a visual element between levels
The Level Progress card renders: **[current level] → [next level]** using a raw "→" text character. It looks like a placeholder that never got designed.

**Fix:** Replace the arrow with a thin progress arc or a simple "→ Level {n+1}" inline label next to the XP bar. Even removing the arrow and just showing the XP bar with labels reads better.

---

### 15. Sidebar role label shows "Manager" for the org owner
The org admin's sidebar bottom card displays the role label **"Manager"** (line 15833: `isOrgAdmin ? "Manager" : ...`). But the org admin is the owner, not a manager. If there are other users with the manager role, their own admin would see themselves labeled the same way.

**Fix:** Show "Admin" or "Owner" for orgAdmin. "Manager" should be reserved for the manager role.

---

### 16. QuizzesScreen loading state is inconsistent with every other screen
All other screens use `<LoadingState rows={...} />` which renders animated skeleton rows. QuizzesScreen uses a plain centered div: *"Loading quizzes…"* (line 8819). It looks unfinished by comparison.

**Fix:** Replace the loading div with `<LoadingState rows={3} message="Loading quizzes…" />` — one line change.

---

### 17. InsightsScreen "AI SUMMARY" section heading is technical product copy
The section label "AI SUMMARY" (all caps, line 13976) in a customer-facing screen puts implementation details front and center. Customers paying for this want the insight, not a label reminding them it's AI-generated.

**Fix:** Change to "Performance Summary" or "Weekly Digest." If you want to signal AI, a subtle ✦ icon or "Powered by AI" in the footer is cleaner than a section heading.

---

### 18. Invite URL shown to admins as a 50-character raw token URL in a 10px font input
During onboarding (OrgSetupScreen step 3) and in TeamScreen, the invite link is shown inside a `<input readOnly>` at `fontSize: 10` (line 11795). The URL includes a full JWT-like token. At 10px on a standard monitor this is unreadable, and the layout looks cramped.

**Fix:** Truncate the URL visually (show just the domain + "...") and make the Copy button more prominent. The actual URL is in the clipboard — the display just needs to signal "link ready to copy," not show the full token.

---

### 19. Two screens show nearly identical activity stats with no clear differentiation
InsightsScreen has an "Activity Summary" section showing 6 metrics (lessons done, courses done, quizzes taken, etc.). ProgressScreen shows the same numbers in its stat cards. A customer navigating both will ask "why is this data in two places?"

**Fix:** Differentiate by purpose: ProgressScreen = historical trends + level/XP arc. InsightsScreen = readiness score + actionable next steps. Remove the generic "Activity Summary" grid from InsightsScreen, or replace it with something Insights-specific (e.g., "Weakest Area" or "Fastest Improvement").

---

### 20. BattleCards search disappears when browsing a category
The search bar is available on the BattleCards home view but disappears when you drill into a category. If you remember seeing a relevant card but don't know which category it's in, you have to navigate back to search.

**Fix:** Keep the search bar visible in the category view. When a search term is active and matches a card in a different category, show a "See all results →" link that takes you back to the filtered home view.

---

## Summary: Quick Wins (Under 30 Minutes Each)

| # | Fix | Where |
|---|---|---|
| 1 | Rename "Knowledge Score" → "Readiness Score" | HomeScreen line 648 |
| 2 | Fix "of 18" to use real team size | HomeScreen line 652 |
| 3 | Replace developer error text in Insights | InsightsScreen line 13984 |
| 6 | Rename "ralli" nav item to "Games" | Nav items line 15773 |
| 7 | Fix "↩" sign-out icon | Sidebar line 15850 |
| 8 | Fix "0 tasks remaining" copy | HomeScreen line 638 |
| 12 | "Not passed" → "Retry" | QuizzesScreen line 8936 |
| 13 | "Begin →" → "Start →" | HomeScreen line 712 |
| 15 | "Manager" → "Admin" for org owner sidebar label | Sidebar line 15833 |
| 16 | Use `LoadingState` in QuizzesScreen | QuizzesScreen line 8819 |
| 17 | "AI SUMMARY" → "Performance Summary" | InsightsScreen line 13976 |

**Medium effort (but high value for demo):**
- #5 — Replace `alert()` / `window.confirm()` with toasts + modals
- #9 — Human-readable XP chart date labels
- #10 — Post-setup welcome state for new orgs
- #11 — Fix "Start New Game" tab label/structure
