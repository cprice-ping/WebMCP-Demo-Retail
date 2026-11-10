// PingOne OIDC Configuration
// Replace these values with your PingOne environment settings
// For GitHub Pages deployment, set these directly or via a build step

// ── Allowlist validators (defined before CONFIG — the CONFIG initializer
// below calls them, so they must be plain functions, not CONFIG methods;
// CONFIG itself is in its temporal dead zone during literal evaluation) ──

function isPageOnLocalhost() {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

// Origins eligible to receive the bearer token. The default API host, the
// page's own origin, and localhost (only when the page itself is local).
// Localhost matches any port — dev servers move around (3000, 8080, …).
function apiBaseAllowlist() {
  const origins = ["https://webmcp-shopapi.ping-devops.com", window.location.origin];
  if (isPageOnLocalhost()) origins.push("localhost", "127.0.0.1");
  return origins;
}

// Returns the validated base URL (origin + path, no trailing slash), or null.
function validateApiBase(apiBase) {
  if (!apiBase || typeof apiBase !== "string") return null;
  try {
    const u = new URL(apiBase, window.location.origin);
    const allowed = apiBaseAllowlist();
    // "localhost"/"127.0.0.1" entries match any port (hostname match);
    // full origins match exactly.
    const ok = allowed.some(a => a === u.origin || (a === u.hostname && isLocalHostname(a)));
    if (!ok) return null;
    return u.origin + u.pathname.replace(/\/$/, "");
  } catch { return null; }
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

// Agent WebSocket hosts eligible to receive TOOL_CALLs. Empty by default —
// add e.g. "wss://your-agent.example" here once you have a deployed agent.
// ws:// (insecure) is allowed only when the page itself is on localhost.
function agentWsAllowlist() {
  const hosts = [];
  if (isPageOnLocalhost()) {
    hosts.push("ws://localhost", "ws://127.0.0.1", "wss://localhost", "wss://127.0.0.1");
  }
  return hosts;
}

// Returns the validated URL, or null. wss:// required (ws:// localhost-only);
// host must be in the allowlist.
function validateAgentUrl(agentUrl) {
  if (!agentUrl || typeof agentUrl !== "string") return null;
  try {
    const u = new URL(agentUrl);
    if (u.protocol !== "wss:" && !(isPageOnLocalhost() && u.protocol === "ws:")) return null;
    const hostKey = `${u.protocol}//${u.host}`;
    if (!agentWsAllowlist().some(a => a === hostKey || hostKey.startsWith(a))) return null;
    return u.toString();
  } catch { return null; }
}

const CONFIG = {
  // Your PingOne Application Client ID
  PINGONE_CLIENT_ID: "1e9994ca-366d-4954-b1d8-32c3506e9641",

  // Your PingOne Environment ID
  PINGONE_ENVIRONMENT_ID: "3f720e3e-ceb4-43a7-bb45-45b05eb26280",

  // Redirect URI — must match what's registered in PingOne
  // For local dev: http://localhost:8080
  // For GitHub Pages: https://yourusername.github.io/WebMCP-Retail/
  // Auto-derived from the current page URL (query string stripped).
  // This must exactly match a Redirect URI registered in your PingOne application.
  // Override with a hardcoded string if auto-detection doesn't match your registration.
  PINGONE_REDIRECT_URI: window.location.origin + window.location.pathname,

  // OIDC scopes to request
  PINGONE_SCOPES: "openid profile email",

  // Dedicated OIDC client for agent-initiated logins (the login tool).
  // The resulting access_token carries THIS client_id — the "session is
  // agentic" signal. Forwarded to PingOne Authorize as Request.clientId,
  // where policy can treat agent checkouts differently (e.g. force step-up).
  // Create a second public OIDC app (PKCE, same redirect URIs) whose sign-on
  // policy maps to the OOB HILT DaVinci flow policy, and paste its ID here —
  // the tool then routes to that flow automatically, no acr_values needed.
  // Leave empty to reuse the main client (session not separately marked).
  PINGONE_AGENTIC_CLIENT_ID: "813fd8fd-3852-45f3-ab11-4b7418bb2b2c",

  // AG-UI Custom Agent WebSocket endpoint.
  // Set to a wss:// URL to enable the Custom Agent panel and auto-connect on sign-in.
  // Leave empty to hide the agent panel (BCA-only demo mode).
  // ?agentUrl= query param overrides (persisted in sessionStorage).
  // ── Agent WebSocket allowlist ──────────────────────────────────
  // The agent end receives TOOL_CALLs that execute in the tab with the
  // user's session, so an arbitrary ?agentUrl= must never auto-connect.
  // A ?agentUrl= value may PREFILL the agent URL input only — connecting
  // requires an explicit user click on Connect, and the value must pass
  // validateAgentUrl() (scheme + allowlist) there before any socket opens.
  AGUI_AGENT_URL: (() => {
    const param = new URLSearchParams(window.location.search).get("agentUrl");
    if (param) {
      // Persist only if it validates; otherwise just prefill and warn.
      if (validateAgentUrl(param)) {
        sessionStorage.setItem("agentUrl", param);
        return param;
      }
      console.warn(`[config] ignoring untrusted agentUrl="${param}" — failed allowlist/scheme validation; prefill only`);
      return param;
    }
    const stored = sessionStorage.getItem("agentUrl");
    if (stored) {
      if (validateAgentUrl(stored)) return stored;
      console.warn(`[config] ignoring untrusted stored agentUrl="${stored}"`);
      sessionStorage.removeItem("agentUrl");
    }
    return "";
  })(),

  // ── API base allowlist ─────────────────────────────────────────
  // SHOP_API_BASE carries the bearer token on every apiRequest(), so a
  // crafted ?apiBase= link (or a poisoned sessionStorage value) must not be
  // able to redirect the token to an arbitrary host. Any value — query param
  // or stored — must pass validateApiBase(); failures are dropped and fall
  // back to the default. Defense in depth: apiRequest() re-checks the final
  // origin before attaching Authorization.
  SHOP_API_BASE: (() => {
    const param = new URLSearchParams(window.location.search).get("apiBase");
    if (param) {
      const ok = validateApiBase(param);
      if (ok) { sessionStorage.setItem("apiBase", ok); return ok; }
      console.warn(`[config] ignoring untrusted apiBase="${param}" — not in the API base allowlist`);
      sessionStorage.removeItem("apiBase");
      return "https://webmcp-shopapi.ping-devops.com/api";
    }
    const stored = sessionStorage.getItem("apiBase");
    if (stored) {
      const ok = validateApiBase(stored);
      if (ok) return ok;
      console.warn(`[config] ignoring untrusted stored apiBase="${stored}" — not in the API base allowlist`);
      sessionStorage.removeItem("apiBase");
    }
    return "https://webmcp-shopapi.ping-devops.com/api";
  })(),
};

// Derived: PingOne authorization server base URL
CONFIG.PINGONE_AS_BASE = `https://auth.pingone.com/${CONFIG.PINGONE_ENVIRONMENT_ID}/as`;
