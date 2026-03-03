// POST /api/checkout
//
// Full server-side trust chain:
//   1. Extract Bearer token from Authorization header
//   2. Validate AT signature + exp via JWKS (server-side — not just payload-decode)
//   3. Request a PingOne Authorize decision, forwarding user + order context
//   4. PERMIT  → generate order record, return receipt
//      DENY    → 403 with decision detail so the agent can explain why

import { Router } from "express";
import { validateAccessToken } from "../lib/token.js";
import { requestDecision, agentIdentityParameters } from "../lib/pingone-az.js";

const router = Router();

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
    `[checkout] AT valid — sub: ${claims.sub}, ` +
    `client_id: ${claims.client_id ?? claims.azp ?? "(none)"}, ` +
    `scope: ${claims.scope ?? "(none)"}`
  );

  // ── 3. Request body ─────────────────────────────────────────
  const { items, total, otpCode, deviceAuthenticationId } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Cart is empty or items is missing." });
  }

  // ── 4. PingOne Authorize decision ───────────────────────────
  // `userContext` carries user identity (handled by requestDecision via claims.sub).
  // `parameters` carries domain context the policy needs to evaluate this action.
  // Key names must match the attribute names defined in your P1AZ policy.
  // All parameters are prefixed "WebMCP." — this is the P1AZ Trust Framework
  // namespace folder for this demo, keeping it separate from other policies.
  // Dots within names are avoided (P1AZ treats them as sub-folder paths);
  // camelCase is used within the WebMCP. namespace instead.
  const azParameters = {
    ...agentIdentityParameters(claims),   // WebMCP.clientId, WebMCP.scope
    "WebMCP.orderTotal":     String(total ?? 0),
    "WebMCP.orderItemCount": String(items.length),
    // Second-pass MFA verification — present only when the user supplied an OTP
    ...(otpCode               && { "WebMCP.otpCode":               otpCode }),
    ...(deviceAuthenticationId && { "WebMCP.deviceAuthenticationId": deviceAuthenticationId }),
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
    // ── MFA step-up: DENY on first pass + MFA_CHALLENGE advice ──
    // P1AZ signals step-up by returning DENY with an advice statement whose
    // id/type/name is "MFA_CHALLENGE".  The obligation in the policy fires the
    // OTP delivery (email to sub) before we even read this response.
    // Only intercept on the *first* pass (no otpCode in the request yet).
    const statements = decision.statements ?? [];
    // Detect step-up: P1AZ returns DENY + an advice statement with code "deny-stepup".
    // The statement payload is a JSON string containing deviceAuthenticationId —
    // that ID is what P1AZ needs on the second pass to confirm MFA completion.
    const mfaAdvice = !otpCode && statements.find(s => s.code === "deny-stepup");

    if (mfaAdvice) {
      // payload is a serialised JSON string: { message, deviceAuthenticationId }
      let devAuthId = null;
      try {
        const p = typeof mfaAdvice.payload === "string"
          ? JSON.parse(mfaAdvice.payload)
          : mfaAdvice.payload;
        devAuthId = p?.deviceAuthenticationId ?? null;
      } catch { /* payload not parseable — proceed without the ID */ }

      console.log(`[checkout] MFA step-up — sub: ${claims.sub}, deviceAuthenticationId: ${devAuthId}`);
      return res.status(202).json({
        challenge:               "MFA_REQUIRED",
        deviceAuthenticationId:  devAuthId,
        hint:                    "An OTP has been sent to your registered email address. Enter it to complete checkout.",
      });
    }

    // ── Regular DENY / INDETERMINATE ────────────────────────────
    const isDeny          = decision.decision === "DENY";
    const isIndeterminate = decision.decision === "INDETERMINATE";
    console.warn(`[checkout] Not permitted — sub: ${claims.sub}, decision: ${decision.decision}`);
    return res.status(403).json({
      error:    isDeny          ? "Checkout denied by policy."
              : isIndeterminate ? "No policy matched this request — checkout cannot proceed."
              :                   `Checkout not permitted (decision: ${decision.decision}).`,
      decision: decision.decision,
      advice:   statements,
      user:     { sub: claims.sub, client_id: claims.client_id ?? claims.azp },
    });
  }

  // ── 5. Process order ────────────────────────────────────────
  const order = {
    order_id:  `ORD-${Date.now()}`,
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
