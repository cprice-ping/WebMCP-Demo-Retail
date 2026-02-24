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

  // Backend API base URL.
  // For this demo: serves static JSON from the same GitHub Pages origin.
  // For a real deployment: point this at your API (e.g. https://api.example.com/shop).
  // view_products → GET  {SHOP_API_BASE}/products.json   (no auth required)
  // checkout      → POST {SHOP_API_BASE}/checkout        (Authorization: Bearer <access_token>)
  SHOP_API_BASE: window.location.origin + window.location.pathname.replace(/\/$/, "") + "/api",
};

// Derived: PingOne authorization server base URL
CONFIG.PINGONE_AS_BASE = `https://auth.pingone.com/${CONFIG.PINGONE_ENVIRONMENT_ID}/as`;
