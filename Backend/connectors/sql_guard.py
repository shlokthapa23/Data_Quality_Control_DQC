import re

_FORBIDDEN_KEYWORDS = re.compile(
    r'(?is)\b(insert|update|delete|drop|alter|truncate|merge|exec|execute|grant|revoke)\b'
)


def validate_select_only(sql):
    """
    Defensive keyword check, not a full SQL parser - meant to catch
    accidental/careless destructive statements in a trusted internal tool,
    not to withstand a hostile author deliberately trying to bypass it.
    Raises ValueError if the script isn't a single plain SELECT.
    """
    normalized = sql.strip().rstrip(';')
    if not re.match(r'(?is)^\s*select\b', normalized):
        raise ValueError("Only single SELECT statements are allowed in test scripts")
    if _FORBIDDEN_KEYWORDS.search(normalized):
        raise ValueError("Test script contains a disallowed keyword (only SELECT is permitted)")
    if ';' in normalized:
        raise ValueError("Only a single statement is allowed - remove any ';' separated statements")
    return normalized