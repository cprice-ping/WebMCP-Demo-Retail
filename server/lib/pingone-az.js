// ============================================================
// PingOne Authorize — Decision Endpoint client
//
// Uses a Worker Application (client_credentials) to obtain a
// short-lived token for calling the decision endpoint.
// The worker token is cached in memory and refreshed automatically
// when it nears expiry — avoids a new credentials call on every request.
//
// Agent Identity Signal
// ─────────────────────
// In WebMCP the agent (Gemini sidecar, MCP Tool Explorer, etc.) invokes tools
// inside the user's browser tab and forwards the user's existing access_token.
// That token carries everything P1AZ needs to answer "who is acting?":
//
//   userContext.user.id   — PingOne user UUID (from AT `sub`)
//                           → policy conditions on the individual user
//
//   agent.client_id       — OAuth client_id of the application that obtained
//                           the token (from AT `client_id` / `azp`).
//                           This IS the agent identity signal. The RS validates
//                           it to answer "which application is acting?"
//                           No separate agent credential is required —
//                           the user's session token carries the signal.
//
//   agent.scope           — Scopes granted to that client for this session.
//                           Lets the policy enforce permission presence.
//
// Use agentIdentityParameters(claims) to get these as a ready-to-spread
// object for the `parameters` block, then add action-specific attributes:
//
//   const params = {
//     ...agentIdentityParameters(claims),
//     "order.total": String(total),
//   };
//   await requestDecision(claims, params);
// ============================================================

const P1_BASE = "https://auth.pingone.com";
const P1_API  = "https://api.pingone.com/v1";

/**
 * Build the standard agent identity parameters from a validated AT payload.
 *
 * In WebMCP the agent operates inside the user's browser tab and forwards
 * the user's access_token. The `client_id` claim in that token is the agent
 * identity signal — it tells the RS (and P1AZ) which application obtained
 * the token. No separate agent credential is required.
 *
 * These parameters give your P1AZ policy consistent, named attributes to
 * condition on for every tool call:
 *
 *   WebMCP.clientId  — which application / agent context is acting
 *   WebMCP.scope     — what permissions were granted to it
 *
 * All parameters are prefixed "WebMCP." — the P1AZ Trust Framework namespace
 * folder for this demo, keeping it separate from other policies.
 * Dots within names are avoided (P1AZ treats them as sub-folder paths);
 * camelCase is used within the WebMCP. namespace instead.
 *
 * User identity (who) is handled separately via userContext.user.id.
 *
 * Spread into azParameters before adding action-specific attributes:
 *   const params = { ...agentIdentityParameters(claims), "WebMCP.orderTotal": "99" };
 *
 * @param {object} claims  Decoded, validated AT payload
 * @returns {object}       Flat key-value pairs ready for the `parameters` block
 */
export function agentIdentityParameters(claims) {
  return {
    "WebMCP.Request.clientId": claims.client_id ?? claims.azp ?? "",
    "WebMCP.Request.scope":    claims.scope ?? "",
  };
}

// In-memory worker token cache
let _workerToken = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maskSubject(sub) {
  if (!sub || typeof sub !== "string") return "(unknown)";
  return `${sub.slice(0, 8)}…(${sub.length})`;
}

/**
 * Obtain (or return cached) a client_credentials token for the Worker app.
 * Refreshes automatically when fewer than 60 seconds remain.
 */
async function getWorkerToken() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (_workerToken && _workerToken.exp > nowSec + 180) {
    return _workerToken.token;
  }

  const envId        = process.env.PINGONE_ENVIRONMENT_ID;
  const clientId     = process.env.AZ_CLIENT_ID;
  const clientSecret = process.env.AZ_CLIENT_SECRET;

  if (!envId || !clientId || !clientSecret) {
    throw new Error(
      "Missing PingOne worker credentials: PINGONE_ENVIRONMENT_ID, AZ_CLIENT_ID, AZ_CLIENT_SECRET"
    );
  }

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${P1_BASE}/${envId}/as/token`, {
        method: "POST",
        headers: {
          "Content-Type":  "application/x-www-form-urlencoded",
          // PingOne Worker apps use client_secret_basic — credentials in Basic Auth header,
          // not in the request body (client_secret_post is rejected with 401 invalid_client).
          "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Worker token request failed: ${resp.status} ${body}`);
      }

      const data = await resp.json();
      _workerToken = {
        token: data.access_token,
        exp:   Math.floor(Date.now() / 1000) + (data.expires_in ?? 299),
      };

      console.log(`[AZ] Worker token refreshed, expires in ${data.expires_in}s`);
      return _workerToken.token;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await sleep(150 * 2 ** (attempt - 1));
      }
    }
  }

  throw lastErr;
}

/**
 * Send a decision request to PingOne Authorize.
 *
 * API: POST /environments/{envId}/decisionEndpoints/{endpointId}
 * Ref: https://developer.pingidentity.com/pingone-api/authorize/authorization-decisions/decision-evaluation/execute-a-decision-request.html
 *
 * Body shape:
 *   {
 *     "parameters": { "Policy Attribute Name": "value", ... },  // flat; names defined by the policy
 *     "userContext": { "user": { "id": "<pingone-user-uuid>" } } // separate block; id = sub claim
 *   }
 *
 * @param {object} userClaims   Decoded access_token payload (sub, client_id/azp, scope, etc.)
 * @param {object} parameters   Flat key-value object whose keys match the attribute names
 *                              defined in your P1AZ policy. The caller decides the shape;
 *                              values should be strings or numbers. This is domain context
 *                              only (e.g. order amounts, product IDs) — user identity is
 *                              carried by userContext, not here.
 * @returns {Promise<object>}   PingOne Authorize response: { decision, statements, ... }
 */
export async function requestDecision(userClaims, parameters = {}) {
  const envId      = process.env.PINGONE_ENVIRONMENT_ID;
  const endpointId = process.env.AZ_DECISION_ENDPOINT_ID;

  if (!endpointId) {
    console.warn("[AZ] AZ_DECISION_ENDPOINT_ID not set — auto-PERMIT (demo mode)");
    return { decision: "PERMIT", statements: [], source: "demo-auto-permit" };
  }

  const workerToken = await getWorkerToken();

  // userContext.user.id is the PingOne user UUID — the `sub` claim of a PingOne
  // access token is that UUID, so we map directly.
  const body = {
    parameters,
    userContext: {
      user: { id: userClaims.sub },
    },
  };

  console.log(`[AZ] Decision request — user: ${maskSubject(userClaims.sub)}`);
  // Log parameters individually — signals payload is large so show length only.
  for (const [k, v] of Object.entries(parameters)) {
    const display = k === "WebMCP.Request.Protect.signalsPayload"
      ? `<${String(v).length} chars>`
      : v;
    console.log(`[AZ]   ${k}: ${display}`);
  }

  const resp = await fetch(
    `${P1_API}/environments/${envId}/decisionEndpoints/${endpointId}`,
    {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${workerToken}`,
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Decision endpoint request failed: ${resp.status} ${errText}`);
  }

  const result = await resp.json();
  console.log(`[AZ] Decision: ${result.decision}`);
  return result;
}
