/**
 * Client-side mirror of Backend/s2d/column_map.py.
 *
 * A validation's column map is an opt-in list of "common names", each binding
 * differently-named physical columns across that validation's tables to one
 * shared name a test case can reference. Shape (as stored and as sent to
 * PUT /api/s2d/mappings/:id/column-map):
 *
 *   [{ name: 'order_id',
 *      source:      { '"dbo"."orders_a"': 'OrderID', '"dbo"."orders_b"': 'order_no' },
 *      destination: { '"dbo"."orders_gold"': 'OrderKey' } }]
 *
 * Keep these helpers in step with the Python ones - the backend re-validates
 * everything on save, so a drift here shows up as a rejected save rather than
 * bad data, but the two should still agree on what's selectable.
 */

export const SIDES = ['source', 'destination'];

/** The mapping's column map, always an array - [] when nobody has opted in. */
export function entriesOf(mapping) {
  const raw = mapping?.column_map;
  return Array.isArray(raw) ? raw : [];
}

const entryName = (entry) => (entry?.name || '').trim();

/**
 * Common names whose map covers EVERY table in `tables` on `side`.
 *
 * Partially-covered names are deliberately excluded: the engine would fall
 * back to a literal lookup on the uncovered tables and fail at run time, so
 * it's better that the option simply isn't offered. Mirrors common_names().
 */
export function commonNamesFor(mapping, side, tables) {
  if (!tables || tables.length === 0) return [];
  return entriesOf(mapping)
    .filter((entry) => {
      if (!entryName(entry)) return false;
      const sideMap = entry[side] || {};
      return tables.every((t) => sideMap[t]);
    })
    .map(entryName);
}

/**
 * Fold away the cosmetic differences between the same field's name in
 * different tables - case, underscores, spaces, punctuation - so
 * "OrderID" / "order_id" / "Order Id" all collapse to "orderid".
 *
 * Only ever used to PROPOSE rows in the mapper's auto-match; nothing is
 * persisted until the tester reviews and saves, so a wrong guess here costs a
 * click to delete, not bad data.
 */
export function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build proposed column-map entries by grouping each table's columns on their
 * normalized name. `tablesBySide` is { source: [{table, columns}], destination: [...] }.
 * Only groups covering at least two tables are proposed - a common name that
 * covers one table carries no information.
 */
export function autoMatchEntries(tablesBySide) {
  const groups = new Map(); // normalized -> { labels: [], source: {}, destination: {} }

  SIDES.forEach((side) => {
    (tablesBySide[side] || []).forEach(({ table, columns }) => {
      (columns || []).forEach((column) => {
        const key = normalizeName(column.name);
        if (!key) return;
        if (!groups.has(key)) groups.set(key, { labels: [], source: {}, destination: {} });
        const group = groups.get(key);
        // One column per table per common name - first spelling wins, which
        // for a normalized match means any of them would do.
        if (!group[side][table]) {
          group[side][table] = column.name;
          group.labels.push(column.name);
        }
      });
    });
  });

  return [...groups.values()]
    .filter((g) => Object.keys(g.source).length + Object.keys(g.destination).length >= 2)
    .map((g) => ({
      // Prefer the most common spelling as the proposed name, so the tester
      // sees something familiar rather than a mangled normalized key.
      name: mostCommon(g.labels),
      source: g.source,
      destination: g.destination,
    }));
}

function mostCommon(values) {
  const counts = new Map();
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
