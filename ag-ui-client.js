// ============================================================
// ag-ui-client.js — AG-UI WebSocket client for WebMCP sites
// ------------------------------------------------------------
// Connects the browser tab outbound to a Custom Agent's WS endpoint.
// The browser is the AG-UI *frontend*; the agent is the AG-UI *backend*.
//
// Exposes 5 globals:
//   connectToAgent(wsUrl, siteLabel, getManifestFn, invokeToolFn, onTextMessage)
//   disconnectAgent()
//   notifyToolsUpdate()
//   getAgentConnectionState()  → "connected" | "connecting" | "disconnected"
//   sendToAgent(data)          → true if sent, false if not connected
//
// Protocol (Browser → Agent):
//   { type: "SITE_CONNECT",  origin, siteLabel, tools: [...] }
//   { type: "TOOL_RESULT",   toolCallId, content: "<json string>" }
//   { type: "TOOLS_UPDATE",  tools: [...] }
//   { type: "USER_MESSAGE",  message: "<text>" }
//
// Protocol (Agent → Browser):
//   { type: "TOOL_CALL",        toolCallId, name, arguments: "<json string>" }
//   { type: "TEXT_MESSAGE",     messageId, delta }
//   { type: "TEXT_MESSAGE_END", messageId }
// ============================================================

"use strict";

(function () {
  // ── State ──────────────────────────────────────────────────
  let _ws              = null;
  let _wsUrl           = null;
  let _siteLabel       = null;
  let _getManifest     = null;
  let _invokeTool      = null;  // async (toolCallId, name, argsString) => contentString
  let _onText          = null;  // (delta, messageId, done) => void

  let _reconnectAttempts = 0;
  const MAX_RECONNECT    = 3;
  const RECONNECT_MS     = 3000;
  let _reconnectTimer    = null;

  // ── Status badge helper ────────────────────────────────────
  function _updateStatus(state) {
    const badge = document.getElementById("agent-status-badge");
    if (badge) {
      if (state === "connected") {
        badge.textContent = "● Connected";
        badge.className   = "agent-status agent-status-connected";
      } else if (state === "connecting") {
        badge.textContent = "◌ Connecting…";
        badge.className   = "agent-status agent-status-connecting";
      } else {
        badge.textContent = "○ Disconnected";
        badge.className   = "agent-status agent-status-disconnected";
      }
    }
    const btn = document.getElementById("btn-agent-connect");
    if (btn) btn.textContent = (state === "connected") ? "Disconnect" : "Connect";
  }

  // ── Internal connect ──────────────────────────────────────
  function _connect() {
    if (!_wsUrl) return;
    _updateStatus("connecting");

    const ws = new WebSocket(_wsUrl);
    _ws = ws;

    ws.addEventListener("open", () => {
      _reconnectAttempts = 0;
      _updateStatus("connected");
      ws.send(JSON.stringify({
        type:      "SITE_CONNECT",
        origin:    location.origin,
        siteLabel: _siteLabel,
        tools:     _getManifest ? _getManifest() : [],
      }));
    });

    ws.addEventListener("message", async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === "TOOL_CALL") {
        let content;
        try {
          content = await _invokeTool(msg.toolCallId, msg.name, msg.arguments ?? "{}");
        } catch (err) {
          content = JSON.stringify({ error: err?.message || String(err) });
        }
        if (_ws && _ws.readyState === WebSocket.OPEN) {
          _ws.send(JSON.stringify({ type: "TOOL_RESULT", toolCallId: msg.toolCallId, content }));
        }
        return;
      }

      if (msg.type === "TEXT_MESSAGE" && _onText) {
        _onText(msg.delta ?? "", msg.messageId, false);
        return;
      }

      if (msg.type === "TEXT_MESSAGE_END" && _onText) {
        _onText("", msg.messageId, true);
        return;
      }
    });

    ws.addEventListener("close", () => {
      _ws = null;
      _updateStatus("disconnected");
      if (_reconnectAttempts < MAX_RECONNECT) {
        _reconnectAttempts++;
        _reconnectTimer = setTimeout(_connect, RECONNECT_MS);
      }
    });

    // Error fires before close — no separate action needed; close handles it.
    ws.addEventListener("error", () => { /* handled by close */ });
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Connect to a Custom Agent's WebSocket endpoint.
   *
   * @param {string}   wsUrl        wss:// endpoint
   * @param {string}   siteLabel    stable identifier for this site (e.g. "accessories")
   * @param {Function} getManifestFn  () => [{name, description, parameters}]
   * @param {Function} invokeToolFn   async (toolCallId, name, argsString) => contentString
   * @param {Function} onTextMessage  (delta, messageId, done) => void
   */
  window.connectToAgent = function (wsUrl, siteLabel, getManifestFn, invokeToolFn, onTextMessage) {
    // Tear down any existing connection without triggering auto-reconnect
    _reconnectAttempts = MAX_RECONNECT;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_ws) { _ws.close(); _ws = null; }

    _wsUrl         = wsUrl;
    _siteLabel     = siteLabel;
    _getManifest   = getManifestFn;
    _invokeTool    = invokeToolFn;
    _onText        = onTextMessage;
    _reconnectAttempts = 0;

    _connect();
  };

  /** Close the connection and disable auto-reconnect. */
  window.disconnectAgent = function () {
    _reconnectAttempts = MAX_RECONNECT;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_ws) { _ws.close(); _ws = null; }
    _updateStatus("disconnected");
  };

  /**
   * Send a TOOLS_UPDATE message to the agent with the current tool manifest.
   * No-op if not connected.
   */
  window.notifyToolsUpdate = function () {
    if (!_ws || _ws.readyState !== WebSocket.OPEN || !_getManifest) return;
    _ws.send(JSON.stringify({ type: "TOOLS_UPDATE", tools: _getManifest() }));
  };

  /** Returns "connected" | "connecting" | "disconnected" */
  window.getAgentConnectionState = function () {
    if (!_ws) return "disconnected";
    if (_ws.readyState === WebSocket.OPEN)       return "connected";
    if (_ws.readyState === WebSocket.CONNECTING) return "connecting";
    return "disconnected";
  };

  /**
   * Send an arbitrary message to the agent over the open WS.
   * Returns true if sent, false if the socket is not open.
   */
  window.sendToAgent = function (data) {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return false;
    _ws.send(JSON.stringify(data));
    return true;
  };
}());
