/**
 * SMCBot Bridge Server v2 — HTTP + WebSocket
 * MT5 EA  → POST /api/ea       (sends ticks, candles, account)
 * MT5 EA  ← GET  /api/commands (polls for trade commands)
 * PWA     ↔ WebSocket ws://host:8080
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// State
const pwaClients  = new Set();
let   pendingCmd  = null;   // next command waiting for MT5 to pick up
let   lastTick    = null;
let   lastSignal  = null;
let   mt5Alive    = false;
let   mt5LastSeen = 0;
const stats = { start: Date.now(), msgIn: 0, msgOut: 0 };

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11,23)}] [${tag}] ${msg}`);
}

function broadcast(obj) {
  const json = JSON.stringify(obj);
  for (const ws of pwaClients) {
    if (ws.readyState === 1) { ws.send(json); stats.msgOut++; }
  }
}

function uptime() {
  const s = Math.floor((Date.now()-stats.start)/1000);
  return `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m ${s%60}s`;
}

// ── HTTP SERVER ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url    = req.url.split('?')[0];
  const method = req.method;

  // CORS for PWA
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── MT5 EA posts data here ──
  if (method === 'POST' && url === '/api/ea') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      stats.msgIn++;
      mt5Alive    = true;
      mt5LastSeen = Date.now();

      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
      msg._ts = Date.now();

      if (msg.type === 'tick')   lastTick   = msg;
      if (msg.type === 'signal') lastSignal = msg;

      log('MT5', `→ type=${msg.type} sym=${msg.symbol||''}`);

      // Forward everything to PWA clients
      broadcast(msg);

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end('{"ok":true}');
    });
    return;
  }

  // ── MT5 EA polls for commands ──
  if (method === 'GET' && url === '/api/commands') {
    mt5Alive    = true;
    mt5LastSeen = Date.now();
    res.writeHead(200, {'Content-Type':'application/json'});
    if (pendingCmd) {
      log('MT5', `← sending command: ${pendingCmd.type}`);
      res.end(JSON.stringify(pendingCmd));
      pendingCmd = null;
    } else {
      res.end('{"type":"none"}');
    }
    return;
  }

  // ── Status page ──
  if (method === 'GET' && (url === '/' || url === '/status')) {
    const mt5Age = mt5LastSeen ? Math.floor((Date.now()-mt5LastSeen)/1000) : null;
    const html = `<!DOCTYPE html>
<html><head><title>SMCBot</title><meta http-equiv="refresh" content="5">
<style>body{background:#070910;color:#dde3f0;font-family:monospace;padding:24px}
h1{color:#00d4a0}.ok{color:#00d4a0}.err{color:#ff4d6d}
table{border-collapse:collapse}td{padding:6px 14px;border-bottom:1px solid #151929}
td:first-child{color:#8892b0}</style></head>
<body><h1>⚡ SMCBot Bridge v2</h1><table>
<tr><td>Status</td><td class="ok">● RUNNING</td></tr>
<tr><td>Uptime</td><td>${uptime()}</td></tr>
<tr><td>MT5 EA</td><td class="${mt5Alive?'ok':'err'}">${mt5Alive?`● ALIVE (${mt5Age}s ago)`:'○ NOT SEEN'}</td></tr>
<tr><td>PWA Clients</td><td>${pwaClients.size}</td></tr>
<tr><td>Messages In</td><td>${stats.msgIn}</td></tr>
<tr><td>Messages Out</td><td>${stats.msgOut}</td></tr>
<tr><td>Last Tick</td><td>${lastTick?lastTick.symbol+' @ '+lastTick.bid:'—'}</td></tr>
</table><p style="color:#4a5270;font-size:11px;margin-top:16px">Auto-refreshes every 5s</p>
</body></html>`;
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(html);
    return;
  }

  res.writeHead(404); res.end('not found');
});

// ── WEBSOCKET (PWA) ──────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  pwaClients.add(ws);
  log('PWA', `Client connected (total: ${pwaClients.size})`);

  // Send current state immediately
  ws.send(JSON.stringify({
    type      : 'init',
    mt5       : mt5Alive,
    lastTick,
    lastSignal,
    serverTime: Date.now(),
  }));

  // Heartbeat
  ws._alive = true;
  const ping = setInterval(() => {
    if (!ws._alive) { ws.terminate(); return; }
    ws._alive = false; ws.ping();
  }, 20000);
  ws.on('pong', () => { ws._alive = true; });

  // Commands from PWA → queue for MT5
  ws.on('message', raw => {
    let cmd;
    try { cmd = JSON.parse(raw); } catch { return; }
    log('PWA', `→ MT5 cmd: ${cmd.type}`);

    if (cmd.type === 'get_status') {
      ws.send(JSON.stringify({ type:'status', mt5:mt5Alive, clients:pwaClients.size, uptime:uptime(), lastTick }));
      return;
    }
    // Queue trade command for MT5 to pick up on next poll
    if (['open_trade','close_trade','modify_trade','get_positions','get_account'].includes(cmd.type)) {
      pendingCmd = cmd;
      ws.send(JSON.stringify({ type:'ack', message:'Command queued for MT5' }));
    }
  });

  ws.on('close', () => { pwaClients.delete(ws); clearInterval(ping); log('PWA',`Client left (remaining: ${pwaClients.size})`); });
  ws.on('error', () => { pwaClients.delete(ws); clearInterval(ping); });
});

// Mark MT5 offline if no ping for 60s
setInterval(() => {
  if (mt5LastSeen && Date.now()-mt5LastSeen > 60000) {
    if (mt5Alive) { mt5Alive = false; broadcast({ type:'mt5_status', connected:false }); }
  }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  log('BOOT', `SMCBot Bridge v2 running on port ${PORT}`);
  log('BOOT', `MT5 posts to  → POST /api/ea`);
  log('BOOT', `MT5 polls     → GET  /api/commands`);
  log('BOOT', `PWA connects  → ws://host:${PORT}`);
});
