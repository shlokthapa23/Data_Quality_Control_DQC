/**
 * Instant, zero-latency SQL hints for the test-case editors.
 *
 * These are HINTS, never blockers. They're heuristics, not a parser, so they
 * must never stop the tester saving something the real database would accept.
 * The authoritative check is the "Check syntax" button, which EXPLAINs the query
 * on the actual connector and catches things no regex can - misspelled column
 * and table names above all. This file exists purely so the common mistakes get
 * caught without waiting ~5-9s for a Fabric round trip.
 *
 * Every rule here corresponds to a mistake actually made against this tool:
 * WHERE placed before FROM, and aliasing the output column something other than
 * the one the check compares.
 */

/** The output column each check scope compares. */
export function requiredColumnFor(checkScope) {
  return checkScope === 'dual_script' ? 'value' : 'passed';
}

/**
 * Strip comments and blank out string-literal CONTENT, so the keyword and
 * bracket checks below only see executable code. Mirrors _strip_sql_comments in
 * Backend/connectors/sql_guard.py - notably, 'a--b' is data, not a comment.
 * Returns { code, unterminatedString }.
 */
function toCode(sql) {
  let out = '';
  let i = 0;
  let inString = false;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        // '' is an escaped quote inside a literal, not the end of one.
        if (sql[i + 1] === "'") { i += 2; continue; }
        inString = false;
        out += "''"; // collapse the whole literal to an empty one
      }
      i += 1;
    } else if (ch === "'") {
      inString = true;
      i += 1;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end; // keep the newline
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? n : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return { code: out, unterminatedString: inString };
}

/** Net bracket balance, and whether it ever went negative (a stray closer). */
function bracketBalance(code) {
  let depth = 0;
  let wentNegative = false;
  for (const ch of code) {
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) wentNegative = true;
    }
  }
  return { depth, wentNegative };
}

/** The column list, i.e. what sits between the first SELECT and its FROM. */
function selectList(code) {
  const start = code.search(/\bselect\b/i);
  if (start === -1) return '';
  const rest = code.slice(start + 6);
  const from = rest.search(/\bfrom\b/i);
  return from === -1 ? rest : rest.slice(0, from);
}

function mentionsColumn(list, column) {
  const aliased = new RegExp(`\\bas\\s+"?${column}"?\\b`, 'i');
  const bare = new RegExp(`(^|,)\\s*"?${column}"?\\s*(,|$)`, 'i');
  return aliased.test(list) || bare.test(list);
}

/**
 * Returns an array of hint strings - empty means nothing obviously wrong (which
 * is NOT the same as "valid"; only the database can say that).
 */
export function lintSql(sql, { requiredColumn } = {}) {
  const raw = (sql || '').trim();
  if (!raw) return [];

  const hints = [];
  const { code, unterminatedString } = toCode(raw);
  const trimmedCode = code.trim();

  if (unterminatedString) {
    hints.push("Unclosed quote — a ' was opened and never closed.");
  }

  const { depth, wentNegative } = bracketBalance(code);
  if (wentNegative) {
    hints.push('A closing ) appears before its opening (.');
  } else if (depth > 0) {
    hints.push(`${depth} unclosed ${depth === 1 ? 'bracket' : 'brackets'} — add ${depth} more ).`);
  }

  if (trimmedCode && !/^\s*select\b/i.test(trimmedCode)) {
    hints.push('Must start with SELECT — only a single SELECT statement can run here.');
  }

  // A trailing ; is fine (the backend strips it); one in the middle is not.
  if (trimmedCode.replace(/;+\s*$/, '').includes(';')) {
    hints.push('Only one statement is allowed — remove the ; separating them.');
  }

  const fromAt = code.search(/\bfrom\b/i);
  const whereAt = code.search(/\bwhere\b/i);
  if (fromAt !== -1 && whereAt !== -1 && whereAt < fromAt) {
    hints.push('WHERE must come after FROM — the order is SELECT … FROM … WHERE ….');
  }

  if (requiredColumn && !mentionsColumn(selectList(code), requiredColumn)) {
    hints.push(
      `This check reads a column named "${requiredColumn}" — add AS ${requiredColumn} `
      + 'to the value you want it to use.'
    );
  }

  return hints;
}
