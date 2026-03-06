// POST /api/checkout
//
// Full server-side trust chain:
//   1. Extract Bearer token from Authorization header
//   2. Validate AT signature + exp via JWKS (server-side — not just payload-decode)
//   3. Request a PingOne Authorize decision, forwarding user + order context
//   4. PERMIT  → generate order record, return receipt
//      DENY    → 403 with decision detail so the agent can explain why

import { Router } from "express";
import { randomUUID } from "crypto";
import { validateAccessToken } from "../lib/token.js";
import { requestDecision, agentIdentityParameters } from "../lib/pingone-az.js";

const router = Router();

function maskSubject(sub) {
  if (!sub || typeof sub !== "string") return "(unknown)";
  return `${sub.slice(0, 8)}…(${sub.length})`;
}

function normalizeCheckoutRequest(body = {}) {
  const { items, total, otpCode, deviceAuthenticationId, verifyTransactionId } = body ?? {};

  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return { error: "Cart is empty or items is invalid (1-100 items required)." };
  }

  const normalizedItems = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      return { error: "Each item must be an object." };
    }
    const qty = Number(item.quantity ?? 0);
    const lineTotal = Number(item.line_total ?? 0);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(lineTotal) || lineTotal < 0) {
      return { error: "Each item must include valid quantity and line_total values." };
    }
    normalizedItems.push(item);
  }

  const computedTotal = normalizedItems.reduce((sum, i) => sum + Number(i.line_total ?? 0), 0);
  const finalTotal = total === undefined ? computedTotal : Number(total);
  if (!Number.isFinite(finalTotal) || finalTotal <= 0 || finalTotal > 1_000_000) {
    return { error: "Total must be a positive number less than 1,000,000." };
  }

  const cleanOtp = otpCode == null ? undefined : String(otpCode).trim();
  if (cleanOtp !== undefined && !/^\d{4,8}$/.test(cleanOtp)) {
    return { error: "OTP code must be 4-8 digits." };
  }

  const cleanDeviceAuthId = deviceAuthenticationId == null ? undefined : String(deviceAuthenticationId).trim();
  if (cleanDeviceAuthId !== undefined && cleanDeviceAuthId.length > 128) {
    return { error: "deviceAuthenticationId is too long." };
  }

  const cleanVerifyTxId = verifyTransactionId == null ? undefined : String(verifyTransactionId).trim();
  if (cleanVerifyTxId !== undefined && cleanVerifyTxId.length > 128) {
    return { error: "verifyTransactionId is too long." };
  }

  return {
    items: normalizedItems,
    total: finalTotal,
    otpCode: cleanOtp,
    deviceAuthenticationId: cleanDeviceAuthId,
    verifyTransactionId: cleanVerifyTxId,
  };
}

router.post("/", async (req, res) => {
  // ── 1. Bearer token ────────────────────────────────────────
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Missing or malformed Authorization header.",
      detail: "Expected: Authorization: Bearer <access_token>",
    });
  }
  const rawToken = authHeader.slice(7);

  // ── 2. AT validation (full JWKS signature check) ───────────
  let claims;
  try {
    claims = await validateAccessToken(rawToken);
  } catch (err) {
    console.warn(`[checkout] Token validation failed: ${err.message}`);
    return res.status(401).json({
      error:  "Access token is invalid.",
      detail: err.message,
      note:   "The server validates the JWT signature using PingOne's JWKS. " +
              "The browser can only read the payload — this check requires a key.",
    });
  }

  console.log(
    `[checkout] AT valid — sub: ${maskSubject(claims.sub)}, ` +
    `client_id: ${claims.client_id ?? claims.azp ?? "(none)"}, ` +
    `scope: ${claims.scope ?? "(none)"}`
  );

  // ── 3. Request body ─────────────────────────────────────────
  const normalized = normalizeCheckoutRequest(req.body);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }
  const { items, total, otpCode, deviceAuthenticationId, verifyTransactionId } = normalized;

  // ── 4. PingOne Authorize decision ───────────────────────────
  // `userContext` carries user identity (handled by requestDecision via claims.sub).
  // `parameters` carries domain context the policy needs to evaluate this action.
  // Key names must match the attribute names defined in your P1AZ policy.
  // All parameters are prefixed "WebMCP." — this is the P1AZ Trust Framework
  // namespace folder for this demo, keeping it separate from other policies.
  // Dots within names are avoided (P1AZ treats them as sub-folder paths);
  // camelCase is used within the WebMCP. namespace instead.
  const azParameters = {
    ...agentIdentityParameters(claims),   // WebMCP.Request.clientId, WebMCP.Request.scope
    "WebMCP.Request.orderTotal":              String(total ?? 0),
    "WebMCP.Request.orderItemCount":          String(items.length),
    // Second-pass MFA verification — present only when the user supplied an OTP
    ...(otpCode               && { "WebMCP.Request.otpCode":               otpCode }),
    ...(deviceAuthenticationId && { "WebMCP.Request.deviceAuthenticationId": deviceAuthenticationId }),
    ...(verifyTransactionId    && { "WebMCP.Request.verifyTransactionId":    verifyTransactionId }),
  };

  let decision;
  try {
    decision = await requestDecision(claims, azParameters);
  } catch (err) {
    console.error(`[checkout] Decision endpoint error: ${err.message}`);
    return res.status(502).json({
      error:  "Could not reach the policy decision endpoint.",
      detail: err.message,
    });
  }

  if (decision.decision !== "PERMIT") {
    const statements = decision.statements ?? [];

    // ── Interactive DENY: policy returned statements with payloads ──
    // The statement `code` is the contract between the policy author and this
    // application. The server's job here is only to:
    //   1. Parse any JSON-string payloads into objects (they arrive serialised)
    //   2. Forward them to the client as-is (202 so the HTTP client doesn't throw)
    //
    // The client owns dispatch — if a new statement code appears, add a handler
    // there; no server change needed. This also maps cleanly to an API Gateway
    // pattern: the gateway enforces PERMIT/DENY; the client handles step-up UX.
    const interactive = statements
      .filter(s => s.payload)
      .map(s => {
        let payload = s.payload;
        try {
          payload = typeof s.payload === "string" ? JSON.parse(s.payload) : s.payload;
        } catch { /* not valid JSON — forward raw string */ }
        return { code: s.code, name: s.name, payload };
      });

    if (interactive.length > 0) {
      console.log(
        `[checkout] DENY with interactive statements — ` +
        `sub: ${maskSubject(claims.sub)}, codes: ${interactive.map(s => s.code).join(", ")}`
      );
      return res.status(202).json({ denied: true, statements: interactive });
    }

    // ── Hard DENY: no client-actionable statements ───────────────
    const isDeny          = decision.decision === "DENY";
    const isIndeterminate = decision.decision === "INDETERMINATE";
    console.warn(`[checkout] Not permitted — sub: ${maskSubject(claims.sub)}, decision: ${decision.decision}`);
    return res.status(403).json({
      error:    isDeny          ? "Checkout denied by policy."
              : isIndeterminate ? "No policy matched this request — checkout cannot proceed."
              :                   `Checkout not permitted (decision: ${decision.decision}).`,
      decision: decision.decision,
      user:     { sub: claims.sub, client_id: claims.client_id ?? claims.azp },
    });
  }

  // ── 5. Process order ────────────────────────────────────────
  const order = {
    order_id:  `ORD-${Date.now()}-${randomUUID().split("-")[0]}`,
    items,
    total:     total ?? items.reduce((sum, i) => sum + (i.line_total ?? 0), 0),
    user:      {
      sub:       claims.sub,
      client_id: claims.client_id ?? claims.azp ?? null,
    },
    decision: {
      result:  decision.decision,
      source:  decision.source ?? "pingone-authorize",
    },
  };

  console.log(`[checkout] Order created: ${order.order_id} — $${order.total}`);
  return res.json({ success: true, order });
});

export default router;
