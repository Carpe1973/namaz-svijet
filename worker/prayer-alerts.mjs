import { buildPushPayload } from '@block65/webcrypto-web-push';
import { APP_LANGUAGES, UI_TEXT } from '../i18n.js';
import {
  ALERT_WINDOW, KEYS, MOSQUE_CALENDARS, MOSQUE_TIMEZONE, cleanTime, dayPlus,
  displayPrayerTime, fetchTimings, keyOf, localEpoch, prayerAlerts, zoned
} from '../prayer-times.mjs';

const API = '/api/prayer-alerts';
const KEY_RECORD = 'vapid-keys';
const SUBJECT = 'https://namaz-svijetav2.mersad-e1d.workers.dev/';
const TOKEN = /^[0-9a-f]{32}$/;
const PUSH_HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);

function subscriptionIsValid(subscription) {
  try {
    const {endpoint, keys} = subscription;
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
      (PUSH_HOSTS.has(url.hostname) || url.hostname.endsWith('.notify.windows.com')) &&
      /^[\w-]{87}$/.test(keys?.p256dh) && /^[\w-]{22}$/.test(keys?.auth);
  } catch {
    return false;
  }
}

function validateConfig(config) {
  if (!config || !Object.hasOwn(APP_LANGUAGES, config.language)) return null;
  const {language, mosque, latitude, longitude, timezone, method, school, offsets, manual} = config;
  if (Object.hasOwn(MOSQUE_CALENDARS, mosque)) return {mosque, language, timezone: MOSQUE_TIMEZONE};
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      !['2', '3', '4', '5', '13', '15'].includes(method) || !['0', '1'].includes(school)) return null;
  if (typeof timezone !== 'string' || timezone.length > 80) return null;
  try {
    new Intl.DateTimeFormat('en', {timeZone: timezone});
  } catch {
    return null;
  }
  const safeOffsets = Object.fromEntries(KEYS.map(key => {
    const value = offsets?.[key];
    return [key, Number.isInteger(value) && Math.abs(value) <= 120 ? value : 0];
  }));
  const safeManual = {};
  const date = zoned(new Date(), timezone);
  for (const day of [dayPlus(date, -1), date, dayPlus(date, 1)]) {
    const dateKey = keyOf(day);
    if (!manual?.[dateKey]) continue;
    safeManual[dateKey] = Object.fromEntries(KEYS.map(key => [key, cleanTime(manual[dateKey][key])]));
  }
  return {latitude, longitude, timezone, method, school, language, offsets: safeOffsets, manual: safeManual};
}

function alarmNamespace(env, name) {
  return env.PRAYER_ALERTS.get(env.PRAYER_ALERTS.idFromName(name));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API + '/')) return env.ASSETS.fetch(request);
    if (url.pathname === API + '/key' && request.method === 'GET') {
      return alarmNamespace(env, KEY_RECORD).fetch('https://internal/public-key');
    }
    if (request.headers.get('Origin') !== url.origin) return new Response(null, {status: 403});
    const [token, action, ...rest] = url.pathname.slice(API.length + 1).split('/');
    if (!TOKEN.test(token) || rest.length || (action && action !== 'test')) return new Response(null, {status: 404});
    if ((!action && !['PUT', 'DELETE'].includes(request.method)) ||
        (action && request.method !== 'POST')) return new Response(null, {status: 405});
    if (request.method === 'PUT') {
      if (Number(request.headers.get('Content-Length')) > 8192) return new Response(null, {status: 413});
      const body = await request.text();
      if (body.length > 8192) return new Response(null, {status: 413});
      let payload;
      try { payload = JSON.parse(body); } catch { return new Response(null, {status: 400}); }
      const config = validateConfig(payload?.config);
      if (!config || !subscriptionIsValid(payload?.subscription)) return new Response(null, {status: 400});
      return alarmNamespace(env, token).fetch('https://internal/subscription', {
        method: 'PUT', body: JSON.stringify({subscription: payload.subscription, config})
      });
    }
    return alarmNamespace(env, token).fetch('https://internal/' + (action || 'subscription'),
      {method: request.method});
  }
};

async function computeDayAlerts(date, config) {
  const dates = [dayPlus(date, -1), date, dayPlus(date, 1)];
  const [yesterday, today, tomorrow] = await Promise.all(dates.map(async day => {
    const data = await fetchTimings(day, config);
    return Object.fromEntries(KEYS.map(key => [
      key, displayPrayerTime(key, data.timings, config, config.manual?.[keyOf(day)])
    ]));
  }));
  return prayerAlerts(date, today, yesterday, tomorrow, config.timezone);
}

export class PrayerAlerts {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/public-key' || path === '/signing-key') {
      const keys = await this.state.blockConcurrencyWhile(async () => {
        const existing = await this.storage.get(KEY_RECORD);
        if (existing) return existing;
        const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
        const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
        const keys = {
          publicKey: btoa(String.fromCharCode(...publicKey)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
          privateKey: privateKey.d,
          subject: SUBJECT
        };
        await this.storage.put(KEY_RECORD, keys);
        return keys;
      });
      return Response.json(path === '/public-key' ? {publicKey: keys.publicKey} : keys,
        {headers: {'Cache-Control': 'no-store'}});
    }
    if (request.method === 'DELETE') {
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
      return new Response(null, {status: 204});
    }
    if (request.method === 'PUT') {
      const payload = await request.json();
      const existing = await this.storage.get('settings');
      if (JSON.stringify(existing) !== JSON.stringify(payload)) {
        // A settings change invalidates the plan, while the last delivered ID still prevents repeats.
        await this.storage.put('settings', payload);
        await this.storage.delete('plan');
        await this.storage.setAlarm(Date.now());
      }
      return new Response(null, {status: 204});
    }
    if (path === '/test') {
      const settings = await this.storage.get('settings');
      if (!settings) return new Response(null, {status: 404});
      const lastTest = await this.storage.get('test');
      if (lastTest && Date.now() - lastTest < 3000) return new Response(null, {status: 429});
      await this.storage.put('test', Date.now());
      const result = await this.send(settings, null);
      return new Response(null, {status: result.ok ? 204 : 502});
    }
    return new Response(null, {status: 404});
  }

  async send(settings, alert) {
    const keyResponse = await alarmNamespace(this.env, KEY_RECORD).fetch('https://internal/signing-key');
    const keys = await keyResponse.json();
    const index = Object.keys(APP_LANGUAGES).indexOf(settings.config.language);
    const title = alert ? UI_TEXT[alert.prayer][index] : 'Namaz Svijet';
    const body = alert ? UI_TEXT.prayerEnding[index].replace('{time}', alert.end) : UI_TEXT.alertTestMessage[index];
    const payload = await buildPushPayload({
      data: JSON.stringify({title, body, tag: alert?.id || 'prayer-alert-test'}),
      options: {
        ttl: alert ? Math.max(0, Math.ceil((alert.at + ALERT_WINDOW - Date.now()) / 1000)) : 60,
        urgency: 'high'
      }
    }, settings.subscription, keys);
    return fetch(settings.subscription.endpoint, {
      ...payload, redirect: 'error', signal: AbortSignal.timeout(8000)
    });
  }

  async alarm() {
    await this.state.blockConcurrencyWhile(async () => {
      const settings = await this.storage.get('settings');
      if (!settings) return;
      const timezone = settings.config.timezone;
      const date = zoned(new Date(), timezone);
      const dateKey = keyOf(date);
      const nextDay = localEpoch(dayPlus(date, 1), '00:00', timezone);
      let plan = await this.storage.get('plan');
      if (plan?.date !== dateKey) {
        try {
          plan = {date: dateKey, alerts: await computeDayAlerts(date, settings.config)};
          await this.storage.put('plan', plan);
        } catch {
          await this.storage.setAlarm(Date.now() + 5 * ALERT_WINDOW);
          return;
        }
      }
      const now = Date.now();
      const pending = plan.alerts.filter(alert => alert.at + ALERT_WINDOW > now);
      const due = pending.find(alert => alert.at <= now);
      const sent = await this.storage.get('sent');
      const delivered = sent?.date === dateKey ? sent.ids : [];
      if (due && !delivered.includes(due.id)) {
        try {
          const result = await this.send(settings, due);
          if (result.status === 404 || result.status === 410) {
            await this.storage.deleteAll();
            return;
          }
          if (!result.ok) throw new Error('Push delivery failed');
          await this.storage.put('sent', {date: dateKey, ids: [...delivered, due.id]});
        } catch {
          if (Date.now() + 5000 < due.at + ALERT_WINDOW) {
            await this.storage.setAlarm(Date.now() + 5000);
            return;
          }
        }
      }
      const next = pending.find(alert => alert.at > now);
      await this.storage.setAlarm(Math.min(next?.at ?? nextDay, nextDay));
    });
  }
}
