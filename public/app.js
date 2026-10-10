(() => {
  const G = TriGame;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = ['#d62839', '#0b8a99'];
  const SYMBOLS = ['♥', '★'];
  const DOT_COLORS = ['#e6399b', '#f08a24', '#1697a6', '#222222', '#7b2d8e'];
  const STORE = 'tri-room';

  const board = $('board');
  const die = $('die');

  // S is the current session: { mode: 'ai' | 'local' | 'online', state, names, me, ... }
  let S = null;
  let sel = null, dragFrom = null, pointer = null;
  let dotEls = [], previewEl = null;
  let drawn = { key: '', lines: 0, tris: 0 };
  let dieTimer = null, toastTimer = null;

  // ---------- small helpers ----------
  function svg(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function show(id) {
    $('menu').hidden = id !== 'menu';
    $('game').hidden = id !== 'game';
  }

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  function seg(id) {
    return $(id).querySelector('.on').dataset.v;
  }

  function myName() {
    const name = $('name').value.replace(/\s+/g, ' ').trim().slice(0, 16);
    try { localStorage.setItem('tri-name', name); } catch {}
    return name;
  }

  function store(value) {
    try {
      if (value) sessionStorage.setItem(STORE, JSON.stringify(value));
      else sessionStorage.removeItem(STORE);
    } catch {}
  }

  function myTurn() {
    const st = S && S.state;
    if (!st || st.phase === 'over') return false;
    if (S.mode === 'online') return S.connected && st.turn === S.me && !!S.names[0] && !!S.names[1];
    if (S.mode === 'ai') return st.turn === 0;
    return true;
  }

  // ---------- actions ----------
  function userAct(action) {
    if (!myTurn()) return;
    if (S.mode === 'online') S.ws.send(JSON.stringify(action));
    else apply(action);
  }

  function apply(action) {
    const st = S.state;
    if (action.t === 'roll') {
      const value = 1 + Math.floor(Math.random() * 6);
      if (G.doRoll(st, value)) rollDie(value);
    } else {
      G.doLine(st, action.a, action.b);
    }
    render();
    scheduleAI();
  }

  function scheduleAI() {
    if (!S || S.mode !== 'ai' || S.aiTimer) return;
    const sess = S, st = S.state;
    if (st.phase === 'over' || st.turn !== 1) return;
    sess.aiTimer = setTimeout(() => {
      sess.aiTimer = null;
      if (S !== sess || sess.state !== st) return;
      if (st.phase === 'roll') apply({ t: 'roll' });
      else {
        const m = G.aiPick(st, sess.level);
        apply({ t: 'line', a: m[0], b: m[1] });
      }
    }, st.phase === 'roll' || st.left === st.roll ? 1000 : 650);
  }

  // ---------- local games ----------
  function startLocal(mode) {
    const name = myName();
    S = {
      mode,
      level: seg('levelSeg'),
      n: +seg('dotsSeg'),
      starter: 0,
      names: mode === 'ai' ? [name || 'คุณ', 'คอมพิวเตอร์'] : [name || 'ผู้เล่น 1', 'ผู้เล่น 2'],
      me: mode === 'ai' ? 0 : null,
      state: null,
      aiTimer: null,
    };
    show('game');
    newLocalGame();
  }

  function newLocalGame() {
    clearTimeout(S.aiTimer);
    S.aiTimer = null;
    S.state = G.newGame(S.n, Math.floor(Math.random() * 2 ** 31), S.starter);
    S.starter = 1 - S.starter;
    render();
    scheduleAI();
  }

  // ---------- online games ----------
  function startOnline(first, saved) {
    if (!/^https?:$/.test(location.protocol)) {
      toast('โหมดออนไลน์ต้องเปิดเว็บผ่านเซิร์ฟเวอร์ (npm start)');
      return;
    }
    S = {
      mode: 'online',
      state: null,
      names: ['', ''],
      online: [false, false],
      rematch: [false, false],
      me: null,
      code: saved ? saved.code : null,
      token: saved ? saved.token : null,
      connected: false,
      first,
      ws: null,
    };
    connect();
  }

  function connect() {
    const sess = S;
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    sess.ws = ws;
    ws.onopen = () => {
      sess.connected = true;
      ws.send(JSON.stringify(sess.code ? { t: 'rejoin', code: sess.code, token: sess.token } : sess.first));
    };
    ws.onmessage = (e) => {
      if (S === sess) onMessage(JSON.parse(e.data));
    };
    ws.onclose = () => {
      if (S !== sess || sess.ws !== ws) return;
      sess.connected = false;
      if (!sess.code || $('game').hidden) {
        S = null;
        store(null);
        show('menu');
        toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
        return;
      }
      render();
      setTimeout(() => {
        if (S === sess) connect();
      }, 1500);
    };
  }

  function onMessage(m) {
    if (m.t === 'joined') {
      S.code = m.code;
      S.token = m.token;
      S.me = m.seat;
      store({ code: m.code, token: m.token });
      history.replaceState(null, '', '?room=' + m.code);
      show('game');
      render();
    } else if (m.t === 'state') {
      S.state = m.state;
      S.names = m.names;
      S.online = m.online;
      S.rematch = m.rematch;
      if (m.ev && m.ev.t === 'roll') rollDie(m.ev.value);
      render();
    } else if (m.t === 'error') {
      toast(m.msg);
      if (m.fatal) leave();
    }
  }

  function roomLink() {
    return location.origin + location.pathname + '?room=' + S.code;
  }

  function copyLink() {
    const link = roomLink();
    const done = () => toast('คัดลอกลิงก์ห้องแล้ว — ส่งให้เพื่อนได้เลย');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link).then(done, () => toast(link));
    else toast(link);
  }

  function leave() {
    const old = S;
    S = null;
    sel = null;
    if (old) {
      clearTimeout(old.aiTimer);
      if (old.ws) {
        try {
          if (old.ws.readyState === 1) old.ws.send(JSON.stringify({ t: 'leave' }));
          old.ws.close();
        } catch {}
      }
      if (old.mode === 'online') {
        store(null);
        history.replaceState(null, '', location.pathname);
      }
    }
    $('invite').hidden = true;
    show('menu');
  }

  // ---------- dice ----------
  function setDie(v) {
    die.dataset.v = v || '';
  }

  function rollDie(value) {
    clearInterval(dieTimer);
    die.classList.add('rolling');
    let k = 0;
    dieTimer = setInterval(() => {
      setDie(1 + Math.floor(Math.random() * 6));
      if (++k >= 7) {
        clearInterval(dieTimer);
        dieTimer = null;
        die.classList.remove('rolling');
        setDie(value);
      }
    }, 70);
  }

  // ---------- rendering ----------
  function tagFor(i) {
    if (S.mode === 'online') {
      if (!S.names[i]) return 'ยังไม่เข้าห้อง';
      if (i === S.me) return 'คุณ';
      return S.online[i] ? '' : 'หลุดการเชื่อมต่อ';
    }
    return S.mode === 'ai' && i === 0 && S.names[0] !== 'คุณ' ? 'คุณ' : '';
  }

  function statusText() {
    const st = S.state;
    if (!st) return '';
    if (S.mode === 'online' && !S.connected) return 'กำลังเชื่อมต่อใหม่…';
    if (st.phase === 'over') return 'จบเกม';
    const who = S.names[st.turn] || '…';
    const mine = myTurn();
    const you = S.mode === 'local' ? who : 'คุณ';
    if (st.phase === 'roll') {
      return mine ? `ตาของ${S.mode === 'local' ? ' ' + who : 'คุณ'} — แตะลูกเต๋าเพื่อทอย` : `ตาของ ${who} — รอทอยลูกเต๋า…`;
    }
    return mine ? `${you} ทอยได้ ${st.roll} — ลากเส้นได้อีก ${st.left} เส้น` : `${who} ทอยได้ ${st.roll} — กำลังลากเส้น…`;
  }

  function button(label, onClick, primary, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (primary ? ' primary' : '');
    b.textContent = label;
    b.disabled = !!disabled;
    b.onclick = onClick;
    return b;
  }

  function renderOverlay() {
    const st = S.state;
    const ov = $('overlay'), title = $('ovTitle'), text = $('ovText'), buttons = $('ovButtons');
    buttons.textContent = '';
    text.textContent = '';

    if (S.mode === 'online' && S.code && (!S.names[0] || !S.names[1])) {
      title.textContent = st ? 'อีกฝ่ายออกจากห้องแล้ว' : 'รอเพื่อนเข้าห้อง…';
      text.append('ส่งรหัสห้องหรือลิงก์นี้ให้เพื่อน');
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = S.code;
      text.append(code);
      buttons.append(button('คัดลอกลิงก์', copyLink, true), button('กลับเมนู', leave));
      ov.hidden = false;
      return;
    }

    if (!st || st.phase !== 'over') {
      ov.hidden = true;
      return;
    }

    if (st.winner < 0) title.textContent = 'เสมอกัน!';
    else if (S.me === null) title.textContent = `${S.names[st.winner]} ชนะ! 🎉`;
    else title.textContent = st.winner === S.me ? 'คุณชนะ! 🎉' : `${S.names[st.winner]} ชนะ`;
    let line = `${S.names[0]} ♥ ${st.scores[0]}  —  ${st.scores[1]} ★ ${S.names[1]}`;

    if (S.mode === 'online') {
      const other = 1 - S.me;
      if (S.rematch[other] && !S.rematch[S.me]) line += '\nอีกฝ่ายขอเล่นอีกครั้ง';
      buttons.append(
        S.rematch[S.me]
          ? button('รออีกฝ่ายตอบรับ…', null, true, true)
          : button('เล่นอีกครั้ง', () => S.ws.send(JSON.stringify({ t: 'rematch' })), true)
      );
    } else {
      buttons.append(button('เล่นอีกครั้ง', newLocalGame, true));
    }
    buttons.append(button('กลับเมนู', leave));
    text.textContent = line;
    ov.hidden = false;
  }

  function render() {
    if (!S) return;
    const st = S.state;
    for (const i of [0, 1]) {
      $('name' + i).textContent = S.names[i] || '—';
      $('tag' + i).textContent = tagFor(i);
      $('score' + i).textContent = st ? st.scores[i] : 0;
      $('card' + i).classList.toggle('active', !!st && st.phase !== 'over' && st.turn === i);
    }
    $('progress').textContent = st ? `สามเหลี่ยม ${st.tris.length}/${st.maxTris}` : '';

    const chip = $('roomChip');
    chip.hidden = !(S.mode === 'online' && S.code);
    if (!chip.hidden) chip.textContent = `ห้อง ${S.code} · คัดลอกลิงก์`;

    if (!dieTimer) setDie(st ? st.roll : 0);
    die.classList.toggle('dim', !st || st.phase !== 'draw');
    die.classList.toggle('can', myTurn() && st.phase === 'roll');
    $('left').textContent = st && st.phase === 'draw' ? `เหลือ ${st.left} เส้น` : '';
    $('status').textContent = statusText();

    renderOverlay();
    drawBoard();
  }

  function drawBoard() {
    const st = S.state;
    board.textContent = '';
    dotEls = [];
    previewEl = null;
    if (!st) {
      drawn = { key: '', lines: 0, tris: 0 };
      return;
    }

    // Only the lines and triangles added since the last draw get animated.
    const key = st.dots.length + ':' + st.dots[0].x + ',' + st.dots[0].y + ',' + st.dots[1].x + ',' + st.dots[1].y;
    if (key !== drawn.key || st.lines.length < drawn.lines) {
      drawn = { key, lines: st.lines.length, tris: st.tris.length };
    }

    st.tris.forEach((t, i) => {
      const A = st.dots[t.a], B = st.dots[t.b], C = st.dots[t.c];
      board.append(svg('polygon', { class: 'tri', fill: COLORS[t.p], points: `${A.x},${A.y} ${B.x},${B.y} ${C.x},${C.y}` }));
      const area = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2;
      const perim = Math.hypot(B.x - A.x, B.y - A.y) + Math.hypot(C.x - B.x, C.y - B.y) + Math.hypot(A.x - C.x, A.y - C.y);
      const size = Math.max(13, Math.min(54, ((2 * area) / perim) * 1.15));
      const sym = svg('text', {
        class: 'tri-sym' + (i >= drawn.tris ? ' new' : ''),
        x: (A.x + B.x + C.x) / 3,
        y: (A.y + B.y + C.y) / 3,
        fill: COLORS[t.p],
        'font-size': size.toFixed(1),
      });
      sym.textContent = SYMBOLS[t.p];
      board.append(sym);
    });

    st.lines.forEach((l, i) => {
      const A = st.dots[l.a], B = st.dots[l.b];
      board.append(svg('line', {
        class: 'ln' + (i >= drawn.lines ? ' new' : ''),
        x1: A.x, y1: A.y, x2: B.x, y2: B.y,
        stroke: COLORS[l.p],
        pathLength: 1,
      }));
    });

    previewEl = svg('line', { class: 'preview', stroke: COLORS[st.turn], visibility: 'hidden' });
    board.append(previewEl);

    st.dots.forEach((d, i) => {
      const g = svg('g', { class: 'dot', 'data-i': i });
      g.append(
        svg('circle', { class: 'hit', cx: d.x, cy: d.y, r: 34 }),
        svg('circle', { class: 'ring', cx: d.x, cy: d.y, r: 18, stroke: COLORS[st.turn] }),
        svg('circle', { class: 'pt', cx: d.x, cy: d.y, r: 10, fill: DOT_COLORS[i % DOT_COLORS.length] })
      );
      board.append(g);
      dotEls.push(g);
    });

    drawn.lines = st.lines.length;
    drawn.tris = st.tris.length;
    updateSel();
  }

  // ---------- drawing lines: tap dot then dot, or drag from dot to dot ----------
  function canDrawNow() {
    return myTurn() && S.state.phase === 'draw';
  }

  function updateSel() {
    const can = !!S && canDrawNow();
    board.classList.toggle('mine', can);
    if (!can) sel = null;
    dotEls.forEach((g, i) => {
      g.classList.toggle('sel', i === sel);
      g.classList.toggle('ok', sel !== null && i !== sel && G.canDraw(S.state, sel, i));
    });
    updatePreview();
  }

  function updatePreview() {
    if (!previewEl) return;
    if (sel === null || !pointer) {
      previewEl.setAttribute('visibility', 'hidden');
      return;
    }
    const d = S.state.dots[sel];
    previewEl.setAttribute('x1', d.x);
    previewEl.setAttribute('y1', d.y);
    previewEl.setAttribute('x2', pointer.x);
    previewEl.setAttribute('y2', pointer.y);
    previewEl.setAttribute('visibility', 'visible');
  }

  function toBoard(e) {
    const r = board.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * G.W, y: ((e.clientY - r.top) / r.height) * G.H };
  }

  function dotAt(target) {
    const g = target && target.closest ? target.closest('.dot') : null;
    return g ? +g.dataset.i : null;
  }

  function tryLine(a, b) {
    sel = null;
    if (!G.canDraw(S.state, a, b)) {
      toast('เส้นนี้ลากไม่ได้ — ซ้ำหรือตัดกับเส้นอื่น');
      updateSel();
      return;
    }
    updateSel();
    userAct({ t: 'line', a, b });
  }

  board.addEventListener('pointerdown', (e) => {
    if (!S || !canDrawNow()) return;
    e.preventDefault();
    pointer = toBoard(e);
    const i = dotAt(e.target);
    if (i === null || i === sel) {
      sel = null;
      updateSel();
    } else if (sel === null) {
      sel = dragFrom = i;
      updateSel();
    } else {
      tryLine(sel, i);
    }
  });

  board.addEventListener('pointermove', (e) => {
    if (sel === null) return;
    pointer = toBoard(e);
    updatePreview();
  });

  window.addEventListener('pointerup', (e) => {
    const from = dragFrom;
    dragFrom = null;
    if (from === null || sel !== from || !S || !canDrawNow()) return;
    const i = dotAt(document.elementFromPoint(e.clientX, e.clientY));
    if (i !== null && i !== from) tryLine(from, i);
  });

  // ---------- menu wiring ----------
  for (const id of ['dotsSeg', 'levelSeg']) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const x of $(id).children) x.classList.toggle('on', x === b);
    });
  }

  $('playAi').onclick = () => startLocal('ai');
  $('playLocal').onclick = () => startLocal('local');
  $('createRoom').onclick = () => startOnline({ t: 'create', name: myName(), n: +seg('dotsSeg') });

  function joinRoom() {
    const code = $('code').value.toUpperCase().trim();
    if (code.length !== 4) {
      toast('ใส่รหัสห้อง 4 ตัวอักษร');
      $('code').focus();
      return;
    }
    startOnline({ t: 'join', code, name: myName() });
  }
  $('joinRoom').onclick = joinRoom;
  $('code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

  $('back').onclick = leave;
  $('roomChip').onclick = copyLink;
  die.onclick = () => {
    if (S && myTurn() && S.state.phase === 'roll') userAct({ t: 'roll' });
  };

  // ---------- startup ----------
  try { $('name').value = localStorage.getItem('tri-name') || ''; } catch {}

  const invited = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
  if (invited) {
    $('code').value = invited;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(STORE)); } catch {}
    if (saved && saved.code === invited) {
      startOnline(null, saved); // page was reloaded mid-game: take the same seat back
    } else {
      $('invite').textContent = `คุณได้รับเชิญเข้าห้อง ${invited} — ใส่ชื่อแล้วกด "เข้าห้อง"`;
      $('invite').hidden = false;
    }
  }
})();
