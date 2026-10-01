/*
 * Minimal client for the private JSON endpoints Instagram's own website uses.
 * Runs in the content script on www.instagram.com, so requests carry your
 * normal logged-in session. Only content you can already see is reachable.
 *
 * Instagram changes these endpoints from time to time. If saving breaks, this
 * file is the one to update.
 */
(() => {
  const root = (globalThis.IGBunny = globalThis.IGBunny || {});
  if (root.ig) return;

  const ORIGIN = 'https://www.instagram.com';
  const APP_ID = '936619743392459'; // Instagram web app ID
  const ASBD_ID = '129477';
  // Same page sizes as gallery-dl: fewer requests per profile = fewer limits.
  const FEED_PAGE_SIZE = 30;
  const REELS_PAGE_SIZE = 50;
  const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const USER_CACHE_KEY = 'igUserCache';

  const LOGIN_MESSAGE = 'Log in to Instagram in this browser first.';
  const LOGGED_OUT_MESSAGE =
    "Instagram didn't send any data, and this browser doesn't look logged in to Instagram. " +
    'Log in at instagram.com in this same Chrome profile, then try again.';
  const CHECKPOINT_MESSAGE =
    'Instagram wants you to confirm your account. Finish the check on instagram.com, then try again.';

  let wwwClaim = readSessionStorage('www-claim-v2') || '0';
  let pacing = null; // { gapMs(), sleep(ms) } while a save job runs
  let lastRequestAt = 0;

  class InstagramError extends Error {
    /**
     * kind: login | checkpoint | rate_limit | limited | server | not_found | private | network | api
     * "limited" means Instagram answered with a web page (usually its home
     * page) instead of data, which is what it does while limiting an account.
     */
    constructor(kind, message, { status, detail } = {}) {
      super(message);
      this.name = 'InstagramError';
      this.kind = kind;
      this.status = status;
      this.detail = detail || ''; // request + response summary, shown in the log
    }
  }

  function readSessionStorage(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function readCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  // ds_user_id is Instagram's script-readable "logged-in user" cookie
  // (sessionid itself is HttpOnly, so it can't be checked from here).
  function looksLoggedIn() {
    return /^\d+$/.test(readCookie('ds_user_id'));
  }

  function withoutEmpty(values) {
    return Object.entries(values || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  }

  function pathOf(href) {
    try {
      return new URL(href).pathname;
    } catch {
      return '?';
    }
  }

  // JSON, optionally behind the "for (;;);" guard some Meta endpoints use.
  function parseJson(text) {
    const body = String(text || '').replace(/^\s*for\s*\(;;\);/, '');
    if (!/^\s*[[{]/.test(body)) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  /** While a job runs, keeps a gap between Instagram requests. */
  function setPacing(value) {
    pacing = value;
  }

  async function paced(fn) {
    if (pacing) {
      const wait = lastRequestAt + pacing.gapMs() - Date.now();
      if (wait > 0) await pacing.sleep(wait);
    }
    lastRequestAt = Date.now();
    return fn();
  }

  /** `what` names the data in error messages, e.g. "the list of posts". */
  function request(path, { method = 'GET', params, form, what = 'the data' } = {}) {
    return paced(() => send(path, { method, params, form, what }));
  }

  async function send(path, { method, params, form, what }) {
    const url = new URL(path, ORIGIN);
    for (const [key, value] of withoutEmpty(params)) url.searchParams.set(key, String(value));

    const headers = {
      Accept: '*/*',
      'X-IG-App-ID': APP_ID,
      'X-ASBD-ID': ASBD_ID,
      'X-IG-WWW-Claim': wwwClaim,
      'X-Requested-With': 'XMLHttpRequest',
    };
    const token = readCookie('csrftoken');
    if (token) headers['X-CSRFToken'] = token;

    let body;
    if (form) {
      body = new URLSearchParams(withoutEmpty(form).map(([k, v]) => [k, String(v)]));
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    let response;
    try {
      response = await fetch(url.href, { method, headers, body, credentials: 'include' });
    } catch (error) {
      throw new InstagramError('network', `Couldn't reach Instagram (${error.message}).`);
    }

    const claim = response.headers.get('x-ig-set-www-claim');
    if (claim) wwwClaim = claim;

    const status = response.status;
    const finalPath = response.redirected ? pathOf(response.url) : '';
    const detail = `${method} ${url.pathname} → HTTP ${status}${finalPath ? ` after a redirect to ${finalPath}` : ''}`;
    const fail = (kind, message) => new InstagramError(kind, message, { status, detail });

    if (finalPath.startsWith('/challenge/')) throw fail('checkpoint', CHECKPOINT_MESSAGE);
    if (finalPath.startsWith('/accounts/login')) throw fail('login', LOGIN_MESSAGE);

    const data = parseJson(await response.text());
    const message = String(data?.message || '');

    if (status === 429 || /wait a few minutes|too many requests|rate.?limit/i.test(message)) {
      throw fail('rate_limit', 'Instagram is asking us to slow down.');
    }
    if (/checkpoint_required|challenge_required/.test(message) || data?.checkpoint_url) {
      throw fail('checkpoint', CHECKPOINT_MESSAGE);
    }
    if (data?.require_login || message === 'login_required' || status === 401) throw fail('login', LOGIN_MESSAGE);
    if (/not authorized to view/i.test(message)) throw fail('private', "This account is private and you don't follow it.");
    if (status === 404) throw fail('not_found', `Instagram couldn't find ${what}.`);
    if (status >= 500) throw fail('server', `Instagram had a server problem (HTTP ${status}) while loading ${what}.`);
    if (!data && response.ok) {
      // A web page instead of JSON. Instagram does this, usually by
      // redirecting to its home page, while it's limiting an account.
      if (!looksLoggedIn()) throw fail('login', LOGGED_OUT_MESSAGE);
      throw fail(
        'limited',
        finalPath === '/'
          ? `Instagram is temporarily limiting your account: it sent its home page instead of ${what}.`
          : `Instagram sent a web page instead of ${what}, which usually means it's temporarily limiting your account.`,
      );
    }
    if (!response.ok || data?.status === 'fail') {
      throw fail(
        'api',
        message ? `Instagram error while loading ${what}: ${message}` : `Instagram returned HTTP ${status} while loading ${what}.`,
      );
    }
    return data;
  }

  // ---- IDs -----------------------------------------------------------------

  function mediaIdFromShortcode(shortcode) {
    let code = String(shortcode);
    if (code.length > 28) code = code.slice(0, -28); // long private-share codes
    let id = 0n;
    for (const ch of code) {
      const digit = SHORTCODE_ALPHABET.indexOf(ch);
      if (digit < 0) throw new InstagramError('not_found', `"${shortcode}" is not a valid post code.`);
      id = id * 64n + BigInt(digit);
    }
    return id.toString();
  }

  function shortcodeFromMediaId(mediaId) {
    let id = BigInt(String(mediaId).split('_')[0]);
    let code = '';
    do {
      code = SHORTCODE_ALPHABET[Number(id % 64n)] + code;
      id /= 64n;
    } while (id > 0n);
    return code;
  }

  // ---- Users ---------------------------------------------------------------

  async function readUserCache() {
    try {
      return (await chrome.storage.local.get(USER_CACHE_KEY))[USER_CACHE_KEY] || {};
    } catch {
      return {};
    }
  }

  async function rememberUser(user) {
    try {
      const cache = await readUserCache();
      cache[user.username.toLowerCase()] = { id: user.id, username: user.username };
      await chrome.storage.local.set({ [USER_CACHE_KEY]: cache });
    } catch {
      // Cache is only an optimisation.
    }
  }

  const PROFILE_WHAT = 'the profile details';

  // gallery-dl's default since web_profile_info started hitting limits (Feb 2026).
  async function userFromSearch(username, wanted) {
    const data = await request('/web/search/topsearch/', { params: { query: username }, what: PROFILE_WHAT });
    const hit = (data?.users || []).map((entry) => entry?.user).find((u) => u?.username?.toLowerCase() === wanted);
    const id = hit && (hit.pk || hit.pk_id || hit.id);
    if (!id) return null;
    return { id: String(id), username: hit.username, isPrivate: Boolean(hit.is_private), followedByViewer: undefined, postCount: null };
  }

  async function userFromProfileInfo(username) {
    const data = await request('/api/v1/users/web_profile_info/', { params: { username }, what: PROFILE_WHAT });
    const u = data?.data?.user;
    if (!u?.id) return null;
    return {
      id: String(u.id),
      username: u.username || username,
      isPrivate: Boolean(u.is_private),
      followedByViewer: u.followed_by_viewer,
      postCount: u.edge_owner_to_timeline_media?.count ?? null,
    };
  }

  // Last resort (gallery-dl's "web" strategy): the profile page's HTML has the ID.
  async function userFromProfilePage(username, wanted) {
    const html = await paced(async () => {
      let response;
      try {
        response = await fetch(`${ORIGIN}/${encodeURIComponent(wanted)}/`, {
          credentials: 'include',
          headers: { Accept: 'text/html' },
        });
      } catch (error) {
        throw new InstagramError('network', `Couldn't reach Instagram (${error.message}).`);
      }
      if (response.status === 404) throw new InstagramError('not_found', `Couldn't find @${username}.`);
      return response.ok ? response.text() : '';
    });
    const match = html.match(/"profile_id":"(\d+)"/) || html.match(/"profilePage_(\d+)"/);
    return match ? { id: match[1], username, isPrivate: false, followedByViewer: undefined, postCount: null } : null;
  }

  function isFatal(error) {
    return error?.kind === 'login' || error?.kind === 'checkpoint';
  }

  /** Resolves a username to { id, username, isPrivate, followedByViewer, postCount }. */
  async function getUser(username) {
    const wanted = username.toLowerCase();

    // Known from an earlier run: no lookup request needed at all.
    const cached = (await readUserCache())[wanted];
    if (cached?.id) {
      return { id: cached.id, username: cached.username || username, isPrivate: false, followedByViewer: undefined, postCount: null };
    }

    const errors = [];
    for (const strategy of [userFromSearch, userFromProfileInfo, userFromProfilePage]) {
      try {
        const user = await strategy(username, wanted);
        if (user?.id) {
          await rememberUser(user);
          return user;
        }
      } catch (error) {
        if (!(error instanceof InstagramError) || isFatal(error)) throw error; // incl. "stopped"
        errors.push(error);
      }
    }

    throw errors.find((e) => e.kind === 'rate_limit' || e.kind === 'limited') ||
      errors.find((e) => e.kind !== 'not_found') ||
      new InstagramError('not_found', `Couldn't find @${username}.`);
  }

  // ---- Feeds ---------------------------------------------------------------

  /** Main profile grid (photos, videos, carousels and reels shared to the grid). */
  async function* userPosts(userId, { retry }) {
    let maxId = null;
    for (;;) {
      const data = await retry(() =>
        request(`/api/v1/feed/user/${encodeURIComponent(userId)}/`, {
          params: { count: FEED_PAGE_SIZE, max_id: maxId },
          what: 'the list of posts',
        }),
      );
      for (const item of data.items || []) yield item;
      if (!data.more_available || !data.next_max_id || data.next_max_id === maxId) return;
      maxId = data.next_max_id;
    }
  }

  /** Everything on the profile's Reels tab. */
  async function* userReels(userId, { retry }) {
    let maxId = null;
    for (;;) {
      const data = await retry(() =>
        request('/api/v1/clips/user/', {
          method: 'POST',
          form: { target_user_id: userId, page_size: REELS_PAGE_SIZE, include_feed_video: 'true', max_id: maxId },
          what: 'the Reels tab',
        }),
      );
      for (const entry of data.items || []) if (entry?.media) yield entry.media;
      const paging = data.paging_info || {};
      if (!paging.more_available || !paging.max_id || paging.max_id === maxId) return;
      maxId = paging.max_id;
    }
  }

  async function getMedia(shortcode) {
    const data = await request(`/api/v1/media/${mediaIdFromShortcode(shortcode)}/info/`, { what: 'the post details' });
    const item = data?.items?.[0];
    if (!item) throw new InstagramError('not_found', 'This post is not available.');
    return item;
  }

  // ---- Parsing -------------------------------------------------------------

  function pickBest(list, score) {
    let best = null;
    for (const entry of list || []) {
      if (entry?.url && (!best || score(entry) > score(best))) best = entry;
    }
    return best;
  }

  const area = (m) => (Number(m.width) || 0) * (Number(m.height) || 0);

  function extensionOf(url, fallback) {
    try {
      const u = new URL(url);
      let ext = (u.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase() || fallback;
      if (ext === 'jpeg') ext = 'jpg';
      if (ext === 'webp' && u.search.includes('stp=dst-jpg')) ext = 'jpg';
      return ['jpg', 'png', 'webp', 'heic', 'mp4', 'mov', 'm4v'].includes(ext) ? ext : fallback;
    } catch {
      return fallback;
    }
  }

  /** Turns an API media item into { id, code, isReel, takenAt, files: [...] }. */
  function parsePost(item) {
    const id = String(item.pk ?? String(item.id || '').split('_')[0]);
    const code = item.code || shortcodeFromMediaId(id);
    const isReel = item.product_type === 'clips';
    const nodes = item.carousel_media?.length ? item.carousel_media : [item];

    const files = [];
    nodes.forEach((node, index) => {
      // Highest resolution wins; for equal sizes prefer the higher "type" like gallery-dl does.
      const video = pickBest(node.video_versions, (v) => area(v) * 1000 + (Number(v.type) || 0));
      const image = pickBest(node.image_versions2?.candidates, area);
      const chosen = video || image;
      if (!chosen) return;
      files.push({
        index: index + 1,
        kind: video ? 'video' : 'image',
        url: chosen.url,
        width: Number(chosen.width) || null,
        height: Number(chosen.height) || null,
        ext: extensionOf(chosen.url, video ? 'mp4' : 'jpg'),
      });
    });

    return {
      id,
      code,
      isReel,
      takenAt: Number(item.taken_at) || null,
      username: item.user?.username || '',
      caption: item.caption?.text || '',
      likeCount: item.like_count ?? null,
      commentCount: item.comment_count ?? null,
      playCount: item.play_count ?? item.ig_play_count ?? null,
      url: `${ORIGIN}/${isReel ? 'reel' : 'p'}/${code}/`,
      files,
    };
  }

  root.ig = {
    InstagramError,
    request,
    setPacing,
    looksLoggedIn,
    getUser,
    userPosts,
    userReels,
    getMedia,
    parsePost,
    mediaIdFromShortcode,
    shortcodeFromMediaId,
  };
})();
