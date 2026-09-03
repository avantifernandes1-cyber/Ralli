// Presentation-only helper for the host gameplay chrome.
//
// The host header/overlays show the EXISTING game PIN so a host can read it to a
// learner who needs to rejoin, without leaving gameplay. The PIN must remain
// visible in every host phase AND survive a host refresh/restore.
//
// Historically the chrome rendered the `pin` prop (app-level `lobbyPin`) directly.
// On a host refresh that app state is not rehydrated, so `pin` is empty even though
// KahootHostView has successfully restored its session from the server. The
// server-authorized restore (rpc_host_session_restore) DOES return the durable
// session PIN (`session.pin`), so we capture it and use it as a fallback here.
//
// This never generates, reconstructs, or mutates a PIN — it only chooses which
// already-existing value to display, and returns null when there is genuinely none
// (so callers render nothing rather than an empty label).

/**
 * Resolve the durable Game PIN to display in host gameplay chrome.
 * Prefers the live prop; falls back to the PIN captured from the host restore.
 *
 * @param {string|number|null|undefined} propPin     - live `pin` prop (lobbyPin)
 * @param {string|number|null|undefined} restoredPin - PIN from the server restore
 * @returns {string|null} the PIN as a trimmed string, or null when none exists
 */
export function resolveHostPin(propPin, restoredPin) {
  const p = propPin == null ? "" : String(propPin).trim();
  if (p) return p;
  const r = restoredPin == null ? "" : String(restoredPin).trim();
  if (r) return r;
  return null;
}

/**
 * Compact label for the narrow/split-screen host PIN chip, e.g. "PIN 492188".
 * Returns null when there is no PIN (chip should not render).
 *
 * @param {string|number|null|undefined} pin
 * @returns {string|null}
 */
export function hostPinChipLabel(pin) {
  const resolved = resolveHostPin(pin, null);
  return resolved ? `PIN ${resolved}` : null;
}
