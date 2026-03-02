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
import { requestDecision } from "../lib/pingone-az.js";

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
  const { items, total } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Cart is empty or items is missing." });
  }

  // ── 4. PingOne Authorize decision ───────────────────────────
  // `userContext` carries user identity (handled by requestDecision via claims.sub).
  // `parameters` carries domain context the policy needs to evaluate this action.
  // Key names must match the attribute names defined in your P1AZ policy.
  const azParameters = {
    "order.total":      String(total ?? 0),
    "order.item_count": String(items.length),
    // client_id identifies which app / agent triggered this checkout.
    // Lets the P1AZ policy make decisions based on the calling application,
    // independently of who the user is (user identity comes via userContext).
    "client_id":        claims.client_id ?? claims.azp ?? "",
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
    console.warn(`[checkout] Denied — sub: ${claims.sub}, decision: ${decision.decision}`);
    return res.status(403).json({
      error:    "Checkout denied by policy.",
      decision: decision.decision,
      // `statements` carries any advice/obligations returned by the Authorize policy
      advice:   decision.statements ?? [],
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
