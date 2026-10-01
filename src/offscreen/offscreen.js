/*
 * Hidden uploader page (offscreen document).
 *
 * Downloads a media file from Instagram's CDN into memory and PUTs it to the
 * Bunny Storage HTTP API. Nothing is written to disk. The storage password is
 * requested from the service worker and never reaches the Instagram tab.
 */
const Settings = globalThis.IGBunny.settings;

const MEDIA_HOSTS = [/(^|\.)cdninstagram\.com$/i, /(^|\.)fbcdn\.net$/i];
const RETRY_DELAYS_MS = [2000, 6000];
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

let credentialCache = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class UploadError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal; // true = stop the whole job (e.g. wrong password)
  }
}

async function getCredentials() {
  if (credentialCache && Date.now() - credentialCache.at < 5000) return credentialCache.value;
  const reply = await chrome.runtime.sendMessage({ target: 'background', type: 'get-bunny-credentials' });
  if (!reply?.ok) throw new UploadError(reply?.error || 'Could not read the Bunny settings.', { fatal: true });
  if (!reply.zone || !reply.password) {
    throw new UploadError('Bunny Storage is not set up yet. Open the extension settings.', { fatal: true });
  }
  credentialCache = { value: reply, at: Date.now() };
  return reply;
}

function bunnyError(status, action) {
  if (status === 401 || status === 403) {
    return new UploadError(
      `Bunny rejected the request (HTTP ${status}). Check the storage zone name, password and region in the extension settings.`,
      { fatal: true },
    );
  }
  if (status === 400) return new UploadError(`Bunny could not ${action} (HTTP 400: invalid path or checksum).`);
  return new UploadError(`Bunny could not ${action} (HTTP ${status}).`);
}

async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) throw new UploadError(`Network error: ${error.message}`);
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!RETRY_STATUSES.has(response.status) || attempt >= RETRY_DELAYS_MS.length) return response;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

async function sha256HexUpper(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function putBlob(creds, path, blob, contentType) {
  const headers = {
    AccessKey: creds.password,
    'Content-Type': 'application/octet-stream',
    Checksum: await sha256HexUpper(blob),
  };
  if (contentType) headers['Override-Content-Type'] = contentType;
  const response = await fetchWithRetry(Settings.storageUrl(creds.host, creds.zone, path), {
    method: 'PUT',
    headers,
    body: blob,
  });
  if (!response.ok) throw bunnyError(response.status, 'save the file');
}

function cleanDir(dir) {
  const trimmed = String(dir || '').replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

// Returns the names of the (non-empty) files directly inside `dir`.
async function list({ dir }) {
  const creds = await getCredentials();
  const response = await fetchWithRetry(Settings.storageUrl(creds.host, creds.zone, cleanDir(dir)), {
    headers: { AccessKey: creds.password, Accept: 'application/json' },
  });
  if (response.status === 404) return { names: [] };
  if (!response.ok) throw bunnyError(response.status, 'list files');
  const items = await response.json();
  return {
    names: (Array.isArray(items) ? items : [])
      .filter((item) => !item.IsDirectory && item.Length > 0)
      .map((item) => item.ObjectName),
  };
}

async function transfer({ sourceUrl, path }) {
  const source = new URL(sourceUrl);
  if (source.protocol !== 'https:' || !MEDIA_HOSTS.some((re) => re.test(source.hostname))) {
    throw new UploadError(`Refusing to download from ${source.hostname}.`);
  }
  const creds = await getCredentials();

  const media = await fetchWithRetry(source.href, { credentials: 'omit', cache: 'no-store' });
  if (!media.ok) throw new UploadError(`Instagram's CDN returned HTTP ${media.status} for this file.`);
  const blob = await media.blob();
  if (!blob.size) throw new UploadError('Instagram returned an empty file.');

  const type = (media.headers.get('content-type') || blob.type || '').split(';')[0].trim().toLowerCase();
  await putBlob(creds, path, blob, /^(image|video)\//.test(type) ? type : '');
  return { bytes: blob.size, contentType: type };
}

async function putText({ path, text, contentType = 'application/json' }) {
  const creds = await getCredentials();
  const blob = new Blob([text], { type: contentType });
  await putBlob(creds, path, blob, contentType);
  return { bytes: blob.size };
}

const HANDLERS = {
  ping: async () => ({}),
  list,
  transfer,
  'put-text': putText,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return undefined;
  const handler = HANDLERS[message.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown uploader request: ${message.type}` });
    return undefined;
  }
  handler(message).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: String(error?.message || error), fatal: Boolean(error?.fatal) }),
  );
  return true;
});
