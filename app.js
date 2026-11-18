/* Namaz Svijet — v3.2. Namaska vremena: Al-Badr (Mawaqit) i AlAdhan API; gradovi: Open-Meteo.
   GPS, kompas i ručni raspored su opt-in; izvor vremena je jasno označen. */
'use strict';
const $=id=>document.getElementById(id);
const PRAYERS=[['Fajr','Sabah'],['Dhuhr','Podne'],['Asr','Ikindija'],['Maghrib','Akšam'],['Isha','Jacija']];
const KEYS=['Fajr','Sunrise','Dhuhr','Asr','Maghrib','Isha'];
const NAMES={Fajr:'Sabah',Sunrise:'Izlazak sunca',Dhuhr:'Podne',Asr:'Ikindija',Maghrib:'Akšam',Isha:'Jacija'};
const DEFAULT={name:'Le Locle, Švicarska',latitude:47.057,longitude:6.752,timezone:'Europe/Zurich'};
const AL_BADR_URL='https://mawaqit.net/fr/mosquee-al-badr-le-locle';
const AL_BADR_GPS_RADIUS_KM=1.5;
function usesAlBadr(){
  const name=place.name.split(',')[0].trim().toLowerCase().replace(/-/g,' ');
  return (name==='le locle' && place.timezone===DEFAULT.timezone)
    || (place.name==='Moja GPS lokacija' && distanceKm(place,DEFAULT)<=AL_BADR_GPS_RADIUS_KM);
}
function prayerTimezone(){return usesAlBadr()?DEFAULT.timezone:(place.timezone||'UTC')}
const pad=n=>String(n).padStart(2,'0');
const saved=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}};
const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch{}};
let place=saved('ns_place',DEFAULT),method=String(saved('ns_method','3')),school=String(saved('ns_school','0'));
let dayData=null,tomorrowData=null,lastDate='',busy=false,requestId=0,watchId=null,compassActive=false,heading=null;
const status=message=>$('status').textContent=message||'';
function zoned(date,tz){
  try{return Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]))}
  catch{return zoned(date,'UTC')}
}
function keyOf(p){return `${p.year}-${pad(p.month)}-${pad(p.day)}`}
function dayPlus(p,n){const d=new Date(Date.UTC(p.year,p.month-1,p.day+n));return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()}}
function localEpoch(p,hhmm,tz){
  const [h,m]=hhmm.split(':').map(Number),desired=Date.UTC(p.year,p.month-1,p.day,h,m);let guess=desired;
  for(let i=0;i<5;i++){const z=zoned(new Date(guess),tz);const actual=Date.UTC(z.year,z.month-1,z.day,z.hour,z.minute,z.second);const diff=desired-actual;if(Math.abs(diff)<1000)break;guess+=diff}
  return guess;
}
function cleanTime(s){const m=String(s||'').match(/\b(\d{1,2}):(\d{2})\b/);if(!m||Number(m[1])>23||Number(m[2])>59)return null;return `${pad(Number(m[1]))}:${m[2]}`}
function placeKey(){return `${Number(place.latitude).toFixed(3)},${Number(place.longitude).toFixed(3)}`}
function offsetKey(){return `ns3_offsets_${placeKey()}`}
function manualKey(p){return `ns3_manual_${placeKey()}_${keyOf(p)}`}
function offsets(){return saved(offsetKey(),{})}
function manual(p){return saved(manualKey(p),null)}
function adjusted(k,raw){const t=cleanTime(raw);if(!t)return null;const [h,m]=t.split(':').map(Number),delta=Number(offsets()[k]||0);const mins=((h*60+m+delta)%1440+1440)%1440;return `${pad(Math.floor(mins/60))}:${pad(mins%60)}`}
function displayTime(k,data,p){
  if(usesAlBadr())return cleanTime(data?.timings?.[k]);
  const fromManual=manual(p)?.times?.[k];return cleanTime(fromManual)||adjusted(k,data?.timings?.[k])}
function bearing(lat,lon){const r=Math.PI/180,phi=lat*r,d=(39.826206-lon)*r,kaaba=21.422487*r;return (Math.atan2(Math.sin(d),Math.cos(phi)*Math.tan(kaaba)-Math.sin(phi)*Math.cos(d))/r+360)%360}
function direction(d){return ['sjever','sjeveroistok','istok','jugoistok','jug','jugozapad','zapad','sjeverozapad'][Math.round(d/45)%8]}
function dateText(p){const weekdays=['ned','pon','uto','sri','čet','pet','sub'],months=['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];const w=new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay();return `${weekdays[w]}, ${p.day}. ${months[p.month-1]} ${p.year}.`}
function hijriText(h){return h?`${h.day}. ${h.month?.en||''} ${h.year}. h.g.`:'—'}
function updatePlace(){
  $('placeName').textContent=place.name;
  $('qiblaPlace').textContent=place.name;
  const deg=bearing(Number(place.latitude),Number(place.longitude));
  $('qiblaDegrees').textContent=`${deg.toFixed(1)}°`;
  $('qiblaDirection').textContent=`od geografskog sjevera · ${direction(deg)}`;
  renderCompass();
}
function renderCompass(){
  const deg=bearing(Number(place.latitude),Number(place.longitude));
  $('qiblaPointer').style.transform=`rotate(${deg-(heading??0)}deg)`;
  $('northIndicator').style.transform=`rotate(${-(heading??0)}deg)`;
}
function setView(name){
  const q=name==='qibla';$('timesView').hidden=q;$('qiblaView').hidden=!q;
  $('timesTab').classList.toggle('active',!q);$('qiblaTab').classList.toggle('active',q);
  if(q){$('qiblaTab').setAttribute('aria-current','page');$('timesTab').removeAttribute('aria-current')}
  else{$('timesTab').setAttribute('aria-current','page');$('qiblaTab').removeAttribute('aria-current')}
}
async function timings(p){
  if(usesAlBadr()){
    const row=typeof AL_BADR_2026==='undefined'?null:AL_BADR_2026[keyOf(p)];
    const timings=row?Object.fromEntries(KEYS.map((key,i)=>[key,row[i]])):null;
    return {timings};
  }
  const date=`${pad(p.day)}-${pad(p.month)}-${p.year}`;
  const params=new URLSearchParams({latitude:String(place.latitude),longitude:String(place.longitude),method,school});
  const response=await fetch(`https://api.aladhan.com/v1/timings/${date}?${params}`,{cache:'no-store'});
  if(!response.ok)throw Error('Servis za vremena nije dostupan.');
  const json=await response.json();if(json.code!==200||!json.data?.timings)throw Error('Servis nije vratio vremena.');
  return json.data;
}
async function loadTimings(){
  const mine=++requestId;busy=true;status('Preuzimam namaska vremena…');updatePlace();
  dayData=null;tomorrowData=null;
  clearTimes();
  resetCountdown('Učitavanje…');
  $('sourceNote').textContent='';
  $('timezoneName').textContent=prayerTimezone();
  const today=zoned(new Date(),prayerTimezone());
  try{
    const [a,b]=await Promise.all([timings(today),timings(dayPlus(today,1))]);
    if(mine!==requestId)return;
    dayData=a;tomorrowData=b;
    if(a.meta?.timezone&&a.meta.timezone!==place.timezone){place.timezone=a.meta.timezone;save('ns_place',place)}
    lastDate=keyOf(today);
    renderDay();status('');
  }catch(err){
    if(mine!==requestId)return;
    dayData=null;tomorrowData=null;lastDate='';
    resetCountdown('Nema podataka');
    $('sourceNote').textContent='Izvor proračuna prema koordinatama · AlAdhan';
    status(`${err.message} Provjeri internet i pokušaj ponovo.`);
  }finally{if(mine===requestId)busy=false}
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
  const alBadr=usesAlBadr(),m=alBadr?null:manual(p);
  $('gregorianDate').textContent=dateText(p);
  $('hijriDate').textContent=hijriText(dayData.date?.hijri);
  for(const k of KEYS)$('time'+k).textContent=displayTime(k,dayData,p)||'--:--';
  $('fajrEnd').textContent=displayTime('Sunrise',dayData,p)||'--:--';
  const source=$('sourceNote');
  if(alBadr){
    $('timezoneName').textContent=DEFAULT.timezone;
    const link=document.createElement('a');
    link.href=AL_BADR_URL;
    link.textContent='Džamija Al-Badr';
    source.replaceChildren(dayData.timings?'Izvor · ':'Raspored za ovaj datum nije dostupan · ',link);
  }else{
    $('timezoneName').textContent=`${place.timezone} · ${$('methodSelect').selectedOptions[0].textContent.split(' – ')[0]}`;
    source.textContent=m?.times&&Object.values(m.times).some(Boolean)
      ?`Ručni raspored · ${m.mosque||'odabrani izvor'}. Ostala vremena · AlAdhan, proračun prema koordinatama.`
      :'Izvor · AlAdhan, proračun prema koordinatama.';
  }
  updateCountdown();
}
function updateCountdown(){
  if(!dayData)return;
  const now=new Date(),timezone=prayerTimezone(),p=zoned(now,timezone),key=keyOf(p);
  $('localClock').textContent=`Lokalno ${pad(p.hour)}:${pad(p.minute)}`;
  if(key!==lastDate){if(!busy)loadTimings();return}
  if(usesAlBadr()&&!dayData.timings){resetCountdown('Nema podataka');return}
  const fajr=displayTime('Fajr',dayData,p),sunrise=displayTime('Sunrise',dayData,p);
  let next;
  if(fajr&&sunrise){const f=localEpoch(p,fajr,timezone),s=localEpoch(p,sunrise,timezone);if(now.getTime()>=f&&now.getTime()<s)next={key:'Fajr',name:'Kraj sabaha',time:s,label:`Izlazak u ${sunrise}`}}
  if(!next){
    const candidates=PRAYERS.map(([k,name])=>{const t=displayTime(k,dayData,p);return t?{key:k,name,time:localEpoch(p,t,timezone),label:`U ${t}`}:null}).filter(x=>x&&x.time>now.getTime());
    if(!candidates.length&&tomorrowData){const tomorrow=dayPlus(p,1),t=displayTime('Fajr',tomorrowData,tomorrow);if(t)candidates.push({key:'Fajr',name:'Sabah',time:localEpoch(tomorrow,t,timezone),label:`Sutra u ${t}`})}
    next=candidates.sort((a,b)=>a.time-b.time)[0];
  }
  if(!next){resetCountdown('Nema podataka');return}
  $('nextName').textContent=next.name;$('nextTime').textContent=next.label;
  let secs=Math.max(0,Math.ceil((next.time-now.getTime())/1000));const h=Math.floor(secs/3600);secs%=3600;
  $('countdown').textContent=`${pad(h)}:${pad(Math.floor(secs/60))}:${pad(secs%60)}`;
  document.querySelectorAll('.prayer-card').forEach(el=>el.classList.toggle('active',el.dataset.prayer===next.key));
}
async function searchCities(e){
  e.preventDefault();const q=$('cityInput').value.trim();if(q.length<2)return;
  const results=$('searchResults');results.hidden=false;results.textContent='Tražim gradove…';
  try{
    const response=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`);
    if(!response.ok)throw Error();const data=await response.json();results.replaceChildren();
    if(!data.results?.length){results.textContent='Nema rezultata. Probaj drugi naziv.';return}
    for(const city of data.results){
      const btn=document.createElement('button');btn.type='button';btn.className='result-item';
      const name=document.createElement('strong');name.textContent=city.name;
      const sub=document.createElement('span');sub.textContent=[city.admin1,city.country].filter(Boolean).join(', ');
      btn.append(name,sub);btn.addEventListener('click',()=>{
        stopGPS();place={name:[city.name,city.country].filter(Boolean).join(', '),latitude:city.latitude,longitude:city.longitude,timezone:city.timezone||'UTC'};
        save('ns_place',place);$('cityInput').value='';results.hidden=true;$('searchArea').hidden=true;$('searchToggle').setAttribute('aria-expanded','false');loadTimings();
      });results.append(btn);
    }
  }catch{results.textContent='Pretraga nije uspjela. Provjeri internet.'}
}
function distanceKm(a,b){const r=Math.PI/180,dlat=(b.latitude-a.latitude)*r,dlon=(b.longitude-a.longitude)*r;const x=Math.sin(dlat/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin(dlon/2)**2;return 12742*Math.asin(Math.min(1,Math.sqrt(x)))}
function stopGPS(){if(watchId!==null&&navigator.geolocation)navigator.geolocation.clearWatch(watchId);watchId=null;save('ns3_follow_gps',false);$('gpsButton').textContent='📍 GPS'}
function startGPS(){
  if(!navigator.geolocation){status('GPS nije dostupan u ovom pregledniku.');return}
  if(watchId!==null){stopGPS();status('Automatsko praćenje lokacije je isključeno.');return}
  status('Tražim dozvolu za lokaciju…');
  watchId=navigator.geolocation.watchPosition(pos=>{
    const fresh={name:'Moja GPS lokacija',latitude:pos.coords.latitude,longitude:pos.coords.longitude,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'};
    if(place.name!=='Moja GPS lokacija'||distanceKm(place,fresh)>2
      || (distanceKm(place,DEFAULT)<=AL_BADR_GPS_RADIUS_KM)!==(distanceKm(fresh,DEFAULT)<=AL_BADR_GPS_RADIUS_KM)){place=fresh;save('ns_place',place);loadTimings()}
    else status('');
    save('ns3_follow_gps',true);$('gpsButton').textContent='📍 ON';
  },err=>{stopGPS();status(err.code===1?'Lokacija nije dozvoljena. Izaberi grad ručno.':'GPS nije dostupan. Izaberi grad ručno.')},{enableHighAccuracy:false,maximumAge:120000,timeout:20000});
}
function makeOffsets(){
  const div=$('offsets');div.replaceChildren();const current=offsets();
  for(const k of KEYS){const label=document.createElement('label');label.textContent=NAMES[k];const input=document.createElement('input');input.type='number';input.min='-120';input.max='120';input.step='1';input.value=current[k]||0;input.dataset.offset=k;label.append(input);div.append(label)}
}
function makeManual(){
  const p=zoned(new Date(),place.timezone),record=manual(p)||{times:{}};
  $('manualDateLabel').textContent=`${dateText(p)} · ${place.name}. Samo za ovaj datum i lokaciju; unosi provjerena vremena.`;
  $('mosqueName').value=record.mosque||'';const div=$('manualTimes');div.replaceChildren();
  for(const k of KEYS){const label=document.createElement('label');label.textContent=NAMES[k];const input=document.createElement('input');input.type='time';input.value=cleanTime(record.times?.[k])||'';input.dataset.manual=k;label.append(input);div.append(label)}
}
function saveSettings(){
  if(usesAlBadr())return;
  const newOffsets={};for(const el of document.querySelectorAll('[data-offset]')){const n=Number(el.value);if(!Number.isFinite(n)||n < -120||n>120){status('Korekcije moraju biti od -120 do +120 minuta.');return}newOffsets[el.dataset.offset]=Math.round(n)}
  const p=zoned(new Date(),place.timezone),times={};for(const el of document.querySelectorAll('[data-manual]')){if(el.value)times[el.dataset.manual]=el.value}
  const hasManual=Object.keys(times).length>0;
  if(hasManual&&times.Fajr&&times.Sunrise&&times.Fajr>=times.Sunrise){status('Kraj sabaha mora biti poslije početka sabaha.');return}
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
  $('compassStatus').textContent=`Kompas aktivan · telefon usmjeren približno ${Math.round(heading)}° od sjevera. Provjeri kalibraciju.`;
  $('compassButton').textContent='🧭 Kompas aktivan';
}
async function activateCompass(){
  if(!window.DeviceOrientationEvent){$('compassStatus').textContent='Ovaj preglednik nema pristup senzoru. Strelica pokazuje kiblu u odnosu na sjever.';return}
  try{
    if(typeof DeviceOrientationEvent.requestPermission==='function'){
      const result=await DeviceOrientationEvent.requestPermission();
      if(result!=='granted'){$('compassStatus').textContent='Dozvola za kompas nije odobrena. Koristi prikaz stepeni od sjevera.';return}
    }
    if(!compassActive){window.addEventListener('deviceorientation',updateHeading);window.addEventListener('deviceorientationabsolute',updateHeading);compassActive=true}
    $('compassStatus').textContent='Čekam podatke senzora… Okreni telefon u obliku osmice za kalibraciju.';
    setTimeout(()=>{if(heading===null&&compassActive)$('compassStatus').textContent='Senzor ne šalje pouzdan smjer. Koristi prikaz stepeni od geografskog sjevera.'},4000);
  }catch{$('compassStatus').textContent='Pristup kompasu nije dostupan. Koristi prikaz stepeni od sjevera.'}
}
$('methodSelect').value=method;$('schoolSelect').value=school;
$('timesTab').addEventListener('click',()=>setView('times'));
$('qiblaTab').addEventListener('click',()=>setView('qibla'));
$('searchToggle').addEventListener('click',()=>{const show=$('searchArea').hidden;$('searchArea').hidden=!show;$('searchToggle').setAttribute('aria-expanded',String(show));if(show)$('cityInput').focus()});
$('searchForm').addEventListener('submit',searchCities);
$('gpsButton').addEventListener('click',startGPS);
$('compassButton').addEventListener('click',activateCompass);
$('settingsButton').addEventListener('click',()=>{
  const alBadr=usesAlBadr();
  $('calculationSettings').hidden=alBadr;
  $('alBadrSettings').hidden=!alBadr;
  if(!alBadr){makeOffsets();makeManual()}
  $('settingsDialog').showModal();
});
$('closeSettings').addEventListener('click',()=>$('settingsDialog').close());
$('saveSettings').addEventListener('click',saveSettings);
$('resetOffsets').addEventListener('click',()=>{save(offsetKey(),{});makeOffsets()});
$('clearManual').addEventListener('click',()=>{const p=zoned(new Date(),place.timezone);localStorage.removeItem(manualKey(p));makeManual()});
updatePlace();loadTimings();setInterval(updateCountdown,1000);
if(saved('ns3_follow_gps',false))startGPS();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
