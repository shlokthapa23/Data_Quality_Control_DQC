import re

_FORBIDDEN_KEYWORDS = re.compile(
    r'(?is)\b(insert|update|delete|drop|alter|truncate|merge|exec|execute|grant|revoke)\b'
)


def clean_explain_error(message):
    """
    Syntax checking wraps the tester's SQL in EXPLAIN, and DuckDB echoes the
    offending source line back in a 'LINE n: ...' block. That block is dropped
    entirely rather than un-prefixed:

      - it exposes an EXPLAIN the tester never wrote, and
      - DuckDB elides long lines ('LINE 1: ...PLAIN select count(*) ...'), so
        there's no reliable prefix to strip, and its caret would point at the
        wrong column anyway.

    Everything genuinely useful survives - the error itself names the offending
    token, DuckDB's 'Candidate bindings:' suggestions are kept, and the tester
    can see their own query in the editor directly above the message.
    """
    kept = []
    for line in str(message).strip().splitlines():
        stripped = line.strip()
        if re.match(r'(?i)^LINE\s+\d+:', stripped):
            continue
        if not stripped.strip('^ \t'):  # the caret line, or blank
            continue
        kept.append(stripped)
    return "\n".join(kept).strip()


def suggest_fix(sql, error):
    """
    A plain-language "here's what to do" for a failed syntax check.

    The database's own message says what's WRONG but rarely what to CHANGE -
    'syntax error at or near "FROM"' doesn't tell a tester their clauses are in
    the wrong order. This turns the common failures into an instruction.

    Built from the error text and the script alone: no extra queries, so adding
    it costs nothing on a connection that's already expensive to open. Returns
    None when there's nothing more useful to say than the error itself.
    """
    text = str(error or "")
    code = _strip_sql_comments(str(sql or ""))
    lowered = text.lower()

    if "only single select" in lowered or "disallowed keyword" in lowered:
        return ("Only a plain SELECT can run here. Rewrite it as a SELECT - test scripts are "
                "never allowed to modify data.")

    if "only a single statement" in lowered:
        return "Remove the ';' and everything after it - only one statement runs."

    # DuckDB lists the real column names it knows about; surfacing them IS the fix.
    candidates = re.search(r'Candidate bindings:\s*(.+)', text)
    if "not found in from clause" in lowered or "referenced column" in lowered:
        if candidates:
            return f"That column isn't in this table. Did you mean one of: {candidates.group(1).strip()}?"
        return ("That column isn't in this table. Check the spelling against the column list, and "
                'quote it if it contains a space or dash, e.g. "Order ID".')

    if "table with name" in lowered and "does not exist" in lowered:
        return ('No table by that name here. Copy it exactly from the table list - Fabric tables '
                'need the full quoted form, e.g. "dbo"."my_table".')

    if "syntax error" in lowered:
        from_at = re.search(r'\bfrom\b', code, re.IGNORECASE)
        where_at = re.search(r'\bwhere\b', code, re.IGNORECASE)
        if from_at and where_at and where_at.start() < from_at.start():
            return "Put FROM before WHERE - the order is SELECT ... FROM ... WHERE ..."
        if code.count("(") != code.count(")"):
            return "Brackets don't balance - count the ( against the )."
        if code.count("'") % 2:
            return "A quote is left open - every ' needs a closing '."
        return ("Something near that word isn't valid SQL. Check for a missing comma, a stray word, "
                "or a keyword in the wrong place.")

    if "does not exist" in lowered and "function" in lowered:
        return ("That function doesn't exist in DuckDB, which is the dialect used here. T-SQL "
                "functions like GETDATE() or ISNULL() won't work - use DuckDB equivalents, and "
                "|| rather than + to join text.")

    return None


def _strip_sql_comments(sql):
    """
    Blank out -- line comments and /* */ block comments, leaving string literals
    intact, so the checks below see only executable code.

    Without this the guard misjudged perfectly good scripts: the shipped
    referential_check and custom_expression templates both OPEN with an
    explanatory -- comment, so "must start with SELECT" rejected them outright,
    and any comment mentioning a word like "delete" tripped the forbidden-keyword
    search. Quote-awareness matters too - 'a--b' is data, not a comment.
    """
    out = []
    i, n = 0, len(sql)
    in_string = False
    while i < n:
        ch = sql[i]
        if in_string:
            out.append(ch)
            # '' is an escaped quote inside a literal, not the end of one.
            if ch == "'":
                if i + 1 < n and sql[i + 1] == "'":
                    out.append(sql[i + 1])
                    i += 2
                    continue
                in_string = False
            i += 1
        elif ch == "'":
            in_string = True
            out.append(ch)
            i += 1
        elif sql.startswith('--', i):
            end = sql.find('\n', i)
            i = n if end == -1 else end  # keep the newline itself
        elif sql.startswith('/*', i):
            end = sql.find('*/', i + 2)
            out.append(' ')  # so /*..*/ between tokens doesn't glue them together
            i = n if end == -1 else end + 2
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def validate_select_only(sql):
    """
    Defensive keyword check, not a full SQL parser - meant to catch
    accidental/careless destructive statements in a trusted internal tool,
    not to withstand a hostile author deliberately trying to bypass it.
    Raises ValueError if the script isn't a single plain SELECT.

    Checks run against the comment-stripped text, but the ORIGINAL (comments and
    all) is returned for execution - the database is perfectly happy with them.
    """
    normalized = sql.strip().rstrip(';')
    code = _strip_sql_comments(normalized).strip()
    if not re.match(r'(?is)^\s*select\b', code):
        raise ValueError("Only single SELECT statements are allowed in test scripts")
    if _FORBIDDEN_KEYWORDS.search(code):
        raise ValueError("Test script contains a disallowed keyword (only SELECT is permitted)")
    if ';' in code:
        raise ValueError("Only a single statement is allowed - remove any ';' separated statements")
    return normalized