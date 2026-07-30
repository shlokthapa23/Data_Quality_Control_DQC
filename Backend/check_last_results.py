import sqlite3

conn = sqlite3.connect("catalog.db")
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

cursor.execute("""
    SELECT test_name, status, evaluated_query, details, error_message
    FROM s2d_test_results
    ORDER BY id DESC
    LIMIT 2
""")

rows = cursor.fetchall()

for row in rows:
    print("=" * 80)
    print(f"test_name:      {row['test_name']}")
    print(f"status:         {row['status']}")
    print(f"evaluated_query: {row['evaluated_query']}")
    print(f"details:        {repr(row['details'])}")
    print(f"error_message:  {repr(row['error_message'])}")

conn.close()