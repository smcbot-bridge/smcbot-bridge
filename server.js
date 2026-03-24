/**
 * SMCBot Bridge Server v3
 * - MT5 EA  → POST /api/ea
 * - MT5 EA  ← GET  /api/commands
 * - PWA     ↔ WebSocket
 * - State   → stored on server (shared across all devices)
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// ── SHARED STATE (same for all devices) ─────────────────────────
const sharedState = {
  balance   : 10000,
  profit    : 0,
  trades    : [],   // last 60 trades
  signals   : [],   // last 40 signals
  positions : [],
  account   : null,
};

const pwaClients  = new Set();
let   pendingCmd  = null;
let   lastTick    = null;
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

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── MT5 posts data ──
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

      if (msg.type === 'tick') lastTick = msg;

      // Update shared state from MT5
      if (msg.type === 'account') {
        sharedState.balance = msg.balance || sharedState.balance;
        sharedState.profit  = msg.profit  || sharedState.profit;
        sharedState.account = msg;
      }
      if (msg.type === 'positions') {
        sharedState.positions = msg.data || [];
      }
      if (msg.type === 'trade_result' && msg.success) {
        sharedState.trades.unshift({
          id     : Date.now(),
          type   : msg.direction,
          symbol : msg.symbol,
          lots   : msg.lots,
          status : 'OPEN',
          pnl    : 0,
          ts     : Date.now(),
        });
        if (sharedState.trades.length > 60) sharedState.trades.pop();
      }
      if (msg.type === 'signal') {
        sharedState.signals.unshift(msg);
        if (sharedState.signals.length > 40) sharedState.signals.pop();
      }

      log('MT5', `type=${msg.type} sym=${msg.symbol||''}`);
      broadcast(msg);

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end('{"ok":true}');
    });
    return;
  }

  // ── MT5 polls for commands ──
  if (method === 'GET' && url === '/api/commands') {
    mt5Alive    = true;
    mt5LastSeen = Date.now();
    res.writeHead(200, {'Content-Type':'application/json'});
    if (pendingCmd) {
      log('MT5', `sending cmd: ${pendingCmd.type}`);
      res.end(JSON.stringify(pendingCmd));
      pendingCmd = null;
    } else {
      res.end('{"type":"none"}');
    }
    return;
  }

  // ── PWA fetches shared state on connect ──
  if (method === 'GET' && url === '/api/state') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      type      : 'shared_state',
      balance   : sharedState.balance,
      profit    : sharedState.profit,
      trades    : sharedState.trades,
      signals   : sharedState.signals,
      positions : sharedState.positions,
      account   : sharedState.account,
      mt5       : mt5Alive,
      serverTime: Date.now(),
    }));
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
<body><h1>SMCBot Bridge v3</h1><table>
<tr><td>Status</td><td class="ok">RUNNING</td></tr>
<tr><td>Uptime</td><td>${uptime()}</td></tr>
<tr><td>MT5 EA</td><td class="${mt5Alive?'ok':'err'}">${mt5Alive?`ALIVE (${mt5Age}s ago)`:'NOT SEEN'}</td></tr>
<tr><td>PWA Clients</td><td>${pwaClients.size}</td></tr>
<tr><td>Balance</td><td>$${sharedState.balance.toFixed(2)}</td></tr>
<tr><td>Profit</td><td>$${sharedState.profit.toFixed(2)}</td></tr>
<tr><td>Trades</td><td>${sharedState.trades.length}</td></tr>
<tr><td>Signals</td><td>${sharedState.signals.length}</td></tr>
<tr><td>Last Tick</td><td>${lastTick?lastTick.symbol+' @ '+lastTick.bid:'none'}</td></tr>
<tr><td>Messages In</td><td>${stats.msgIn}</td></tr>
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

  // Send SHARED state immediately on connect
  ws.send(JSON.stringify({
    type      : 'shared_state',
    balance   : sharedState.balance,
    profit    : sharedState.profit,
    trades    : sharedState.trades,
    signals   : sharedState.signals,
    positions : sharedState.positions,
    mt5       : mt5Alive,
    lastTick,
    serverTime: Date.now(),
  }));

  ws._alive = true;
  const ping = setInterval(() => {
    if (!ws._alive) { ws.terminate(); return; }
    ws._alive = false; ws.ping();
  }, 20000);
  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', raw => {
    let cmd;
    try { cmd = JSON.parse(raw); } catch { return; }

    if (cmd.type === 'get_status') {
      ws.send(JSON.stringify({
        type    : 'shared_state',
        balance : sharedState.balance,
        profit  : sharedState.profit,
        trades  : sharedState.trades,
        signals : sharedState.signals,
        mt5     : mt5Alive,
        uptime  : uptime(),
        lastTick,
      }));
      return;
    }
    if (['open_trade','close_trade','modify_trade','get_positions','get_account'].includes(cmd.type)) {
      pendingCmd = cmd;
      ws.send(JSON.stringify({ type:'ack', message:'Command queued for MT5' }));
    }
  });

  ws.on('close', () => { pwaClients.delete(ws); clearInterval(ping); });
  ws.on('error', () => { pwaClients.delete(ws); clearInterval(ping); });
});

// Mark MT5 offline after 60s silence
setInterval(() => {
  if (mt5LastSeen && Date.now()-mt5LastSeen > 60000) {
    if (mt5Alive) {
      mt5Alive = false;
      broadcast({ type:'mt5_status', connected:false });
    }
  }
}, 10000);

// Self-ping to keep Render awake
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
if (SELF_URL) {
  setInterval(() => {
    require('https').get(SELF_URL+'/status', ()=>{}).on('error',()=>{});
  }, 10*60*1000);
}

server.listen(PORT, '0.0.0.0', () => {
  log('BOOT', `SMCBot Bridge v3 on port ${PORT}`);
});
