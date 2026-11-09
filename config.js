// PingOne OIDC Configuration
// Replace these values with your PingOne environment settings
// For GitHub Pages deployment, set these directly or via a build step

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

  // DaVinci flow policy ID for the agent-initiated login tool (OOB HILT).
  // Sent as acr_values on the authorize request so the tool routes to the
  // OOB flow even if the app's default sign-on policy is a different flow.
  // Leave empty to use the application's default sign-on policy.
  LOGIN_FLOW_POLICY_ID: "",

  // Dedicated OIDC client for agent-initiated logins (the login tool).
  // The resulting access_token carries THIS client_id — the "session is
  // agentic" signal. Forwarded to PingOne Authorize as WebMCP.Request.clientId,
  // where policy can treat agent checkouts differently (e.g. force step-up).
  // Create a second public OIDC app (PKCE, same redirect URIs) and paste its
  // ID here. Leave empty to reuse the main client (session not separately
  // marked — the tool still works).
  PINGONE_AGENTIC_CLIENT_ID: "",

  // AG-UI Custom Agent WebSocket endpoint.
  // Set to a wss:// URL to enable the Custom Agent panel and auto-connect on sign-in.
  // Leave empty to hide the agent panel (BCA-only demo mode).
  // ?agentUrl= query param overrides (persisted in sessionStorage).
  AGUI_AGENT_URL: (() => {
    const param = new URLSearchParams(window.location.search).get("agentUrl");
    if (param) { sessionStorage.setItem("agentUrl", param); return param; }
    const stored = sessionStorage.getItem("agentUrl");
    if (stored) return stored;
    return "";
  })(),

  // Backend API base URL.
  // ?apiBase= query param overrides (persisted in sessionStorage so it survives
  // the OIDC redirect) — useful for pointing a deployed frontend at a local server:
  //   https://cprice-ping.github.io/WebMCP-Demo-Retail/?apiBase=http://localhost:3000/api
  SHOP_API_BASE: (() => {
    const param = new URLSearchParams(window.location.search).get("apiBase");
    if (param) { sessionStorage.setItem("apiBase", param); return param; }
    const stored = sessionStorage.getItem("apiBase");
    const onLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    // Discard a stored localhost URL when running on a remote origin (e.g. GitHub Pages)
    const storedIsLocal = stored && (stored.includes("localhost") || stored.includes("127.0.0.1"));
    if (stored && !(storedIsLocal && !onLocalhost)) return stored;
    return "https://webmcp-shopapi.ping-devops.com/api";
  })(),
};

// Derived: PingOne authorization server base URL
CONFIG.PINGONE_AS_BASE = `https://auth.pingone.com/${CONFIG.PINGONE_ENVIRONMENT_ID}/as`;
