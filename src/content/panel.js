/*
 * Floating button + panel shown on instagram.com. Lives in a shadow root so
 * Instagram's CSS can't break it (and ours can't break Instagram).
 * This file only draws things; main.js decides what happens.
 */
(() => {
  const root = (globalThis.IGBunny = globalThis.IGBunny || {});
  if (root.panel) return;

  const HOST_ID = 'ig-bunny-saver-root';
  const MAX_LOG_LINES = 200;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    [hidden] { display: none !important; }
    .launcher {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
      width: 48px; height: 48px; border: 0; border-radius: 50%; cursor: pointer;
      background: linear-gradient(135deg, #f97316, #db2777); color: #fff;
      box-shadow: 0 6px 18px rgba(0,0,0,.25); display: grid; place-items: center;
    }
    .launcher:hover { filter: brightness(1.08); }
    .launcher svg { width: 24px; height: 24px; }
    .launcher.busy::after {
      content: ""; position: absolute; inset: -4px; border-radius: 50%;
      border: 3px solid transparent; border-top-color: #f97316; animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .panel {
      position: fixed; right: 20px; bottom: 80px; z-index: 2147483000;
      width: 340px; max-height: min(640px, calc(100vh - 110px)); overflow: auto;
      background: #fff; color: #111; border-radius: 14px; padding: 14px 16px 16px;
      box-shadow: 0 12px 36px rgba(0,0,0,.28); font-size: 13px; line-height: 1.4;
    }
    header { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
    header strong { flex: 1; font-size: 15px; }
    .icon { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 5px; border-radius: 6px; display: grid; place-items: center; }
    .icon:hover { background: rgba(127,127,127,.15); }
    .icon svg { width: 17px; height: 17px; }
    p { margin: 0 0 10px; }
    .where { font-weight: 600; font-size: 14px; }
    .hint { color: #666; }
    .options { display: grid; gap: 6px; margin: 0 0 12px; }
    .options label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .options .limit input { width: 72px; padding: 3px 6px; border: 1px solid #ccc; border-radius: 6px; font: inherit; color: inherit; background: transparent; }
    .options .limit span { color: #888; }
    button.primary, button.stop {
      width: 100%; border: 0; border-radius: 9px; padding: 9px 12px; cursor: pointer;
      font-weight: 600; font-size: 14px;
    }
    button.primary { background: #f97316; color: #fff; }
    button.primary:hover { background: #ea580c; }
    button.primary:disabled { background: #fdba74; cursor: not-allowed; }
    button.stop { background: rgba(127,127,127,.18); color: inherit; margin-top: 10px; }
    .job { margin-top: 14px; border-top: 1px solid rgba(127,127,127,.25); padding-top: 12px; }
    .status { font-weight: 600; }
    .status.done { color: #15803d; }
    .status.error { color: #b91c1c; }
    .current { color: #666; font-size: 12px; overflow-wrap: anywhere; min-height: 16px; }
    .bg-hint { margin: 10px 0 0; font-size: 12px; color: #666; }
    .bar { height: 6px; border-radius: 3px; background: rgba(127,127,127,.2); overflow: hidden; margin-bottom: 10px; }
    .fill { height: 100%; width: 0; background: linear-gradient(90deg, #f97316, #db2777); transition: width .3s; }
    .bar.indeterminate .fill { width: 30%; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; text-align: center; }
    .stats div { background: rgba(127,127,127,.1); border-radius: 8px; padding: 6px 2px; }
    .stats b { display: block; font-size: 15px; }
    .stats span { font-size: 11px; color: #777; }
    .log { list-style: none; margin: 10px 0 0; padding: 8px; max-height: 170px; overflow: auto; border-radius: 8px;
      background: rgba(127,127,127,.08); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .log:empty { display: none; }
    .log li { overflow-wrap: anywhere; }
    .log .warn { color: #b45309; }
    .log .error { color: #b91c1c; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1c1c1e; color: #f5f5f5; }
      .hint, .current, .bg-hint { color: #aaa; }
      .log .warn { color: #fbbf24; }
      .log .error, .status.error { color: #f87171; }
      .status.done { color: #4ade80; }
    }
  `;

  const TEMPLATE = `
    <button class="launcher" type="button" title="Save to Bunny Storage" aria-label="Save to Bunny Storage">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0-4.5-4.5M12 14l4.5-4.5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
        fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <section class="panel" role="dialog" aria-label="Save to Bunny Storage" hidden>
      <header>
        <strong>Save to Bunny</strong>
        <button class="icon settings" type="button" title="Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>
          </svg>
        </button>
        <button class="icon close" type="button" title="Close" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
      </header>
      <div class="setup" hidden>
        <p>Connect your Bunny storage zone first.</p>
        <button class="primary open-settings" type="button">Open settings</button>
      </div>
      <div class="context">
        <p class="where"></p>
        <p class="hint" hidden>Open a profile, post or reel to save it.</p>
        <div class="options" hidden>
          <label><input type="checkbox" name="posts" checked /> Posts (photos &amp; videos)</label>
          <label><input type="checkbox" name="reels" checked /> Reels</label>
          <label><input type="checkbox" name="onlyNew" /> Only new (stop at already-saved posts)</label>
          <label class="limit">Max posts <input type="number" name="limit" min="0" step="1" value="0" /> <span>0 = all</span></label>
        </div>
        <button class="primary start" type="button" hidden></button>
      </div>
      <div class="job" hidden>
        <p class="status"></p>
        <p class="current"></p>
        <div class="bar"><div class="fill"></div></div>
        <div class="stats">
          <div><b data-stat="uploaded">0</b><span>saved</span></div>
          <div><b data-stat="skipped">0</b><span>skipped</span></div>
          <div><b data-stat="failed">0</b><span>failed</span></div>
          <div><b data-stat="bytes">0 B</b><span>uploaded</span></div>
        </div>
        <p class="bg-hint">You can use other tabs meanwhile. Keep this tab open until it's done.</p>
        <button class="stop" type="button">Stop</button>
        <ol class="log"></ol>
      </div>
    </section>
  `;

  function create({ onStart, onStop, onOpenSettings, formatBytes }) {
    document.getElementById(HOST_ID)?.remove(); // leftover from an older copy of the extension

    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${STYLE}</style>${TEMPLATE}`;
    (document.body || document.documentElement).appendChild(host);

    const $ = (selector) => shadow.querySelector(selector);
    const el = {
      launcher: $('.launcher'),
      panel: $('.panel'),
      setup: $('.setup'),
      context: $('.context'),
      where: $('.where'),
      hint: $('.hint'),
      options: $('.options'),
      start: $('.start'),
      job: $('.job'),
      status: $('.status'),
      current: $('.current'),
      bar: $('.bar'),
      fill: $('.fill'),
      stop: $('.stop'),
      bgHint: $('.bg-hint'),
      log: $('.log'),
      posts: $('input[name="posts"]'),
      reels: $('input[name="reels"]'),
      onlyNew: $('input[name="onlyNew"]'),
      limit: $('input[name="limit"]'),
    };

    let route = { type: 'other' };
    let running = false;
    let configured = false;

    function refreshStartButton() {
      const profileNeedsChoice = route.type === 'profile' && !el.posts.checked && !el.reels.checked;
      el.start.disabled = running || !configured || profileNeedsChoice;
    }

    function render() {
      el.setup.hidden = configured;
      el.where.hidden = route.type === 'other';
      el.hint.hidden = route.type !== 'other';
      el.options.hidden = route.type !== 'profile' || running;
      el.start.hidden = route.type === 'other';
      if (route.type === 'post') {
        el.where.textContent = `Post ${route.shortcode}`;
        el.start.textContent = 'Save this post';
      } else if (route.type === 'profile') {
        el.where.textContent = `@${route.username}`;
        el.start.textContent = `Save all from @${route.username}`;
      }
      refreshStartButton();
    }

    function setStatus(text, kind = '') {
      el.status.textContent = text;
      el.status.className = `status ${kind}`.trim();
    }

    function setProgress(done, total) {
      const known = Number.isFinite(total) && total > 0;
      el.bar.classList.toggle('indeterminate', running && !known);
      el.fill.style.width = known ? `${Math.min(100, Math.round((done / total) * 100))}%` : running ? '' : '100%';
    }

    function addLog({ text, level }) {
      const li = document.createElement('li');
      li.className = level;
      li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
      el.log.appendChild(li);
      while (el.log.children.length > MAX_LOG_LINES) el.log.firstElementChild.remove();
      el.log.scrollTop = el.log.scrollHeight;
    }

    el.launcher.addEventListener('click', () => api.toggle());
    $('.close').addEventListener('click', () => api.close());
    $('.settings').addEventListener('click', () => onOpenSettings());
    $('.open-settings').addEventListener('click', () => onOpenSettings());
    el.posts.addEventListener('change', refreshStartButton);
    el.reels.addEventListener('change', refreshStartButton);
    el.stop.addEventListener('click', () => {
      el.stop.disabled = true;
      onStop();
    });
    el.start.addEventListener('click', () => {
      if (el.start.disabled) return;
      onStart({
        posts: el.posts.checked,
        reels: el.reels.checked,
        onlyNew: el.onlyNew.checked,
        limit: Math.max(0, Math.floor(Number(el.limit.value) || 0)),
      });
    });

    const api = {
      open() {
        el.panel.hidden = false;
      },
      close() {
        el.panel.hidden = true;
      },
      toggle() {
        el.panel.hidden = !el.panel.hidden;
      },
      setConfigured(value) {
        configured = Boolean(value);
        render();
      },
      setRoute(value) {
        route = value;
        render();
      },
      startJob() {
        running = true;
        el.log.textContent = '';
        el.job.hidden = false;
        el.stop.hidden = false;
        el.stop.disabled = false;
        el.bgHint.hidden = false;
        el.launcher.classList.add('busy');
        setStatus('Starting…');
        el.current.textContent = '';
        el.current.hidden = false;
        setProgress(0, null);
        api.update({ stats: { uploaded: 0, skipped: 0, failed: 0, bytes: 0, posts: 0 } });
        render();
        api.open();
      },
      update(patch) {
        if (patch.status !== undefined) setStatus(patch.status);
        if (patch.current !== undefined) el.current.textContent = patch.current;
        if (patch.log) addLog(patch.log);
        if (patch.stats) {
          for (const node of shadow.querySelectorAll('[data-stat]')) {
            const key = node.dataset.stat;
            node.textContent = key === 'bytes' ? formatBytes(patch.stats.bytes) : String(patch.stats[key] ?? 0);
          }
          setProgress(patch.stats.posts || 0, patch.total);
        }
      },
      finishJob(kind, text) {
        running = false;
        el.launcher.classList.remove('busy');
        el.stop.hidden = true;
        el.bgHint.hidden = true;
        el.current.hidden = true;
        setStatus(text, kind === 'done' ? 'done' : kind === 'error' ? 'error' : '');
        el.bar.classList.remove('indeterminate');
        el.fill.style.width = kind === 'done' ? '100%' : '0';
        render();
      },
      isAttached: () => host.isConnected,
      reattach() {
        (document.body || document.documentElement).appendChild(host);
      },
      destroy() {
        host.remove();
      },
    };

    render();
    return api;
  }

  root.panel = { create };
})();
