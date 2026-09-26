#!/usr/bin/env python3
"""Shared counters for life.petruha.ge: visits, people online, and what visitors did.

Standard library only. No IP addresses or cookies are stored: a visitor is a
random id the page keeps in localStorage, and "online" lives in memory.

  POST /api/hit   {"id": str, "visit": bool, "leave": bool, "events": {name: int}}
  GET  /api/stats
Both answer with the current totals as JSON.
"""
import json
import os
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.path.join(os.environ.get('STATE_DIRECTORY', '.'), 'stats.db')
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8787'))
ONLINE_WINDOW = 45  # seconds since a visitor's last report
ID_RE = re.compile(r'^[A-Za-z0-9-]{8,64}$')
# A page reports every ~15 s; per-request caps keep a forged request from
# adding more than a very busy visitor could.
CAPS = {
    'pillar': 100,
    'meteor': 100,
    'blast': 100,
    'sow': 100,
    'born': 2_000_000,
    'shattered': 20_000,
    'generations': 500,
}
COUNTERS = ('visits', 'visitors', *CAPS)

lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute('PRAGMA journal_mode=WAL')
db.execute('CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL)')
db.execute('CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL)')
db.commit()
last_seen = {}  # visitor id -> unix time of the last report


def add(key, n):
    db.execute(
        'INSERT INTO counters (key, value) VALUES (?, ?) '
        'ON CONFLICT(key) DO UPDATE SET value = value + excluded.value',
        (key, n),
    )


def totals():
    rows = dict(db.execute('SELECT key, value FROM counters'))
    now = time.time()
    out = {k: rows.get(k, 0) for k in COUNTERS}
    out['online'] = sum(1 for t in last_seen.values() if now - t < ONLINE_WINDOW)
    return out


def record(body):
    vid = body.get('id')
    if not isinstance(vid, str) or not ID_RE.match(vid):
        raise ValueError('bad id')
    events = body.get('events') or {}
    if not isinstance(events, dict):
        raise ValueError('bad events')
    now = time.time()
    with lock:
        for key, cap in CAPS.items():
            n = events.get(key, 0)
            if isinstance(n, int) and not isinstance(n, bool) and n > 0:
                add(key, min(n, cap))
        if body.get('visit') is True:
            add('visits', 1)
            cur = db.execute('INSERT OR IGNORE INTO visitors (id, first_seen) VALUES (?, ?)', (vid, int(now)))
            if cur.rowcount:
                add('visitors', 1)
        db.commit()
        if body.get('leave') is True:
            last_seen.pop(vid, None)
        else:
            last_seen[vid] = now
        for k in [k for k, t in last_seen.items() if now - t > ONLINE_WINDOW * 4]:
            del last_seen[k]
        return totals()


class Handler(BaseHTTPRequestHandler):
    server_version = 'life-stats'

    def reply(self, code, payload):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split('?')[0] != '/api/stats':
            return self.reply(404, {'error': 'not found'})
        with lock:
            return self.reply(200, totals())

    def do_POST(self):
        if self.path.split('?')[0] != '/api/hit':
            return self.reply(404, {'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if not 0 < length <= 4096:
                raise ValueError('bad length')
            # sendBeacon posts text/plain, so the content type is not checked
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('bad body')
            return self.reply(200, record(body))
        except (ValueError, json.JSONDecodeError) as err:
            return self.reply(400, {'error': str(err)})

    def log_message(self, fmt, *args):  # nginx already logs requests
        pass


if __name__ == '__main__':
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
