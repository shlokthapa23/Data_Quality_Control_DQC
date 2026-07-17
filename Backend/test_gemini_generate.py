"""
Minimal, isolated test of generateContent - bypasses our whole app so we
can quickly try several model names against your real key and see which
one actually works for this specific method, not just for ListModels.

Usage:
    python test_gemini_generate.py
"""
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env")

api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    print("GEMINI_API_KEY not found - check your .env is next to this script.")
    exit(1)

# Try a few candidates, roughly in order of "most likely to be stable and
# actually enabled for your account" - gemini-flash-latest in particular
# is a Google-maintained alias meant to dodge exactly this kind of
# model-name churn.
candidates = [
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
]

for model in candidates:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    try:
        resp = requests.post(
            url,
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            json={"contents": [{"parts": [{"text": "Say OK"}]}]},
            timeout=30,
        )
        if resp.status_code == 200:
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            print(f"{model:30} SUCCESS - response: {text.strip()[:50]}")
        else:
            print(f"{model:30} FAILED  - HTTP {resp.status_code}: {resp.text[:150]}")
    except Exception as e:
        print(f"{model:30} ERROR   - {e}")