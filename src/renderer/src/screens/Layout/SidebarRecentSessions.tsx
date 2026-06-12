import { useCallback, useEffect, useRef, useState, memo } from "react";
import { useI18n } from "../../components/useI18n";
import { Circle } from "../../assets/icons";

interface RecentSession {
  id: string;
  title: string;
}

// ChatGPT-style recent list under the Sessions nav item.
export const RECENT_SESSIONS_LIMIT = 5;

// Re-sync cadence while the list is visible. Deliberately slower than the
// Sessions screen (30s) — the sidebar is always on screen, so this interval
// runs for the whole app lifetime when the section is expanded.
const RECENT_REFRESH_MS = 60_000;

// Minimum gap between event-driven refreshes (focus, session switch) so a
// burst of focus/blur events doesn't hammer state.db.
const REFRESH_THROTTLE_MS = 5_000;

function sameSessions(a: RecentSession[], b: RecentSession[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].title !== b[i].title) return false;
  }
  return true;
}

/**
 * Recent-sessions list rendered under the "Sessions" nav item in the sidebar
 * (like ChatGPT's sidebar chat list). Owns its own data so Layout re-renders
 * (view switches, update banners, …) never trigger fetches, and `memo` keeps
 * it off the render hot path entirely.
 *
 * Fetch strategy, cheapest first:
 *  - on open: instant read from the sessions.json cache (no DB), then one
 *    sync against state.db to pick up sessions created since the last sync
 *  - while open: refresh on window focus and on a slow interval, throttled
 *  - closed (collapsed section or icon-only sidebar): zero work, renders null
 */
const SidebarRecentSessions = memo(function SidebarRecentSessions({
  open,
  currentSessionId,
  onSelect,
}: {
  open: boolean;
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const lastRefreshRef = useRef(0);

  const applySessions = useCallback(
    (list: Array<{ id: string; title: string }>): void => {
      const next = list
        .slice(0, RECENT_SESSIONS_LIMIT)
        .map(({ id, title }) => ({ id, title }));
      // Skip the state update (and re-render) when nothing changed — the
      // common case for periodic refreshes.
      setSessions((prev) => (sameSessions(prev, next) ? prev : next));
    },
    [],
  );

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastRefreshRef.current < REFRESH_THROTTLE_MS) return;
      lastRefreshRef.current = now;
      try {
        const synced = await window.hermesAPI.syncSessionCache();
        applySessions(synced);
      } catch {
        // keep whatever we had — the list is best-effort UI sugar
      }
    },
    [applySessions],
  );

  // Initial load when the section opens: paint from the JSON cache
  // immediately (no DB access), then sync once for anything new.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.hermesAPI
      .listCachedSessions(RECENT_SESSIONS_LIMIT)
      .then((cached) => {
        if (!cancelled && cached.length > 0) applySessions(cached);
      })
      .catch(() => {});
    lastRefreshRef.current = Date.now();
    void (async () => {
      try {
        const synced = await window.hermesAPI.syncSessionCache();
        if (!cancelled) applySessions(synced);
      } catch {
        // cache read above already painted something
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, applySessions]);

  // While open: pick up background sessions (gateway, cron, other devices)
  // on focus and on a slow timer. No listeners or timers at all when closed.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void refresh(), RECENT_REFRESH_MS);
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, refresh]);

  // Resuming/switching sessions reorders recency — refresh (throttled).
  useEffect(() => {
    if (open && currentSessionId) void refresh();
  }, [open, currentSessionId, refresh]);

  // Keep the wrapper mounted so the collapse/expand animates (CSS grid-rows
  // trick). Returning null would make it pop in/out. Effects above are still
  // gated on `open`, so a closed section does no fetching — it just keeps the
  // last-loaded list in the DOM to animate shut. Stay unmounted only until the
  // first sessions arrive, so a brand-new profile renders nothing.
  if (sessions.length === 0) return null;

  const expanded = open;

  return (
    <div
      className={`sidebar-recent-sessions-wrap ${expanded ? "expanded" : ""}`}
      aria-hidden={!expanded}
    >
      <div className="sidebar-recent-sessions">
        {sessions.map((s) => {
          const title = s.title || t("sessions.newConversation");
          return (
            <button
              key={s.id}
              type="button"
              className={`sidebar-recent-session ${
                currentSessionId === s.id ? "active" : ""
              }`}
              onClick={() => onSelect(s.id)}
              title={title}
              tabIndex={expanded ? 0 : -1}
            >
              <Circle className="sidebar-recent-session-dot" size={7} />
              <span className="sidebar-recent-session-title">{title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

export default SidebarRecentSessions;
