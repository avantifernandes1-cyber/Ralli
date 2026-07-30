/**
 * Ralli Live — zero-player halt connectivity rule (pure, testable).
 *
 * The host auto-pauses ("halts") a running game when every connected player has
 * left, so it never runs unattended and silently marks absent people wrong. The
 * decision must be robust against a momentary empty Presence sync (roster resync,
 * channel re-subscribe, a start-of-game presence gap) while a player is provably
 * still there via the durable heartbeat.
 *
 * A player counts as CONNECTED if EITHER source proves an eligible active player:
 *   • realtime Presence (the fast path) — trusted only while the host channel is
 *     SUBSCRIBED (otherwise the roster is not authoritative → "unknown"), OR
 *   • the durable fresh participant heartbeat (the veto / recovery source) —
 *     trusted only once the roster has loaded at least once (otherwise a count of
 *     0 means "not loaded yet", not "zero players").
 *
 * Verdict:
 *   'connected' — at least one source proves an eligible active player.
 *   'zero'      — BOTH sources are KNOWN and definitively zero.
 *   'unknown'   — at least one source is loading/unknown/error; hold and retry,
 *                 never conclude a disconnect.
 *
 * The caller only advances toward the halt grace window on 'zero'; 'unknown' and
 * 'connected' both cancel any in-progress zero streak. This keeps Presence as the
 * fast path while the durable heartbeat vetoes a false halt — so a genuine
 * tab-close / dropped websocket halts only after the heartbeat goes stale AND the
 * grace window, never on a reconnect/refresh blip.
 *
 * @param {object} args
 * @param {boolean} args.presenceKnown      - host channel is SUBSCRIBED
 * @param {number}  args.presenceCount      - eligible players in the presence roster
 * @param {boolean} args.durableKnown       - durable roster has loaded ≥1 time
 * @param {number}  args.durableActiveCount - eligible players with a FRESH heartbeat
 * @returns {'connected'|'zero'|'unknown'}
 */
export function evaluateConnectivity({ presenceKnown, presenceCount, durableKnown, durableActiveCount }) {
  const presenceActive = !!presenceKnown && Number(presenceCount) > 0;
  const durableActive  = !!durableKnown  && Number(durableActiveCount) > 0;
  if (presenceActive || durableActive) return "connected";
  if (!presenceKnown || !durableKnown) return "unknown";
  return "zero";
}

export default { evaluateConnectivity };
