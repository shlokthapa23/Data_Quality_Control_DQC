import { useEffect, useRef, useState } from 'react';
import { Bell, RefreshCw, CalendarClock, ListChecks, DatabaseZap, Activity } from 'lucide-react';
import { fetchNotifications } from '../../api';

const LAST_SEEN_KEY = 'notifications_last_seen_at';

// Icon by notification type - purely cosmetic, falls back to a generic dot
// for any type this hasn't been taught about yet (keeps this forward-
// compatible with new notification kinds added later without a crash).
const TYPE_ICON = {
  schedule_fired: CalendarClock,
  suite_run: ListChecks,
  test_data_inserted: DatabaseZap,
  harvest_run: RefreshCw,
};

function iconFor(type) {
  return TYPE_ICON[type] || Activity;
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Notifications are global (not per-user) - see Backend/notifications/db.py's
 * module docstring for why. "Read" state is therefore tracked purely client
 * side: a last-seen timestamp in localStorage. Opening the panel marks
 * everything visible at that moment as seen; anything that arrives after
 * stays unread until the next open.
 */
export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState(() => localStorage.getItem(LAST_SEEN_KEY) || '');
  const panelRef = useRef(null);

  const load = () => {
    fetchNotifications(50).then((data) => setItems(data.notifications || [])).catch(() => {});
  };

  useEffect(() => {
    load();
    // Schedules/suites fire in the background with no user action to hang a
    // refresh off of, so this is plain polling - 20s is frequent enough to
    // feel live without hammering the one shared SQLite file.
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const unreadCount = lastSeenAt
    ? items.filter((n) => n.created_at > lastSeenAt).length
    : items.length;

  const toggleOpen = () => {
    setOpen((v) => !v);
    if (!open) {
      const now = new Date().toISOString();
      localStorage.setItem(LAST_SEEN_KEY, now);
      setLastSeenAt(now);
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={toggleOpen}
        title="Notifications"
        className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[1rem] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 max-h-[70vh] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 sticky top-0 bg-white">
            <span className="text-sm font-semibold text-slate-800">Notifications</span>
            <button onClick={load} title="Refresh" className="p-1 text-slate-400 hover:text-mastek-primary rounded">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          {items.length === 0 ? (
            <p className="text-sm text-slate-400 italic px-4 py-6 text-center">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((n) => {
                const Icon = iconFor(n.type);
                return (
                  <li key={n.id} className="flex items-start gap-3 px-4 py-2.5">
                    <Icon className="w-4 h-4 text-mastek-primary shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm text-slate-700">{n.message}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(n.created_at)}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
