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

# column_parity only supports metrics computable independently on each side
# and compared for equality - null count, distinct count, min/max range.
# Kept in sync with s2d/engine.py's _build_parity_metric_query.
PARITY_VALIDATION_TYPES = ['Null Value Constraint', 'Uniqueness Constraint', 'Boundary Range Constraint']


def _table_blocks(tables):
    """tables: list of {"table_name", "columns"} - one labeled block per table."""
    return "\n".join(
        f'Table "{t["table_name"]}" has columns: ' + ", ".join(f"{c['name']} ({c['data_type']})" for c in t["columns"])
        for t in tables
    )


def _build_prompt(tables, description):
    """
    tables: list of {"table_name": ..., "columns": [{"name":..., "data_type":...}, ...]} -
    one or more tables on the SAME side (source or destination). When more
    than one is given, they're expected to represent one logical dataset
    split across tables (e.g. a mapping's split destination), so the model
    is told to UNION ALL them together rather than treat them as unrelated.
    """
    multi_table_note = ""
    if len(tables) > 1:
        table_names = ", ".join(f'"{t["table_name"]}"' for t in tables)
        multi_table_note = (
            f"\nThese {len(tables)} tables ({table_names}) together represent one logical dataset - "
            "combine rows from all of them using UNION ALL (matching on shared column names) rather than "
            "treating them as unrelated tables.\n"
        )
    return f"""You are a SQL test generator for a data validation tool. Output ONLY a single DuckDB SQL SELECT statement - no explanation, no markdown code fences, no extra text before or after.

The statement must return exactly one row with:
- a column named "passed" that evaluates to 1 (pass) or 0 (fail)
- optionally a column named "details" with a short human-readable message

{_table_blocks(tables)}
{multi_table_note}
Quote any column or table name that contains a space, hyphen, or other special character using double quotes (DuckDB syntax), e.g. "Order ID". Do not invent columns that aren't in the list(s) above, and use exactly the table name(s) given.

Validation to implement: {description}

Output only the SQL statement, nothing else."""


def _build_key_column_prompt(source_tables, destination_tables, description):
    return f"""You are a data pipeline validation expert. A source dataset is copied/transformed into a destination dataset, and you need to pick ONE column that can be used to match/join individual rows between the two sides (a primary key, natural key, or unique identifier present on both sides with the same meaning - possibly a different name).

Source table(s):
{_table_blocks(source_tables)}

Destination table(s):
{_table_blocks(destination_tables)}

What the user wants to verify: {description}

Output ONLY a JSON object (no markdown fences, no explanation before or after) with exactly these fields:
- "key_column": the exact column name to use as the join/match key - it MUST exist, spelled exactly the same, in every one of the tables listed above on BOTH sides (pick a column name that's identical across all of them, not just similar)
- "name": a short human-readable name for this check

Output only the JSON object, nothing else."""


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


def _build_parity_sample_prompt(source_table, source_columns, source_sample,
                                 destination_table, destination_columns, destination_sample, max_rules):
    source_columns_desc = ", ".join(f"{c['name']} ({c['data_type']})" for c in source_columns)
    destination_columns_desc = ", ".join(f"{c['name']} ({c['data_type']})" for c in destination_columns)
    source_json = json.dumps(source_sample[:15], default=str)
    destination_json = json.dumps(destination_sample[:15], default=str)
    types_list = ", ".join(f'"{t}"' for t in PARITY_VALIDATION_TYPES)
    severities_list = ", ".join(f'"{s}"' for s in SEVERITIES)
    return f"""You are a data pipeline validation expert. A source table's data is copied/transformed into a destination table, and your job is to find pairs of columns - one from each table - that are meant to hold the SAME data (possibly renamed), so we can verify the transfer didn't lose or corrupt anything.

You will be shown both tables' real schemas and a random sample of their actual rows. Identify {max_rules} DIVERSE column pairs that correspond to each other (match by name similarity, data type, and by comparing the actual sample values - e.g. a source "OrderID" column and a destination "Order_ID" column with overlapping values are the same field). For each pair, pick the check that best fits what the sample data suggests: null counts should match if nothing should be dropped, distinct-value counts should match for identifier/key-like columns, or min/max range should match for numeric columns.

Output ONLY a JSON array (no markdown fences, no explanation before or after), where each element is an object with exactly these fields:
- "name": short human-readable rule name
- "description": one sentence explaining why this column pair matters and what the check verifies
- "validation_type": exactly one of [{types_list}] - this determines which metric is compared (Null Value Constraint = null count, Uniqueness Constraint = distinct count, Boundary Range Constraint = min/max)
- "severity": exactly one of [{severities_list}]
- "source_column": the exact column name from the source table's column list below
- "destination_column": the exact column name from the destination table's column list below

Do not invent column names that aren't in the lists below. Only pair columns that genuinely represent the same real-world field - do not force a pairing if nothing corresponds.

Source table: {source_table}
Source columns: {source_columns_desc}
Random sample of {min(len(source_sample), 15)} source rows:
{source_json}

Destination table: {destination_table}
Destination columns: {destination_columns_desc}
Random sample of {min(len(destination_sample), 15)} destination rows:
{destination_json}

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


def generate_test_case_sql(tables, description):
    """
    tables: list of {"table_name": ..., "columns": [...]} - one or more
    tables on one side, real schema already known to us, so the model
    never has to guess column/table names. When more than one table is
    given, the prompt instructs the model to UNION ALL them together as
    one logical dataset. Returns raw SQL text (not yet run through
    validate_select_only - the caller is responsible for that final
    safety check).
    """
    prompt = _build_prompt(tables, description)
    text = _call_gemini(prompt, max_output_tokens=600)
    return _clean_sql(text)


def generate_key_column_suggestion(source_tables, destination_tables, description):
    """
    source_tables/destination_tables: list of {"table_name","columns"} - real
    schemas on each side. cross_table_parity checks are engine-computed (no
    arbitrary SQL) - the AI's only job here is picking a shared join/key
    column and a check name from the real schemas + what the user described.
    Returns {"key_column": ..., "name": ...}. The caller is responsible for
    validating the returned key_column actually exists in every selected
    table on both sides before trusting/saving it.
    """
    prompt = _build_key_column_prompt(source_tables, destination_tables, description)
    text = _call_gemini(prompt, max_output_tokens=300)
    cleaned = _clean_json(text)

    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"AI response wasn't valid JSON: {e}")

    if not isinstance(result, dict):
        raise RuntimeError("AI response wasn't a JSON object")

    return result


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


def generate_parity_rules_from_samples(source_table, source_columns, source_sample,
                                        destination_table, destination_columns, destination_sample, max_rules=6):
    """
    Reads BOTH tables' real schemas and random samples (no user-typed
    prompt) and asks the model to find corresponding column pairs to run
    column_parity checks on - this is the actual point of S2D validation:
    proving data reached the destination intact, not just checking one
    side in isolation. Returns rule dicts:
    {"name", "description", "validation_type", "severity", "source_column", "destination_column"}.
    No script_text is generated - column_parity checks are executed by
    s2d/engine.py building the comparison query itself from validation_type
    + the two column names, so there's no SQL here for the caller to
    safety-check; the caller instead validates the returned column names
    actually exist in each side's schema before saving.
    """
    prompt = _build_parity_sample_prompt(
        source_table, source_columns, source_sample,
        destination_table, destination_columns, destination_sample, max_rules,
    )
    text = _call_gemini(prompt, max_output_tokens=2000)
    cleaned = _clean_json(text)

    try:
        rules = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"AI response wasn't valid JSON: {e}")

    if not isinstance(rules, list):
        raise RuntimeError("AI response wasn't a JSON array of rules")

    return rules
