/**
 * Readiness V2 — pure presentation/logic helpers for Settings → Readiness.
 *
 * These are DISPLAY helpers only. They never decide readiness scores or the
 * authoritative setup-complete gate for activation — the server does that
 * (readiness_v2_validate). deriveSetupState mirrors the server's rule purely to
 * drive UI affordances (disable Activate, show "Readiness setup incomplete"); the
 * server re-checks on activate and is the real gate. Kept dependency-free so it is
 * unit-testable under `node --test`.
 */

// Minimum supported readiness tags for a valid (activatable) configuration.
export const MIN_READINESS_TAGS = 2;

// UI authorization gate for Settings → Readiness. Mirrors the server contract
// (readiness_caller_can_configure = orgAdmin/manager OR is_ralli_admin). This is a
// convenience gate only — the RPCs + tenant-scoped RLS are the real boundary
// (they also enforce same-tenant, so a cross-tenant manager cannot manage another
// tenant even though this returns true for their role). Learners (role 'user') are
// excluded here and by the server. Unknown/empty roles are denied.
export function canAccessReadinessSettings(role) {
  return role === "orgAdmin" || role === "manager"
      || role === "ralli_admin" || role === "superadmin";
}

// Human-readable label for a server-supplied tag warning code.
export function warningLabel(code) {
  switch (code) {
    case "archived_or_merged":       return "Tag is archived or merged — it cannot support readiness.";
    case "no_active_quiz":           return "No active quiz supports this tag.";
    case "no_graded_questions":      return "No graded questions in the supporting quizzes.";
    case "designated_but_unsupported": return "Counts toward readiness but has no assessment coverage.";
    default:                          return code;
  }
}

// A tag row is a VALID readiness tag iff it is active and has real assessment
// coverage (server supplies coverageSufficient = active quiz + ≥1 graded question).
export function isValidReadinessTag(tag) {
  return !!tag && tag.status === "active" && !!tag.coverageSufficient;
}

// Derive the UI setup state from the tag-candidates payload. Returns counts, the
// setup-complete flag, whether Activate should be enabled, and an honest reason
// string when incomplete. This is advisory UI logic — the server is authoritative.
export function deriveSetupState(payload) {
  const tags = (payload && Array.isArray(payload.tags)) ? payload.tags : [];
  const designated = tags.filter(t => t && t.countsTowardReadiness);
  const valid = designated.filter(isValidReadinessTag);
  const required = designated.filter(t => t.isRequired);
  const requiredSupported = required.filter(isValidReadinessTag);
  const unsupportedDesignated = designated.filter(t => !isValidReadinessTag(t));

  // Official readiness is scored ONLY over REQUIRED areas, so a config is activatable iff it
  // has ≥1 REQUIRED readiness tag and every required tag has coverage. Optional tags are
  // insights only and never block activation (nor are they scored).
  const setupComplete = required.length >= 1
    && required.length === requiredSupported.length;

  let reason = null;
  if (!setupComplete) {
    if (required.length < 1) {
      reason = "Readiness setup incomplete — designate at least one REQUIRED readiness area (optional areas alone are insights only and are never scored).";
    } else if (required.length !== requiredSupported.length) {
      reason = "Readiness setup incomplete — one or more required readiness areas have no assessment coverage.";
    } else {
      reason = "Readiness setup incomplete.";
    }
  }

  return {
    designatedCount: designated.length,
    validCount: valid.length,
    requiredCount: required.length,
    requiredSupportedCount: requiredSupported.length,
    unsupportedDesignatedCount: unsupportedDesignated.length,
    setupComplete,
    canActivate: setupComplete,
    reason,
  };
}

// Build the server payload [{tagId, required}] from the current UI rows (only the
// rows the manager has marked as counting toward readiness).
export function draftDesignationsFrom(rows) {
  return (rows || [])
    .filter(r => r && r.countsTowardReadiness)
    .map(r => ({ tagId: r.tagId, required: !!r.isRequired }));
}

// Is the current UI draft different from the last-saved designation set? Compares
// the designated tag ids + their required flags (order-independent).
export function isDraftDirty(rows, savedDesignations) {
  const now = normalizeDesig(draftDesignationsFrom(rows));
  const saved = normalizeDesig(savedDesignations || []);
  if (now.length !== saved.length) return true;
  for (let i = 0; i < now.length; i++) {
    if (now[i].tagId !== saved[i].tagId || now[i].required !== saved[i].required) return true;
  }
  return false;
}

function normalizeDesig(list) {
  return (list || [])
    .map(d => ({ tagId: d.tagId ?? d.tag_id, required: !!(d.required ?? d.is_required) }))
    .sort((a, b) => (a.tagId < b.tagId ? -1 : a.tagId > b.tagId ? 1 : 0));
}

// One-line banner text for the whole config surface.
export function setupBanner(state) {
  if (!state) return "";
  return state.setupComplete
    ? "Readiness configuration is valid and ready to activate."
    : (state.reason || "Readiness setup incomplete.");
}
