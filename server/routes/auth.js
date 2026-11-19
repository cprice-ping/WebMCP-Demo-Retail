// ============================================================
// Device-code auth broker — Mode C (Agent-only / headless)
// See docs/agent-auth-modes-spec.md
//
// The browser tab cannot run the OIDC redirect flow when it is headless
// (navigation unloads it, and rendering/polling the DaVinci approval page
// in-tab previously OOM-killed the headless browser). Instead the tab's
// agent asks this broker to start a device-code grant (RFC 8628); the HUMAN
// approves out-of-band (visits verification_uri, enters user_code), and the
// tab polls the broker until the token lands.
//
// Flow:
//   tab → POST /api/auth/start        → { request_id, user_code, verification_uri, ... }
//   agent relays user_code + verification_uri to the human
//   human approves at verification_uri (device code page on agentic client)
//   server polls PingOne /token in the background with proper backoff
//   tab → GET  /api/auth/status       → { status: "pending" | "approved" | ... }
//   tab → POST /api/auth/token (once) → { access_token, ... } (then deleted)
//
// Security notes:
//   - device_code never leaves the server; the tab only holds request_id.
//   - request_id is a high-entropy random handle (not guessable).
//   - The one-time token exchange (demo convenience) deletes the stored
//     token on read. Production keeps it server-side and proxies calls.
//   - In-memory store — single-instance demo only. Note for k8s: replicas
//     would need a shared store.
// ============================================================

import { Router } from "express";
import { randomUUID } from "crypto";

const router = Router();

const P1_BASE = process.env.PINGONE_AS_BASE ||
  (process.env.PINGONE_ENVIRONMENT_ID
    ? `https://auth.pingone.com/${process.env.PINGONE_ENVIRONMENT_ID}/as`
    : null);

const AGENTIC_CLIENT_ID = process.env.AGENTIC_CLIENT_ID ||
  process.env.PINGONE_AGENTIC_CLIENT_ID || ""; // alias for local parity with config.js

// Derived per-request (env may load after module import in some runtimes).
function pingOneBase() {
  return process.env.PINGONE_AS_BASE ||
    (process.env.PINGONE_ENVIRONMENT_ID
      ? `https://auth.pingone.com/${process.env.PINGONE_ENVIRONMENT_ID}/as`
      : null);
}

function agenticClientId() {
  return process.env.AGENTIC_CLIENT_ID ||
    process.env.PINGONE_AGENTIC_CLIENT_ID || "";
}

const DEVICE_SCOPE = "openid profile email";

// request_id → { device_code, user_code, verification_uri, interval, expires_at,
//                state: "pending"|"approved"|"consumed"|"expired"|"denied",
//                token?: {access_token, ...}, error?: string }
const pendingRequests = new Map();

const REQUEST_TTL_MS     = 10 * 60 * 1000; // PingOne default device-code lifetime
const TOKEN_RETENTION_MS = 5 * 60 * 1000;  // how long an approved token waits for pickup

function pruneExpired() {
  const now = Date.now();
  for (const [id, entry] of pendingRequests) {
    if (now > entry.expires_at + TOKEN_RETENTION_MS) pendingRequests.delete(id);
  }
}

function maskSubject(sub) {
  if (!sub || typeof sub !== "string") return "(unknown)";
  return `${sub.slice(0, 8)}…(${sub.length})`;
}

// ── 1. Start a device authorization ─────────────────────────
router.post("/start", async (req, res) => {
  pruneExpired();

  if (!pingOneBase() || !agenticClientId()) {
    return res.status(503).json({
      error: "Device-code broker not configured.",
      detail: "Set PINGONE_ENVIRONMENT_ID (or PINGONE_AS_BASE) and AGENTIC_CLIENT_ID; the agentic app must have the device-code grant enabled.",
    });
  }

  // Optional person-pinning hint — forwarded as login_hint to the device page.
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "email must be a valid address when provided." });
  }

  try {
    const body = new URLSearchParams({
      client_id: agenticClientId(),
      scope: DEVICE_SCOPE,
    });
    if (email) body.set("login_hint", email);

    const resp = await fetch(`${pingOneBase()}/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.warn(`[auth] device_authorization failed: ${resp.status} ${JSON.stringify(data).slice(0, 300)}`);
      return res.status(502).json({
        error: "PingOne rejected the device authorization request.",
        detail: data.error ?? data.message ?? `HTTP ${resp.status}`,
      });
    }

    const requestId = randomUUID();
    const interval  = Number(data.interval) || 5;
    const expiresIn = Number(data.expires_in) || 600;

    pendingRequests.set(requestId, {
      device_code:      data.device_code,
      user_code:        data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete ?? null,
      interval,
      expires_at: Date.now() + expiresIn * 1000,
      state: "pending",
      token: null,
      error: null,
      // Polling clock (server-side): next allowed /token attempt
      nextPollAt: 0,
    });

    console.log(`[auth] device auth started — request_id: ${requestId}, user_code: ${data.user_code}`);

    // device_code is NEVER returned to the client.
    return res.json({
      request_id:       requestId,
      user_code:        data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete ?? null,
      expires_in:       expiresIn,
      interval,
    });
  } catch (err) {
    console.error(`[auth] start error: ${err.message}`);
    return res.status(502).json({ error: "Could not reach PingOne device authorization endpoint.", detail: err.message });
  }
});

// ── 2. Status: poll on behalf of the tab ─────────────────────
router.get("/status", async (req, res) => {
  pruneExpired();

  const requestId = String(req.query.request_id ?? "");
  const entry = pendingRequests.get(requestId);
  if (!entry) {
    return res.status(404).json({ error: "Unknown request_id.", status: "unknown" });
  }

  const now = Date.now();
  if (now > entry.expires_at && entry.state === "pending") {
    entry.state = "expired";
  }
  if (entry.state !== "pending") {
    return res.json({ status: entry.state, error: entry.error ?? undefined });
  }

  // Respect the slow_down backoff clock PingOne gave us.
  if (now < entry.nextPollAt) {
    return res.json({ status: "pending", retry_after: Math.ceil((entry.nextPollAt - now) / 1000) });
  }

  try {
    const body = new URLSearchParams({
      grant_type:    "urn:ietf:params:oauth:grant-type:device_code",
      device_code:   entry.device_code,
      client_id:     agenticClientId(),
    });

    const resp = await fetch(`${pingOneBase()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const data = await resp.json();

    if (resp.ok && data.access_token) {
      // Approved — store server-side, hand out only status. Token pickup is
      // a separate one-time call.
      entry.state = "approved";
      entry.token = data;
      console.log(`[auth] device flow approved — request_id: ${requestId}, sub: ${maskSubject(data.id_token ? decodeSub(data.id_token) : null)}`);
      return res.json({ status: "approved", expires_in: data.expires_in ?? undefined });
    }

    if (data.error === "authorization_pending") {
      entry.nextPollAt = now + (entry.interval * 1000);
      return res.json({ status: "pending", retry_after: entry.interval });
    }
    if (data.error === "slow_down") {
      entry.interval = Math.min(entry.interval + 5, 60);
      entry.nextPollAt = now + (entry.interval * 1000);
      return res.json({ status: "pending", retry_after: entry.interval });
    }
    if (data.error === "expired_token") {
      entry.state = "expired";
      return res.json({ status: "expired" });
    }
    if (data.error === "access_denied") {
      entry.state = "denied";
      return res.json({ status: "denied" });
    }

    // Unexpected error — surface as terminal so the tab doesn't spin forever.
    console.warn(`[auth] unexpected token error: ${data.error ?? resp.status}`);
    entry.state = "error";
    entry.error = data.error_description ?? data.error ?? `HTTP ${resp.status}`;
    return res.json({ status: "error", error: entry.error });
  } catch (err) {
    console.error(`[auth] status poll error: ${err.message}`);
    // Network hiccup — stay pending; the tab will re-poll.
    return res.json({ status: "pending", retry_after: entry.interval });
  }
});

// Pull the `sub` out of an id_token for logging only (no verification needed —
// the token came straight from PingOne over TLS; this is display only).
function decodeSub(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return payload.sub;
  } catch { return null; }
}

// ── 3. One-time token pickup (demo convenience) ──────────────
router.post("/token", (req, res) => {
  pruneExpired();

  const requestId = String(req.body?.request_id ?? "");
  const entry = pendingRequests.get(requestId);

  if (!entry) {
    return res.status(404).json({ error: "Unknown request_id." });
  }
  if (entry.state !== "approved" || !entry.token) {
    return res.status(409).json({ error: `Token not ready — status: ${entry.state}.` });
  }

  // One-time: hand over and delete. Production keeps it server-side and
  // proxies tool calls instead (out of scope for the demo).
  const token = entry.token;
  entry.token = null;
  entry.state = "consumed";
  console.log(`[auth] token picked up — request_id: ${requestId}`);
  return res.json(token);
});

export default router;
