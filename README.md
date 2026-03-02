# WebMCP Retail Demo

A fully client-side retail demo that implements the [W3C WebMCP Draft Spec](https://webmachinelearning.github.io/webmcp/) with PingOne OIDC authentication. It demonstrates a key architectural principle:

> **The user's existing OIDC session is sufficient for agent identity — no separate agent OAuth flow is required.**

Live demo: **https://cprice-ping.github.io/WebMCP-Demo-Retail/**

---

## What This Demonstrates

When an MCP agent (e.g. the [MCP Tool Explorer](https://marketplace.visualstudio.com/items?itemName=AutomateTheEarth.mcp-tool-explorer) VS Code extension) invokes a tool on this page, it uses the same `access_token` already present in the user's browser session as a `Bearer` credential. The `client_id` embedded in that token identifies _which application_ made the request. No second OAuth dance, no agent-specific credentials.

The **Token Inspector** panel (right-hand side) shows this in real time:

| Claim | Where it comes from | What it proves |
|---|---|---|
| `aud` | Access token payload | Which resource server the token was issued for |
| `client_id` / `azp` | Access token payload | Which OAuth client (application) the agent is acting through |
| `scope` | Access token payload | What permissions were granted |
| `sub` | ID token payload | Which user is authenticated |

The browser hard-checks only `exp`. Signature, `aud`, `client_id`, and `scope` are all validated server-side by the Resource Server — the Token Inspector logs them for educational transparency.

---

## Architecture

```
Browser
├── index.html          UI shell (login, store, cart, tool console, token inspector)
├── styles.css          All styling
├── config.js           PingOne OIDC + API configuration
├── app.js              Everything: OIDC flow, WebMCP registration, tools, UI logic
└── api/
    └── products.json   Product catalog (source of truth — includes emoji, price, description)
```

### Key Patterns

**Tools as the service layer.** Every state-changing action (load products, add to cart, checkout) goes through a registered tool via `invokeTool()`. The UI is a thin consumer of the same tool handlers the agent uses. There is no separate "UI path" vs "agent path."

**Single sources of truth.** `api/products.json` owns the product catalog. `toolRegistry` owns tool metadata — the count badge, the tool cards in the UI, and the tool console select are all derived from it at runtime. Nothing is hardcoded in HTML.

**Spec-compliant WebMCP.** Tools are registered as `{ name, description, inputSchema, execute, annotations }`. The `execute` function receives `(input, client)`. Return values are `{ content: [{ type: "text", text }] }`. Errors return `{ content: [...], isError: true }` — handlers never throw.

---

## The Five Tools

| Tool | Type | Auth required | Notes |
|---|---|---|---|
| `view_products` | `GET /api/products.json` | Session | `readOnlyHint: true`; populates `PRODUCTS[]` and renders the grid |
| `add_to_cart` | Mutation | Session | Takes `product_id` + `quantity`; updates in-memory `cart{}` |
| `view_cart` | Read | Session | `readOnlyHint: true`; returns cart contents + total as JSON |
| `remove_from_cart` | Mutation | Session | Takes `product_id`; removes it entirely from `cart{}` |
| `checkout` | Elicitation → `POST /api/checkout` | Session + Bearer | Uses `client.requestUserInteraction()` for user confirmation before posting |

### Session Guard

Every tool calls `requireSession()` first. This checks for an `access_token` in `sessionStorage`. If absent, the tool returns a structured error — the agent receives a readable explanation, not a raw exception.

```js
function requireSession() {
  if (sessionStorage.getItem("access_token")) return null;
  return {
    error: "Session required.",
    detail: "Tools forward the access_token as the Bearer credential. …"
  };
}
```

### Elicitation (checkout)

`checkout` uses the WebMCP spec's `client.requestUserInteraction(callback)` to pause and ask the user for confirmation before the `POST` is sent. When called from the UI, a `mockClient` is used that invokes the callback immediately (the modal is already in-page). When called by a native `navigator.modelContext` agent, the host provides a real `ModelContextClient`.

This is distinct from the MCP Protocol `elicitation/create` mechanism — because the tool and DOM share the same process, there's no need for the round-trip protocol complexity.

---

## Auth Flow

Standard OIDC Authorization Code + PKCE:

```
User clicks "Sign In"
  → startLogin()  builds the /authorize URL (code_challenge, state, nonce)
  → PingOne AS    authenticates the user
  → redirect back with ?code=…
  → exchangeCode() swaps the code for { id_token, access_token }
  → tokens stored in sessionStorage
  → mountApp()    calls invokeTool("view_products") to bootstrap the UI
```

**Silent refresh.** On page load, if the `access_token` is expired, `startSilentLogin()` sends `prompt=none` to the AS. If the AS session cookie is still valid, fresh tokens are issued without showing UI. If not, `error=login_required` is returned and the user sees the login screen.

**Token usage:**

| Token | Used for |
|---|---|
| `id_token` | UI display (user name, Token Inspector IT tab) |
| `access_token` | `requireSession()` gate, silent refresh trigger, `Authorization: Bearer` on API calls |

The `id_token` is never sent to a Resource Server. The `access_token` is the operative credential.

---

## Setup

### 1. PingOne Application

Create a **Single-Page Application** in your PingOne environment with:

- **Grant type:** Authorization Code
- **Response type:** Code
- **PKCE:** Required (S256)
- **Redirect URI:** `https://<your-github-username>.github.io/<repo-name>/` (and `http://localhost:8080` for local dev)
- **Scopes:** `openid profile email`
- **Token endpoint auth method:** None (public client)

### 2. Configure `config.js`

```js
const CONFIG = {
  PINGONE_CLIENT_ID:       "<your-app-client-id>",
  PINGONE_ENVIRONMENT_ID:  "<your-environment-id>",
  PINGONE_REDIRECT_URI:    window.location.origin + window.location.pathname,
  PINGONE_SCOPES:          "openid profile email",
  SHOP_API_BASE:           window.location.origin + window.location.pathname.replace(/\/$/, "") + "/api",
};
```

`PINGONE_AS_BASE` is constructed from `PINGONE_ENVIRONMENT_ID` at runtime — you do not need to set it manually.

### 3. Deploy to GitHub Pages

This is a zero-build static site. Push to `main` and enable GitHub Pages (root of `main`):

```bash
git push origin main
# Settings → Pages → Source: Deploy from branch → main / (root)
```

### 4. Local Development

Any static file server works:

```bash
npx serve .
# or
python3 -m http.server 8080
```

---

## Tool Console

The right-hand **Tool Console** panel shows every tool invocation in real time — both UI-triggered and agent-triggered calls share the same log. This makes the demo useful for explaining what an agent actually does when it calls a tool.

Each log entry includes:
- The call source (`ui` or `navigator.modelContext`)
- The full outbound HTTP request (method, URL, headers including Bearer)
- A note on which token is used and why
- The response payload

---

## WebMCP Registration

Tools register via `navigator.modelContext.registerTool()`. On page load the app:

1. Installs a shim if the browser doesn't natively support `navigator.modelContext`
2. Retries native registration every 500ms for up to 10 seconds (browser extensions inject `navigator.modelContext` after page scripts run)

The registration attempts four forms in order (most-spec-compliant first) so the app works with both current and older versions of MCP Tool Explorer:

```js
// Primary: W3C spec form
navigator.modelContext.registerTool({
  name, description, inputSchema, execute, annotations
});
```

---

## File Reference

| File | Purpose |
|---|---|
| [app.js](app.js) | OIDC flow, WebMCP tool registration, tool implementations, UI logic, cart state |
| [index.html](index.html) | UI shell — views, nav, token inspector tabs, checkout modal |
| [styles.css](styles.css) | All styling including tool label badges, token inspector, tools pane toggle |
| [config.js](config.js) | PingOne OIDC coordinates and API base URL |
| [api/products.json](api/products.json) | Product catalog — source of truth for names, prices, descriptions, emoji |
