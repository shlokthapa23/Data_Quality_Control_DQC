#!/usr/bin/env python3
"""
Query S2D validation results from catalog.db
Run from: D:\Fabrics_analytics_app\Backend
"""

import sqlite3
import json
from datetime import datetime
from pathlib import Path

DB_PATH = Path("catalog.db")

def run_query(query, params=()):
    """Execute a query and return results"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(query, params)
    results = cursor.fetchall()
    conn.close()
    return results

def format_table(headers, rows):
    """Pretty-print a table"""
    if not rows:
        print("  (no results)")
        return
    
    col_widths = [len(h) for h in headers]
    for row in rows:
        for i, h in enumerate(headers):
            col_widths[i] = max(col_widths[i], len(str(row[h] or "")))
    
    # Print header
    print("  " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)))
    print("  " + "-+-".join("-" * col_widths[i] for i in range(len(headers))))
    
    # Print rows
    for row in rows:
        print("  " + " | ".join(str(row[h] or "").ljust(col_widths[i]) for i, h in enumerate(headers)))

def show_all_runs():
    """Show all validation runs"""
    print("\n" + "="*80)
    print("ALL VALIDATION RUNS")
    print("="*80)
    
    rows = run_query("""
        SELECT r.id, r.mapping_id, m.name AS mapping_name, r.status, 
               r.total_checkpoints, r.pass_count, r.fail_count, 
               r.compute_time_seconds, r.started_at
        FROM s2d_test_runs r
        LEFT JOIN s2d_mappings m ON m.id = r.mapping_id
        ORDER BY r.started_at DESC
        LIMIT 20
    """)
    
    if rows:
        headers = ["started_at", "mapping_name", "status", "total", "pass", "fail", "seconds"]
        for row in rows:
            print(f"\nRun ID: {row['id']}")
            print(f"  Mapping: {row['mapping_name']} | Status: {row['status']}")
            print(f"  Results: {row['pass_count']}/{row['total_checkpoints']} passed in {row['compute_time_seconds']}s")
    else:
        print("  (no runs yet)")

def show_latest_run_details():
    """Show detailed results from the most recent run"""
    print("\n" + "="*80)
    print("LATEST RUN - DETAILED RESULTS")
    print("="*80)
    
    # Get latest run
    run = run_query("""
        SELECT r.*, m.name AS mapping_name,
               m.source_connector_name, m.source_container_name, m.source_tables,
               m.destination_connector_name, m.destination_container_name, m.destination_tables
        FROM s2d_test_runs r
        LEFT JOIN s2d_mappings m ON m.id = r.mapping_id
        ORDER BY r.started_at DESC
        LIMIT 1
    """)
    
    if not run:
        print("  (no runs yet)")
        return
    
    run = run[0]
    print(f"\nRun ID: {run['id']}")
    print(f"Mapping: {run['mapping_name']}")
    print(f"Status: {run['status'].upper()} | {run['pass_count']}/{run['total_checkpoints']} passed | {run['compute_time_seconds']}s")
    print(f"Started: {run['started_at']}")
    
    source_tables = json.loads(run['source_tables'])
    dest_tables = json.loads(run['destination_tables'])
    print(f"Validation: {run['source_connector_name']}.{run['source_container_name']} {source_tables}")
    print(f"          → {run['destination_connector_name']}.{run['destination_container_name']} {dest_tables}")
    
    # Get all test results
    results = run_query("""
        SELECT * FROM s2d_test_results
        WHERE run_id = ?
        ORDER BY test_label ASC
    """, (run['id'],))
    
    print(f"\nTest Results ({len(results)} total):")
    for result in results:
        status_symbol = "✓" if result['status'] == "PASS" else "✗" if result['status'] == "FAIL" else "!"
        print(f"\n  {status_symbol} [{result['test_label']}] {result['test_name']}")
        print(f"      Status: {result['status']}")
        print(f"      Target: {result['rule_target']}")
        if result['evaluated_query']:
            query_preview = result['evaluated_query'][:100].replace("\n", " ")
            print(f"      Query: {query_preview}{'...' if len(result['evaluated_query']) > 100 else ''}")
        if result['details']:
            print(f"      Details: {result['details']}")
        if result['error_message']:
            print(f"      ERROR: {result['error_message']}")

def show_all_mappings():
    """List all mappings"""
    print("\n" + "="*80)
    print("ALL MAPPINGS")
    print("="*80)
    
    rows = run_query("""
        SELECT id, name, source_connector_name, source_container_name, 
               destination_connector_name, destination_container_name, created_at
        FROM s2d_mappings
        ORDER BY created_at DESC
    """)
    
    if rows:
        for row in rows:
            print(f"\n  {row['name']} ({row['id'][:8]}...)")
            print(f"    From: {row['source_connector_name']}.{row['source_container_name']}")
            print(f"    To:   {row['destination_connector_name']}.{row['destination_container_name']}")
            print(f"    Created: {row['created_at']}")
    else:
        print("  (no mappings yet)")

def show_mapping_test_cases(mapping_id):
    """Show all test cases for a mapping"""
    print("\n" + "="*80)
    print(f"TEST CASES FOR MAPPING ({mapping_id[:8]}...)")
    print("="*80)
    
    rows = run_query("""
        SELECT id, name, check_type, target, script_type, script_text, created_at
        FROM s2d_test_cases
        WHERE mapping_id = ?
        ORDER BY created_at ASC
    """, (mapping_id,))
    
    if rows:
        for i, row in enumerate(rows, 1):
            print(f"\n  TC-{i:03d}: {row['name']}")
            print(f"    Type: {row['check_type']}")
            if row['script_type']:
                print(f"    Language: {row['script_type']}")
            if row['target']:
                print(f"    Target: {row['target']}")
            if row['script_text']:
                script_preview = row['script_text'].replace("\n", " ")[:100]
                print(f"    SQL: {script_preview}{'...' if len(row['script_text']) > 100 else ''}")
    else:
        print("  (no test cases yet)")

if __name__ == "__main__":
    if not DB_PATH.exists():
        print(f"ERROR: {DB_PATH} not found!")
        print(f"Run this script from: D:\\Fabrics_analytics_app\\Backend")
        exit(1)
    
    print("S2D Validation Data Inspector")
    print(f"Database: {DB_PATH.resolve()}")
    
    show_all_runs()
    show_latest_run_details()
    show_all_mappings()
    
    # If there's a mapping, show its test cases
    mappings = run_query("SELECT id FROM s2d_mappings ORDER BY created_at DESC LIMIT 1")
    if mappings:
        show_mapping_test_cases(mappings[0]['id'])
    
    print("\n" + "="*80)
    print("Done!")