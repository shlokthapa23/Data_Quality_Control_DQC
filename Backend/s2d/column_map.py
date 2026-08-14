"""
Per-Validation column map.

Lets a tester declare that differently-named physical columns across the
tables of one mapping are actually the same logical field, under a single
"common name". A test case then references the common name, and the engine
resolves it to the right physical column per table at run time - which is
what makes a validation with (say) three source tables and one destination
table holding the same data under different column names testable at all.

Stored as JSON on s2d_mappings.column_map:

    [
      {
        "name": "order_id",
        "source":      {'"dbo"."orders_a"': "OrderID", '"dbo"."orders_b"': "order_no"},
        "destination": {'"dbo"."orders_gold"': "OrderKey"},
      },
      ...
    ]

Table keys are the fully-qualified names exactly as stored in the mapping's
source_tables / destination_tables arrays (Fabric shape is '"dbo"."table"',
Local is a bare DuckDB table name).

The whole module is opt-in by construction: physical_column() falls back to
returning the name it was handed whenever no entry covers that table. So a
mapping with no column map at all - or one where the tester deliberately
mapped only some tables - behaves exactly as it did before this existed, and
existing test cases (whose key_column / source_column already hold a real
physical column name) keep resolving to themselves.

Pure functions only, no DB access, so both s2d.engine and app.py can import
it without any circular-import risk.
"""

SIDES = ("source", "destination")


def entries(mapping):
    """The mapping's column map, always a list - [] when nobody has opted in."""
    if not mapping:
        return []
    raw = mapping.get("column_map") or []
    return raw if isinstance(raw, list) else []


def _side_map(entry, side):
    value = entry.get(side) or {}
    return value if isinstance(value, dict) else {}


def _entry_name(entry):
    return (entry.get("name") or "").strip()


def physical_column(mapping, side, table, name):
    """
    Resolve a common name to the physical column to select from `table`.

    Matching is case-insensitive, consistent with the uniqueness rule enforced
    on save. Falls back to `name` verbatim when no entry covers this table -
    see the module docstring on why that fallback IS the opt-in guarantee.
    """
    wanted = (name or "").strip().casefold()
    if not wanted:
        return name
    for entry in entries(mapping):
        if _entry_name(entry).casefold() == wanted:
            mapped = _side_map(entry, side).get(table)
            if mapped:
                return mapped
    return name


def columns_for(mapping, side, tables, name):
    """
    {table: physical column} for every table in `tables`, in the order given -
    the shape the engine's UNION ALL builders need so each arm can select its
    own physical column while still aliasing to one shared output name.
    """
    return {t: physical_column(mapping, side, t, name) for t in tables}


def common_names(mapping, side, tables):
    """
    Common names whose map covers EVERY table in `tables` on `side`.

    Used to widen the "this column must exist on all the selected tables"
    checks. Partially-covered names are deliberately excluded: they'd fall
    back to a literal lookup on the uncovered tables and surface as a
    confusing SQL error at run time instead of an unselectable option now.
    """
    if not tables:
        return []
    names = []
    for entry in entries(mapping):
        name = _entry_name(entry)
        if not name:
            continue
        side_map = _side_map(entry, side)
        if all(side_map.get(t) for t in tables):
            names.append(name)
    return names


def describe(mapping):
    """
    Human-readable block for AI prompts - "" when there's no map, so callers
    can interpolate it unconditionally the way already_covered_text is.
    """
    lines = []
    for entry in entries(mapping):
        name = _entry_name(entry)
        if not name:
            continue
        parts = [
            f"{table}.{column} ({side})"
            for side in SIDES
            for table, column in _side_map(entry, side).items()
        ]
        if parts:
            lines.append(f'- "{name}" is: ' + ", ".join(parts))
    return "\n".join(lines)


def prepare(column_map, source_tables, destination_tables):
    """
    Clean + validate a column map submitted by the editor.
    Returns (error_string, cleaned_list) - error is None when valid, matching
    the (error, parsed) convention app.py's _validate_schedule_body uses.

    Cleaning runs first so the editor's "-" (not mapped) option, which arrives
    as an empty string, is dropped rather than rejected. An entry left with no
    mapped table on either side carries no information and is dropped whole;
    an entry that maps tables but was never given a name is an error.

    Deliberately does NOT check that the columns actually exist: that needs a
    live connector round-trip per save, and the editor already builds its
    dropdowns from live schema.
    """
    if not isinstance(column_map, list):
        return "column_map must be an array", None

    valid_tables = {"source": set(source_tables), "destination": set(destination_tables)}
    cleaned = []

    for i, entry in enumerate(column_map):
        if not isinstance(entry, dict):
            return f"Entry {i + 1} must be an object", None

        normalized = {"name": _entry_name(entry)}
        mapped_count = 0
        for side in SIDES:
            side_map = entry.get(side)
            if side_map is not None and not isinstance(side_map, dict):
                return f"Entry {i + 1}: {side} must be an object of table -> column", None
            normalized[side] = {
                table: column.strip()
                for table, column in (side_map or {}).items()
                if isinstance(column, str) and column.strip()
            }
            mapped_count += len(normalized[side])

        if not mapped_count:
            continue  # nothing mapped on either side - drop it silently

        if not normalized["name"]:
            return f"Entry {i + 1} maps columns but has no common name", None

        for side in SIDES:
            unknown = set(normalized[side]) - valid_tables[side]
            if unknown:
                return (
                    f"\"{normalized['name']}\" references {side} table(s) that aren't "
                    f"in this validation: {', '.join(sorted(unknown))}"
                ), None

        cleaned.append(normalized)

    seen = {}
    for entry in cleaned:
        key = entry["name"].casefold()
        if key in seen:
            return f"Duplicate common name: {entry['name']}", None
        seen[key] = True

    return None, cleaned
