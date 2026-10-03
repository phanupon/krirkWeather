'use strict';

/* =====================================================================
 * ระบบพยากรณ์อากาศและภัยธรรมชาติ
 * แหล่งข้อมูล (ไม่ต้องใช้ API key):
 *   - Open-Meteo Forecast  : พยากรณ์อากาศ / ฝน
 *   - Open-Meteo Flood     : อัตราการไหลของแม่น้ำ (GloFAS)
 *   - Open-Meteo Marine    : ระดับน้ำทะเล (น้ำขึ้นน้ำลง)
 *   - Open-Meteo Geocoding : ค้นหาสถานที่
 *   - USGS                 : แผ่นดินไหว
 * ===================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const DEFAULT_LOC = { lat: 13.7563, lon: 100.5018, name: 'กรุงเทพมหานคร, ประเทศไทย' };

const TIDE_PRESETS = [
  { name: 'ปากแม่น้ำเจ้าพระยา', lat: 13.43, lon: 100.60 },
  { name: 'บางแสน', lat: 13.28, lon: 100.90 },
  { name: 'พัทยา', lat: 12.93, lon: 100.85 },
  { name: 'ระยอง', lat: 12.63, lon: 101.30 },
  { name: 'หัวหิน', lat: 12.57, lon: 100.00 },
  { name: 'เกาะสมุย', lat: 9.50, lon: 100.10 },
  { name: 'สงขลา', lat: 7.22, lon: 100.65 },
  { name: 'ภูเก็ต', lat: 7.85, lon: 98.25 },
  { name: 'กระบี่', lat: 8.00, lon: 98.80 },
];

const state = {
  loc: loadLoc(),
  weather: null,
  tideLoc: null,
  charts: {},
  maps: {},
  loaded: {},
  activeTab: 'overview',
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function loadLoc() {
  try { return JSON.parse(localStorage.getItem('ww.loc')) || DEFAULT_LOC; } catch { return DEFAULT_LOC; }
}
function saveLoc(loc) {
  try { localStorage.setItem('ww.loc', JSON.stringify(loc)); } catch { /* ignore */ }
}

async function getJSON(url, timeoutMs = 0) {
  const res = await fetch(url, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined)
    .catch(e => { throw new Error(e.name === 'TimeoutError' ? 'หมดเวลาเชื่อมต่อ' : e.message); });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try { const j = await res.json(); reason = j.reason || reason; } catch { /* ignore */ }
    throw new Error(reason);
  }
  return res.json();
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sum = arr => arr.reduce((a, b) => a + (b ?? 0), 0);
const maxOf = arr => arr.reduce((m, v) => (v != null && v > m ? v : m), -Infinity);
const fmt = (n, d = 0) =>
  n == null || !isFinite(n) ? '–' : Number(n).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });

const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** แปลงเวลา "YYYY-MM-DDTHH:MM" (เวลาท้องถิ่นของตำแหน่ง) เป็น Date แบบ naive */
function parseLocal(t) {
  const [d, h = '00:00'] = t.split('T');
  const [Y, M, D] = d.split('-').map(Number);
  const [hh, mm] = h.split(':').map(Number);
  return new Date(Y, M - 1, D, hh, mm);
}
/** เวลาปัจจุบันของตำแหน่ง (naive) จาก utc offset */
function nowAt(offsetSec) {
  const t = new Date(Date.now() + offsetSec * 1000);
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes());
}
const fmtDay = d => `${TH_DAYS[d.getDay()]} ${d.getDate()} ${TH_MONTHS[d.getMonth()]}`;
const fmtTime = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayLabel = t => fmtDay(parseLocal(t));

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function setStatus(id, msg, type = '') {
  const el = $('#' + id);
  el.className = 'status' + (type ? ' ' + type : '');
  el.innerHTML = msg || '';
}

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ------------------------------------------------------------------ */
/* Weather code (WMO) → คำอธิบายภาษาไทย                                */
/* ------------------------------------------------------------------ */

const WMO = {
  0: ['ท้องฟ้าแจ่มใส', '☀️', '🌙'], 1: ['มีเมฆเล็กน้อย', '🌤️', '🌙'], 2: ['มีเมฆบางส่วน', '⛅', '☁️'],
  3: ['เมฆมาก', '☁️'], 45: ['หมอก', '🌫️'], 48: ['หมอกเกาะน้ำแข็ง', '🌫️'],
  51: ['ฝนละอองเบาบาง', '🌦️'], 53: ['ฝนละออง', '🌦️'], 55: ['ฝนละอองหนาแน่น', '🌧️'],
  56: ['ฝนละอองเยือกแข็ง', '🌧️'], 57: ['ฝนละอองเยือกแข็ง', '🌧️'],
  61: ['ฝนเล็กน้อย', '🌦️'], 63: ['ฝนปานกลาง', '🌧️'], 65: ['ฝนหนัก', '🌧️'],
  66: ['ฝนเยือกแข็ง', '🌧️'], 67: ['ฝนเยือกแข็งหนัก', '🌧️'],
  71: ['หิมะเล็กน้อย', '🌨️'], 73: ['หิมะปานกลาง', '🌨️'], 75: ['หิมะหนัก', '❄️'], 77: ['เกล็ดหิมะ', '🌨️'],
  80: ['ฝนซู่เล็กน้อย', '🌦️'], 81: ['ฝนซู่ปานกลาง', '🌧️'], 82: ['ฝนซู่รุนแรง', '⛈️'],
  85: ['หิมะซู่', '🌨️'], 86: ['หิมะซู่หนัก', '❄️'],
  95: ['พายุฝนฟ้าคะนอง', '⛈️'], 96: ['พายุฝนฟ้าคะนองและลูกเห็บ', '⛈️'], 99: ['พายุฝนฟ้าคะนองและลูกเห็บรุนแรง', '⛈️'],
};
function wmo(code, isDay = 1) {
  const e = WMO[code] || ['ไม่ทราบ', '❔'];
  return [e[0], !isDay && e[2] ? e[2] : e[1]];
}

function windDir(deg) {
  const dirs = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
  return deg == null ? '' : 'จากทิศ' + dirs[Math.round(deg / 45) % 8];
}
function uvLevel(uv) {
  if (uv == null) return '';
  if (uv < 3) return '(ต่ำ)';
  if (uv < 6) return '(ปานกลาง)';
  if (uv < 8) return '(สูง)';
  if (uv < 11) return '(สูงมาก)';
  return '(อันตราย)';
}
function rainClass(mm) {
  if (mm == null || mm < 0.1) return { name: 'ไม่มีฝน', color: '#94a3b8' };
  if (mm <= 10) return { name: 'ฝนเล็กน้อย', color: '#7dd3fc' };
  if (mm <= 35) return { name: 'ฝนปานกลาง', color: '#3b82f6' };
  if (mm <= 90) return { name: 'ฝนหนัก', color: '#f97316' };
  return { name: 'ฝนหนักมาก', color: '#dc2626' };
}
function chanceLevel(p) {
  if (p < 20) return { name: 'ไม่น่ามีฝน', color: '#16a34a' };
  if (p < 40) return { name: 'โอกาสน้อย', color: '#65a30d' };
  if (p < 60) return { name: 'ปานกลาง', color: '#ca8a04' };
  if (p < 80) return { name: 'สูง', color: '#ea580c' };
  return { name: 'สูงมาก', color: '#dc2626' };
}

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

// ปลั๊กอินวาดเส้นแนวตั้ง "ขณะนี้"
Chart.register({
  id: 'nowLine',
  afterDatasetsDraw(chart, _args, opts) {
    if (opts.index == null) return;
    const x = chart.scales.x.getPixelForValue(opts.index);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillStyle = '#e11d48';
    ctx.font = '12px "IBM Plex Sans Thai", sans-serif';
    ctx.fillText(opts.label || 'ขณะนี้', x + 5, top + 12);
    ctx.restore();
  },
});

function makeChart(id, config) {
  state.charts[id]?.destroy();
  Chart.defaults.font.family = '"IBM Plex Sans Thai", sans-serif';
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--grid');
  config.options = Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
  }, config.options);
  state.charts[id] = new Chart($('#' + id), config);
}

/* ------------------------------------------------------------------ */
/* Location / search                                                   */
/* ------------------------------------------------------------------ */

async function setLocation(loc) {
  state.loc = { lat: +(+loc.lat).toFixed(4), lon: +(+loc.lon).toFixed(4), name: loc.name };
  saveLoc(state.loc);
  state.loaded = {};
  state.tideLoc = null;
  state.airStationId = null; // เลือกสถานีอากาศที่ใกล้ตำแหน่งใหม่
  renderLocBar();
  pickMarker?.setLatLng([state.loc.lat, state.loc.lon]);
  state.maps.pick?.setView([state.loc.lat, state.loc.lon], Math.max(state.maps.pick.getZoom(), 7));
  await loadWeatherAll();
  ensureTab(state.activeTab);
}

function renderLocBar() {
  $('#locName').textContent = '📍 ' + state.loc.name;
  $('#locCoord').textContent = `${state.loc.lat.toFixed(3)}°, ${state.loc.lon.toFixed(3)}°`;
}

async function reverseGeocode(lat, lon) {
  try {
    const j = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=th`);
    const parts = [j.city || j.locality, j.principalSubdivision, j.countryName].filter(Boolean);
    const uniq = [...new Set(parts)];
    if (uniq.length) return uniq.join(', ');
  } catch { /* ignore */ }
  return `พิกัด ${(+lat).toFixed(3)}, ${(+lon).toFixed(3)}`;
}

function initSearch() {
  const input = $('#searchInput'), list = $('#searchResults');
  let timer, items = [], active = -1;

  const close = () => { list.hidden = true; active = -1; };
  const choose = r => {
    close();
    input.value = '';
    setLocation({ lat: r.latitude, lon: r.longitude, name: [r.name, r.admin1, r.country].filter(Boolean).join(', ') });
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      try {
        const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=th&format=json`);
        items = j.results || [];
        list.innerHTML = items.length
          ? items.map((r, i) => `<li data-i="${i}">${r.name}<small>${[r.admin1, r.country].filter(Boolean).join(', ')} · ${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}</small></li>`).join('')
          : '<li class="muted">ไม่พบสถานที่ ลองพิมพ์เป็นภาษาอังกฤษ</li>';
        list.hidden = false;
        active = -1;
      } catch (e) {
        list.innerHTML = `<li class="muted">ค้นหาไม่สำเร็จ: ${e.message}</li>`;
        list.hidden = false;
      }
    }, 350);
  });

  list.addEventListener('click', e => {
    const li = e.target.closest('li[data-i]');
    if (li) choose(items[+li.dataset.i]);
  });
  input.addEventListener('keydown', e => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      $$('li', list).forEach((li, i) => li.classList.toggle('active', i === active));
    } else if (e.key === 'Enter') {
      choose(items[Math.max(active, 0)]);
    } else if (e.key === 'Escape') close();
  });
  document.addEventListener('click', e => { if (!e.target.closest('.search-box')) close(); });

  $('#geoBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return alert('เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง');
    $('#geoBtn').textContent = '⏳ กำลังระบุ…';
    navigator.geolocation.getCurrentPosition(async pos => {
      $('#geoBtn').textContent = '📍 ตำแหน่งของฉัน';
      const { latitude: lat, longitude: lon } = pos.coords;
      setLocation({ lat, lon, name: await reverseGeocode(lat, lon) });
    }, err => {
      $('#geoBtn').textContent = '📍 ตำแหน่งของฉัน';
      alert('ไม่สามารถระบุตำแหน่งได้: ' + err.message);
    }, { enableHighAccuracy: false, timeout: 10000 });
  });
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function initTabs() {
  $$('.tab').forEach(btn => btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    state.activeTab = tab;
    $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
    ensureTab(tab);
    // Leaflet ต้องคำนวณขนาดใหม่เมื่อ panel ถูกแสดง
    setTimeout(() => Object.values(state.maps).forEach(m => m.invalidateSize()), 50);
  }));
}

function ensureTab(tab) {
  if (state.loaded[tab]) return;
  if (tab === 'flood' && state.weather) { state.loaded.flood = true; loadFlood(); }
  if (tab === 'radar') { state.loaded.radar = true; loadRadar(); }
  if (tab === 'water') { state.loaded.water = true; loadWater(); }
  if (tab === 'air') { state.loaded.air = true; loadAir(); }
  if (tab === 'fire') { state.loaded.fire = true; loadFire(); }
  if (tab === 'quake') { state.loaded.quake = true; loadQuakes(); }
  if (tab === 'tide') { state.loaded.tide = true; loadTide(); }
}

/* ------------------------------------------------------------------ */
/* 1) พยากรณ์อากาศ                                                     */
/* ------------------------------------------------------------------ */

async function loadWeatherAll() {
  setStatus('overviewStatus', 'กำลังโหลดข้อมูลพยากรณ์อากาศ…', 'loading');
  setStatus('rainStatus', 'กำลังโหลดข้อมูล…', 'loading');
  const { lat, lon } = state.loc;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,is_day' +
    '&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,pressure_msl,cape' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,precipitation_hours,wind_speed_10m_max,uv_index_max,sunrise,sunset' +
    '&timezone=auto&past_days=7&forecast_days=16';
  try {
    const w = await getJSON(url);
    const nowKey = w.current.time.slice(0, 13);
    w.hIdx = Math.max(0, w.hourly.time.findIndex(t => t.slice(0, 13) === nowKey));
    w.dIdx = Math.max(0, w.daily.time.indexOf(w.current.time.slice(0, 10)));
    state.weather = w;
    renderOverview(w);
    renderRain(w);
    renderRainRadarCard();
    loadThaiWater()
      .then(tw => { if (state.weather === w) renderRainObs(tw); })
      .catch(e => { $('#rainObs').innerHTML = `<p class="muted">โหลดข้อมูลสถานีวัดฝน ThaiWater ไม่สำเร็จ: ${e.message}</p>`; });
    setStatus('overviewStatus', '');
    setStatus('rainStatus', '');
    $('#updated').textContent = `อัปเดต ${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น. · เขตเวลา ${w.timezone} · ความสูง ${fmt(w.elevation)} ม.`;
  } catch (e) {
    const msg = `โหลดข้อมูลพยากรณ์อากาศไม่สำเร็จ: ${e.message}`;
    setStatus('overviewStatus', msg, 'error');
    setStatus('rainStatus', msg, 'error');
  }
}

const kv = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;

function renderOverview(w) {
  const c = w.current, d = w.daily, i = w.dIdx;
  const [desc, icon] = wmo(c.weather_code, c.is_day);
  $('#currentCard').innerHTML = `
    <h3>สภาพอากาศขณะนี้ <span class="muted">(${c.time.slice(11, 16)} น. เวลาท้องถิ่น)</span></h3>
    <div class="cur-top">
      <div class="cur-icon">${icon}</div>
      <div>
        <div class="cur-temp">${fmt(c.temperature_2m, 1)}°C</div>
        <div class="cur-desc">${desc}</div>
        <div class="muted">รู้สึกเหมือน ${fmt(c.apparent_temperature, 1)}°C · สูงสุด ${fmt(d.temperature_2m_max[i])}° / ต่ำสุด ${fmt(d.temperature_2m_min[i])}°</div>
      </div>
    </div>
    <div class="kv">
      ${kv('💧 ความชื้นสัมพัทธ์', fmt(c.relative_humidity_2m) + '%')}
      ${kv('🌬️ ลม', `${fmt(c.wind_speed_10m)} กม./ชม. ${windDir(c.wind_direction_10m)}`)}
      ${kv('☁️ เมฆปกคลุม', fmt(c.cloud_cover) + '%')}
      ${kv('🧭 ความกดอากาศ', fmt(c.pressure_msl) + ' hPa')}
      ${kv('🌧️ โอกาสฝนวันนี้', fmt(d.precipitation_probability_max[i]) + '%')}
      ${kv('☀️ ดัชนี UV สูงสุด', `${fmt(d.uv_index_max[i], 1)} ${uvLevel(d.uv_index_max[i])}`)}
      ${kv('🌅 ดวงอาทิตย์ขึ้น', d.sunrise[i].slice(11) + ' น.')}
      ${kv('🌇 ดวงอาทิตย์ตก', d.sunset[i].slice(11) + ' น.')}
    </div>`;

  // กราฟรายชั่วโมง 24 ชม.
  const h = w.hourly, s = w.hIdx, e = s + 24;
  makeChart('hourlyChart', {
    type: 'bar',
    data: {
      labels: h.time.slice(s, e).map(t => t.slice(11, 16)),
      datasets: [
        {
          type: 'line', label: 'อุณหภูมิ (°C)', data: h.temperature_2m.slice(s, e),
          borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,.15)', fill: true, tension: .35, yAxisID: 'y', pointRadius: 2,
        },
        {
          label: 'โอกาสฝน (%)', data: h.precipitation_probability.slice(s, e),
          backgroundColor: 'rgba(59,130,246,.45)', borderRadius: 4, yAxisID: 'y1',
        },
      ],
    },
    options: {
      scales: {
        y: { position: 'left', title: { display: true, text: '°C' } },
        y1: { position: 'right', min: 0, max: 100, grid: { display: false }, title: { display: true, text: '%' } },
      },
    },
  });

  // รายวัน 16 วัน
  $('#dailyList').innerHTML = d.time.slice(i).map((t, k) => {
    const j = i + k;
    const [dsc, ic] = wmo(d.weather_code[j]);
    return `<div class="day ${k === 0 ? 'today' : ''}" title="${dsc}">
      <div class="d-name">${k === 0 ? 'วันนี้' : dayLabel(t)}</div>
      <div class="d-icon">${ic}</div>
      <div class="d-temp">${fmt(d.temperature_2m_max[j])}° <small>${fmt(d.temperature_2m_min[j])}°</small></div>
      <div class="d-rain">💧 ${fmt(d.precipitation_probability_max[j])}% · ${fmt(d.precipitation_sum[j], 1)} มม.</div>
    </div>`;
  }).join('');
}

let pickMarker = null;
function initPickMap() {
  const map = L.map('pickMap').setView([state.loc.lat, state.loc.lon], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap',
  }).addTo(map);
  pickMarker = L.marker([state.loc.lat, state.loc.lon]).addTo(map);
  map.on('click', async ev => {
    const { lat, lng } = ev.latlng;
    pickMarker.setLatLng(ev.latlng);
    setLocation({ lat, lon: lng, name: await reverseGeocode(lat, lng) });
  });
  state.maps.pick = map;
}

/* ------------------------------------------------------------------ */
/* 2) ทำนายฝน                                                          */
/* ------------------------------------------------------------------ */

/** ดัชนีโอกาสฝน 0–100 จากหลายปัจจัยอุตุนิยมวิทยา */
function rainIndex(h, i) {
  const p = h.precipitation_probability[i] ?? 0;
  const rh = h.relative_humidity_2m[i] ?? 0;
  const cc = h.cloud_cover[i] ?? 0;
  const cape = h.cape?.[i] ?? 0;
  const dp = i >= 3 && h.pressure_msl[i] != null && h.pressure_msl[i - 3] != null ? h.pressure_msl[i] - h.pressure_msl[i - 3] : 0;
  const fRH = clamp((rh - 60) / 35, 0, 1) * 100;
  const fCape = clamp(cape / 2000, 0, 1) * 100;
  const fP = clamp(-dp / 2, 0, 1) * 100;
  return clamp(0.55 * p + 0.15 * fRH + 0.12 * cc + 0.12 * fCape + 0.06 * fP, 0, 100);
}

function renderRain(w) {
  const h = w.hourly, s = w.hIdx, d = w.daily, di = w.dIdx;
  const e = Math.min(s + 72, h.time.length);
  const idxs = Array.from({ length: e - s }, (_, k) => s + k);
  const index = idxs.map(i => rainIndex(h, i));

  const r24 = sum(h.precipitation.slice(s, s + 24));
  const r72 = sum(h.precipitation.slice(s, s + 72));
  const idx24 = maxOf(index.slice(0, 24));
  const nextRain = idxs.find(i => (h.precipitation_probability[i] ?? 0) >= 50 || (h.precipitation[i] ?? 0) >= 0.5);
  const cl24 = chanceLevel(idx24);

  const tile = (label, value, sub, color) =>
    `<div class="tile"><div class="t-label">${label}</div><div class="t-value" ${color ? `style="color:${color}"` : ''}>${value}</div><div class="t-sub">${sub}</div></div>`;

  let nextTxt = 'ไม่คาดว่าจะมีฝนใน 72 ชม.', nextSub = '';
  if (nextRain != null) {
    const dt = parseLocal(h.time[nextRain]);
    nextTxt = nextRain === s ? 'กำลังมีฝน / ขณะนี้' : `${fmtTime(dt)} น.`;
    nextSub = `${fmtDay(dt)} · โอกาส ${fmt(h.precipitation_probability[nextRain])}%`;
  }

  $('#rainTiles').innerHTML =
    tile('ดัชนีโอกาสฝน 24 ชม.', `${fmt(idx24)} / 100`, `<span class="badge" style="background:${cl24.color}">${cl24.name}</span>`, cl24.color) +
    tile('ฝนสะสม 24 ชม. ข้างหน้า', `${fmt(r24, 1)} มม.`, rainClass(r24).name) +
    tile('ฝนสะสม 72 ชม. ข้างหน้า', `${fmt(r72, 1)} มม.`, `เฉลี่ย ${fmt(r72 / 3, 1)} มม./วัน`) +
    tile('คาดว่าฝนจะเริ่มตก', nextTxt, nextSub);

  // ---- บทวิเคราะห์ ----
  const notes = [];
  let peakI = idxs[0];
  idxs.forEach(i => { if ((h.precipitation_probability[i] ?? 0) > (h.precipitation_probability[peakI] ?? 0)) peakI = i; });
  const peakDt = parseLocal(h.time[peakI]);
  notes.push(`ช่วง 24 ชั่วโมงข้างหน้า คาดว่ามีปริมาณฝนสะสม <b>${fmt(r24, 1)} มม.</b> (${rainClass(r24).name}) ดัชนีโอกาสฝนสูงสุด <b>${fmt(idx24)}</b> — ${cl24.name}`);
  if ((h.precipitation_probability[peakI] ?? 0) > 0) {
    notes.push(`ช่วงที่มีโอกาสฝนสูงสุดใน 72 ชม.: <b>${fmtDay(peakDt)} เวลา ${fmtTime(peakDt)} น.</b> (${fmt(h.precipitation_probability[peakI])}%)`);
  }

  const cape24 = maxOf((h.cape || []).slice(s, s + 24));
  if (cape24 > 1000 && idx24 >= 40) {
    notes.push(`⚡ บรรยากาศไม่มีเสถียรภาพ (CAPE สูงสุด ${fmt(cape24)} J/kg) มีโอกาสเกิด <b>พายุฝนฟ้าคะนอง ฟ้าผ่า และลมกระโชกแรง</b>`);
  }
  const p0 = h.pressure_msl[s], p24 = h.pressure_msl[Math.min(s + 24, h.time.length - 1)];
  if (p0 != null && p24 != null) {
    const dp = p24 - p0;
    const trend = dp <= -2 ? 'ลดลงชัดเจน (มักสัมพันธ์กับหย่อมความกดอากาศต่ำ/ร่องมรสุม — เพิ่มโอกาสฝน)'
      : dp >= 2 ? 'เพิ่มขึ้น (อากาศมีแนวโน้มแห้งและเสถียรขึ้น)' : 'ค่อนข้างคงที่';
    notes.push(`ความกดอากาศ 24 ชม. ข้างหน้า ${dp >= 0 ? '+' : ''}${fmt(dp, 1)} hPa — ${trend}`);
  }
  const rh24 = sum(h.relative_humidity_2m.slice(s, s + 24)) / 24;
  notes.push(`ความชื้นสัมพัทธ์เฉลี่ย ${fmt(rh24)}% ${rh24 >= 80 ? '— ความชื้นสูง เอื้อต่อการเกิดฝน' : rh24 < 60 ? '— อากาศค่อนข้างแห้ง' : ''}`);

  const heavyDays = d.time.slice(di).map((t, k) => ({ t, mm: d.precipitation_sum[di + k] })).filter(x => x.mm > 35);
  if (heavyDays.length) {
    notes.push('🌧️ วันที่คาดว่าจะมีฝนหนัก: ' + heavyDays.map(x => `<b>${dayLabel(x.t)}</b> (${fmt(x.mm, 1)} มม. – ${rainClass(x.mm).name})`).join(', '));
  } else {
    notes.push('ไม่พบวันที่คาดว่าจะมีฝนหนัก (> 35 มม./วัน) ในช่วง 16 วันข้างหน้า');
  }
  $('#rainInsight').innerHTML = `<ul>${notes.map(n => `<li>${n}</li>`).join('')}</ul>`;

  // ---- กราฟรายชั่วโมง 72 ชม. ----
  makeChart('rainHourlyChart', {
    type: 'bar',
    data: {
      labels: idxs.map(i => {
        const dt = parseLocal(h.time[i]);
        return dt.getHours() === 0 ? [fmtTime(dt), fmtDay(dt)] : fmtTime(dt);
      }),
      datasets: [
        { label: 'ปริมาณฝน (มม.)', data: idxs.map(i => h.precipitation[i]), backgroundColor: '#3b82f6', borderRadius: 3, yAxisID: 'y1', order: 2 },
        { type: 'line', label: 'โอกาสฝนจากแบบจำลอง (%)', data: idxs.map(i => h.precipitation_probability[i]), borderColor: '#94a3b8', borderDash: [5, 4], pointRadius: 0, tension: .3, yAxisID: 'y', order: 1 },
        { type: 'line', label: 'ดัชนีโอกาสฝน (0–100)', data: index, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.12)', fill: true, pointRadius: 0, tension: .3, yAxisID: 'y', order: 0 },
      ],
    },
    options: {
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 18 } },
        y: { min: 0, max: 100, title: { display: true, text: 'โอกาส / ดัชนี' } },
        y1: { position: 'right', min: 0, suggestedMax: 5, grid: { display: false }, title: { display: true, text: 'มม./ชม.' } },
      },
    },
  });

  // ---- กราฟรายวัน ----
  const dd = d.time.slice(di);
  const rainDaily = d.precipitation_sum.slice(di);
  makeChart('rainDailyChart', {
    type: 'bar',
    data: {
      labels: dd.map((t, k) => (k === 0 ? 'วันนี้' : dayLabel(t))),
      datasets: [
        { label: 'ปริมาณฝน (มม.)', data: rainDaily, backgroundColor: rainDaily.map(v => rainClass(v).color), borderRadius: 4, yAxisID: 'y' },
        { type: 'line', label: 'โอกาสฝนสูงสุด (%)', data: d.precipitation_probability_max.slice(di), borderColor: '#8b5cf6', pointRadius: 3, tension: .3, yAxisID: 'y1' },
      ],
    },
    options: {
      scales: {
        y: { min: 0, suggestedMax: 20, title: { display: true, text: 'มม./วัน' } },
        y1: { position: 'right', min: 0, max: 100, grid: { display: false }, title: { display: true, text: '%' } },
      },
      plugins: {
        tooltip: { callbacks: { afterLabel: c => (c.datasetIndex === 0 ? rainClass(c.raw).name : '') } },
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/* เรดาร์ฝน + พยากรณ์ฝนระยะสั้น (nowcast)                                */
/*   RainViewer : ภาพเรดาร์รวมทุก 10 นาที ย้อนหลัง 2 ชม. (ถอดค่า dBZ จากสี)  */
/*   กรมฝนหลวงฯ  : ภาพ CAPPI ความละเอียดสูงรายสถานี ทุก 6 นาที             */
/*                                                                      */
/*   Nowcast: ประมาณเวกเตอร์การเคลื่อนตัวของกลุ่มฝน (block matching)       */
/*   แล้วเลื่อนภาพล่าสุดไปข้างหน้า (semi-Lagrangian) และคิดโอกาสฝนเป็น       */
/*   สัดส่วนพื้นที่มีฝนในรัศมี ~12 กม. (neighbourhood probability)          */
/*   ทดสอบกับข้อมูลจริง: Brier score ดีกว่าการคงสภาพ (persistence) ~30%     */
/*   ที่ +30 นาที จึงผสมกับแบบจำลองโดยลดน้ำหนักเรดาร์ลงจนเป็น 0 ที่ +90 นาที  */
/* ------------------------------------------------------------------ */

// RainViewer "Universal Blue" palette: dBZ −32…95 (8 hex/ค่า, RGBA) จาก rainviewer_api_colors_table.csv
const RV_UB_RAIN = '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006361591466635a1969665c1e6c685d246f6b5f29726e612e75706234787364397c75653e7f786744827b6949857d6a4e88806c548b826d598e856f5e928871649e93756eaa9e7978b6a97e82c2b4828ccec08796d2c48ba0d6c88faadacc93b4ded097be88ddeeff6cd1ebff51c5e8ff36bae5ff1baee2ff00a3e0ff009ad5ff0091caff0088bfff007fb4ff0077aaff0070a3ff00699cff006295ff005b8eff005588ff005180ff004e78ff004a70ff004768ffffee00ffffe000ffffd200ffffc500ffffb700ffffaa00ffff9f00ffff9500ffff8b00ffff8100ffff4400fff23600ffe62800ffd91b00ffcd0d00ffc10000ffa80000ff8f0000ff760000ff5d0000ffffaaffffff9fffffff95ffffff8bffffff81ffffff77ffffff6cffffff62ffffff58ffffff4effffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff';
const RV_UB_SNOW = '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cfffff00ceffff0ccdffff19ccffff26cbffff33cbffff3fcaffff4cc9ffff59c8ffff66c7ffff72c7ffff7fc6ffff8cc5ffff99c4ffffa5c3ffffb2c3ffffbfc2ffffccc1ffffd8c0ffffe5bffffff2bfffffffb8f8ffffb2f2ffffabebffffa5e5ffff9fdfffff98d8ffff92d2ffff8bcbffff85c5ffff7fbfffff78b8ffff72b2ffff6babffff65a5ffff5f9fffff5b9bffff5898ffff5595ffff5292ffff4f8fffff4b8bffff4888ffff4585ffff4282ffff3f7fffff3b7bffff3878ffff3575ffff3272ffff2f6fffff2b6bffff2868ffff2565ffff2262ffff1f5fffff1b5bffff1858ffff1555ffff1252ffff0f4fffff0c4bffff0948ffff0645ffff0242ffff003fffff003bffff0038ffff0035ffff0032ffff002fffff002bffff0028ffff0025ffff0022ffff001fffff001bffff0018ffff0015ffff0012ffff000fffff000cffff0009ffff0006ffff0002ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff';

const RV_API = 'https://api.rainviewer.com/public/weather-maps.json';
const RV_Z = 7;            // ซูมสูงสุดที่ RainViewer (บริการฟรี) ให้ข้อมูล ~1.2 กม./px
const RV_N = 3;            // โดเมนวิเคราะห์ 3×3 ไทล์ (~900 กม.)
const RV_S = 256 * RV_N;   // 768 px
const NC_STEPS = 9;        // คาดการณ์ 9 × 10 นาที = 90 นาที
const NC_R = 10;           // รัศมีย่าน 10 px ≈ 12 กม.
const RAIN_DBZ = 20;       // ≥ 20 dBZ ≈ ฝน 0.6 มม./ชม. ขึ้นไป
const NC_BLEND_MIN = 90;   // น้ำหนักเรดาร์ลดเป็นเส้นตรงจาก 1 → 0 ภายใน 90 นาที

const hexRgba = (s, i) => [0, 2, 4, 6].map(k => parseInt(s.substr(i * 8 + k, 2), 16));
// Uint32 ของ ImageData (little-endian) = A<<24 | B<<16 | G<<8 | R
const rgbaKey = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
const RV_TABLE = [RV_UB_RAIN, RV_UB_SNOW].flatMap(s => Array.from({ length: 128 }, (_, i) => [...hexRgba(s, i), i - 32]))
  .filter(([, , , a]) => a > 0);
const RV_DECODE = new Map();
RV_TABLE.forEach(([r, g, b, a, d]) => { const k = rgbaKey(r, g, b, a); if (!RV_DECODE.has(k)) RV_DECODE.set(k, d); });
/** สี → dBZ (canvas อาจปัดค่าสีโปร่งแสง จึงหาสีที่ใกล้ที่สุดเมื่อไม่ตรงพอดี) */
function rvDecode(v) {
  if ((v >>> 24) === 0) return -32;
  let d = RV_DECODE.get(v);
  if (d !== undefined) return d;
  const r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255, a = v >>> 24;
  let best = Infinity;
  RV_TABLE.forEach(([R, G, B, A, D]) => { const e = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2 + (A - a) ** 2; if (e < best) { best = e; d = D; } });
  RV_DECODE.set(v, d);
  return d;
}
const RV_RGBA = new Uint8ClampedArray(128 * 4);
for (let i = 0; i < 128; i++) hexRgba(RV_UB_RAIN, i).forEach((v, k) => { RV_RGBA[i * 4 + k] = v; });
const dbzColor = d => { const i = clamp(Math.round(d) + 32, 0, 127) * 4; return `rgba(${RV_RGBA[i]},${RV_RGBA[i + 1]},${RV_RGBA[i + 2]},${RV_RGBA[i + 3] / 255})`; };
/** Marshall–Palmer: Z = 200 R^1.6 */
const dbzToRate = d => (d < 15 ? 0 : Math.pow(Math.pow(10, d / 10) / 200, 1 / 1.6));
const rateName = r => (r < 0.1 ? 'ไม่มีฝน' : r < 2.5 ? 'ฝนเล็กน้อย' : r < 7.6 ? 'ฝนปานกลาง' : r < 50 ? 'ฝนหนัก' : 'ฝนหนักมาก');

const tileXYf = (lat, lon, z) => {
  const n = 2 ** z;
  return { x: (lon + 180) / 360 * n, y: (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n };
};
const tile2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const rvTileUrl = (host, path, z, x, y) => `${host}${path}/256/${z}/${x}/${y}/2/1_1.png`;
const unixHHMM = (t, off) => { const d = new Date((t + off) * 1000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

function loadRvIndex() {
  if (state.rvIndexPromise && Date.now() - state.rvIndexTime < 3 * 60e3) return state.rvIndexPromise;
  state.rvIndexTime = Date.now();
  state.rvIndexPromise = getJSON(RV_API, 20e3);
  state.rvIndexPromise.catch(() => { state.rvIndexTime = 0; });
  return state.rvIndexPromise;
}

function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('โหลดภาพเรดาร์ไม่สำเร็จ'));
    im.src = url;
  });
}

const rvGridCache = new Map();
/** โหลดไทล์ 3×3 ของเฟรมหนึ่ง แล้วถอดเป็นตาราง dBZ (Float32Array RV_S×RV_S) */
function rvGrid(host, path, cx, cy) {
  const key = `${path}|${cx}|${cy}`;
  if (rvGridCache.has(key)) return rvGridCache.get(key);
  if (rvGridCache.size > 40) rvGridCache.delete(rvGridCache.keys().next().value);
  const p = (async () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = RV_S;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let j = 0; j < RV_N; j++) {
      for (let i = 0; i < RV_N; i++) {
        jobs.push(loadImg(rvTileUrl(host, path, RV_Z, cx - 1 + i, cy - 1 + j)).then(im => ctx.drawImage(im, i * 256, j * 256)));
      }
    }
    await Promise.all(jobs);
    const px = new Uint32Array(ctx.getImageData(0, 0, RV_S, RV_S).data.buffer);
    const g = new Float32Array(RV_S * RV_S);
    for (let i = 0; i < px.length; i++) g[i] = rvDecode(px[i]);
    return g;
  })();
  p.catch(() => rvGridCache.delete(key));
  rvGridCache.set(key, p);
  return p;
}

/** ลดความละเอียด 2× (ค่าสูงสุด) และตัดค่าต่ำกว่า 10 dBZ */
function down2(g) {
  const n = RV_S / 2, out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = 2 * y * RV_S + 2 * x;
      out[y * n + x] = Math.max(0, Math.max(g[i], g[i + 1], g[i + RV_S], g[i + RV_S + 1]) - 10);
    }
  }
  return out;
}

/** Block matching ระหว่างสองเฟรม → เวกเตอร์ต่อบล็อก (px ของกริดลดความละเอียด / 10 นาที) */
function motionPair(A, Bm, B = 48, R = 6) {
  const n = RV_S / 2, nb = n / B, W = 2 * R + 1;
  const vx = new Float32Array(nb * nb).fill(NaN), vy = new Float32Array(nb * nb).fill(NaN);
  const sc = new Float64Array(W * W);
  for (let by = 0; by < nb; by++) {
    for (let bx = 0; bx < nb; bx++) {
      const y0 = by * B, x0 = bx * B;
      let echo = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) if (Bm[(y0 + y) * n + x0 + x] > 10) echo++;
      if (echo < 0.03 * B * B) continue; // ฝนน้อยเกินไปสำหรับประมาณการเคลื่อนที่
      sc.fill(Infinity);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const ys = y0 - dy, xs = x0 - dx;
          if (ys < 0 || xs < 0 || ys + B > n || xs + B > n) continue;
          let s = 0;
          for (let y = 0; y < B; y++) {
            const ra = (ys + y) * n + xs, rb = (y0 + y) * n + x0;
            for (let x = 0; x < B; x++) { const d = A[ra + x] - Bm[rb + x]; s += d * d; }
          }
          sc[(dy + R) * W + dx + R] = s;
        }
      }
      let bi = 0;
      for (let i = 1; i < sc.length; i++) if (sc[i] < sc[bi]) bi = i;
      const iy = Math.floor(bi / W), ix = bi % W;
      const sub = (a, b, c) => { const d = a - 2 * b + c; return isFinite(d) && d > 0 ? clamp(0.5 * (a - c) / d, -0.5, 0.5) : 0; };
      const oy = iy > 0 && iy < W - 1 ? sub(sc[(iy - 1) * W + ix], sc[bi], sc[(iy + 1) * W + ix]) : 0;
      const ox = ix > 0 && ix < W - 1 ? sub(sc[bi - 1], sc[bi], sc[bi + 1]) : 0;
      vx[by * nb + bx] = ix - R + ox;
      vy[by * nb + bx] = iy - R + oy;
    }
  }
  return { vx, vy, nb };
}

/** รวมเวกเตอร์จากหลายคู่เฟรม เติมบล็อกที่ไม่มีฝนด้วยค่ามัธยฐาน แล้วทำให้เรียบ 3×3 */
function motionField(pairs) {
  const ms = pairs.map(([a, b]) => motionPair(a, b));
  const nb = ms[0].nb, N = nb * nb;
  const vx = new Float32Array(N), vy = new Float32Array(N), ok = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let sx = 0, sy = 0, c = 0;
    ms.forEach(m => { if (!isNaN(m.vx[i])) { sx += m.vx[i]; sy += m.vy[i]; c++; } });
    if (c) { vx[i] = sx / c; vy[i] = sy / c; ok[i] = 1; }
  }
  const med = arr => { const v = [...arr].filter((_, i) => ok[i]).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  const gx = med(vx), gy = med(vy);
  for (let i = 0; i < N; i++) if (!ok[i]) { vx[i] = gx; vy[i] = gy; }
  const sm = v => v.map((_, i) => {
    const by = Math.floor(i / nb), bx = i % nb;
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += v[clamp(by + dy, 0, nb - 1) * nb + clamp(bx + dx, 0, nb - 1)];
    return s / 9;
  });
  return { vx: sm(vx), vy: sm(vy), nb, gx, gy, valid: ok.reduce((a, b) => a + b, 0) };
}

/** ขยายสนามเวกเตอร์เป็นความละเอียดเต็ม (bilinear) หน่วย px เต็ม / 10 นาที */
function upsampleField(F) {
  const { nb } = F, U = new Float32Array(RV_S * RV_S), V = new Float32Array(RV_S * RV_S);
  for (let y = 0; y < RV_S; y++) {
    const fy = (y + 0.5) / RV_S * nb - 0.5, y0 = clamp(Math.floor(fy), 0, nb - 1), y1 = Math.min(y0 + 1, nb - 1), wy = clamp(fy - y0, 0, 1);
    for (let x = 0; x < RV_S; x++) {
      const fx = (x + 0.5) / RV_S * nb - 0.5, x0 = clamp(Math.floor(fx), 0, nb - 1), x1 = Math.min(x0 + 1, nb - 1), wx = clamp(fx - x0, 0, 1);
      const bl = (a) => (a[y0 * nb + x0] * (1 - wy) * (1 - wx) + a[y0 * nb + x1] * (1 - wy) * wx + a[y1 * nb + x0] * wy * (1 - wx) + a[y1 * nb + x1] * wy * wx) * 2;
      U[y * RV_S + x] = bl(F.vx);
      V[y * RV_S + x] = bl(F.vy);
    }
  }
  return { U, V };
}

/** เลื่อนภาพไปข้างหน้า steps × 10 นาที (backward semi-Lagrangian) */
function advect(src, VF, steps) {
  const out = new Float32Array(RV_S * RV_S);
  for (let y = 0; y < RV_S; y++) {
    for (let x = 0; x < RV_S; x++) {
      const i = y * RV_S + x;
      const sx = Math.round(x - VF.U[i] * steps), sy = Math.round(y - VF.V[i] * steps);
      out[i] = sx < 0 || sy < 0 || sx >= RV_S || sy >= RV_S ? -32 : src[sy * RV_S + sx];
    }
  }
  return out;
}

/** สัดส่วนพื้นที่มีฝนและความแรงฝนเฉลี่ยในรัศมี r รอบจุด (px, py) */
function pointStats(g, px, py, r = NC_R) {
  let n = 0, wet = 0, rate = 0;
  const cx = Math.round(px), cy = Math.round(py);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= RV_S || y >= RV_S) continue;
      const d = g[y * RV_S + x];
      n++;
      if (d >= RAIN_DBZ) wet++;
      rate += dbzToRate(d);
    }
  }
  const c = g[clamp(cy, 0, RV_S - 1) * RV_S + clamp(cx, 0, RV_S - 1)];
  return { prob: n ? wet / n : 0, rate: n ? rate / n : 0, dbz: c, pointRate: dbzToRate(c) };
}

/** ความน่าจะเป็นแบบย่านสำหรับทุกพิกเซล (integral image) */
function neighbourhoodProb(g, r = NC_R) {
  const S = RV_S, I = new Float64Array((S + 1) * (S + 1));
  for (let y = 0; y < S; y++) {
    let row = 0;
    for (let x = 0; x < S; x++) {
      row += g[y * S + x] >= RAIN_DBZ ? 1 : 0;
      I[(y + 1) * (S + 1) + x + 1] = I[y * (S + 1) + x + 1] + row;
    }
  }
  const P = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(S, y + r + 1);
    for (let x = 0; x < S; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(S, x + r + 1);
      const s = I[y1 * (S + 1) + x1] - I[y0 * (S + 1) + x1] - I[y1 * (S + 1) + x0] + I[y0 * (S + 1) + x0];
      P[y * S + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return P;
}

/**
 * คำนวณ nowcast สำหรับตำแหน่ง (แคชตามเฟรมล่าสุด + ตำแหน่ง)
 * ใช้ 7 เฟรมล่าสุด (60 นาที): 3 คู่ล่าสุดหาการเคลื่อนตัว และทดสอบย้อนหลังด้วยการทำนายจากเฟรม −30 นาที
 */
async function computeNowcast(lat, lon) {
  const idx = await loadRvIndex();
  const past = idx.radar?.past || [];
  if (past.length < 7) throw new Error('ข้อมูลเรดาร์ย้อนหลังไม่พอ');
  const tf = tileXYf(lat, lon, RV_Z), cx = Math.floor(tf.x), cy = Math.floor(tf.y);
  const key = `${past[past.length - 1].path}|${lat}|${lon}`;
  if (state.nowcast?.key === key) return state.nowcast;
  if (state.nowcastJob?.key === key) return state.nowcastJob.promise;

  const promise = (async () => {
    const use = past.slice(-7);
    const grids = await Promise.all(use.map(f => rvGrid(idx.host, f.path, cx, cy)));
    const D = grids.map(down2);
    const px = (tf.x - (cx - 1)) * 256, py = (tf.y - (cy - 1)) * 256;
    const kmPx = 156543.03 * Math.cos(lat * Math.PI / 180) / 2 ** RV_Z / 1000;

    // การเคลื่อนตัวปัจจุบันและภาพคาดการณ์
    const F = motionField([[D[3], D[4]], [D[4], D[5]], [D[5], D[6]]]);
    const VF = upsampleField(F);
    const last = grids[6];
    const fc = Array.from({ length: NC_STEPS }, (_, k) => advect(last, VF, k + 1));

    // ทดสอบย้อนหลัง: ทำนายจาก −30 นาที แล้วเทียบกับภาพจริงล่าสุด (ภายในโดเมนชั้นใน)
    const Fh = motionField([[D[0], D[1]], [D[1], D[2]], [D[2], D[3]]]);
    const Ph = neighbourhoodProb(advect(grids[3], upsampleField(Fh), 3));
    let bN = 0, bP = 0, cnt = 0, obsWet = 0;
    for (let y = 128; y < RV_S - 128; y += 2) {
      for (let x = 128; x < RV_S - 128; x += 2) {
        const i = y * RV_S + x, o = last[i] >= RAIN_DBZ ? 1 : 0, p0 = grids[3][i] >= RAIN_DBZ ? 1 : 0;
        bN += (Ph[i] - o) ** 2; bP += (p0 - o) ** 2; cnt++; obsWet += o;
      }
    }
    const skill = { brierNowcast: bN / cnt, brierPersist: bP / cnt, wetFrac: obsWet / cnt };

    // กลุ่มฝนที่ใกล้ที่สุด
    let nearest = null;
    for (let y = 0; y < RV_S; y++) {
      for (let x = 0; x < RV_S; x++) {
        if (last[y * RV_S + x] < RAIN_DBZ) continue;
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        if (!nearest || d2 < nearest.d2) nearest = { d2, x, y };
      }
    }
    if (nearest) {
      nearest.km = Math.sqrt(nearest.d2) * kmPx;
      nearest.dir = (Math.atan2(nearest.x - px, -(nearest.y - py)) * 180 / Math.PI + 360) % 360;
    }

    const speed = Math.hypot(F.gx, F.gy) * 2 * kmPx * 6; // กม./ชม.
    const heading = (Math.atan2(F.gx, -F.gy) * 180 / Math.PI + 360) % 360; // ทิศที่กลุ่มฝนเคลื่อนไป
    const t0 = use[6].time;
    const nc = {
      key, host: idx.host, past, cx, cy, px, py, kmPx, grids, fc, F, speed, heading, skill, nearest, t0,
      bounds: [[tile2lat(cy + 2, RV_Z), tile2lon(cx - 1, RV_Z)], [tile2lat(cy - 1, RV_Z), tile2lon(cx + 2, RV_Z)]],
      observed: use.map((f, k) => ({ t: f.time, ...pointStats(grids[k], px, py) })),
      forecast: fc.map((g, k) => ({ t: t0 + (k + 1) * 600, lead: (k + 1) * 10, ...pointStats(g, px, py) })),
    };
    state.nowcast = nc;
    return nc;
  })();
  state.nowcastJob = { key, promise };
  promise.finally(() => { if (state.nowcastJob?.key === key) state.nowcastJob = null; });
  return promise;
}

/** โอกาสฝนจากแบบจำลอง (Open-Meteo รายชั่วโมง) ณ เวลา unix t */
function modelProbAt(t) {
  const w = state.weather;
  if (!w) return null;
  const local = (t + w.utc_offset_seconds) / 3600;
  const h0 = Math.floor(local);
  const key = h => { const d = new Date(h * 3600e3); return d.toISOString().slice(0, 13); };
  const i0 = w.hourly.time.findIndex(x => x.slice(0, 13) === key(h0));
  if (i0 < 0) return null;
  const a = w.hourly.precipitation_probability[i0], b = w.hourly.precipitation_probability[i0 + 1] ?? a;
  return a == null ? null : a + (b - a) * (local - h0);
}

/** ผสมเรดาร์ + แบบจำลอง: น้ำหนักเรดาร์ 1 − lead/90 */
function blendedSeries(nc, hours = 6) {
  const out = [];
  const radarAt = lead => {
    if (lead <= 0) return nc.observed[nc.observed.length - 1].prob * 100;
    const k = Math.min(lead / 10, NC_STEPS), k0 = Math.floor(k), k1 = Math.ceil(k);
    const p = i => (i === 0 ? nc.observed[nc.observed.length - 1].prob : nc.forecast[i - 1].prob);
    return (p(k0) + (p(k1) - p(k0)) * (k - k0)) * 100;
  };
  for (let lead = 0; lead <= hours * 60; lead += 10) {
    const t = nc.t0 + lead * 60, m = modelProbAt(t);
    const w = Math.max(0, 1 - lead / NC_BLEND_MIN);
    const r = lead <= NC_STEPS * 10 ? radarAt(lead) : null;
    out.push({ t, lead, radar: r, model: m, blend: m == null ? r : r == null ? m : w * r + (1 - w) * m });
  }
  return out;
}

const probColor = p => (p >= 70 ? '#1d4ed8' : p >= 40 ? '#3b82f6' : p >= 20 ? '#7dd3fc' : '#94a3b8');

function nowcastSummary(nc) {
  const ser = blendedSeries(nc, 2);
  const at = lead => ser.find(s => s.lead === lead)?.blend ?? 0;
  const now = nc.observed[nc.observed.length - 1];
  const rainingNow = now.pointRate >= 0.5 || now.prob >= 0.4;
  let eta = null;
  if (rainingNow) {
    const stop = ser.find(s => s.lead > 0 && s.blend < 30);
    eta = stop ? { type: 'stop', lead: stop.lead } : null;
  } else {
    const start = ser.find(s => s.lead > 0 && s.blend >= 50);
    eta = start ? { type: 'start', lead: start.lead } : null;
  }
  return { ser, p30: at(30), p60: at(60), p90: at(90), now, rainingNow, eta };
}

function motionSvg(nc, size = 84) {
  const c = size / 2, moving = nc.speed >= 5;
  const a = (nc.heading - 90) * Math.PI / 180, L = c * 0.7;
  return `<svg viewBox="0 0 ${size} ${size}">
    <circle cx="${c}" cy="${c}" r="${c - 2}" fill="var(--surface-2)" stroke="var(--border)"/>
    <text x="${c}" y="11" text-anchor="middle" font-size="9" fill="var(--muted)">N</text>
    ${moving ? `<defs><marker id="mh" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#2563eb"/></marker></defs>
    <line x1="${c - L * Math.cos(a)}" y1="${c - L * Math.sin(a)}" x2="${c + L * Math.cos(a)}" y2="${c + L * Math.sin(a)}" stroke="#2563eb" stroke-width="4" marker-end="url(#mh)"/>`
    : `<circle cx="${c}" cy="${c}" r="7" fill="#2563eb" opacity=".6"/>`}
  </svg>`;
}

const motionText = nc => (nc.speed >= 5
  ? `กลุ่มฝนเคลื่อนตัวไปทาง<b>${dirName(nc.heading)}</b> ~${fmt(nc.speed)} กม./ชม.`
  : 'กลุ่มฝนแทบไม่เคลื่อนที่ (ฝนก่อตัวและสลายในพื้นที่ — มักเป็นฝนฟ้าคะนองช่วงบ่าย)');

const skillText = nc => {
  const { brierNowcast: n, brierPersist: p } = nc.skill;
  if (nc.skill.wetFrac < 0.002) return 'ขณะนี้มีฝนในโดเมนน้อยมาก ยังประเมินความแม่นยำไม่ได้';
  const imp = (1 - n / p) * 100;
  return `ทดสอบย้อนหลัง 30 นาทีบนภาพจริงล่าสุด: Brier score <b>${fmt(n, 4)}</b> เทียบกับการคงสภาพ ${fmt(p, 4)} — ` +
    (imp > 0 ? `<b style="color:#16a34a">แม่นยำกว่า ${fmt(imp)}%</b>` : `<b style="color:#dc2626">ด้อยกว่า ${fmt(-imp)}%</b>`);
};

/* ---------- การ์ดในแท็บทำนายฝน ---------- */

async function renderRainRadarCard() {
  const box = $('#rainRadar');
  try {
    const nc = await computeNowcast(state.loc.lat, state.loc.lon);
    if (nc.key.split('|').slice(1).join('|') !== `${state.loc.lat}|${state.loc.lon}`) return;
    const s = nowcastSummary(nc), off = state.weather?.utc_offset_seconds ?? BKK_OFFSET;
    const nowTxt = s.rainingNow ? `🌧️ มีฝนบริเวณตำแหน่งของคุณ ~${fmt(s.now.rate, 1)} มม./ชม. (${rateName(s.now.rate)})`
      : `☁️ ไม่มีฝนที่ตำแหน่งของคุณ${nc.nearest ? ` · กลุ่มฝนใกล้สุดห่าง ${fmt(nc.nearest.km)} กม. ทิศ${dirName(nc.nearest.dir)}` : ''}`;
    const etaTxt = !s.eta ? '' : s.eta.type === 'start' ? `<li>⏱️ คาดว่า<b>ฝนจะเริ่มตกในอีก ~${s.eta.lead} นาที</b></li>` : `<li>⏱️ คาดว่า<b>ฝนจะซาลงในอีก ~${s.eta.lead} นาที</b></li>`;
    box.innerHTML = `<div class="obs-grid">
      <ul>
        <li>${nowTxt} <small class="muted">(เรดาร์ ${unixHHMM(nc.t0, off)} น.)</small></li>
        ${etaTxt}
        <li>${motionText(nc)}</li>
        <li>${skillText(nc)}</li>
      </ul>
      <div class="nc-probs">${[30, 60, 90].map(l => { const p = s[`p${l}`]; return `<div class="nc-prob"><div class="lead">อีก ${l} นาที</div><div class="pv" style="color:${probColor(p)}">${fmt(p)}%</div><div class="bar"><span style="width:${p}%;background:${probColor(p)}"></span></div></div>`; }).join('')}</div>
    </div>
    <p class="hint">โอกาสฝน = ผสมเรดาร์ (น้ำหนักลดจาก 100% → 0% ภายใน 90 นาที) กับแบบจำลอง · ดูแผนที่และภาพเคลื่อนไหวได้ที่แท็บ 📡 เรดาร์ฝน</p>`;
  } catch (e) {
    box.innerHTML = `<p class="muted">วิเคราะห์ภาพเรดาร์ไม่สำเร็จ: ${e.message}</p>`;
  }
}

/* ---------- แท็บเรดาร์ ---------- */

async function loadRadar() {
  setStatus('radarStatus', 'กำลังดึงภาพเรดาร์ 60 นาทีล่าสุดและคำนวณการเคลื่อนตัวของกลุ่มฝน…', 'loading');
  initRadarControls();
  loadDrraa();
  try {
    for (let i = 0; i < 50 && !state.weather; i++) await new Promise(r => setTimeout(r, 300)); // รอข้อมูลแบบจำลอง
    const [nc, idx] = await Promise.all([computeNowcast(state.loc.lat, state.loc.lon), loadRvIndex()]);
    setStatus('radarStatus', '');
    renderRadarHero(nc);
    renderRadarMap(nc, idx);
    renderRadarCharts(nc);
  } catch (e) {
    setStatus('radarStatus', `โหลดภาพเรดาร์ไม่สำเร็จ: ${e.message}`, 'error');
  }
}

function renderRadarHero(nc) {
  const s = nowcastSummary(nc), off = state.weather?.utc_offset_seconds ?? BKK_OFFSET;
  const head = s.rainingNow ? `🌧️ ${rateName(s.now.rate)} ~${fmt(s.now.rate, 1)} มม./ชม.` : '☁️ ขณะนี้ไม่มีฝนที่ตำแหน่งของคุณ';
  const sub = s.rainingNow ? `พื้นที่รอบตัว (รัศมี ~12 กม.) มีฝน ${fmt(s.now.prob * 100)}%`
    : nc.nearest ? `กลุ่มฝนที่ใกล้ที่สุดห่าง <b>${fmt(nc.nearest.km)} กม.</b> ทางทิศ${dirName(nc.nearest.dir)}` : 'ไม่พบกลุ่มฝนในรัศมี ~450 กม.';
  const eta = !s.eta ? '' : s.eta.type === 'start'
    ? `<div class="advice-box">⏱️ คาดว่า<b>ฝนจะเริ่มตกในอีกประมาณ ${s.eta.lead} นาที</b> — เตรียมร่มหรือเลื่อนการเดินทาง</div>`
    : `<div class="advice-box">⏱️ คาดว่า<b>ฝนจะซาลงในอีกประมาณ ${s.eta.lead} นาที</b></div>`;
  $('#radarHero').innerHTML = `
    <div class="card nc-main" style="--nc:${probColor(s.p30)}">
      <div class="muted" style="font-size:.85rem">📍 ${state.loc.name} · ภาพเรดาร์ล่าสุด ${unixHHMM(nc.t0, off)} น.</div>
      <div class="nc-now">${head}</div>
      <div>${sub}</div>
      <div class="nc-probs">${[30, 60, 90].map(l => { const p = s[`p${l}`]; return `<div class="nc-prob"><div class="lead">โอกาสฝนอีก ${l} นาที</div><div class="pv" style="color:${probColor(p)}">${fmt(p)}%</div><div class="bar"><span style="width:${p}%;background:${probColor(p)}"></span></div></div>`; }).join('')}</div>
      ${eta}
    </div>
    <div class="card">
      <h3>การเคลื่อนตัวของกลุ่มฝน</h3>
      <div class="motion">${motionSvg(nc)}<div>${motionText(nc)}<div class="muted" style="font-size:.82rem;margin-top:4px">ประมาณจากภาพเรดาร์ 4 ภาพล่าสุด (30 นาที) · บล็อกที่มีฝนพอวิเคราะห์ ${nc.F.valid}/${nc.F.nb ** 2}</div></div></div>
      <div class="skill">${skillText(nc)}<div class="muted" style="margin-top:4px">Brier score ยิ่งต่ำยิ่งแม่น · การคงสภาพ = สมมติว่าฝนอยู่ที่เดิม</div></div>
    </div>`;
}

function initRadarControls() {
  if (state.radarBound) return;
  state.radarBound = true;
  $('#rvSlider').addEventListener('input', e => showRadarFrame(+e.target.value));
  $('#rvPrev').addEventListener('click', () => showRadarFrame(state.rvFrame - 1));
  $('#rvNext').addEventListener('click', () => showRadarFrame(state.rvFrame + 1));
  $('#rvPlay').addEventListener('click', () => toggleRadarPlay());
  $('#rvOpacity').addEventListener('input', () => showRadarFrame(state.rvFrame));
  $('#rvShowNowcast').addEventListener('change', () => { buildRadarFrames(); showRadarFrame(state.rvFrames.findIndex(f => f.last)); });
  $('#drPlay').addEventListener('click', toggleDrPlay);
  $('#drSlider').addEventListener('input', e => showDrFrame(+e.target.value));
  $('#drStation').addEventListener('change', e => loadDrStation(e.target.value));
}

function gridToDataUrl(g) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = RV_S;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(RV_S, RV_S);
  for (let i = 0; i < g.length; i++) {
    if (g[i] < RAIN_DBZ - 10) continue; // แสดงเฉพาะสัญญาณที่มีนัยสำคัญ
    const k = clamp(Math.round(g[i]) + 32, 0, 127) * 4;
    img.data[i * 4] = RV_RGBA[k]; img.data[i * 4 + 1] = RV_RGBA[k + 1]; img.data[i * 4 + 2] = RV_RGBA[k + 2]; img.data[i * 4 + 3] = RV_RGBA[k + 3];
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL();
}

function renderRadarMap(nc, idx) {
  if (!state.maps.radar) {
    const map = L.map('radarMap', { zoomSnap: 0.5 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap · Weather data © <a href="https://www.rainviewer.com" target="_blank">RainViewer</a>' }).addTo(map);
    state.maps.radar = map;
    state.rvLayers = L.layerGroup().addTo(map);
    state.rvMe = L.layerGroup().addTo(map);
  }
  const map = state.maps.radar;
  state.rvLayers.clearLayers();
  state.rvMe.clearLayers();
  // ภาพสังเกตการณ์จาก RainViewer (ไทล์) — สร้างเลเยอร์เมื่อแสดงเฟรมนั้นครั้งแรก
  // (เพิ่มทุกเฟรมพร้อมกันทำให้ถูกจำกัดอัตราการเรียก HTTP 429) แล้วเก็บไว้เพื่อเล่นซ้ำได้ลื่น
  state.rvPast = (idx.radar.past || []).map(f => ({
    t: f.time, url: rvTileUrl(idx.host, f.path, '{z}', '{x}', '{y}'), layer: null,
  }));
  // ภาพคาดการณ์ (คำนวณเอง) วางทับโดเมนวิเคราะห์
  state.rvFc = nc.fc.map((g, k) => ({ t: nc.t0 + (k + 1) * 600, lead: (k + 1) * 10, layer: L.imageOverlay(gridToDataUrl(g), nc.bounds, { opacity: 0, zIndex: 6 }).addTo(state.rvLayers) }));
  L.rectangle(nc.bounds, { color: '#a855f7', weight: 1, dashArray: '6 5', fill: false, interactive: false }).addTo(state.rvMe);
  L.marker([state.loc.lat, state.loc.lon]).bindPopup(`<b>${state.loc.name}</b>`).addTo(state.rvMe);
  L.circle([state.loc.lat, state.loc.lon], { radius: NC_R * nc.kmPx * 1000, color: '#0f172a', weight: 1.5, fill: false, dashArray: '3 3', interactive: false }).addTo(state.rvMe);
  if (!state.rvViewSet) { map.setView([state.loc.lat, state.loc.lon], 7); state.rvViewSet = true; } else map.panTo([state.loc.lat, state.loc.lon]);
  buildRadarFrames();
  showRadarFrame(state.rvFrames.findIndex(f => f.last));

  const stops = [10, 20, 30, 35, 40, 45, 50, 55, 60];
  $('#radarLegend').innerHTML = `<span><b>ความแรงฝน (dBZ):</b><span class="dbz-bar">${stops.map(d => `<span style="background:${dbzColor(d)}" title="${d} dBZ ≈ ${fmt(dbzToRate(d), 1)} มม./ชม."></span>`).join('')}</span>10 → 60 dBZ</span>` +
    '<span>20 dBZ ≈ ฝนเล็กน้อย 0.6 มม./ชม. · 35 ≈ ปานกลาง 5.6 · 45 ≈ หนัก 24 · 55+ ≈ พายุฝนฟ้าคะนองรุนแรง</span>' +
    '<span>กรอบประสีม่วง = พื้นที่คำนวณคาดการณ์ · วงกลมประ = รัศมี ~12 กม. ที่ใช้คิดโอกาสฝน</span>';
}

function buildRadarFrames() {
  const withFc = $('#rvShowNowcast').checked;
  state.rvFrames = [
    ...state.rvPast.map((f, i, a) => ({ ...f, kind: 'obs', last: i === a.length - 1 })),
    ...(withFc ? state.rvFc.map(f => ({ ...f, kind: 'fc' })) : []),
  ];
  $('#rvSlider').max = state.rvFrames.length - 1;
}

function showRadarFrame(i) {
  const fr = state.rvFrames;
  if (!fr?.length) return;
  i = (i + fr.length) % fr.length;
  state.rvFrame = i;
  const op = +$('#rvOpacity').value / 100;
  const cur = fr[i].kind === 'obs' ? state.rvPast.find(p => p.t === fr[i].t) : fr[i];
  if (!cur.layer) {
    cur.layer = L.tileLayer(cur.url, { maxNativeZoom: RV_Z, maxZoom: 12, opacity: 0, zIndex: 5 }).addTo(state.rvLayers);
  }
  [...state.rvPast, ...state.rvFc].forEach(f => f.layer?.setOpacity(0));
  cur.layer.setOpacity(op);
  $('#rvSlider').value = i;
  const off = state.weather?.utc_offset_seconds ?? BKK_OFFSET, f = fr[i];
  const el = $('#rvTime');
  el.className = 'rv-time' + (f.kind === 'fc' ? ' fc' : '');
  el.textContent = f.kind === 'fc' ? `${unixHHMM(f.t, off)} น. · คาดการณ์ +${f.lead} นาที` : `${unixHHMM(f.t, off)} น. · ภาพเรดาร์จริง${f.last ? ' (ล่าสุด)' : ''}`;
}

function toggleRadarPlay() {
  if (state.rvTimer) {
    clearInterval(state.rvTimer); state.rvTimer = null; $('#rvPlay').textContent = '▶';
    return;
  }
  $('#rvPlay').textContent = '⏸';
  state.rvTimer = setInterval(() => showRadarFrame(state.rvFrame + 1), 700);
}

function renderRadarCharts(nc) {
  const off = state.weather?.utc_offset_seconds ?? BKK_OFFSET;
  const ser = blendedSeries(nc, 6);
  makeChart('radarProbChart', {
    type: 'line',
    data: {
      labels: ser.map(s => unixHHMM(s.t, off)),
      datasets: [
        { label: 'ผสม (ใช้พยากรณ์)', data: ser.map(s => s.blend), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.12)', fill: true, borderWidth: 3, pointRadius: 0, tension: .3 },
        { label: 'เรดาร์ (nowcast)', data: ser.map(s => s.radar), borderColor: '#a855f7', borderDash: [5, 4], pointRadius: 2, tension: .3 },
        { label: 'แบบจำลอง (Open-Meteo)', data: ser.map(s => s.model), borderColor: '#94a3b8', borderDash: [2, 3], pointRadius: 0, tension: .3 },
      ],
    },
    options: {
      scales: { x: { ticks: { maxTicksLimit: 13, maxRotation: 0 } }, y: { min: 0, max: 100, title: { display: true, text: 'โอกาสฝน (%)' } } },
      plugins: { nowLine: { index: 0, label: 'ภาพล่าสุด' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw == null ? '–' : fmt(c.raw) + '%'}` } } },
    },
  });
  $('#radarSkill').innerHTML = `<p class="hint">0–90 นาทีแรกใช้เรดาร์เป็นหลัก (โอกาสฝน = สัดส่วนพื้นที่ที่มีฝนในรัศมี ~12 กม. หลังเลื่อนตามการเคลื่อนตัวของกลุ่มฝน) แล้วค่อย ๆ ส่งต่อให้แบบจำลองซึ่งแม่นยำกว่าในระยะเกิน 1–2 ชม.</p>`;

  const obs = nc.observed, fc = nc.forecast;
  const labels = [...obs.map(o => unixHHMM(o.t, off)), ...fc.map(f => unixHHMM(f.t, off))];
  makeChart('radarRateChart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'สังเกตการณ์ (เรดาร์)', data: [...obs.map(o => o.rate), ...fc.map(() => null)], borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,.18)', fill: true, pointRadius: 3, borderWidth: 2.5 },
        { label: 'คาดการณ์ (nowcast)', data: [...obs.map((o, i) => (i === obs.length - 1 ? o.rate : null)), ...fc.map(f => f.rate)], borderColor: '#a855f7', borderDash: [5, 4], pointRadius: 2, borderWidth: 2.5 },
      ],
    },
    options: {
      scales: { x: { ticks: { maxRotation: 0 } }, y: { beginAtZero: true, suggestedMax: 2, title: { display: true, text: 'มม./ชม.' } } },
      plugins: { nowLine: { index: obs.length - 1, label: 'ล่าสุด' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw == null ? '–' : fmt(c.raw, 2)} มม./ชม.` } } },
    },
  });
}

/* ---------- เรดาร์กรมฝนหลวงและการบินเกษตร ---------- */

// พิกัดโดยประมาณระดับอำเภอ ใช้เลือกสถานีที่ใกล้ที่สุดเท่านั้น
const DRRAA_STATIONS = [
  { id: 'omkoi', name: 'อมก๋อย จ.เชียงใหม่', lat: 17.80, lon: 98.36 },
  { id: 'rongkwang', name: 'ร้องกวาง จ.แพร่', lat: 18.34, lon: 100.32 },
  { id: 'banphue', name: 'บ้านผือ จ.อุดรธานี', lat: 17.69, lon: 102.48 },
  { id: 'takhli', name: 'ตาคลี จ.นครสวรรค์', lat: 15.25, lon: 100.34 },
  { id: 'phimai', name: 'พิมาย จ.นครราชสีมา', lat: 15.22, lon: 102.49 },
  { id: 'rasisalai', name: 'ราษีไศล จ.ศรีสะเกษ', lat: 15.35, lon: 104.15 },
  { id: 'sattahip', name: 'สัตหีบ จ.ชลบุรี', lat: 12.66, lon: 100.90 },
  { id: 'pluakdaeng', name: 'ปลวกแดง จ.ระยอง', lat: 12.98, lon: 101.21 },
  { id: 'pathio', name: 'ปะทิว จ.ชุมพร', lat: 10.72, lon: 99.31 },
  { id: 'phanom', name: 'พนม จ.สุราษฎร์ธานี', lat: 8.86, lon: 98.82 },
  { id: 'singha', name: 'สิงหนคร จ.สงขลา', lat: 7.24, lon: 100.55 },
];

/** รายการภาพ: ผ่าน proxy ของ server.py ก่อน (API ต้นทางไม่มี CORS) */
async function drraaApi(station) {
  try {
    const r = await fetch(`/proxy/royalrain?station=${station}`, { signal: AbortSignal.timeout(40e3) });
    if (r.ok) return await r.json();
  } catch { /* ลองเรียกตรง */ }
  return getJSON(`https://file.royalrain.go.th/opendata/radar_data/cappi/api.php?station=${station}`, 20e3);
}

async function loadDrraa() {
  if (state.drLatest) return populateDrStations();
  try {
    const j = await drraaApi('all-only-latest');
    state.drLatest = Object.fromEntries((j.data || []).map(d => [d.station, d]));
    populateDrStations();
  } catch {
    $('#drView').innerHTML = `<div class="skeleton" style="padding:24px;text-align:left">ไม่สามารถดึงรายการภาพเรดาร์ของกรมฝนหลวงฯ ได้<br>
      API ต้นทางไม่อนุญาตให้เบราว์เซอร์เรียกโดยตรง (ไม่มี CORS) — กรุณาเปิดเว็บผ่าน <code>python server.py</code> ซึ่งมีตัวกลาง (proxy) ให้</div>`;
  }
}

function populateDrStations() {
  const { lat, lon } = state.loc;
  const list = DRRAA_STATIONS.map(s => ({ ...s, dist: haversine(lat, lon, s.lat, s.lon), latest: state.drLatest[s.id] }))
    .sort((a, b) => a.dist - b.dist);
  $('#drStation').innerHTML = list.map(s => `<option value="${s.id}" ${s.latest ? '' : 'disabled'}>${s.name} · ${fmt(s.dist)} กม.${s.latest ? ` · ล่าสุด ${s.latest.datetime_bangkok.slice(9)} น.` : ' · ไม่มีข้อมูล'}</option>`).join('');
  const first = list.find(s => s.latest);
  if (first) { $('#drStation').value = first.id; loadDrStation(first.id); }
}

async function loadDrStation(id) {
  const view = $('#drView');
  view.innerHTML = '<div class="skeleton">กำลังโหลดภาพเรดาร์…</div>';
  if (state.drTimer) toggleDrPlay();
  try {
    const j = await drraaApi(id);
    const frames = (j.data || []).slice(0, 20).reverse().map(d => ({ url: d.url.replace(/^http:/, 'https:'), t: d.datetime_bangkok }));
    if (!frames.length) throw new Error('ไม่มีภาพ');
    frames.forEach(f => { const im = new Image(); im.src = f.url; }); // preload
    state.drFrames = frames;
    view.innerHTML = '<img id="drImg" alt="ภาพเรดาร์">';
    $('#drSlider').max = frames.length - 1;
    showDrFrame(frames.length - 1);
  } catch (e) {
    view.innerHTML = `<div class="skeleton">โหลดภาพไม่สำเร็จ: ${e.message}</div>`;
  }
}

function showDrFrame(i) {
  const fr = state.drFrames;
  if (!fr?.length || !$('#drImg')) return;
  i = (i + fr.length) % fr.length;
  state.drFrame = i;
  $('#drImg').src = fr[i].url;
  $('#drSlider').value = i;
  const t = fr[i].t; // "YYYYMMDD HH:MM"
  $('#drTime').textContent = `${dayLabel(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`)} ${t.slice(9)} น.${i === fr.length - 1 ? ' (ล่าสุด)' : ''}`;
}

function toggleDrPlay() {
  if (state.drTimer) {
    clearInterval(state.drTimer); state.drTimer = null; $('#drPlay').textContent = '▶';
    return;
  }
  $('#drPlay').textContent = '⏸';
  state.drTimer = setInterval(() => showDrFrame(state.drFrame + 1), 600);
}

/* ------------------------------------------------------------------ */
/* 3) วิเคราะห์น้ำท่วม                                                  */
/* ------------------------------------------------------------------ */

const FLOOD_LEVELS = [
  { name: 'ปกติ', color: '#16a34a', advice: ['สถานการณ์ปกติ ติดตามข่าวสารสภาพอากาศตามปกติ'] },
  { name: 'เฝ้าระวัง', color: '#ca8a04', advice: ['ติดตามประกาศจากกรมอุตุนิยมวิทยาและหน่วยงานท้องถิ่นอย่างใกล้ชิด', 'ตรวจสอบและลอกท่อระบายน้ำรอบที่พักอาศัย'] },
  { name: 'ระวัง', color: '#ea580c', advice: ['ขนย้ายสิ่งของมีค่าและเอกสารสำคัญขึ้นที่สูง', 'เตรียมถุงยังชีพ ยา ไฟฉาย และแบตเตอรี่สำรอง', 'หลีกเลี่ยงการสัญจรผ่านพื้นที่ลุ่มต่ำและทางน้ำไหลผ่าน'] },
  { name: 'เสี่ยงสูง', color: '#dc2626', advice: ['เตรียมพร้อมอพยพ ทราบเส้นทางและจุดอพยพที่ใกล้ที่สุด', 'ตัดกระแสไฟฟ้าส่วนที่อาจถูกน้ำท่วม', 'ห้ามขับรถหรือเดินลุยกระแสน้ำไหลเชี่ยว', 'สายด่วน ปภ. 1784'] },
  { name: 'วิกฤต', color: '#7f1d1d', advice: ['ปฏิบัติตามคำสั่งอพยพของเจ้าหน้าที่ทันที', 'ขึ้นที่สูงและอยู่ห่างจากลำน้ำ', 'แจ้งเหตุฉุกเฉิน 1784 (ปภ.) หรือ 1669'] },
];

async function loadFlood() {
  setStatus('floodStatus', 'กำลังวิเคราะห์ความเสี่ยงน้ำท่วม…', 'loading');
  const { lat, lon } = state.loc;
  const ymd = dt => dt.toISOString().slice(0, 10);
  const start = new Date(); start.setFullYear(start.getFullYear() - 3);
  const end = new Date(); end.setDate(end.getDate() - 31);

  // ตำแหน่งที่ผู้ใช้เลือกมักไม่ตรงกับลำน้ำพอดี จึงสุ่มตัวอย่างกริด 3×3 (±~5 กม.)
  // แล้วเลือกจุดที่มีอัตราการไหลเฉลี่ยสูงสุด (ลำน้ำสายหลักที่ใกล้ที่สุด)
  const offs = [-0.05, 0, 0.05];
  const pts = offs.flatMap(a => offs.map(b => [+(lat + a).toFixed(4), +(lon + b).toFixed(4)]));
  let fc = null, hist = null, errMsg = '';
  try {
    const res = await getJSON(`https://flood-api.open-meteo.com/v1/flood?latitude=${pts.map(p => p[0])}&longitude=${pts.map(p => p[1])}` +
      '&daily=river_discharge,river_discharge_median,river_discharge_p25,river_discharge_p75,river_discharge_max&past_days=30&forecast_days=30');
    const all = Array.isArray(res) ? res : [res];
    const mean = r => sum(r.daily.river_discharge) / r.daily.river_discharge.length;
    fc = all.reduce((best, r) => (mean(r) > mean(best) ? r : best));
    fc.distKm = haversine(lat, lon, fc.latitude, fc.longitude);
    hist = await getJSON(`https://flood-api.open-meteo.com/v1/flood?latitude=${fc.latitude}&longitude=${fc.longitude}&daily=river_discharge&start_date=${ymd(start)}&end_date=${ymd(end)}`)
      .catch(() => null);
  } catch (e) {
    errMsg = e.message;
  }
  setStatus('floodStatus', fc ? '' : `ไม่สามารถโหลดข้อมูลแม่น้ำได้ (${errMsg}) — วิเคราะห์จากข้อมูลฝนเพียงอย่างเดียว`, fc ? '' : 'error');
  const w = state.weather;
  renderFlood(w, fc, hist, state.tw);
  // ข้อมูลตรวจวัด ThaiWater โหลดช้ากว่า → วิเคราะห์ใหม่เมื่อพร้อม
  if (!state.tw) {
    loadThaiWater()
      .then(tw => { if (state.weather === w) renderFlood(w, fc, hist, tw); })
      .catch(() => { if (state.weather === w) renderFlood(w, fc, hist, null, true); });
  }
}

function riverThresholds(hist) {
  const vals = (hist?.daily?.river_discharge || []).filter(v => v != null).sort((a, b) => a - b);
  if (vals.length < 200) return null;
  // ค่าสูงสุดรายปี → ค่าเฉลี่ย ≈ คาบการเกิดซ้ำ ~2 ปี
  const byYear = {};
  hist.daily.time.forEach((t, i) => {
    const v = hist.daily.river_discharge[i];
    if (v == null) return;
    const y = t.slice(0, 4);
    byYear[y] = Math.max(byYear[y] ?? 0, v);
  });
  const annualMax = Object.values(byYear);
  const median = quantile(vals, 0.5);
  const watch = quantile(vals, 0.9);
  const warn = Math.max(annualMax.reduce((a, b) => a + b, 0) / annualMax.length, watch * 1.1);
  const severe = Math.max(vals[vals.length - 1], warn * 1.1);
  return { median, watch, warn, severe };
}

function renderFlood(w, fc, hist, tw, twFailed = false) {
  const d = w.daily, di = w.dIdx;
  const factors = [];
  const nb = tw ? twNearby(tw, state.loc.lat, state.loc.lon) : null;
  const twPending = !tw && !twFailed;
  const twMissing = twPending ? 'กำลังโหลดข้อมูลตรวจวัดจาก ThaiWater…' : 'ไม่สามารถโหลดข้อมูล ThaiWater ได้';

  // ---------- ปัจจัยฝน (คาดการณ์) ----------
  const past7 = sum(d.precipitation_sum.slice(Math.max(0, di - 7), di));
  const next3 = d.precipitation_sum.slice(di, di + 3);
  const r3 = sum(next3);
  const max1 = maxOf(next3);
  let rainScore = r3 >= 150 ? 3 : r3 >= 90 ? 2 : r3 >= 35 ? 1 : 0;
  if (max1 > 90) rainScore = Math.max(rainScore, 2);
  factors.push({
    name: '🌧️ ฝนคาดการณ์ 3 วันข้างหน้า', value: `${fmt(r3, 1)} มม.`, score: rainScore,
    detail: `สูงสุดรายวัน ${fmt(max1, 1)} มม. (${rainClass(max1).name}) · เกณฑ์: ≥35 เฝ้าระวัง, ≥90 ระวัง, ≥150 เสี่ยงสูง`,
  });

  // ---------- ปัจจัยฝน (ตรวจวัดจริง ThaiWater) ----------
  let obsScore = 0;
  if (nb?.rainNear.length) {
    const o = nb.rainMax, t = rainThresholds(o.zone);
    obsScore = o.r24 >= t.crit ? 3 : o.r24 >= t.warn ? 2 : o.r24 >= 35 ? 1 : 0;
    if (nb.rainOutlier) obsScore = Math.max(0, obsScore - 1);
    factors.push({
      name: '📡 ฝนตรวจวัดจริง 24 ชม. (ThaiWater)', value: `${fmt(o.r24, 1)} มม.`, score: obsScore,
      detail: `สูงสุดที่สถานี${o.name} (${fmt(o.dist, 1)} กม.) · เฉลี่ย ${fmt(nb.rainAvg, 1)} มม. จาก ${nb.rainNear.length} สถานี · ` +
        `เกณฑ์โซน ${o.zone}: ≥35 เฝ้าระวัง, ≥${t.warn} ระวัง, ≥${t.crit} เสี่ยงสูง` +
        (nb.rainOutlier ? ` · ⚠️ สถานีข้างเคียงวัดได้ไม่เกิน ${fmt(nb.rainSecond, 1)} มม. อาจเป็นพายุเฉพาะจุดหรือค่าผิดปกติ จึงลดน้ำหนักลง 1 ระดับ` : ''),
    });
  } else {
    factors.push({ name: '📡 ฝนตรวจวัดจริง 24 ชม. (ThaiWater)', value: '–', score: 0, detail: tw ? 'ไม่มีสถานีวัดฝนในรัศมี 40 กม.' : twMissing });
  }
  const rainBase = Math.max(rainScore, obsScore);

  let soilScore = 0;
  if (past7 >= 150 && rainBase >= 1) soilScore = 1;
  factors.push({
    name: '🟫 ฝนสะสมย้อนหลัง 7 วัน (ความชุ่มน้ำในดิน)', value: `${fmt(past7, 1)} มม.`, score: soilScore,
    detail: (past7 >= 150 ? 'ดินอิ่มตัวด้วยน้ำ ความสามารถในการซับน้ำลดลง น้ำไหลบ่าผิวดินได้ง่าย' : 'ความชุ่มน้ำในดินยังไม่วิกฤต') +
      (past7 >= 150 && rainBase < 1 ? ' (จะเพิ่มความเสี่ยงเมื่อมีฝนตกหนักซ้ำ)' : ''),
  });

  const elev = w.elevation;
  const lowScore = elev != null && elev < 10 && rainBase >= 1 ? 1 : 0;
  factors.push({
    name: '⛰️ ระดับความสูงของพื้นที่', value: `${fmt(elev)} ม.`, score: lowScore,
    detail: elev < 10 ? 'พื้นที่ลุ่มต่ำ เสี่ยงต่อน้ำท่วมขังจากการระบายน้ำไม่ทันเมื่อมีฝนตกหนัก' : 'พื้นที่ไม่ใช่ที่ลุ่มต่ำมาก',
  });

  // ---------- ปัจจัยแม่น้ำ ----------
  let riverScore = 0, th = null, fcStart = -1;
  if (fc?.daily?.river_discharge) {
    const q = fc.daily.river_discharge;
    const today = w.current.time.slice(0, 10);
    fcStart = Math.max(0, fc.daily.time.indexOf(today));
    th = riverThresholds(hist);
    const peakFc = maxOf(q.slice(fcStart));
    const peakIdx = q.indexOf(peakFc, fcStart);
    const nowQ = q[fcStart];
    if (th && th.median >= 5) {
      riverScore = peakFc >= th.severe ? 3 : peakFc >= th.warn ? 2 : peakFc >= th.watch ? 1 : 0;
      factors.push({
        name: '🏞️ อัตราการไหลของแม่น้ำ (สูงสุดใน 30 วัน)', value: `${fmt(peakFc, 1)} m³/s`, score: riverScore,
        detail: `จุดลำน้ำห่าง ${fmt(fc.distKm, 1)} กม. · ปัจจุบัน ${fmt(nowQ, 1)} m³/s · คาดสูงสุด ${dayLabel(fc.daily.time[peakIdx])} · ` +
          `ปกติ ${fmt(th.median, 1)} / เฝ้าระวัง ${fmt(th.watch, 1)} / เตือนภัย ${fmt(th.warn, 1)} / วิกฤต ${fmt(th.severe, 1)} m³/s`,
      });
    } else {
      factors.push({
        name: '🏞️ อัตราการไหลของแม่น้ำ', value: `${fmt(nowQ, 1)} m³/s`, score: 0,
        detail: 'ไม่พบลำน้ำสายหลักที่จุดนี้ (อัตราการไหลต่ำ) — ความเสี่ยงหลักคือน้ำท่วมขัง/น้ำป่าจากฝนตกหนัก',
      });
    }
  } else {
    factors.push({ name: '🏞️ อัตราการไหลของแม่น้ำ', value: 'ไม่มีข้อมูล', score: 0, detail: 'ไม่สามารถโหลดข้อมูล GloFAS ได้' });
  }

  // ---------- ระดับน้ำจริงในลำน้ำ (ThaiWater) ----------
  let stationScore = 0;
  if (nb?.wlMax) {
    const s = nb.wlMax, st = wlStatus(s.pct);
    stationScore = s.pct > 100 ? 3 : s.pct > 85 ? 2 : s.pct > 70 ? 1 : 0;
    factors.push({
      name: '📏 ระดับน้ำจริงในลำน้ำ (ThaiWater)', value: `${fmt(s.pct, 1)}%`, score: stationScore,
      detail: `สถานี${s.name} ${s.river} (${fmt(s.dist, 1)} กม.) — ${st.name} · ${s.diffText.replace(' (ม.)', '')} ${fmt(Math.abs(s.diffBank), 2)} ม. · แนวโน้ม ${wlTrend(s)} · ` +
        'เกณฑ์ % ความจุลำน้ำ: >70 เฝ้าระวัง, >85 ระวัง, >100 ล้นตลิ่ง',
    });
  } else {
    factors.push({ name: '📏 ระดับน้ำจริงในลำน้ำ (ThaiWater)', value: '–', score: 0, detail: tw ? 'ไม่มีสถานีวัดระดับน้ำในรัศมี 30 กม.' : twMissing });
  }

  // ---------- เขื่อนใกล้เคียง (ThaiWater) ----------
  let damScore = 0;
  const dam = nb?.damNear.find(x => x.dist <= 100);
  if (dam) {
    const st = damStatus(dam);
    damScore = dam.pct > 100 ? 2 : dam.pct > 80 ? 1 : 0;
    factors.push({
      name: '🏞️ เขื่อนใกล้เคียง (ThaiWater)', value: `${fmt(dam.pct, 1)}%`, score: damScore,
      detail: `เขื่อน${dam.name} (${fmt(dam.dist)} กม.) — ${st.name} · ไหลเข้า ${fmt(dam.inflow, 2)} / ระบาย ${fmt(dam.released, 2)} ล้าน ลบ.ม./วัน` +
        (damScore ? ' · เขื่อนน้ำมาก อาจต้องเพิ่มการระบายน้ำ ส่งผลต่อพื้นที่ท้ายเขื่อน' : ''),
    });
  } else {
    factors.push({ name: '🏞️ เขื่อนใกล้เคียง (ThaiWater)', value: '–', score: 0, detail: tw ? 'ไม่มีเขื่อนขนาดใหญ่ในรัศมี 100 กม.' : twMissing });
  }

  // ---------- รวมคะแนน ----------
  const rainTotal = Math.min(3, rainBase + soilScore + lowScore);
  const riverAll = Math.max(riverScore, stationScore);
  let level = Math.max(riverAll, rainTotal, damScore);
  if (riverAll >= 1 && rainTotal >= 1) level += 1; // ฝนตกหนักซ้ำเติมน้ำในแม่น้ำสูง
  level = clamp(level, 0, 4);
  const L4 = FLOOD_LEVELS[level];

  // gauge ครึ่งวงกลม 5 ช่วง — เข็มชี้กลางช่องของระดับปัจจุบัน
  const ang = Math.PI * (1 - (level + 0.5) / 5);
  const nx = 75 + 55 * Math.cos(ang), ny = 75 - 55 * Math.sin(ang);
  const gauge = `<svg class="gauge" viewBox="0 0 150 90">
    ${FLOOD_LEVELS.map((lv, k) => {
      const a0 = Math.PI * (1 - k / 5), a1 = Math.PI * (1 - (k + 1) / 5);
      const p = (a, r) => `${75 + r * Math.cos(a)},${75 - r * Math.sin(a)}`;
      return `<path d="M${p(a0, 65)} A65,65 0 0 1 ${p(a1, 65)} L${p(a1, 45)} A45,45 0 0 0 ${p(a0, 45)} Z" fill="${lv.color}" opacity="${k === level ? 1 : .3}"/>`;
    }).join('')}
    <line x1="75" y1="75" x2="${nx}" y2="${ny}" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    <circle cx="75" cy="75" r="5" fill="currentColor"/>
  </svg>`;

  $('#floodRiskCard').innerHTML = `
    <h3>ระดับความเสี่ยงน้ำท่วม</h3>
    <div class="risk-head">
      ${gauge}
      <div>
        <div class="risk-level" style="color:${L4.color}">${L4.name}</div>
        <div class="muted">ระดับ ${level} จาก 4 · ${state.loc.name}</div>
      </div>
    </div>
    <div class="risk-bar">${FLOOD_LEVELS.map((lv, k) => `<span style="${k <= level ? `background:${lv.color}` : ''}"></span>`).join('')}</div>
    <b>คำแนะนำ</b>
    <ul class="advice">${L4.advice.map(a => `<li>${a}</li>`).join('')}</ul>`;

  $('#floodFactors').innerHTML = factors.map(f => `
    <div class="factor">
      <span class="f-name">${f.name}</span>
      <span><b>${f.value}</b> <span class="badge" style="background:${FLOOD_LEVELS[Math.min(f.score, 4)].color}">+${f.score}</span></span>
      <span class="f-detail">${f.detail}</span>
    </div>`).join('') +
    `<p class="hint">คะแนนรวม = max(แม่น้ำ[GloFAS, ระดับน้ำจริง], ฝน[คาดการณ์, ตรวจวัด]+ดิน+ความสูง, เขื่อน) และ +1 เมื่อทั้งแม่น้ำและฝนอยู่ในเกณฑ์เสี่ยงพร้อมกัน` +
    `${twPending ? ' · <b>กำลังโหลดข้อมูลตรวจวัด ThaiWater ผลจะอัปเดตอัตโนมัติ</b>' : ''}</p>`;

  // ---------- กราฟอัตราการไหล ----------
  if (fc?.daily?.river_discharge) {
    const t = fc.daily.time, n = t.length;
    const line = v => Array(n).fill(v);
    const ds = [
      { label: 'ช่วงคาดการณ์ P25–P75', data: fc.daily.river_discharge_p75, borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(59,130,246,.18)', fill: '+1' },
      { label: '_p25', data: fc.daily.river_discharge_p25, borderWidth: 0, pointRadius: 0, fill: false },
      {
        label: 'อัตราการไหล (m³/s)', data: fc.daily.river_discharge, borderColor: '#2563eb', pointRadius: 0, borderWidth: 2.5, tension: .3,
        segment: { borderDash: ctx => (ctx.p0DataIndex >= fcStart ? [6, 4] : undefined) },
      },
    ];
    if (th && th.median >= 5) {
      ds.push(
        { label: 'เฝ้าระวัง', data: line(th.watch), borderColor: '#ca8a04', borderDash: [3, 3], pointRadius: 0, borderWidth: 1.5 },
        { label: 'เตือนภัย', data: line(th.warn), borderColor: '#ea580c', borderDash: [3, 3], pointRadius: 0, borderWidth: 1.5 },
        { label: 'วิกฤต', data: line(th.severe), borderColor: '#dc2626', borderDash: [3, 3], pointRadius: 0, borderWidth: 1.5 },
      );
    }
    makeChart('dischargeChart', {
      type: 'line',
      data: { labels: t.map(dayLabel), datasets: ds },
      options: {
        scales: { y: { beginAtZero: true, title: { display: true, text: 'm³/s' } }, x: { ticks: { maxTicksLimit: 15 } } },
        plugins: {
          nowLine: { index: fcStart, label: 'วันนี้' },
          legend: { labels: { filter: it => !it.text.startsWith('_') } },
          tooltip: { filter: it => !it.dataset.label.startsWith('_') },
        },
      },
    });
  }

  // ---------- กราฟฝนสะสม ----------
  const from = Math.max(0, di - 7);
  const days = d.time.slice(from);
  const rain = d.precipitation_sum.slice(from);
  let acc = 0;
  const cum = rain.map((v, k) => (from + k < di ? null : (acc += v ?? 0)));
  makeChart('floodRainChart', {
    type: 'bar',
    data: {
      labels: days.map(dayLabel),
      datasets: [
        { label: 'ฝนรายวัน (มม.)', data: rain, backgroundColor: rain.map((_, k) => (from + k < di ? '#94a3b8' : '#3b82f6')), borderRadius: 4, yAxisID: 'y' },
        { type: 'line', label: 'ฝนสะสมตั้งแต่วันนี้ (มม.)', data: cum, borderColor: '#0891b2', pointRadius: 2, tension: .3, yAxisID: 'y1' },
      ],
    },
    options: {
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'มม./วัน' } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, title: { display: true, text: 'สะสม (มม.)' } },
      },
      plugins: { nowLine: { index: di - from, label: 'วันนี้' } },
    },
  });
}

/* ------------------------------------------------------------------ */
/* ข้อมูลน้ำ / เขื่อน (ThaiWater — คลังข้อมูลน้ำแห่งชาติ, สสน.)          */
/* ------------------------------------------------------------------ */

const TW_BASE = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
const TW_CACHE_MS = 15 * 60e3; // ข้อมูลระดับประเทศ ไม่ขึ้นกับตำแหน่ง → แคช 15 นาที
const num = v => (v == null || v === '' ? null : +v);

/** โหลดและปรับรูปแบบข้อมูล thailand_main (เขื่อน/ระดับน้ำ/เกณฑ์ฝน) + rain_24h (ฝน 24 ชม.) */
function loadThaiWater() {
  if (state.twPromise && Date.now() - state.twTime < TW_CACHE_MS) return state.twPromise;
  state.twTime = Date.now();
  state.twPromise = (async () => {
    const [mainR, rainR] = await Promise.allSettled([getJSON(TW_BASE + 'thailand_main', 60e3), getJSON(TW_BASE + 'rain_24h', 30e3)]);
    if (mainR.status !== 'fulfilled' && rainR.status !== 'fulfilled') throw mainR.reason;
    const m = mainR.value || {};
    // ใช้ rain_24h เป็นหลัก ถ้าล้มเหลวใช้ชุดฝนใน thailand_main แทน
    const rainRaw = rainR.status === 'fulfilled' ? rainR.value.data || [] : m.rain?.data?.data || [];

    const dams = (m.dam?.data?.data || []).filter(d => d.dam?.dam_lat).map(d => ({
      name: d.dam.dam_name?.th, lat: d.dam.dam_lat, lon: d.dam.dam_long,
      province: d.geocode?.province_name?.th, basin: d.basin?.basin_name?.th, date: d.dam_date,
      storage: d.dam_storage, pct: d.dam_storage_percent, usable: d.dam_uses_water, usablePct: d.dam_uses_water_percent,
      inflow: d.dam_inflow, released: d.dam_released, normal: d.dam.normal_storage, max: d.dam.max_storage,
    }));
    const wl = (m.waterlevel?.data?.data || [])
      .filter(s => num(s.storage_percent) != null && s.station?.tele_station_lat)
      .map(s => ({
        name: s.station.tele_station_name?.th, code: s.station.tele_station_oldcode, river: s.river_name || '',
        lat: s.station.tele_station_lat, lon: s.station.tele_station_long,
        province: s.geocode?.province_name?.th, amphoe: s.geocode?.amphoe_name?.th,
        pct: num(s.storage_percent), msl: num(s.waterlevel_msl), prev: num(s.waterlevel_msl_previous),
        diffBank: num(s.diff_wl_bank), diffText: s.diff_wl_bank_text || '', time: s.waterlevel_datetime,
      }));
    const rain = rainRaw
      .filter(r => r.station?.tele_station_lat && r.rain_24h != null)
      .map(r => ({
        name: r.station.tele_station_name?.th, lat: r.station.tele_station_lat, lon: r.station.tele_station_long,
        province: r.geocode?.province_name?.th, amphoe: r.geocode?.amphoe_name?.th, zone: r.geocode?.warning_zone,
        r24: r.rain_24h, r1: r.rain_1h, time: r.rainfall_datetime, agency: r.agency?.agency_shortname?.th,
      }));
    state.tw = {
      dams, wl, rain,
      rainRules: m.rain?.setting?.rule || {},
      rainSource: rainR.status === 'fulfilled' ? 'rain_24h' : 'thailand_main',
      fetched: new Date(),
    };
    return state.tw;
  })();
  state.twPromise.catch(() => { state.twTime = 0; }); // ให้ลองใหม่ได้ครั้งถัดไป
  return state.twPromise;
}

function damStatus(d) {
  if (d.pct > 100) return { name: 'เกินความจุ', color: '#C70000' };
  if (d.pct > 80) return { name: 'น้ำมาก', color: '#FF0000' };
  if (d.usablePct != null && d.usablePct <= 30) return { name: 'น้ำน้อยวิกฤต', color: '#FFC000' };
  if (d.pct > 50) return { name: 'น้ำดี', color: '#003CFA' };
  return { name: 'น้ำพอใช้', color: '#00B050' };
}
function wlStatus(p) {
  if (p > 100) return { name: 'ล้นตลิ่ง', color: '#FF0000' };
  if (p > 70) return { name: 'น้ำมาก', color: '#003CFA' };
  if (p > 30) return { name: 'ปกติ', color: '#00B050' };
  if (p > 10) return { name: 'น้ำน้อย', color: '#FFC000' };
  return { name: 'น้ำน้อยวิกฤต', color: '#990000' };
}
const RAIN_SCALE = [[90, '#EE141F'], [70, '#CA6504'], [50, '#FE8A04'], [35, '#F6D300'], [20, '#66C803'], [10, '#9CEEB2'], [0, '#A9D1FC']];
const rainColor = mm => (RAIN_SCALE.find(([t]) => mm > t) || [0, '#cbd5e1'])[1];

/** เกณฑ์เตือนภัยฝน 24 ชม. ตามโซนเตือนภัยของ ThaiWater (level 3 = เฝ้าระวัง, level 4 = วิกฤต) */
function rainThresholds(zone) {
  const rules = state.tw?.rainRules?.[zone];
  const l3 = rules?.find(r => r.level === '3'), l4 = rules?.find(r => r.level === '4');
  return { warn: +(l3?.rain24h ?? 90), crit: +(l4?.rain24h ?? 150), rain3dWarn: +(l3?.rain3d ?? 150) };
}

/** ข้อมูลน้ำรอบตำแหน่ง: สถานีฝน (20–40 กม.), สถานีระดับน้ำ (30 กม.), เขื่อนใกล้ที่สุด */
function twNearby(tw, lat, lon) {
  const byDist = arr => arr.map(x => ({ ...x, dist: haversine(lat, lon, x.lat, x.lon) })).sort((a, b) => a.dist - b.dist);
  const rainAll = byDist(tw.rain);
  let rainR = 20, rainNear = rainAll.filter(x => x.dist <= rainR);
  if (rainNear.length < 3) { rainR = 40; rainNear = rainAll.filter(x => x.dist <= rainR); }
  const rainMax = rainNear.reduce((a, b) => (b.r24 > (a?.r24 ?? -1) ? b : a), null);
  const rainAvg = rainNear.length ? sum(rainNear.map(x => x.r24)) / rainNear.length : null;
  // ค่าสูงสุดที่ไม่มีสถานีข้างเคียงยืนยัน (อาจเป็นเครื่องวัดผิดพลาดหรือพายุเฉพาะจุด)
  const rainSecond = [...rainNear].sort((a, b) => b.r24 - a.r24)[1]?.r24 ?? 0;
  const rainOutlier = rainNear.length >= 3 && rainMax?.r24 >= 35 && rainSecond < rainMax.r24 * 0.25;
  const wlNear = byDist(tw.wl).filter(x => x.dist <= 30);
  const wlMax = wlNear.reduce((a, b) => (b.pct > (a?.pct ?? -1) ? b : a), null);
  const damNear = byDist(tw.dams).slice(0, 3);
  return { rainR, rainNear, rainMax, rainAvg, rainSecond, rainOutlier, wlNear, wlMax, damNear };
}

const pctBar = (p, color) => `<span class="pct-bar"><span style="width:${clamp(p ?? 0, 0, 100)}%;background:${color}"></span></span>`;
const wlTrend = s => (s.msl == null || s.prev == null ? '–'
  : s.msl > s.prev + 0.01 ? `<span style="color:#dc2626">▲ ${fmt(s.msl - s.prev, 2)}</span>`
    : s.msl < s.prev - 0.01 ? `<span style="color:#16a34a">▼ ${fmt(s.prev - s.msl, 2)}</span>` : '● คงที่');

async function loadWater() {
  setStatus('waterStatus', 'กำลังโหลดข้อมูลจากคลังข้อมูลน้ำแห่งชาติ (ThaiWater)… ข้อมูลมีขนาดใหญ่ อาจใช้เวลาสักครู่', 'loading');
  try {
    const tw = await loadThaiWater();
    if (state.waterRenderedAt !== tw.fetched) {
      renderWaterNational(tw);
      state.waterRenderedAt = tw.fetched;
    }
    renderWaterNearby(tw);
    setStatus('waterStatus', '');
  } catch (e) {
    setStatus('waterStatus', `โหลดข้อมูล ThaiWater ไม่สำเร็จ: ${e.message}`, 'error');
  }
}

function renderWaterNational(tw) {
  const { dams, wl, rain } = tw;
  // ---------- สรุประดับประเทศ ----------
  const totStorage = sum(dams.map(d => d.storage)), totNormal = sum(dams.map(d => d.normal));
  const totUsable = sum(dams.map(d => d.usable));
  const hiDams = dams.filter(d => d.pct > 80), lowDams = dams.filter(d => d.usablePct != null && d.usablePct <= 30);
  const overflow = wl.filter(s => s.pct > 100);
  const heavy = rain.filter(r => r.r24 > 90);
  const rMax = rain.reduce((a, b) => (b.r24 > (a?.r24 ?? -1) ? b : a), null);
  const tile = (label, value, sub, color) =>
    `<div class="tile"><div class="t-label">${label}</div><div class="t-value" ${color ? `style="color:${color}"` : ''}>${value}</div><div class="t-sub">${sub}</div></div>`;
  $('#waterTiles').innerHTML =
    tile(`ปริมาณน้ำรวม ${dams.length} เขื่อนใหญ่`, `${fmt(totStorage)} <small>ล้าน ลบ.ม.</small>`, `${fmt(totStorage / totNormal * 100, 1)}% ของความจุ · น้ำใช้การ ${fmt(totUsable)} ล้าน ลบ.ม.`) +
    tile('เขื่อนน้ำมาก (> 80%)', `${hiDams.length} แห่ง`, hiDams.filter(d => d.pct > 100).length ? `เกินความจุ ${hiDams.filter(d => d.pct > 100).length} แห่ง` : 'ไม่มีเขื่อนเกินความจุ', hiDams.length ? '#dc2626' : '') +
    tile('เขื่อนน้ำน้อยวิกฤต (ใช้การ ≤ 30%)', `${lowDams.length} แห่ง`, lowDams.map(d => d.name).slice(0, 4).join(', ') || '—', lowDams.length ? '#d97706' : '') +
    tile('สถานีน้ำล้นตลิ่ง', `${overflow.length} <small>/ ${wl.length}</small>`, `น้ำมาก (> 70%) ${wl.filter(s => s.pct > 70 && s.pct <= 100).length} สถานี`, overflow.length ? '#dc2626' : '') +
    tile('ฝน 24 ชม. สูงสุด', rMax ? `${fmt(rMax.r24, 1)} มม.` : '–', rMax ? `${rMax.name} จ.${rMax.province} · ฝน > 90 มม. ${heavy.length} สถานี` : '');

  // ---------- แผนที่ ----------
  if (!state.maps.water) {
    const map = L.map('waterMap', { preferCanvas: true, zoomSnap: 0.25 }).fitBounds([[5.6, 97.4], [20.5, 105.7]]);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap · ThaiWater' }).addTo(map);
    state.maps.water = map;
    state.waterLayers = { rain: L.layerGroup(), wl: L.layerGroup().addTo(map), dam: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) };
    L.control.layers(null, {
      '🏞️ เขื่อนขนาดใหญ่': state.waterLayers.dam,
      '📏 ระดับน้ำในลำน้ำ': state.waterLayers.wl,
      '🌧️ ฝน 24 ชม.': state.waterLayers.rain,
    }, { collapsed: false }).addTo(map);
  }
  const Ly = state.waterLayers;
  Ly.rain.clearLayers(); Ly.wl.clearLayers(); Ly.dam.clearLayers();

  [...rain].filter(r => r.r24 > 0).sort((a, b) => a.r24 - b.r24).forEach(r => {
    L.circleMarker([r.lat, r.lon], { radius: 3 + Math.min(r.r24, 150) / 25, weight: 0, fillColor: rainColor(r.r24), fillOpacity: .85 })
      .bindPopup(`<b>🌧️ ${r.name}</b><br>อ.${r.amphoe} จ.${r.province}<br>ฝน 24 ชม.: <b>${fmt(r.r24, 1)} มม.</b> · 1 ชม.: ${fmt(r.r1, 1)} มม.<br><small>${r.time} · ${r.agency || ''}</small>`)
      .addTo(Ly.rain);
  });
  [...wl].sort((a, b) => a.pct - b.pct).forEach(s => {
    const st = wlStatus(s.pct);
    s._mk = L.circleMarker([s.lat, s.lon], { radius: 5, color: '#fff', weight: 1, fillColor: st.color, fillOpacity: .9 })
      .bindPopup(`<b>📏 ${s.name}</b> ${s.code ? `(${s.code})` : ''}<br>${s.river} · จ.${s.province}<br>` +
        `ระดับน้ำ ${fmt(s.msl, 2)} ม.รทก. · <b style="color:${st.color}">${fmt(s.pct, 1)}% (${st.name})</b><br>` +
        `${s.diffText} ${fmt(s.diffBank, 2)} · แนวโน้ม ${wlTrend(s)}<br><small>${s.time}</small>`)
      .addTo(Ly.wl);
  });
  dams.forEach(d => {
    const st = damStatus(d);
    d._mk = L.circleMarker([d.lat, d.lon], { radius: 10, color: '#0f172a', weight: 2, fillColor: st.color, fillOpacity: .95 })
      .bindTooltip(`${d.name} ${fmt(d.pct)}%`, { direction: 'top', offset: [0, -8] })
      .bindPopup(`<b>🏞️ เขื่อน${d.name}</b><br>จ.${d.province} · ${d.basin}<br>` +
        `ปริมาณน้ำ <b>${fmt(d.storage, 2)}</b> / ${fmt(d.normal)} ล้าน ลบ.ม. (<b style="color:${st.color}">${fmt(d.pct, 1)}%</b> – ${st.name})<br>` +
        `น้ำใช้การ ${fmt(d.usable, 2)} ล้าน ลบ.ม. (${fmt(d.usablePct, 1)}%)<br>ไหลเข้า ${fmt(d.inflow, 2)} · ระบาย ${fmt(d.released, 2)} ล้าน ลบ.ม./วัน<br><small>ข้อมูลวันที่ ${d.date}</small>`)
      .addTo(Ly.dam);
  });

  const dot = (c, t) => `<i style="background:${c}"></i>${t}`;
  $('#waterLegend').innerHTML =
    `<span><b>เขื่อน:</b>${dot('#C70000', '>100%')}${dot('#FF0000', '81–100%')}${dot('#003CFA', '51–80%')}${dot('#00B050', '31–50%')}${dot('#FFC000', 'น้ำน้อยวิกฤต')}</span>` +
    `<span><b>ระดับน้ำ:</b>${dot('#FF0000', 'ล้นตลิ่ง')}${dot('#003CFA', 'น้ำมาก')}${dot('#00B050', 'ปกติ')}${dot('#FFC000', 'น้ำน้อย')}${dot('#990000', 'วิกฤต')}</span>` +
    `<span><b>ฝน (มม.):</b>${RAIN_SCALE.slice().reverse().map(([t, c]) => dot(c, `>${t}`)).join('')}</span>`;

  // ---------- กราฟเขื่อน ----------
  const sorted = [...dams].sort((a, b) => b.pct - a.pct);
  makeChart('damChart', {
    type: 'bar',
    data: {
      labels: sorted.map(d => d.name),
      datasets: [{ label: '% ของความจุ (รนก.)', data: sorted.map(d => d.pct), backgroundColor: sorted.map(d => damStatus(d).color), borderRadius: 3 }],
    },
    options: {
      indexAxis: 'y',
      interaction: { mode: 'nearest', axis: 'y', intersect: false },
      scales: { x: { min: 0, suggestedMax: 110, title: { display: true, text: '%' } }, y: { ticks: { autoSkip: false, font: { size: 11 } } } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => `${fmt(c.raw, 1)}% · ${damStatus(sorted[c.dataIndex]).name}`,
            afterLabel: c => { const d = sorted[c.dataIndex]; return `${fmt(d.storage, 1)} / ${fmt(d.normal)} ล้าน ลบ.ม. · ใช้การ ${fmt(d.usablePct, 1)}%`; },
          },
        },
      },
    },
  });

  // ---------- ตารางเขื่อน ----------
  const damBody = $('#damTable tbody');
  damBody.innerHTML = sorted.map((d, i) => {
    const st = damStatus(d);
    return `<tr data-i="${i}">
      <td><b>${d.name}</b></td>
      <td>${d.province}<br><small class="muted">${d.basin || ''}</small></td>
      <td>${fmt(d.storage, 2)} <small class="muted">/ ${fmt(d.normal)}</small></td>
      <td>${pctBar(d.pct, st.color)}${fmt(d.pct, 1)}%</td>
      <td>${fmt(d.usablePct, 1)}%</td>
      <td>${fmt(d.inflow, 2)}</td>
      <td>${fmt(d.released, 2)}</td>
      <td><span class="badge" style="background:${st.color}">${st.name}</span></td>
    </tr>`;
  }).join('');
  damBody.onclick = e => {
    const tr = e.target.closest('tr[data-i]');
    if (tr) focusWaterMarker(sorted[+tr.dataset.i]._mk);
  };

  // ---------- ตารางสถานีระดับน้ำ (เฝ้าระวัง) ----------
  const watch = [...wl].filter(s => s.pct > 70).sort((a, b) => b.pct - a.pct).slice(0, 60);
  const wlBody = $('#wlTable tbody');
  wlBody.innerHTML = watch.length ? watch.map((s, i) => {
    const st = wlStatus(s.pct);
    return `<tr data-i="${i}">
      <td class="wrap"><b>${s.name}</b><br><small class="muted">${s.river}</small></td>
      <td>${s.province}</td>
      <td>${pctBar(s.pct, st.color)}<b style="color:${st.color}">${fmt(s.pct, 1)}%</b></td>
      <td>${s.diffText.replace(' (ม.)', '')} ${fmt(Math.abs(s.diffBank), 2)} ม.</td>
      <td>${wlTrend(s)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="muted">ไม่มีสถานีที่ระดับน้ำเกิน 70% ของความจุลำน้ำ</td></tr>';
  wlBody.onclick = e => {
    const tr = e.target.closest('tr[data-i]');
    if (tr) focusWaterMarker(watch[+tr.dataset.i]._mk);
  };
}

function focusWaterMarker(mk) {
  const map = state.maps.water;
  if (!mk || !map) return;
  $('#waterMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  map.flyTo(mk.getLatLng(), Math.max(map.getZoom(), 9));
  mk.openPopup();
}

function renderWaterNearby(tw) {
  const { lat, lon, name } = state.loc;
  const nb = twNearby(tw, lat, lon);

  // ตำแหน่งผู้ใช้บนแผนที่
  const me = state.waterLayers?.me;
  if (me) {
    me.clearLayers();
    L.marker([lat, lon]).bindPopup(`<b>${name}</b>`).addTo(me);
    L.circle([lat, lon], { radius: nb.rainR * 1000, color: '#2563eb', weight: 1, fillOpacity: .04 }).addTo(me);
  }

  // ฝน
  let rainHtml = '<h4>🌧️ ฝนตรวจวัด 24 ชม.</h4>';
  if (nb.rainNear.length) {
    const th = rainThresholds(nb.rainMax.zone);
    rainHtml += `<div class="big" style="color:${rainColor(nb.rainMax.r24)}">${fmt(nb.rainMax.r24, 1)} มม.</div>
      <div class="muted">สูงสุดที่ ${nb.rainMax.name} · เฉลี่ย ${fmt(nb.rainAvg, 1)} มม. จาก ${nb.rainNear.length} สถานี (รัศมี ${nb.rainR} กม.)</div>
      <div class="muted">เกณฑ์เตือนภัยโซน ${nb.rainMax.zone}: เฝ้าระวัง ≥ ${th.warn} · วิกฤต ≥ ${th.crit} มม.</div>
      <ul class="mini-list">${[...nb.rainNear].sort((a, b) => b.r24 - a.r24).slice(0, 5).map(r =>
        `<li><span>${r.name} <small class="muted">${fmt(r.dist, 1)} กม.</small></span><span style="color:${rainColor(r.r24)}">${fmt(r.r24, 1)}</span></li>`).join('')}</ul>`;
  } else rainHtml += '<p class="muted">ไม่มีสถานีวัดฝนในรัศมี 40 กม.</p>';

  // ระดับน้ำ
  let wlHtml = '<h4>📏 ระดับน้ำในลำน้ำ (รัศมี 30 กม.)</h4>';
  if (nb.wlNear.length) {
    const st = wlStatus(nb.wlMax.pct);
    wlHtml += `<div class="big" style="color:${st.color}">${fmt(nb.wlMax.pct, 1)}% <small>${st.name}</small></div>
      <div class="muted">${nb.wlMax.name} · ${nb.wlMax.river}</div>
      <ul class="mini-list">${nb.wlNear.slice(0, 6).map(s =>
        `<li><span>${s.name} <small class="muted">${s.river} · ${fmt(s.dist, 1)} กม.</small></span><span style="color:${wlStatus(s.pct).color}">${fmt(s.pct)}%</span></li>`).join('')}</ul>`;
  } else wlHtml += '<p class="muted">ไม่มีสถานีวัดระดับน้ำในรัศมี 30 กม.</p>';

  // เขื่อน
  const damHtml = '<h4>🏞️ เขื่อนขนาดใหญ่ที่ใกล้ที่สุด</h4>' + nb.damNear.map(d => {
    const st = damStatus(d);
    return `<div style="margin-bottom:8px"><b>${d.name}</b> <small class="muted">${fmt(d.dist)} กม. · จ.${d.province}</small><br>
      ${pctBar(d.pct, st.color)}<b style="color:${st.color}">${fmt(d.pct, 1)}%</b> <small>${st.name} · ไหลเข้า ${fmt(d.inflow, 1)} / ระบาย ${fmt(d.released, 1)} ล้าน ลบ.ม./วัน</small></div>`;
  }).join('');

  $('#waterNearby').innerHTML = `<div>${rainHtml}</div><div>${wlHtml}</div><div>${damHtml}</div>`;
}

/** การ์ดฝนตรวจวัดจริงในแท็บทำนายฝน — เทียบกับค่าพยากรณ์และเกณฑ์เตือนภัย */
function renderRainObs(tw) {
  const w = state.weather;
  if (!w) return;
  const nb = twNearby(tw, state.loc.lat, state.loc.lon);
  if (!nb.rainNear.length) {
    $('#rainObs').innerHTML = '<p class="muted">ไม่มีสถานีวัดฝนของ ThaiWater ในรัศมี 40 กม. (ข้อมูลครอบคลุมเฉพาะประเทศไทย)</p>';
    return;
  }
  const h = w.hourly, s = w.hIdx;
  const modelPast24 = sum(h.precipitation.slice(Math.max(0, s - 24), s));
  const next24 = sum(h.precipitation.slice(s, s + 24));
  const th = rainThresholds(nb.rainMax.zone);
  const obs = nb.rainMax.r24;
  const notes = [];
  if (obs >= th.crit) notes.push(`🔴 ฝนตรวจวัดสูงสุด <b>${fmt(obs, 1)} มม.</b> เกินเกณฑ์ <b>วิกฤต</b> ของพื้นที่ (≥ ${th.crit} มม.) — เสี่ยงน้ำท่วมฉับพลัน/น้ำป่า`);
  else if (obs >= th.warn) notes.push(`🟠 ฝนตรวจวัดสูงสุด <b>${fmt(obs, 1)} มม.</b> เกินเกณฑ์ <b>เฝ้าระวัง</b> ของพื้นที่ (≥ ${th.warn} มม.)`);
  else notes.push(`ฝนตรวจวัดสูงสุด <b>${fmt(obs, 1)} มม.</b> ยังต่ำกว่าเกณฑ์เฝ้าระวังของพื้นที่ (${th.warn} มม.)`);
  if (nb.rainOutlier) {
    notes.push(`⚠️ สถานีข้างเคียงวัดได้ไม่เกิน ${fmt(nb.rainSecond, 1)} มม. — ค่าสูงสุดอาจเป็นพายุเฉพาะจุดหรือความผิดพลาดของเครื่องวัด ควรตรวจสอบเพิ่มเติม`);
  }
  notes.push(`แบบจำลองประเมินฝน 24 ชม. ที่ผ่านมา ${fmt(modelPast24, 1)} มม. เทียบกับค่าเฉลี่ยสถานีจริง ${fmt(nb.rainAvg, 1)} มม. — ` +
    (nb.rainAvg > modelPast24 * 1.5 + 5 ? 'ฝนจริง<b>มากกว่า</b>แบบจำลอง ควรเผื่อค่าพยากรณ์สูงขึ้น'
      : nb.rainAvg < modelPast24 * 0.5 - 5 ? 'ฝนจริง<b>น้อยกว่า</b>แบบจำลอง' : 'ใกล้เคียงกับแบบจำลอง'));
  if (nb.rainAvg >= 35 && next24 >= 10) {
    notes.push(`⚠️ ดินชุ่มน้ำจากฝนที่ตกไปแล้ว และคาดว่าจะมีฝนอีก ${fmt(next24, 1)} มม. ใน 24 ชม. — เพิ่มความเสี่ยงน้ำท่วมขังและน้ำไหลหลาก`);
  }
  $('#rainObs').innerHTML = `<div class="obs-grid">
    <ul>${notes.map(n => `<li>${n}</li>`).join('')}</ul>
    <div><ul class="mini-list">${[...nb.rainNear].sort((a, b) => b.r24 - a.r24).slice(0, 6).map(r =>
      `<li><span>${r.name} <small class="muted">อ.${r.amphoe} · ${fmt(r.dist, 1)} กม.</small></span><span style="color:${rainColor(r.r24)}">${fmt(r.r24, 1)} มม.</span></li>`).join('')}</ul>
      <p class="hint">ข้อมูล ณ ${nb.rainMax.time} · ${nb.rainNear.length} สถานีในรัศมี ${nb.rainR} กม.</p></div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* คุณภาพอากาศ                                                          */
/*   Air4Thai (กรมควบคุมมลพิษ) : AQI ไทย + ประวัติรายชั่วโมง (ใช้ฝึกแบบจำลอง) */
/*   WAQI (aqicn.org)           : สถานีเพิ่มเติม + พยากรณ์รายวัน (US AQI)    */
/*   Open-Meteo Air Quality     : องค์ประกอบมลพิษจากแบบจำลอง CAMS           */
/* ------------------------------------------------------------------ */

const A4T_BASE = 'https://air4thai.com/forweb/';
// WAQI token ของผู้ใช้ (ออกแบบมาให้ใช้ฝั่งเบราว์เซอร์ได้) — ขอใหม่ได้ที่ https://aqicn.org/data-platform/token/
const WAQI_TOKEN = '2d05287b0fa774bb404a076e1f21d5e0b40ee978';
const TH_BOUNDS = [[5.6, 97.3], [20.5, 105.7]];
const BKK_OFFSET = 7 * 3600;

// ระดับ AQI ของประเทศไทย (กรมควบคุมมลพิษ)
const THAI_AQI = [
  { max: 25, name: 'ดีมาก', color: '#3BCCFF', text: '#0b3a4a', advice: 'คุณภาพอากาศดีมาก เหมาะสำหรับกิจกรรมกลางแจ้งและการท่องเที่ยว' },
  { max: 50, name: 'ดี', color: '#92D050', text: '#1f3d0c', advice: 'คุณภาพอากาศดี สามารถทำกิจกรรมกลางแจ้งและการท่องเที่ยวได้ตามปกติ' },
  { max: 100, name: 'ปานกลาง', color: '#FFFF00', text: '#4a4a00', advice: 'ประชาชนทั่วไปทำกิจกรรมกลางแจ้งได้ตามปกติ ผู้ที่ต้องดูแลสุขภาพเป็นพิเศษ หากมีอาการ เช่น ไอ หายใจลำบาก ระคายเคืองตา ควรลดระยะเวลาทำกิจกรรมกลางแจ้ง' },
  { max: 200, name: 'เริ่มมีผลกระทบต่อสุขภาพ', color: '#FFA200', text: '#4a2e00', advice: 'ควรเฝ้าระวังสุขภาพ ลดระยะเวลาทำกิจกรรมกลางแจ้ง หรือใช้อุปกรณ์ป้องกันตนเองหากมีความจำเป็น เด็ก ผู้สูงอายุ และผู้มีโรคประจำตัวควรหลีกเลี่ยงกิจกรรมกลางแจ้ง' },
  { max: Infinity, name: 'มีผลกระทบต่อสุขภาพ', color: '#F04646', text: '#ffffff', advice: 'ทุกคนควรหลีกเลี่ยงกิจกรรมกลางแจ้ง ปิดประตูหน้าต่าง สวมหน้ากาก N95 เมื่อออกนอกอาคาร หากมีอาการผิดปกติให้ปรึกษาแพทย์' },
];
const thaiLevel = aqi => THAI_AQI.find(l => aqi <= l.max);
const thaiLevelById = id => THAI_AQI[+id - 1] || null; // color_id ของ Air4Thai (1–5, 0 = ไม่มีข้อมูล)

// ระดับ US AQI (WAQI)
const US_AQI = [
  { max: 50, name: 'ดี', color: '#009966', text: '#fff' },
  { max: 100, name: 'ปานกลาง', color: '#FFDE33', text: '#3d3500' },
  { max: 150, name: 'มีผลต่อกลุ่มเสี่ยง', color: '#FF9933', text: '#3d1f00' },
  { max: 200, name: 'มีผลต่อสุขภาพ', color: '#CC0033', text: '#fff' },
  { max: 300, name: 'มีผลต่อสุขภาพมาก', color: '#660099', text: '#fff' },
  { max: Infinity, name: 'อันตราย', color: '#7E0023', text: '#fff' },
];
const usLevel = aqi => US_AQI.find(l => aqi <= l.max);

/** PM2.5 (µg/m³, เฉลี่ย 24 ชม.) → AQI ไทย ตามเกณฑ์ปี 2566 */
function pm25ToThaiAqi(c) {
  const bp = [[0, 15, 0, 25], [15.1, 25, 26, 50], [25.1, 37.5, 51, 100], [37.6, 75, 101, 200]];
  const r = bp.find(([, hi]) => c <= hi);
  if (!r) return Math.round(201 + (c - 75.1) * (99 / 37.4));
  const [lo, hi, alo, ahi] = r;
  return Math.round(alo + (Math.max(c, lo) - lo) * (ahi - alo) / (hi - lo));
}

const POLLUTANTS = [
  { key: 'PM25', name: 'PM2.5', unit: 'µg/m³' },
  { key: 'PM10', name: 'PM10', unit: 'µg/m³' },
  { key: 'O3', name: 'โอโซน (O₃)', unit: 'ppb' },
  { key: 'CO', name: 'คาร์บอนมอนอกไซด์ (CO)', unit: 'ppm' },
  { key: 'NO2', name: 'ไนโตรเจนไดออกไซด์ (NO₂)', unit: 'ppb' },
  { key: 'SO2', name: 'ซัลเฟอร์ไดออกไซด์ (SO₂)', unit: 'ppb' },
];

const ymdOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hourKey = d => `${ymdOf(d)}T${String(d.getHours()).padStart(2, '0')}`;

/* ---------- โหลดข้อมูลสถานี ---------- */

function loadAir4Thai() {
  if (state.a4tPromise && Date.now() - state.a4tTime < 10 * 60e3) return state.a4tPromise;
  state.a4tTime = Date.now();
  state.a4tPromise = getJSON(A4T_BASE + 'getAQI_JSON.php', 30e3).then(j => {
    const list = (j.stations || []).map(s => {
      const L = s.AQILast || {};
      const aqi = num(L.AQI?.aqi);
      return {
        id: s.stationID, name: s.nameTH, nameEN: s.nameEN, area: s.areaTH, type: s.stationType,
        province: (s.areaTH || '').split(',').pop().trim(),
        lat: +s.lat, lon: +s.long, date: L.date, time: L.time,
        aqi: aqi != null && aqi >= 0 ? aqi : null, aqiColor: L.AQI?.color_id, dominant: L.AQI?.param,
        p: Object.fromEntries(POLLUTANTS.map(p => {
          const v = num(L[p.key]?.value), a = num(L[p.key]?.aqi);
          return [p.key, { value: v != null && v >= 0 ? v : null, aqi: a != null && a >= 0 ? a : null, color: L[p.key]?.color_id }];
        })),
      };
    }).filter(s => isFinite(s.lat) && isFinite(s.lon));
    const latest = list.map(s => `${s.date} ${s.time}`).sort().pop();
    list.forEach(s => { s.stale = `${s.date} ${s.time}` < latest.slice(0, 10) + ' 00:00' || s.aqi == null; });
    return { list, latest };
  });
  state.a4tPromise.catch(() => { state.a4tTime = 0; });
  return state.a4tPromise;
}

function loadWaqiBounds() {
  if (state.waqiPromise) return state.waqiPromise;
  const [[s, w], [n, e]] = TH_BOUNDS;
  state.waqiPromise = getJSON(`https://api.waqi.info/map/bounds/?latlng=${s},${w},${n},${e}&networks=all&token=${WAQI_TOKEN}`, 30e3)
    .then(j => {
      if (j.status !== 'ok') throw new Error(j.data || 'WAQI error');
      return j.data.filter(x => x.aqi !== '-' && isFinite(+x.aqi))
        .map(x => ({ uid: x.uid, lat: x.lat, lon: x.lon, aqi: +x.aqi, name: x.station?.name, time: x.station?.time }));
    });
  state.waqiPromise.catch(() => { state.waqiPromise = null; });
  return state.waqiPromise;
}

async function waqiFeed(path) {
  const j = await getJSON(`https://api.waqi.info/feed/${path}/?token=${WAQI_TOKEN}`, 20e3);
  if (j.status !== 'ok') throw new Error(j.data || 'WAQI error');
  return j.data;
}

/* ---------- แท็บหลัก ---------- */

async function loadAir() {
  setStatus('airStatus', 'กำลังโหลดข้อมูลสถานีตรวจวัดคุณภาพอากาศ…', 'loading');
  try {
    const a4t = await loadAir4Thai();
    state.a4t = a4t;
    initAirControls(a4t);
    await renderAirMap();
    renderAirNational(a4t);
    const st = a4t.list.find(s => s.id === state.airStationId) || nearestAirStation();
    setStatus('airStatus', '');
    selectAirStation(st.id, false);
  } catch (e) {
    setStatus('airStatus', `โหลดข้อมูล Air4Thai ไม่สำเร็จ: ${e.message}`, 'error');
  }
}

function nearestAirStation() {
  const { lat, lon } = state.loc;
  return state.a4t.list.filter(s => !s.stale)
    .reduce((a, b) => (haversine(lat, lon, b.lat, b.lon) < haversine(lat, lon, a.lat, a.lon) ? b : a));
}

function initAirControls(a4t) {
  // รายชื่อสถานีจัดกลุ่มตามจังหวัด
  const byProv = {};
  a4t.list.filter(s => s.aqi != null).forEach(s => (byProv[s.province] ||= []).push(s));
  $('#airStation').innerHTML = Object.keys(byProv).sort((a, b) => a.localeCompare(b, 'th')).map(p =>
    `<optgroup label="${p}">${byProv[p].sort((a, b) => a.name.localeCompare(b.name, 'th'))
      .map(s => `<option value="${s.id}">${s.name} — AQI ${s.aqi}${s.stale ? ' (ข้อมูลเก่า)' : ''}</option>`).join('')}</optgroup>`).join('');
  if (state.airControlsBound) return;
  state.airControlsBound = true;
  $('#airStation').addEventListener('change', e => selectAirStation(e.target.value, true));
  $('#airNearest').addEventListener('click', () => selectAirStation(nearestAirStation().id, true));
  $('#airMetric').addEventListener('change', renderAirMap);
  $('#airSource').addEventListener('change', () => {
    $('#airMetricWrap').style.display = $('#airSource').value === 'a4t' ? '' : 'none';
    renderAirMap();
  });
}

function airPin(value, lvl, extra = '') {
  const w = String(value).length > 2 ? 38 : 32;
  return L.divIcon({
    className: 'aq-icon', iconSize: [w, 22], iconAnchor: [w / 2, 11],
    html: `<div class="aq-pin ${extra}" style="background:${lvl.color};color:${lvl.text}">${value}</div>`,
  });
}

async function renderAirMap() {
  if (!state.maps.air) {
    const map = L.map('airMap', { zoomSnap: 0.25 }).fitBounds(TH_BOUNDS);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
    state.maps.air = map;
    state.airLayer = L.layerGroup().addTo(map);
  }
  const layer = state.airLayer;
  layer.clearLayers();
  state.airMarkers = {};
  const source = $('#airSource').value, metric = $('#airMetric').value;

  if (source === 'a4t') {
    state.a4t.list.forEach(s => {
      const m = metric === 'AQI' ? { value: s.aqi, color: s.aqiColor } : { value: s.p[metric].value, color: s.p[metric].color };
      const lvl = thaiLevelById(m.color);
      if (m.value == null || !lvl) return;
      const cls = [s.stale ? 'stale' : '', s.id === state.airStationId ? 'sel' : ''].join(' ');
      const mk = L.marker([s.lat, s.lon], { icon: airPin(Math.round(m.value * 10) / 10, lvl, cls), zIndexOffset: s.id === state.airStationId ? 1000 : m.value })
        .bindTooltip(`<b>${s.name}</b><br>${s.area}<br>AQI ${s.aqi ?? '–'} · PM2.5 ${fmt(s.p.PM25.value, 1)} µg/m³<br><small>${s.date} ${s.time} น.</small>`, { direction: 'top', offset: [0, -10] })
        .on('click', () => selectAirStation(s.id, true))
        .addTo(layer);
      state.airMarkers[s.id] = mk;
    });
    $('#airLegend').innerHTML = `<span><b>AQI ไทย (กรมควบคุมมลพิษ):</b>${THAI_AQI.map((l, i) =>
      `<i style="background:${l.color}"></i>${[0, 26, 51, 101, 201][i]}${i < 4 ? '–' + l.max : '+'} ${l.name}`).join('')}</span>` +
      '<span>จุดจาง = ข้อมูลไม่เป็นปัจจุบัน · คลิกสถานีเพื่อดูรายละเอียดและผลการทำนาย</span>';
  } else {
    setStatus('airStatus', 'กำลังโหลดสถานีจาก WAQI…', 'loading');
    try {
      const list = await loadWaqiBounds();
      setStatus('airStatus', '');
      list.forEach(x => {
        const lvl = usLevel(x.aqi);
        L.marker([x.lat, x.lon], { icon: airPin(x.aqi, lvl), zIndexOffset: x.aqi })
          .bindPopup('<div class="muted">กำลังโหลด…</div>', { minWidth: 240 })
          .on('popupopen', async ev => {
            try {
              const d = await waqiFeed('@' + x.uid);
              ev.popup.setContent(waqiPopup(d));
            } catch (e) { ev.popup.setContent(`โหลดไม่สำเร็จ: ${e.message}`); }
          })
          .addTo(layer);
      });
      $('#airLegend').innerHTML = `<span><b>US AQI (WAQI):</b>${US_AQI.map((l, i) =>
        `<i style="background:${l.color}"></i>${[0, 51, 101, 151, 201, 301][i]}${isFinite(l.max) ? '–' + l.max : '+'} ${l.name}`).join('')}</span>` +
        `<span>${list.length} สถานี (รวมเครือข่ายเซนเซอร์ชุมชนและประเทศเพื่อนบ้าน) · คลิกเพื่อดูรายละเอียด</span>`;
    } catch (e) {
      setStatus('airStatus', `โหลดข้อมูล WAQI ไม่สำเร็จ: ${e.message}`, 'error');
    }
  }
}

const IAQI_NAMES = { pm25: 'PM2.5', pm10: 'PM10', o3: 'O₃', no2: 'NO₂', so2: 'SO₂', co: 'CO', t: 'อุณหภูมิ °C', h: 'ความชื้น %', w: 'ลม m/s', p: 'ความกดอากาศ hPa' };
function waqiPopup(d) {
  const lvl = usLevel(+d.aqi || 0);
  const iaqi = Object.entries(d.iaqi || {}).filter(([k]) => IAQI_NAMES[k])
    .map(([k, v]) => `<span>${IAQI_NAMES[k]} <b>${fmt(v.v, 1)}</b></span>`).join('');
  return `<b>${d.city?.name || ''}</b><br>
    <span class="badge" style="background:${lvl.color};color:${lvl.text}">US AQI ${d.aqi} · ${lvl.name}</span>
    มลพิษหลัก: <b>${(d.dominentpol || '').toUpperCase()}</b><div class="iaqi">${iaqi}</div>
    <small class="muted">${d.time?.s || ''} · ค่ามลพิษเป็นดัชนีย่อย (US AQI)<br>${(d.attributions || []).map(a => a.name).join(' · ')}</small>`;
}

function renderAirNational(a4t) {
  const cur = a4t.list.filter(s => !s.stale && s.aqi != null);
  $('#airNatTime').textContent = `(${cur.length} สถานี · ${a4t.latest} น.)`;
  const counts = THAI_AQI.map((_, i) => cur.filter(s => +s.aqiColor === i + 1).length);
  $('#airDist').innerHTML = `<div class="dist-bar">${THAI_AQI.map((l, i) => counts[i]
    ? `<span style="flex:${counts[i]};background:${l.color};color:${l.text}" title="${l.name}: ${counts[i]} สถานี">${counts[i]}</span>` : '').join('')}</div>
    <div class="dist-legend">${THAI_AQI.map((l, i) => `<span><i style="background:${l.color}"></i>${l.name} ${counts[i]}</span>`).join('')}</div>`;
  const top = [...cur].sort((a, b) => b.aqi - a.aqi).slice(0, 10);
  $('#airTop').innerHTML = top.map(s => {
    const l = thaiLevelById(s.aqiColor);
    return `<li data-id="${s.id}"><span class="badge" style="background:${l.color};color:${l.text}">${s.aqi}</span>${s.name} <small class="muted">${s.province}</small></li>`;
  }).join('');
  $('#airTop').onclick = e => {
    const li = e.target.closest('li[data-id]');
    if (li) selectAirStation(li.dataset.id, true);
  };
}

/* ---------- สถานีที่เลือก ---------- */

function selectAirStation(id, fly) {
  const s = state.a4t.list.find(x => x.id === id);
  if (!s) return;
  state.airStationId = id;
  $('#airStation').value = id;
  if ($('#airSource').value === 'a4t') renderAirMap();
  if (fly) state.maps.air.flyTo([s.lat, s.lon], Math.max(state.maps.air.getZoom(), 9), { duration: .8 });
  renderAirHero(s);
  runAirModel(s);
  renderWaqiCompare(s);
}

function aqiRing(value, lvl, max = 200) {
  const r = 52, c = 2 * Math.PI * r, frac = clamp((value ?? 0) / max, 0, 1);
  return `<svg class="aqi-ring" viewBox="0 0 128 128">
    <circle cx="64" cy="64" r="${r}" fill="none" stroke="var(--border)" stroke-width="12"/>
    <circle cx="64" cy="64" r="${r}" fill="none" stroke="${lvl?.color || '#94a3b8'}" stroke-width="12" stroke-linecap="round"
      stroke-dasharray="${c * frac} ${c}" transform="rotate(-90 64 64)"/>
    <text x="64" y="66" text-anchor="middle" class="val">${value ?? '–'}</text>
    <text x="64" y="86" text-anchor="middle" class="lbl">AQI</text>
  </svg>`;
}

function renderAirHero(s) {
  const lvl = thaiLevelById(s.aqiColor) || THAI_AQI[0];
  const dist = haversine(state.loc.lat, state.loc.lon, s.lat, s.lon);
  const pols = POLLUTANTS.map(p => {
    const v = s.p[p.key], pl = thaiLevelById(v.color);
    return `<div class="pol ${v.value == null ? 'na' : ''}" style="--c:${pl?.color || 'var(--border)'}">
      <div class="p-name">${p.name}</div>
      <div class="p-val">${v.value == null ? '–' : fmt(v.value, p.key === 'CO' ? 2 : 1)} <small>${p.unit}</small></div>
      <div class="p-aqi">${v.aqi != null ? `AQI ${v.aqi} · <b style="color:${pl?.color}">${pl?.name || ''}</b>` : '<span class="muted">ไม่มีการตรวจวัด</span>'}</div>
    </div>`;
  }).join('');
  $('#airHero').innerHTML = `
    <div class="card aqi-main" style="--lvl:${lvl.color};--lvl-soft:${lvl.color}33">
      <div class="ring-wrap">
        ${aqiRing(s.aqi, lvl)}
        <div>
          <div class="st-name">${s.name}</div>
          <div class="muted" style="font-size:.85rem">${s.area}</div>
          <span class="lvl-badge" style="background:${lvl.color};color:${lvl.text}">${lvl.name}</span>
          <div class="muted" style="font-size:.8rem">มลพิษหลัก ${POLLUTANTS.find(p => p.key === s.dominant)?.name || s.dominant || '–'} · ${s.date} ${s.time} น.<br>ห่างจากตำแหน่งหลัก ${fmt(dist, 1)} กม.</div>
        </div>
      </div>
      <div class="advice-box">💡 ${lvl.advice}</div>
    </div>
    <div class="card">
      <h3>ค่ามลพิษที่ตรวจวัดได้ <span class="muted">(ค่าเฉลี่ยตามมาตรฐานกรมควบคุมมลพิษ)</span></h3>
      <div class="pol-grid">${pols}</div>
    </div>`;
}

/* ---------- แบบจำลองทำนาย PM2.5 ---------- */

/** แก้ระบบสมการเชิงเส้นด้วย Gaussian elimination (partial pivoting) */
function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Ridge regression บนตัวแปรที่ปรับมาตรฐานแล้ว */
function ridgeFit(X, y, lambda = 3) {
  const n = X.length, p = X[0].length;
  const mu = Array(p).fill(0), sd = Array(p).fill(0);
  X.forEach(r => r.forEach((v, j) => { mu[j] += v / n; }));
  X.forEach(r => r.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / n; }));
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const z = r => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])];
  const P = p + 1, A = Array.from({ length: P }, () => Array(P).fill(0)), b = Array(P).fill(0);
  X.forEach((r, i) => {
    const zi = z(r);
    for (let a = 0; a < P; a++) {
      b[a] += zi[a] * y[i];
      for (let c = 0; c < P; c++) A[a][c] += zi[a] * zi[c];
    }
  });
  for (let a = 1; a < P; a++) A[a][a] += lambda;
  const w = solveLinear(A, b);
  return { w, z, predict: r => z(r).reduce((s, v, j) => s + v * w[j], 0) };
}

// ตัวแปรต้นของแบบจำลอง (group = รวมผลในกราฟปัจจัย, hi/lo = คำอธิบายเมื่อค่าสูง/ต่ำกว่าเฉลี่ย 14 วัน)
const AIR_FEATURES = [
  { label: 'PM2.5 จากแบบจำลอง CAMS', group: 'cams', hi: 'สูงกว่าปกติ', lo: 'ต่ำกว่าปกติ' },
  { label: 'คาร์บอนมอนอกไซด์ (การเผาไหม้/เผาชีวมวล)', group: 'co', hi: 'สูงกว่าปกติ', lo: 'ต่ำกว่าปกติ' },
  { label: 'ไนโตรเจนไดออกไซด์ (การจราจร/อุตสาหกรรม)', group: 'no2', hi: 'สูงกว่าปกติ', lo: 'ต่ำกว่าปกติ' },
  { label: 'ฝุ่นละอองในบรรยากาศ (AOD)', group: 'aod', hi: 'หนากว่าปกติ', lo: 'บางกว่าปกติ' },
  { label: 'ชั้นผสมอากาศ', group: 'blh', hi: 'สูงกว่าปกติ (ระบายอากาศดี)', lo: 'ต่ำกว่าปกติ (ฝุ่นถูกกักใกล้พื้น)' },
  { label: 'ลม', group: 'wind', hi: 'แรงกว่าปกติ', lo: 'อ่อนกว่าปกติ' },
  { label: 'ความชื้นสัมพัทธ์', group: 'rh', hi: 'สูงกว่าปกติ', lo: 'ต่ำกว่าปกติ' },
  { label: 'ฝนสะสม 6 ชม.', group: 'rain', hi: 'มากกว่าปกติ (ชะล้างฝุ่น)', lo: 'น้อยกว่าปกติ (ชะล้างฝุ่นได้น้อย)' },
  { label: 'อุณหภูมิ', group: 'temp', hi: 'สูงกว่าปกติ', lo: 'ต่ำกว่าปกติ' },
  { label: 'ช่วงเวลาของวัน', group: 'hour' },
  { label: 'ช่วงเวลาของวัน', group: 'hour' },
];

async function runAirModel(s) {
  const token = (state.airModelToken = {});
  $('#airDaily').innerHTML = '<div class="skeleton">กำลังดึงข้อมูลย้อนหลัง 14 วันและสร้างแบบจำลอง…</div>';
  $('#airSkill').innerHTML = '';
  $('#airInsight').innerHTML = '';
  try {
    const now = nowAt(BKK_OFFSET);
    const start = new Date(now); start.setDate(start.getDate() - 14);
    const tz = 'Asia%2FBangkok';
    const [hist, met, aq] = await Promise.all([
      getJSON(`${A4T_BASE}getHistoryData.php?stationID=${s.id}&param=PM25&type=hr&sdate=${ymdOf(start)}&edate=${ymdOf(now)}&stime=00&etime=23`, 30e3),
      getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}&hourly=boundary_layer_height,wind_speed_10m,relative_humidity_2m,precipitation,temperature_2m&timezone=${tz}&past_days=14&forecast_days=4`),
      getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${s.lat}&longitude=${s.lon}&hourly=pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,dust,aerosol_optical_depth&timezone=${tz}&past_days=14&forecast_days=4`),
    ]);
    if (token !== state.airModelToken) return; // ผู้ใช้เปลี่ยนสถานีระหว่างโหลด
    if (hist.result !== 'OK') throw new Error(hist.error || 'Air4Thai history error');

    const obs = {};
    (hist.stations?.[0]?.data || []).forEach(r => {
      if (r.PM25 != null && r.PM25 >= 0) obs[r.DATETIMEDATA.slice(0, 13).replace(' ', 'T')] = r.PM25;
    });
    const mh = met.hourly, ah = aq.hourly;
    const aIdx = Object.fromEntries(ah.time.map((t, i) => [t, i]));
    const rows = mh.time.map((t, i) => {
      const j = aIdx[t];
      if (j == null) return null;
      const vals = [ah.pm2_5[j], ah.carbon_monoxide[j], ah.nitrogen_dioxide[j], ah.aerosol_optical_depth[j],
        mh.boundary_layer_height[i], mh.wind_speed_10m[i], mh.relative_humidity_2m[i], mh.temperature_2m[i]];
      if (vals.some(v => v == null)) return null;
      const hr = +t.slice(11, 13);
      const rain6 = sum(mh.precipitation.slice(Math.max(0, i - 5), i + 1));
      return {
        t, key: t.slice(0, 13), cams: ah.pm2_5[j], obs: obs[t.slice(0, 13)],
        x: [Math.log(ah.pm2_5[j] + 1), Math.log(ah.carbon_monoxide[j]), Math.log(ah.nitrogen_dioxide[j] + 1), ah.aerosol_optical_depth[j],
          Math.log(mh.boundary_layer_height[i] + 10), mh.wind_speed_10m[i], mh.relative_humidity_2m[i], Math.log(rain6 + 1),
          mh.temperature_2m[i], Math.sin(2 * Math.PI * hr / 24), Math.cos(2 * Math.PI * hr / 24)],
      };
    }).filter(Boolean);

    const nowKey = hourKey(now);
    const train = rows.filter(r => r.key <= nowKey && r.obs != null);
    const future = rows.filter(r => r.key > nowKey).slice(0, 72);
    if (train.length < 120) throw new Error(`ข้อมูลตรวจวัดย้อนหลังไม่พอสำหรับฝึกแบบจำลอง (${train.length} ชม.)`);

    // --- ตรวจสอบความแม่นยำ: ฝึกโดยไม่ใช้ 48 ชม. ล่าสุด แล้วทดสอบกับช่วงนั้น ---
    const VAL = 48, fitRows = train.slice(0, -VAL), valRows = train.slice(-VAL);
    const mVal = ridgeFit(fitRows.map(r => r.x), fitRows.map(r => Math.log(r.obs + 1)));
    const valPred = { model: [], cams: [], blend: [] };
    valRows.forEach(r => {
      const m = Math.max(0, Math.exp(mVal.predict(r.x)) - 1);
      valPred.model.push(m); valPred.cams.push(r.cams); valPred.blend.push((m + r.cams) / 2);
    });
    const mae = arr => sum(arr.map((v, i) => Math.abs(v - valRows[i].obs))) / arr.length;
    const skill = Object.fromEntries(Object.keys(valPred).map(k => [k, mae(valPred[k])]));
    const best = Object.keys(skill).reduce((a, b) => (skill[b] < skill[a] ? b : a));
    const logErr = valPred[best].map((v, i) => Math.log(v + 1) - Math.log(valRows[i].obs + 1));
    const bias = sum(logErr) / logErr.length;
    const sigma = Math.sqrt(sum(logErr.map(e => (e - bias) ** 2)) / logErr.length);

    // --- ฝึกด้วยข้อมูลทั้งหมด แล้วทำนายล่วงหน้า ---
    const model = ridgeFit(train.map(r => r.x), train.map(r => Math.log(r.obs + 1)));
    future.forEach(r => {
      r.model = Math.max(0, Math.exp(model.predict(r.x)) - 1);
      r.pred = best === 'model' ? r.model : best === 'cams' ? r.cams : (r.model + r.cams) / 2;
      r.lo = Math.max(0, (r.pred + 1) * Math.exp(-1.28 * sigma) - 1);
      r.hi = (r.pred + 1) * Math.exp(1.28 * sigma) - 1;
    });

    // ผลของปัจจัยในอีก 24 ชม. (log-space → % เปลี่ยนแปลง)
    const next24 = future.slice(0, 24);
    const contrib = {}, zAvg = {};
    next24.forEach(r => {
      const z = model.z(r.x);
      AIR_FEATURES.forEach((f, j) => {
        contrib[f.group] = (contrib[f.group] || 0) + model.w[j + 1] * z[j + 1] / next24.length;
        zAvg[f.group] = (zAvg[f.group] || 0) + z[j + 1] / next24.length;
      });
    });

    state.airModel = { s, rows, train, future, skill, best, sigma, contrib, zAvg, model, nowKey };
    renderAirForecast(state.airModel);
  } catch (e) {
    if (token !== state.airModelToken) return;
    $('#airDaily').innerHTML = `<p class="muted">สร้างแบบจำลองไม่สำเร็จ: ${e.message}</p>`;
    state.charts.airForecastChart?.destroy();
    state.charts.airFactorChart?.destroy();
  }
}

const METHOD_NAMES = { model: 'แบบจำลองทางสถิติ (Ridge)', cams: 'แบบจำลอง CAMS โดยตรง', blend: 'ค่าเฉลี่ยของทั้งสองแบบ' };

function renderAirForecast(M) {
  const { rows, future, skill, best, contrib, zAvg, nowKey, s } = M;
  const pastRows = rows.filter(r => r.key <= nowKey).slice(-24 * 7);

  // ---------- รายวัน ----------
  const byDay = {};
  [...rows.filter(r => r.key <= nowKey && r.obs != null), ...future].forEach(r => {
    const d = r.t.slice(0, 10), v = r.key <= nowKey ? r.obs : r.pred;
    (byDay[d] ||= []).push(v);
  });
  const today = nowKey.slice(0, 10);
  const days = Object.keys(byDay).filter(d => d >= today && byDay[d].length >= 12).slice(0, 4);
  $('#airDaily').innerHTML = days.map((d, k) => {
    const v = byDay[d], mean = sum(v) / v.length, aqi = pm25ToThaiAqi(mean), l = thaiLevel(aqi);
    return `<div class="aq-day" style="--c:${l.color}">
      <div class="d-n">${k === 0 ? 'วันนี้' : k === 1 ? 'พรุ่งนี้' : dayLabel(d)}</div>
      <div class="d-v">${fmt(mean, 1)} <small>µg/m³</small></div>
      <div class="d-l"><span class="badge" style="background:${l.color};color:${l.text}">AQI ${aqi} · ${l.name}</span></div>
      <div class="d-r">ช่วง ${fmt(Math.min(...v), 0)}–${fmt(Math.max(...v), 0)} µg/m³</div>
    </div>`;
  }).join('');
  $('#airSkill').innerHTML = `<div class="skill">
    <b>🎯 ทดสอบความแม่นยำย้อนหลัง 48 ชม.</b> (ข้อมูลที่แบบจำลองไม่เคยเห็น) — ค่าคลาดเคลื่อนเฉลี่ย (MAE, µg/m³):
    <table>${Object.keys(skill).map(k => `<tr class="${k === best ? 'best' : ''}"><td>${k === best ? '✅ ' : ''}${METHOD_NAMES[k]}</td><td style="text-align:right">${fmt(skill[k], 2)}</td></tr>`).join('')}</table>
    <div class="muted" style="margin-top:4px">ระบบเลือกวิธีที่แม่นยำที่สุดของสถานีนี้โดยอัตโนมัติ · ฝึกด้วยข้อมูลจริง ${M.train.length} ชั่วโมง</div>
  </div>`;

  // ---------- บทวิเคราะห์ ----------
  const peak = future.slice(0, 24).reduce((a, b) => (b.pred > a.pred ? b : a), future[0]);
  const lastObs = [...rows].reverse().find(r => r.key <= nowKey && r.obs != null);
  const pct = c => (Math.exp(c) - 1) * 100;
  const drivers = Object.entries(contrib).sort((a, b) => b[1] - a[1]);
  // ระบุทิศทางของตัวแปรเทียบกับค่าเฉลี่ย 14 วัน เช่น "ฝนสะสม 6 ชม. น้อยกว่าปกติ"
  const label = g => {
    const f = AIR_FEATURES.find(x => x.group === g);
    if (!f.hi || Math.abs(zAvg[g]) < 0.15) return f.label;
    return `${f.label} ${zAvg[g] > 0 ? f.hi : f.lo}`;
  };
  const up = drivers.filter(([, c]) => pct(c) >= 5).slice(0, 2), down = drivers.filter(([, c]) => pct(c) <= -5).reverse().slice(0, 2);
  const pl = thaiLevel(pm25ToThaiAqi(peak.pred));
  $('#airInsight').innerHTML = `<ul>
    <li>ค่าตรวจวัดล่าสุด <b>${fmt(lastObs?.obs, 1)} µg/m³</b> (${lastObs?.t.slice(11)} น.) · คาดว่าใน 24 ชม. ข้างหน้า PM2.5 สูงสุด <b style="color:${pl.color === '#FFFF00' ? '#a16207' : pl.color}">${fmt(peak.pred, 1)} µg/m³</b> ช่วง ${dayLabel(peak.t)} ${peak.t.slice(11)} น.</li>
    ${up.length ? `<li>🔺 ปัจจัยที่ทำให้ฝุ่นสะสมเพิ่ม: ${up.map(([g, c]) => `<b>${label(g)}</b> (+${fmt(pct(c))}%)`).join(', ')}</li>` : ''}
    ${down.length ? `<li>🔻 ปัจจัยที่ช่วยลดฝุ่น: ${down.map(([g, c]) => `<b>${label(g)}</b> (${fmt(pct(c))}%)`).join(', ')}</li>` : ''}
  </ul>`;

  // ---------- กราฟรายชั่วโมง ----------
  const all = [...pastRows, ...future];
  const nowIdx = pastRows.length - 1;
  const lvlLine = (v, name, color) => ({ label: name, data: all.map(() => v), borderColor: color, borderDash: [4, 4], borderWidth: 1, pointRadius: 0 });
  makeChart('airForecastChart', {
    type: 'line',
    data: {
      labels: all.map(r => {
        const d = parseLocal(r.t);
        return d.getHours() === 0 ? [fmtTime(d), fmtDay(d)] : fmtTime(d);
      }),
      datasets: [
        { label: '_hi', data: all.map((r, i) => (i > nowIdx ? r.hi : null)), borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(168,85,247,.18)', fill: '+1' },
        { label: '_lo', data: all.map((r, i) => (i > nowIdx ? r.lo : null)), borderWidth: 0, pointRadius: 0, fill: false },
        { label: 'ค่าตรวจวัดจริง (Air4Thai)', data: all.map((r, i) => (i <= nowIdx ? r.obs ?? null : null)), borderColor: '#0f766e', backgroundColor: '#0f766e', pointRadius: 1.5, borderWidth: 2, spanGaps: false },
        { label: 'แบบจำลอง CAMS', data: all.map(r => r.cams), borderColor: '#94a3b8', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 },
        { label: `ทำนาย (${METHOD_NAMES[best]})`, data: all.map((r, i) => (i >= nowIdx ? (i === nowIdx ? r.obs ?? r.cams : r.pred) : null)), borderColor: '#a855f7', pointRadius: 0, borderWidth: 3, tension: .3 },
        lvlLine(37.5, 'เกณฑ์มาตรฐาน 37.5', '#FFA200'),
        lvlLine(75, 'มีผลกระทบต่อสุขภาพ 75', '#F04646'),
      ],
    },
    options: {
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 16 } },
        y: { beginAtZero: true, suggestedMax: 40, title: { display: true, text: 'PM2.5 (µg/m³)' } },
      },
      plugins: {
        nowLine: { index: nowIdx },
        legend: { labels: { filter: it => !it.text.startsWith('_') } },
        tooltip: { filter: it => !it.dataset.label.startsWith('_') && it.raw != null },
      },
    },
  });
  $('#airModelNote').innerHTML = `แถบสีม่วงอ่อน = ช่วงความเชื่อมั่นประมาณ 80% · แบบจำลองฝึกจากค่าตรวจวัดจริงของสถานี${s.name} ย้อนหลัง 14 วัน ` +
    'ร่วมกับองค์ประกอบมลพิษจาก CAMS (PM2.5, CO, NO₂, AOD) และตัวแปรอุตุนิยมวิทยา (ความสูงชั้นผสมอากาศ, ลม, ความชื้น, ฝน, อุณหภูมิ)';

  // ---------- กราฟปัจจัย ----------
  const f = drivers.map(([g, c]) => ({ g, v: pct(c) })).sort((a, b) => b.v - a.v);
  makeChart('airFactorChart', {
    type: 'bar',
    data: {
      labels: f.map(x => label(x.g)),
      datasets: [{ label: 'ผลต่อ PM2.5 (%)', data: f.map(x => x.v), backgroundColor: f.map(x => (x.v >= 0 ? '#ef4444' : '#22c55e')), borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y',
      interaction: { mode: 'nearest', axis: 'y', intersect: false },
      scales: { x: { title: { display: true, text: '% เทียบกับสภาพเฉลี่ย' } }, y: { ticks: { font: { size: 11 } } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.raw >= 0 ? '+' : ''}${fmt(c.raw, 1)}%` } } },
    },
  });

  renderAirComponents(M);
}

function renderAirComponents(M) {
  const rows = [...M.rows.filter(r => r.key <= M.nowKey).slice(-48), ...M.future];
  const nowIdx = M.rows.filter(r => r.key <= M.nowKey).slice(-48).length - 1;
  // x = ตัวแปรที่แปลงแล้ว → แปลงกลับเพื่อแสดงค่าจริง
  const comps = [
    { name: 'PM2.5 (CAMS)', unit: 'µg/m³', color: '#a855f7', get: r => r.cams },
    { name: 'CO', unit: 'µg/m³', color: '#f97316', get: r => Math.exp(r.x[1]) },
    { name: 'NO₂', unit: 'µg/m³', color: '#ef4444', get: r => Math.exp(r.x[2]) - 1 },
    { name: 'AOD', unit: '', color: '#eab308', get: r => r.x[3] },
    { name: 'ความสูงชั้นผสมอากาศ', unit: 'ม.', color: '#0ea5e9', get: r => Math.exp(r.x[4]) - 10 },
    { name: 'ความเร็วลม', unit: 'กม./ชม.', color: '#14b8a6', get: r => r.x[5] },
  ];
  $('#airComponents').innerHTML = comps.map((c, i) =>
    `<div class="spark"><div class="s-h"><span>${c.name}</span><b style="color:${c.color}">${fmt(c.get(rows[nowIdx]), c.unit ? 0 : 2)} ${c.unit}</b></div><div class="s-c"><canvas id="airSpark${i}"></canvas></div></div>`).join('');
  comps.forEach((c, i) => makeChart('airSpark' + i, {
    type: 'line',
    data: { labels: rows.map(r => `${dayLabel(r.t)} ${r.t.slice(11)}`), datasets: [{ data: rows.map(c.get), borderColor: c.color, backgroundColor: c.color + '22', fill: true, pointRadius: 0, borderWidth: 1.5, tension: .3 }] },
    options: {
      scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
      plugins: { legend: { display: false }, nowLine: { index: nowIdx, label: ' ' }, tooltip: { callbacks: { label: t => `${fmt(t.raw, c.unit ? 1 : 2)} ${c.unit}` } } },
    },
  }));
}

/* ---------- เทียบกับ WAQI ---------- */

async function renderWaqiCompare(s) {
  const box = $('#airWaqi');
  box.innerHTML = '<h3>เทียบกับ WAQI (aqicn.org)</h3><div class="skeleton">กำลังโหลด…</div>';
  try {
    const d = await waqiFeed(`geo:${s.lat};${s.lon}`);
    if (state.airStationId !== s.id) return;
    const lvl = usLevel(+d.aqi || 0);
    const fc = d.forecast?.daily?.pm25 || [];
    box.innerHTML = `<h3>เทียบกับ WAQI (aqicn.org) <span class="muted">— สถานีใกล้เคียง, มาตรฐาน US AQI</span></h3>
      <div class="waqi-grid">
        <div>
          <div class="ring-wrap" style="display:flex;gap:14px;align-items:center">
            ${aqiRing(+d.aqi || null, lvl, 300)}
            <div>
              <div class="st-name"><b>${d.city?.name || ''}</b></div>
              <span class="badge" style="background:${lvl.color};color:${lvl.text}">${lvl.name}</span>
              <div class="muted" style="font-size:.82rem">มลพิษหลัก ${(d.dominentpol || '').toUpperCase()} · ${d.time?.s || ''}<br>ห่างจากสถานีที่เลือก ${fmt(haversine(s.lat, s.lon, d.city.geo[0], d.city.geo[1]), 1)} กม.</div>
            </div>
          </div>
          <div class="iaqi">${Object.entries(d.iaqi || {}).filter(([k]) => IAQI_NAMES[k]).map(([k, v]) => `<span>${IAQI_NAMES[k]} <b>${fmt(v.v, 1)}</b></span>`).join('')}</div>
          <p class="hint">หมายเหตุ: US AQI ใช้เกณฑ์เข้มกว่า AQI ไทย ค่าตัวเลขจึงมักสูงกว่า · ${(d.attributions || []).map(a => a.name).join(' · ')}</p>
        </div>
        <div>
          <b>พยากรณ์ PM2.5 รายวันของ WAQI (US AQI)</b>
          <div class="chart-box" style="height:200px"><canvas id="waqiChart"></canvas></div>
        </div>
      </div>`;
    if (fc.length) {
      makeChart('waqiChart', {
        type: 'bar',
        data: {
          labels: fc.map(x => dayLabel(x.day)),
          datasets: [
            { label: 'เฉลี่ย', data: fc.map(x => x.avg), backgroundColor: fc.map(x => usLevel(x.avg).color), borderRadius: 4 },
            { type: 'line', label: 'สูงสุด', data: fc.map(x => x.max), borderColor: '#94a3b8', borderDash: [4, 3], pointRadius: 2 },
          ],
        },
        options: { scales: { y: { beginAtZero: true, title: { display: true, text: 'US AQI' } } }, plugins: { nowLine: { index: fc.findIndex(x => x.day === hourKey(nowAt(BKK_OFFSET)).slice(0, 10)), label: 'วันนี้' } } },
      });
    }
  } catch (e) {
    box.innerHTML = `<h3>เทียบกับ WAQI</h3><p class="muted">โหลดข้อมูล WAQI ไม่สำเร็จ: ${e.message}</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* ไฟป่า / จุดความร้อน                                                  */
/*   GISTDA (สทอภ.) : จุดความร้อน VIIRS ในไทย พร้อมจังหวัด/อำเภอ/ตำบล/      */
/*                    ประเภทการใช้ที่ดิน + พื้นที่เผาไหม้ (burn scar)         */
/*   NASA FIRMS     : จุดความร้อนประเทศเพื่อนบ้าน + ข้อมูลย้อนหลังตั้งแต่ปี 2000 */
/* ------------------------------------------------------------------ */

// คีย์ของผู้ใช้ (ใช้ฝั่งเบราว์เซอร์ จึงมองเห็นได้ใน source ของหน้าเว็บ)
const FIRMS_KEY = '32b4fb7e858c7b910f8810ae7b5b193e';
const GISTDA_KEY = 'iJlWI41aCyhpJYQlJGBLz99HXLVNjfjc3O2f7svqOuyR8vu9FqceSossTbiKuzjx';
const GISTDA_BASE = 'https://api-gateway.gistda.or.th/api/2.0/resources/features/';
const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/';
const FIRE_REGION = [92, 5, 110, 24.5]; // west,south,east,north — ไทยและประเทศเพื่อนบ้าน
const GISTDA_MAX = 6000; // ข้อมูล GISTDA ~1.6 KB/จุด และไม่บีบอัด จึงจำกัดจำนวนที่ดาวน์โหลด

const COUNTRIES = {
  764: { code: 'TH', name: 'ไทย', color: '#f97316' },
  104: { code: 'MM', name: 'เมียนมา', color: '#dc2626' },
  418: { code: 'LA', name: 'ลาว', color: '#db2777' },
  116: { code: 'KH', name: 'กัมพูชา', color: '#7c3aed' },
  704: { code: 'VN', name: 'เวียดนาม', color: '#0891b2' },
  458: { code: 'MY', name: 'มาเลเซีย', color: '#64748b' },
};
const OTHER_COUNTRY = { code: 'XX', name: 'อื่น ๆ (จีนตอนใต้/ทะเล)', color: '#94a3b8' };
const countryByCode = c => Object.values(COUNTRIES).find(x => x.code === c) || OTHER_COUNTRY;

const LANDUSE = {
  'ป่าอนุรักษ์': '#166534',
  'ป่าสงวนแห่งชาติ': '#65a30d',
  'เขต สปก.': '#ca8a04',
  'พื้นที่เกษตร': '#f97316',
  'ชุมชนและอื่น ๆ': '#a855f7',
  'พื้นที่ริมทางหลวง': '#64748b',
};
const luColor = lu => LANDUSE[lu] || '#94a3b8';
const isForest = lu => lu === 'ป่าอนุรักษ์' || lu === 'ป่าสงวนแห่งชาติ';
const frpColor = f => (f >= 50 ? '#7f1d1d' : f >= 15 ? '#ef4444' : f >= 5 ? '#fb923c' : '#fde047');
const ageColor = h => (h < 6 ? '#dc2626' : h < 24 ? '#f97316' : h < 72 ? '#facc15' : '#a3a3a3');

const TH_PROVINCES = ['กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี', 'ฉะเชิงเทรา', 'ชลบุรี', 'ชัยนาท',
  'ชัยภูมิ', 'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด', 'ตาก', 'นครนายก', 'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช',
  'นครสวรรค์', 'นนทบุรี', 'นราธิวาส', 'น่าน', 'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี',
  'พระนครศรีอยุธยา', 'พะเยา', 'พังงา', 'พัทลุง', 'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่', 'ภูเก็ต', 'มหาสารคาม',
  'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง', 'ระยอง', 'ราชบุรี', 'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ',
  'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ', 'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย', 'สุพรรณบุรี',
  'สุราษฎร์ธานี', 'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ', 'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี', 'อุบลราชธานี'];

/** ทิศทาง (องศา) จากจุด 1 ไปจุด 2 */
function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
/** จุดปลายจากจุดตั้งต้น ทิศ brg ระยะ km (ใช้วาดเซกเตอร์ต้นลม) */
function destPoint(lat, lon, brg, km) {
  const r = Math.PI / 180, d = km / 6371, b = brg * r, la = lat * r, lo = lon * r;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 / r, lo2 / r];
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const TH_DIRS = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
const dirName = deg => TH_DIRS[Math.round(deg / 45) % 8];

/* ---------- เขตแดนประเทศ (Natural Earth 1:50m) ---------- */

function loadCountries() {
  if (state.countriesPromise) return state.countriesPromise;
  state.countriesPromise = getJSON('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json', 30e3).then(topo => {
    const geoms = topo.objects.countries.geometries.filter(g => COUNTRIES[+g.id]);
    return geoms.map(g => {
      const f = topojson.feature(topo, g);
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      let [w, s, e, n] = [180, 90, -180, -90];
      polys.forEach(p => p[0].forEach(([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }));
      return { ...COUNTRIES[+g.id], feature: f, polys, bbox: [w, s, e, n] };
    });
  });
  state.countriesPromise.catch(() => { state.countriesPromise = null; });
  return state.countriesPromise;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function countryOf(countries, lat, lon) {
  for (const c of countries) {
    const [w, s, e, n] = c.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (c.polys.some(p => inRing(lon, lat, p[0]) && !p.slice(1).some(h => inRing(lon, lat, h)))) return c.code;
  }
  return 'XX';
}

/* ---------- โหลดข้อมูล ---------- */

/** จุดความร้อนในไทยจาก GISTDA (แบ่งหน้าละ 1,000 ดาวน์โหลดพร้อมกัน) */
async function loadGistdaHotspots(period) {
  const url = off => `${GISTDA_BASE}viirs/${period}?limit=1000&offset=${off}&ct_en=Thailand&api_key=${GISTDA_KEY}`;
  const first = await getJSON(url(0), 60e3);
  const total = first.numberMatched ?? first.features.length;
  const pages = [];
  for (let off = 1000; off < Math.min(total, GISTDA_MAX); off += 1000) pages.push(getJSON(url(off), 60e3));
  const rest = await Promise.all(pages);
  const feats = [first, ...rest].flatMap(p => p.features || []);
  const now = nowAt(BKK_OFFSET);
  const list = feats.map(f => {
    const p = f.properties, tt = String(p.th_time || '0000').padStart(4, '0');
    const t = parseLocal(`${(p.th_date || p.acq_date).slice(0, 10)}T${tt.slice(0, 2)}:${tt.slice(2)}`);
    return {
      lat: p.latitude, lon: p.longitude, t, ageH: (now - t) / 3600e3, country: 'TH', src: 'GISTDA',
      sat: { N: 'Suomi-NPP', N20: 'NOAA-20', N21: 'NOAA-21' }[p.satellite] || p.satellite, conf: p.confidence, frp: p.frp ?? 0,
      pv: p.pv_tn, ap: p.ap_tn, tb: p.tb_tn, village: p.village, lu: p.lu_name || 'ไม่ระบุ', crop: p.lu_hp_name,
      vDist: p.v_dist, vDir: p.v_direct,
    };
  });
  return { list, total };
}

/** แปลง CSV ของ FIRMS เป็นรายการจุด (เวลา UTC → เวลาไทย) */
function parseFirmsCsv(text, countries, now) {
  const lines = text.trim().split('\n');
  const head = lines.shift()?.split(',') || [];
  if (!head.includes('latitude')) throw new Error(text.slice(0, 120));
  const ix = k => head.indexOf(k);
  const iLat = ix('latitude'), iLon = ix('longitude'), iD = ix('acq_date'), iT = ix('acq_time'), iC = ix('confidence'),
    iF = ix('frp'), iS = ix('satellite'), iI = ix('instrument');
  return lines.map(l => {
    const c = l.split(',');
    const tt = c[iT].padStart(4, '0');
    const utc = parseLocal(`${c[iD]}T${tt.slice(0, 2)}:${tt.slice(2)}`);
    const t = new Date(utc.getTime() + BKK_OFFSET * 1000);
    const lat = +c[iLat], lon = +c[iLon];
    const conf = c[iC];
    return {
      lat, lon, t, ageH: (now - t) / 3600e3, country: countryOf(countries, lat, lon), src: 'FIRMS',
      sat: `${c[iI]} ${c[iS]}`, frp: +c[iF] || 0,
      conf: { l: 'low', n: 'nominal', h: 'high' }[conf] || (+conf >= 80 ? 'high' : +conf >= 30 ? 'nominal' : 'low'),
    };
  });
}

/** ชื่อชุดข้อมูล FIRMS: NRT (ล่าสุด ~3 เดือน) หรือ SP (ข้อมูลมาตรฐานย้อนหลัง) ตามวันที่ */
async function firmsSource(sat, startDate) {
  if (!state.firmsAvail) {
    const csv = await fetch(`${FIRMS_BASE}data_availability/csv/${FIRMS_KEY}/all`).then(r => r.text());
    state.firmsAvail = Object.fromEntries(csv.trim().split('\n').slice(1).map(l => { const [id, a, b] = l.split(','); return [id, [a, b]]; }));
  }
  const ok = id => state.firmsAvail[id] && (!startDate || (startDate >= state.firmsAvail[id][0] && startDate <= state.firmsAvail[id][1]));
  for (const id of [`${sat}_NRT`, `${sat}_SP`, 'VIIRS_SNPP_SP', 'MODIS_SP']) if (ok(id)) return id;
  throw new Error(`ไม่มีข้อมูล ${sat} สำหรับวันที่ ${startDate}`);
}

/** FIRMS area API จำกัด 1–5 วันต่อคำขอ → แบ่งช่วงเป็นก้อนละ 5 วัน (วันที่ตาม UTC) แล้วโหลดพร้อมกัน */
async function loadFirms(sat, days, startDate, countries) {
  const now = nowAt(BKK_OFFSET);
  const chunks = [];
  if (!startDate && days <= 5) chunks.push({ days, date: null });
  else {
    const start = startDate ? new Date(startDate + 'T00:00:00Z') : new Date(Date.now() - (days - 1) * 86400e3);
    for (let off = 0; off < days; off += 5) {
      const d = new Date(start.getTime() + off * 86400e3);
      chunks.push({ days: Math.min(5, days - off), date: d.toISOString().slice(0, 10) });
    }
  }
  const results = await Promise.all(chunks.map(async c => {
    const src = await firmsSource(sat, c.date);
    const url = `${FIRMS_BASE}area/csv/${FIRMS_KEY}/${src}/${FIRE_REGION.join(',')}/${c.days}${c.date ? '/' + c.date : ''}`;
    const text = await fetch(url, { signal: AbortSignal.timeout(90e3) }).then(r => r.text());
    return { list: parseFirmsCsv(text, countries, now), src };
  }));
  return { list: results.flatMap(r => r.list), src: [...new Set(results.map(r => r.src))].join(' + ') };
}

/* ---------- แท็บหลัก ---------- */

function initFireControls() {
  if (state.fireControlsBound) return;
  state.fireControlsBound = true;
  const now = nowAt(BKK_OFFSET);
  const d = new Date(now); d.setDate(d.getDate() - 2);
  $('#fireDate').value = ymdOf(d);
  $('#fireDate').max = ymdOf(now);
  $('#fireDate').min = '2000-11-01';
  $('#fireMode').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    $$('#fireMode button').forEach(x => x.classList.toggle('active', x === b));
    const archive = b.dataset.mode === 'archive';
    $('#firePeriodWrap').hidden = archive;
    $('#fireDateWrap').hidden = !archive;
    $('#fireColor').value = archive ? 'country' : 'lu';
    loadFire();
  });
  $('#fireReload').addEventListener('click', loadFire);
  ['#firePeriod', '#fireSat', '#fireNeighbors'].forEach(s => $(s).addEventListener('change', loadFire));
  $('#fireColor').addEventListener('change', () => state.fire && renderFireMap(state.fire));
  $('#fireTableFilter').addEventListener('change', () => state.fire && renderFireTable(state.fire));
  $('#fireScarBtn').addEventListener('click', loadBurnScar);
  $('#fireScarProv').innerHTML = TH_PROVINCES.map(p => `<option>${p}</option>`).join('');
}

async function loadFire() {
  initFireControls();
  const archive = $('#fireMode .active').dataset.mode === 'archive';
  const sat = $('#fireSat').value, neighbors = $('#fireNeighbors').checked;
  const token = (state.fireToken = {});
  setStatus('fireStatus', archive ? 'กำลังดึงข้อมูลย้อนหลังจาก NASA FIRMS…' : 'กำลังดึงข้อมูลจุดความร้อนจาก GISTDA และ NASA FIRMS…', 'loading');
  try {
    const countries = await loadCountries();
    let th = [], others = [], total = 0, note = [];
    if (archive) {
      const days = +$('#fireDays').value, start = $('#fireDate').value;
      const f = await loadFirms(sat, days, start, countries);
      th = f.list.filter(p => p.country === 'TH');
      others = neighbors ? f.list.filter(p => p.country !== 'TH') : [];
      total = th.length;
      const end = new Date(parseLocal(start)); end.setDate(end.getDate() + days - 1);
      note.push(`NASA FIRMS ${f.src} · ${dayLabel(start)} – ${fmtDay(end)}`);
      state.fireRange = { from: start, days };
    } else {
      const period = $('#firePeriod').value;
      const days = { '1day': 1, '3days': 3, '7days': 7, '30days': 30 }[period];
      const [g, f] = await Promise.allSettled([
        loadGistdaHotspots(period),
        neighbors ? loadFirms(sat, days, null, countries) : Promise.resolve({ list: [] }),
      ]);
      if (g.status === 'fulfilled') {
        th = g.value.list; total = g.value.total;
        note.push(`GISTDA VIIRS ${days} วัน`);
        if (total > th.length) note.push(`⚠️ แผนที่แสดง ${fmt(th.length)} จาก ${fmt(total)} จุด (เลือกช่วงเวลาสั้นลงเพื่อดูครบ)`);
      } else {
        // GISTDA ล้มเหลว → ใช้จุดในไทยจาก FIRMS แทน
        note.push(`⚠️ GISTDA ไม่ตอบสนอง (${g.reason?.message}) ใช้ข้อมูลในไทยจาก NASA FIRMS แทน`);
      }
      if (f.status === 'fulfilled') {
        if (g.status !== 'fulfilled') { th = f.value.list.filter(p => p.country === 'TH'); total = th.length; }
        others = f.value.list.filter(p => p.country !== 'TH');
        if (neighbors) note.push(`ประเทศเพื่อนบ้าน: NASA FIRMS ${f.value.src} ${days} วัน`);
      } else note.push(`⚠️ NASA FIRMS ไม่ตอบสนอง (${f.reason?.message})`);
      if (g.status !== 'fulfilled' && f.status !== 'fulfilled') throw new Error('ไม่สามารถเชื่อมต่อทั้ง GISTDA และ NASA FIRMS');
      const now = nowAt(BKK_OFFSET), from = new Date(now); from.setDate(from.getDate() - days + 1);
      state.fireRange = { from: ymdOf(from), days };
    }
    if (token !== state.fireToken) return;
    state.fire = { th, others, total, archive, countries, note };
    setStatus('fireStatus', note.join(' · '), note.some(n => n.startsWith('⚠️')) ? '' : 'loading');
    renderFire(state.fire);
  } catch (e) {
    if (token !== state.fireToken) return;
    setStatus('fireStatus', `โหลดข้อมูลจุดความร้อนไม่สำเร็จ: ${e.message}`, 'error');
  }
}

function renderFire(F) {
  renderFireTiles(F);
  renderFireMap(F);
  renderFireNear(F);
  renderFireCharts(F);
  renderFireTable(F, true);
  renderFireWeather();
  // จังหวัดเริ่มต้นสำหรับ burn scar = จังหวัดของตำแหน่งหลัก
  provinceOfLoc().then(p => { if (p && TH_PROVINCES.includes(p) && !state.scarProvTouched) $('#fireScarProv').value = p; });
}

async function provinceOfLoc() {
  const key = `${state.loc.lat},${state.loc.lon}`;
  if (state.locProvince?.key === key) return state.locProvince.name;
  try {
    const j = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${state.loc.lat}&longitude=${state.loc.lon}&localityLanguage=th`);
    const name = (j.principalSubdivision || '').replace(/^จังหวัด/, '').trim();
    state.locProvince = { key, name };
    return name;
  } catch { return null; }
}

function renderFireTiles(F) {
  const { th, others, total, archive } = F;
  const forest = th.filter(p => isForest(p.lu)).length;
  const byProv = {};
  th.forEach(p => { if (p.pv) byProv[p.pv] = (byProv[p.pv] || 0) + 1; });
  const topProv = Object.entries(byProv).sort((a, b) => b[1] - a[1])[0];
  const byCountry = {};
  others.forEach(p => { byCountry[p.country] = (byCountry[p.country] || 0) + 1; });
  const topC = Object.entries(byCountry).filter(([c]) => c !== 'XX').sort((a, b) => b[1] - a[1])[0];
  const maxF = [...th, ...others].reduce((a, b) => (b.frp > (a?.frp ?? -1) ? b : a), null);
  const last24 = th.filter(p => p.ageH <= 24).length;
  const tile = (label, value, sub, cls = '') => `<div class="tile ${cls}"><div class="t-label">${label}</div><div class="t-value">${value}</div><div class="t-sub">${sub}</div></div>`;
  $('#fireTiles').innerHTML =
    tile('🔥 จุดความร้อนในประเทศไทย', fmt(total), archive ? `${state.fireRange.days} วัน (NASA FIRMS)` : `ใน 24 ชม. ล่าสุด ${fmt(last24)} จุด`, 'fire-tile-hot') +
    (archive ? '' : tile('🌲 ในพื้นที่ป่า', fmt(forest), th.length ? `${fmt(forest / th.length * 100, 1)}% (ป่าอนุรักษ์ + ป่าสงวนแห่งชาติ)` : '–')) +
    (archive ? '' : tile('📍 จังหวัดที่พบมากที่สุด', topProv ? topProv[0] : '–', topProv ? `${fmt(topProv[1])} จุด` : 'ไม่พบจุดความร้อน')) +
    tile('🌏 ประเทศเพื่อนบ้าน', fmt(others.filter(p => p.country !== 'XX').length), topC ? `มากสุด: ${countryByCode(topC[0]).name} ${fmt(topC[1])} จุด` : 'ไม่ได้แสดง/ไม่พบ') +
    tile('💥 ไฟรุนแรงที่สุด (FRP)', maxF ? `${fmt(maxF.frp, 1)} MW` : '–', maxF ? (maxF.pv ? `จ.${maxF.pv} · ${maxF.lu}` : countryByCode(maxF.country).name) : '');
}

function fireColorOf(p, mode) {
  if (mode === 'frp') return frpColor(p.frp);
  if (mode === 'age') return ageColor(p.ageH);
  if (mode === 'country') return countryByCode(p.country).color;
  return p.src === 'GISTDA' ? luColor(p.lu) : countryByCode(p.country).color;
}

function firePopup(p) {
  const place = p.pv ? `บ้าน${p.village || '–'} ต.${p.tb} อ.${p.ap} จ.${p.pv}` : countryByCode(p.country).name;
  return `<b>🔥 ${place}</b><br>${p.t.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })} น.` +
    `${p.lu ? `<br>พื้นที่: <b style="color:${luColor(p.lu)}">${p.lu}</b>${p.crop ? ` · ${p.crop}` : ''}` : ''}` +
    `<br>FRP ${fmt(p.frp, 1)} MW · ความเชื่อมั่น ${p.conf} · ${p.sat}` +
    `${p.vDist ? `<br><small>ห่างหมู่บ้าน ${fmt(p.vDist, 2)} กม. ทิศ ${p.vDir}</small>` : ''}` +
    `<br><a href="https://www.google.com/maps?q=${p.lat},${p.lon}" target="_blank" rel="noopener">เปิดใน Google Maps</a> · <small>${p.src}</small>`;
}

function renderFireMap(F) {
  if (!state.maps.fire) {
    const map = L.map('fireMap', { preferCanvas: true, zoomSnap: 0.25 }).fitBounds([[5.6, 96], [21, 107]]);
    const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Imagery © Esri' });
    state.fireLayers = { border: L.layerGroup().addTo(map), others: L.layerGroup().addTo(map), th: L.layerGroup().addTo(map), scar: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) };
    L.control.layers({ 'แผนที่ถนน': streets, 'ภาพถ่ายดาวเทียม': sat }, {
      '🔥 จุดความร้อนในไทย': state.fireLayers.th,
      '🌏 ประเทศเพื่อนบ้าน': state.fireLayers.others,
      '🟫 พื้นที่เผาไหม้ (burn scar)': state.fireLayers.scar,
      '🧭 ทิศลม/ต้นลม': state.fireLayers.me,
    }, { collapsed: true }).addTo(map);
    state.maps.fire = map;
    // เส้นเขตแดนประเทศไทย
    F.countries.filter(c => c.code === 'TH').forEach(c =>
      L.geoJSON(c.feature, { style: { color: '#ea580c', weight: 1.5, fill: false, dashArray: '4 3' }, interactive: false }).addTo(state.fireLayers.border));
  }
  const mode = $('#fireColor').value;
  const Ly = state.fireLayers;
  Ly.th.clearLayers(); Ly.others.clearLayers();
  const draw = (p, layer) => L.circleMarker([p.lat, p.lon], {
    radius: 3 + Math.sqrt(Math.min(p.frp, 150)) * 0.55, weight: 0.6, color: '#fff',
    fillColor: fireColorOf(p, mode), fillOpacity: p.ageH > 72 && mode !== 'age' ? 0.6 : 0.9,
  }).bindPopup(() => firePopup(p)).addTo(layer);
  [...F.others].sort((a, b) => a.frp - b.frp).forEach(p => draw(p, Ly.others));
  [...F.th].sort((a, b) => a.frp - b.frp).forEach(p => draw(p, Ly.th));

  const dot = (c, t) => `<i style="background:${c}"></i>${t}`;
  let legend = '';
  if (mode === 'lu') legend = `<span><b>ประเภทพื้นที่ (ไทย):</b>${Object.entries(LANDUSE).map(([k, c]) => dot(c, k)).join('')}</span><span><b>ต่างประเทศ:</b>${Object.values(COUNTRIES).filter(c => c.code !== 'TH').map(c => dot(c.color, c.name)).join('')}</span>`;
  if (mode === 'frp') legend = `<span><b>FRP (MW):</b>${dot('#fde047', '< 5')}${dot('#fb923c', '5–15')}${dot('#ef4444', '15–50')}${dot('#7f1d1d', '≥ 50')}</span>`;
  if (mode === 'age') legend = `<span><b>ตรวจพบเมื่อ:</b>${dot('#dc2626', '< 6 ชม.')}${dot('#f97316', '6–24 ชม.')}${dot('#facc15', '1–3 วัน')}${dot('#a3a3a3', '> 3 วัน')}</span>`;
  if (mode === 'country') legend = `<span><b>ประเทศ:</b>${Object.values(COUNTRIES).map(c => dot(c.color, c.name)).join('')}${dot(OTHER_COUNTRY.color, OTHER_COUNTRY.name)}</span>`;
  $('#fireLegend').innerHTML = legend + '<span>ขนาดจุดตามความรุนแรง (FRP) · เส้นประสีส้ม = เขตแดนประเทศไทย · ลูกศรสีฟ้า = ทิศลมขณะนี้, พื้นที่สีฟ้า = ต้นลม 300 กม.</span>';
}

/** ความเสี่ยงต่อตำแหน่งหลัก: จุดใกล้ + ควันไฟที่ลมพัดพามา */
function renderFireNear(F) {
  const { lat, lon, name } = state.loc;
  $('#fireNearLoc').textContent = `(${name})`;
  const all = [...F.th, ...F.others].map(p => ({ ...p, dist: haversine(lat, lon, p.lat, p.lon), brg: bearing(lat, lon, p.lat, p.lon) }));
  const within = km => all.filter(p => p.dist <= km);
  const nearest = all.reduce((a, b) => (b.dist < (a?.dist ?? Infinity) ? b : a), null);
  const n25 = within(25).length, n50 = within(50).length, n100 = within(100).length;

  // ลมขณะนี้ (wind_direction = ทิศที่ลมพัดมา)
  const w = state.weather?.current;
  const windFrom = w?.wind_direction_10m, windSpd = w?.wind_speed_10m;
  const upwind = windFrom == null ? [] : all.filter(p => p.dist <= 300 && angDiff(p.brg, windFrom) <= 45);
  const up150 = upwind.filter(p => p.dist <= 150).length;
  const smokeLvl = up150 >= 50 ? 3 : up150 >= 10 ? 2 : up150 >= 1 ? 1 : 0;
  const nearLvl = n25 >= 10 ? 3 : n25 >= 1 ? 2 : n50 >= 1 ? 1 : 0;
  const LV = [['ต่ำ', '#16a34a'], ['ปานกลาง', '#ca8a04'], ['สูง', '#ea580c'], ['สูงมาก', '#dc2626']];
  const chip = (lv, sub) => `<div class="risk-chip" style="background:${LV[lv][1]}">${LV[lv][0]}<small>${sub}</small></div>`;

  // เข็มทิศ: ทิศลม + จุดความร้อนรอบ ๆ (รัศมี 300 กม.)
  const pts = all.filter(p => p.dist <= 300).slice(0, 400).map(p => {
    const r = 6 + (p.dist / 300) * 40, a = (p.brg - 90) * Math.PI / 180;
    return `<circle cx="${48 + r * Math.cos(a)}" cy="${48 + r * Math.sin(a)}" r="1.6" fill="#ef4444" opacity=".8"/>`;
  }).join('');
  const arrow = windFrom == null ? '' : (() => {
    const a = (windFrom + 180 - 90) * Math.PI / 180; // ลมพัดไปทิศตรงข้ามกับทิศที่มา
    const x1 = 48 - 30 * Math.cos(a), y1 = 48 - 30 * Math.sin(a), x2 = 48 + 30 * Math.cos(a), y2 = 48 + 30 * Math.sin(a);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0ea5e9" stroke-width="3" marker-end="url(#ah)"/>`;
  })();
  const compass = `<svg class="compass" viewBox="0 0 96 96">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#0ea5e9"/></marker></defs>
    <circle cx="48" cy="48" r="46" fill="var(--surface-2)" stroke="var(--border)"/><circle cx="48" cy="48" r="25" fill="none" stroke="var(--border)" stroke-dasharray="2 3"/>
    <text x="48" y="10" text-anchor="middle" font-size="9" fill="var(--muted)">N</text>${pts}${arrow}<circle cx="48" cy="48" r="3" fill="var(--text)"/></svg>`;

  $('#fireNear').innerHTML = `
    <div class="near-head">${compass}
      <div>
        <div>ลมขณะนี้: <b>${windFrom == null ? '–' : `จากทิศ${dirName(windFrom)} ${fmt(windSpd)} กม./ชม.`}</b></div>
        <div class="muted" style="font-size:.85rem">จุดแดง = จุดความร้อนรัศมี 300 กม. · ลูกศร = ทิศที่ลมพัดไป</div>
        <div style="font-size:.88rem;margin-top:4px">ใกล้ที่สุด: <b>${nearest ? `${fmt(nearest.dist, 1)} กม.` : '–'}</b>${nearest ? ` ทิศ${dirName(nearest.brg)} · ${nearest.pv ? `จ.${nearest.pv} (${nearest.lu})` : countryByCode(nearest.country).name}` : ''}</div>
      </div>
    </div>
    <div class="risk-row">${chip(nearLvl, 'ไฟใกล้ตัว')}<div>รัศมี 25 กม.: <b>${n25}</b> จุด · 50 กม.: <b>${n50}</b> จุด · 100 กม.: <b>${n100}</b> จุด
      <div class="muted" style="font-size:.82rem">${nearLvl >= 2 ? 'มีจุดความร้อนใกล้พื้นที่ ควรเฝ้าระวังไฟลุกลามและหลีกเลี่ยงการเผาในที่โล่ง' : 'ไม่พบจุดความร้อนในระยะใกล้'}</div></div></div>
    <div class="risk-row">${chip(smokeLvl, 'ควันพัดเข้า')}<div>จุดความร้อนอยู่<b>ต้นลม</b> (±45° จากทิศที่ลมพัดมา): ภายใน 150 กม. <b>${up150}</b> จุด · 300 กม. <b>${upwind.length}</b> จุด
      <div class="muted" style="font-size:.82rem">${windFrom == null ? 'ไม่มีข้อมูลลม' : smokeLvl >= 2 ? '⚠️ ลมอาจพัดพาควันและฝุ่น PM2.5 เข้าสู่พื้นที่ ดูแท็บคุณภาพอากาศประกอบ' : 'โอกาสที่ควันไฟจะถูกพัดเข้าพื้นที่ต่ำ'}</div></div></div>`;

  // ลูกศรลมและเซกเตอร์ต้นลมบนแผนที่
  const me = state.fireLayers.me;
  me.clearLayers();
  L.marker([lat, lon]).bindPopup(`<b>${name}</b>`).addTo(me);
  if (windFrom != null) {
    const sector = [[lat, lon]];
    for (let a = windFrom - 45; a <= windFrom + 45; a += 5) sector.push(destPoint(lat, lon, a, 300));
    L.polygon(sector, { color: '#0ea5e9', weight: 1, fillOpacity: 0.07, interactive: false }).addTo(me);
    L.polyline([destPoint(lat, lon, windFrom, 120), [lat, lon]], { color: '#0ea5e9', weight: 3, interactive: false }).addTo(me);
  }
}

function renderFireCharts(F) {
  const { th, others, archive } = F;
  // ---------- รายวัน ----------
  const dates = [];
  const d0 = parseLocal(state.fireRange.from);
  for (let i = 0; i < state.fireRange.days; i++) { const d = new Date(d0); d.setDate(d.getDate() + i); dates.push(ymdOf(d)); }
  const count = (list, d) => list.filter(p => ymdOf(p.t) === d).length;
  const nb = Object.values(COUNTRIES).filter(c => c.code !== 'TH');
  makeChart('fireDailyChart', {
    type: 'bar',
    data: {
      labels: dates.map(dayLabel),
      datasets: [
        { label: 'ไทย', data: dates.map(d => count(th, d)), backgroundColor: '#f97316', borderRadius: 3 },
        ...nb.map(c => ({ label: c.name, data: dates.map(d => count(others.filter(p => p.country === c.code), d)), backgroundColor: c.color + 'cc', borderRadius: 3 }))
          .filter(ds => ds.data.some(v => v > 0)),
      ],
    },
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: 'จุด' } } } },
  });

  // ---------- ประเภทพื้นที่ / ประเทศ ----------
  let luLabels, luData, luColors;
  if (archive) {
    $('#fireLuTitle').textContent = 'จุดความร้อนแยกตามประเทศ';
    const all = [...th, ...others], cs = [...Object.values(COUNTRIES), OTHER_COUNTRY].filter(c => all.some(p => p.country === c.code));
    luLabels = cs.map(c => c.name); luData = cs.map(c => all.filter(p => p.country === c.code).length); luColors = cs.map(c => c.color);
  } else {
    $('#fireLuTitle').textContent = 'จุดความร้อนในไทยตามประเภทพื้นที่ (GISTDA)';
    const m = {};
    th.forEach(p => { m[p.lu] = (m[p.lu] || 0) + 1; });
    const e = Object.entries(m).sort((a, b) => b[1] - a[1]);
    luLabels = e.map(x => x[0]); luData = e.map(x => x[1]); luColors = luLabels.map(luColor);
  }
  makeChart('fireLuChart', {
    type: 'doughnut',
    data: { labels: luLabels, datasets: [{ data: luData, backgroundColor: luColors, borderColor: cssVar('--surface'), borderWidth: 2 }] },
    options: {
      cutout: '58%',
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        legend: { position: 'right' },
        tooltip: { callbacks: { label: c => `${c.label}: ${fmt(c.raw)} จุด (${fmt(c.raw / sum(luData) * 100, 1)}%)` } },
      },
    },
  });

  // ---------- จังหวัด (ซ้อนตามประเภทพื้นที่) ----------
  if (archive || !th.some(p => p.pv)) {
    $('#fireProvTitle').textContent = 'จังหวัดที่พบจุดความร้อนมากที่สุด — ใช้ได้เฉพาะโหมดล่าสุด (ข้อมูล GISTDA มีชื่อจังหวัด)';
    state.charts.fireProvChart?.destroy();
    return;
  }
  $('#fireProvTitle').textContent = 'จังหวัดที่พบจุดความร้อนมากที่สุด (15 อันดับ)';
  const prov = {};
  th.forEach(p => { (prov[p.pv] ||= {})[p.lu] = ((prov[p.pv] ||= {})[p.lu] || 0) + 1; });
  const top = Object.entries(prov).map(([k, v]) => [k, v, sum(Object.values(v))]).sort((a, b) => b[2] - a[2]).slice(0, 15);
  const lus = Object.keys(LANDUSE).filter(lu => top.some(([, v]) => v[lu]));
  makeChart('fireProvChart', {
    type: 'bar',
    data: { labels: top.map(x => x[0]), datasets: lus.map(lu => ({ label: lu, data: top.map(([, v]) => v[lu] || 0), backgroundColor: luColor(lu), borderRadius: 2 })) },
    options: {
      indexAxis: 'y',
      interaction: { mode: 'index', axis: 'y', intersect: false },
      scales: { x: { stacked: true, title: { display: true, text: 'จุด' } }, y: { stacked: true } },
    },
  });
}

function renderFireTable(F, rebuildFilter = false) {
  const all = [...F.th, ...F.others];
  if (rebuildFilter) {
    const provs = [...new Set(F.th.map(p => p.pv).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'));
    const cs = [...new Set(F.others.map(p => p.country))];
    $('#fireTableFilter').innerHTML = '<option value="">ทั้งหมด</option>' +
      (provs.length ? `<optgroup label="จังหวัด (ไทย)">${provs.map(p => `<option value="pv:${p}">${p}</option>`).join('')}</optgroup>` : '<option value="c:TH">ไทย</option>') +
      (cs.length ? `<optgroup label="ประเทศ">${cs.map(c => `<option value="c:${c}">${countryByCode(c).name}</option>`).join('')}</optgroup>` : '');
  }
  const f = $('#fireTableFilter').value;
  const rows = all.filter(p => !f || (f.startsWith('pv:') ? p.pv === f.slice(3) : p.country === f.slice(2)))
    .sort((a, b) => b.t - a.t);
  const MAX = 400;
  $('#fireTableCount').textContent = `${fmt(rows.length)} จุด${rows.length > MAX ? ` (แสดงล่าสุด ${MAX})` : ''}`;
  const tbody = $('#fireTable tbody');
  tbody.innerHTML = rows.length ? rows.slice(0, MAX).map((p, i) => `<tr data-i="${i}">
    <td>${p.t.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</td>
    <td class="wrap">${p.pv ? `<b>จ.${p.pv}</b> อ.${p.ap}<br><small class="muted">ต.${p.tb} · บ้าน${p.village || '–'}</small>` : `<b>${countryByCode(p.country).name}</b><br><small class="muted">${fmt(p.lat, 3)}, ${fmt(p.lon, 3)}</small>`}</td>
    <td>${p.lu ? `<span class="badge" style="background:${luColor(p.lu)}">${p.lu}</span>${p.crop ? `<br><small class="muted">${p.crop}</small>` : ''}` : '–'}</td>
    <td><b style="color:${frpColor(p.frp) === '#fde047' ? '#a16207' : frpColor(p.frp)}">${fmt(p.frp, 1)}</b></td>
    <td>${{ high: 'สูง', nominal: 'ปกติ', low: 'ต่ำ' }[p.conf] || p.conf}</td>
    <td><small>${p.sat}</small></td>
    <td><a href="https://www.google.com/maps?q=${p.lat},${p.lon}" target="_blank" rel="noopener" title="Google Maps">🗺️</a></td>
  </tr>`).join('') : '<tr><td colspan="7" class="muted">ไม่พบจุดความร้อน</td></tr>';
  tbody.onclick = e => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr || e.target.closest('a')) return;
    const p = rows[+tr.dataset.i];
    $('#fireMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.maps.fire.flyTo([p.lat, p.lon], 12);
    L.popup().setLatLng([p.lat, p.lon]).setContent(firePopup(p)).openOn(state.maps.fire);
  };
}

/* ---------- ดัชนีสภาพอากาศเอื้อต่อการเกิดไฟ ---------- */

/**
 * Angström index: I = RH/20 + (27 − T)/10  (ใช้ RH ต่ำสุดและอุณหภูมิสูงสุดของวัน)
 * I < 2.0 เอื้อมาก · 2.0–2.5 เอื้อ · 2.5–4.0 ไม่เอื้อ · > 4.0 ไม่น่าเกิด
 * ร่วมกับจำนวนวันติดต่อกันที่ไม่มีฝน (< 1 มม.) — ≥ 10 วัน เพิ่มระดับความเสี่ยง 1 ขั้น
 */
async function renderFireWeather() {
  const { lat, lon } = state.loc;
  try {
    const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&daily=temperature_2m_max,relative_humidity_2m_min,wind_speed_10m_max,precipitation_sum&timezone=Asia%2FBangkok&past_days=30&forecast_days=7');
    const d = j.daily, today = hourKey(nowAt(BKK_OFFSET)).slice(0, 10);
    const i0 = Math.max(0, d.time.indexOf(today));
    let dry = 0;
    const dryArr = d.precipitation_sum.map(p => (dry = (p ?? 0) < 1 ? dry + 1 : 0));
    const LV = [['ต่ำ', '#16a34a'], ['ปานกลาง', '#ca8a04'], ['สูง', '#ea580c'], ['สูงมาก', '#dc2626']];
    const days = d.time.slice(i0, i0 + 7).map((t, k) => {
      const i = i0 + k;
      const I = d.relative_humidity_2m_min[i] / 20 + (27 - d.temperature_2m_max[i]) / 10;
      let lv = I < 2 ? 3 : I < 2.5 ? 2 : I < 4 ? 1 : 0;
      if (dryArr[i] >= 10 && lv < 3) lv += 1;
      if ((d.precipitation_sum[i] ?? 0) >= 2 && lv > 0) lv -= 1; // ฝนทำให้เชื้อเพลิงเปียก
      return { t, I, lv, dry: dryArr[i], T: d.temperature_2m_max[i], RH: d.relative_humidity_2m_min[i], W: d.wind_speed_10m_max[i], P: d.precipitation_sum[i] };
    });
    makeChart('fireWeatherChart', {
      type: 'bar',
      data: {
        labels: days.map((x, k) => (k === 0 ? 'วันนี้' : dayLabel(x.t))),
        datasets: [
          { label: 'Angström index (ต่ำ = เอื้อต่อไฟ)', data: days.map(x => x.I), backgroundColor: days.map(x => LV[x.lv][1]), borderRadius: 4, yAxisID: 'y' },
          { type: 'line', label: 'วันติดต่อกันที่ไม่มีฝน', data: days.map(x => x.dry), borderColor: '#a16207', pointRadius: 3, yAxisID: 'y1' },
        ],
      },
      options: {
        scales: {
          y: { beginAtZero: true, suggestedMax: 5, title: { display: true, text: 'Angström' } },
          y1: { position: 'right', beginAtZero: true, suggestedMax: 10, grid: { display: false }, title: { display: true, text: 'วัน' } },
        },
        plugins: {
          tooltip: { callbacks: { afterBody: it => { const x = days[it[0].dataIndex]; return `อุณหภูมิสูงสุด ${fmt(x.T, 1)}°C · ความชื้นต่ำสุด ${fmt(x.RH)}% · ลม ${fmt(x.W)} กม./ชม. · ฝน ${fmt(x.P, 1)} มม.\nความเสี่ยง: ${LV[x.lv][0]}`; } } },
        },
      },
    });
    $('#fireWeatherNote').innerHTML = `<div class="fw-days">${days.map((x, k) => `<div class="fw-day" style="background:${LV[x.lv][1]}">${LV[x.lv][0]}<small>${k === 0 ? 'วันนี้' : dayLabel(x.t)}</small></div>`).join('')}</div>
      <p class="hint">Angström index = RH/20 + (27 − T)/10 จากอุณหภูมิสูงสุดและความชื้นต่ำสุดของวัน: &lt; 2.0 เอื้อต่อไฟมาก, 2.0–2.5 เอื้อ, 2.5–4.0 ไม่ค่อยเอื้อ, &gt; 4.0 ไม่น่าเกิด · ไม่มีฝนติดต่อกัน ≥ 10 วัน เพิ่มความเสี่ยง 1 ระดับ · วันที่มีฝน ≥ 2 มม. ลด 1 ระดับ · ปัจจุบันไม่มีฝนติดต่อกัน ${days[0].dry} วัน</p>`;
  } catch (e) {
    $('#fireWeatherNote').innerHTML = `<p class="muted">โหลดข้อมูลสภาพอากาศไม่สำเร็จ: ${e.message}</p>`;
  }
}

/* ---------- พื้นที่เผาไหม้ (GISTDA burn scar) ---------- */

const SCAR_COLORS = { 'ป่าอนุรักษ์': '#166534', 'ป่าสงวนแห่งชาติ': '#65a30d', 'เขตปฏิรูปที่ดินเพื่อเกษตรกรรม': '#ca8a04', 'พื้นที่เกษตร': '#f97316', 'ชุมชนและอื่นๆ': '#a855f7', 'ริมทางหลวง 50 เมตร': '#64748b' };

async function loadBurnScar() {
  state.scarProvTouched = true;
  const pv = $('#fireScarProv').value;
  const info = $('#fireScarInfo');
  info.textContent = `กำลังโหลดพื้นที่เผาไหม้ จ.${pv}…`;
  const url = off => `${GISTDA_BASE}burn-scar?limit=1000&offset=${off}&pv_tn=${encodeURIComponent(pv)}&api_key=${GISTDA_KEY}`;
  try {
    const first = await getJSON(url(0), 90e3);
    const total = first.numberMatched ?? 0, MAX = 5000;
    const pages = [];
    for (let off = 1000; off < Math.min(total, MAX); off += 1000) pages.push(getJSON(url(off), 90e3));
    const feats = [first, ...(await Promise.all(pages))].flatMap(p => p.features || []);
    const layer = state.fireLayers.scar;
    layer.clearLayers();
    if (!feats.length) { info.textContent = `ไม่พบพื้นที่เผาไหม้ใน จ.${pv}`; return; }
    if (!state.maps.fire.hasLayer(layer)) layer.addTo(state.maps.fire);
    const gj = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
      style: f => ({ color: SCAR_COLORS[f.properties.rp_name] || '#7c2d12', weight: 0.8, fillColor: '#7c2d12', fillOpacity: 0.45 }),
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindPopup(`<b>🟫 พื้นที่เผาไหม้</b><br>ต.${p.tb_tn} อ.${p.ap_tn} จ.${p.pv_tn}<br>พื้นที่ <b>${fmt(p.area_rai, 1)} ไร่</b><br>` +
          `เขตพื้นที่: ${p.rp_name || '–'} · การใช้ที่ดิน: ${p.lu_name || '–'}<br><small>ช่วงตรวจพบ ${p.date}</small>`);
      },
    });
    // แปลงเผาไหม้ส่วนใหญ่เล็ก (~10 ไร่) มองไม่เห็นเมื่อซูมออก → แสดงเป็นจุดศูนย์กลางก่อน แล้วสลับเป็นรูปแปลงเมื่อซูม ≥ 13
    const dots = L.layerGroup(gj.getLayers().map(l => L.circleMarker(l.getBounds().getCenter(), {
      radius: 2 + Math.min(Math.sqrt(l.feature.properties.area_rai || 0) / 6, 4), weight: 0.4, color: '#fff', fillColor: '#7c2d12', fillOpacity: 0.75,
    }).bindPopup(l.getPopup())));
    const sync = () => {
      const z = state.maps.fire.getZoom();
      if (z >= 13) { layer.removeLayer(dots); layer.addLayer(gj); } else { layer.removeLayer(gj); layer.addLayer(dots); }
    };
    state.maps.fire.off('zoomend', state.scarSync);
    state.scarSync = sync;
    state.maps.fire.on('zoomend', sync);
    state.maps.fire.fitBounds(gj.getBounds(), { padding: [20, 20] });
    sync();
    const rai = sum(feats.map(f => f.properties.area_rai || 0));
    const byRp = {};
    feats.forEach(f => { const k = f.properties.rp_name || 'ไม่ระบุ'; byRp[k] = (byRp[k] || 0) + (f.properties.area_rai || 0); });
    const dates = [...new Set(feats.map(f => f.properties.date))].sort();
    info.innerHTML = `จ.${pv}: <b>${fmt(feats.length)}</b>${total > feats.length ? ` จาก ${fmt(total)}` : ''} แปลง · รวม <b>${fmt(rai)} ไร่</b> · ` +
      Object.entries(byRp).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${fmt(v / rai * 100)}%`).join(', ') +
      ` · ช่วง ${dates[0]?.slice(0, 8)}–${dates[dates.length - 1]?.slice(-8)}`;
  } catch (e) {
    info.textContent = `โหลดพื้นที่เผาไหม้ไม่สำเร็จ: ${e.message}`;
  }
}

/* ------------------------------------------------------------------ */
/* 4) แผ่นดินไหว                                                        */
/* ------------------------------------------------------------------ */

const magColor = m => (m >= 6 ? '#a21caf' : m >= 5 ? '#ef4444' : m >= 4 ? '#f97316' : m >= 3 ? '#eab308' : '#22c55e');

/** ประเมินการรับรู้แรงสั่นอย่างหยาบ: รัศมีรับรู้ได้ ≈ 10^(0.43M + 0.3) กม. */
function feltEstimate(mag, distKm) {
  if (mag < 2.5) return '–';
  const r = 10 ** (0.43 * mag + 0.3);
  if (distKm <= r * 0.25) return '<span style="color:#dc2626">รู้สึกได้ชัดเจน</span>';
  if (distKm <= r) return '<span style="color:#ea580c">อาจรู้สึกได้</span>';
  return '<span class="muted">ไม่รู้สึก</span>';
}

function initQuakeMap() {
  const map = L.map('quakeMap', { worldCopyJump: true }).setView([state.loc.lat, state.loc.lon], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  state.maps.quake = map;
  state.quakeLayer = L.layerGroup().addTo(map);
}

async function loadQuakes() {
  if (!state.maps.quake) initQuakeMap();
  setStatus('quakeStatus', 'กำลังโหลดข้อมูลแผ่นดินไหว…', 'loading');
  const { lat, lon } = state.loc;
  const days = +$('#eqDays').value, minmag = $('#eqMag').value, radius = $('#eqRadius').value;
  const start = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 19);
  let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&limit=2000&starttime=${start}&minmagnitude=${minmag}`;
  if (radius !== 'all') url += `&latitude=${lat}&longitude=${lon}&maxradiuskm=${radius}`;
  try {
    const data = await getJSON(url);
    renderQuakes(data.features, radius);
    setStatus('quakeStatus', '');
  } catch (e) {
    setStatus('quakeStatus', `โหลดข้อมูลแผ่นดินไหวไม่สำเร็จ: ${e.message}`, 'error');
  }
}

function renderQuakes(features, radius) {
  const { lat, lon } = state.loc;
  const map = state.maps.quake, layer = state.quakeLayer;
  layer.clearLayers();

  const eqs = features.map(f => {
    const [qlon, qlat, depth] = f.geometry.coordinates;
    return {
      id: f.id, mag: f.properties.mag ?? 0, place: f.properties.place || '—', time: new Date(f.properties.time),
      url: f.properties.url, tsunami: f.properties.tsunami, lat: qlat, lon: qlon, depth,
      dist: haversine(lat, lon, qlat, qlon),
    };
  });

  // ตำแหน่งผู้ใช้ + วงรัศมี
  L.marker([lat, lon], { title: state.loc.name }).addTo(layer).bindPopup(`<b>${state.loc.name}</b>`);
  if (radius !== 'all') {
    const circle = L.circle([lat, lon], { radius: radius * 1000, color: '#2563eb', weight: 1, fillOpacity: .03 }).addTo(layer);
    map.fitBounds(circle.getBounds());
  } else {
    map.setView([20, lon], 2);
  }

  const markers = {};
  [...eqs].sort((a, b) => a.mag - b.mag).forEach(q => {
    const m = L.circleMarker([q.lat, q.lon], {
      radius: 3 + Math.max(q.mag, 0) ** 1.6, color: '#fff', weight: 1, fillColor: magColor(q.mag), fillOpacity: .8,
    }).addTo(layer);
    m.bindPopup(`<b>M ${q.mag.toFixed(1)}</b> — ${q.place}<br>${q.time.toLocaleString('th-TH')}<br>ความลึก ${fmt(q.depth, 1)} กม. · ห่าง ${fmt(q.dist)} กม.` +
      `${q.tsunami ? '<br><b style="color:#dc2626">⚠️ มีการแจ้งเตือนสึนามิ</b>' : ''}<br><a href="${q.url}" target="_blank" rel="noopener">รายละเอียด USGS</a>`);
    markers[q.id] = m;
  });

  // สถิติ
  const biggest = eqs.reduce((a, b) => (b.mag > (a?.mag ?? -9) ? b : a), null);
  const nearest = eqs.reduce((a, b) => (b.dist < (a?.dist ?? Infinity) ? b : a), null);
  const felt = eqs.filter(q => q.dist <= 10 ** (0.43 * q.mag + 0.3)).length;
  const tile = (label, value, sub) => `<div class="tile"><div class="t-label">${label}</div><div class="t-value">${value}</div><div class="t-sub">${sub}</div></div>`;
  $('#quakeTiles').innerHTML =
    tile('จำนวนเหตุการณ์', fmt(eqs.length), `ช่วง ${$('#eqDays').selectedOptions[0].text} · ${$('#eqRadius').selectedOptions[0].text}`) +
    tile('ขนาดใหญ่สุด', biggest ? `M ${biggest.mag.toFixed(1)}` : '–', biggest ? biggest.place : '') +
    tile('ใกล้ที่สุด', nearest ? `${fmt(nearest.dist)} กม.` : '–', nearest ? `M ${nearest.mag.toFixed(1)} · ${nearest.place}` : '') +
    tile('อาจรู้สึกได้ที่ตำแหน่งคุณ', fmt(felt), 'เหตุการณ์ (ประเมินอย่างหยาบ)');

  // ตาราง
  const tbody = $('#quakeTable tbody');
  tbody.innerHTML = eqs.length ? eqs.slice(0, 300).map(q => `
    <tr data-id="${q.id}">
      <td>${q.time.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td><span class="mag" style="background:${magColor(q.mag)}">${q.mag.toFixed(1)}</span></td>
      <td class="wrap">${q.place}${q.tsunami ? ' ⚠️สึนามิ' : ''}</td>
      <td>${fmt(q.depth, 1)} กม.</td>
      <td>${fmt(q.dist)} กม.</td>
      <td>${feltEstimate(q.mag, q.dist)}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="muted">ไม่พบเหตุการณ์แผ่นดินไหวตามเงื่อนไข</td></tr>';
  tbody.onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const m = markers[tr.dataset.id];
    map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 6));
    m.openPopup();
    $('#quakeMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
}

/* ------------------------------------------------------------------ */
/* 5) น้ำขึ้นน้ำลง                                                      */
/* ------------------------------------------------------------------ */

function renderTidePresets() {
  const cur = state.tideLoc;
  const chips = [{ name: '📍 ตำแหน่งหลัก', lat: state.loc.lat, lon: state.loc.lon, main: true }, ...TIDE_PRESETS];
  $('#tidePresets').innerHTML = chips.map((p, i) =>
    `<button class="chip ${cur && cur.lat === p.lat && cur.lon === p.lon ? 'active' : ''}" data-i="${i}">${p.name}</button>`).join('');
  $('#tidePresets').onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const p = chips[+b.dataset.i];
    loadTide({ lat: p.lat, lon: p.lon, name: p.main ? state.loc.name : p.name });
  };
}

/** หาจุดน้ำขึ้นสูงสุด/น้ำลงต่ำสุด พร้อมประมาณค่าด้วยพาราโบลา */
function findExtremes(times, vals) {
  const out = [];
  for (let i = 1; i < vals.length - 1; i++) {
    const a = vals[i - 1], b = vals[i], c = vals[i + 1];
    if (a == null || b == null || c == null) continue;
    const isMax = b >= a && b > c, isMin = b <= a && b < c;
    if (!isMax && !isMin) continue;
    const den = a - 2 * b + c;
    const off = den ? clamp(0.5 * (a - c) / den, -0.5, 0.5) : 0;
    const val = b - 0.25 * (a - c) * off;
    out.push({ type: isMax ? 'high' : 'low', time: new Date(parseLocal(times[i]).getTime() + off * 3600e3), value: val, idx: i + off });
  }
  return out;
}

async function loadTide(loc) {
  loc = loc || state.tideLoc || { ...state.loc };
  state.tideLoc = loc;
  renderTidePresets();
  setStatus('tideStatus', `กำลังโหลดข้อมูลระดับน้ำทะเล: ${loc.name}…`, 'loading');
  try {
    const m = await getJSON(`https://marine-api.open-meteo.com/v1/marine?latitude=${loc.lat}&longitude=${loc.lon}&hourly=sea_level_height_msl&timezone=auto&past_days=1&forecast_days=7&cell_selection=sea`);
    const vals = m.hourly?.sea_level_height_msl || [];
    if (vals.filter(v => v != null).length < 24) {
      // ตำแหน่งอยู่ในแผ่นดิน → ใช้จุดชายฝั่งที่ใกล้ที่สุดแทน
      const isPreset = TIDE_PRESETS.some(p => p.lat === loc.lat && p.lon === loc.lon);
      if (!isPreset) {
        const nearest = TIDE_PRESETS.reduce((a, b) =>
          (haversine(loc.lat, loc.lon, b.lat, b.lon) < haversine(loc.lat, loc.lon, a.lat, a.lon) ? b : a));
        await loadTide(nearest);
        setStatus('tideStatus', `📍 <b>${loc.name}</b> อยู่ห่างจากทะเล จึงแสดงข้อมูลจุดชายฝั่งที่ใกล้ที่สุด: <b>${nearest.name}</b> ` +
          `(ห่าง ${fmt(haversine(loc.lat, loc.lon, nearest.lat, nearest.lon))} กม.)`);
        return;
      }
      setStatus('tideStatus', `📍 <b>${loc.name}</b> ไม่มีข้อมูลน้ำขึ้นน้ำลง — กรุณาเลือกจุดตรวจวัดอื่น`, '');
      $('#tideTiles').innerHTML = '';
      $('#tideTable tbody').innerHTML = '';
      state.charts.tideChart?.destroy();
      return;
    }
    renderTide(m, loc);
    const dist = haversine(loc.lat, loc.lon, m.latitude, m.longitude);
    setStatus('tideStatus', dist > 15 ? `ใช้ข้อมูลจากจุดกริดทะเลที่ใกล้ที่สุด (${m.latitude.toFixed(2)}, ${m.longitude.toFixed(2)}) ห่าง ${fmt(dist)} กม.` : '');
  } catch (e) {
    setStatus('tideStatus', `โหลดข้อมูลน้ำขึ้นน้ำลงไม่สำเร็จ: ${e.message}`, 'error');
  }
}

function renderTide(m, loc) {
  const times = m.hourly.time, vals = m.hourly.sea_level_height_msl;
  const now = nowAt(m.utc_offset_seconds);
  const t0 = parseLocal(times[0]).getTime();
  const nowIdx = (now.getTime() - t0) / 3600e3;
  const i0 = Math.floor(nowIdx), fr = nowIdx - i0;
  const nowVal = vals[i0] != null && vals[i0 + 1] != null ? vals[i0] + (vals[i0 + 1] - vals[i0]) * fr : vals[i0];
  const rising = vals[i0 + 1] != null && vals[i0] != null ? vals[i0 + 1] > vals[i0] : null;

  const ex = findExtremes(times, vals);
  const future = ex.filter(e => e.time > now);
  const nextHigh = future.find(e => e.type === 'high');
  const nextLow = future.find(e => e.type === 'low');

  const tile = (label, value, sub, color) =>
    `<div class="tile"><div class="t-label">${label}</div><div class="t-value" ${color ? `style="color:${color}"` : ''}>${value}</div><div class="t-sub">${sub}</div></div>`;
  $('#tideTiles').innerHTML =
    tile(`ระดับน้ำขณะนี้ · ${loc.name}`, `${fmt(nowVal, 2)} ม.`, `${fmtTime(now)} น. เวลาท้องถิ่น`) +
    tile('แนวโน้ม', rising == null ? '–' : rising ? '⬆️ น้ำกำลังขึ้น' : '⬇️ น้ำกำลังลง', '', rising ? '#0284c7' : '#b45309') +
    tile('น้ำขึ้นสูงสุดครั้งถัดไป', nextHigh ? `${fmtTime(nextHigh.time)} น.` : '–', nextHigh ? `${fmtDay(nextHigh.time)} · ${fmt(nextHigh.value, 2)} ม.` : '', '#0284c7') +
    tile('น้ำลงต่ำสุดครั้งถัดไป', nextLow ? `${fmtTime(nextLow.time)} น.` : '–', nextLow ? `${fmtDay(nextLow.time)} · ${fmt(nextLow.value, 2)} ม.` : '', '#b45309');

  const hiPts = Array(vals.length).fill(null), loPts = Array(vals.length).fill(null);
  ex.forEach(e => { const k = Math.round(e.idx); (e.type === 'high' ? hiPts : loPts)[k] = vals[k]; });

  makeChart('tideChart', {
    type: 'line',
    data: {
      labels: times.map(t => {
        const dt = parseLocal(t);
        return dt.getHours() === 0 ? [fmtTime(dt), fmtDay(dt)] : fmtTime(dt);
      }),
      datasets: [
        { label: 'ระดับน้ำทะเล (ม.)', data: vals, borderColor: '#0891b2', backgroundColor: 'rgba(8,145,178,.15)', fill: 'origin', pointRadius: 0, tension: .4, borderWidth: 2 },
        { label: 'น้ำขึ้นสูงสุด', data: hiPts, showLine: false, pointRadius: 5, pointBackgroundColor: '#0284c7', borderColor: '#0284c7' },
        { label: 'น้ำลงต่ำสุด', data: loPts, showLine: false, pointRadius: 5, pointBackgroundColor: '#d97706', borderColor: '#d97706' },
      ],
    },
    options: {
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 16 } },
        y: { title: { display: true, text: 'เมตร (MSL)' } },
      },
      plugins: { nowLine: { index: nowIdx } },
    },
  });

  // ตารางรายวัน
  const byDay = {};
  ex.forEach(e => {
    const key = `${e.time.getFullYear()}-${e.time.getMonth()}-${e.time.getDate()}`;
    (byDay[key] ||= { date: e.time, high: [], low: [] })[e.type].push(e);
  });
  const cell = (arr, cls) => arr.map(e => `<span class="${cls}">${fmtTime(e.time)} น.</span> (${fmt(e.value, 2)} ม.)`).join('<br>') || '–';
  $('#tideTable tbody').innerHTML = Object.values(byDay).map(r => {
    const hi = maxOf(r.high.map(e => e.value)), lo = r.low.length ? Math.min(...r.low.map(e => e.value)) : null;
    const range = r.high.length && r.low.length ? hi - lo : null;
    return `<tr><td>${fmtDay(r.date)}</td><td>${cell(r.high, 'tide-high')}</td><td>${cell(r.low, 'tide-low')}</td><td>${range != null ? fmt(range, 2) + ' ม.' : '–'}</td></tr>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function init() {
  renderLocBar();
  initSearch();
  initTabs();
  initPickMap();
  $('#eqReload').addEventListener('click', loadQuakes);
  ['#eqDays', '#eqMag', '#eqRadius'].forEach(s => $(s).addEventListener('change', loadQuakes));
  $('#refreshBtn').addEventListener('click', () => { state.twTime = 0; setLocation(state.loc); });
  loadThaiWater().catch(() => { /* แสดง error ในแต่ละแท็บ */ });
  loadWeatherAll().then(() => ensureTab(state.activeTab));
}

init();
