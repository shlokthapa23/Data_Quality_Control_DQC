import json
import os
import re
import requests

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

VALIDATION_TYPES = [
    'Null Value Constraint',
    'Boundary Range Constraint',
    'Regex Pattern Check',
    'Uniqueness Constraint',
    'Length Constraint',
    'Categorical Constraint',
    'Referential Integrity',
    'Data Freshness',
    'Record Volume Integrity',
    'Custom',
]

SEVERITIES = ['critical', 'error', 'warning']


def _build_prompt(table_name, columns, description):
    columns_desc = ", ".join(f"{c['name']} ({c['data_type']})" for c in columns)
    return f"""You are a SQL test generator for a data validation tool. Output ONLY a single DuckDB SQL SELECT statement - no explanation, no markdown code fences, no extra text before or after.

The statement must return exactly one row with:
- a column named "passed" that evaluates to 1 (pass) or 0 (fail)
- optionally a column named "details" with a short human-readable message

Use exactly this table name: {table_name}
Available columns: {columns_desc}
Quote any column or table name that contains a space, hyphen, or other special character using double quotes (DuckDB syntax), e.g. "Order ID". Do not invent columns that aren't in the list above.

Validation to implement: {description}

Output only the SQL statement, nothing else."""


def _build_sample_prompt(table_name, columns, sample_rows, max_rules):
    columns_desc = ", ".join(f"{c['name']} ({c['data_type']})" for c in columns)
    sample_json = json.dumps(sample_rows[:15], default=str)
    types_list = ", ".join(f'"{t}"' for t in VALIDATION_TYPES)
    severities_list = ", ".join(f'"{s}"' for s in SEVERITIES)
    return f"""You are a data quality rule generator for a data validation tool. You will be shown a table's real schema and a random sample of its actual rows. Infer sensible data quality rules from what the sample data suggests (e.g. columns that never look null, id-like columns that look unique, numeric columns that stay in a range, string columns that follow a fixed set of values or a format) and output {max_rules} DIVERSE DuckDB SQL test cases covering different aspects.

Output ONLY a JSON array (no markdown fences, no explanation before or after), where each element is an object with exactly these fields:
- "name": short human-readable rule name
- "description": one sentence explaining why this rule matters, based on the sample data
- "validation_type": exactly one of [{types_list}]
- "severity": exactly one of [{severities_list}]
- "script_text": a single DuckDB SQL SELECT statement that returns exactly one row with a column named "passed" (1 or 0) and optionally a column named "details"

Use exactly this table name in every script_text: {table_name}
Available columns: {columns_desc}
Quote any column or table name that contains a space, hyphen, or other special character using double quotes (DuckDB syntax). Do not invent columns that aren't in the list above.

Random sample of {min(len(sample_rows), 15)} rows from this table:
{sample_json}

Output only the JSON array, nothing else."""


def _strip_fences(text, lang=""):
    """Strip markdown code fences if the model adds them despite instructions not to."""
    cleaned = text.strip()
    cleaned = re.sub(rf'^```(?:{lang})?\s*', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\s*```$', '', cleaned)
    return cleaned.strip()


def _clean_sql(text):
    return _strip_fences(text, lang="sql")


def _clean_json(text):
    return _strip_fences(text, lang="json")


def _call_gemini(prompt, max_output_tokens=600):
    """Shared Gemini REST call. Returns the raw text of the first candidate."""
    api_key = os.environ.get("GEMINI_API_KEY")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set in .env")

    url = f"{GEMINI_API_BASE}/{model}:generateContent"
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": max_output_tokens, "thinkingConfig": {"thinkingBudget": 0}},
    }

    resp = requests.post(url, headers=headers, json=body, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    try:
        candidate = data["candidates"][0]
        text = candidate["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise RuntimeError(f"Unexpected Gemini response shape: {data}")

    if candidate.get("finishReason") == "MAX_TOKENS":
        raise RuntimeError(
            "Gemini response was truncated (hit maxOutputTokens) - "
            "try a shorter/simpler description or increase the token limit"
        )

    return text


def generate_test_case_sql(table_name, columns, description):
    """
    columns: list of {"name": ..., "data_type": ...} - the table's REAL
    schema, already known to us, so the model never has to guess column
    names. Returns raw SQL text (not yet run through validate_select_only -
    the caller is responsible for that final safety check).
    """
    prompt = _build_prompt(table_name, columns, description)
    text = _call_gemini(prompt, max_output_tokens=600)
    return _clean_sql(text)


def generate_rules_from_sample(table_name, columns, sample_rows, max_rules=6):
    """
    columns: the table's REAL schema, same as generate_test_case_sql.
    sample_rows: a list of dicts, a random sample of the table's actual
    data (no user-typed prompt involved) - the model infers rules from
    what the data itself looks like. Returns a list of rule dicts:
    {"name", "description", "validation_type", "severity", "script_text"}.
    None of the script_text values are validated here - the caller must
    run each through validate_select_only before trusting/saving them.
    """
    prompt = _build_sample_prompt(table_name, columns, sample_rows, max_rules)
    text = _call_gemini(prompt, max_output_tokens=2000)
    cleaned = _clean_json(text)

    try:
        rules = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"AI response wasn't valid JSON: {e}")

    if not isinstance(rules, list):
        raise RuntimeError("AI response wasn't a JSON array of rules")

    return rules
