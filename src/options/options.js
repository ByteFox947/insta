const Settings = globalThis.IGBunny.settings;

const form = document.getElementById('settings-form');
const message = document.getElementById('message');
const preview = document.getElementById('layout-preview');
const togglePassword = document.getElementById('toggle-password');

for (const region of Settings.REGIONS) {
  form.region.add(new Option(`${region.label} (${region.host})`, region.id));
}

function readForm() {
  return {
    zone: form.zone.value,
    region: form.region.value,
    folder: form.folder.value,
    pullZoneUrl: form.pullZoneUrl.value,
    skipExisting: form.skipExisting.checked,
    saveInfoJson: form.saveInfoJson.checked,
    requestDelaySec: form.requestDelaySec.value,
  };
}

function fillForm(settings, password) {
  form.zone.value = settings.zone;
  form.region.value = settings.region;
  form.folder.value = settings.folder;
  form.pullZoneUrl.value = settings.pullZoneUrl;
  form.skipExisting.checked = settings.skipExisting;
  form.saveInfoJson.checked = settings.saveInfoJson;
  form.requestDelaySec.value = settings.requestDelaySec;
  form.password.value = password;
  updatePreview();
}

function updatePreview() {
  const s = Settings.normalize(readForm());
  const base = [s.zone || 'your-zone', s.folder].filter(Boolean).join('/');
  preview.textContent = `${base}/<username>/posts/ and ${base}/<username>/reels/`;
}

function show(text, kind = '') {
  message.textContent = text;
  message.className = kind;
}

async function testConnection() {
  const s = Settings.normalize(readForm());
  const password = form.password.value.trim();
  if (!s.zone || !password) throw new Error('Enter the storage zone name and password first.');

  let response;
  try {
    response = await fetch(Settings.storageUrl(Settings.regionHost(s.region), s.zone, ''), {
      headers: { AccessKey: password, Accept: 'application/json' },
    });
  } catch (error) {
    throw new Error(`Couldn't reach Bunny (${error.message}).`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Bunny said "unauthorized" (HTTP ${response.status}). Check the zone name, password and region.`);
  }
  if (!response.ok) throw new Error(`Bunny returned HTTP ${response.status}.`);
  const items = await response.json().catch(() => []);
  const count = Array.isArray(items) ? items.length : 0;
  return `Connected. Zone "${s.zone}" has ${count} item(s) at the top level.`;
}

form.addEventListener('input', updatePreview);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = form.password.value.trim();
  const saved = await Settings.save(readForm());
  await Settings.saveSecret(password);
  fillForm(saved, password);
  if (!saved.zone || !password) show('Saved, but uploads need both the zone name and its password.', 'warn');
  else show('Saved.', 'ok');
});

document.getElementById('test').addEventListener('click', async () => {
  show('Testing…');
  try {
    show(await testConnection(), 'ok');
  } catch (error) {
    show(error.message, 'error');
  }
});

togglePassword.addEventListener('click', () => {
  const reveal = form.password.type === 'password';
  form.password.type = reveal ? 'text' : 'password';
  togglePassword.textContent = reveal ? 'Hide' : 'Show';
});

(async () => {
  const [settings, secret] = await Promise.all([Settings.load(), Settings.loadSecret()]);
  fillForm(settings, secret.password);
})();
