// ============================================================
// CIBA auth broker — Mode C (Agent-only / headless)
// See docs/agent-auth-modes-spec.md
//
// The headless tab has no UX to run an OIDC redirect (navigation unloads it)
// and device code failed in practice: the human has to be TOLD a code and a
// URL by the agent, and the tab-side polling had nothing to show for it.
// CIBA (Client-Initiated Backchannel Authentication, OpenID FAPI CIBA) is
// the right shape for an agent-only session: the tab's agent asks the AS
// (via this broker) to authenticate the person, and the AS *pushes* the
// approval to the person's device. The human's entire experience is a
// notification they approve. The agent only polls.
//
// Flow (RFC: OpenID Client-Initiated Backchannel Authentication):
//   agent → device_login { email }           (login_hint is CIBA-mandatory —
//                                             the person must be identified)
//         → POST /api/auth/start             → broker → POST {as}/cibaAuthorization
//                                             → { auth_req_id, expires_in, interval }
//   PingOne pushes the approval to the person's device (PingOne Verify push /
//   whatever the agentic client's CIBA flow defines)
//   agent → auth_status { request_id }       → broker polls {as}/token with
//                                             grant_type=urn:openid:params:grant-type:ciba
//                                             → pending | approved | denied | expired
//   approved → one-time POST /api/auth/token → tokens into sessionStorage
//   Tab behaves exactly like Mode A/B from there (TokenProvider seam).
//
// Security notes:
//   - auth_req_id never leaves the server; the tab only holds request_id.
//   - CIBA requires client authentication: the broker authenticates with the
//     HEADLESS app's own credentials (HEADLESS_CLIENT_ID/HEADLESS_CLIENT_SECRET,
//     client_secret_basic) — the standard OAuth client auth for the CIBA grant,
//     same method on both /cibaAuthorization and the /token poll. The secret
//     can only initiate backchannel requests; no token is issued without the
//     person approving the push, so its blast radius is push-spam to an
//     arbitrary login_hint — inherent to any CIBA client secret. (The AZ
//     Worker credential stays dedicated to the decision endpoint.)
//   - request_id is a high-entropy random handle.
//   - In-memory store — single-instance demo only.
// ============================================================

import { Router } from "express";
import { randomUUID } from "crypto";

const router = Router();

// request_id → { auth_req_id, interval, expires_at, state, token, error, nextPollAt }
const pendingRequests = new Map();

const TOKEN_RETENTION_MS = 5 * 60 * 1000; // how long an approved token waits for pickup

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

function pingOneBase() {
  return process.env.PINGONE_AS_BASE ||
    (process.env.PINGONE_ENVIRONMENT_ID
      ? `https://auth.pingone.com/${process.env.PINGONE_ENVIRONMENT_ID}/as`
      : null);
}

function headlessClientId() {
  // Mode C (headless/CIBA) client — deliberately SEPARATE from the companion
  // client (config.js PINGONE_AGENTIC_CLIENT_ID) so P1AZ policy can give the
  // two agent modes different postures. AGENTIC_CLIENT_ID kept as a fallback
  // alias for pre-split deployments.
  return process.env.HEADLESS_CLIENT_ID ||
    process.env.AGENTIC_CLIENT_ID ||
    process.env.PINGONE_AGENTIC_CLIENT_ID || "";
}

function headlessClientSecret() {
  return process.env.HEADLESS_CLIENT_SECRET || "";
}

// Standard OAuth client_secret_basic header for the headless app — used on
// both /cibaAuthorization and the CIBA /token poll (PingOne requires the same
// client auth method throughout the flow).
function clientAuthHeader() {
  const cred = Buffer.from(`${headlessClientId()}:${headlessClientSecret()}`).toString("base64");
  return `Basic ${cred}`;
}

// ── 1. Start a CIBA backchannel authorization ───────────────
router.post("/start", async (req, res) => {
  pruneExpired();

  if (!pingOneBase() || !headlessClientId() || !headlessClientSecret()) {
    return res.status(503).json({
      error: "CIBA broker not configured.",
      detail: "Set PINGONE_ENVIRONMENT_ID (or PINGONE_AS_BASE), HEADLESS_CLIENT_ID, and HEADLESS_CLIENT_SECRET; the headless app must be confidential with CIBA enabled in PingOne.",
    });
  }

  // login_hint is REQUIRED in CIBA — the AS pushes to a specific person; there
  // is no code for the human to type, so the identity must be pinned up front.
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "A valid email (login_hint) is required for CIBA.",
      detail: "CIBA pushes the approval to a specific person's device — ask the user for their account email address first.",
      code: "LOGIN_HINT_REQUIRED",
    });
  }

  try {
    // PingOne CIBA: the backchannel_authentication_endpoint (discovered as
    // /as/cibaAuthorization — PingFederate uses /bc-authorize, PingOne does
    // not) uses standard OAuth client auth. The headless app's own
    // client_secret_basic identifies the CIBA client; no worker token needed.
    const body = new URLSearchParams({
      scope:           "openid profile email",
      login_hint:      email,
      binding_message: "WebMCP sign-in",
    });

    const resp = await fetch(`${pingOneBase()}/cibaAuthorization`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": clientAuthHeader(),
      },
      body: body.toString(),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.warn(`[auth] cibaAuthorization failed: ${resp.status} ${JSON.stringify(data).slice(0, 300)}`);
      return res.status(502).json({
        error: "PingOne rejected the CIBA backchannel authorization.",
        detail: data.error_description ?? data.error ?? data.message ?? `HTTP ${resp.status}`,
      });
    }

    const requestId = randomUUID();
    const interval  = Number(data.interval) || 5;
    const expiresIn = Number(data.expires_in) || 300;

    pendingRequests.set(requestId, {
      auth_req_id: data.auth_req_id,
      interval,
      expires_at: Date.now() + expiresIn * 1000,
      state: "pending",
      token: null,
      error: null,
      nextPollAt: 0,
    });

    console.log(`[auth] CIBA started — request_id: ${requestId}, login_hint: ${email}`);

    // auth_req_id is NEVER returned to the client.
    return res.json({
      request_id: requestId,
      login_hint: email,
      expires_in: expiresIn,
      interval,
      detail: "An approval request is being pushed to the person's device. Poll /status.",
    });
  } catch (err) {
    console.error(`[auth] start error: ${err.message}`);
    return res.status(502).json({ error: "Could not reach PingOne CIBA endpoint.", detail: err.message });
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

  // Respect the interval the AS gave us (CIBA polling discipline).
  if (now < entry.nextPollAt) {
    return res.json({ status: "pending", retry_after: Math.ceil((entry.nextPollAt - now) / 1000) });
  }

  try {
    const body = new URLSearchParams({
      grant_type:  "urn:openid:params:grant-type:ciba",
      auth_req_id: entry.auth_req_id,
    });

    const resp = await fetch(`${pingOneBase()}/token`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": clientAuthHeader(),
      },
      body: body.toString(),
    });

    const data = await resp.json();

    if (resp.ok && data.access_token) {
      entry.state = "approved";
      entry.token = data;
      console.log(`[auth] CIBA approved — request_id: ${requestId}, sub: ${maskSubject(data.id_token ? decodeSub(data.id_token) : null)}`);
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

    console.warn(`[auth] unexpected CIBA token error: ${data.error ?? resp.status}`);
    entry.state = "error";
    entry.error = data.error_description ?? data.error ?? `HTTP ${resp.status}`;
    return res.json({ status: "error", error: entry.error });
  } catch (err) {
    console.error(`[auth] status poll error: ${err.message}`);
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

  const token = entry.token;
  entry.token = null;
  entry.state = "consumed";
  console.log(`[auth] token picked up — request_id: ${requestId}`);
  return res.json(token);
});

export default router;
