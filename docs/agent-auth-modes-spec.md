# Agent Auth Spec: One Web App, Three Identity Modes

Goal: Person-only, Person + Companion Agent, and Agent-only sessions all work through
the same SPA, the same WebMCP tools, and the same backend. The only difference is
**where the access token comes from**, selected by a single "token provider" seam.
All actor distinction happens in PingOne (client_id) and P1AZ policy evaluation.

## Definitions

| Mode | Who acts | Grant | `client_id` in token | Human in tab? |
|---|---|---|---|---|
| A — Person | Human via OIDC redirect | Auth Code + PKCE | main app client | yes |
| B — Person + Companion | Agent calls tools in the human's tab | Auth Code + PKCE (agentic client) — today's demo | agentic client | yes |
| C — Agent-only / headless | Agent via backend device flow | Device Code (RFC 8628) on agentic client | agentic client | no |

Non-goal: new UI. WebMCP tools, `invokeTool`, `sessionStorage` reader stay.

## 1. Client: token provider seam (`app.js`, small, behavior-preserving)

Replace the direct `sessionStorage.getItem("access_token")` reads (today: `requireSession()`)
with a `TokenProvider`:

```js
async function getAccessToken() {
  const mode = sessionStorage.getItem("agent_auth_mode") || "browser"; // "browser" | "broker"
  if (mode === "broker") {
    // token was delivered by backend after device-flow approval (demo: injected once)
    return sessionStorage.getItem("access_token") || null;
  }
  return sessionStorage.getItem("access_token");
}
```

Rules:
- `requireSession()` becomes async (or caches) — thread the await through `invokeTool` and all handlers.
- Zero behavior change in Mode A/B: same storage keys, same redirect flow, same `handleCallback`.
- Do NOT touch checkout logic, tool registration, or `invokeTool` signatures.

## 2. Backend (`server/`): device-code broker (Mode C)

New route module `routes/auth.js` (mirror `routes/checkout.js` style), mounted at `/api/auth`:

- `POST /api/auth/start` `{ email? }` → calls PingOne `POST {as}/device_authorization`
  (agentic client, scope `openid profile email`, `client_id` auth — no secret in browser).
  Returns `{ request_id, user_code, verification_uri, expires_in, interval }`.
  `request_id` = server-side handle bound to the device_code; **never** return `device_code`.
- `GET /api/auth/status?request_id=…` → server polls PingOne `/token`
  (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) with backoff clock:
  - `authorization_pending`/`slow_down` → `{ status: "pending" }`
  - success → store token server-side keyed by `request_id`, return `{ status: "approved" }`
  - `expired_token`/`access_denied` → terminal states
- `POST /api/auth/token` `{ request_id }` → one-time exchange for the stored token
  (Mode C demo convenience; returns token once then deletes it). Production alternative:
  keep token server-side and have backend proxy tool calls — out of scope for the demo.
- Env: `AGENTIC_CLIENT_ID`, `PINGONE_AS_BASE` (or reuse existing config in `lib/pingone-az.js`),
  mounted only over HTTPS; rate-limit `/start` per IP+email; tokens never logged;
  short TTLs; in-memory store OK for demo (note it).

## 3. Client: new tools (both registered only when signed out / in broker mode)

- `device_login { email? }` — calls `/api/auth/start`; returns
  `{ user_code, verification_uri, expires_in, request_id }` + plain-language
  "Tell the human to open <uri> and enter code XXXX-XXXX."
- `auth_status { request_id? }` — without id: reports current tab session
  `{ signed_in, client_id?, expires_at? }`; with id: proxies `/api/auth/status`.
- On `approved`: call `/api/auth/token`, stash result in `sessionStorage`
  (`access_token`, `agent_auth_mode="broker"`), unregister `login`/`device_login`,
  register the standard store tools. From here the tab behaves exactly like Mode A/B.

## 4. P1AZ / PingOne config (manual, outside repo)

- Agentic app: enable **device code** grant.
- Policy: keep P1AZ evaluation keyed on `client_id`; decide whether device-flow tokens
  may satisfy checkout `consequential` actions or are read-only. Document the decision
  in README.
- `login_hint` should be required for `device_login` if you want person-pinned tokens;
  otherwise the approval screen personalizes the session anyway (user_code binds it).

## 5. Verification

1. `docker compose up` server; curl start/status happy path + error matrix
   (unknown request_id, expired, denied).
2. MCP Inspector (or scripted `document.modelContext`): `device_login` → human approves →
   `auth_status.approved` → `sessionStorage.access_token` set → `view_products` works,
   token inspector shows `client_id = agentic client`.
3. Regression: `login` redirect flow still works; Person-only token still shows main client_id;
   checkout step-up unchanged.

## Guardrails

- Never render/poll the DaVinci approval page in headless tabs (prior OOM kill).
  The only waiting primitive for Mode C is HTTP polling of `/api/auth/status`.
- Never put secrets in the SPA or git; server-side env only.
- `login` remains the human-present path; don't merge the two tools.
- Decide & document: do device-flow tokens carry checkout rights? (Recommend: yes for demo
  parity with Mode B, flagged in README.)

## Build order

1. TokenProvider seam (no behavior change) → 2. backend `/api/auth/*` → 3. `device_login` + `auth_status` → 4. P1AZ policy check → 5. README + k8s env updates.
