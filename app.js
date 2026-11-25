/* Namaz Svijet — v3.2. Namaska vremena: Al-Badr (Mawaqit) i AlAdhan API; gradovi: Open-Meteo.
   GPS, kompas i ručni raspored su opt-in; izvor vremena je jasno označen. */
'use strict';
const $=id=>document.getElementById(id);
import { APP_LANGUAGES, UI_TEXT } from './i18n.js?v=3.38';
import {
  KEYS, PRAYERS, MOSQUE_TIMEZONE, cleanTime, dayPlus, displayPrayerTime,
  fetchTimings, keyOf, localEpoch, pad, zoned
} from './prayer-times.mjs';
import { createPrayerReminders } from './prayer-reminders.mjs';

const DEFAULT={name:'Le Locle, Švicarska',latitude:47.057,longitude:6.752,timezone:MOSQUE_TIMEZONE};
const AL_BADR_URL='https://mawaqit.net/fr/mosquee-al-badr-le-locle';
const localMosques = [
  {id: 'alBadr', name: 'Al-Badr', latitude: 47.0520851, longitude: 6.7489249, url: AL_BADR_URL},
  {id: 'cci', name: 'CCI de La Chaux-de-Fonds', latitude: 47.101633789772, longitude: 6.8250626550335, url: 'https://mawaqit.net/fr/ccicdf'}
];
function nearestMosque(position){
  let nearest = null, limit = 10;
  for(const mosque of localMosques){
    const km = distanceKm(position, mosque);
    if(km <= limit){nearest = mosque; limit = km}
  }
  return nearest;
}
const QURAN_SOURCE = 'https://quran-json.risanb.com';
const TAJWEED_SOURCE = 'https://api.quran.com/api/v4/quran/verses/uthmani_tajweed';
const VIEWS = ['times', 'qibla', 'schedule', 'quran'];
const SCHEDULE_PERIODS = {today: [0], tomorrow: [1], week: [0, 1, 2, 3, 4, 5, 6]};
let schedulePeriod = 'today', scheduleRequest = 0;
let quranChapters = [], quranRequest = 0, quranLoading = false;
let translationCatalog, basmalaRequest;
let mushafPageMetadata = [];
let mushafScrollQueued = false;

async function fetchMushafPages(chapter){
  const response = await fetch('https://api.alquran.cloud/v1/surah/' + chapter.id);
  if(!response.ok) throw Error('Mushaf metadata unavailable');
  const payload = await response.json();
  const ayahs = payload?.data?.ayahs;
  if(!Array.isArray(ayahs) || ayahs.length !== chapter.total_verses ||
     !ayahs.every((ayah,index) => ayah.numberInSurah === index + 1 &&
       Number.isInteger(ayah.page) && ayah.page >= 1 && ayah.page <= 604 &&
       Number.isInteger(ayah.juz) && ayah.juz >= 1 && ayah.juz <= 30)){
    throw Error('Invalid Mushaf page metadata');
  }
  return ayahs.map(ayah => ({page:ayah.page, juz:ayah.juz}));
}
function updateMushafPosition(){
  if($('quranView').hidden || !mushafPageMetadata.length) return;
  const elements = Array.from($('surahVerses').querySelectorAll('li[data-verse]'));
  const threshold = $('quranView').querySelector('.mushaf-header').getBoundingClientRect().bottom + 55;
  let index = 0;
  for(let i=0;i<elements.length;i++){
    if(elements[i].getBoundingClientRect().top <= threshold) index=i;
    else break;
  }
  const location = mushafPageMetadata[index];
  if(!location) return;
  $('mushafCurrentPage').textContent=String(location.page);
  $('mushafJuz').textContent='Juz '+location.juz;
  save('ns_mushaf_progress',{chapter:Number($('surahSelect').value),verse:index+1,page:location.page});
}
window.addEventListener('scroll',()=>{
  if(mushafScrollQueued) return;
  mushafScrollQueued=true;
  requestAnimationFrame(()=>{mushafScrollQueued=false;updateMushafPosition();});
},{passive:true});

const tajweedColours = {
  ham_wasl: 'silent', laam_shamsiyah: 'silent', slnt: 'silent',
  madda_normal: 'short', madda_permissible: 'madd', madda_obligatory: 'madd', madda_necessary: 'madd',
  ghunnah: 'nasal', idgham_ghunnah: 'nasal', idgham_wo_ghunnah: 'nasal', idgham_shafawi: 'nasal',
  idgham_mutajanisayn: 'nasal', idgham_mutaqaribayn: 'nasal', ikhafa: 'nasal', ikhafa_shafawi: 'nasal', iqlab: 'nasal',
  qalaqah: 'echo'
};
function selectedMosque(){
  if(usesGpsPlace()) return nearestMosque(place);
  const name = place.name.split(',')[0].trim().toLowerCase().replace(/-/g,' ');
  return name === 'le locle' && place.timezone === DEFAULT.timezone ? localMosques[0] : null;
}
function mosqueLabel(){return selectedMosque() === localMosques[0] ? t('alBadr') : selectedMosque()?.name}
function prayerTimezone(){return selectedMosque()?DEFAULT.timezone:(place.timezone||'UTC')}
const saved=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}};
const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch{}};
const languageCodes = Object.keys(APP_LANGUAGES);
let appLanguage = saved('ns_language', 'bs');
if(!languageCodes.includes(appLanguage)) appLanguage = 'bs';
const t = key => UI_TEXT[key][languageCodes.indexOf(appLanguage)];
const placeDisplayName = () => usesGpsPlace() ? (mosqueLabel() || t('gpsLocation')) : place.name === DEFAULT.name ? `Le Locle, ${t('switzerland')}` : place.name;
const usesGpsPlace = () => place.name === 'Moja GPS lokacija';
let place=saved('ns_place',DEFAULT),method=String(saved('ns_method','3')),school=String(saved('ns_school','0'));
let dayData=null,tomorrowData=null,lastDate='',busy=false,requestId=0,watchId=null,compassActive=false,heading=null;
const status=message=>$('status').textContent=message||'';
function placeKey(){return `${Number(place.latitude).toFixed(3)},${Number(place.longitude).toFixed(3)}`}
function offsetKey(){return `ns3_offsets_${placeKey()}`}
function manualKey(p){return `ns3_manual_${placeKey()}_${keyOf(p)}`}
function offsets(){return saved(offsetKey(),{})}
function manual(p){return saved(manualKey(p),null)}
function timingConfig(){
  return {mosque:selectedMosque()?.id, latitude:place.latitude, longitude:place.longitude, method, school};
}
function displayTime(key,data,p){
  return displayPrayerTime(key,data?.timings,{mosque:selectedMosque()?.id, offsets:offsets()},manual(p)?.times);
}
function reminderContext(){
  const timezone=prayerTimezone();
  const date=zoned(new Date(),timezone);
  if(!dayData || keyOf(date)!==lastDate || !dayData.timings) return null;
  const config={...timingConfig(), timezone, offsets:offsets(), language:appLanguage};
  const manualTimes = Object.fromEntries([-1,0,1].map(offset=>{
    const day=dayPlus(date,offset);
    return [keyOf(day), manual(day)?.times];
  }));
  const pushConfig={...config, manual:manualTimes};
  if(config.mosque){
    delete pushConfig.latitude;
    delete pushConfig.longitude;
    delete pushConfig.manual;
    delete pushConfig.offsets;
  }else if(usesGpsPlace()){
    pushConfig.latitude=Number(config.latitude.toFixed(3));
    pushConfig.longitude=Number(config.longitude.toFixed(3));
  }
  return {config, pushConfig, date, today:dayData, tomorrow:tomorrowData, manualAt:day=>manual(day)?.times};
}
const prayerReminders=createPrayerReminders({translate:t, readContext:reminderContext, saved, save});
function bearing(lat,lon){const r=Math.PI/180,phi=lat*r,d=(39.826206-lon)*r,kaaba=21.422487*r;return (Math.atan2(Math.sin(d),Math.cos(phi)*Math.tan(kaaba)-Math.sin(phi)*Math.cos(d))/r+360)%360}
function direction(d){return t('directions')[Math.round(d/45)%8]}
function dateText(p){
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if(appLanguage === 'bs'){
    const weekdays = ['ned', 'pon', 'uto', 'sri', 'čet', 'pet', 'sub'];
    const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
    return `${weekdays[date.getUTCDay()]}, ${p.day}. ${months[p.month - 1]} ${p.year}.`;
  }
  return new Intl.DateTimeFormat(appLanguage, {weekday:'short', day:'numeric', month:'short', year:'numeric', timeZone:'UTC'}).format(date);
}
function hijriText(h){return h?`${h.day}. ${h.month?.en||''} ${h.year}. h.g.`:'—'}
function updatePlace(){
  $('placeName').textContent=placeDisplayName();
  $('qiblaPlace').textContent=placeDisplayName();
  const deg=bearing(Number(place.latitude),Number(place.longitude));
  $('qiblaDegrees').textContent=`${deg.toFixed(1)}°`;
  $('qiblaDirection').textContent=`${t('north')} · ${direction(deg)}`;
  renderCompass();
}
function renderCompass(){
  const deg=bearing(Number(place.latitude),Number(place.longitude));
  $('qiblaPointer').style.transform=`rotate(${deg-(heading??0)}deg)`;
  $('northIndicator').style.transform=`rotate(${-(heading??0)}deg)`;
}
function setView(name){
  const changed = $(name+'View').hidden;
  for(const view of VIEWS){
    const active = view === name;
    const tab = $(view+'Tab');
    $(view+'View').hidden = !active;
    tab.classList.toggle('active', active);
    if(active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  document.body.classList.toggle('quran-mode', name === 'quran');
  $('quranSettingsTab').hidden = true;
  if(changed) window.scrollTo(0, 0);
  if(name === 'schedule') renderSchedule();
  // PDF reader is embedded in quranView. Do not invoke legacy renderer.
}

function panelMessage(id, message){
  const target = $(id);
  target.textContent = message;
  target.hidden = !message;
}

function applyAppLanguage(){
  document.documentElement.lang = appLanguage;
  for(const node of document.querySelectorAll('[data-t]')) node.textContent = t(node.dataset.t);
  for(const [dataKey, attribute] of [['label', 'aria-label'], ['placeholder', 'placeholder'], ['title', 'title']]){
    for(const node of document.querySelectorAll(`[data-${dataKey}]`)) node.setAttribute(attribute, t(node.dataset[dataKey]));
  }
  for(const input of document.querySelectorAll('[data-offset], [data-manual]')){
    input.parentNode.firstChild.textContent = t(input.dataset.offset || input.dataset.manual);
  }
  if(heading !== null){
    $('compassButtonLabel').textContent = t('compassActive');
    $('compassStatus').textContent = `${t('compassActive')} · ${Math.round(heading)}° ${t('north')}`;
  }
}

function scheduleCard(date, data){
  const card = document.createElement('article');
  card.className = 'reading-card';
  const title = document.createElement('h2');
  title.textContent = dateText(date);
  const times = document.createElement('dl');
  times.className = 'schedule-times';
  for(const key of KEYS){
    const slot = document.createElement('div');
    const label = document.createElement('dt');
    const value = document.createElement('dd');
    label.textContent = t(key);
    value.textContent = displayTime(key, data, date) || '—';
    slot.append(label, value);
    times.append(slot);
  }
  card.append(title, times);
  return card;
}

async function renderSchedule(){
  const request = ++scheduleRequest;
  const days = $('scheduleDays');
  const source = $('scheduleSource');
  $('schedulePlace').textContent = placeDisplayName();
  days.replaceChildren();
  source.textContent = '';
  panelMessage('scheduleStatus', t('loading'));
  if(busy) return;

  const today = zoned(new Date(), prayerTimezone());
  const currentDay = lastDate === keyOf(today);
  const dates = SCHEDULE_PERIODS[schedulePeriod].map(offset => dayPlus(today, offset));
  const results = await Promise.allSettled(SCHEDULE_PERIODS[schedulePeriod].map((offset, index) => {
    if(currentDay && offset === 0 && dayData) return dayData;
    if(currentDay && offset === 1 && tomorrowData) return tomorrowData;
    return timings(dates[index]);
  }));
  if(request !== scheduleRequest) return;

  const hasMissingTimes = results.some(({value}, index) => KEYS.some(key => !displayTime(key, value, dates[index])));
  panelMessage('scheduleStatus', hasMissingTimes ? t('scheduleMissing') : '');
  days.replaceChildren(...dates.map((date, index) => scheduleCard(date, results[index].value)));
  if(selectedMosque()){
    const link = document.createElement('a');
    link.href = selectedMosque().url;
    link.textContent = mosqueLabel();
    source.append(t('source') + ' · ', link);
  }else{
    source.textContent = `${t('source')} · AlAdhan, ${t('adjustments')}`;
  }
}

async function fetchQuran(path){
  const response = await fetch(QURAN_SOURCE + path);
  if(!response.ok) throw Error('Quran source unavailable');
  return response.json();
}

function validVerses(data, chapter, field){
  return data.id === chapter.id && Array.isArray(data.verses) && data.verses.length === chapter.total_verses &&
    data.verses.every((verse, index) => verse.id === index + 1 && typeof verse[field] === 'string' && verse[field].trim());
}

async function fetchTranslation(chapter, language){
  const {edition} = APP_LANGUAGES[language];
  const [catalog, data] = await Promise.all([
    translationCatalog || fetchQuran('/translations/index.json'),
    fetchQuran(`/translations/${edition}/chapters/${chapter.id}.json`)
  ]);
  const source = catalog.editions.find(item => item.path === `/translations/${edition}/`);
  if(!source?.version || !validVerses(data, chapter, 'translation')) throw Error('Invalid translation');
  translationCatalog = catalog;
  return {verses: data.verses, version: source.version};
}

function tajweedVerse(markup){
  // Parse into an inert template and rebuild the source's text and colour spans.
  const template = document.createElement('template');
  template.innerHTML = markup;
  const fragment = document.createDocumentFragment();
  function appendNode(parent, node){
    if(node.nodeType === Node.TEXT_NODE){
      parent.append(node.textContent);
    }else if(node.nodeName === 'TAJWEED'){
      const rule = node.getAttribute('class');
      const colour = Object.hasOwn(tajweedColours, rule) ? tajweedColours[rule] : '';
      const span = document.createElement('span');
      if(colour) span.className = `tajweed-${colour}`;
      for(const child of node.childNodes) appendNode(span, child);
      parent.append(span);
    }else if(node.nodeName !== 'SPAN' || node.getAttribute('class') !== 'end'){
      throw Error('Unexpected tajweed markup');
    }
  }
  for(const node of template.content.childNodes) appendNode(fragment, node);
  if(!fragment.textContent.trim()) throw Error('Empty tajweed verse');
  return fragment;
}

async function fetchTajweed(chapter){
  const response = await fetch(`${TAJWEED_SOURCE}?chapter_number=${chapter.id}`, {cache:'no-store'});
  if(!response.ok) throw Error('Tajweed source unavailable');
  const {verses} = await response.json();
  if(!Array.isArray(verses) || verses.length !== chapter.total_verses || !verses.every((verse, index) =>
    verse.verse_key === `${chapter.id}:${index + 1}` && typeof verse.text_uthmani_tajweed === 'string')){
    throw Error('Invalid tajweed verses');
  }
  return verses.map(verse => verse.text_uthmani_tajweed);
}

function renderQuranVerse(verse, highlighted, translation, language, number, chapterId){
  const item = document.createElement('li');
  const arabic = document.createElement('p');
  arabic.className = 'arabic-verse';
  arabic.lang = 'ar';
  arabic.dir = 'rtl';
  // The paired-waqf signs in Al-Baqarah 2:2 are essential. They are separate
  // Quranic marks, not decorative punctuation, and some tajweed APIs omit them.
  const verifiedTwoTwo = 'ذَٰلِكَ ٱلْكِتَٰبُ لَا رَيْبَ ۛ فِيهِ ۛ هُدًى لِّلْمُتَّقِينَ';
  const sourceText = chapterId === 2 && number === 2 ? verifiedTwoTwo : verse?.text;
  if(typeof sourceText !== 'string' || !sourceText.trim()) throw Error('Missing Quran text');
  // Never substitute markup if its entire text differs even by one Quranic mark.
  // Fail closed to plain, authoritative verse text.
  const sameText = highlighted && highlighted.textContent === sourceText;
  arabic.append(sameText ? highlighted : sourceText);
  const marker = document.createElement('bdi');
  marker.className = 'ayah-number';
  marker.textContent = String(number).replace(/\d/g, digit => '٠١٢٣٤٥٦٧٨٩'[digit]);
  arabic.append(' ', marker, ' ');
  item.append(arabic);
  if(translation){
    const meaning = document.createElement('p');
    meaning.className = 'verse-translation';
    meaning.lang = language;
    meaning.textContent = translation.translation;
    item.append(meaning);
    if(translation.footnotes){
      const notes = document.createElement('details');
      const label = document.createElement('summary');
      const content = document.createElement('p');
      notes.className = 'verse-notes';
      label.textContent = t('footnotes');
      content.textContent = translation.footnotes;
      notes.append(label, content);
      item.append(notes);
    }
  }
  return item;
}

async function openQuran(){
  const request = ++quranRequest;
  const select = $('surahSelect');
  const retry = $('quranRetry');
  quranLoading = true;
  retry.hidden = true;
  $('quranChapter').hidden = true;
  $('quranLicense').hidden = true;
  const language = appLanguage;
  const colourEnabled = $('tajweedToggle').checked;
  $('tajweedLegend').hidden = !colourEnabled;
  $('tajweedCredit').hidden = true;
  panelMessage('quranStatus', t('loading'));

  try{
    if(!quranChapters.length){
      const chapters = await fetchQuran('/chapters.json');
      if(!Array.isArray(chapters) || chapters.length !== 114 || !chapters.every((chapter, index) => chapter.id === index + 1)){
        throw Error('Invalid chapter list');
      }
      quranChapters = chapters;
      select.replaceChildren(...chapters.map(chapter => new Option(`${chapter.id}. ${chapter.transliteration} · ${chapter.name}`, chapter.id)));
      const preferred = String(saved('ns_surah', 1));
      if(chapters.some(chapter => String(chapter.id) === preferred)) select.value = preferred;
      select.disabled = false;
    }

    const chapter = quranChapters[Number(select.value) - 1];
    $('mushafPage').textContent = String(chapter.id);
    $('mushafJuz').textContent = 'Juz —';
    $('mushafCurrentPage').textContent = '—';
    mushafPageMetadata = [];
    const showBasmala = colourEnabled && chapter.id !== 1 && chapter.id !== 9;
    if(showBasmala && !basmalaRequest){
      basmalaRequest = fetchTajweed(quranChapters[0]).then(verses => tajweedVerse(verses[0])).catch(() => {
        basmalaRequest = undefined;
        return null;
      });
    }
    const [plain, translated, pageInfo, coloured, basmala] = await Promise.allSettled([
      fetchQuran(`/text/uthmani/chapters/${chapter.id}.json`),
      fetchTranslation(chapter, language),
      fetchMushafPages(chapter).catch(()=>null),
      colourEnabled ? fetchTajweed(chapter).then(verses => verses.map(tajweedVerse)) : null,
      showBasmala ? basmalaRequest.then(fragment => fragment?.cloneNode(true)) : null
    ]);
    if(request !== quranRequest) return;
    const data = plain.value;
    const translation = translated.value;
    const highlights = !showBasmala || basmala.value ? coloured.value : null;
    if(!data || !validVerses(data, chapter, 'text')) throw Error('Invalid authoritative Quran text');

    const verses = Array.from({length:chapter.total_verses}, (_, index) =>
      renderQuranVerse(data?.verses?.[index], highlights?.[index], translation?.verses[index], language, index + 1, chapter.id));
    $('surahTitle').textContent = chapter.name;
    mushafPageMetadata = pageInfo.status === 'fulfilled' && Array.isArray(pageInfo.value) ? pageInfo.value : [];
    const contentWithPages = [];
    for(let i=0;i<verses.length;i++){
      verses[i].dataset.verse=String(i+1);
      const info=mushafPageMetadata[i];
      if(info){
        verses[i].dataset.mushafPage=String(info.page);
        // A page label marks the first verse that STARTS on that Madinah page.
        // A long verse can itself span a page break; don't invent word boundaries.
        if(i===0 || info.page!==mushafPageMetadata[i-1].page){
          const marker=document.createElement('li');
          marker.className='mushaf-page-divider';
          marker.setAttribute('aria-label','Stranica '+info.page+' od 604');
          const span=document.createElement('span');
          span.textContent=String(info.page);
          marker.append(span);
          contentWithPages.push(marker);
        }
      }
      contentWithPages.push(verses[i]);
    }
    $('surahVerses').replaceChildren(...contentWithPages);
    if(mushafPageMetadata.length){
      $('mushafCurrentPage').textContent=String(mushafPageMetadata[0].page);
      $('mushafJuz').textContent='Juz '+mushafPageMetadata[0].juz;
    }

    $('surahBasmala').replaceChildren(...(highlights && basmala.value ? [basmala.value] : []));
    $('surahBasmala').hidden = !highlights || !basmala.value;
    $('tajweedCredit').hidden = !highlights;
    $('translationCredit').hidden = !translation;
    if(translation){
      const edition = APP_LANGUAGES[language];
      const link = $('translationLink');
      link.href = `https://quranenc.com/en/browse/${edition.source}/${chapter.id}`;
      link.textContent = `${edition.author} · QuranEnc.com · v${translation.version}`;
    }
    $('quranNotice').textContent = data?.notice || '';
    $('quranLicense').hidden = !data?.notice;
    $('quranChapter').hidden = false;
    requestAnimationFrame(updateMushafPosition);
    const messages = [];
    if(colourEnabled && !highlights) messages.push(t('tajweedError'));
    if(!translation) messages.push(t('translationError'));
    panelMessage('quranStatus', messages.join(' '));
    retry.hidden = !messages.length;
    save('ns_surah', chapter.id);
  }catch{
    if(request !== quranRequest) return;
    panelMessage('quranStatus', t('quranError'));
    retry.hidden = false;
  }finally{
    if(request === quranRequest) quranLoading = false;
  }
}
function timings(p){return fetchTimings(p,timingConfig())}
async function loadTimings(){
  const mine=++requestId;busy=true;status(t('loading'));updatePlace();
  dayData=null;tomorrowData=null;
  prayerReminders.refresh();
  clearTimes();
  resetCountdown(t('loading'));
  $('sourceNote').textContent='';
  $('timezoneName').textContent=prayerTimezone();
  if(!$('scheduleView').hidden) renderSchedule();
  const today=zoned(new Date(),prayerTimezone());
  try{
    const [a,b]=await Promise.all([timings(today),timings(dayPlus(today,1))]);
    if(mine!==requestId)return;
    dayData=a;tomorrowData=b;
    if(a.meta?.timezone&&a.meta.timezone!==place.timezone){place.timezone=a.meta.timezone;save('ns_place',place)}
    lastDate=keyOf(today);
    renderDay();status('');
  }catch{
    if(mine!==requestId)return;
    dayData=null;tomorrowData=null;lastDate='';
    resetCountdown(t('missing'));
    $('sourceNote').textContent=`${t('source')} · AlAdhan, ${t('calculated')}`;
    status(t('timingsError'));
  }finally{
    if(mine===requestId){
      busy=false;
      if(!$('scheduleView').hidden) renderSchedule();
    }
  }
}
function clearTimes(){
  for(const k of KEYS)$('time'+k).textContent='--:--';
  $('fajrEnd').textContent='--:--';
  $('hijriDate').textContent='—';
}
function resetCountdown(message){
  $('nextName').textContent=message;
  $('nextTime').textContent='—';
  $('countdown').textContent='--:--:--';
  document.querySelectorAll('.prayer-card').forEach(el=>el.classList.remove('active'));
}
function renderDay(){
  if(!dayData)return;
  const p=zoned(new Date(),prayerTimezone());
  const alBadr=selectedMosque(),m=alBadr?null:manual(p);
  $('gregorianDate').textContent=dateText(p);
  $('hijriDate').textContent=hijriText(dayData.date?.hijri);
  for(const k of KEYS)$('time'+k).textContent=displayTime(k,dayData,p)||'--:--';
  $('fajrEnd').textContent=displayTime('Sunrise',dayData,p)||'--:--';
  const source=$('sourceNote');
  if(alBadr){
    $('timezoneName').textContent=DEFAULT.timezone;
    const link=document.createElement('a');
    link.href=selectedMosque().url;
    link.textContent=mosqueLabel();
    source.replaceChildren(dayData.timings?t('source') + ' · ':t('dateMissing') + ' · ',link);
  }else{
    $('timezoneName').textContent=`${place.timezone} · ${$('methodSelect').selectedOptions[0].textContent.split(' – ')[0]}`;
    source.textContent=m?.times&&Object.values(m.times).some(Boolean)
      ?`${t('manualSource')} · ${m.mosque||t('selectedSource')}. ${t('otherTimes')} · AlAdhan, ${t('calculated')}.`
      :`${t('source')} · AlAdhan, ${t('calculated')}.`;
  }
  prayerReminders.refresh();
  updateCountdown();
}
function updateCountdown(){
  if(!dayData)return;
  const now=new Date(),timezone=prayerTimezone(),p=zoned(now,timezone),key=keyOf(p);
  $('localClock').textContent=`${t('local')} ${pad(p.hour)}:${pad(p.minute)}`;
  if(key!==lastDate){if(!busy)loadTimings();return}
  if(selectedMosque()&&!dayData.timings){resetCountdown(t('missing'));return}
  prayerReminders.check(now.getTime());
  const fajr=displayTime('Fajr',dayData,p),sunrise=displayTime('Sunrise',dayData,p);
  let next;
  if(fajr&&sunrise){const f=localEpoch(p,fajr,timezone),s=localEpoch(p,sunrise,timezone);if(now.getTime()>=f&&now.getTime()<s)next={key:'Fajr',name:t('fajrEnd'),time:s,label:`${t('Sunrise')} · ${sunrise}`}}
  if(!next){
    const candidates=PRAYERS.map(k=>{const time=displayTime(k,dayData,p);return time?{key:k,name:t(k),time:localEpoch(p,time,timezone),label:`${t('at')} ${time}`}:null}).filter(x=>x&&x.time>now.getTime());
    if(!candidates.length&&tomorrowData){const tomorrow=dayPlus(p,1),time=displayTime('Fajr',tomorrowData,tomorrow);if(time)candidates.push({key:'Fajr',name:t('Fajr'),time:localEpoch(tomorrow,time,timezone),label:`${t('tomorrow')} · ${time}`})}
    next=candidates.sort((a,b)=>a.time-b.time)[0];
  }
  if(!next){resetCountdown(t('missing'));return}
  $('nextName').textContent=next.name;$('nextTime').textContent=next.label;
  let secs=Math.max(0,Math.ceil((next.time-now.getTime())/1000));const h=Math.floor(secs/3600);secs%=3600;
  $('countdown').textContent=`${pad(h)}:${pad(Math.floor(secs/60))}:${pad(secs%60)}`;
  document.querySelectorAll('.prayer-card').forEach(el=>el.classList.toggle('active',el.dataset.prayer===next.key));
}
let citySearch;

function clearCitySearch(){
  citySearch?.abort();
  citySearch = undefined;
  $('searchResults').hidden = true;
}

function setSearchOpen(open){
  const toggle = $('searchToggle');
  $('searchArea').hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if(open){
    $('cityInput').focus({preventScroll: true});
  }else{
    clearCitySearch();
    toggle.focus({preventScroll: true});
  }
}

function cityResult(city, selectedPlace){
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'result-item';
  const name = document.createElement('strong');
  name.textContent = city.name;
  const detail = document.createElement('span');
  detail.textContent = [city.admin1, city.country].filter(Boolean).join(', ');
  button.append(name, detail);
  button.addEventListener('click', () => {
    stopGPS();
    place = selectedPlace;
    save('ns_place', place);
    $('cityInput').value = '';
    setSearchOpen(false);
    loadTimings();
  });
  return button;
}

async function searchCities(event){
  event.preventDefault();
  const input = $('cityInput');
  const query = input.value.trim();
  if(query.length < 2) return;
  input.blur();
  clearCitySearch();

  const results = $('searchResults');
  results.hidden = false;
  if(/^(le[\s-]+)?locle$/i.test(query)){
    results.replaceChildren(cityResult({name:'Le Locle', admin1:'Neuchâtel', country:t('switzerland')}, DEFAULT));
    return;
  }

  results.textContent = t('searchLoading');
  const request = new AbortController();
  citySearch = request;
  const timeout = setTimeout(() => request.abort(), 8000);
  try{
    const params = new URLSearchParams({name:query, count:'8', language:appLanguage, format:'json'});
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, {signal:request.signal});
    if(!response.ok) throw Error('City search failed');
    const data = await response.json();
    if(citySearch !== request) return;
    if(!data.results?.length){
      results.textContent = t('searchEmpty');
      return;
    }
    results.replaceChildren(...data.results.map(city => cityResult(city, {
      name:[city.name, city.country].filter(Boolean).join(', '),
      latitude:city.latitude, longitude:city.longitude, timezone:city.timezone || 'UTC'
    })));
  }catch{
    if(citySearch === request) results.textContent = t('searchError');
  }finally{
    clearTimeout(timeout);
    if(citySearch === request) citySearch = undefined;
  }
}
function distanceKm(a,b){const r=Math.PI/180,dlat=(b.latitude-a.latitude)*r,dlon=(b.longitude-a.longitude)*r;const x=Math.sin(dlat/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin(dlon/2)**2;return 12742*Math.asin(Math.min(1,Math.sqrt(x)))}
function stopGPS(){if(watchId!==null&&navigator.geolocation)navigator.geolocation.clearWatch(watchId);watchId=null;save('ns3_follow_gps',false);$('gpsButton').textContent='📍 GPS'}
function startGPS(){
  if(!navigator.geolocation){status(t('locationError'));return}
  if(watchId!==null){stopGPS();status(t('gpsStopped'));return}
  status(t('locationRequest'));
  watchId=navigator.geolocation.watchPosition(pos=>{
    const fresh={name:'Moja GPS lokacija',latitude:pos.coords.latitude,longitude:pos.coords.longitude,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'};
    if(!usesGpsPlace()||distanceKm(place,fresh)>2
      || nearestMosque(place)!==nearestMosque(fresh)){place=fresh;save('ns_place',place);loadTimings()}
    else status('');
    save('ns3_follow_gps',true);$('gpsButton').textContent='📍 ON';
  },err=>{stopGPS();status(err.code===1?t('locationDenied'):t('locationError'))},{enableHighAccuracy:false,maximumAge:120000,timeout:20000});
}
function makeOffsets(){
  const div=$('offsets');div.replaceChildren();const current=offsets();
  for(const k of KEYS){const label=document.createElement('label');label.textContent=t(k);const input=document.createElement('input');input.type='number';input.min='-120';input.max='120';input.step='1';input.value=current[k]||0;input.dataset.offset=k;label.append(input);div.append(label)}
}
function makeManual(){
  const p=zoned(new Date(),place.timezone),record=manual(p)||{times:{}};
  $('manualDateLabel').textContent=`${dateText(p)} · ${placeDisplayName()}. ${t('manualNote')}`;
  $('mosqueName').value=record.mosque||'';const div=$('manualTimes');div.replaceChildren();
  for(const k of KEYS){const label=document.createElement('label');label.textContent=t(k);const input=document.createElement('input');input.type='time';input.value=cleanTime(record.times?.[k])||'';input.dataset.manual=k;label.append(input);div.append(label)}
}
function saveSettings(){
  if(selectedMosque())return;
  const newOffsets={};for(const el of document.querySelectorAll('[data-offset]')){const n=Number(el.value);if(!Number.isFinite(n)||n < -120||n>120){status(t('offsetError'));return}newOffsets[el.dataset.offset]=Math.round(n)}
  const p=zoned(new Date(),place.timezone),times={};for(const el of document.querySelectorAll('[data-manual]')){if(el.value)times[el.dataset.manual]=el.value}
  const hasManual=Object.keys(times).length>0;
  if(hasManual&&times.Fajr&&times.Sunrise&&times.Fajr>=times.Sunrise){status(t('fajrError'));return}
  method=$('methodSelect').value;school=$('schoolSelect').value;
  save('ns_method',method);save('ns_school',school);save(offsetKey(),newOffsets);
  if(hasManual)save(manualKey(p),{mosque:$('mosqueName').value.trim(),times});else localStorage.removeItem(manualKey(p));
  $('settingsDialog').close();loadTimings();
}
function updateHeading(event){
  let newHeading=null;
  if(Number.isFinite(event.webkitCompassHeading))newHeading=event.webkitCompassHeading;
  else if(event.absolute===true&&Number.isFinite(event.alpha))newHeading=(360-event.alpha)%360;
  if(newHeading===null)return;
  heading=newHeading;renderCompass();
  $('compassStatus').textContent=`${t('compassActive')} · ${Math.round(heading)}° ${t('north')}`;
  $('compassButtonLabel').textContent=t('compassActive');
}
async function activateCompass(){
  if(!window.DeviceOrientationEvent){$('compassStatus').textContent=t('compassHelp');return}
  try{
    if(typeof DeviceOrientationEvent.requestPermission==='function'){
      const result=await DeviceOrientationEvent.requestPermission();
      if(result!=='granted'){$('compassStatus').textContent=t('compassHelp');return}
    }
    if(!compassActive){window.addEventListener('deviceorientation',updateHeading);window.addEventListener('deviceorientationabsolute',updateHeading);compassActive=true}
    $('compassStatus').textContent=t('compassWaiting');
    setTimeout(()=>{if(heading===null&&compassActive)$('compassStatus').textContent=t('compassHelp')},4000);
  }catch{$('compassStatus').textContent=t('compassHelp')}
}
function enableTemporaryZoom(app){
  let initialDistance = 0;
  const distance = (first, second) => Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);

  function resetZoom(){
    initialDistance = 0;
    app.style.removeProperty('transform-origin');
    app.style.removeProperty('transform');
  }

  app.addEventListener('touchstart', event => {
    if(event.touches.length !== 2){
      if(initialDistance) resetZoom();
      return;
    }

    const first = event.touches[0];
    const second = event.touches[1];
    initialDistance = Math.max(1, distance(first, second));
    const bounds = app.getBoundingClientRect();
    const centerX = (first.clientX + second.clientX) / 2 - bounds.left;
    const centerY = (first.clientY + second.clientY) / 2 - bounds.top;
    app.style.transformOrigin = `${centerX}px ${centerY}px`;
    if(event.cancelable) event.preventDefault();
  }, {passive: false});

  app.addEventListener('touchmove', event => {
    if(!initialDistance || event.touches.length !== 2) return;
    if(event.cancelable) event.preventDefault();
    const currentDistance = distance(event.touches[0], event.touches[1]);
    const scale = Math.min(3, Math.max(1, currentDistance / initialDistance));
    app.style.transform = `scale(${scale})`;
  }, {passive: false});

  app.addEventListener('touchend', event => {
    if(initialDistance && event.touches.length < 2) resetZoom();
  });
  app.addEventListener('touchcancel', resetZoom);
}

enableTemporaryZoom(document.querySelector('.app-shell'));
$('appLanguage').replaceChildren(...languageCodes.map(code => new Option(APP_LANGUAGES[code].name, code)));
$('appLanguage').value = appLanguage;
$('appLanguage').addEventListener('change', event => {
  appLanguage = event.target.value;
  prayerReminders.showFeedback();
  save('ns_language', appLanguage);
  applyAppLanguage();
  updatePlace();
  if(dayData) renderDay();
  if(!$('scheduleView').hidden) renderSchedule();
  if($('quranView').hidden){
    quranRequest++;
    quranLoading = false;
    $('quranChapter').hidden = true;
  }else{
    openQuran();
  }
});
applyAppLanguage();
$('methodSelect').value=method;$('schoolSelect').value=school;
for(const view of VIEWS) $(view+'Tab').addEventListener('click',()=>setView(view));
const periodButtons = document.querySelectorAll('[data-period]');
for(const button of periodButtons){
  button.addEventListener('click', () => {
    schedulePeriod = button.dataset.period;
    for(const option of periodButtons) option.setAttribute('aria-pressed', String(option === button));
    renderSchedule();
  });
}
$('surahSelect').addEventListener('change', () => { openQuran(); $('quranView').scrollIntoView({block:'start'}); });
for(const [id, step] of [['previousSurah', -1], ['nextSurah', 1]]){
  $(id).addEventListener('click', () => {
    const selector = $('surahSelect');
    if(selector.disabled) return;
    const next = Math.max(1, Math.min(114, Number(selector.value) + step));
    if(next !== Number(selector.value)){
      selector.value = String(next);
      openQuran();
      $('quranView').scrollIntoView({block:'start'});
    }
  });
}
$('quranSettingsTab').addEventListener('click', () => $('settingsButton').click());
$('quranSettingsTab').hidden = true;
$('quranRetry').addEventListener('click', openQuran);
const paperTheme = $('paperTheme'), showMeaning = $('showMeaning');
const themeChoices = new Set(['cream', 'soft-green', 'olive', 'night', 'navy', 'charcoal']);
const savedPaperTheme = saved('ns_paper_theme', 'cream');
paperTheme.value = themeChoices.has(savedPaperTheme) ? savedPaperTheme : (savedPaperTheme === 'day' ? 'cream' : 'cream');
showMeaning.checked = saved('ns_show_meaning',false);
function applyReaderLayout(){
  $('quranView').dataset.paper = paperTheme.value;
  $('quranChapter').classList.toggle('continuous', !showMeaning.checked);
}
applyReaderLayout();
paperTheme.addEventListener('change', () => {applyReaderLayout(); save('ns_paper_theme',paperTheme.value)});
showMeaning.addEventListener('change', () => {applyReaderLayout(); save('ns_show_meaning',showMeaning.checked)});
const readingSize = $('readingSize');
readingSize.value = saved('ns_reading_size', 100);
function applyReadingSize(){
  const percent = readingSize.valueAsNumber;
  $('quranView').style.setProperty('--reading-scale', String(percent / 100));
  $('readingPercent').value = percent + '%';
  readingSize.setAttribute('aria-valuetext', percent + '%');
}
applyReadingSize();
readingSize.addEventListener('input', applyReadingSize);
readingSize.addEventListener('change', () => save('ns_reading_size', readingSize.valueAsNumber));
$('tajweedToggle').checked = saved('ns_tajweed', true);
$('tajweedToggle').addEventListener('change', event => {
  save('ns_tajweed', event.target.checked);
  if(quranChapters.length) openQuran();
});
$('searchToggle').addEventListener('click',()=>setSearchOpen($('searchArea').hidden));
$('cityInput').addEventListener('input', clearCitySearch);
$('searchForm').addEventListener('submit',searchCities);
$('gpsButton').addEventListener('click',startGPS);
$('compassButton').addEventListener('click',activateCompass);
$('settingsButton').addEventListener('click',()=>{
  const alBadr=selectedMosque();
  $('calculationSettings').hidden=alBadr;
  $('alBadrSettings').hidden=!alBadr;
  if(alBadr) $('alBadrSettings').textContent=t('source')+' · '+mosqueLabel();
  if(!alBadr){makeOffsets();makeManual()}
  $('settingsDialog').showModal();
});
$('closeSettings').addEventListener('click',()=>$('settingsDialog').close());
$('saveSettings').addEventListener('click',saveSettings);
$('resetOffsets').addEventListener('click',()=>{save(offsetKey(),{});makeOffsets()});
$('clearManual').addEventListener('click',()=>{const p=zoned(new Date(),place.timezone);localStorage.removeItem(manualKey(p));makeManual();if(dayData)renderDay()});
const requestedTab=new URLSearchParams(location.search).get('tab');
if(['times','qibla','schedule','quran'].includes(requestedTab))setView(requestedTab);
updatePlace();loadTimings();setInterval(updateCountdown,1000);
if(saved('ns3_follow_gps',false))startGPS();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
