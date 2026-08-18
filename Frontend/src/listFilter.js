/**
 * Filtering helpers for the long table lists.
 *
 * Plain functions in their own module rather than alongside the ListFilter
 * component: a file that exports both a component and helpers breaks Fast
 * Refresh, which is the same reason rowCount.js and sqlLint.js live here.
 */

/** Case-insensitive substring match on whatever each item calls its name. */
export function filterByName(items, query, getName = (i) => i) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => String(getName(item) ?? '').toLowerCase().includes(q));
}

/** Message for when a filter hides everything - never leave a blank list. */
export function noMatchNote(query) {
  return `Nothing matches "${query}".`;
}
