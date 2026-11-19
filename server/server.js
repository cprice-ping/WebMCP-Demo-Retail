// ============================================================
// ShopMCP API Server
// Runs identically under Docker locally and in k8s.
// The only difference between environments is env vars.
//   Local dev:  docker-compose (reads .env)
//   k8s:        Deployment env sourced from a Secret
// ============================================================

import express from "express";
import cors from "cors";
import productsRouter from "./routes/products.js";
import checkoutRouter from "./routes/checkout.js";
import authRouter from "./routes/auth.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ALLOWED_ORIGIN: the GitHub Pages URL in production,
//                 http://localhost:8080 (or similar) for local frontend dev.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || "http://localhost:8080")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (curl, health checks)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// ── Routes ──────────────────────────────────────────────────
// Mount at both /api/products and /api/products.json — the browser app
// calls GET {SHOP_API_BASE}/products.json which matches the static file path
// on GitHub Pages; the Node server must honour the same URL.
app.use("/api/products", productsRouter);
app.use("/api/products.json", productsRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/auth", authRouter);

// Health / readiness probe (used by k8s liveness/readiness)
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ShopMCP API listening on :${PORT}`);
  console.log(`  ALLOWED_ORIGIN: ${allowedOrigins.join(", ")}`);
  console.log(`  PingOne env:    ${process.env.PINGONE_ENVIRONMENT_ID ?? "(not set)"}`);
  console.log(`  AZ enabled:     ${process.env.AZ_DECISION_ENDPOINT_ID ? "yes" : "no — checkout will auto-PERMIT"}`);
});
