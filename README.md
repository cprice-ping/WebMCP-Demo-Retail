# WebMCP Retail Demo

A fully client-side retail demo that implements the [W3C WebMCP Draft Spec](https://webmachinelearning.github.io/webmcp/) with PingOne OIDC authentication and **PingOne Authorize policy decisions at checkout**. It demonstrates a key architectural principle:

> **The user's existing OIDC session is sufficient for agent identity — no separate agent OAuth flow is required.**

A checkout request is evaluated by a PingOne Authorize policy before any order is placed. The policy receives the full request context — who the user is, which application is acting, and what they're trying to do — and can return `PERMIT`, `DENY`, or trigger a **step-up MFA challenge** that is surfaced back to the user in the browser as an in-page confirmation modal.

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

**Spec-compliant WebMCP.** Tools are registered via `document.modelContext.registerTool({ name, title, description, inputSchema, execute, annotations }, { signal })` per the [current spec](https://webmachinelearning.github.io/webmcp/). The `execute` function receives `(inputObject, options)` where `options.signal` is an `AbortSignal` for agent-initiated cancellation. Return values are plain JSON-serializable objects — the host serializes them per spec. Handlers return `{ error: "..." }` on failure rather than throwing, so agents always receive a readable reason.

---

## The Six Tools

| Tool | Type | Auth required | Notes |
|---|---|---|---|
| `login` | OIDC in-tab redirect | Signed out only | Agent-initiated sign-in. The agent asks the user for their email in chat and passes it to the tool; the tab navigates to PingOne, the user completes OOB verification (e.g. approves on their phone), and the app returns signed in via the callback. Unregisters itself once a session exists. |
| `view_products` | `GET /api/products.json` | Session | `readOnlyHint: true`; populates `PRODUCTS[]` and renders the grid |
| `add_to_cart` | Mutation | Session | Takes `product_id` + `quantity`; updates in-memory `cart{}` |
| `view_cart` | Read | Session | `readOnlyHint: true`; returns cart contents + total as JSON |
| `remove_from_cart` | Mutation | Session | Takes `product_id`; removes it entirely from `cart{}` |
| `checkout` | Host prompt → `POST /api/checkout` | Session + Bearer | The host prompts the user before the tool runs (`consequentialHint`) — extension permission card, browser chrome, or agent chat. POSTs to the server, which validates the AT and calls PingOne Authorize: PERMIT → order placed; step-up challenge → returned as a tool result for agent mediation (`MFA_REQUIRED` → agent asks for the OTP → `verify_checkout_otp`; `VERIFY_TRANSACTION` → user approves in the Verify app → `check_checkout_verification`). Human-in-tab paths (button, console) use the in-page modals instead. |

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

### User confirmation (checkout)

The current WebMCP spec removed the tool-initiated elicitation API (`client.requestUserInteraction` no longer exists). Confirmation is now a **page concern**: `checkout` shows an in-page modal that must be approved before the `POST` is sent. Agents enforce their own user prompt using the `consequentialHint: true` annotation — the WebMCP Extension, for example, shows a permission card for any tool marked consequential. The page also honors the spec's `ToolExecuteCallbackOptions.signal`: if the agent aborts the in-flight call, the confirmation modal closes automatically.

If PingOne Authorize returns a **step-up MFA challenge**, a second in-page modal collects the OTP the user received by email, without any additional agent turn. The full loop:

```
Agent calls checkout
  → Modal 1: confirm purchase (user clicks OK)
  → POST /api/checkout  (first pass)
  → P1AZ: DENY + deny-stepup advice  (OTP sent to user's email)
  → Server: 202 { challenge: "MFA_REQUIRED", deviceAuthenticationId }
  → Modal 2: enter OTP
  → POST /api/checkout  (second pass, includes otpCode + deviceAuthenticationId)
  → P1AZ: PERMIT
  → Order placed
```

Because the tool and DOM share the same process, no round-trip protocol is needed — the page's own modals are the user-interaction channel.

### Agent-initiated login (`login` tool)

The `login` tool lets an agent sign the user in without the button. The mechanism is the same OIDC authorization-code + PKCE request as the button, as a **full-page redirect**: the tool navigates the tab to PingOne, and execution ends there (the spec defines `AbortError` for "target document unloaded" — this is the expected pattern for navigating tools). The agent observes the outcome through page state: after the callback, `mountApp()` registers the store tools and the host's `ontoolchange` fires.

```
Agent calls login { email }
  (the agent asks the user for their email in chat first — required parameter)
  → Tool navigates the tab: GET /as/authorize (PKCE, state, nonce, login_hint=<email>)
      — authorized against PINGONE_AGENTIC_CLIENT_ID when configured
  → PingOne routes at the agentic client's sign-on policy → the OOB HILT DaVinci flow
  → DaVinci flow: reads global.parameters.authorizationRequest.login_hint,
      fires the OOB challenge (PingOne Verify push / email), user approves on their phone
  → PingOne redirects the tab back to the app with ?code=…&state=…
  → handleCallback() validates state, exchanges the code (same exchangeCode() as the
      button) → tokens → sessionStorage → mountApp()
  → Session lands in the tab; store tools register; the agent continues on page state
```

No popup, no in-page confirmation UI, no relay: a main-frame navigation needs no user gesture, so the tool works identically whether invoked by the extension, a native WebMCP browser, or the page's own console. The one-click email modal was removed with the popup design.

**DaVinci flow setup** (the OOB HILT flow behind the tool):

1. Build the flow: read `global.parameters.authorizationRequest.login_hint` → trigger the OOB challenge for that identity → on approval, look up the user → **Flow Control (Success)**.
2. Create/assign a **DaVinci application + flow policy** for the flow.
3. In PingOne, map that flow policy to the **agentic client's** sign-on policy (`PINGONE_AGENTIC_CLIENT_ID`) — tool logins route to the OOB flow automatically; button logins on the main client keep the default policy.
4. The redirect URI is the same one already registered (`PINGONE_REDIRECT_URI`) — the tab itself returns to the app.

This is agent-initiated HILT: the identity was collected by the agent, the human approved it out-of-band on a device they hold, and the resulting code lands in a session marked as agent-initiated by the agentic client's `client_id` — which the server forwards to PingOne Authorize as `WebMCP.Request.clientId` for policy conditioning.

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
- The call source (`ui`, `custom-agent`, or `document.modelContext`)
- The full outbound HTTP request (method, URL, headers including Bearer)
- A note on which token is used and why
- The response payload

---

## WebMCP Registration

Tools register via `document.modelContext.registerTool()` per the [current spec](https://webmachinelearning.github.io/webmcp/). On page load the app:

1. Installs a shim on `document.modelContext` if the browser doesn't natively support it (tools stay callable from the UI either way)
2. Retries native registration every 500ms for up to 10 seconds, in case the browser exposes `document.modelContext` after page scripts run (e.g. flag toggled mid-session)

The registration uses the current spec form — `registerTool(tool, options)` with an `AbortSignal` in options so dynamic tools (checkout, remove_from_cart) can be unregistered spec-compliantly by aborting the signal:

```js
// Primary: current spec form
document.modelContext.registerTool({
  name, title, description, inputSchema, execute, annotations
}, { signal: controller.signal });
```

---

## Optional: Node.js API Server (Docker / k8s)

The default demo serves static JSON from GitHub Pages and simulates the `POST /api/checkout` response client-side. For a real deployment — or to add **PingOne Authorize policy decisions** at checkout — a Node.js backend is included in [`server/`](server/).

```
server/
├── server.js              Express entry point, CORS, routes
├── routes/
│   ├── products.js        GET  /api/products
│   └── checkout.js        POST /api/checkout  (AT validation → AZ decision → order)
├── lib/
│   ├── token.js           Full JWKS signature validation (jose)
│   └── pingone-az.js      Client credentials token cache + decision endpoint client
├── products.json          Product catalog (same data as api/products.json)
├── Dockerfile             Multi-stage build, non-root user, healthcheck
├── docker-compose.yml     Local dev — mounts .env, hot-reloads products.json
├── .env.example           All env vars documented
└── k8s/
    ├── namespace.yaml
    ├── deployment.yaml    Env from Secret, products from ConfigMap
    ├── service.yaml
    ├── ingress.yaml       nginx + TLS (cert-manager)
    ├── configmap.yaml     Product catalog as a ConfigMap
    └── secret.yaml        Template only — never commit real values
```

### Checkout trust chain (server-side)

```
POST /api/checkout
  Authorization: Bearer <user_AT>

  First pass:
  1. Validate AT signature via PingOne JWKS  (server can do this; browser cannot)
  2. client_credentials → PingOne worker token  (secret never leaves the server)
  3. POST /decisionEndpoints/{id}
       parameters:   { WebMCP.Request.clientId, WebMCP.Request.scope,
                       WebMCP.Request.orderTotal, WebMCP.Request.orderItemCount }
       userContext:  { user: { id: <sub> } }
  4a. PERMIT  → return order receipt
  4b. DENY + deny-stepup advice
              → 202 { challenge: "MFA_REQUIRED", deviceAuthenticationId }
              (P1AZ obligation has already sent OTP to user's email)
  4c. DENY (no step-up) → 403 { decision, advice }

  Second pass (user submitted OTP):
  1-2. Same AT validation + worker token
  3. POST /decisionEndpoints/{id}
       parameters:   { ...same as first pass,
                       WebMCP.Request.otpCode, WebMCP.Request.deviceAuthenticationId }
       userContext:  { user: { id: <sub> } }
  4a. PERMIT  → return order receipt
  4b. DENY    → 403 { decision, advice }
```

### Local dev

```bash
cd server
cp .env.example .env        # fill in PingOne values
docker-compose up --build
```

Then point the frontend at the local server by updating `config.js`:

```js
SHOP_API_BASE: "http://localhost:3000/api",
```

Set `ALLOWED_ORIGIN=http://localhost:8080` (or wherever you serve the frontend locally) in `.env`.

Leave `AZ_DECISION_ENDPOINT_ID` blank to skip the Authorize step and auto-PERMIT all checkouts — useful while iterating on the policy.

### k8s deploy

```bash
# Create namespace
kubectl apply -f server/k8s/namespace.yaml

# Create secret (imperatively — never commit real values)
kubectl create secret generic shopapi-secrets \
  --from-literal=PINGONE_ENVIRONMENT_ID=xxx \
  --from-literal=AZ_CLIENT_ID=xxx \
  --from-literal=AZ_CLIENT_SECRET=xxx \
  --from-literal=AZ_DECISION_ENDPOINT_ID=xxx \
  -n shopmcp

# Build and push your image
docker build -t your-registry/shopmcp-api:latest server/
docker push your-registry/shopmcp-api:latest

# Apply everything else
kubectl apply -f server/k8s/configmap.yaml
kubectl apply -f server/k8s/deployment.yaml
kubectl apply -f server/k8s/service.yaml
kubectl apply -f server/k8s/ingress.yaml
```

Update `ALLOWED_ORIGIN` in [server/k8s/deployment.yaml](server/k8s/deployment.yaml) to your GitHub Pages URL, and `SHOP_API_BASE` in [config.js](config.js) to your k8s ingress hostname.

---

## PingOne Authorize Policy

The checkout route uses a PingOne Authorize **Decision Endpoint** to evaluate every checkout request before processing the order. The policy receives request context as flat parameters under the `WebMCP.Request` Trust Framework namespace and user identity from `userContext`.

### Trust Framework — `WebMCP` → `Request` folder

Create these attributes under **Authorize → Trust Framework → Attributes → WebMCP → Request**:

| Attribute | Type | Present on |
|---|---|---|
| `clientId` | String | Every request |
| `scope` | String | Every request |
| `orderTotal` | String | Every request |
| `orderItemCount` | String | Every request |
| `otpCode` | String | Second pass only (MFA verification) |
| `deviceAuthenticationId` | String | Second pass only (MFA verification) |

In decision endpoint parameters these are referenced as e.g. `WebMCP.Request.clientId` (folder path + attribute name).

### Policy — two rules

**Rule 1: First pass → step-up MFA**

Condition: `WebMCP.Request.otpCode` is blank (first pass — no OTP yet provided)

Effect: `DENY`

Obligation: trigger PingOne MFA to send an OTP to the user identified by `userContext.user.id`. The advice statement the server looks for:
```json
{ "name": "DENY with MFA AuthN ID", "code": "deny-stepup",
  "payload": "{\"message\": \"step-up with MFA required\", \"deviceAuthenticationId\": \"<uuid>\"}" }
```

**Rule 2: Second pass → verify OTP and permit**

Condition: `WebMCP.Request.otpCode` is present **AND** `WebMCP.Request.deviceAuthenticationId` is present

Effect: Use `WebMCP.Request.deviceAuthenticationId` + `WebMCP.Request.otpCode` to call PingOne MFA verify. If the OTP is valid → `PERMIT`. If invalid → `DENY`.

### Worker Application

The server uses a separate **Worker (M2M) Application** — not the browser PKCE client — to call the decision endpoint. It requires:
- **Grant type:** Client Credentials
- **Auth method:** Client Secret Basic
- **Permission:** access to the Decision Endpoints API

Credentials are passed via `AZ_CLIENT_ID` / `AZ_CLIENT_SECRET` env vars and never leave the server.

---

## File Reference

| File | Purpose |
|---|---|
| [app.js](app.js) | OIDC flow, WebMCP tool registration, tool implementations, UI logic, cart state |
| [index.html](index.html) | UI shell — views, nav, token inspector tabs, checkout modal |
| [styles.css](styles.css) | All styling including tool label badges, token inspector, tools pane toggle |
| [config.js](config.js) | PingOne OIDC coordinates and API base URL |
| [api/products.json](api/products.json) | Product catalog for the static GitHub Pages demo |
| [server/](server/) | Optional Node.js API server with JWKS validation and PingOne Authorize integration |
