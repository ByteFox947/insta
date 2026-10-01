/*
 * Settings shared by the service worker, content scripts, options page and
 * uploader page. Loaded as a classic script everywhere, so it attaches itself
 * to globalThis.IGBunny instead of using ES module exports.
 *
 * Storage layout (chrome.storage.local, this device only, never synced):
 *   settings -> non-secret options (zone name, region, folder, ...)
 *   secret   -> { password } for the storage zone
 */
(() => {
  const root = (globalThis.IGBunny = globalThis.IGBunny || {});
  if (root.settings) return;

  // Primary storage regions and their HTTP API hostnames (from Bunny's SDK).
  const REGIONS = [
    { id: 'de', label: 'Falkenstein, Germany (default)', host: 'storage.bunnycdn.com' },
    { id: 'uk', label: 'London, UK', host: 'uk.storage.bunnycdn.com' },
    { id: 'se', label: 'Stockholm, Sweden', host: 'se.storage.bunnycdn.com' },
    { id: 'ny', label: 'New York, US', host: 'ny.storage.bunnycdn.com' },
    { id: 'la', label: 'Los Angeles, US', host: 'la.storage.bunnycdn.com' },
    { id: 'sg', label: 'Singapore', host: 'sg.storage.bunnycdn.com' },
    { id: 'syd', label: 'Sydney, Australia', host: 'syd.storage.bunnycdn.com' },
    { id: 'br', label: 'São Paulo, Brazil', host: 'br.storage.bunnycdn.com' },
    { id: 'jh', label: 'Johannesburg, South Africa', host: 'jh.storage.bunnycdn.com' },
  ];

  const DEFAULTS = Object.freeze({
    zone: '',
    region: 'de',
    folder: 'instagram',
    pullZoneUrl: '',
    skipExisting: true,
    saveInfoJson: true,
    requestDelaySec: 3,
  });

  function cleanZone(value) {
    return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  }

  // "a//b/../c " -> "a/b/c"; only safe characters survive.
  function cleanFolder(value) {
    return String(value ?? '')
      .split('/')
      .map((part) => part.trim().replace(/[^A-Za-z0-9._-]/g, '_'))
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
  }

  function cleanPullZoneUrl(value) {
    let text = String(value ?? '').trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
    try {
      return new URL(text).origin;
    } catch {
      return '';
    }
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    return {
      zone: cleanZone(s.zone),
      region: REGIONS.some((r) => r.id === s.region) ? s.region : DEFAULTS.region,
      folder: cleanFolder(s.folder),
      pullZoneUrl: cleanPullZoneUrl(s.pullZoneUrl),
      skipExisting: s.skipExisting !== false,
      saveInfoJson: s.saveInfoJson !== false,
      requestDelaySec: clampNumber(s.requestDelaySec, 1, 60, DEFAULTS.requestDelaySec),
    };
  }

  function regionHost(regionId) {
    return (REGIONS.find((r) => r.id === regionId) || REGIONS[0]).host;
  }

  function encodePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  // https://{host}/{zone}/{path}; an empty path addresses the zone root.
  function storageUrl(host, zone, path = '') {
    return `https://${host}/${encodeURIComponent(zone)}/${encodePath(path)}`;
  }

  function publicUrl(pullZoneUrl, path) {
    return pullZoneUrl ? `${pullZoneUrl}/${encodePath(path)}` : '';
  }

  async function load() {
    const { settings } = await chrome.storage.local.get('settings');
    return normalize(settings);
  }

  async function save(values) {
    const settings = normalize(values);
    await chrome.storage.local.set({ settings });
    return settings;
  }

  async function loadSecret() {
    const { secret } = await chrome.storage.local.get('secret');
    return { password: String(secret?.password || '') };
  }

  async function saveSecret(password) {
    await chrome.storage.local.set({ secret: { password: String(password || '').trim() } });
  }

  root.settings = {
    REGIONS,
    DEFAULTS,
    normalize,
    cleanFolder,
    regionHost,
    encodePath,
    storageUrl,
    publicUrl,
    load,
    save,
    loadSecret,
    saveSecret,
  };
})();
