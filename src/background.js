/*
 * Service worker: starts the hidden uploader page, hands it the Bunny
 * credentials, and toggles the in-page panel when the toolbar icon is clicked.
 *
 * Uploads do NOT run here. Chrome stops extension service workers when a
 * fetch takes longer than ~30 seconds, and a large reel upload can easily take
 * longer, so transfers happen in an offscreen document instead.
 */
importScripts('shared/settings.js');

const Settings = self.IGBunny.settings;
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);
const CONTENT_SCRIPT_FILES = chrome.runtime.getManifest().content_scripts[0].js;
const INSTAGRAM_URL = /^https:\/\/www\.instagram\.com\//;

const DEFAULT_TITLE = chrome.runtime.getManifest().action.default_title;
const BADGE_COLORS = { running: '#f97316', done: '#16a34a', error: '#dc2626' };

let creatingOffscreen = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

async function pingOffscreen() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
      if (reply?.ok) return;
    } catch {
      // Not listening yet; try again shortly.
    }
    await sleep(100);
  }
  throw new Error('The uploader did not start. Try reloading the extension.');
}

async function ensureOffscreen() {
  if (!(await hasOffscreenDocument())) {
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen
        .createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['BLOBS'],
          justification: 'Download Instagram media and upload it to Bunny Storage.',
        })
        .catch((error) => {
          // Another call created it first; that's fine.
          if (!/single offscreen document/i.test(String(error?.message))) throw error;
        })
        .finally(() => {
          creatingOffscreen = null;
        });
    }
    await creatingOffscreen;
  }
  await pingOffscreen();
}

// ---- Background jobs: badge, tab protection, notifications ----------------
// Jobs run inside the Instagram tab, so it's fine to use other tabs meanwhile.
// This keeps Chrome's Memory Saver from unloading that tab mid-job and shows
// progress on the toolbar icon.

function compactCount(n) {
  if (n < 1000) return String(n);
  return n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.floor(n / 1000)}k`;
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title: title || DEFAULT_TITLE });
}

async function getJobTabs() {
  return (await chrome.storage.session.get('jobTabs')).jobTabs || {};
}

async function setJobTab(tabId, info) {
  const tabs = await getJobTabs();
  if (info) tabs[tabId] = info;
  else delete tabs[tabId];
  await chrome.storage.session.set({ jobTabs: tabs });
  return tabs;
}

async function protectTab(tabId, on) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: !on });
  } catch {
    // Tab already closed.
  }
}

async function isTabInFront(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.active && (await chrome.windows.get(tab.windowId)).focused;
  } catch {
    return false;
  }
}

async function notifyFinished(tabId, { kind, label, text }) {
  await chrome.notifications.create(`igb-job-${tabId}-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: kind === 'done' ? `Finished saving ${label} to Bunny` : `Saving ${label} needs attention`,
    message: text,
  });
}

// A job tab was closed or reloaded, so its job is gone.
async function forgetJobTab(tabId, tabStillOpen) {
  const tabs = await getJobTabs();
  if (!(tabId in tabs)) return;
  const remaining = await setJobTab(tabId, null);
  if (tabStillOpen) await protectTab(tabId, false);
  if (!Object.keys(remaining).length) await setBadge('', null);
}

// Job messages are handled one at a time, in order, so a late progress update
// can never overwrite the final badge.
let jobQueue = Promise.resolve();
function enqueue(task) {
  const run = jobQueue.then(task);
  jobQueue = run.catch(() => {});
  return run;
}

async function onJobMessage(message, tabId) {
  const { label = '', stats = {} } = message;
  if (message.type === 'job-started') {
    if (tabId !== undefined) {
      await protectTab(tabId, true);
      await setJobTab(tabId, { label });
    }
    await setBadge('…', BADGE_COLORS.running, `Saving ${label} to Bunny…`);
    return;
  }
  if (message.type === 'job-progress') {
    if (tabId !== undefined && !(tabId in (await getJobTabs()))) return; // job already over
    const done = (stats.uploaded || 0) + (stats.skipped || 0);
    await setBadge(
      compactCount(done),
      BADGE_COLORS.running,
      `Saving ${label}: ${stats.uploaded || 0} saved, ${stats.skipped || 0} already there, ${stats.failed || 0} failed`,
    );
    return;
  }
  // job-finished
  if (tabId !== undefined) {
    await protectTab(tabId, false);
    await setJobTab(tabId, null);
  }
  if (message.kind === 'stopped') {
    await setBadge('', null);
    return;
  }
  const ok = message.kind === 'done';
  await setBadge(ok ? 'OK' : '!', ok ? BADGE_COLORS.done : BADGE_COLORS.error, `${label}: ${message.text}`);
  if (tabId !== undefined && !(await isTabInFront(tabId))) await notifyFinished(tabId, message);
}

chrome.notifications.onClicked.addListener(async (id) => {
  const match = /^igb-job-(\d+)-/.exec(id);
  chrome.notifications.clear(id);
  if (!match) return;
  try {
    const tab = await chrome.tabs.update(Number(match[1]), { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Tab was closed.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => forgetJobTab(tabId, false));
});

// After a (re)load, ask the page whether its job survived. Instagram's in-page
// navigation keeps the job alive; a real reload or leaving the site does not.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  enqueue(async () => {
    if (!(tabId in (await getJobTabs()))) return;
    let running = false;
    try {
      running = (await chrome.tabs.sendMessage(tabId, { type: 'job-status' }))?.running === true;
    } catch {
      // No content script = the page that ran the job is gone.
    }
    if (!running) await forgetJobTab(tabId, true);
  });
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'job-started':
    case 'job-progress':
    case 'job-finished':
      await enqueue(() => onJobMessage(message, sender.tab?.id));
      return {};

    case 'ensure-uploader':
      await ensureOffscreen();
      return {};

    case 'get-status': {
      const [settings, secret] = await Promise.all([Settings.load(), Settings.loadSecret()]);
      return { configured: Boolean(settings.zone && secret.password), settings };
    }

    case 'get-bunny-credentials': {
      // Only the uploader page may read the storage password.
      if (sender.url !== OFFSCREEN_URL) throw new Error('Not allowed.');
      const [settings, secret] = await Promise.all([Settings.load(), Settings.loadSecret()]);
      return {
        host: Settings.regionHost(settings.region),
        zone: settings.zone,
        password: secret.password,
      };
    }

    case 'open-options':
      await chrome.runtime.openOptionsPage();
      return {};

    default:
      throw new Error(`Unknown request: ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return undefined; // for the uploader page
  handleMessage(message, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true; // respond asynchronously
});

chrome.action.onClicked.addListener(async (tab) => {
  // Clear a finished job's "OK" / "!" badge once you've looked.
  enqueue(async () => {
    if (!Object.keys(await getJobTabs()).length) await setBadge('', null);
  });

  if (!tab?.id || !INSTAGRAM_URL.test(tab.url || '')) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
  } catch {
    // The tab was opened before the extension was installed or reloaded,
    // so the content script isn't there yet. Inject it, then open the panel.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPT_FILES });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel', open: true });
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.runtime.openOptionsPage();
});
