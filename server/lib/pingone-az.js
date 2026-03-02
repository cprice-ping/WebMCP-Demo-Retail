// ============================================================
// PingOne Authorize — Decision Endpoint client
//
// Uses a Worker Application (client_credentials) to obtain a
// short-lived token for calling the decision endpoint.
// The worker token is cached in memory and refreshed automatically
// when it nears expiry — avoids a token request on every checkout.
//
// The user's AT claims are forwarded as policy context so the
// Authorize policy can condition decisions on:
//   - who the user is (sub)
//   - which app/agent made the request (client_id / azp)
//   - what permissions they were granted (scope)
//   - order attributes (total, item count)
// ============================================================

const P1_BASE = "https://auth.pingone.com";
const P1_API  = "https://api.pingone.com/v1";

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
 * @param {object} userClaims   Decoded access_token payload from the user's AT
 * @param {object} context      Free-form object passed as `parameters` to the policy.
 *                              The caller shapes this to match what the policy expects.
 *                              A `user` key is always injected from userClaims — the
 *                              caller can override individual fields by including a
 *                              `user` key in context (it will be merged, not replaced).
 * @returns {Promise<object>}   PingOne Authorize response
 *                              { decision: "PERMIT" | "DENY", statements: [...] }
 */
export async function requestDecision(userClaims, context = {}) {
  const envId      = process.env.PINGONE_ENVIRONMENT_ID;
  const endpointId = process.env.AZ_DECISION_ENDPOINT_ID;

  if (!endpointId) {
    // No decision endpoint configured — permit everything (demo / local dev mode).
    console.warn("[AZ] AZ_DECISION_ENDPOINT_ID not set — auto-PERMIT (demo mode)");
    return { decision: "PERMIT", statements: [], source: "demo-auto-permit" };
  }

  const workerToken = await getWorkerToken();

  // Always inject a standard `user` block from the validated AT claims so every
  // policy has consistent identity context without the caller needing to add it.
  // Destructure `user` out of context so the top-level spread doesn't overwrite
  // the merged user block. Caller-supplied user fields merge on top of the base.
  const { user: callerUser = {}, ...rest } = context;
  const parameters = {
    user: {
      id:        userClaims.sub,
      client_id: userClaims.client_id ?? userClaims.azp ?? null,
      scope:     userClaims.scope ?? "",
      ...callerUser,   // caller can add / override individual user fields
    },
    ...rest,           // all other caller-supplied context keys passed through
  };

  console.log(`[AZ] Decision request — user: ${userClaims.sub}`);
  console.log(`[AZ] Parameters: ${JSON.stringify(parameters)}`);

  const resp = await fetch(
    `${P1_API}/environments/${envId}/decisionEndpoints/${endpointId}`,
    {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ parameters }),
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Decision endpoint request failed: ${resp.status} ${body}`);
  }

  const result = await resp.json();
  console.log(`[AZ] Decision: ${result.decision}`);
  return result;
}
