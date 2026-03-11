// ============================================================
// ShopMCP — WebMCP Retail Demo
// Demonstrates: session + client_id as sufficient agent identity
// ============================================================

"use strict";

// ------------------------------------------------------------
// Product catalog — populated from api/products.json via view_products tool.
// Do not add products here; api/products.json is the source of truth.
// ------------------------------------------------------------
const PRODUCTS = [];

// ------------------------------------------------------------
// In-memory cart state
// ------------------------------------------------------------
let cart = {}; // { productId: quantity }

// ============================================================
// PingOne Protect (Signals) SDK
// SDK is loaded from CDN via a <script defer> tag in index.html.
// initProtectSDK() — called once from mountApp(); fires-and-forgets.
// getProtectSignals() — called at checkout tool invocation; returns
//   the payload string for P1AZ, or null on failure/timeout.
// ============================================================

let protectSdkReady  = false;
let protectSdkFailed = false;

function initProtectSDK() {
  const doInit = () => {
    if (!window._pingOneSignals) {
      protectSdkFailed = true;
      logToolEvent("[protect] _pingOneSignals not on window after ready event", "warn");
      return;
    }
    window._pingOneSignals.init({
      behavioralDataCollection:      true,
      universalDeviceIdentification: true,
    }).then(() => {
      protectSdkReady = true;
      logToolEvent("[protect] PingOne Protect SDK initialized — signals active", "info");
    }).catch(err => {
      protectSdkFailed = true;
      logToolEvent(`[protect] SDK init() failed: ${err?.message ?? err}`, "warn");
    });
  };

  // The SDK sets window._pingOneSignalsReady = true and dispatches
  // PingOneSignalsReadyEvent when it is ready to be initialised.
  if (window._pingOneSignalsReady) {
    doInit();
  } else {
    document.addEventListener("PingOneSignalsReadyEvent", doInit, { once: true });
  }
}

async function getProtectSignals(timeoutMs = 5000) {
  if (!protectSdkReady) {
    logToolEvent(
      protectSdkFailed
        ? "[protect] SDK failed to init — checkout will proceed without signals"
        : "[protect] SDK not yet ready — checkout will proceed without signals",
      "warn"
    );
    return null;
  }
  try {
    const payload = await Promise.race([
      window._pingOneSignals.getData(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("getData() timed out")), timeoutMs)
      ),
    ]);
    logToolEvent(`[protect] getData() returned ${payload?.length ?? 0}-char signals payload`, "info");
    return payload ?? null;
  } catch (err) {
    logToolEvent(`[protect] getData() error: ${err?.message ?? err} — proceeding without signals`, "warn");
    return null;
  }
}

// ------------------------------------------------------------
// Verify modal helpers
// openVerifyModal: shows the modal and returns a view-handle.
// Wire cancel BEFORE calling this so the handler is set once.
// ------------------------------------------------------------

function openVerifyModal({ hint, qrUrl, webVerificationCode }) {
  const modal    = document.getElementById("modal-verify");
  const hintEl   = document.getElementById("verify-hint");
  const qrImg    = document.getElementById("verify-qr-img");
  const statusEl = document.getElementById("verify-status");
  const codeWrap = document.getElementById("verify-code-wrap");
  const codeEl   = document.getElementById("verify-code");

  if (hintEl)   hintEl.textContent = hint ?? "Scan the QR code to verify this transaction.";
  if (qrImg)  { qrImg.src = qrUrl || ""; qrImg.alt = "Transaction verification QR code"; }
  if (statusEl) statusEl.textContent = "Waiting for verification… polling every 4 seconds.";

  if (codeWrap && codeEl) {
    if (webVerificationCode) {
      codeEl.textContent = webVerificationCode;
      codeWrap.classList.remove("hidden");
    } else {
      codeWrap.classList.add("hidden");
    }
  }

  modal.classList.remove("hidden");

  return {
    close() {
      modal.classList.add("hidden");
      if (statusEl) statusEl.textContent = "";
      if (qrImg)  { qrImg.removeAttribute("src"); qrImg.alt = ""; }
      if (codeWrap) codeWrap.classList.add("hidden");
      if (codeEl)   codeEl.textContent = "";
    },
    setStatus(msg) {
      const el = document.getElementById("verify-status");
      if (el) el.textContent = msg;
    },
    setHint(msg) {
      const el = document.getElementById("verify-hint");
      if (el) el.textContent = msg;
    },
  };
}

// runVerifyChallenge: single entry-point for the full verify flow.
// Opens the modal, starts polling, resolves when approved or cancelled.
// This is safe to await inside a WebMCP elicitation Promise — the polling
// loop runs asynchronously and the modal stays open while it waits.
async function runVerifyChallenge({ hint, qrUrl, webVerificationCode, requestBody }) {
  return new Promise((resolve) => {
    let done = false;

    // Wire cancel first, before opening the modal, so we replace
    // the button exactly once and always have the right handler.
    const cancelBtn   = document.getElementById("verify-cancel");
    const cancelClone = cancelBtn.cloneNode(true);
    cancelBtn.replaceWith(cancelClone);
    cancelClone.addEventListener("click", () => {
      if (done) return;
      done = true;
      view.close();
      resolve({ cancelled: true, reason: "User cancelled verify transaction flow" });
    }, { once: true });

    const view = openVerifyModal({ hint, qrUrl, webVerificationCode });

    // Polling loop — runs in the background while modal is open.
    (async () => {
      const started    = Date.now();
      const maxMs      = 120_000;
      const intervalMs = 4_000;

      while (Date.now() - started < maxMs) {
        if (done) return;
        await new Promise(r => setTimeout(r, intervalMs));
        if (done) return;

        const elapsed = Math.floor((Date.now() - started) / 1000);
        view.setStatus(`Waiting for verification… ${elapsed}s elapsed (polling every 4s)`);

        let resp;
        try {
          resp = await apiRequest("POST", "/checkout", {
            body: requestBody,
            requiresAuth: true,
          });
        } catch (err) {
          if (done) return;
          done = true;
          view.close();
          resolve({ error: err.message });
          return;
        }

        if (resp?.success && resp?.order) {
          if (done) return;
          done = true;
          view.setStatus("Verification complete. Finalising checkout…");
          view.close();
          resolve(resp);
          return;
        }

        // Still pending — loop again
        logToolEvent(`[verify] poll ${elapsed}s — still pending`);
      }

      // Timed out
      if (!done) {
        done = true;
        view.close();
        resolve({ error: "Verification timed out after 120 seconds. Please try checkout again." });
      }
    })();
  });
}

// ------------------------------------------------------------
// Auth state
// ------------------------------------------------------------
let idTokenClaims = null;
let idTokenRaw = null;

// ============================================================
// OIDC helpers (PKCE, implicit-style ID token for demo)
// ============================================================

function randomBase64url(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function sha256Base64url(plain) {
  const enc = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parseJwt(token) {
  try {
    const [, payload] = token.split(".");
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Build the PKCE authorization URL and redirect
async function startLogin() {
  const verifier = randomBase64url(64);
  const challenge = await sha256Base64url(verifier);

  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("oauth_state", randomBase64url(16));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.PINGONE_CLIENT_ID,
    redirect_uri: CONFIG.PINGONE_REDIRECT_URI,
    scope: CONFIG.PINGONE_SCOPES,
    state: sessionStorage.getItem("oauth_state"),
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce: randomBase64url(16),
  });

  window.location.href = `${CONFIG.PINGONE_AS_BASE}/authorize?${params}`;
}

// Silent token refresh using prompt=none.
// The AS checks its own session cookie (longer-lived than our id_token) and
// issues fresh tokens without showing the user any UI.
// If the AS session is also expired it returns error=login_required, which we
// catch and handle by falling back to the interactive login screen.
async function startSilentLogin() {
  const verifier = randomBase64url(64);
  const challenge = await sha256Base64url(verifier);

  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("oauth_state", randomBase64url(16));
  sessionStorage.setItem("silent_refresh", "1");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.PINGONE_CLIENT_ID,
    redirect_uri: CONFIG.PINGONE_REDIRECT_URI,
    scope: CONFIG.PINGONE_SCOPES,
    state: sessionStorage.getItem("oauth_state"),
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce: randomBase64url(16),
    prompt: "none",          // do not show any login UI
  });

  window.location.href = `${CONFIG.PINGONE_AS_BASE}/authorize?${params}`;
}

// Exchange auth code for tokens
async function exchangeCode(code) {
  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) throw new Error("No PKCE verifier in session");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CONFIG.PINGONE_REDIRECT_URI,
    client_id: CONFIG.PINGONE_CLIENT_ID,
    code_verifier: verifier,
  });

  const resp = await fetch(`${CONFIG.PINGONE_AS_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${err}`);
  }

  return resp.json();
}

// ============================================================
// WebMCP tool registration
// navigator.modelContext polyfill for browsers that don't yet
// implement the spec — tools are still callable via the UI.
// ============================================================

const toolRegistry = {};
const nativeRegisteredTools = new Set();
const nativeRegistrationFailures = new Map();

function ensureModelContextShim() {
  if (typeof navigator === "undefined") return null;

  if (!navigator.modelContext) {
    const shim = {
      __shopMcpShim: true,
      async registerTool(name, descriptor, handler) {
        toolRegistry[name] = { descriptor, handler };
      },
      listTools() {
        return Object.entries(toolRegistry).map(([name, value]) => ({
          name,
          description: value.descriptor?.description || "",
          parameters: value.descriptor?.parameters || {},
        }));
      },
      async callTool(name, args = {}) {
        const tool = toolRegistry[name];
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        return tool.handler(args);
      },
    };

    navigator.modelContext = shim;
  }

  return navigator.modelContext;
}

function registerToolsWithNativeModelContext() {
  if (typeof navigator === "undefined" || !navigator.modelContext?.registerTool) return;
  if (navigator.modelContext.__shopMcpShim) return;

  Object.entries(toolRegistry).forEach(([name, value]) => {
    if (nativeRegisteredTools.has(name)) return;

    const inputSchema = value.descriptor?.parameters || { type: "object", properties: {} };
    const annotations = value.descriptor?.annotations;
    const candidates = [
      // Primary: W3C WebMCP spec form — single object, 'execute' key, optional annotations
      () => navigator.modelContext.registerTool({
        name,
        description: value.descriptor?.description || "",
        inputSchema,
        execute: value.handler,
        ...(annotations && { annotations }),
      }),
      // Fallback: 'handler' key (accepted by some extension versions)
      () => navigator.modelContext.registerTool({
        name,
        description: value.descriptor?.description || "",
        inputSchema,
        handler: value.handler,
      }),
      // Fallback: 'parameters' instead of 'inputSchema'
      () => navigator.modelContext.registerTool({
        name,
        description: value.descriptor?.description || "",
        parameters: inputSchema,
        execute: value.handler,
      }),
      // Fallback: old 3-argument form
      () => navigator.modelContext.registerTool(name, value.descriptor, value.handler),
    ];

    let registered = false;
    let lastErrorMessage = "Unknown registerTool error";

    try {
      for (const attempt of candidates) {
        try {
          attempt();
          registered = true;
          break;
        } catch (e) {
          lastErrorMessage = e?.message || String(e);
        }
      }

      if (registered) {
        nativeRegisteredTools.add(name);
        nativeRegistrationFailures.delete(name);
        logToolEvent(`Registered tool "${name}" via navigator.modelContext`);
        return;
      }

      const prev = nativeRegistrationFailures.get(name);
      if (prev !== lastErrorMessage) {
        nativeRegistrationFailures.set(name, lastErrorMessage);
        logToolEvent(`navigator.modelContext.registerTool unavailable: ${lastErrorMessage}`, "warn");
      }
    } catch (e) {
      const msg = e?.message || String(e);
      const prev = nativeRegistrationFailures.get(name);
      if (prev !== msg) {
        nativeRegistrationFailures.set(name, msg);
        logToolEvent(`navigator.modelContext.registerTool unavailable: ${msg}`, "warn");
      }
    }
  });
}

function registerTool(name, descriptor, handler) {
  const instrumentedHandler = createInstrumentedToolHandler(name, handler);
  toolRegistry[name] = { descriptor, handler: instrumentedHandler, rawHandler: handler };

  const modelContext = ensureModelContextShim();
  if (modelContext?.__shopMcpShim && modelContext.registerTool) {
    modelContext.registerTool(name, descriptor, instrumentedHandler);
  }

  registerToolsWithNativeModelContext();
}

// ============================================================
// API client
// Wraps fetch() and logs the full outbound request to the
// Tool Console so the invocation contract is always visible.
// ============================================================

// Pre-flight token health check — runs before the fetch so problems are
// surfaced in the Tool Console with a clear explanation, not a raw 401.
//
// What the BROWSER can check:
//   exp       — timestamp is in the payload; no key needed
//
// What only the RESOURCE SERVER can check:
//   aud       — RS verifies its own identifier is in the audience list
//   client_id — RS confirms the requesting app is a known/allowed client
//   scope     — RS confirms the required permission is present
//   signature — RS validates against the JWKS; browser has no key
//
// We log aud / client_id / scope for visibility, but do NOT fail on them —
// the RS is the authority on those claims, not the browser.
function checkTokenHealth(token) {
  const claims = parseJwt(token);
  if (!claims) {
    return { ok: false, reason: "Token is malformed — cannot decode JWT payload." };
  }

  const nowSec = Math.floor(Date.now() / 1000);

  if (claims.exp && claims.exp < nowSec) {
    const expired = new Date(claims.exp * 1000).toLocaleTimeString();
    return {
      ok: false,
      reason: `Token expired at ${expired}. ` +
              `The browser can read 'exp' without a key. ` +
              `The RS would also reject this with 401.`,
      claims,
    };
  }

  // Informational only — log what the RS *will* validate, but don't block here.
  const aud       = claims.aud ? [].concat(claims.aud).join(", ") : "(not present)";
  const clientId  = claims.client_id || claims.azp || "(not present)";
  const scope     = claims.scope || "(not present)";

  return {
    ok: true,
    claims,
    rsChecks: {
      note: "RS validates these; browser logs them for transparency only.",
      aud,
      client_id: clientId,
      scope,
    },
  };
}

async function apiRequest(method, path, { body, requiresAuth = false } = {}) {
  const url = CONFIG.SHOP_API_BASE + path;
  const headers = { "Content-Type": "application/json" };

  if (requiresAuth) {
    // access_token is the correct Bearer credential for resource servers.
    // id_token is an identity assertion for the client only — sending it as
    // a Bearer to an API is wrong and the RS will reject it.
    const token = sessionStorage.getItem("access_token");

    // 1. Existence check (browser can do this)
    if (!token) {
      throw new Error(
        "No access_token in sessionStorage — user must sign in before calling a protected tool. " +
        "Note: the id_token is intentionally NOT used here; it is an identity assertion for " +
        "the client only and resource servers will reject it as a Bearer credential."
      );
    }

    // 2. Pre-flight health check (browser can decode but NOT verify the signature)
    const health = checkTokenHealth(token);
    if (!health.ok) {
      logToolEvent(`[Token pre-flight] ✗ fail — ${health.reason}`, "error");
      throw new Error(`Token pre-flight failed: ${health.reason}`);
    }
    logToolEvent(
      `[Token pre-flight] ✓ exp OK — RS will also validate: ${JSON.stringify(health.rsChecks)}`,
      "info"
    );

    headers["Authorization"] = `Bearer ${token}`;
  }

  // Log the full outbound request before it goes out
  const requestMeta = { method, url, headers: { ...headers }, body: body ?? undefined };
  if (requiresAuth) {
    requestMeta["__note"] =
      "Bearer is the OIDC access_token from the PingOne session — " +
      "the agent forwards the user's credential; no separate agent OAuth required. " +
      "Signature validation happens server-side; the browser only checks 'exp' and 'aud'.";
  }
  logToolEvent(`[API] ${method} ${url}\n${JSON.stringify(requestMeta, null, 2)}`, "call");

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    // Surface auth rejections explicitly — these come from the backend, not the tool
    if (resp.status === 401) {
      throw new Error(
        `[401 Unauthorized] Backend rejected the Bearer token. ` +
        `Likely causes: expired, wrong audience, or invalid signature. ` +
        `This is the server-side trust boundary — the browser pre-flight only catches ` +
        `what can be read from the JWT payload without a JWKS.`
      );
    }
    if (resp.status === 403) {
      // Read the server's JSON body — it contains the P1AZ decision, advice, and user context.
      // Surface that directly rather than a generic string so the agent/user can see why.
      let detail;
      try { detail = await resp.json(); } catch { detail = null; }
      const msg = detail
        ? `[403 Forbidden] ${detail.error ?? "Denied"} — decision: ${detail.decision ?? "unknown"}` +
          (detail.advice?.length ? ` — advice: ${JSON.stringify(detail.advice)}` : "")
        : `[403 Forbidden] Backend accepted the token identity but denied the action.`;
      throw new Error(msg);
    }

    // For the demo checkout POST there is no real server — simulate a 200
    if (method === "POST") {
      logToolEvent(`[API] No backend at ${url} — returning simulated 200 (demo mode)`, "warn");
      return null; // caller will synthesise the response
    }

    throw new Error(`API ${method} ${url} → ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

// ============================================================
// Session guard
// All tools gate on access_token — that is the credential they
// forward to APIs. The id_token is used by the app UI to display
// user identity, but it is not what tools send to resource servers.
// If there is no access_token, there is nothing a tool can forward.
// ============================================================

function requireSession() {
  if (sessionStorage.getItem("access_token")) return null; // AT present — tools can run
  return {
    error: "Session required.",
    detail: "The user must sign in before any tool can be used. " +
            "Tools forward the access_token as the Bearer credential to APIs. " +
            "The id_token establishes the UI session and carries identity claims, " +
            "but the access_token is the operative credential for agent tool calls. " +
            "No separate agent OAuth is needed — the user's existing session token is forwarded.",
  };
}

// Tool: view_products
registerTool(
  "view_products",
  {
    description: "Fetches the product catalog from the backend API. Requires an active user session.",
    parameters: {},
    annotations: { readOnlyHint: "true" },
    ui: {
      labels: [{text:"GET"}, {text:"API", cls:"tool-label-api"}],
      desc: "GET <code>/api/products.json</code> — fetches catalog from the backend.",
    },
  },
  async () => {
    const sessionError = requireSession();
    if (sessionError) return sessionError;
    const data = await apiRequest("GET", "/products.json");
    if (data?.products) {
      PRODUCTS.length = 0;
      data.products.forEach(p => PRODUCTS.push({ ...p, emoji: p.emoji || "📦" }));
      renderProducts();
    }
    return data;
  }
);

// Tool: add_to_cart
registerTool(
  "add_to_cart",
  {
    description: "Adds a product to the shopping cart by product ID and quantity.",
    parameters: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "Product ID from the catalog" },
        quantity:   { type: "integer", description: "Number of units to add", minimum: 1 },
      },
      required: ["product_id", "quantity"],
    },
    ui: {
      labels: [{text:"MUTATE", cls:"tool-label-mutate"}],
      desc: "Adds a product to the cart by product ID and quantity.",
      inputs: true,
    },
  },
  async ({ product_id, quantity }) => {
    const sessionError = requireSession();
    if (sessionError) return sessionError;
    const product = PRODUCTS.find(p => p.id === product_id);
    if (!product) {
      return { error: `Product "${product_id}" not found` };
    }
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    cart[product_id] = (cart[product_id] || 0) + qty;
    renderCart();
    return {
      success: true,
      added: { product_id, name: product.name, quantity: qty },
      cart_summary: cartSummary(),
    };
  }
);

// Tool: view_cart
registerTool(
  "view_cart",
  {
    description: "Returns the current cart contents and total as JSON. Requires an active user session.",
    parameters: {},
    annotations: { readOnlyHint: "true" },
    ui: {
      labels: [{text:"GET"}],
      desc: "Returns current cart items, item count, and total as JSON.",
    },
  },
  async () => {
    const sessionError = requireSession();
    if (sessionError) return sessionError;
    return {
      ...cartSummary(),
      item_count: Object.values(cart).reduce((n, qty) => n + qty, 0),
    };
  }
);

// Tool: remove_from_cart
registerTool(
  "remove_from_cart",
  {
    description: "Removes a product entirely from the cart by product ID.",
    parameters: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "Product ID to remove" },
      },
      required: ["product_id"],
    },
    ui: {
      labels: [{text:"MUTATE", cls:"tool-label-mutate"}],
      desc: "Removes a product from the cart by product ID.",
    },
  },
  async ({ product_id }) => {
    const sessionError = requireSession();
    if (sessionError) return sessionError;
    if (!cart[product_id]) {
      return { error: `Product "${product_id}" is not in the cart.` };
    }
    const removed = { product_id, name: PRODUCTS.find(p => p.id === product_id)?.name };
    delete cart[product_id];
    renderCart();
    return { success: true, removed, cart_summary: cartSummary() };
  }
);

// Tool: checkout
registerTool(
  "checkout",
  {
    description: "POSTs the cart to the checkout API using the user's access_token as a Bearer credential. Requires an active user session and user confirmation via elicitation before the request is sent. Returns an error if the user is not signed in or the cart is empty.",
    parameters: {},
    ui: {
      labels: [{text:"ELICIT", cls:"tool-label-confirm"}, {text:"API", cls:"tool-label-api"}, {text:"BEARER", cls:"tool-label-auth"}],
      desc: "POST <code>/api/checkout</code> — elicits confirmation, then calls the API with <code>Authorization: Bearer &lt;access_token&gt;</code>.",
    },
  },
  async (args, client) => {
    const sessionError = requireSession();
    if (sessionError) return sessionError;

    if (Object.keys(cart).length === 0) {
      return { error: "Cart is empty. Add items before checkout." };
    }

    // Kick off Protect signals collection immediately — runs in parallel
    // with the confirmation modal so getData() is ready (or timed out)
    // by the time the user clicks Confirm. No await yet.
    const signalsPromise = getProtectSignals();

    // Elicitation: surface confirmation modal via client.requestUserInteraction
    // This is the spec-defined channel for a tool to pause and await human input.
    // client is a ModelContextClient (native) or mockClient (UI calls).
    const userDecision = await (client?.requestUserInteraction
      ? client.requestUserInteraction(() => new Promise((resolve) => showCheckoutModal(resolve)))
      : new Promise((resolve) => showCheckoutModal(resolve)));

    if (userDecision.cancelled) return userDecision;

    // Await signals — should already be resolved since the modal gave it time.
    const signalsPayload = await signalsPromise;

    // User confirmed — now POST to the protected API with the Bearer token
    const requestBody = {
      order_id: userDecision.order.order_id,
      items: userDecision.order.items,
      total: userDecision.order.total,
      ...(signalsPayload && { signalsPayload }),
    };

    let apiResponse;
    try {
      apiResponse = await apiRequest("POST", "/checkout", {
        body: requestBody,
        requiresAuth: true,
      });
    } catch (err) {
      // API denied or unreachable — surface the reason in the UI and re-throw
      // so the tool console also logs it as an error.
      showOrderDenied(err.message);
      throw err;
    }

    // ── P1AZ interactive DENY: dispatch on statement code ─────────────
    // Server returns 202 { denied: true, statements: [{ code, name, payload }] }
    // when the policy wants the client to take action before retrying.
    // The statement code is the policy-author-defined contract — add a new
    // handler below for each code you want to support; no server change needed.
    if (apiResponse?.denied && apiResponse.statements?.length) {
      for (const stmt of apiResponse.statements) {
        const p = stmt.payload ?? {};

        // ── deny-stepup: MFA/OTP required ──────────────────────────
        if (stmt.code === "deny-stepup") {
          logToolEvent(`[checkout] P1AZ: deny-stepup — eliciting OTP via WebMCP Elicitation`, "info");

          const otpResult = await (client?.requestUserInteraction
            ? client.requestUserInteraction(() => new Promise(resolve => showOtpModal(p.message, resolve)))
            : new Promise(resolve => showOtpModal(p.message, resolve)));

          if (otpResult.cancelled) return otpResult;

          let mfaResponse;
          try {
            mfaResponse = await apiRequest("POST", "/checkout", {
              body: { ...requestBody, otpCode: otpResult.otpCode, deviceAuthenticationId: p.deviceAuthenticationId },
              requiresAuth: true,
            });
          } catch (err) { showOrderDenied(err.message); throw err; }

          showOrderSuccess(mfaResponse.order ?? userDecision.order);
          cart = {};
          renderCart();
          return mfaResponse;
        }

        // ── deny-verify: PingOne Verify QR step-up ─────────────────
        if (stmt.code === "deny-verify") {
          logToolEvent(`[checkout] P1AZ: deny-verify — displaying QR and polling every 4s`, "info");

          if (!p.verifyTransactionId || !p.qrUrl) {
            const message = "deny-verify statement is missing verifyTransactionId or qrUrl.";
            showOrderDenied(message);
            throw new Error(message);
          }

          const verifyResult = await (client?.requestUserInteraction
            ? client.requestUserInteraction(() => runVerifyChallenge({
                hint: p.message, qrUrl: p.qrUrl,
                webVerificationCode: p.webVerificationCode,
                requestBody: { ...requestBody, verifyTransactionId: p.verifyTransactionId },
              }))
            : runVerifyChallenge({
                hint: p.message, qrUrl: p.qrUrl,
                webVerificationCode: p.webVerificationCode,
                requestBody: { ...requestBody, verifyTransactionId: p.verifyTransactionId },
              }));

          if (verifyResult.cancelled) return verifyResult;
          if (verifyResult.error) { showOrderDenied(verifyResult.error); throw new Error(verifyResult.error); }

          showOrderSuccess(verifyResult.order ?? userDecision.order);
          cart = {};
          renderCart();
          return verifyResult;
        }

        // ── unhandled code: log and fall through ───────────────────
        logToolEvent(`[checkout] P1AZ: unhandled statement code "${stmt.code}" — no handler registered`, "warn");
      }

      // All statements were unrecognised
      const codes = apiResponse.statements.map(s => s.code).join(", ");
      const message = `Checkout denied — unhandled statement code(s): ${codes}`;
      showOrderDenied(message);
      throw new Error(message);
    }

    // apiResponse is null when no real backend is present (demo mode)
    const finalResult = apiResponse ?? {
      success: true,
      source: "demo-simulated",
      order: userDecision.order,
    };

    // Order was accepted — now update the UI
    showOrderSuccess(finalResult.order ?? userDecision.order);
    cart = {};
    renderCart();

    return finalResult;
  }
);

// ============================================================
// Cart helpers
// ============================================================

// Update the tool count badge and generate tool cards from the registry.
// This is the single source of truth — adding/removing a registerTool() call
// automatically updates both the badge and the UI card list.
document.addEventListener("DOMContentLoaded", () => {
  // Badge
  const badge = document.getElementById("tool-count-badge");
  if (badge) badge.textContent = `${Object.keys(toolRegistry).length} tools registered`;

  // Login footnote scope — driven from CONFIG, not hardcoded
  const footnote = document.getElementById("login-scope");
  if (footnote) footnote.textContent = CONFIG.PINGONE_SCOPES;

  // Tool cards
  const list = document.getElementById("tool-list");
  if (!list) return;

  list.innerHTML = Object.entries(toolRegistry).map(([name, value]) => {
    const ui = value.descriptor?.ui || {};
    const labels = (ui.labels || []).map(l =>
      `<span class="tool-label ${l.cls || ""}">${l.text}</span>`
    ).join("");
    const inputs = ui.inputs ? `
      <div class="tool-inputs">
        <label>Product ID<select id="tool-product-id"></select></label>
        <label>Qty<input id="tool-qty" type="number" value="1" min="1" max="10" /></label>
      </div>` : "";
    return `
      <div class="tool-card">
        <div class="tool-header">
          <code class="tool-name">${name}</code>
          ${labels}
        </div>
        <p class="tool-desc">${ui.desc || value.descriptor?.description || ""}</p>
        ${inputs}
        <button class="btn-tool" data-tool="${name}">Call tool</button>
      </div>`;
  }).join("");
});

function cartSummary() {
  let total = 0;
  const items = Object.entries(cart).map(([id, qty]) => {
    const p = PRODUCTS.find(x => x.id === id);
    total += p.price * qty;
    return { product_id: id, name: p.name, quantity: qty, unit_price: p.price, line_total: +(p.price * qty).toFixed(2) };
  });
  return { items, total: +total.toFixed(2) };
}

function renderCart() {
  const list = document.getElementById("cart-list");
  const footer = document.getElementById("cart-footer");
  const badge = document.getElementById("cart-count");
  const total = document.getElementById("cart-total");

  const summary = cartSummary();
  const itemCount = summary.items.reduce((n, i) => n + i.quantity, 0);

  badge.textContent = itemCount;

  if (summary.items.length === 0) {
    list.innerHTML = '<p class="cart-empty">Your cart is empty.</p>';
    footer.classList.add("hidden");
    return;
  }

  list.innerHTML = summary.items.map(item => `
    <div class="cart-item">
      <span class="cart-item-name">${item.name}</span>
      <span class="cart-item-qty">x${item.quantity}</span>
      <span class="cart-item-price">$${item.line_total.toFixed(2)}</span>
      <button class="cart-remove" data-id="${item.product_id}" title="Remove">✕</button>
    </div>
  `).join("");

  total.textContent = `$${summary.total.toFixed(2)}`;
  footer.classList.remove("hidden");

  // Remove buttons — routed through the tool so the action is logged
  // and consistent with agent-initiated removals.
  list.querySelectorAll(".cart-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      invokeTool("remove_from_cart", { product_id: btn.dataset.id });
    });
  });
}

// ============================================================
// Checkout modal (elicitation)
// ============================================================

function showCheckoutModal(resolvePromise) {
  const modal = document.getElementById("modal-checkout");
  const summary = cartSummary();
  const summaryEl = document.getElementById("modal-summary");

  const lines = summary.items.map(i =>
    `${i.quantity}× ${i.name} — $${i.line_total.toFixed(2)}`
  ).join("\n");

  summaryEl.textContent = `${lines}\n\nTotal: $${summary.total.toFixed(2)}`;
  modal.classList.remove("hidden");

  const confirm = document.getElementById("modal-confirm");
  const cancel  = document.getElementById("modal-cancel");

  function cleanup() {
    modal.classList.add("hidden");
    confirm.replaceWith(confirm.cloneNode(true));
    cancel.replaceWith(cancel.cloneNode(true));
  }

  document.getElementById("modal-confirm").addEventListener("click", () => {
    cleanup();
    // Do NOT show success here — wait for the API response first.
    // Success/failure UI is rendered by the checkout tool after the POST returns.
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    const result = { order: { ...cartSummary(), order_id: `ORD-${Date.now()}-${rand}` } };
    resolvePromise(result);
  }, { once: true });

  document.getElementById("modal-cancel").addEventListener("click", () => {
    cleanup();
    resolvePromise({ cancelled: true, reason: "User declined checkout via elicitation" });
  }, { once: true });
}

function showOrderSuccess(order) {
  document.getElementById("order-denied")?.classList.add("hidden");
  const el = document.getElementById("order-success");
  const detail = document.getElementById("order-detail");
  detail.textContent = `Order ${order.order_id} placed — Total: $${order.total.toFixed(2)}`;
  el.classList.remove("hidden");
}

function showOrderDenied(reason) {
  document.getElementById("order-success")?.classList.add("hidden");
  const el = document.getElementById("order-denied");
  if (!el) return;
  const detail = document.getElementById("order-denied-detail");
  if (detail) detail.textContent = reason;
  el.classList.remove("hidden");
}

// OTP elicitation modal
// Shown when P1AZ returns DENY + MFA_CHALLENGE advice.
// Collects the one-time code so the checkout tool can re-POST for verification.
function showOtpModal(hint, resolvePromise) {
  const modal  = document.getElementById("modal-otp");
  const hintEl = document.getElementById("otp-hint");
  const input  = document.getElementById("otp-input");

  if (hintEl) hintEl.textContent = hint ?? "Enter the OTP sent to your registered email.";
  if (input)  input.value = "";
  modal.classList.remove("hidden");
  // Focus after the repaint so the field is visible
  requestAnimationFrame(() => input?.focus());

  const submit = document.getElementById("otp-submit");
  const cancel = document.getElementById("otp-cancel");

  function cleanup() {
    modal.classList.add("hidden");
    document.getElementById("otp-submit").replaceWith(submit.cloneNode(true));
    document.getElementById("otp-cancel").replaceWith(cancel.cloneNode(true));
  }

  function trySubmit() {
    const code = document.getElementById("otp-input").value.trim();
    if (!code) return;
    cleanup();
    resolvePromise({ otpCode: code });
  }

  document.getElementById("otp-submit").addEventListener("click", trySubmit, { once: true });
  document.getElementById("otp-cancel").addEventListener("click", () => {
    cleanup();
    resolvePromise({ cancelled: true, reason: "User cancelled OTP entry" });
  }, { once: true });
  // Also submit on Enter
  input?.addEventListener("keydown", function onKey(e) {
    if (e.key === "Enter") { input.removeEventListener("keydown", onKey); trySubmit(); }
  });
}

document.addEventListener("click", (e) => {
  if (e.target.id === "btn-continue") {
    document.getElementById("order-success").classList.add("hidden");
  }
  if (e.target.id === "btn-continue-denied") {
    document.getElementById("order-denied").classList.add("hidden");
  }
});

// ============================================================
// Tool console (simulate agent calls from UI)
// ============================================================

function logToolEvent(message, level = "info") {
  const log = document.getElementById("tool-log");
  if (!log) return;
  const entry = document.createElement("div");
  entry.className = `log-entry log-${level}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function logToolCall(name, args, result) {
  const log = document.getElementById("tool-log");
  if (!log) return;

  // Call line
  const callEl = document.createElement("div");
  callEl.className = "log-entry log-call";
  callEl.textContent = `→ ${name}(${args ? JSON.stringify(args) : ""})`;
  log.appendChild(callEl);

  // Result line
  const resEl = document.createElement("div");
  resEl.className = "log-entry log-result";
  resEl.textContent = `← ${JSON.stringify(result, null, 2)}`;
  log.appendChild(resEl);

  log.scrollTop = log.scrollHeight;
}

function stringifyForLog(data) {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function sanitizeRequestForLog(rawRequest) {
  if (!rawRequest || typeof rawRequest !== "object") return rawRequest;
  if (!("__shopMcpMeta" in rawRequest)) return rawRequest;

  const copy = { ...rawRequest };
  delete copy.__shopMcpMeta;
  return copy;
}

// Per spec, execute(input, client) receives input directly.
// UI-triggered calls wrap args in { __shopMcpMeta, arguments } so we
// can distinguish the two call paths for logging.
function normalizeToolInvocation(rawRequest) {
  const request = rawRequest ?? {};
  const isUiCall = request?.__shopMcpMeta?.source === "ui";
  const source = isUiCall ? "ui" : "navigator.modelContext";
  const args = isUiCall ? (request.arguments ?? {}) : request;
  const requestForLog = sanitizeRequestForLog(request);
  return { source, args, requestForLog };
}

// execute(input, client) — spec-compliant two-arg signature.
// client is a ModelContextClient (native) or our mockClient (UI calls).
// Return value is wrapped in { content: [{ type: "text", text }] } per spec.
function createInstrumentedToolHandler(name, handler) {
  return async (rawRequest = {}, client) => {
    const { source, args, requestForLog } = normalizeToolInvocation(rawRequest);
    const started = Date.now();

    logToolEvent(
      `→ [${source}] ${name} request: ${stringifyForLog(requestForLog)}`,
      "call"
    );

    if (requestForLog !== args) {
      logToolEvent(
        `→ [${source}] ${name} args: ${stringifyForLog(args)}`,
        "call"
      );
    }

    try {
      const result = await handler(args, client);
      logToolEvent(
        `← [${source}] ${name} response (${Date.now() - started}ms): ${stringifyForLog(result)}`,
        "result"
      );
      // Spec-compliant return: { content: [{ type: "text", text: "..." }] }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err?.message || String(err);
      logToolEvent(`← [${source}] ${name} error: ${message}`, "error");
      // Return errors as structured content rather than throwing.
      // An agent can read and reason about { error } in content;
      // a raw exception gives it nothing useful to work with.
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  };
}

async function invokeTool(name, args = {}) {
  const tool = toolRegistry[name];
  if (!tool) {
    logToolEvent(`Unknown tool: ${name}`, "error");
    return;
  }

  // Mock ModelContextClient for UI-triggered calls.
  // requestUserInteraction invokes the callback immediately (modal is already in-page).
  const mockClient = {
    requestUserInteraction: async (callback) => callback(),
  };

  try {
    await tool.handler(
      { __shopMcpMeta: { source: "ui" }, arguments: args },
      mockClient
    );
  } catch (err) {
    logToolEvent(`Tool error: ${err.message}`, "error");
  }
}

// Wire up tool buttons
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-tool]");
  if (!btn) return;

  const toolName = btn.dataset.tool;

  if (toolName === "add_to_cart") {
    const id  = document.getElementById("tool-product-id").value;
    const qty = parseInt(document.getElementById("tool-qty").value, 10) || 1;
    await invokeTool("add_to_cart", { product_id: id, quantity: qty });
  } else {
    await invokeTool(toolName);
  }
});

// ============================================================
// Token inspector
// ============================================================

function renderTokenInspector(idClaims, idRaw, atClaims, atRaw) {
  // Access token — the operative credential for tools and APIs
  const atAud      = atClaims?.aud ? [].concat(atClaims.aud).join(", ") : "(not present)";
  const atClientId = atClaims?.client_id || atClaims?.azp || "(not present)";
  document.getElementById("token-at-aud").textContent      = atAud;
  document.getElementById("token-at-client-id").textContent = atClientId;

  // Helper: render a sorted claims object into a table element
  function buildClaimsTable(claims, tableId, highlightKeys) {
    const table = document.getElementById(tableId);
    if (!claims || !table) return;

    const priority = ["iss", "sub", "aud", "client_id", "azp", "iat", "exp", "scope", "nonce", "name", "email", "given_name", "family_name"];
    const sorted = [
      ...priority.filter(k => k in claims),
      ...Object.keys(claims).filter(k => !priority.includes(k)),
    ];

    table.innerHTML = sorted.map(key => {
      const val = claims[key];
      const isHighlighted = highlightKeys.includes(key);
      const displayVal = typeof val === "object" ? JSON.stringify(val) : String(val);

      let formatted = displayVal;
      if ((key === "iat" || key === "exp" || key === "auth_time") && typeof val === "number") {
        const d = new Date(val * 1000);
        formatted = `${displayVal} (${d.toLocaleString()})`;
      }

      return `
        <div class="claim-row ${isHighlighted ? "claim-row-highlight" : ""}">
          <span class="claim-key">${key}</span>
          <span class="claim-value ${isHighlighted ? "claim-value-highlight" : ""}">${formatted}</span>
        </div>
      `;
    }).join("");
  }

  // AT: highlight aud (RS target) and client_id (agent signal)
  buildClaimsTable(atClaims, "at-claims-table", ["aud", "client_id", "azp", "scope"]);
  // IT: highlight sub (user identity) and aud/client_id
  buildClaimsTable(idClaims, "it-claims-table", ["sub", "aud", "client_id"]);

  // Wire tab switching
  document.querySelectorAll(".token-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".token-tab").forEach(b => b.classList.remove("token-tab-active"));
      btn.classList.add("token-tab-active");
      document.getElementById("tab-at").classList.toggle("hidden", tab !== "at");
      document.getElementById("tab-it").classList.toggle("hidden", tab !== "it");
    });
  });
}

// ============================================================
// Product grid + select
// ============================================================

function renderProducts() {
  const grid = document.getElementById("product-grid");
  grid.innerHTML = PRODUCTS.map(p => `
    <div class="product-card">
      <div class="product-emoji">${p.emoji}</div>
      <div class="product-info">
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.description}</div>
        <div class="product-price">$${p.price.toFixed(2)}</div>
      </div>
      <button class="btn-add-to-cart" data-product-id="${p.id}">
        Add to cart
      </button>
    </div>
  `).join("");

  // Quick-add buttons
  grid.querySelectorAll(".btn-add-to-cart").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.productId;
      const mockClient = { requestUserInteraction: async (cb) => cb() };
      await toolRegistry["add_to_cart"].handler(
        { __shopMcpMeta: { source: "ui" }, arguments: { product_id: id, quantity: 1 } },
        mockClient
      );
      btn.textContent = "Added ✓";
      setTimeout(() => { btn.textContent = "Add to cart"; }, 1200);
    });
  });

  // Populate the tool console select
  const sel = document.getElementById("tool-product-id");
  sel.innerHTML = PRODUCTS.map(p =>
    `<option value="${p.id}">${p.name} ($${p.price.toFixed(2)})</option>`
  ).join("");
}

// ============================================================
// Checkout button (direct, not via tool)
// ============================================================

document.addEventListener("click", async (e) => {
  if (e.target.id === "btn-checkout") {
    await invokeTool("checkout");
  }
});

// ============================================================
// View management
// ============================================================

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
}

// ============================================================
// Auth flow
// ============================================================

document.getElementById("btn-login").addEventListener("click", startLogin);

// Tools pane toggle
(function () {
  const btn = document.getElementById("btn-toggle-inspector");
  const layout = document.querySelector(".app-layout");
  const aside  = document.querySelector(".inspector-column");
  const hidden = sessionStorage.getItem("inspector_hidden") === "1";

  function applyState(isHidden) {
    layout.classList.toggle("inspector-hidden", isHidden);
    aside.classList.toggle("inspector-hidden", isHidden);
    btn.textContent = isHidden ? "Show Tools" : "Hide Tools";
    sessionStorage.setItem("inspector_hidden", isHidden ? "1" : "0");
  }

  applyState(hidden); // restore last state
  btn.addEventListener("click", () => {
    applyState(!layout.classList.contains("inspector-hidden"));
  });
}());

document.getElementById("btn-logout").addEventListener("click", () => {
  const apiBase = sessionStorage.getItem("apiBase"); // preserve across logout if set
  sessionStorage.clear();
  if (apiBase) sessionStorage.setItem("apiBase", apiBase);
  idTokenClaims = null;
  idTokenRaw = null;
  cart = {};

  // PingOne end_session (best-effort, then redirect to login)
  const endSession = `${CONFIG.PINGONE_AS_BASE}/signoff?post_logout_redirect_uri=${encodeURIComponent(CONFIG.PINGONE_REDIRECT_URI)}`;
  window.location.href = endSession;
});

async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code  = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  if (error) {
    // login_required / interaction_required mean the AS session is also gone.
    // Any other error is unexpected — log it either way.
    const wasSilent = sessionStorage.getItem("silent_refresh");
    sessionStorage.removeItem("silent_refresh");
    if (wasSilent && (error === "login_required" || error === "interaction_required")) {
      // Silent refresh failed — AS cookie is gone too. Show the login screen.
      sessionStorage.clear();
      showView("login");
    } else {
      logToolEvent(`Auth error: ${error} — ${params.get("error_description")}`, "error");
      showView("login");
    }
    return true;
  }

  if (!code) return false; // not a callback

  // Validate state
  const storedState = sessionStorage.getItem("oauth_state");
  if (state !== storedState) {
    console.warn("State mismatch — possible CSRF");
    showView("login");
    return true;
  }

  // Clean URL
  window.history.replaceState({}, document.title, window.location.pathname);

  try {
    const tokens = await exchangeCode(code);
    idTokenRaw = tokens.id_token;
    idTokenClaims = parseJwt(idTokenRaw);

    sessionStorage.setItem("id_token", idTokenRaw);
    sessionStorage.setItem("access_token", tokens.access_token || "");
    sessionStorage.removeItem("silent_refresh"); // clear flag whether login was silent or interactive

    mountApp();
  } catch (err) {
    console.error("Token exchange failed:", err);
    const errMsg = document.createElement("p");
    errMsg.style.cssText = "color:red;text-align:center;padding:1rem";
    errMsg.textContent = `Login failed: ${err.message}`;
    document.getElementById("view-login").querySelector(".login-card").appendChild(errMsg);
    showView("login");
  }

  return true;
}

async function mountApp() {
  // Use the tool to load products — same code path as an agent call.
  // This means the API fetch, logging, and error handling are unified
  // whether the caller is the webapp itself or an MCP agent.
  await invokeTool("view_products");
  renderCart();

  const name = idTokenClaims?.name || idTokenClaims?.preferred_username || idTokenClaims?.email || idTokenClaims?.sub || "User";
  document.getElementById("nav-username").textContent = name;

  renderTokenInspector(
    idTokenClaims,
    idTokenRaw,
    parseJwt(sessionStorage.getItem("access_token")),
    sessionStorage.getItem("access_token")
  );

  showView("app");

  logToolEvent(`Session established for ${name}`);
  logToolEvent(`client_id: ${CONFIG.PINGONE_CLIENT_ID} — agent identity signal present in token`);

  // Initialise PingOne Protect — non-blocking; fires and forgets.
  // SDK will be ready well before the first checkout is triggered.
  initProtectSDK();
}

// ============================================================
// Boot
// ============================================================

async function boot() {
  ensureModelContextShim();

  // Some browser extensions inject modelContext after page scripts run.
  // Retry registration briefly so tools are discoverable in MCP explorers.
  let attempts = 0;
  const registrationTimer = setInterval(() => {
    registerToolsWithNativeModelContext();
    attempts += 1;
    if (attempts >= 20 || Object.keys(toolRegistry).every(name => nativeRegisteredTools.has(name))) {
      clearInterval(registrationTimer);
    }
  }, 500);

  // Check if we're returning from an OIDC redirect
  const isCallback = await handleCallback();
  if (isCallback) return;

  // Check for existing session in sessionStorage.
  // The access_token is the operative credential for tools — check its expiry.
  // The id_token is still loaded for UI display (name, token inspector).
  const storedIdToken = sessionStorage.getItem("id_token");
  const storedAccessToken = sessionStorage.getItem("access_token");

  if (storedIdToken) {
    idTokenRaw = storedIdToken;
    idTokenClaims = parseJwt(storedIdToken);
  }

  if (storedAccessToken) {
    const atClaims = parseJwt(storedAccessToken);

    // access_token expired — but the IdP session cookie may still be valid
    // (it's longer-lived than the JWT). Try a silent token refresh first.
    // If the IdP cookie is also gone, the AS returns login_required and
    // handleCallback will fall back to the interactive login screen.
    if (atClaims?.exp && atClaims.exp * 1000 < Date.now()) {
      sessionStorage.clear();
      await startSilentLogin();
      return;
    }

    mountApp();
    return;
  }

  showView("login");
}

boot();
