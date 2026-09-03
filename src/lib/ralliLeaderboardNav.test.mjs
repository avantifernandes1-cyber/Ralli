// Role-navigation parity for the Ralli Live leaderboard (source-assertion test, same idiom as the
// Edge Function wiring tests). Guarantees the ONE canonical server-verified leaderboard lives inside
// Ralli Games for every role, with no separate global nav item and no legacy XP leaderboard.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

test("legacy XP LeaderboardScreen is fully removed (not defined, not referenced)", () => {
  assert.ok(!/LeaderboardScreen/.test(src), "LeaderboardScreen must be gone");
});

test("no separate global Leaderboard nav item for any role", () => {
  // The global sidebar/bottom-nav items came from NAV_ITEMS + superadmin list; none may carry a
  // leaderboard permKey/featureKey, and there must be no standalone Leaderboard nav entry.
  assert.ok(!/permKey:\s*"leaderboard"/.test(src), "no nav item may gate on permKey leaderboard");
  assert.ok(!/featureKey:\s*"leaderboard"/.test(src), "no nav item may gate on featureKey leaderboard");
  assert.match(src, /no global nav item/i);
});

test('the "leaderboard" route resolves into Ralli Games (RankdScreen), not a standalone screen', () => {
  assert.match(src, /case "leaderboard":\s*return <RankdScreen/);
});

test("Ralli Games exposes the SAME RalliLeaderboard to learners and managers/admins", () => {
  // Learner panel (Join a Game | My Scores | Leaderboard) and manager/admin panel (…| Leaderboard)
  assert.match(src, /<RalliLeaderboard currentUser=\{currentUser\} isManager=\{false\} \/>/);
  assert.match(src, /<RalliLeaderboard currentUser=\{currentUser\} isManager=\{true\} \/>/);
  // exactly one component definition — no second implementation
  assert.equal((src.match(/function RalliLeaderboard\(/g) || []).length, 1);
});

test("both Ralli Games panels list a Leaderboard tab", () => {
  // learner tabs include join/scores/leaderboard
  assert.match(src, /id: "join", label: "Join a Game" \}, \{ id: "scores", label: "My Scores" \}, \{ id: "leaderboard"/);
  // manager/admin tab set includes a leaderboard tab
  assert.match(src, /\{ id: "leaderboard", label: "Leaderboard"\s*\},/);
});

test("manager/orgAdmin role reaches the manager Ralli Games panel", () => {
  // gameRole is derived admin for admin-type profiles, and RankdScreen renders the admin panel for it.
  assert.match(src, /const gameRole = isAdminType \? "admin" : "user";/);
  assert.match(src, /role === "admin"[\s\S]{0,200}RankdAdminPanel/);
});
