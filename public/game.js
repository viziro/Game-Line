// Shared game rules: used by the browser (window.TriGame) and by server.js (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TriGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const W = 1000, H = 700, MARGIN = 60;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // Dots are kept in "general position": no dot sits on (or within `clear` of) the
  // segment between two others, so a line is legal iff it crosses no other line.
  function dotFits(p, dots, minDist, clear) {
    for (const d of dots) if (Math.hypot(p.x - d.x, p.y - d.y) < minDist) return false;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        if (distToSeg(p, dots[i], dots[j]) < clear) return false;
        if (distToSeg(dots[j], p, dots[i]) < clear) return false;
        if (distToSeg(dots[i], p, dots[j]) < clear) return false;
      }
    }
    return true;
  }

  function generateDots(n, rng) {
    const base = Math.sqrt(((W - 2 * MARGIN) * (H - 2 * MARGIN)) / n);
    for (let clear = 14; clear >= 2; clear -= 3) {
      const minDist = base * (0.45 + clear / 100);
      const dots = [];
      let fails = 0;
      while (dots.length < n && fails < 6000) {
        const p = {
          x: Math.round(MARGIN + rng() * (W - 2 * MARGIN)),
          y: Math.round(MARGIN + rng() * (H - 2 * MARGIN)),
        };
        if (dotFits(p, dots, minDist, clear)) dots.push(p);
        else fails++;
      }
      if (dots.length === n) return dots;
    }
    throw new Error('could not place dots');
  }

  function hullSize(dots) {
    const p = dots.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const build = (pts) => {
      const h = [];
      for (const q of pts) {
        while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
        h.push(q);
      }
      h.pop();
      return h;
    };
    return build(p).length + build(p.reverse()).length;
  }

  function newGame(n, seed, starter) {
    const dots = generateDots(n, mulberry32(seed));
    return {
      dots,
      lines: [], // {a, b, p}
      tris: [], // {a, b, c, p}
      scores: [0, 0],
      turn: starter ? 1 : 0,
      phase: 'roll', // 'roll' | 'draw' | 'over'
      roll: 0,
      left: 0,
      winner: null, // 0 | 1 | -1 (draw)
      maxTris: 2 * n - 2 - hullSize(dots),
    };
  }

  // ---- ctx: state plus an adjacency matrix, for fast repeated queries ----
  function ctxOf(s) {
    const n = s.dots.length;
    const adj = new Uint8Array(n * n);
    for (const l of s.lines) adj[l.a * n + l.b] = adj[l.b * n + l.a] = 1;
    return { dots: s.dots, lines: s.lines.map((l) => [l.a, l.b]), adj, n };
  }
  function ctxAdd(c, a, b) {
    c.adj[a * c.n + b] = c.adj[b * c.n + a] = 1;
    c.lines.push([a, b]);
  }
  function ctxPop(c) {
    const [a, b] = c.lines.pop();
    c.adj[a * c.n + b] = c.adj[b * c.n + a] = 0;
  }

  function canDrawCtx(c, a, b) {
    if (a === b || c.adj[a * c.n + b]) return false;
    const A = c.dots[a], B = c.dots[b];
    for (const [u, v] of c.lines) {
      if (u === a || u === b || v === a || v === b) continue;
      const U = c.dots[u], V = c.dots[v];
      const d1 = cross(U, V, A), d2 = cross(U, V, B);
      if ((d1 > 0) === (d2 > 0)) continue;
      const d3 = cross(A, B, U), d4 = cross(A, B, V);
      if ((d3 > 0) !== (d4 > 0)) return false;
    }
    return true;
  }

  function legalMovesCtx(c) {
    const out = [];
    for (let a = 0; a < c.n; a++)
      for (let b = a + 1; b < c.n; b++) if (canDrawCtx(c, a, b)) out.push([a, b]);
    return out;
  }

  function triEmpty(dots, a, b, c) {
    const A = dots[a], B = dots[b], C = dots[c];
    for (let i = 0; i < dots.length; i++) {
      if (i === a || i === b || i === c) continue;
      const s1 = cross(A, B, dots[i]) > 0, s2 = cross(B, C, dots[i]) > 0, s3 = cross(C, A, dots[i]) > 0;
      if (s1 === s2 && s2 === s3) return false;
    }
    return true;
  }

  // Third corners of the triangles that drawing a-b would close.
  function newTrisCtx(c, a, b) {
    const out = [];
    for (let k = 0; k < c.n; k++) {
      if (k === a || k === b) continue;
      if (c.adj[a * c.n + k] && c.adj[b * c.n + k] && triEmpty(c.dots, a, b, k)) out.push(k);
    }
    return out;
  }

  function validIndex(s, i) {
    return Number.isInteger(i) && i >= 0 && i < s.dots.length;
  }

  function canDraw(s, a, b) {
    return validIndex(s, a) && validIndex(s, b) && canDrawCtx(ctxOf(s), a, b);
  }

  function doRoll(s, value) {
    if (s.phase !== 'roll' || !(value >= 1 && value <= 6)) return false;
    s.roll = value;
    s.left = value;
    s.phase = 'draw';
    return true;
  }

  // Returns null if illegal, otherwise { tris: [third corners closed by this line] }.
  function doLine(s, a, b) {
    if (s.phase !== 'draw' || !validIndex(s, a) || !validIndex(s, b)) return null;
    const c = ctxOf(s);
    if (!canDrawCtx(c, a, b)) return null;
    const closed = newTrisCtx(c, a, b);
    s.lines.push({ a, b, p: s.turn });
    for (const k of closed) s.tris.push({ a, b, c: k, p: s.turn });
    s.scores[s.turn] += closed.length;
    s.left--;
    ctxAdd(c, a, b);
    if (legalMovesCtx(c).length === 0) {
      s.phase = 'over';
      s.left = 0;
      s.winner = s.scores[0] === s.scores[1] ? -1 : s.scores[0] > s.scores[1] ? 0 : 1;
    } else if (s.left === 0) {
      s.turn = 1 - s.turn;
      s.phase = 'roll';
    }
    return { tris: closed };
  }

  // level: 'easy' | 'normal' | 'hard'. Returns [a, b] or null.
  function aiPick(s, level, rnd) {
    rnd = rnd || Math.random;
    const c = ctxOf(s);
    const moves = legalMovesCtx(c);
    if (!moves.length) return null;
    if (level === 'easy' && rnd() < 0.6) return moves[Math.floor(rnd() * moves.length)];
    let best = null, bestScore = -Infinity;
    for (const m of moves) {
      let score = newTrisCtx(c, m[0], m[1]).length * 10 + rnd();
      if (level === 'hard') {
        // Look at what this line leaves open: triangles I can still close with my
        // remaining lines are good, the ones handed to the opponent are bad.
        ctxAdd(c, m[0], m[1]);
        const open = [];
        for (const r of legalMovesCtx(c)) {
          const k = newTrisCtx(c, r[0], r[1]).length;
          if (k) open.push(k);
        }
        ctxPop(c);
        open.sort((x, y) => y - x);
        const mine = s.left - 1;
        for (let i = 0; i < open.length; i++) {
          if (i < mine) score += open[i] * 8;
          else if (i < mine + 4) score -= open[i] * 7;
        }
      }
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  return { W, H, newGame, canDraw, doRoll, doLine, aiPick };
});
