import { ALERT_WINDOW, KEYS, dayPlus, displayPrayerTime, fetchTimings, keyOf, prayerAlerts } from './prayer-times.mjs';

const API = './api/prayer-alerts';
const MODES = ['off', 'foreground', 'push'];

export function createPrayerReminders({translate, audioLanguage, readContext, saved, save}) {
  const modeSelect = document.getElementById('prayerAlertMode');
  const testButton = document.getElementById('testPrayerAlert');
  const feedback = document.getElementById('prayerAlertFeedback');
  const notice = document.getElementById('prayerAlertNotice');
  const Audio = window.AudioContext || window.webkitAudioContext;
  let mode = saved('ns_alert_mode', 'off');
  if (!MODES.includes(mode)) mode = 'off';
  let audio;
  let voice;
  let alerts = [];
  let revision = 0;
  let yesterday;
  let noticeTimer;
  let syncedConfig;
  let disablingPush = false;
  let syncQueue = Promise.resolve();

  function showFeedback(key) {
    feedback.textContent = key ? translate(key) : '';
  }
  function renderMode() {
    modeSelect.value = mode;
    testButton.hidden = mode === 'off';
    document.getElementById('prayerAlertHint').hidden = mode === 'foreground';
    document.getElementById('prayerAlertAudioHint').hidden = mode === 'off';
  }
  function startAudio() {
    if (!Audio) return Promise.reject(new Error('Audio is unavailable'));
    audio ||= new Audio();
    loadVoice().catch(() => {});
    return audio.resume();
  }
  function loadVoice() {
    const code = audioLanguage();
    if (voice?.code === code) return voice.ready;
    const clip = {code};
    voice = clip;
    clip.ready = fetch(new URL(`./assets/prayer-alert/${code}.mp3`, import.meta.url), {
      signal: AbortSignal.timeout(5000)
    }).then(async response => {
      if (!response.ok) throw new Error('Voice clip is unavailable');
      clip.buffer = await audio.decodeAudioData(await response.arrayBuffer());
    }).catch(error => {
      if (voice === clip) voice = undefined;
      throw error;
    });
    return clip.ready;
  }
  function playVoice() {
    if (audio?.state !== 'running' || voice?.code !== audioLanguage() || !voice.buffer) return false;
    const source = audio.createBufferSource();
    source.buffer = voice.buffer;
    source.connect(audio.destination);
    source.start();
    return true;
  }
  async function previewVoice() {
    await startAudio();
    await loadVoice();
    return playVoice();
  }
  function playAlert() {
    if (playVoice()) return true;
    if (audio?.state !== 'running') return false;
    const start = audio.currentTime;
    [660, 880, 660].forEach((frequency, index) => {
      const time = start + index * 0.23;
      const tone = audio.createOscillator();
      const level = audio.createGain();
      tone.frequency.value = frequency;
      level.gain.setValueAtTime(0.001, time);
      level.gain.exponentialRampToValueAtTime(0.24, time + 0.02);
      level.gain.exponentialRampToValueAtTime(0.001, time + 0.19);
      tone.connect(level);
      level.connect(audio.destination);
      tone.start(time);
      tone.stop(time + 0.20);
    });
    return true;
  }

  async function request(url, options) {
    const response = await fetch(url, {...options, signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error('Prayer alert service unavailable');
    return response;
  }
  async function registration() {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing?.active) return existing;
    let timeout;
    try {
      return await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Service worker unavailable')), 8000);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  async function syncPush(config, maySubscribe) {
    const current = await registration();
    let subscription = await current.pushManager.getSubscription();
    let token = saved('ns_alert_token', '');
    if (!subscription && maySubscribe) {
      const {publicKey} = await (await request(API + '/key')).json();
      const base64 = publicKey.replaceAll('-', '+').replaceAll('_', '/');
      const applicationServerKey = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      subscription = await current.pushManager.subscribe({userVisibleOnly: true, applicationServerKey});
    }
    if (!subscription) throw new Error('Push subscription unavailable');
    if (!token) {
      token = crypto.randomUUID().replaceAll('-', '');
      save('ns_alert_token', token);
    }
    const body = JSON.stringify({subscription, config});
    if (body !== syncedConfig || maySubscribe) {
      await request(API + '/' + token, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body});
      syncedConfig = body;
    }
    return token;
  }
  async function stopPush() {
    const token = saved('ns_alert_token', '');
    const current = await navigator.serviceWorker.getRegistration();
    const subscription = await current?.pushManager.getSubscription();
    const settled = await Promise.allSettled([
      token ? request(API + '/' + token, {method: 'DELETE'}) : Promise.resolve(),
      subscription ? subscription.unsubscribe() : Promise.resolve()
    ]);
    if (settled.every(result => result.status === 'rejected')) throw new Error('Unable to disable alerts');
    syncedConfig = undefined;
  }
  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function queuePush(config, maySubscribe) {
    const sync = syncQueue.then(() => {
      if (maySubscribe || (mode === 'push' && !disablingPush)) return syncPush(config, maySubscribe);
    });
    syncQueue = sync.catch(() => {});
    return sync;
  }

  async function refreshPush(pushConfig, current) {
    if (!pushSupported() || Notification.permission !== 'granted') {
      showFeedback('alertsPermission');
      return;
    }
    try {
      await queuePush(pushConfig, false);
      if (current === revision) showFeedback('');
    } catch {
      if (current === revision) showFeedback('alertsSyncError');
    }
  }
  async function refresh() {
    const current = ++revision;
    alerts = [];
    if (mode === 'off') return;
    if (audio) loadVoice().catch(() => {});
    const context = readContext();
    if (!context) return;
    const {config, pushConfig, date, today, tomorrow, manualAt} = context;
    if (mode === 'push') refreshPush(pushConfig, current);
    const displayed = (data, day) => Object.fromEntries(KEYS.map(key => [
      key, displayPrayerTime(key, data?.timings, config, manualAt(day))
    ]));
    const previousDate = dayPlus(date, -1);
    const todayTimes = displayed(today, date);
    const tomorrowTimes = displayed(tomorrow, dayPlus(date, 1));
    alerts = prayerAlerts(date, todayTimes, null, tomorrowTimes, config.timezone);
    const previousKey = JSON.stringify([keyOf(previousDate), config.mosque, config.latitude, config.longitude, config.method, config.school]);
    if (yesterday?.id !== previousKey) yesterday = {id: previousKey, result: fetchTimings(previousDate, config)};
    try {
      const past = await yesterday.result;
      if (current === revision) {
        alerts = prayerAlerts(date, todayTimes, displayed(past, previousDate), tomorrowTimes, config.timezone);
      }
    } catch {
      if (yesterday?.id === previousKey) yesterday = undefined;
    }
  }

  async function changeMode() {
    const next = modeSelect.value;
    modeSelect.disabled = testButton.disabled = true;
    disablingPush = mode === 'push' && next !== 'push';
    showFeedback('');
    try {
      if (next === 'push') {
        if (!pushSupported()) {
          showFeedback('alertsPushUnsupported');
          return;
        }
        startAudio().catch(() => {});
        if (await Notification.requestPermission() !== 'granted') {
          showFeedback('alertsPermission');
          return;
        }
        const context = readContext();
        if (!context) {
          showFeedback('alertsNoTimes');
          return;
        }
        await queuePush(context.pushConfig, true);
      }
      if (next === 'foreground') await startAudio();
      if (disablingPush) {
        await syncQueue;
        await stopPush();
      }
      mode = next;
      save('ns_alert_mode', mode);
      refresh();
    } catch {
      showFeedback(next === 'foreground' ? 'alertsAudioError' : 'alertsSyncError');
    } finally {
      disablingPush = false;
      renderMode();
      modeSelect.disabled = testButton.disabled = false;
    }
  }

  async function test() {
    modeSelect.disabled = testButton.disabled = true;
    showFeedback('');
    try {
      const spoken = previewVoice().catch(() => false);
      if (mode === 'push') {
        const token = saved('ns_alert_token', '');
        await request(API + '/' + token + '/test', {method: 'POST'});
        showFeedback(await spoken ? 'alertsTestSent' : 'alertsTestSentWithoutVoice');
      } else {
        showFeedback(await spoken ? 'alertTestMessage' : 'alertsAudioError');
      }
    } catch {
      showFeedback(mode === 'foreground' ? 'alertsAudioError' : 'alertsPushTestError');
    } finally {
      modeSelect.disabled = testButton.disabled = false;
    }
  }

  function check(now) {
    if (mode === 'off' || document.hidden) return;
    const alert = alerts.find(item => item.at <= now && now < item.at + ALERT_WINDOW);
    if (!alert) return;
    const id = alert.id + '-' + alert.at;
    const recent = saved('ns_alert_played', {});
    if (Object.hasOwn(recent, id) || !playAlert()) return;
    const updated = Object.fromEntries(Object.entries(recent).filter(([, at]) => now - at < 86_400_000));
    save('ns_alert_played', {...updated, [id]: now});
    notice.textContent = `${translate(alert.prayer)} · ${translate('prayerAlertSpeech')} · ${alert.end}`;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.textContent = ''; }, ALERT_WINDOW);
  }

  modeSelect.addEventListener('change', changeMode);
  testButton.addEventListener('click', test);
  window.addEventListener('online', refresh);
  const unlockAudio = () => { if (mode !== 'off' && audio?.state !== 'running') startAudio().catch(() => {}); };
  document.addEventListener('pointerup', unlockAudio, {passive: true});
  document.addEventListener('keydown', unlockAudio);
  renderMode();
  return {check, refresh, showFeedback};
}
