export function humanizeTrigger(sched) {
  if (sched.trigger_type === 'interval') {
    const s = sched.trigger_config?.seconds || 0;
    if (s % 3600 === 0) return `Every ${s / 3600}h`;
    if (s % 60 === 0) return `Every ${s / 60}m`;
    return `Every ${s}s`;
  }
  const expr = sched.trigger_config?.expression || '';
  return `cron: ${expr} (${sched.timezone || 'UTC'})`;
}

export const STATUS_STYLES = {
  ran:       'bg-mastek-success/10 text-mastek-success',
  coalesced: 'bg-amber-100 text-amber-700',
  missed:    'bg-amber-100 text-amber-700',
  errored:   'bg-red-100 text-red-700',
};
