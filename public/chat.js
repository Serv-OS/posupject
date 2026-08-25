/* ServOS support chat widget.
 *
 * Embed on any site with one line:
 *   <script src="https://posupcrm.vercel.app/chat.js" data-site-key="KEY" defer></script>
 *
 * Modes:
 *   popup  (default) — bubble bottom-right, opens on click
 *   inline           — always open, fills data-target (for a POS screen)
 *
 * Everything renders inside a shadow root so the host page's CSS can never
 * break it, and ours can never leak out.
 */
(function () {
  'use strict';

  var API = 'https://xvtzxlyjasdmwxqchwmm.supabase.co/functions/v1/chat';

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();

  var cfg = {
    siteKey: script.getAttribute('data-site-key') || '',
    mode: (script.getAttribute('data-mode') || 'popup').toLowerCase(),
    target: script.getAttribute('data-target') || '',
    title: script.getAttribute('data-title') || 'Support',
    accent: script.getAttribute('data-accent') || '#15C26A',
    api: script.getAttribute('data-api') || API,
    open: script.getAttribute('data-open') === 'true',
  };

  if (!cfg.siteKey) { console.error('[servos-chat] missing data-site-key'); return; }

  // One session per tab: a refresh keeps the thread, a new tab starts fresh.
  var SKEY = 'servos_chat_session_' + cfg.siteKey;
  var sessionId = null;
  try { sessionId = sessionStorage.getItem(SKEY); } catch (e) { /* private mode */ }

  var host = document.createElement('div');
  host.setAttribute('data-servos-chat', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var inline = cfg.mode === 'inline';
  if (inline) host.style.cssText = 'display:block;height:100%;min-height:0;';
  var mount = null;
  if (inline) {
    mount = cfg.target ? document.querySelector(cfg.target) : null;
    if (!mount) { mount = document.createElement('div'); document.body.appendChild(mount); }
    mount.appendChild(host);
  } else {
    document.body.appendChild(host);
  }

  root.innerHTML = [
    '<style>',
    ':host, * { box-sizing: border-box; }',
    '.wrap { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '        color: #16211c; }',
    // floating bubble
    '.bubble { position: fixed; right: 20px; bottom: 20px; width: 58px; height: 58px; border-radius: 50%;',
    '  border: 0; cursor: pointer; background: var(--acc); color: #fff; font-size: 25px; z-index: 2147483000;',
    '  box-shadow: 0 8px 26px rgba(0,0,0,.24); transition: transform .15s ease; }',
    '.bubble:hover { transform: scale(1.06); }',
    '.bubble .dot { position:absolute; top:-2px; right:-2px; width:14px; height:14px; border-radius:50%;',
    '  background:#e5484d; border:2px solid #fff; display:none; }',
    // panel
    '.panel { position: fixed; right: 20px; bottom: 88px; width: 380px; max-width: calc(100vw - 32px);',
    '  height: 560px; max-height: calc(100vh - 120px); background: #fff; border-radius: 18px;',
    '  box-shadow: 0 20px 60px rgba(0,0,0,.26); display: none; flex-direction: column; overflow: hidden;',
    '  z-index: 2147483000; }',
    '.panel.open { display: flex; }',
    // inline mode fills its container instead of floating
    '.inline { height: 100%; min-height: 0; }',
    '.inline .panel { position: static; right:auto; bottom:auto; width:100%; height:100%;',
    '  max-width:none; max-height:none; border-radius:0; box-shadow:none; display:flex; }',
    '.inline .bubble { display: none; }',
    '@media (max-width: 480px) {',
    '  .panel { top: 0; right: 0; bottom: 0; left: 0; width: auto; max-width: none;',
    '    height: 100vh; height: 100dvh; max-height: 100dvh; border-radius: 0; }',
    // The bubble is the ONLY way to open the chat, and this used to hide it
    // outright below 480px — so on a phone the widget was invisible and could
    // not be opened. Hidden only while the full-screen panel covers it.
    '  .wrap.open .bubble { display: none; }',
    '  .bubble { right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); }',
    '}',
    '.head { background: var(--acc); color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }',
    '.head .t { font-weight: 700; font-size: 15px; }',
    '.head .s { font-size: 12px; opacity: .85; }',
    '.x { margin-left: auto; background: rgba(255,255,255,.18); border: 0; color: #fff; width: 28px; height: 28px;',
    '  border-radius: 8px; cursor: pointer; font-size: 16px; line-height: 1; }',
    '.inline .x { display: none; }',
    '@media (max-width: 480px) { .inline .x { display: block; } .wrap.inline .x { display: none; } }',
    // A flex child defaults to min-height:auto, so it grows to fit its content
    // and gets clipped by the panel instead of scrolling. min-height:0 is what
    // actually makes the message list scrollable.
    '.msgs { flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;',
    '  overscroll-behavior: contain; padding: 16px; background: #f6f8f7; }',
    '.m { max-width: 84%; padding: 10px 13px; border-radius: 14px; margin-bottom: 10px; white-space: pre-wrap;',
    '  word-wrap: break-word; font-size: 14.5px; }',
    '.m.bot { background: #fff; border: 1px solid #e6ebe8; border-bottom-left-radius: 5px; }',
    '.m.me { background: var(--acc); color: #fff; margin-left: auto; border-bottom-right-radius: 5px; }',
    '.m.esc { background: #fff8e6; border: 1px solid #f0d089; }',
    '.typing { display: flex; gap: 4px; padding: 12px 14px; }',
    '.typing i { width: 7px; height: 7px; border-radius: 50%; background: #b9c3bd; animation: b 1.2s infinite; }',
    '.typing i:nth-child(2){ animation-delay:.2s } .typing i:nth-child(3){ animation-delay:.4s }',
    '@keyframes b { 0%,60%,100%{opacity:.3; transform:translateY(0)} 30%{opacity:1; transform:translateY(-4px)} }',
    '.foot { border-top: 1px solid #e6ebe8; padding: 10px; display: flex; gap: 8px; background: #fff;',
    '  flex: 0 0 auto; padding-bottom: calc(10px + env(safe-area-inset-bottom)); }',
    'textarea { flex: 1; resize: none; border: 1px solid #dfe6e2; border-radius: 12px; padding: 10px 12px;',
    '  font: inherit; font-size: 14.5px; max-height: 120px; outline: none; }',
    'textarea:focus { border-color: var(--acc); }',
    '.send { background: var(--acc); color: #fff; border: 0; border-radius: 12px; padding: 0 16px; cursor: pointer;',
    '  font-weight: 600; font-size: 14px; }',
    '.send:disabled { opacity: .45; cursor: default; }',
    '.err { color: #b4232a; font-size: 12.5px; padding: 0 16px 8px; }',
    '</style>',
    '<div class="wrap' + (inline ? ' inline' : '') + '">',
    '  <button class="bubble" aria-label="Open support chat">💬<span class="dot"></span></button>',
    '  <div class="panel" role="dialog" aria-label="Support chat">',
    '    <div class="head"><div><div class="t"></div><div class="s">We usually reply in a few minutes</div></div>',
    '      <button class="x" aria-label="Close">✕</button></div>',
    '    <div class="msgs"></div>',
    '    <div class="err" style="display:none"></div>',
    '    <div class="foot">',
    '      <textarea rows="1" placeholder="Type your message…" aria-label="Message"></textarea>',
    '      <button class="send">Send</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n');

  var $ = function (s) { return root.querySelector(s); };
  var wrap = $('.wrap'), panel = $('.panel'), msgs = $('.msgs'), ta = $('textarea'),
      sendBtn = $('.send'), bubble = $('.bubble'), errEl = $('.err');
  wrap.style.setProperty('--acc', cfg.accent);
  $('.head .t').textContent = cfg.title;

  function scroll() { msgs.scrollTop = msgs.scrollHeight; }

  function add(text, who, escalated) {
    var d = document.createElement('div');
    d.className = 'm ' + (who === 'me' ? 'me' : escalated ? 'bot esc' : 'bot');
    d.textContent = text;
    msgs.appendChild(d);
    scroll();
  }

  var typingEl = null;
  function typing(on) {
    if (on && !typingEl) {
      typingEl = document.createElement('div');
      typingEl.className = 'm bot typing';
      typingEl.innerHTML = '<i></i><i></i><i></i>';
      msgs.appendChild(typingEl); scroll();
    } else if (!on && typingEl) { typingEl.remove(); typingEl = null; }
  }

  function showErr(m) {
    errEl.textContent = m || '';
    errEl.style.display = m ? 'block' : 'none';
  }

  var busy = false;
  function post(message) {
    if (busy) return;
    busy = true; sendBtn.disabled = true; showErr('');
    typing(true);
    return fetch(cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_key: cfg.siteKey, session_id: sessionId, message: message || undefined }),
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        typing(false);
        if (!res.ok) { showErr(res.b && res.b.error ? res.b.error : 'Something went wrong.'); return; }
        if (res.b.session_id) {
          sessionId = res.b.session_id;
          try { sessionStorage.setItem(SKEY, sessionId); } catch (e) {}
        }
        if (res.b.reply) add(res.b.reply, 'bot', res.b.escalated);
      })
      .catch(function () { typing(false); showErr("Can't reach support right now — please try again."); })
      .then(function () { busy = false; sendBtn.disabled = false; });
  }

  function send() {
    var v = ta.value.trim();
    if (!v || busy) return;
    add(v, 'me');
    ta.value = ''; ta.style.height = 'auto';
    post(v);
  }

  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  ta.addEventListener('input', function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  });

  var started = false;
  function openPanel() {
    panel.classList.add('open');
    wrap.classList.add('open');
    if (!started) {
      started = true;
      // Only ask the server to open a conversation when there isn't one. With a
      // session already in hand (reopened panel, page refresh) a message-less
      // post is rejected as empty, which surfaced as a red error to the user.
      if (sessionId) add('Hi again — carry on where you left off, or tell me what you need.', 'bot');
      else post(null);
    }
    setTimeout(function () { ta.focus(); }, 60);
  }
  // .wrap carries the open state too, because the bubble sits BEFORE the panel
  // in the DOM and CSS cannot look backwards at a sibling.
  function closePanel() { panel.classList.remove('open'); wrap.classList.remove('open'); }
  bubble.addEventListener('click', function () {
    panel.classList.contains('open') ? closePanel() : openPanel();
  });
  $('.x').addEventListener('click', closePanel);

  if (inline || cfg.open) openPanel();
})();
