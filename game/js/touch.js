'use strict';
// ---------------------------------------------------------------------------
// Touch controls (iPad / iPhone / Android tablets)
//   - left virtual stick  -> movement
//   - drag anywhere       -> look around
//   - bottom-right buttons-> jump / mine (hold) / use-place (hold) / sneak / sprint
//   - top bar             -> pause, inventory, chat, camera, fly (creative)
//   - tap the hotbar      -> select slot
//   - while a GUI is open a tap acts as a left click, the "右" button toggles
//     right-click mode (place one / take half), just like a mouse
// ---------------------------------------------------------------------------
// ---- feature switches -------------------------------------------------------
// Chat is temporarily disabled on touch devices: the on-screen keyboard / text
// input is not usable yet. Set to true to bring the 💬 button back.
var TOUCH_CHAT = false;

var TOUCH_MODE = (function () {
  let isIOS = false;
  try {
    const ua = navigator.userAgent || '';
    isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    // only the *primary* pointer decides: a Windows touch laptop with a mouse must stay a mouse game
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const q = new URLSearchParams(location.search);
    if (q.get('touch') === '1') return { active: true, forced: true, ios: isIOS };
    if (q.get('touch') === '0') return { active: false, forced: false, ios: isIOS };
    return { active: navigator.maxTouchPoints > 0 && (isIOS || isAndroid || coarse), ios: isIOS };
  } catch (e) { return { active: false, ios: isIOS }; }
})();

var TOUCH_CSS = `
#touchui { position: fixed; inset: 0; pointer-events: none; z-index: 20;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  --tb: clamp(50px, min(8.6vmin, 10vw), 88px); --gap: clamp(8px, 1.4vmin, 14px);
  --sl: calc(16px + env(safe-area-inset-left)); --sr: calc(16px + env(safe-area-inset-right));
  --sb: calc(16px + env(safe-area-inset-bottom)); --st: calc(10px + env(safe-area-inset-top));
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
#touchui .tb { position: absolute; display: none; align-items: center; justify-content: center;
  width: var(--tb); height: var(--tb); box-sizing: border-box; pointer-events: auto; touch-action: none;
  background: rgba(0,0,0,.34); border: 2px solid rgba(255,255,255,.48); border-radius: 14px;
  color: #fff; font-size: calc(var(--tb) * .34); line-height: 1; text-shadow: 0 2px 3px rgba(0,0,0,.8);
  box-shadow: 0 2px 8px rgba(0,0,0,.35); }
#touchui .tb.on { background: rgba(255,255,255,.5); border-color: #fff; color: #111; text-shadow: none; }
#touchui .tb .ico { display: block; }
#touchui .tb.big { width: calc(var(--tb) * 1.15); height: calc(var(--tb) * 1.15); font-size: calc(var(--tb) * .4); }
#touchui .tb.small { width: calc(var(--tb) * .72); height: calc(var(--tb) * .72); font-size: calc(var(--tb) * .26); border-radius: 11px; }
#touchui.play .only-play { display: flex; }
#touchui.play:not(.screen) .only-play-noscreen { display: flex; }
#touchui.creative .only-creative { display: flex; }
#touchui:not(.creative) .only-creative { display: none !important; }
/* right-click mode only makes sense inside an item container */
#touchui.container #talt { display: flex; }
/* never let the top bar cover an open GUI (chat box, titles, slots) */
#touchui.screen #trow { display: none !important; }

#touchui #tstick { position: absolute; left: var(--sl); bottom: var(--sb); display: none;
  width: clamp(110px, min(21vmin, 26vw), 190px); height: clamp(110px, min(21vmin, 26vw), 190px); border-radius: 50%;
  box-sizing: border-box; pointer-events: auto; touch-action: none;
  background: radial-gradient(circle at 50% 50%, rgba(255,255,255,.10), rgba(0,0,0,.28) 70%);
  border: 2px solid rgba(255,255,255,.38); }
#touchui.play:not(.screen) #tstick { display: block; }
#touchui #tknob { position: absolute; left: 50%; top: 50%; width: 44%; height: 44%; margin: -22% 0 0 -22%;
  border-radius: 50%; background: rgba(255,255,255,.42); border: 2px solid rgba(255,255,255,.7);
  box-shadow: 0 2px 10px rgba(0,0,0,.5); transition: transform .06s linear; }

#touchui #tjump { right: var(--sr); bottom: var(--sb); }
#touchui #tmine { right: var(--sr); bottom: calc(var(--sb) + var(--tb) * 1.15 + var(--gap)); }
#touchui #tuse  { right: calc(var(--sr) + var(--tb) * 1.15 + var(--gap)); bottom: var(--sb); }
#touchui #tsneak{ right: calc(var(--sr) + var(--tb) * 2.3 + var(--gap) * 2); bottom: var(--sb); }
#touchui #tsprint{right: calc(var(--sr) + var(--tb) * 2.3 + var(--gap) * 2); bottom: calc(var(--sb) + var(--tb) * .95 + var(--gap)); }

#touchui #trow { position: absolute; top: var(--st); left: 50%; transform: translateX(-50%);
  display: flex; gap: 8px; pointer-events: none; }
#touchui #trow .tb { position: static; }
#touchui #talt { left: var(--sl); top: var(--st); }
#touchui #talt.on { background: rgba(90,200,90,.6); border-color: #bfffbf; }

/* portrait: keep the sneak/sprint column clear of the centred hotbar */
@media (max-aspect-ratio: 1/1) {
  #touchui #tsneak { bottom: calc(var(--sb) + 38px); }
  #touchui #tsprint { bottom: calc(var(--sb) + 38px + var(--tb) * .72 + var(--gap)); }
}
`;

function bindTouch(g) {
  if (!TOUCH_MODE.active) return;
  const ui = g.ui, canvas = g.canvas;
  g.touchMove = { fwd: 0, strafe: 0 };

  // touch-first defaults when the player has no saved settings yet (retina fill-rate is the bottleneck)
  try {
    if (!localStorage.getItem('mcjs-settings')) {
      g.settings.resScale = 0.75;
      g.settings.renderDist = Math.min(g.settings.renderDist || 6, 6);
      g.applySettings();
    }
  } catch (e) { }

  // touch wording in the tutorial / help pages
  if (typeof TUTORIAL !== 'undefined') {
    TUTORIAL[0].text = '推动左下角摇杆四处走走';
    if (TUTORIAL[2]) TUTORIAL[2].text = '点击上方的 ☰ 按钮打开物品栏';
    if (TUTORIAL[1]) TUTORIAL[1].text = '对准树干，按住 ⛏ 挖掉它';
  }
  if (typeof HELP_PAGES !== 'undefined' && !HELP_PAGES[0].touch) {
    HELP_PAGES.unshift({
      title: '触屏操作', touch: true, lines: [
        '左摇杆|移动（推到底自动疾跑需按 » 开启疾跑）',
        '拖动屏幕|环视四周',
        '⛏（按住）|挖掘方块 / 攻击生物',
        '▣（按住）|放置方块 / 使用物品 / 打开容器 / 吃东西',
        '▲|跳跃；(创造模式) 双击切换飞行',
        '⇩ / »|潜行 / 疾跑（再次点击取消）',
        '✈|创造模式飞行开关',
        '👁|切换第一 / 第三人称视角',
        'Ⅱ / ☰|游戏菜单 / 物品栏',
        '（聊天功能暂未开放）',
        '点击物品栏底部|切换快捷栏格子',
        '打开界面时|点击 = 左键，「右」按钮切换右键',
        '  例如先点「右」再点物品 = 放下一个 / 拿一半',
        '提示|可在 选项 → 渲染分辨率 调整画质换取流畅度',
      ]
    });
  }

  const style = document.createElement('style');
  style.id = 'touchstyle'; style.textContent = TOUCH_CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'touchui';
  root.innerHTML = `
    <div id="tstick"><div id="tknob"></div></div>
    <div class="tb small" id="talt"><span class="ico">右</span></div>
    <div class="tb big only-play-noscreen" id="tjump"><span class="ico">▲</span></div>
    <div class="tb only-play-noscreen" id="tmine"><span class="ico">⛏</span></div>
    <div class="tb only-play-noscreen" id="tuse"><span class="ico">▣</span></div>
    <div class="tb small only-play-noscreen" id="tsneak"><span class="ico">⇩</span></div>
    <div class="tb small only-play-noscreen" id="tsprint"><span class="ico">»</span></div>
    <div id="trow">
      <div class="tb small only-play" id="tpause"><span class="ico">Ⅱ</span></div>
      <div class="tb small only-play" id="tinv"><span class="ico">☰</span></div>
      <div class="tb small only-play" id="tchat"><span class="ico">💬</span></div>
      <div class="tb small only-play" id="tcam"><span class="ico">👁</span></div>
      <div class="tb small only-play only-creative" id="tfly"><span class="ico">✈</span></div>
    </div>`;
  document.body.appendChild(root);
  const $ = (id) => root.querySelector(id);

  if (!TOUCH_CHAT) { const chat = $('#tchat'); if (chat) chat.remove(); }
  const LABELS = {
    talt: '右键模式', tjump: '跳跃', tmine: '挖掘 / 攻击', tuse: '放置 / 使用', tsneak: '潜行',
    tsprint: '疾跑', tpause: '游戏菜单', tinv: '物品栏', tcam: '切换视角', tfly: '创造飞行',
  };
  root.querySelectorAll('.tb').forEach((el) => {
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', LABELS[el.id] || el.textContent.trim());
  });

  // On iOS the keyboard only opens when focus() happens inside the touch gesture,
  // and it would cover a chat box pinned to the bottom of the screen.
  if (ui && ui.showInput) {
    const origShow = ui.showInput.bind(ui);
    ui.showInput = function (x, y, w, h, value, onEnter, opts) {
      const s = this.scale / this.dpr;
      origShow(x, y, w, h, value, onEnter, opts);
      const el = this.input;
      if (this.screen && this.screen.isChat) {
        el.style.left = (4 * s) + 'px'; el.style.top = '8px';
        el.style.width = ((this.w - 8) * s) + 'px';
        el.style.height = Math.max(18, 13 * s) + 'px';
      }
      try { el.focus(); } catch (e) { }
    };
  }

  // ---- UI state classes -----------------------------------------------------
  let wasScreen = null, wasPlay = null, wasCreative = null, wasContainer = null;
  const syncState = () => {
    const isScreen = !!ui.screen, isPlay = g.state === 'play', isCreative = g.mode === 'creative';
    const isContainer = !!(isScreen && typeof ContainerScreen !== 'undefined' && ui.screen instanceof ContainerScreen);
    if (isScreen !== wasScreen) {
      root.classList.toggle('screen', isScreen);
      if (!isScreen) altClick = false; // right-click mode is per-GUI
      wasScreen = isScreen;
    }
    if (isContainer !== wasContainer) { root.classList.toggle('container', isContainer); wasContainer = isContainer; }
    if (isPlay !== wasPlay) { root.classList.toggle('play', isPlay); wasPlay = isPlay; }
    if (isCreative !== wasCreative) { root.classList.toggle('creative', isCreative); wasCreative = isCreative; }
    root.querySelector('#talt').classList.toggle('on', altClick);
    root.querySelector('#tsneak').classList.toggle('on', !!g.keys.ShiftLeft);
    root.querySelector('#tsprint').classList.toggle('on', !!g.sprintToggle);
    root.querySelector('#tfly').classList.toggle('on', !!(g.player && g.player.flying));
  };
  setInterval(syncState, 150);

  // ---- helpers --------------------------------------------------------------
  const press = (el, down, up) => {
    let pid = null;
    el.addEventListener('pointerdown', (e) => {
      if (pid !== null) return; // already held
      pid = e.pointerId;
      e.preventDefault(); e.stopPropagation();
      Sound.init();
      try { el.setPointerCapture(e.pointerId); } catch (err) { }
      el.classList.add('on');
      down && down(e);
    });
    const end = (e) => {
      // pointerup and lostpointercapture both fire; only the owning pointer may release
      if (pid === null || e.pointerId !== pid) return;
      pid = null;
      e.preventDefault();
      el.classList.remove('on');
      up && up(e);
      syncState();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  };
  const tap = (el, fn) => press(el, fn, null);

  // Some browsers still synthesize mouse events after a tap; eating them keeps a
  // single tap from being handled twice (once by us, once by the mouse bindings).
  let lastTouch = 0;
  window.addEventListener('touchstart', () => { lastTouch = performance.now(); }, true);
  window.addEventListener('touchmove', () => { lastTouch = performance.now(); }, true);
  const eatCompatMouse = (e) => {
    if (performance.now() - lastTouch < 900) { e.stopPropagation(); e.preventDefault(); }
  };
  window.addEventListener('mousedown', eatCompatMouse, true);
  window.addEventListener('mouseup', eatCompatMouse, true);

  // ---- look & GUI taps on the game canvas ------------------------------------
  let lookId = null, lastX = 0, lastY = 0, downT = 0, moved = 0, altClick = false;
  let guiDown = false;

  const clientRect = () => canvas.getBoundingClientRect();
  const toGui = (clientX, clientY) => {
    const r = clientRect();
    return [(clientX - r.left) * (ui.dpr || 1) / ui.scale, (clientY - r.top) * (ui.dpr || 1) / ui.scale];
  };
  const mouseEv = (t, button) => ({
    clientX: t.clientX, clientY: t.clientY, button: button || 0, shiftKey: false,
    target: canvas, preventDefault() { }, stopPropagation() { },
  });

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    Sound.init();
    if (e.touches.length > 1) { lookId = null; return; }
    const t = e.changedTouches[0];
    if (ui.screen) {
      guiDown = true;
      ui.mouseDown(mouseEv(t, altClick ? 2 : 0));
      return;
    }
    if (g.state !== 'play') return;
    lookId = t.identifier; lastX = t.clientX; lastY = t.clientY;
    downT = performance.now(); moved = 0;
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const t = Array.prototype.find.call(e.changedTouches, (x) => x.identifier === lookId);
    if (ui.screen) {
      if (guiDown || e.touches.length) ui.mouseMove(mouseEv(e.changedTouches[0]));
      return;
    }
    if (!t || g.state !== 'play' || ui.screen) return;
    const dx = t.clientX - lastX, dy = t.clientY - lastY;
    lastX = t.clientX; lastY = t.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    const p = g.player;
    const s = g.settings.sens * 0.009 + 0.0012;
    p.yaw -= dx * s;
    p.pitch = clamp(p.pitch - dy * s, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
  }, { passive: false });

  const endTouch = (e) => {
    e.preventDefault();
    const t = Array.prototype.find.call(e.changedTouches, (x) => x.identifier === lookId);
    if (ui.screen) {
      if (guiDown) { guiDown = false; ui.mouseUp(mouseEv(e.changedTouches[0], altClick ? 2 : 0)); }
      return;
    }
    if (g.state !== 'play') { lookId = null; return; }
    if (t && moved < 14 && performance.now() - downT < 320) tapGame(t.clientX, t.clientY);
    if (t) lookId = null;
  };
  canvas.addEventListener('touchend', endTouch, { passive: false });
  canvas.addEventListener('touchcancel', (e) => { e.preventDefault(); lookId = null; guiDown = false; }, { passive: false });

  // tap the hotbar to select a slot (the hotbar itself is drawn by the HUD)
  function tapGame(clientX, clientY) {
    const [gx, gy] = toGui(clientX, clientY);
    const hx = Math.floor(ui.w / 2 - 91), hy = ui.h - 22;
    if (gy >= hy - 6 && gy <= hy + 26 && gx >= hx && gx < hx + 182) {
      const sel = clamp(Math.floor((gx - hx) / 20), 0, 8);
      if (sel !== g.player.inv.sel) { g.player.inv.sel = sel; Sound.click(); }
    }
  }

  // ---- movement stick -------------------------------------------------------
  const stickEl = $('#tstick'), knob = $('#tknob');
  let stickId = null, stickR = 1;

  const setMove = (nx, ny) => {
    g.touchMove.fwd = -ny; g.touchMove.strafe = nx;
    knob.style.transform = `translate(${(nx * stickR).toFixed(1)}px, ${(ny * stickR).toFixed(1)}px)`;
  };
  stickEl.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); Sound.init();
    try { stickEl.setPointerCapture(e.pointerId); } catch (err) { }
    stickId = e.pointerId;
    const r = stickEl.getBoundingClientRect();
    stickR = r.width * 0.33;
    applyStick(e);
  });
  stickEl.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) { e.preventDefault(); applyStick(e); } });
  const stickEnd = (e) => {
    if (e.pointerId !== stickId) return;
    e.preventDefault(); stickId = null; setMove(0, 0);
    knob.style.transition = 'transform .12s ease-out';
    knob.style.transform = 'translate(0px, 0px)';
  };
  stickEl.addEventListener('pointerup', stickEnd);
  stickEl.addEventListener('pointercancel', stickEnd);
  stickEl.addEventListener('lostpointercapture', stickEnd);
  // Losing focus must never leave the player walking / jumping / mining.
  const resetTouchState = () => {
    stickId = null;
    g.touchMove.fwd = 0; g.touchMove.strafe = 0;
    knob.style.transition = 'none';
    knob.style.transform = 'translate(0px, 0px)';
    g.keys.Space = false; g.keys.ShiftLeft = false; g.keys.ShiftRight = false;
    g.mouseBtn[0] = false; g.mouseBtn[2] = false;
    g.sprintToggle = false;
  };
  window.addEventListener('blur', resetTouchState);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetTouchState(); });
  function applyStick(e) {
    const r = stickEl.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / stickR;
    let dy = (e.clientY - (r.top + r.height / 2)) / stickR;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    if (len < 0.18) { dx = 0; dy = 0; }
    knob.style.transition = 'none';
    setMove(dx, dy);
  }

  // ---- action buttons -------------------------------------------------------
  // mine: hold to keep breaking / attacking (same flags as the left mouse button)
  press($('#tmine'), () => {
    g.mouseBtn[0] = true; g.mouseClicked0 = true; g.attackCd = Math.min(g.attackCd, 0);
    if (!g.targetEntity && !g.target) g.player.swingT = 6;
  }, () => { g.mouseBtn[0] = false; });

  // use: hold to place / eat / draw a bow / open a block (right mouse button)
  press($('#tuse'), () => { g.mouseBtn[2] = true; g.useCd = 0; }, () => { g.mouseBtn[2] = false; });

  // jump: hold to jump; double-tap toggles flying in creative mode
  let lastJump = 0;
  press($('#tjump'), () => {
    const now = performance.now();
    if (g.mode === 'creative' && now - lastJump < 300) {
      g.player.flying = !g.player.flying; g.player.vel[1] = 0; lastJump = 0;
      Sound.click();
    } else lastJump = now;
    g.keys.Space = true;
  }, () => { g.keys.Space = false; });

  tap($('#tsneak'), () => { g.keys.ShiftLeft = !g.keys.ShiftLeft; if (!g.keys.ShiftLeft) g.keys.ShiftRight = false; });
  tap($('#tsprint'), () => { g.sprintToggle = !g.sprintToggle; });

  // ---- top bar --------------------------------------------------------------
  const escScreen = () => {
    if (ui.screen) {
      if (ui.screen.onEsc) ui.screen.onEsc();
      else if (g.state === 'play' && !(ui.screen instanceof DeathScreen)) ui.close();
    } else if (g.state === 'play') ui.open(new PauseScreen(g));
  };
  tap($('#tpause'), escScreen);
  tap($('#tinv'), () => {
    if (ui.screen) return;
    if (g.state !== 'play') return;
    ui.open(g.mode === 'creative' ? new CreativeScreen(g) : new CraftingScreen(g, 2));
  });
  const chatBtn = $('#tchat');
  if (chatBtn) tap(chatBtn, () => {
    if (ui.screen || g.state !== 'play') return;
    ui.open(new ChatScreen(g));
  });
  tap($('#tcam'), () => { if (g.state === 'play') g.perspective = (g.perspective + 1) % 3; });
  tap($('#tfly'), () => {
    const p = g.player;
    if (!p || g.mode !== 'creative') return;
    p.flying = !p.flying; p.vel[1] = 0; Sound.click();
  });
  tap($('#talt'), () => { altClick = !altClick; Sound.click(); syncState(); });

  // make sure a stray touch never scrolls / zooms the page
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.target === canvas || root.contains(e.target)) e.preventDefault(); }, { passive: false });

  syncState();
  ui.message('已启用触屏操作：左摇杆移动，拖动屏幕环视，右下按钮挖掘/放置', '#AAAAFF');
}
