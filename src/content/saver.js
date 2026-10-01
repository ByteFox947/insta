/*
 * Save jobs: walk a profile (or a single post), work out file names, skip
 * files that already exist in Bunny, and hand each file to the uploader page.
 *
 * Bunny layout:  {folder}/{username}/posts/2026-09-30_<code>_1.jpg
 *                {folder}/{username}/reels/2026-09-30_<code>_1.mp4
 *                ...plus an optional 2026-09-30_<code>.json with caption/info.
 */
(() => {
  const root = (globalThis.IGBunny = globalThis.IGBunny || {});
  if (root.saver) return;

  const { ig, settings: Settings } = root;
  // How long to wait before each retry, per kind of Instagram problem.
  // "limited" = Instagram answered with its home page instead of data, which
  // it does while limiting an account; it clears up after a pause.
  const RETRY_WAITS_SEC = {
    network: [5, 15],
    server: [10, 30],
    rate_limit: [60, 120, 240],
    limited: [120, 300, 900],
  };
  const WAIT_LABELS = {
    rate_limit: 'Instagram rate limit, waiting',
    limited: 'Instagram is limiting your account, waiting',
  };
  const ONLY_NEW_STOP_AFTER = 12; // this many already-saved posts in a row = caught up
  const RELOADED_MESSAGE = 'The extension was updated or reloaded. Refresh this Instagram tab and try again.';

  class StopError extends Error {
    constructor() {
      super('Stopped');
      this.name = 'StopError';
    }
  }

  class Job {
    constructor(onUpdate) {
      this.onUpdate = onUpdate || (() => {});
      this.stopRequested = false;
      this.total = null;
      this.stats = { posts: 0, uploaded: 0, skipped: 0, failed: 0, bytes: 0 };
      this.wakers = new Set(); // pending sleeps, resolved early by stop()
    }

    stop() {
      this.stopRequested = true;
      for (const wake of [...this.wakers]) wake();
      this.update({ status: 'Stopping after the current file…' });
    }

    checkStop() {
      if (this.stopRequested) throw new StopError();
    }

    update(patch = {}) {
      this.onUpdate({ ...patch, stats: { ...this.stats }, total: this.total });
    }

    log(text, level = 'info') {
      this.update({ log: { text, level } });
    }

    // One timer per wait, never a chain of short ones: Chrome slows chained
    // timers in background tabs to about one run per minute, which would make
    // a job crawl while you work in another tab.
    async sleep(ms) {
      this.checkStop();
      await new Promise((resolve) => {
        let timer = null;
        const wake = () => {
          clearTimeout(timer);
          this.wakers.delete(wake);
          resolve();
        };
        timer = setTimeout(wake, Math.max(0, ms));
        this.wakers.add(wake);
      });
      this.checkStop();
    }

    async countdown(seconds, label) {
      const end = Date.now() + seconds * 1000;
      const show = () => this.update({ status: `${label} (${formatDuration((end - Date.now()) / 1000)})` });
      show();
      const ticker = setInterval(show, 1000); // display only; may tick slower in a background tab
      try {
        await this.sleep(seconds * 1000);
      } finally {
        clearInterval(ticker);
      }
    }
  }

  // ---- Messaging ------------------------------------------------------------

  const contextGone = (error) => /context invalidated/i.test(String(error?.message));

  async function sendToBackground(type, payload = {}) {
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ target: 'background', type, ...payload });
    } catch (error) {
      throw new Error(contextGone(error) ? RELOADED_MESSAGE : error.message);
    }
    if (!reply?.ok) throw new Error(reply?.error || 'The extension did not respond.');
    return reply;
  }

  async function uploader(type, payload = {}) {
    for (let attempt = 0; ; attempt++) {
      let reply;
      try {
        reply = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
      } catch (error) {
        if (contextGone(error)) throw new Error(RELOADED_MESSAGE);
        reply = undefined; // uploader page isn't running
      }
      if (reply === undefined) {
        if (attempt >= 2) throw new Error('The uploader is not responding. Try reloading the extension.');
        await sendToBackground('ensure-uploader');
        continue;
      }
      if (!reply.ok) {
        const error = new Error(reply.error || 'Upload failed.');
        error.fatal = Boolean(reply.fatal);
        throw error;
      }
      return reply;
    }
  }

  async function loadReadySettings() {
    const status = await sendToBackground('get-status');
    if (!status.configured) {
      const error = new Error('Connect your Bunny storage zone first: open the settings (gear icon) and fill them in.');
      error.fatal = true;
      throw error;
    }
    return Settings.normalize(status.settings);
  }

  // ---- Helpers --------------------------------------------------------------

  const joinPath = (...parts) => parts.filter(Boolean).join('/');
  const safeSegment = (text) => String(text).replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = n / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  function summarize(stats) {
    return `${stats.uploaded} file(s) saved (${formatBytes(stats.bytes)}), ${stats.skipped} already there, ${stats.failed} failed.`;
  }

  const isLimit = (error) => error?.kind === 'limited' || error?.kind === 'rate_limit';

  /** Final message for a failed job. */
  function describeError(error) {
    if (isLimit(error) && error.exhausted) {
      return `${error.message} It was still limited after waiting, so the job stopped. ` +
        'Try again in about an hour; files already in Bunny are skipped.';
    }
    return error?.message || String(error);
  }

  // Retries temporary Instagram problems with waits from RETRY_WAITS_SEC.
  // Each wait is one stoppable timer, so it also works in a background tab.
  async function igRetry(job, fn) {
    const used = {};
    for (;;) {
      job.checkStop();
      try {
        return await fn();
      } catch (error) {
        const kind = error?.kind;
        const waits = RETRY_WAITS_SEC[kind];
        if (!waits) throw error;
        const attempt = used[kind] || 0;
        if (attempt >= waits.length) {
          error.exhausted = true;
          throw error;
        }
        used[kind] = attempt + 1;
        const seconds = waits[attempt];
        job.log(`${error.message} Trying again in ${formatDuration(seconds)}.`, 'warn');
        if (error.detail) job.log(`Details: ${error.detail}`, 'warn');
        if (WAIT_LABELS[kind]) await job.countdown(seconds, WAIT_LABELS[kind]);
        else await job.sleep(seconds * 1000);
      }
    }
  }

  // Keeps 1x-2x the configured pause between Instagram requests (6-12 s by
  // default, like gallery-dl), so a job looks less like a bot.
  async function withPacing(job, settings, fn) {
    const baseMs = settings.requestDelaySec * 1000;
    ig.setPacing({ gapMs: () => Math.round(baseMs * (1 + Math.random())), sleep: (ms) => job.sleep(ms) });
    try {
      return await fn();
    } finally {
      ig.setPacing(null);
    }
  }

  // Caches the Bunny directory listings used for "skip files that exist".
  function makeContext(settings) {
    const listings = new Map();
    return {
      settings,
      async existing(dir) {
        if (!settings.skipExisting) return new Set();
        if (!listings.has(dir)) {
          const pending = uploader('list', { dir }).then((reply) => new Set(reply.names));
          listings.set(dir, pending);
          pending.catch(() => listings.delete(dir));
        }
        return listings.get(dir);
      },
    };
  }

  // ---- Saving -----------------------------------------------------------------

  // `folderUser` is the profile being saved, so collab posts owned by someone
  // else still land in that profile's folder.
  async function processPost(job, ctx, item, folder, folderUser) {
    const { settings } = ctx;
    const post = ig.parsePost(item);
    const username = safeSegment(folderUser || post.username || 'unknown');
    const dir = joinPath(settings.folder, username, folder);
    const existing = await ctx.existing(dir);
    const takenAt = post.takenAt ? new Date(post.takenAt * 1000) : null;
    const base = `${takenAt ? takenAt.toISOString().slice(0, 10) : 'undated'}_${post.code}`;
    const result = { uploaded: 0, skipped: 0, failed: 0 };
    const files = [];

    if (!post.files.length) job.log(`${post.code}: nothing downloadable in this post.`, 'warn');

    for (const file of post.files) {
      job.checkStop();
      const name = `${base}_${file.index}.${file.ext}`;
      const path = `${dir}/${name}`;
      files.push({
        name,
        type: file.kind,
        width: file.width,
        height: file.height,
        url: Settings.publicUrl(settings.pullZoneUrl, path) || undefined,
      });

      if (settings.skipExisting && existing.has(name)) {
        result.skipped++;
        job.stats.skipped++;
        continue;
      }

      job.update({ current: `${folder}/${name}` });
      try {
        const reply = await uploader('transfer', { sourceUrl: file.url, path });
        existing.add(name);
        result.uploaded++;
        job.stats.uploaded++;
        job.stats.bytes += reply.bytes || 0;
        job.log(`Saved ${folder}/${name} (${formatBytes(reply.bytes)})`);
      } catch (error) {
        if (error.fatal) throw error;
        result.failed++;
        job.stats.failed++;
        job.log(`Failed ${folder}/${name}: ${error.message}`, 'error');
      }
    }

    // Caption + details, written only once every file of the post is safe in Bunny.
    const infoName = `${base}.json`;
    if (settings.saveInfoJson && post.files.length && !result.failed && !(settings.skipExisting && existing.has(infoName))) {
      const info = {
        id: post.id,
        shortcode: post.code,
        type: post.isReel ? 'reel' : 'post',
        url: post.url,
        username: post.username || username,
        takenAt: takenAt ? takenAt.toISOString() : null,
        caption: post.caption,
        likeCount: post.likeCount,
        commentCount: post.commentCount,
        playCount: post.playCount,
        files,
        savedAt: new Date().toISOString(),
      };
      try {
        await uploader('put-text', { path: `${dir}/${infoName}`, text: JSON.stringify(info, null, 2) });
        existing.add(infoName);
      } catch (error) {
        if (error.fatal) throw error;
        job.log(`Couldn't save ${infoName}: ${error.message}`, 'warn');
      }
    }

    job.stats.posts++;
    job.update({ current: '' });
    return { ...result, alreadySaved: result.skipped > 0 && result.uploaded === 0 && result.failed === 0 };
  }

  /**
   * options: { posts: bool, reels: bool, onlyNew: bool, limit: number (0 = all) }
   */
  async function saveProfile(username, options, job) {
    const settings = await loadReadySettings();
    await sendToBackground('ensure-uploader');
    await withPacing(job, settings, () => runProfile(username, options, job, settings));
  }

  async function runProfile(username, options, job, settings) {
    const retry = (fn) => igRetry(job, fn);

    job.update({ status: `Looking up @${username}…` });
    const user = await retry(() => ig.getUser(username));
    if (user.isPrivate && user.followedByViewer === false) {
      throw new Error(`@${user.username} is private and you don't follow them.`);
    }

    const ctx = makeContext(settings);
    const limit = options.limit > 0 ? Math.floor(options.limit) : Infinity;
    const limitTotal = Number.isFinite(limit) ? limit : null;
    const seen = new Set();
    job.total = options.posts && user.postCount ? Math.min(user.postCount, limit) : limitTotal;
    job.log(`Saving @${user.username} to ${joinPath(settings.zone, settings.folder, safeSegment(user.username))}/`);

    const runFeed = async (label, feed, folderFor) => {
      let alreadySavedInARow = 0;
      for await (const item of feed) {
        if (job.stats.posts >= limit) return;
        job.checkStop();
        const id = String(item.pk ?? item.id);
        if (seen.has(id)) continue;
        seen.add(id);
        const folder = folderFor(item);
        if (!folder) continue;

        const of = job.total ? ` of ~${job.total}` : '';
        job.update({ status: `${label}: post ${job.stats.posts + 1}${of}` });
        const result = await processPost(job, ctx, item, folder, user.username);

        alreadySavedInARow = result.alreadySaved ? alreadySavedInARow + 1 : 0;
        if (options.onlyNew && alreadySavedInARow >= ONLY_NEW_STOP_AFTER) {
          job.log(`${label}: reached posts that were already saved, moving on.`);
          return;
        }
      }
    };

    // If Instagram keeps limiting the posts list, still try the Reels tab
    // (a different endpoint) before giving up.
    let postsProblem = null;
    if (options.posts) {
      const folderFor = (item) => (item.product_type === 'clips' ? (options.reels ? 'reels' : null) : 'posts');
      try {
        await runFeed('Posts', ig.userPosts(user.id, { retry }), folderFor);
      } catch (error) {
        if (!(options.reels && isLimit(error))) throw error;
        postsProblem = error;
        job.log(`Posts skipped for now: ${error.message} Moving on to the Reels tab.`, 'warn');
      }
    }

    if (options.reels && job.stats.posts < limit) {
      if (options.posts) job.total = limitTotal; // the Reels tab has no known total
      try {
        await runFeed('Reels', ig.userReels(user.id, { retry }), () => 'reels');
      } catch (error) {
        const keepGoing = options.posts && !postsProblem && error?.kind &&
          !['login', 'checkpoint', 'rate_limit', 'limited', 'private'].includes(error.kind);
        if (!keepGoing) throw error;
        job.log(`Couldn't read the Reels tab (${error.message}). Reels shown in the main grid were still saved.`, 'warn');
      }
    }

    if (postsProblem) {
      const error = new ig.InstagramError(postsProblem.kind, `Reels are done, but posts were skipped. ${postsProblem.message}`, {
        status: postsProblem.status,
        detail: postsProblem.detail,
      });
      error.exhausted = true;
      throw error;
    }
  }

  async function savePost(shortcode, job) {
    const settings = await loadReadySettings();
    await sendToBackground('ensure-uploader');
    job.total = 1;
    job.update({ status: 'Reading the post…' });
    await withPacing(job, settings, async () => {
      const item = await igRetry(job, () => ig.getMedia(shortcode));
      const folder = item.product_type === 'clips' ? 'reels' : 'posts';
      job.update({ status: `Saving ${folder === 'reels' ? 'reel' : 'post'} ${item.code || shortcode}…` });
      await processPost(job, makeContext(settings), item, folder, item.user?.username);
    });
  }

  root.saver = {
    Job,
    StopError,
    WAITS: RETRY_WAITS_SEC, // tunable, e.g. by tests
    saveProfile,
    savePost,
    summarize,
    describeError,
    formatBytes,
    getStatus: () => sendToBackground('get-status'),
    openSettings: () => sendToBackground('open-options'),
  };
})();
