/*
 * Content-script entry point: figures out what page you're on (profile,
 * post, reel), wires the panel buttons to save jobs, and keeps up with
 * Instagram's in-page navigation.
 */
(() => {
  const root = globalThis.IGBunny;
  if (!root?.panel || root.contentLoaded) return;
  root.contentLoaded = true;

  const { saver } = root;

  // First path segments that are Instagram pages, not usernames.
  const RESERVED = new Set([
    'about', 'accounts', 'api', 'ar', 'challenge', 'create', 'developer', 'direct', 'directory', 'emails',
    'explore', 'graphql', 'legal', 'lite', 'locations', 'meta-verified', 'nametag', 'notifications', 'oauth',
    'p', 'press', 'privacy', 'qr', 'reel', 'reels', 'session', 'share', 'stories', 'tags', 'terms', 'threads',
    'topics', 'tv', 'web', 'your_activity',
  ]);

  function parseRoute(pathname) {
    const post = pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})\/?/);
    if (post) return { type: 'post', shortcode: post[1] };
    const profile = pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?(?:(?:reels|tagged|saved|posts)\/?)?$/);
    if (profile && !RESERVED.has(profile[1].toLowerCase())) return { type: 'profile', username: profile[1] };
    return { type: 'other' };
  }

  let job = null;
  let lastPath = location.pathname;
  let route = parseRoute(lastPath);

  const panel = root.panel.create({
    formatBytes: saver.formatBytes,
    onOpenSettings: () => saver.openSettings().catch(() => {}),
    onStop: () => job?.stop(),
    onStart: (options) => startJob(options),
  });
  panel.setRoute(route);

  async function refreshConfigured() {
    try {
      panel.setConfigured((await saver.getStatus()).configured);
    } catch {
      panel.setConfigured(false);
    }
  }

  // Tells the service worker about the job so it can keep this tab from being
  // unloaded, show progress on the toolbar icon, and notify when it's done.
  function report(type, payload) {
    chrome.runtime.sendMessage({ target: 'background', type, ...payload }).catch(() => {});
  }

  async function startJob(options) {
    if (job) return;
    const target = route;
    if (target.type === 'other') return;

    const label = target.type === 'post' ? `post ${target.shortcode}` : `@${target.username}`;
    let lastReport = 0;
    job = new saver.Job((patch) => {
      panel.update(patch);
      if (patch.stats && Date.now() - lastReport >= 1000) {
        lastReport = Date.now();
        report('job-progress', { label, stats: patch.stats });
      }
    });
    panel.startJob();
    report('job-started', { label });

    let kind;
    let text;
    try {
      if (target.type === 'post') await saver.savePost(target.shortcode, job);
      else await saver.saveProfile(target.username, options, job);
      kind = job.stats.failed ? 'error' : 'done';
      text = `Done. ${saver.summarize(job.stats)}`;
    } catch (error) {
      if (error instanceof saver.StopError) {
        kind = 'stopped';
        text = `Stopped. ${saver.summarize(job.stats)}`;
      } else {
        kind = 'error';
        text = error.message;
        panel.update({ log: { text, level: 'error' } });
      }
    }
    panel.finishJob(kind, text);
    report('job-finished', { label, kind, text, stats: job.stats });
    job = null;
  }

  // Warn before closing or reloading the tab mid-job (that would stop it).
  window.addEventListener('beforeunload', (event) => {
    if (!job) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // Messages from the service worker (toolbar icon, job checks).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'job-status') {
      sendResponse({ running: Boolean(job) });
    } else if (message?.type === 'toggle-panel') {
      if (message.open) panel.open();
      else panel.toggle();
      sendResponse({ ok: true });
    }
    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.settings || changes.secret)) refreshConfigured();
  });

  // Instagram is a single-page app: watch the URL instead of page loads.
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) {
      // The extension was reloaded; this copy is orphaned.
      clearInterval(timer);
      panel.destroy();
      return;
    }
    if (!panel.isAttached()) panel.reattach();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      route = parseRoute(lastPath);
      panel.setRoute(route);
    }
  }, 700);

  refreshConfigured();
})();
