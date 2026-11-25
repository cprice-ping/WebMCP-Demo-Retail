# WebMCP Retail Demo

A retail demo that implements the [W3C WebMCP Draft Spec](https://webmachinelearning.github.io/webmcp/) with PingOne OIDC authentication and PingOne Authorize policy decisions at checkout.

The core idea: agents authenticate through the same OIDC stack as humans, but through their own OAuth clients. Every session's token carries a `client_id` that records how it was created — human sign-in, agent-initiated redirect, or agent-only CIBA — and the Authorize policy keys on that to decide what the session may do. Authentication isn't replaced by the agent; it's relocated to whichever entrypoint fits, and the provenance travels in the token.

Three sign-in paths support three ways of using an agent:

1. **Human** — the Sign In button. The person signs in; a sidecar agent sharing the tab uses that session.
2. **Agent-initiated, person present** — the `login` tool. The tab redirects through PingOne and the person approves out-of-band.
3. **Agent-only / headless** — the `ciba_login` tool. A CIBA push goes to the person's device; the tab never navigates.

A checkout request is evaluated by a PingOne Authorize policy before any order is placed. The policy receives who the user is, which client is acting, and what they're trying to do, and can return `PERMIT`, `DENY`, or demand step-up verification before the order goes through.

Live demo: **https://cprice-ping.github.io/WebMCP-Demo-Retail/**

---

## What This Demonstrates

When an MCP agent invokes a tool on this page, it uses the `access_token` already present in the browser session (or delivered by the CIBA broker) as the `Bearer` credential. The `client_id` in that token says which application made the request — the main client for human sign-ins, the companion client for agent-initiated redirects, the headless client for CIBA sessions. Same user, same `sub`, different provenance.

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
├── vendor/
│   └── webmcp-polyfill.js  W3C WebMCP polyfill (@w3c/webmcp-polyfill 0.1.1, Apache-2.0)
└── api/
    └── products.json   Product catalog (source of truth — includes emoji, price, description)
```

### Key Patterns

**Tools as the service layer.** Every state-changing action (load products, add to cart, checkout) goes through a registered tool via `invokeTool()`. The UI is a thin consumer of the same tool handlers the agent uses. There is no separate "UI path" vs "agent path."

**Single sources of truth.** `api/products.json` owns the product catalog. `toolRegistry` owns tool metadata — the count badge, the tool cards in the UI, and the tool console select are all derived from it at runtime. Nothing is hardcoded in HTML.

**Spec-compliant WebMCP.** Tools are registered via `document.modelContext.registerTool({ name, title, description, inputSchema, execute, annotations }, { signal })` per the [current spec](https://webmachinelearning.github.io/webmcp/). The `execute` function receives `(inputObject, options)` where `options.signal` is an `AbortSignal` for agent-initiated cancellation. Return values are plain JSON-serializable objects — the host serializes them per spec. Handlers return `{ error: "..." }` on failure rather than throwing, so agents always receive a readable reason.

---

## The Tools

| Tool | Type | Auth required | Notes |
|---|---|---|---|
| `login` | OIDC redirect | Signed out only | Agent-initiated sign-in for a tab the person can see. The agent asks for the email in chat, passes it to the tool, the tab navigates to PingOne, the person approves out-of-band, and the app returns signed in. Unregisters itself once a session exists. |
| `ciba_login` | CIBA via backend broker | Signed out only | Agent-initiated sign-in without navigating the tab — safe headless. The broker calls `/as/cibaAuthorization`, PingOne sends the approval to the person's device, the person approves, tokens land on one poll of `auth_status`. Requires the backend server. |
| `auth_status` | Broker poll | Signed out | Without `request_id`: reports the current session (`signed_in`, `client_id`, `provenance`). With one: polls the pending CIBA approval. |
| `view_products` | `GET /api/products.json` | Session | `readOnlyHint: true`; populates `PRODUCTS[]` and renders the grid |
| `add_to_cart` | Mutation | Session | Takes `product_id` + `quantity`; updates in-memory `cart{}` |
| `view_cart` | Read | Session | `readOnlyHint: true`; returns cart contents + total as JSON |
| `remove_from_cart` | Mutation | Session | Takes `product_id`; removes it entirely from `cart{}` |
| `checkout` | `POST /api/checkout` | Session + Bearer | `consequentialHint: true` — the host prompts before the tool runs. Agent path: PERMIT → order placed; interactive deny → the tab navigates to the OOB flow, cart stashed and restored on return, agent calls checkout again. Human-in-tab path (button, console): in-page modals instead. |

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

The current WebMCP spec has no tool-initiated elicitation API, so confirmation happens on two sides:

- **Host side**: `checkout` carries `consequentialHint: true`, so a WebMCP host shows its own permission card before executing (the WebMCP extension does this; browser chrome does the same for native implementations).
- **Page side**: when the call originates from the page's own UI (console button, product grid), the in-page confirmation modal runs — the human is right there. The modal honors `ToolExecuteCallbackOptions.signal`: if the agent aborts the call, the modal closes.

When the call comes through `document.modelContext`, there is no in-page confirmation — the host already prompted. This split is deliberate: an agent executing in a hidden tab has no human watching the page, so an in-page modal would hang forever.

### Step-up (P1AZ deny)

If the Authorize policy demands stronger verification than the session carries, the deny comes back with a statement payload. The server stashes the authoritative order summary under a short reference code (`step_up_code`) and returns it with the deny; the page then routes by the session's own auth mode — the same mechanism that created the session re-authenticates it.

**Agent path** (`document.modelContext` — the tab may be unattended). The transport matches the session:

- **Browser session** (button or `login` tool): the tab navigates to the OOB sign-in flow under the session's own client. The `step_up_code` rides as a custom authorize parameter; the tool returns `{challenge: "STEP_UP_REQUIRED", transport: "redirect", redirecting: true}` and execution ends (same pattern as the login tool). When the person completes verification out-of-band, the app reloads with a fresh session, the cart is restored, and the agent calls `checkout` again.

```
Agent calls checkout
  → POST /api/checkout
  → P1AZ: DENY with step-up statement → 202 { denied, step_up_code, statements }
  → tool stashes cart, navigates tab to OOB flow (step_up_code in the request object)
  → person approves on their device
  → app reloads signed in, cart restored
  → agent calls checkout again → P1AZ: PERMIT → order placed
```

- **Broker session** (`ciba_login`): CIBA re-auth through the backend broker — no navigation. The `step_up_code` becomes the CIBA `binding_message`; the tool returns `{challenge: "STEP_UP_REQUIRED", transport: "ciba", request_id}` and re-registers `auth_status` for the polling phase. The person's experience is the same push as sign-in; on approval the session refreshes under the same headless client with a fresh `auth_time`, the cart is restored, and the agent re-calls `checkout`.

```
Agent calls checkout
  → POST /api/checkout → 202 { denied, step_up_code, statements }
  → tool calls POST /api/auth/start { email, step_up_code }  (no navigation)
  → tool returns { challenge: "STEP_UP_REQUIRED", transport: "ciba", request_id }
  → person approves the push on their device
  → agent polls auth_status { request_id } → approved (session refreshed, cart restored)
  → agent calls checkout again → P1AZ: PERMIT → order placed
```

**Human-in-tab path** (UI clicks): in-page modals handle the challenges, dispatched by statement code:

| Code | Page behavior | Payload fields read |
|---|---|---|
| `deny-stepup` | OTP modal → second POST with `otpCode` + `deviceAuthenticationId` | `message`, `deviceAuthenticationId` |
| `deny-verify` | Verify QR modal → polls → POST with `verifyTransactionId` | `message`, `qrUrl`, `webVerificationCode`, `verifyTransactionId` |
| anything else | logged as unhandled → checkout fails with "unhandled statement code(s)" | — |

**Transaction context travels as a pointer, not a payload.** The deny stash holds the server-confirmed order summary; the `step_up_code` reaches the verification flow via the authorize request object (redirect) or `binding_message` (CIBA), and the DaVinci flow fetches the real summary from `GET /api/auth/context/:code` on the broker. The flow displays only server-confirmed data — anything the client passed in the request is treated as a claim, not a fact.

**Statement codes on the agent path:** the server treats *any* payload-bearing statement as interactive step-up regardless of its code name; the agent path doesn't branch on the code (the DaVinci flow owns what verification runs). The code names matter only to the human-in-tab dispatch table above. See the statement-code contract under [PingOne Authorize Policy](#pingone-authorize-policy).

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

This is agent-initiated HILT: the identity was collected by the agent, the person approved it out-of-band on a device they hold, and the resulting code lands in a session marked as agent-initiated by the companion client's `client_id` — which the server forwards to PingOne Authorize as `Request.clientId` for policy conditioning.

### Agent-initiated headless login (`ciba_login` tool)

The `ciba_login` tool serves sessions where the tab may have no human at any point — a headless browser an agent is driving. The tab never navigates; the only network activity is the broker. The person's entire experience is a notification they approve.

```
Agent calls ciba_login { email }
  → POST /api/auth/start { email }
      → broker POSTs /as/cibaAuthorization (Basic auth: headless client credentials;
        login_hint=<email>; binding_message="WebMCP" — PingOne caps it at 8 chars)
      → { auth_req_id, expires_in, interval } — auth_req_id stays on the server
      → tool returns { request_id, expires_in, next_step }
  → PingOne invokes the app's CIBA DaVinci flow, which notifies the person
  → person approves on their device
  → agent polls auth_status { request_id }
      → broker POSTs /as/token (grant_type=urn:openid:params:grant-type:ciba,
        same Basic auth) → tokens stored server-side
  → next poll returns { status: "approved" }
  → tool fetches tokens once from POST /api/auth/token (one-time pickup),
      stashes them in sessionStorage, sets agent_auth_mode="broker",
      unregisters login/ciba_login/auth_status, registers the store tools
```

Notes:

- The broker enforces the AS's polling interval (`authorization_pending` / `slow_down` discipline) so the tab can poll as often as it likes.
- The DaVinci flow behind the headless client must use the **CIBA Flow** toggle in Flow Settings and end in **Return CIBA Success / Return CIBA Error** connectors — a normal human-UX flow fails with "Unable to parse Http connector response" because CIBA flows run without an attached browser.
- Broker sessions don't silently refresh: the headless tab has no AS session cookie, so tokens simply expire (~1h) and the agent runs `ciba_login` again when needed.
- The email the person receives carries the real context (app name, approval link); `binding_message` is only the 8-character comparison code, and one code is sufficient since the tenant runs a single CIBA entrypoint.

Tool descriptions are the agent's selection contract between `login` and `ciba_login`: `login` warns against headless use (navigation unloads the tab); `ciba_login` is safe anywhere but notes that `login` gives better provenance when a person is present. The agent picks based on what it knows about its own context.

---

## Auth Flow

Standard OIDC Authorization Code + PKCE (all three paths — button, `login`, `ciba_login` — build on this):

```
User clicks "Sign In"
  → startLogin()  builds the /authorize URL (code_challenge, state, nonce)
  → PingOne AS    authenticates the user
  → redirect back with ?code=…
  → exchangeCode() swaps the code for { id_token, access_token }
  → tokens stored in sessionStorage
  → mountApp()    calls invokeTool("view_products") to bootstrap the UI
```

All three paths land in the same `TokenProvider` seam (`getAccessToken()` + `agent_auth_mode`); everything downstream — tools, checkout, P1AZ — is mode-agnostic and keys on the token's `client_id`.

**Silent refresh.** On page load, if the `access_token` is expired, `startSilentLogin()` sends `prompt=none` to the AS. If the AS session cookie is still valid, fresh tokens are issued without showing UI. If not, `error=login_required` is returned and the user sees the login screen.

**Token usage:**

| Token | Used for |
|---|---|
| `id_token` | UI display (user name, Token Inspector IT tab) |
| `access_token` | `requireSession()` gate, silent refresh trigger, `Authorization: Bearer` on API calls |

The `id_token` is never sent to a Resource Server. The `access_token` is the operative credential.

---

## Setup

### 1. PingOne Applications

Three OIDC applications in your PingOne environment — one per session entrypoint, so policy can tell them apart:

| Application | Type | Used by | Config |
|---|---|---|---|
| Main (public) | SPA | Sign In button | Authorization Code + PKCE (S256), redirect URI `https://<you>.github.io/<repo>/` (+ localhost), scopes `openid profile email`, token auth: none |
| Companion (public) | SPA | `login` tool | Same shape as main, same redirect URIs; sign-on policy mapped to the OOB HILT DaVinci flow |
| Headless (confidential) | Service/Web | `ciba_login` tool (via broker) | Token auth: Client Secret Basic; grant: CIBA; flow policy mapped to the push-approval DaVinci flow |

The main and companion clients go in `config.js` (`PINGONE_CLIENT_ID`, `PINGONE_AGENTIC_CLIENT_ID`); the headless client's ID and secret go in the server env (`HEADLESS_CLIENT_ID`, `HEADLESS_CLIENT_SECRET`).

### 2. Configure `config.js`

Set the client IDs from step 1 (`PINGONE_AGENTIC_CLIENT_ID` may stay empty to route `login` through the main client, but the dedicated companion client is what gives those sessions their provenance). `SHOP_API_BASE` points at your deployed backend. `PINGONE_AS_BASE` is derived from `PINGONE_ENVIRONMENT_ID` at runtime.

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
- The call source (`ui` for page-internal calls, `document.modelContext` for host-mediated agent calls)
- The full outbound HTTP request (method, URL, headers including Bearer)
- A note on which token is used and why
- The response payload

---

## WebMCP Registration

Tools register via `document.modelContext.registerTool()` per the [current spec](https://webmachinelearning.github.io/webmcp/). Browsers without native WebMCP get `document.modelContext` from the [W3C WebMCP polyfill](https://github.com/w3c-oss/webmcp-polyfill), vendored at `vendor/webmcp-polyfill.js` and loaded before `app.js`. The polyfill never replaces a native implementation, so the app has a single, spec-shaped code path in every browser.

What the polyfill does and doesn't give you:

- **Does:** the full page-side API (`registerTool`, `getTools`, `executeTool`, `toolchange`/`toolactivated`/`toolcancel`) in any secure context (HTTPS or `localhost`). You can call the page's tools from DevTools with `document.modelContext.getTools()` / `executeTool()`.
- **Doesn't:** connect the page to a browser agent. External agents still need native support (e.g. Chrome's WebMCP flag) or an extension.
- **Load order caveat:** the polyfill installs synchronously, so anything that injects `document.modelContext` *after* page scripts run will find it already present. Native browser support is unaffected.

The registration uses the current spec form — `registerTool(tool, options)` with an `AbortSignal` in options so dynamic tools (checkout, remove_from_cart) can be unregistered spec-compliantly by aborting the signal:

```js
// Primary: current spec form
document.modelContext.registerTool({
  name, title, description, inputSchema, execute, annotations
}, { signal: controller.signal });
```

---

## Backend API Server (Docker / k8s)

The static site can run standalone, but the three sign-in paths and real policy decisions need the backend: `login`/`ciba_login` work against PingOne directly, but `ciba_login` requires the CIBA broker in [`server/`](server/) (`/api/auth/*`), and PingOne Authorize checkout decisions happen server-side. Point `SHOP_API_BASE` at the deployed server.

```
server/
├── server.js              Express entry point, CORS, routes
├── routes/
│   ├── products.js        GET  /api/products
│   ├── checkout.js        POST /api/checkout  (AT validation → AZ decision → order)
│   └── auth.js            /api/auth/*  — CIBA broker for the ciba_login tool (Mode C)
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

  1. Validate AT signature via PingOne JWKS  (server can do this; browser cannot)
  2. client_credentials → PingOne worker token  (secret never leaves the server)
  3. POST /decisionEndpoints/{id}
       parameters:   { Request.clientId, Request.scope,
                       Request.orderTotal, Request.orderItemCount,
                       Request.authTime, Request.tokenIssuedAt }
       userContext:  { user: { id: <sub> } }
  4a. PERMIT  → return order receipt
  4b. DENY with a step-up statement (payload present)
              → 202 { denied: true, step_up_code, statements: [...] }
              (order summary stashed under step_up_code; the page routes by
               auth mode — OOB redirect or CIBA re-auth, see Step-up above)
  4c. DENY without statements (plain deny) → 403 { decision, advice }

  Retry after step-up:
  1-4. Same flow — the fresh session's auth_time now satisfies the policy,
       or the policy's own second-pass rules (Request.otpCode etc.) apply
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
  --from-literal=HEADLESS_CLIENT_ID=xxx \
  --from-literal=HEADLESS_CLIENT_SECRET=xxx \
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

The checkout route uses a PingOne Authorize **Decision Endpoint** to evaluate every checkout request before processing the order. The policy receives request context as flat parameters under the `Request` Trust Framework namespace and user identity from `userContext`.

### Trust Framework — `Request` folder

Create these attributes under **Authorize → Trust Framework → Attributes → Request** (the decision endpoint's namespace root):

| Attribute | Type | Present on |
|---|---|---|
| `clientId` | String | Every request |
| `scope` | String | Every request |
| `orderTotal` | String | Every request |
| `orderItemCount` | String | Every request |
| `authTime` | String | Every request (epoch seconds — session freshness) |
| `tokenIssuedAt` | String | Every request (epoch seconds — token age) |
| `otpCode` | String | Second pass only (MFA verification) |
| `deviceAuthenticationId` | String | Second pass only (MFA verification) |

In decision endpoint parameters these are referenced as e.g. `Request.clientId` (folder path + attribute name).

### Policy — example rules

One example policy that exercises the full loop. Your own rules will likely also condition on `Request.clientId` (that's the whole point of the client split) and `Request.authTime` (fresh-session checks).

**Rule 1: First pass → step-up MFA**

Condition: `Request.otpCode` is blank (first pass — no OTP yet provided)

Effect: `DENY`

Obligation: trigger PingOne MFA to send an OTP to the user identified by `userContext.user.id`. The advice statement the server looks for:
```json
{ "name": "DENY with MFA AuthN ID", "code": "deny-stepup",
  "payload": "{\"message\": \"step-up with MFA required\", \"deviceAuthenticationId\": \"<uuid>\"}" }
```

**Rule 2: Second pass → verify OTP and permit**

Condition: `Request.otpCode` is present **AND** `Request.deviceAuthenticationId` is present

Effect: Use `Request.deviceAuthenticationId` + `Request.otpCode` to call PingOne MFA verify. If the OTP is valid → `PERMIT`. If invalid → `DENY`.

**Headless posture:** rules matching the headless client (`Request.clientId`) should end in plain `DENY` — no statement payloads — unless the page has a dispatch branch for the code (see below).

### Statement codes — the policy ↔ tool contract

The server's rule is structural: **any deny whose statements carry a payload** is interactive step-up (202 with `step_up_code`); **a payload-less statement** (or none) is a plain DENY (403, terminal, session survives). What the code *name* selects differs by path:

- **Agent path** (`document.modelContext`): the code name is not branched on — any interactive deny routes to step-up by transport (redirect for browser sessions, CIBA for broker sessions; see [Step-up](#step-up-p1az-deny)). The DaVinci flow owns what verification runs, so the code is informational to the tool.
- **Human-in-tab path** (UI clicks): the page dispatches on the code name — `deny-stepup` (OTP modal) and `deny-verify` (Verify QR poll) have handlers; any other code fails with "unhandled statement code(s)". Until a third handler exists, policies serving UI-originated checkouts should stick to these two names.

**Authoring guidance:**

- Interactive step-up statements (payload present) work for **all three clients** — browser sessions step up by redirect, broker sessions by CIBA push. Neither navigates an unattended tab into a dead end; the CIBA transport made the earlier "never step-up headless" restriction obsolete.
- Reserve **plain DENY** (no payload) for the terminal "no, never" cases — a policy posture you don't want the client retrying with a fresher session.
- If you add a new statement code for a new verification method, the agent path picks it up automatically (any payload → step-up); add a handler in the human-path dispatch only if UI-originated checkouts should support it too.

### Worker Application

The server uses a separate **Worker (M2M) Application** — not the browser PKCE client — to call the decision endpoint. It requires:
- **Grant type:** Client Credentials
- **Auth method:** Client Secret Basic
- **Permission:** access to the Decision Endpoints API

Credentials are passed via `AZ_CLIENT_ID` / `AZ_CLIENT_SECRET` env vars and never leave the server. The CIBA broker does **not** use this credential — it authenticates with the headless app's own secret (see the login paths above).

### Headless Application (Mode C)

The headless agentic app must be **confidential** (holds a secret) with:
- **Token endpoint auth method:** Client Secret Basic
- **Grant type:** CIBA
- **Flow policy:** mapped to the push-approval DaVinci flow

Credentials are passed via `HEADLESS_CLIENT_ID` / `HEADLESS_CLIENT_SECRET` env vars. The secret only authorizes *initiating* backchannel requests — no token is issued without the person approving the push on their device.

---

## File Reference

| File | Purpose |
|---|---|
| [app.js](app.js) | OIDC flow, WebMCP tool registration, tool implementations, UI logic, cart state |
| [index.html](index.html) | UI shell — views, nav, token inspector tabs, checkout modal |
| [styles.css](styles.css) | All styling including tool label badges, token inspector, tools pane toggle |
| [config.js](config.js) | PingOne OIDC coordinates (main, companion, and headless clients) and API base URL |
| [api/products.json](api/products.json) | Product catalog for the static GitHub Pages demo |
| [api/webmcp.json](api/webmcp.json) | Static tool descriptor mirror (documentation for tool consumers) |
| [docs/agent-auth-modes-spec.md](docs/agent-auth-modes-spec.md) | Historical design record for the three-mode auth architecture |
| [server/](server/) | Node.js API server: JWKS validation, PingOne Authorize checkout, CIBA broker |
