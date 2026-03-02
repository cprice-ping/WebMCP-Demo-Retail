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
// When an MCP agent invokes a tool it forwards the user's access_token.
// That token carries two signals that tell P1AZ *who is acting*:
//
//   userContext.user.id   — the PingOne user UUID (from sub)
//                           → policy can condition on the individual user
//
//   agent.client_id       — the OAuth app that obtained the token
//                           → policy can condition on which application/agent
//                             triggered the action (e.g. allow browser UI but
//                             require extra step for an autonomous agent)
//
//   agent.scope           — scopes granted to that client for this session
//                           → policy can enforce "checkout:write" is present
//
// Use agentIdentityParameters(claims) to get these as a ready-to-spread
// object for the `parameters` block, then add your action-specific
// attributes alongside:
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
 * These are the parameters your P1AZ policy can condition on to answer
 * "which application / agent triggered this action?" separately from
 * "who is the user?" (which comes from userContext).
 *
 * Parameter names used here:
 *   agent.client_id  — OAuth client_id of the application that holds the token.
 *                      In a WebMCP scenario this identifies the browser app /
 *                      agent; an autonomous agent using a different client would
 *                      show a different value here.
 *   agent.scope      — Space-separated scopes granted to this client for the
 *                      current session. Lets the policy enforce scope presence.
 *
 * Spread into your azParameters before adding action-specific attributes:
 *   const params = { ...agentIdentityParameters(claims), "order.total": "99" };
 *
 * @param {object} claims  Decoded AT payload (already validated via validateAccessToken)
 * @returns {object}       Flat key-value pairs ready for the `parameters` block
 */
export function agentIdentityParameters(claims) {
  return {
    "agent.client_id": claims.client_id ?? claims.azp ?? "",
    "agent.scope":     claims.scope ?? "",
  };
}

// In-memory worker token cache
let _workerToken = null;

/**
 * Obtain (or return cached) a client_credentials token for the Worker app.
 * Refreshes automatically when fewer than 60 seconds remain.
 */
async function getWorkerToken() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (_workerToken && _workerToken.exp > nowSec + 60) {
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

  const resp = await fetch(`${P1_BASE}/${envId}/as/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Worker token request failed: ${resp.status} ${body}`);
  }

  const data = await resp.json();
  _workerToken = {
    token: data.access_token,
    exp:   nowSec + (data.expires_in ?? 299),
  };

  console.log(`[AZ] Worker token refreshed, expires in ${data.expires_in}s`);
  return _workerToken.token;
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

  console.log(`[AZ] Decision request — user: ${userClaims.sub}`);
  console.log(`[AZ] Body: ${JSON.stringify(body)}`);


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
