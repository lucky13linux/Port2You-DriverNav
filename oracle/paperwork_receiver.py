#!/usr/bin/env python3
"""Minimal HTTPS-reverse-proxied Port2You paperwork receiver.

Set P2Y_TOKENS_JSON to a JSON object of driver IDs -> random bearer tokens.
Set P2Y_DISCORD_WEBHOOK and optionally P2Y_DB_PATH.
Listen only on loopback; terminate HTTPS with Nginx/Caddy.
"""
import hashlib
import hmac
import io
import json
import os
import sqlite3
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

TOKENS = json.loads(os.environ.get("P2Y_TOKENS_JSON", "{}"))
WEBHOOK = os.environ.get("P2Y_DISCORD_WEBHOOK", "")
DB = os.environ.get("P2Y_DB_PATH", "./paperwork.sqlite3")
PORT = int(os.environ.get("P2Y_PORT", "8788"))

def db():
    conn = sqlite3.connect(DB, timeout=30)
    conn.execute("CREATE TABLE IF NOT EXISTS processed (event_id TEXT PRIMARY KEY, driver_id TEXT, posted_at TEXT)")
    return conn

def pdf_for(x, driver):
    out = io.BytesIO()
    c = canvas.Canvas(out, pagesize=A4)
    c.setTitle("Port2You Bill of Lading")
    c.setFont("Helvetica-Bold", 19)
    c.drawString(45, 792, "PORT2YOU — BILL OF LADING")
    c.setFont("Helvetica", 11)
    rows = [
        ("Driver", driver), ("Dispatch", x.get("dispatchId")), ("Job", x.get("jobId")),
        ("From", ", ".join(str(v or "") for v in x.get("origin", {}).values())),
        ("To", ", ".join(str(v or "") for v in x.get("destination", {}).values())),
        ("Cargo", x.get("cargo")), ("Weight", x.get("cargoWeight")),
        ("Truck", x.get("truck")), ("Planned distance", x.get("plannedDistance")),
        ("Actual distance", f'{float(x.get("actualDistanceMiles") or 0):.1f} miles'),
        ("Cargo damage", f'{float(x.get("cargoDamagePercent") or 0):.2f}%'),
        ("Completed UTC", x.get("completedAtUtc")),
        ("Completion", x.get("completionMethod"))
    ]
    y = 750
    for label, value in rows:
        c.setFont("Helvetica-Bold", 10)
        c.drawString(45, y, label + ":")
        c.setFont("Helvetica", 10)
        c.drawString(175, y, str(value or "")[:85])
        y -= 31
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(45, 90, "Simulation delivery record generated from MSDC telemetry.")
    c.save()
    return out.getvalue()

def discord_post(event, driver):
    summary = f"🚛 **{driver} delivered:** {event['origin']['city']} → {event['destination']['city']}\n" + (
        f"**Cargo:** {event.get('cargo','Unknown')} · **Truck:** {event.get('truck','Unknown')}\n"
        f"**Dispatch:** {event.get('dispatchId','')} · **Job:** {event.get('jobId','')}"
    )
    body = pdf_for(event, driver)
    boundary = "p2y" + hashlib.sha256(body).hexdigest()[:20]
    metadata = json.dumps({"content": summary}).encode()
    payload = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n".encode()
        + metadata + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"Port2You-BOL.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".encode()
        + body + f"\r\n--{boundary}--\r\n".encode()
    )
    req = urllib.request.Request(WEBHOOK, data=payload, headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": "Port2You-Paperwork/1.0"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as res:
        if res.status not in (200, 204):
            raise RuntimeError(f"Discord status {res.status}")

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/paperwork":
            self.send_error(404)
            return
        auth = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        driver = next((name for name, token in TOKENS.items() if hmac.compare_digest(token, auth) and auth), None)
        if not driver:
            self.send_error(401)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 65536:
                self.send_error(413)
                return
            x = json.loads(self.rfile.read(length))
            if not isinstance(x, dict) or x.get("schemaVersion") != 1 or not isinstance(x.get("eventId"), str) or len(x["eventId"]) != 64:
                self.send_error(400)
                return
            if not all(isinstance(x.get(k), dict) and isinstance(x[k].get("city"), str) for k in ("origin", "destination")):
                self.send_error(400)
                return
            if not x.get("completedAtUtc") or not WEBHOOK:
                self.send_error(503)
                return
            with db() as conn:
                if conn.execute("SELECT 1 FROM processed WHERE event_id=?", (x["eventId"],)).fetchone():
                    self.send_response(200)
                    self.end_headers()
                    return
                discord_post(x, driver)
                conn.execute("INSERT INTO processed VALUES (?, ?, ?)", (x["eventId"], driver, datetime.utcnow().isoformat()))
            self.send_response(201)
            self.end_headers()
        except Exception as exc:
            print("Paperwork processing failed:", str(exc), flush=True)
            self.send_error(502)

if __name__ == "__main__":
    if not TOKENS or not WEBHOOK:
        raise SystemExit("Set P2Y_TOKENS_JSON and P2Y_DISCORD_WEBHOOK")
    Path(DB).parent.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
