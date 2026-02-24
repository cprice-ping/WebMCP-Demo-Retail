// ============================================================
// ShopMCP — WebMCP Retail Demo
// Demonstrates: session + client_id as sufficient agent identity
// ============================================================

"use strict";

// ------------------------------------------------------------
// Product catalog (in-memory, immutable)
// ------------------------------------------------------------
const PRODUCTS = [
  { id: "p1", name: "Wireless Headphones",    price: 79.99,  emoji: "🎧", description: "Noise-cancelling, 30hr battery" },
  { id: "p2", name: "Mechanical Keyboard",     price: 129.99, emoji: "⌨️", description: "Tactile switches, USB-C" },
  { id: "p3", name: "USB-C Hub",               price: 34.99,  emoji: "🔌", description: "7-in-1, 4K HDMI, 100W PD" },
  { id: "p4", name: "Webcam HD 1080p",         price: 59.99,  emoji: "📷", description: "Auto-focus, built-in mic" },
  { id: "p5", name: "Desk LED Lamp",           price: 24.99,  emoji: "💡", description: "Adjustable color temp" },
  { id: "p6", name: "Laptop Stand",            price: 39.99,  emoji: "💻", description: "Aluminium, foldable" },
];

// ------------------------------------------------------------
// In-memory cart state
// ------------------------------------------------------------
let cart = {}; // { productId: quantity }

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
    const candidates = [
      () => navigator.modelContext.registerTool({
        name,
        description: value.descriptor?.description || "",
        inputSchema,
        handler: value.handler,
      }),
      () => navigator.modelContext.registerTool({
        name,
        description: value.descriptor?.description || "",
        parameters: inputSchema,
        handler: value.handler,
      }),
      () => navigator.modelContext.registerTool({
        name,
        description: value.descriptor?.description || "",
        schema: inputSchema,
        execute: value.handler,
      }),
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

// Tool: view_products
registerTool(
  "view_products",
  {
    description: "Returns the full product catalog with IDs, names, prices, and descriptions.",
    parameters: {},
  },
  async () => {
    return {
      products: PRODUCTS.map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        description: p.description,
      })),
    };
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
  },
  async ({ product_id, quantity }) => {
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

// Tool: checkout
registerTool(
  "checkout",
  {
    description: "Initiates checkout for the current cart. Requires user confirmation via elicitation before the purchase is completed.",
    parameters: {},
  },
  async () => {
    if (Object.keys(cart).length === 0) {
      return { error: "Cart is empty. Add items before checkout." };
    }
    // Elicitation: surface confirmation modal, wait for user
    return new Promise((resolve) => {
      showCheckoutModal(resolve);
    });
  }
);

// ============================================================
// Cart helpers
// ============================================================

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

  // Remove buttons
  list.querySelectorAll(".cart-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      delete cart[btn.dataset.id];
      renderCart();
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
    const result = { success: true, order: { ...cartSummary(), order_id: "ORD-" + Date.now() } };
    showOrderSuccess(result.order);
    cart = {};
    renderCart();
    resolvePromise(result);
  }, { once: true });

  document.getElementById("modal-cancel").addEventListener("click", () => {
    cleanup();
    resolvePromise({ cancelled: true, reason: "User declined checkout via elicitation" });
  }, { once: true });
}

function showOrderSuccess(order) {
  const el = document.getElementById("order-success");
  const detail = document.getElementById("order-detail");
  detail.textContent = `Order ${order.order_id} placed — Total: $${order.total.toFixed(2)}`;
  el.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (e.target.id === "btn-continue") {
    document.getElementById("order-success").classList.add("hidden");
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

function normalizeToolInvocation(rawRequest) {
  const request = rawRequest ?? {};
  const source = request?.__shopMcpMeta?.source || "navigator.modelContext";

  if (request && typeof request === "object") {
    if (request.arguments && typeof request.arguments === "object") {
      return { source, args: request.arguments, requestForLog: sanitizeRequestForLog(request) };
    }
    if (request.params && typeof request.params === "object") {
      return { source, args: request.params, requestForLog: sanitizeRequestForLog(request) };
    }
    if (request.input && typeof request.input === "object") {
      return { source, args: request.input, requestForLog: sanitizeRequestForLog(request) };
    }
  }

  return { source, args: request, requestForLog: sanitizeRequestForLog(request) };
}

function createInstrumentedToolHandler(name, handler) {
  return async (rawRequest = {}) => {
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
      const result = await handler(args);
      logToolEvent(
        `← [${source}] ${name} response (${Date.now() - started}ms): ${stringifyForLog(result)}`,
        "result"
      );
      return result;
    } catch (err) {
      const message = err?.message || String(err);
      logToolEvent(`← [${source}] ${name} error: ${message}`, "error");
      throw err;
    }
  };
}

async function invokeTool(name, args = {}) {
  const tool = toolRegistry[name];
  if (!tool) {
    logToolEvent(`Unknown tool: ${name}`, "error");
    return;
  }
  try {
    await tool.handler({
      __shopMcpMeta: { source: "ui" },
      arguments: args,
    });
  } catch (err) {
    logToolEvent(`Tool error: ${err.message}`, "error");
  }
}

// Wire up tool buttons
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-tool]");
  if (!btn) return;

  const toolName = btn.dataset.tool;

  if (toolName === "view_products") {
    await invokeTool("view_products");
  } else if (toolName === "add_to_cart") {
    const id  = document.getElementById("tool-product-id").value;
    const qty = parseInt(document.getElementById("tool-qty").value, 10) || 1;
    await invokeTool("add_to_cart", { product_id: id, quantity: qty });
  } else if (toolName === "checkout") {
    await invokeTool("checkout");
  }
});

// ============================================================
// Token inspector
// ============================================================

function renderTokenInspector(claims, rawToken) {
  // Highlight the client_id
  const clientId = claims.aud || claims.client_id || CONFIG.PINGONE_CLIENT_ID;
  const displayClientId = Array.isArray(clientId) ? clientId.join(", ") : String(clientId);
  document.getElementById("token-client-id").textContent = displayClientId;

  // Claims table
  const table = document.getElementById("claims-table");

  // Priority claims to show first and highlight
  const priority = ["iss", "sub", "aud", "client_id", "iat", "exp", "nonce", "name", "email", "given_name", "family_name"];

  const sorted = [
    ...priority.filter(k => k in claims),
    ...Object.keys(claims).filter(k => !priority.includes(k)),
  ];

  table.innerHTML = sorted.map(key => {
    const val = claims[key];
    const isHighlighted = key === "aud" || key === "client_id";
    const displayVal = typeof val === "object" ? JSON.stringify(val) : String(val);

    // Format timestamps
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
      await toolRegistry["add_to_cart"].handler({
        __shopMcpMeta: { source: "ui" },
        arguments: { product_id: id, quantity: 1 },
      });
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

document.getElementById("btn-logout").addEventListener("click", () => {
  sessionStorage.clear();
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
    logToolEvent(`Auth error: ${error} — ${params.get("error_description")}`, "error");
    showView("login");
    return;
  }

  if (!code) return false; // not a callback

  // Validate state
  const storedState = sessionStorage.getItem("oauth_state");
  if (state !== storedState) {
    console.warn("State mismatch — possible CSRF");
    showView("login");
    return;
  }

  // Clean URL
  window.history.replaceState({}, document.title, window.location.pathname);

  try {
    const tokens = await exchangeCode(code);
    idTokenRaw = tokens.id_token;
    idTokenClaims = parseJwt(idTokenRaw);

    sessionStorage.setItem("id_token", idTokenRaw);
    sessionStorage.setItem("access_token", tokens.access_token || "");

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

function mountApp() {
  renderProducts();
  renderCart();

  const name = idTokenClaims?.name || idTokenClaims?.email || idTokenClaims?.sub || "User";
  document.getElementById("nav-username").textContent = name;

  renderTokenInspector(idTokenClaims, idTokenRaw);

  showView("app");

  logToolEvent(`Session established for ${name}`);
  logToolEvent(`client_id: ${CONFIG.PINGONE_CLIENT_ID} — agent identity signal present in token`);
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

  // Check for existing session in sessionStorage
  const storedToken = sessionStorage.getItem("id_token");
  if (storedToken) {
    idTokenRaw = storedToken;
    idTokenClaims = parseJwt(storedToken);

    // Basic expiry check
    if (idTokenClaims?.exp && idTokenClaims.exp * 1000 < Date.now()) {
      sessionStorage.clear();
      showView("login");
      return;
    }

    mountApp();
    return;
  }

  showView("login");
}

boot();
