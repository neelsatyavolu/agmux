"""Aggregate-only post_api_request persistence; never relay metrics over hooks."""
from contextlib import closing
import math
import re
import sqlite3

TOKEN_KEYS = ('input_tokens', 'output_tokens', 'cache_read_tokens',
              'cache_write_tokens', 'reasoning_tokens')


def persist_usage(root, owner_id, payload):
    usage = payload.get('usage')
    ended_at = payload.get('ended_at')
    session_id = payload.get('session_id')
    request_id = payload.get('api_request_id')
    model = payload.get('model')
    # Only provider identifiers and measured scalar fields cross this boundary.
    for value in (owner_id, session_id, request_id):
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,256}', value):
            return
    if not isinstance(model, str) or not re.fullmatch(
            r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?:/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})?', model):
        return
    if (type(ended_at) not in (int, float) or not math.isfinite(ended_at)
            or ended_at <= 0 or not isinstance(usage, dict)):
        return
    counts = [usage.get(key) for key in TOKEN_KEYS]
    if any(type(value) is not int or value < 0 or value > 2**63 - 1 for value in counts):
        return
    try:
        # Environment presence alone is not creation provenance. Fail closed on
        # old/missing databases; never promote imported sessions on resume.
        with closing(sqlite3.connect((root / 'agmux.db').as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
            owned = db.execute(
                "SELECT 1 FROM session_origins WHERE provider='Hermes' "
                'AND owner_id=? AND created_in_agmux=1', (owner_id,)).fetchone()
        if not owned:
            return
        directory = root / 'teams'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with closing(sqlite3.connect(directory / 'hermes-usage.sqlite', timeout=2)) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS hermes_api_usage (
                owner_id TEXT NOT NULL, session_id TEXT NOT NULL,
                api_request_id TEXT NOT NULL, ended_at REAL NOT NULL,
                model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
                PRIMARY KEY (owner_id, session_id, api_request_id))''')
            db.execute('INSERT OR IGNORE INTO hermes_api_usage VALUES (?,?,?,?,?,?,?,?,?,?)',
                       (owner_id, session_id, request_id, ended_at, model, *counts))
    except (OSError, sqlite3.Error):
        # An observer must never interrupt the agent. Missing records are not
        # replaced by lifetime estimates or timestamped at the next scan.
        return
