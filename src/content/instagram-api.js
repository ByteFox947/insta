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
  const PAGE_SIZE = 12; // same page size the website uses
  const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const USER_CACHE_KEY = 'igUserCache';

  let wwwClaim = readSessionStorage('www-claim-v2') || '0';

  class InstagramError extends Error {
    /** kind: login | checkpoint | rate_limit | not_found | private | network | api */
    constructor(kind, message, status) {
      super(message);
      this.name = 'InstagramError';
      this.kind = kind;
      this.status = status;
    }
  }

  function readSessionStorage(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function withoutEmpty(values) {
    return Object.entries(values || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  }

  async function request(path, { method = 'GET', params, form } = {}) {
    const url = new URL(path, ORIGIN);
    for (const [key, value] of withoutEmpty(params)) url.searchParams.set(key, String(value));

    const headers = {
      Accept: '*/*',
      'X-IG-App-ID': APP_ID,
      'X-ASBD-ID': ASBD_ID,
      'X-IG-WWW-Claim': wwwClaim,
      'X-Requested-With': 'XMLHttpRequest',
    };
    const token = csrfToken();
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

    if (response.redirected && /\/challenge\//.test(response.url)) {
      throw new InstagramError('checkpoint', 'Instagram wants you to confirm your account. Finish the check on instagram.com, then try again.');
    }
    if (response.redirected && /\/accounts\/login/.test(response.url)) {
      throw new InstagramError('login', 'Log in to Instagram in this browser first.');
    }

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const message = String(data?.message || '');
    const status = response.status;

    if (status === 429 || /wait a few minutes|too many requests|rate.?limit/i.test(message)) {
      throw new InstagramError('rate_limit', 'Instagram is asking us to slow down.', status);
    }
    if (/checkpoint_required|challenge_required/.test(message) || data?.checkpoint_url) {
      throw new InstagramError('checkpoint', 'Instagram wants you to confirm your account. Finish the check on instagram.com, then try again.', status);
    }
    if (data?.require_login || message === 'login_required' || status === 401) {
      throw new InstagramError('login', 'Log in to Instagram in this browser first.', status);
    }
    if (/not authorized to view/i.test(message)) {
      throw new InstagramError('private', "This account is private and you don't follow it.", status);
    }
    if (status === 404) throw new InstagramError('not_found', 'Instagram says this does not exist.', status);
    if (!response.ok || data?.status === 'fail') {
      throw new InstagramError('api', message ? `Instagram error: ${message}` : `Instagram returned HTTP ${status}.`, status);
    }
    if (!data) {
      throw new InstagramError('api', 'Instagram returned a web page instead of data. Are you logged in?', status);
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

  function isFatal(error) {
    return error?.kind === 'login' || error?.kind === 'checkpoint';
  }

  /** Resolves a username to { id, username, isPrivate, followedByViewer, postCount }. */
  async function getUser(username) {
    const wanted = username.toLowerCase();
    const errors = [];

    try {
      const data = await request('/api/v1/users/web_profile_info/', { params: { username } });
      const u = data?.data?.user;
      if (u?.id) {
        const user = {
          id: String(u.id),
          username: u.username || username,
          isPrivate: Boolean(u.is_private),
          followedByViewer: u.followed_by_viewer,
          postCount: u.edge_owner_to_timeline_media?.count ?? null,
        };
        await rememberUser(user);
        return user;
      }
    } catch (error) {
      if (isFatal(error)) throw error;
      errors.push(error);
    }

    // Fallback used by gallery-dl since web_profile_info is often rate-limited.
    try {
      const data = await request('/web/search/topsearch/', { params: { query: username } });
      const hit = (data?.users || []).map((entry) => entry?.user).find((u) => u?.username?.toLowerCase() === wanted);
      const id = hit && (hit.pk || hit.pk_id || hit.id);
      if (id) {
        const user = {
          id: String(id),
          username: hit.username,
          isPrivate: Boolean(hit.is_private),
          followedByViewer: undefined,
          postCount: null,
        };
        await rememberUser(user);
        return user;
      }
    } catch (error) {
      if (isFatal(error)) throw error;
      errors.push(error);
    }

    const cached = (await readUserCache())[wanted];
    if (cached?.id) return { ...cached, isPrivate: false, followedByViewer: undefined, postCount: null };

    throw errors.find((e) => e.kind === 'rate_limit') || errors.find((e) => e.kind !== 'not_found') ||
      new InstagramError('not_found', `Couldn't find @${username}.`);
  }

  // ---- Feeds ---------------------------------------------------------------

  /**
   * Main profile grid (photos, videos, carousels and reels shared to the grid).
   * `pace` is awaited between pages, `retry` wraps each request.
   */
  async function* userPosts(userId, { pace, retry }) {
    let maxId = null;
    for (let page = 0; ; page++) {
      if (page > 0) await pace();
      const data = await retry(() =>
        request(`/api/v1/feed/user/${encodeURIComponent(userId)}/`, { params: { count: PAGE_SIZE, max_id: maxId } }),
      );
      for (const item of data.items || []) yield item;
      if (!data.more_available || !data.next_max_id || data.next_max_id === maxId) return;
      maxId = data.next_max_id;
    }
  }

  /** Everything on the profile's Reels tab. */
  async function* userReels(userId, { pace, retry }) {
    let maxId = null;
    for (let page = 0; ; page++) {
      if (page > 0) await pace();
      const data = await retry(() =>
        request('/api/v1/clips/user/', {
          method: 'POST',
          form: { target_user_id: userId, page_size: PAGE_SIZE, include_feed_video: 'true', max_id: maxId },
        }),
      );
      for (const entry of data.items || []) if (entry?.media) yield entry.media;
      const paging = data.paging_info || {};
      if (!paging.more_available || !paging.max_id || paging.max_id === maxId) return;
      maxId = paging.max_id;
    }
  }

  async function getMedia(shortcode) {
    const data = await request(`/api/v1/media/${mediaIdFromShortcode(shortcode)}/info/`);
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
    getUser,
    userPosts,
    userReels,
    getMedia,
    parsePost,
    mediaIdFromShortcode,
    shortcodeFromMediaId,
  };
})();
