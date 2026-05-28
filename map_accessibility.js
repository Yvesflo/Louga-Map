// Unified accessibility map: switch between Euclidien (DistanceMatrix), Road network (RN / QNEAT3), and LCP (AccessMod).

const BANDS = [
  { label: '0 – 2 km',   min: 0,  max: 2,   color: '#ffffb2' },
  { label: '2 – 4 km',   min: 2,  max: 4,   color: '#74c476' },
  { label: '4 – 6 km',   min: 4,  max: 6,   color: '#41b6c4' },
  { label: '6 – 8 km',   min: 6,  max: 8,   color: '#2171b5' },
  { label: '8 – 10 km',  min: 8,  max: 10,  color: '#08306b' },
  { label: '> 10 km', min: 10, max: 1000000, color: '#440154' },
];

function getBand(distKm) {
  return BANDS.find(b => distKm >= b.min && distKm < b.max) || BANDS[BANDS.length - 1];
}

function coordsToKey(pt) {
  if (!pt || pt.length < 2) return null;
  return `${pt[0]},${pt[1]}`;
}

// ── MAP INIT ───────────────────────────────────────────────────────────────
const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
const map = L.map('map', {
  center: [15.55, -15.8],
  zoom: 9,
  zoomAnimation: true,
  tap: isTouch,
  touchZoom: true,
  scrollWheelZoom: true,
  dragging: true
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors', maxZoom: 19,
}).addTo(map);

L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 150 }).addTo(map);

// ── NORTH ARROW ────────────────────────────────────────────────────────────
const NorthArrow = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'north-arrow');
    div.innerHTML = `
      <svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="bgGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stop-color="#ffffff" stop-opacity="1"/>
            <stop offset="100%" stop-color="#dce8f0" stop-opacity="1"/>
          </radialGradient>
          <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.25"/>
          </filter>
        </defs>
        <circle cx="30" cy="30" r="28" fill="url(#bgGrad)" stroke="#1E5A7A" stroke-width="1.5" filter="url(#shadow)"/>
        <line x1="30" y1="4"  x2="30" y2="9"  stroke="#1E5A7A" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="30" y1="51" x2="30" y2="56" stroke="#999" stroke-width="1" stroke-linecap="round"/>
        <line x1="4"  y1="30" x2="9"  y2="30" stroke="#999" stroke-width="1" stroke-linecap="round"/>
        <line x1="51" y1="30" x2="56" y2="30" stroke="#999" stroke-width="1" stroke-linecap="round"/>
        <polygon points="30,8 34,30 30,26 26,30" fill="#1E5A7A" stroke="#fff" stroke-width="0.8"/>
        <polygon points="30,52 34,30 30,34 26,30" fill="#b0c8d8" stroke="#fff" stroke-width="0.8"/>
        <circle cx="30" cy="30" r="3" fill="#1E5A7A" stroke="#fff" stroke-width="1"/>
        <text x="30" y="20.5" text-anchor="middle" font-size="8" font-weight="bold" fill="#1E5A7A" font-family="Arial, sans-serif" letter-spacing="0.5">N</text>
      </svg>`;
    div.title = 'North';
    return div;
  }
});
new NorthArrow().addTo(map);

// ── LAYER GROUPS ───────────────────────────────────────────────────────────
const bufferLayer = L.layerGroup().addTo(map);
const uncoveredLayer = L.layerGroup();
const centresLayer = L.layerGroup().addTo(map);
const boundaryLayer = L.layerGroup().addTo(map);

// ── UI/STATE ──────────────────────────────────────────────────────────────
let activeFilter = 10;
let activeBands = new Set(BANDS.map((_, i) => i));

let allBuffer = [];
let allUncovered = [];
let searchData = [];
let chart = null;
let currentView = 'euclid';

const VIEW_CONFIG = {
  euclid: {
    label: 'Euclidien Distance Matrix',
    matrixUrl: 'Layers/DistanceMatrix_Louga.geojson',
  },
  rn: {
    label: 'Road network distance (QNEAT3)',
    matrixUrl: 'Layers/RN_DistanceMatrix_Louga.geojson',
  },
  lcp: {
    label: 'LCP distance (AccessMod)',
    matrixUrl: 'Layers/LCP_DistanceMatrix_Louga.geojson',
  }
};

function setLoading(on) {
  // minimal: change document title
  document.title = on ? 'Loading…' : 'Accessibility to nearest health centre – Louga, 2023';
}

// ── CENTRES + BOUNDARY (same for all views) ───────────────────────────────
function loadStaticLayers({ boundary, centres }) {
  boundaryLayer.clearLayers();
  boundaryGeo = L.geoJSON(boundary, {
    style: { color: '#1E5A7A', weight: 2, fillColor: '#e8f4f8', fillOpacity: 0.15, dashArray: '5 5' }
  }).addTo(boundaryLayer);

  // Do NOT call fitBounds on view toggle: preserve user's zoom/position.




  centresLayer.clearLayers();
  centres.features.forEach(f => {
    const p = f.properties || {};
    const lngLat = f.geometry?.coordinates;

    if (!lngLat) return;
    const [lng, lat] = lngLat;
    const name = p.Name || p.NAME || p.NOM || 'Centre de santé';
    const district = p.DISTRICT || '';

    const pulseIcon = L.divIcon({
      className: '',
      html: `<div class="pulse-dot"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });

    L.marker([lat, lng], { icon: pulseIcon })
      .bindPopup(`
        <div class="popup-header" style="background:#e53e3e">🏥 ${name}</div>
        <div class="popup-body">
          <b>District:</b> ${district || 'N/A'}<br>
          <b>Type:</b> Centre de Santé (CS)<br>
          <b>Région:</b> Louga
        </div>`, { maxWidth: 220 })
      .addTo(centresLayer);
  });

  document.getElementById('s-centres').textContent = centres.features.length;
}

// Extract two points from MultiPoint when available.
// For Euclid/RN it should be consistent; for LCP it may be MultiPoint(1).
function extractCentreAndVillageFromFeature(feature, centreCoordKeys) {
  if (!feature?.geometry || feature.geometry.type !== 'MultiPoint') return null;
  const cs = feature.geometry.coordinates;
  if (!Array.isArray(cs) || cs.length < 1) return null;

  if (cs.length >= 2) {
    const k0 = coordsToKey(cs[0]);
    const k1 = coordsToKey(cs[1]);

    // decide which one is centre based on matching against health centre coords
    if (k0 && centreCoordKeys.has(k0)) return { centre: cs[0], village: cs[1] };
    if (k1 && centreCoordKeys.has(k1)) return { centre: cs[1], village: cs[0] };

    // fallback to first/second order
    return { centre: cs[0], village: cs[1] };
  }

  // only one point: best-effort, treat it as village
  return { centre: null, village: cs[0] };
}

function renderBufferVillages() {
  bufferLayer.clearLayers();
  if (!allBuffer.length) return;

  allBuffer.forEach(v => {
    const bi = BANDS.indexOf(v.band);
    if (!activeBands.has(bi) || v.distKm > activeFilter) return;

    const marker = L.circleMarker([v.lat, v.lng], {
      radius: 6,
      fillColor: v.band.color,
      color: '#fff',
      weight: 0.8,
      fillOpacity: 0.9,
    });

    if (!isTouch) {
      marker.on('mouseover', function () {
        this.setStyle({ radius: 9, weight: 1.5 });
        this.bindTooltip(`<b>${v.village}</b><br>📍 ${v.distKm.toFixed(1)} km → ${v.centre || 'Centre inconnu'}`,
          { sticky: true, offset: [10, -5] }).openTooltip();
      });

      marker.on('mouseout', function () {
        this.setStyle({ radius: 6, weight: 0.8 });
        this.closeTooltip();
      });
    }

    marker.on('click', function () {
      marker.bindPopup(`
        <div class="popup-header">📍 ${v.village}</div>
        <div class="popup-body">
          <b>Nearest centre:</b><br>${v.centre || 'N/A'}<br>
          <b>Distance:</b> ${v.distKm.toFixed(1)} km<br>
          <span class="popup-badge" style="background:${v.band.color};color:${v.distKm<3?'#333':'#fff'}">
            ${v.band.label}</span>
        </div>`, { maxWidth: 240 }).openPopup();
    });

    bufferLayer.addLayer(marker);
  });

  updateStats();
}

function renderUncoveredVillages() {
  uncoveredLayer.clearLayers();
  allUncovered.forEach(v => {
    const marker = L.circleMarker([v.lat, v.lng], {
      radius: 1.5,
      fillColor: '#bbb',
      color: '#bbb',
      weight: 0.2,
      fillOpacity: 0.35,
    });

    marker.on('mouseover', function () {
      this.setStyle({ radius: 4 });
      this.bindTooltip(`<b>${v.village}</b><br>⚠️ Non couvert / Uncovered`, { sticky: true, offset: [10, -5] }).openTooltip();
    });

    marker.on('mouseout', function () {
      this.setStyle({ radius: 1.5 });
      this.closeTooltip();
    });

    marker.on('click', function () {
      marker.bindPopup(`
        <div class="popup-header" style="background:#888">⚠️ ${v.village}</div>
        <div class="popup-body"><i>No health centre within current view range</i></div>`, { maxWidth: 220 }).openPopup();
    });

    uncoveredLayer.addLayer(marker);
  });
}

function buildLegend() {
  const legendEl = document.getElementById('legend');
  legendEl.innerHTML = '';
  BANDS.forEach((b, i) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<div class="dot" style="background:${b.color};border:1px solid #ccc"></div><span>${b.label}</span>`;
    item.addEventListener('click', () => {
      activeBands.has(i) ? activeBands.delete(i) : activeBands.add(i);
      item.classList.toggle('inactive');
      renderBufferVillages();
    });
    legendEl.appendChild(item);
  });
}

function buildChart() {
  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('distChart'), {
    type: 'bar',
    data: {
      labels: BANDS.map(b => b.label),
      datasets: [{
        data: BANDS.map(b => allBuffer.filter(v => v.distKm >= b.min && v.distKm < b.max).length),
        backgroundColor: BANDS.map(b => b.color),
        borderWidth: 1,
        borderColor: '#ccc',
        borderRadius: 4,
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 9 }, color: '#555' }, grid: { display: false } },
        y: { ticks: { font: { size: 9 }, color: '#555' }, grid: { color: '#eee' } },
      },
      animation: { duration: 250 },
    }
  });
}

function updateStats() {
  const visible = allBuffer.filter(v => {
    const bi = BANDS.indexOf(v.band);
    return activeBands.has(bi) && v.distKm <= activeFilter;
  });

  const avg = visible.length ? (visible.reduce((s, v) => s + v.distKm, 0) / visible.length).toFixed(1) : '--';

  document.getElementById('s-total').textContent = visible.length;
  document.getElementById('s-uncovered').textContent = allUncovered.length;
  document.getElementById('s-avg').textContent = avg;
}

function rebuildSearchIndex() {
  // Search uses current allBuffer + allUncovered.
  // For simplicity, we rebuild from allBuffer (covered villages) + villagesAll (uncovered in allUncovered).
  // During view switch we set searchData.
  // Implementation: handled in loadView().
}

function wireSearch() {
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');

  searchInput.addEventListener('input', function () {
    const q = this.value.trim().toLowerCase();
    searchResults.innerHTML = '';

    if (q.length < 2) { searchResults.style.display = 'none'; return; }

    const matches = searchData
      .filter(d =>
        (d.label || '').toLowerCase().includes(q) ||
        (d.nomreg || '').includes(q) ||
        (d.nomdep || '').includes(q) ||
        (d.nom_arro || '').includes(q) ||
        (d.nomcr || '').includes(q)
      )
      .slice(0, 8);

    if (!matches.length) { searchResults.style.display = 'none'; return; }

    matches.forEach(m => {
      const item = document.createElement('div');
      item.className = 'search-item';
      item.innerHTML = `<b>${m.label}</b><br><small>${m.type}${m.sub ? ' · ' + m.sub : ''}</small>`;
      item.addEventListener('click', () => {
        if (m.lat && m.lng) map.setView([m.lat, m.lng], 13);
        searchResults.style.display = 'none';
        searchInput.value = m.label;

        if (m.lat && m.lng) {
          const flash = L.circleMarker([m.lat, m.lng], {
            radius: 14,
            fillColor: '#f59e0b',
            color: '#fff',
            weight: 2,
            fillOpacity: 0.7,
          }).addTo(map);
          setTimeout(() => map.removeLayer(flash), 2000);
        }
      });
      searchResults.appendChild(item);
    });

    searchResults.style.display = 'block';
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#searchBox')) searchResults.style.display = 'none';
  });
}

async function loadView(viewKey) {
  currentView = viewKey;
  setLoading(true);

  // Reset dynamic state
  allBuffer = [];
  allUncovered = [];
  searchData = [];

  bufferLayer.clearLayers();
  uncoveredLayer.clearLayers();

  const cfg = VIEW_CONFIG[viewKey];

  // Load all layers required.
  const [distMatrix, villagesAll, boundary, centres] = await Promise.all([
    fetch(cfg.matrixUrl).then(r => r.json()),
    fetch('Layers/Villages_all.geojson').then(r => r.json()),
    fetch('Layers/Limites_louga.geojson').then(r => r.json()),
    fetch('Layers/Centredesante_louga.geojson').then(r => r.json()),
  ]);

  // Static draw
  loadStaticLayers({ boundary, centres });

  const centreCoordKeys = new Set();
  centres.features.forEach(f => {
    const key = coordsToKey(f.geometry?.coordinates);
    if (key) centreCoordKeys.add(key);
  });

  // covered names for uncovered computation
  const bufferedVillageNames = new Set();

  // Build covered list from distance matrix
  distMatrix.features.forEach((f, idx) => {
    try {
      if (!f.geometry?.coordinates) return;

      const p = f.properties || {};
      const villageName = p.InputID;
      const centreName = p.TargetID;
      const distM = p.Distance;

      if (!villageName) return;
      if (distM == null) return;
      if (typeof distM !== 'number' || !Number.isFinite(distM)) return;

      const distKm = distM / 1000;

      const extracted = extractCentreAndVillageFromFeature(f, centreCoordKeys);
      if (!extracted?.village) return;

      const lat = extracted.village[1];
      const lng = extracted.village[0];
      if (!lat || !lng) return;

      bufferedVillageNames.add(villageName);

      const band = getBand(distKm);
      allBuffer.push({ village: villageName, centre: centreName || null, distKm, lat, lng, band, props: p });

    } catch (e) {
      console.warn(`View ${viewKey}: buffer feature ${idx}:`, e.message);
    }
  });

  // Uncovered villages (not found in bufferedVillageNames)
  villagesAll.features.forEach((f, idx) => {
    try {
      if (!f.geometry?.coordinates) return;
      const p = f.properties || {};
      const name = p.VILLAGE || p.name || p.NAME || p.NOM || 'Unknown';
      if (!bufferedVillageNames.has(name)) {
        const lng = f.geometry.coordinates[0];
        const lat = f.geometry.coordinates[1];
        if (lat && lng) allUncovered.push({ village: name, lat, lng });
      }
    } catch (e) {
      console.warn(`View ${viewKey}: uncovered feature ${idx}:`, e.message);
    }
  });

  // Search index: include both covered and uncovered
  allBuffer.forEach(v => {
    searchData.push({
      label: v.village,
      type: 'Village couvert / Covered',
      sub: v.centre || '',
      lat: v.lat,
      lng: v.lng,
    });
  });

  villagesAll.features.forEach(f => {
    if (!f.geometry?.coordinates) return;
    const p = f.properties || {};
    const name = p.VILLAGE || p.name || p.NAME || p.NOM;
    if (!name) return;

    // Only add uncovered entries to avoid duplicates in search.
    if (bufferedVillageNames.has(name)) return;

    searchData.push({
      label: name,
      type: 'Village',
      sub: [p.NOMREG, p.NOMDEP, p.NOM_ARRO, p.NOMCR].filter(Boolean).join(' › '),
      nomreg: (p.NOMREG || '').toLowerCase(),
      nomdep: (p.NOMDEP || '').toLowerCase(),
      nom_arro: (p.NOM_ARRO || '').toLowerCase(),
      nomcr: (p.NOMCR || '').toLowerCase(),
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
    });
  });

  // Render
  buildLegend();
  buildChart();
  renderBufferVillages();
  renderUncoveredVillages();
  updateStats();

  setLoading(false);
}

// ── EVENTS ────────────────────────────────────────────────────────────────
document.querySelectorAll('input[name="view"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      loadView(radio.value);
    }
  });
});

document.getElementById('distFilter').addEventListener('input', function () {
  activeFilter = +this.value;
  document.getElementById('rangeVal').textContent = activeFilter;
  renderBufferVillages();
});

document.getElementById('tog-buffer').addEventListener('change', function () {
  this.checked ? map.addLayer(bufferLayer) : map.removeLayer(bufferLayer);
});

document.getElementById('tog-uncovered').addEventListener('change', function () {
  this.checked ? map.addLayer(uncoveredLayer) : map.removeLayer(uncoveredLayer);
});

document.getElementById('tog-boundary').addEventListener('change', function () {
  this.checked ? map.addLayer(boundaryLayer) : map.removeLayer(boundaryLayer);
});

document.getElementById('tog-centres').addEventListener('change', function () {
  this.checked ? map.addLayer(centresLayer) : map.removeLayer(centresLayer);
});

// ── EXPORTS ───────────────────────────────────────────────────────────────
async function exportPNG() {
  const btn = document.getElementById('btn-png');
  btn.disabled = true;
  btn.textContent = '⏳ Préparation...';
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', cursor: 'never' },
      preferCurrentTab: true,
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = () => { video.play(); r(); }; });
    await new Promise(r => requestAnimationFrame(r));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    stream.getTracks().forEach(t => t.stop());

    const link = document.createElement('a');
    link.download = `LougaMap_access_${currentView}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (e) {
    if (e.name !== 'AbortError') alert('Capture non supportée ou annulée : ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📷 Capture écran PNG';
  }
}
document.getElementById('btn-png').addEventListener('click', exportPNG);

function exportPDF() {
  document.getElementById('print-date').textContent = new Date().toLocaleDateString('fr-FR');
  window.print();
}
document.getElementById('btn-pdf').addEventListener('click', exportPDF);

function exportCSV() {
  const rows = [[
    'Village', 'Centre de santé le plus proche', 'Distance (km)',
    'Bande distance', 'Latitude', 'Longitude', 'Statut'
  ]];

  allBuffer.forEach(v => rows.push([
    v.village,
    v.centre || 'N/A',
    v.distKm.toFixed(3),
    v.band.label,
    v.lat.toFixed(6),
    v.lng.toFixed(6),
    'Couvert / Covered'
  ]));

  allUncovered.forEach(v => rows.push([
    v.village, '', '', '',
    v.lat.toFixed(6), v.lng.toFixed(6), 'Non couvert / Uncovered'
  ]));

  const csv = '\uFEFF' + rows
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = `LougaMap_access_${currentView}_villages.csv`;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
document.getElementById('btn-csv').addEventListener('click', exportCSV);

// ── BOOT ──────────────────────────────────────────────────────────────────
wireSearch();
loadView('euclid');

// ── ABOUT MODAL ───────────────────────────────────────────────────────────
document.getElementById('btn-about')?.addEventListener('click', async () => {
  const modal = document.getElementById('aboutModal');
  const content = document.getElementById('aboutContent');
  if (!modal || !content) return;

  // Load HTML from local file (same folder) once.
  if (!content.innerHTML.trim()) {
    try {
      const res = await fetch('about_modal.html');
      content.innerHTML = await res.text();
    } catch (e) {
      content.innerHTML = '<div style="color:#b00020;">Unable to load About content.</div>';
    }
  }

  modal.style.display = 'block';
});

document.getElementById('btn-close-about')?.addEventListener('click', () => {
  const modal = document.getElementById('aboutModal');
  if (modal) modal.style.display = 'none';
});

document.getElementById('aboutModal')?.addEventListener('click', e => {
  if (e.target && e.target.id === 'aboutModal') {
    e.currentTarget.style.display = 'none';
  }
});


