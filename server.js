// Static file server + WebSocket rooms for online play. The server owns the game
// state and the dice; clients only send "roll" and "line" requests.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./public/game.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const DOT_CHOICES = [12, 16, 20, 24];
const MAX_ROOMS = 2000;
const ROOM_IDLE_MS = 10 * 60 * 1000;

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---- rooms ----
const rooms = new Map(); // code -> { code, n, state, players: [p|null, p|null], rematch, starter, lastActive }

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(code)) return code;
  }
}

function cleanName(name, fallback) {
  const s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || fallback;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function fail(ws, msg, fatal) {
  send(ws, { t: 'error', msg, fatal: !!fatal });
}

function broadcast(room, ev) {
  room.lastActive = Date.now();
  const msg = {
    t: 'state',
    code: room.code,
    state: room.state,
    names: room.players.map((p) => (p ? p.name : '')),
    online: room.players.map((p) => !!(p && p.ws)),
    rematch: room.rematch,
    ev: ev || null,
  };
  for (const p of room.players) if (p) send(p.ws, msg);
}

function startGame(room) {
  room.state = G.newGame(room.n, crypto.randomInt(2 ** 31), room.starter);
  room.starter = 1 - room.starter;
  room.rematch = [false, false];
}

function seat(ws, room, i, name) {
  const token = crypto.randomBytes(12).toString('hex');
  room.players[i] = { name, token, ws };
  ws.room = room;
  ws.seat = i;
  send(ws, { t: 'joined', code: room.code, seat: i, token });
}

function detach(ws, remove) {
  const room = ws.room;
  if (!room) return;
  const p = room.players[ws.seat];
  ws.room = null;
  if (!p || p.ws !== ws) return;
  if (remove) room.players[ws.seat] = null;
  else p.ws = null;
  if (!room.players[0] && !room.players[1]) rooms.delete(room.code);
  else broadcast(room);
}

const handlers = {
  create(ws, m) {
    if (ws.room) return;
    if (rooms.size >= MAX_ROOMS) return fail(ws, 'เซิร์ฟเวอร์เต็ม ลองใหม่ภายหลัง', true);
    const room = {
      code: makeCode(),
      n: DOT_CHOICES.includes(m.n) ? m.n : 20,
      state: null,
      players: [null, null],
      rematch: [false, false],
      starter: 0,
      lastActive: Date.now(),
    };
    rooms.set(room.code, room);
    seat(ws, room, 0, cleanName(m.name, 'ผู้เล่น 1'));
    broadcast(room);
  },

  join(ws, m) {
    if (ws.room) return;
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return fail(ws, 'ไม่พบห้องนี้ ตรวจรหัสห้องอีกครั้ง', true);
    const i = room.players.findIndex((p) => !p);
    if (i < 0) return fail(ws, 'ห้องนี้เต็มแล้ว', true);
    seat(ws, room, i, cleanName(m.name, 'ผู้เล่น ' + (i + 1)));
    if (!room.state) startGame(room);
    broadcast(room);
  },

  rejoin(ws, m) {
    if (ws.room) return;
    const room = rooms.get(String(m.code || ''));
    const i = room ? room.players.findIndex((p) => p && p.token === m.token) : -1;
    if (i < 0) return fail(ws, 'ห้องนี้ปิดไปแล้ว', true);
    const p = room.players[i];
    if (p.ws && p.ws !== ws) {
      p.ws.room = null;
      p.ws.close();
    }
    p.ws = ws;
    ws.room = room;
    ws.seat = i;
    send(ws, { t: 'joined', code: room.code, seat: i, token: p.token });
    broadcast(room);
  },

  roll(ws) {
    const room = ws.room;
    if (!ready(room) || room.state.turn !== ws.seat) return;
    const value = crypto.randomInt(1, 7);
    if (G.doRoll(room.state, value)) broadcast(room, { t: 'roll', value, by: ws.seat });
  },

  line(ws, m) {
    const room = ws.room;
    if (!ready(room) || room.state.turn !== ws.seat) return;
    const r = G.doLine(room.state, m.a, m.b);
    if (!r) return fail(ws, 'ลากเส้นนี้ไม่ได้');
    broadcast(room, { t: 'line', a: m.a, b: m.b, by: ws.seat, tris: r.tris.length });
  },

  rematch(ws) {
    const room = ws.room;
    if (!ready(room) || room.state.phase !== 'over') return;
    room.rematch[ws.seat] = true;
    if (room.rematch[0] && room.rematch[1]) startGame(room);
    broadcast(room);
  },

  leave(ws) {
    detach(ws, true);
  },
};

function ready(room) {
  return !!(room && room.state && room.players[0] && room.players[1]);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const h = m && Object.prototype.hasOwnProperty.call(handlers, m.t) ? handlers[m.t] : null;
    if (h) h(ws, m);
  });
  ws.on('close', () => detach(ws, false));
  ws.on('error', () => {});
});

// Keep connections alive through proxies, and drop dead ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

// Remove rooms nobody is connected to any more.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = room.players.some((p) => p && p.ws);
    if (!anyone && now - room.lastActive > ROOM_IDLE_MS) rooms.delete(room.code);
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`Triangle Dots running:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) console.log(`  on your network:      http://${ni.address}:${PORT}`);
    }
  }
});
