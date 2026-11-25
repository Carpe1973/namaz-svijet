import { AL_BADR_2026 } from './al-badr-2026.js';
import { CCI_2026 } from './cci-2026.js';

export const KEYS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
export const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
export const MOSQUE_TIMEZONE = 'Europe/Zurich';
export const MOSQUE_CALENDARS = {alBadr: AL_BADR_2026, cci: CCI_2026};
export const ALERT_WINDOW = 60_000;
const ALERT_LEAD = 20 * 60_000;

export const pad = n => String(n).padStart(2, '0');
export function zoned(date, tz) {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    return Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]));
  } catch {
    return zoned(date, 'UTC');
  }
}
export function keyOf(p) {
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
export function dayPlus(p, days) {
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return {year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate()};
}
export function localEpoch(p, hhmm, tz) {
  const [hour, minute] = hhmm.split(':').map(Number);
  const target = Date.UTC(p.year, p.month - 1, p.day, hour, minute);
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const z = zoned(new Date(guess), tz);
    const difference = target - Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
    if (difference === 0) break;
    guess += difference;
  }
  return guess;
}
export function cleanTime(value) {
  const match = String(value || '').match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return `${pad(Number(match[1]))}:${match[2]}`;
}
export function adjustedTime(raw, minutes) {
  const time = cleanTime(raw);
  if (!time) return null;
  const [hour, minute] = time.split(':').map(Number);
  const total = ((hour * 60 + minute + Number(minutes || 0)) % 1440 + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
export async function fetchTimings(date, config) {
  if (config.mosque) {
    const row = MOSQUE_CALENDARS[config.mosque]?.[keyOf(date)];
    return {timings: row ? Object.fromEntries(KEYS.map((key, index) => [key, row[index]])) : null};
  }
  const params = new URLSearchParams({
    latitude: config.latitude, longitude: config.longitude, method: config.method, school: config.school
  });
  const response = await fetch(`https://api.aladhan.com/v1/timings/${pad(date.day)}-${pad(date.month)}-${date.year}?${params}`,
    {cache: 'no-store', signal: AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error('Prayer times unavailable');
  const json = await response.json();
  if (json.code !== 200 || !json.data?.timings) throw new Error('Invalid prayer times');
  return json.data;
}

export function displayPrayerTime(key, timings, config, manualTimes) {
  if (config.mosque) return cleanTime(timings?.[key]);
  return cleanTime(manualTimes?.[key]) || adjustedTime(timings?.[key], config.offsets?.[key]);
}

// Both the app and the Worker use the same local timetable and expiry calculation.
export function prayerAlerts(date, times, yesterday, tomorrow, timezone) {
  const previousDate = dayPlus(date, -1);
  const nextDate = dayPlus(date, 1);
  const windows = [
    ['Isha', previousDate, yesterday?.Isha, date, times?.Fajr],
    ['Fajr', date, times?.Fajr, date, times?.Sunrise],
    ['Dhuhr', date, times?.Dhuhr, date, times?.Asr],
    ['Asr', date, times?.Asr, date, times?.Maghrib],
    ['Maghrib', date, times?.Maghrib, date, times?.Isha],
    ['Isha', date, times?.Isha, nextDate, tomorrow?.Fajr]
  ];
  return windows.flatMap(([prayer, startDate, start, endDate, end]) => {
    if (!start || !end) return [];
    const expires = localEpoch(endDate, end, timezone);
    const at = expires - ALERT_LEAD;
    if (at < localEpoch(startDate, start, timezone)) return [];
    return [{prayer, at, end, id: `${keyOf(startDate)}-${prayer}`}];
  }).sort((a, b) => a.at - b.at);
}
