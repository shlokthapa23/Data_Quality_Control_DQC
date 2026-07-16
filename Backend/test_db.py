import os
import pyodbc
from dotenv import load_dotenv

load_dotenv()

server = os.environ.get("FABRIC_SERVER")
database = os.environ.get("FABRIC_DATABASE")

conn_str = (
    f"Driver={{ODBC Driver 18 for SQL Server}};"
    f"Server={server},1433;"
    f"Database={database};"
    f"Authentication=ActiveDirectoryInteractive;"
    f"Encrypt=yes;"
    f"TrustServerCertificate=no;"
)

try:
    conn = pyodbc.connect(conn_str)
    cursor = conn.cursor()
    
    # Query the system to return all table names
    cursor.execute("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES")
    
    print("\n--- Available Tables in your Lakehouse ---")
    for row in cursor.fetchall():
        print(f"{row.TABLE_SCHEMA}.{row.TABLE_NAME}")
        
    conn.close()
except Exception as e:
    print(f"\n❌ Query failed: {e}")