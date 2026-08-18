import { useMemo, useRef, useState } from 'react';
import { Table2, Columns3 } from 'lucide-react';

/**
 * A SQL editor that suggests the table and column names actually available on
 * the side being written against.
 *
 * The problem it solves is specific: Fabric table names are fully quoted
 * (`"dbo"."my_table"`), local ones are bare, JSON uploads produce dotted
 * columns (`"customer.address.city"`), and a column map adds common names on
 * top. A tester writing SQL by hand had no way to know which spelling applies
 * where, and found out by running the query and reading a binder error.
 *
 * Deliberately NOT a full SQL parser. It looks at the word being typed and the
 * keyword before it, which is enough to tell "after FROM you want a table" from
 * "after SELECT you want a column" and is wrong in ways that cost a keystroke,
 * not correctness - the suggestion is always optional and the real check is
 * still the Check syntax button against the live schema.
 */

/** Keywords after which a TABLE name is the likely next token. */
const TABLE_CONTEXT = /\b(from|join|into|update|table)\s+[^\s,()]*$/i;
/** Keywords after which a COLUMN name is the likely next token. */
const COLUMN_CONTEXT = /\b(select|where|and|or|on|by|having|set|distinct|count|sum|min|max|avg|cast)\s*\(?\s*[^\s,()]*$/i;

/**
 * The token being typed at the caret. Quoted identifiers count as one token, so
 * `"dbo"."my_` completes as a whole rather than fragmenting on the dots.
 */
function tokenAtCaret(text, caret) {
  const before = text.slice(0, caret);
  const match = before.match(/[A-Za-z0-9_."[\]]*$/);
  const token = match ? match[0] : '';
  return { token, start: caret - token.length };
}

function scoreMatch(candidate, token) {
  if (!token) return 0;
  const c = candidate.toLowerCase();
  const t = token.toLowerCase().replace(/^"+|"+$/g, '');
  if (!t) return 0;
  const idx = c.indexOf(t);
  if (idx === -1) return -1;
  // Prefer a prefix hit, then an earlier hit, then a shorter candidate - so
  // typing "ord" offers "orders" before "customer_order_lines".
  return (idx === 0 ? 1000 : 500 - idx) - candidate.length;
}

export default function SqlSuggest({
  value, onChange, tables = [], columnsByTable = {}, commonNames = [],
  rows = 8, className = '', placeholder, disabled, onBlur,
}) {
  const ref = useRef(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // Every column on this side, de-duplicated, with the tables that hold it -
  // the tester needs to know a column exists AND where, since the same name
  // often appears on several tables.
  const columnIndex = useMemo(() => {
    const index = new Map();
    Object.entries(columnsByTable).forEach(([table, cols]) => {
      (cols || []).forEach((col) => {
        const name = typeof col === 'string' ? col : col.name;
        if (!name) return;
        if (!index.has(name)) index.set(name, []);
        index.get(name).push(table);
      });
    });
    return index;
  }, [columnsByTable]);

  const { token, start } = tokenAtCaret(value || '', caret);

  const suggestions = useMemo(() => {
    if (!open || token.replace(/"/g, '').length < 1) return [];
    const before = (value || '').slice(0, caret);
    const wantsTable = TABLE_CONTEXT.test(before);
    const wantsColumn = !wantsTable && COLUMN_CONTEXT.test(before);

    const pool = [];
    if (!wantsColumn) {
      tables.forEach((t) => pool.push({ kind: 'table', label: t, detail: 'table' }));
    }
    if (!wantsTable) {
      columnIndex.forEach((owners, name) => {
        pool.push({
          kind: 'column', label: name,
          detail: owners.length > 2 ? `column · ${owners.length} tables` : `column · ${owners.join(', ')}`,
        });
      });
      commonNames.forEach((n) => pool.push({ kind: 'column', label: n, detail: 'column map' }));
    }

    return pool
      .map((item) => ({ ...item, score: scoreMatch(item.label, token) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [open, token, caret, value, tables, columnIndex, commonNames]);

  const accept = (item) => {
    const el = ref.current;
    // A Fabric name is already quoted; a bare name with a dot or space would
    // break the query unquoted, so it gets quotes here rather than later.
    const needsQuotes = !item.label.startsWith('"') && /[.\s-]/.test(item.label);
    const insert = needsQuotes ? `"${item.label}"` : item.label;
    const next = (value || '').slice(0, start) + insert + (value || '').slice(caret);
    onChange(next);
    setOpen(false);
    // Put the caret after what was just inserted, so typing continues naturally.
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = start + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const handleKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Enter accepts a suggestion only while the list is open, so a normal
      // newline still works the rest of the time.
      e.preventDefault();
      accept(suggestions[Math.min(active, suggestions.length - 1)]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const sync = (e) => {
    setCaret(e.target.selectionStart ?? 0);
    setOpen(true);
    setActive(0);
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); sync(e); }}
        onClick={sync}
        onKeyUp={(e) => setCaret(e.target.selectionStart ?? 0)}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          // Delayed so a click on a suggestion lands before the list closes.
          setTimeout(() => setOpen(false), 120);
          if (onBlur) onBlur(e);
        }}
        className={className}
      />

      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 z-30 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
          {suggestions.map((item, i) => (
            <button
              key={`${item.kind}-${item.label}`}
              // mousedown, not click: blur would otherwise close the list first.
              onMouseDown={(e) => { e.preventDefault(); accept(item); }}
              onMouseEnter={() => setActive(i)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                i === active ? 'bg-mastek-primary/10' : 'hover:bg-slate-50'
              }`}
            >
              {item.kind === 'table'
                ? <Table2 className="w-3.5 h-3.5 text-mastek-primary shrink-0" />
                : <Columns3 className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
              <span className="font-mono text-slate-700 truncate">{item.label}</span>
              <span className="ml-auto text-[10px] text-slate-400 shrink-0">{item.detail}</span>
            </button>
          ))}
          <p className="px-2.5 py-1 text-[10px] text-slate-400 border-t border-slate-100">
            Tab or Enter to insert &middot; Esc to dismiss
          </p>
        </div>
      )}
    </div>
  );
}
