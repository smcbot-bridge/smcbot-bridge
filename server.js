/**
 * SMCBot VPS Bridge Server
 * ─────────────────────────────────────────────
 * Bridges MT5 EA (TCP) ←→ PWA clients (WebSocket)
 * 
 * Ports:
 *   8080  → WebSocket  (PWA connects here)
 *   5555  → TCP Socket (MT5 EA connects here)
 *   3000  → HTTP status page
 */

const net            = require('net');
const http           = require('http');
const { WebSocketServer } = require('ws');

// ── CONFIG ──────────────────────────────────────────────
const WS_PORT   = 8080;   // PWA WebSocket port
const MT5_PORT  = 5555;   // MT5 EA TCP port
const HTTP_PORT = 3000;   // Status page port
const PING_INTERVAL = 20000; // 20s heartbeat

// ── STATE ────────────────────────────────────────────────
let mt5Socket    = null;   // single MT5 EA connection
let mt5Connected = false;
let mt5Buffer    = '';
const pwaClients = new Set();  // all connected PWA browsers

const stats = {
  startTime     : Date.now(),
  mt5Connects   : 0,
  pwaConnects   : 0,
  messagesIn    : 0,
  messagesOut   : 0,
  lastTick      : null,
  lastSignal    : null,
};

// ── HELPERS ──────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function broadcast(pwaClients, data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  for (const ws of pwaClients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(json);
      stats.messagesOut++;
    }
  }
}

function sendToMT5(obj) {
  if (!mt5Socket || !mt5Connected) {
    log('WARN', 'Cannot send to MT5 — not connected');
    return false;
  }
  const line = JSON.stringify(obj) + '\n';
  mt5Socket.write(line);
  stats.messagesIn++;
  return true;
}

function uptime() {
  const s = Math.floor((Date.now() - stats.startTime) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}

// ── MT5 TCP SERVER ────────────────────────────────────────
const mt5Server = net.createServer(socket => {
  // Only allow one MT5 connection at a time
  if (mt5Socket) {
    log('MT5', 'Second EA tried to connect — rejecting');
    socket.destroy();
    return;
  }

  mt5Socket    = socket;
  mt5Connected = true;
  stats.mt5Connects++;
  log('MT5', `EA connected from ${socket.remoteAddress}`);

  // Tell all PWA clients MT5 is up
  broadcast(pwaClients, { type: 'mt5_status', connected: true });

  socket.setEncoding('utf8');
  socket.setKeepAlive(true, 10000);

  // MT5 sends newline-delimited JSON
  socket.on('data', chunk => {
    mt5Buffer += chunk;
    const lines = mt5Buffer.split('\n');
    mt5Buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (e) {
        log('MT5', `Bad JSON: ${trimmed.slice(0, 80)}`);
        continue;
      }

      stats.messagesIn++;

      // Tag with server timestamp
      msg._ts = Date.now();

      // Track last tick / signal for status page
      if (msg.type === 'tick')   stats.lastTick   = msg;
      if (msg.type === 'signal') stats.lastSignal = msg;

      log('MT5', `→ PWA  type=${msg.type} sym=${msg.symbol || ''}`);

      // Forward everything to all PWA clients
      broadcast(pwaClients, msg);
    }
  });

  socket.on('close', () => {
    log('MT5', 'EA disconnected');
    mt5Socket    = null;
    mt5Connected = false;
    mt5Buffer    = '';
    broadcast(pwaClients, { type: 'mt5_status', connected: false });
  });

  socket.on('error', err => {
    log('MT5', `Socket error: ${err.message}`);
    mt5Socket    = null;
    mt5Connected = false;
  });
});

mt5Server.listen(MT5_PORT, '0.0.0.0', () => {
  log('MT5', `TCP server listening on port ${MT5_PORT}`);
});

// ── WEBSOCKET SERVER (PWA) ────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Simple status page on GET /
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status      : 'ok',
    uptime      : uptime(),
    mt5         : mt5Connected,
    pwaClients  : pwaClients.size,
    stats,
  }, null, 2));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  pwaClients.add(ws);
  stats.pwaConnects++;
  const ip = req.socket.remoteAddress;
  log('PWA', `Client connected from ${ip} (total: ${pwaClients.size})`);

  // Send current MT5 status immediately on connect
  ws.send(JSON.stringify({
    type      : 'init',
    mt5       : mt5Connected,
    lastTick  : stats.lastTick,
    lastSignal: stats.lastSignal,
    serverTime: Date.now(),
  }));

  // Heartbeat ping
  ws._pingAlive = true;
  const pingTimer = setInterval(() => {
    if (!ws._pingAlive) {
      log('PWA', 'Client timed out — terminating');
      ws.terminate();
      return;
    }
    ws._pingAlive = false;
    ws.ping();
  }, PING_INTERVAL);

  ws.on('pong', () => { ws._pingAlive = true; });

  // Commands coming FROM the PWA → forward to MT5
  ws.on('message', raw => {
    let cmd;
    try { cmd = JSON.parse(raw); } catch { return; }

    log('PWA', `→ MT5  type=${cmd.type}`);

    // Special: status request — reply directly without going to MT5
    if (cmd.type === 'get_status') {
      ws.send(JSON.stringify({
        type     : 'status',
        mt5      : mt5Connected,
        clients  : pwaClients.size,
        uptime   : uptime(),
        lastTick : stats.lastTick,
      }));
      return;
    }

    // Forward trade commands to MT5
    if (['open_trade', 'close_trade', 'modify_trade', 'get_positions', 'get_account'].includes(cmd.type)) {
      const sent = sendToMT5(cmd);
      if (!sent) {
        ws.send(JSON.stringify({ type: 'error', message: 'MT5 not connected', ref: cmd.type }));
      }
    }
  });

  ws.on('close', () => {
    pwaClients.delete(ws);
    clearInterval(pingTimer);
    log('PWA', `Client disconnected (remaining: ${pwaClients.size})`);
  });

  ws.on('error', err => {
    log('PWA', `WS error: ${err.message}`);
    pwaClients.delete(ws);
    clearInterval(pingTimer);
  });
});

httpServer.listen(WS_PORT, '0.0.0.0', () => {
  log('WS', `WebSocket server listening on port ${WS_PORT}`);
});

// ── HTTP STATUS PAGE ──────────────────────────────────────
const statusServer = http.createServer((req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>SMCBot Server</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body{background:#070910;color:#dde3f0;font-family:monospace;padding:24px}
    h1{color:#00d4a0}
    .ok{color:#00d4a0} .err{color:#ff4d6d} .warn{color:#f0c040}
    table{border-collapse:collapse;width:100%;max-width:500px}
    td{padding:6px 12px;border-bottom:1px solid #151929}
    td:first-child{color:#8892b0}
  </style>
</head>
<body>
  <h1>⚡ SMCBot VPS Bridge</h1>
  <table>
    <tr><td>Status</td><td class="ok">● RUNNING</td></tr>
    <tr><td>Uptime</td><td>${uptime()}</td></tr>
    <tr><td>MT5 EA</td><td class="${mt5Connected ? 'ok' : 'err'}">${mt5Connected ? '● CONNECTED' : '○ DISCONNECTED'}</td></tr>
    <tr><td>PWA Clients</td><td>${pwaClients.size}</td></tr>
    <tr><td>Messages In</td><td>${stats.messagesIn}</td></tr>
    <tr><td>Messages Out</td><td>${stats.messagesOut}</td></tr>
    <tr><td>Last Tick</td><td>${stats.lastTick ? stats.lastTick.symbol + ' @ ' + stats.lastTick.bid : '—'}</td></tr>
    <tr><td>Last Signal</td><td>${stats.lastSignal ? stats.lastSignal.symbol + ' ' + stats.lastSignal.direction : '—'}</td></tr>
  </table>
  <p style="color:#4a5270;font-size:11px;margin-top:16px">Auto-refreshes every 5s</p>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

statusServer.listen(HTTP_PORT, '0.0.0.0', () => {
  log('HTTP', `Status page on port ${HTTP_PORT}`);
});

log('BOOT', '═══════════════════════════════════');
log('BOOT', ' SMCBot Bridge Server started');
log('BOOT', `  WS   → ws://0.0.0.0:${WS_PORT}`);
log('BOOT', `  MT5  → tcp://0.0.0.0:${MT5_PORT}`);
log('BOOT', `  HTTP → http://0.0.0.0:${HTTP_PORT}`);
log('BOOT', '═══════════════════════════════════');
