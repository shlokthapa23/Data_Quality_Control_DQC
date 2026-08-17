/**
 * How a table's row count is shown in the pickers.
 *
 * Shared by the S2D table lists and the Validation Setup picker so the two can't
 * drift - and kept in its own module rather than exported from TestCasePanel,
 * which would pull that whole component into MappingsPage's bundle for two
 * helper functions.
 */

/**
 * An empty table is worth noticing BEFORE writing a check against it: a rule
 * over 0 rows passes trivially and proves nothing, so 0 is called out in red
 * while a populated table stays a calm green.
 *
 * null means the count couldn't be read - neither good nor bad - so it stays
 * neutral grey rather than implying a problem with the data.
 */
export function rowCountStyle(count) {
  if (count === null || count === undefined) return 'text-slate-500 bg-slate-100';
  return count === 0 ? 'text-red-600 bg-red-50' : 'text-emerald-700 bg-emerald-50';
}

/** "1,000 rows", or "—" when the count couldn't be read. */
export function formatRowCount(count) {
  if (count === null || count === undefined) return '—';
  return `${count.toLocaleString()} rows`;
}

/** Tooltip text explaining what the badge means. */
export function rowCountTitle(count) {
  if (count === null || count === undefined) return 'Row count unavailable';
  if (count === 0) {
    // Says what to do next, not just what's wrong: a check against an empty
    // table passes trivially, so the table needs populating before it can be
    // meaningfully tested.
    return 'This table currently holds no records. Test cases cannot be meaningfully '
      + 'evaluated against it, as any check would pass without verifying anything. '
      + 'Load data into the table - for example by running the relevant pipeline from '
      + 'Test Data Preparation - before defining test cases.';
  }
  return `${count.toLocaleString()} rows`;
}
