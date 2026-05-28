// ── DISTANCE BANDS ───────────────────────────────────────────────────────────
const BANDS = [
  { label: '0 – 2 km',   min: 0,  max: 2,   color: '#f2dc1d' },
  { label: '2 – 4 km',   min: 2,  max: 4,   color: '#7ad151' },
  { label: '4 – 6 km',   min: 4,  max: 6,   color: '#23a884' },
  { label: '6 – 8 km',   min: 6,  max: 8,   color: '#2a788e' },
  { label: '8 – 10 km',  min: 8,  max: 10,  color: '#414387' },
  { label: '10 – 100 km', min: 10, max: 100, color: '#440154' },
];

function getBand(distKm) {
  return BANDS.find(b => distKm >= b.min && distKm < b.max) || BANDS[BANDS.length - 1];
}

// ── MAP INIT ──────────────────────────────────────────────────────────────────
const map = L.map('map', { center: [15.55, -15.8], zoom: 9, zoomAnimation: true });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors', maxZoom: 19,
}).addTo(map);

L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 150 }).addTo(map);

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
        <line x1="30" y1="51" x2="30" y2="56" stroke="#999"    stroke-width="1"   stroke-linecap="round"/>
        <line x1="4"  y1="30" x2="9"  y2="30" stroke="#999"    stroke-width="1"   stroke-linecap="round"/>
        <line x1="51" y1="30" x2="56" y2="30" stroke="#999"    stroke-width="1"   stroke-linecap="round"/>
        <polygon points="30,8 34,30 30,26 26,30" fill="#1E5A7A" stroke="#fff" stroke-width="0.8"/>
        <polygon points="30,52 34,30 30,34 26,30" fill="#b0c8d8" stroke="#fff" stroke-width="0.8"/>
        <circle cx="30" cy="30" r="3" fill="#1E5A7A" stroke="#fff" stroke-width="1"/>
        <text x="30" y="20.5" text-anchor="middle" font-size="8" font-weight="bold"
              fill="#1E5A7A" font-family="Arial, sans-serif" letter-spacing="0.5">N</text>
      </svg>`;
    div.title = 'North';
    return div;
  }
});
new NorthArrow().addTo(map);

// ── LAYER GROUPS ──────────────────────────────────────────────────────────────
const bufferLayer    = L.layerGroup().addTo(map);
const uncoveredLayer = L.layerGroup();
const centresLayer   = L.layerGroup().addTo(map);
const boundaryLayer  = L.layerGroup().addTo(map);

// ── STATE ─────────────────────────────────────────────────────────────────────
let activeFilter = 100;
let activeBands  = new Set(BANDS.map((_, i) => i));
let allBuffer    = [];
let allUncovered = [];
let searchData   = [];
let chart        = null;

// ── LOAD GEOJSON (RN technique only) ──────────────────────────────────────────
Promise.all([
  fetch('layers/RN_DistanceMatrix_Louga.geojson').then(r => r.json()),
  fetch('layers/Villages_all.geojson').then(r => r.json()),
  fetch('layers/Limites_louga.geojson').then(r => r.json()),
  fetch('layers/Centredesante_louga.geojson').then(r => r.json()),
])
.then(([distMatrix, villagesAll, boundary, centres]) => {
  // 1. Boundary
  const boundaryGeo = L.geoJSON(boundary, {
    style: { color: '#1E5A7A', weight: 2, fillColor: '#e8f4f8', fillOpacity: 0.15, dashArray: '5 5' }
  }).addTo(boundaryLayer);
  map.fitBounds(boundaryGeo.getBounds(), { padding: [20, 20] });

  // 2. Buffer villages from MultiPoint matrix
  const centreCoordKeys = new Set();
  centres.features.forEach(f => {
    if (!f.geometry?.coordinates) return;
    const [cx, cy] = f.geometry.coordinates;
    centreCoordKeys.add(`${cx},${cy}`);
  });

  const bufferedNames = new Set();

  distMatrix.features.forEach((f, idx) => {
    try {
      if (!f.geometry?.coordinates) return;
      const { InputID: village, TargetID: centre, Distance: distM } = f.properties;
      if (!village || !distM) return;

      const distKm = distM / 1000;
      bufferedNames.add(village);

      const c0 = f.geometry.coordinates[0];
      const c1 = f.geometry.coordinates[1];
      const key0 = `${c0[0]},${c0[1]}`;
      const key1 = `${c1[0]},${c1[1]}`;

      let lat, lng;
      if (centreCoordKeys.has(key0)) {
        lat = c1[1]; lng = c1[0];
      } else if (centreCoordKeys.has(key1)) {
        lat = c0[1]; lng = c0[0];
      } else {
        lat = c0[1]; lng = c0[0];
      }
      if (!lat || !lng) return;

      const band = getBand(distKm);
      allBuffer.push({ village, centre, distKm, lat, lng, band, props: f.properties });
    } catch (e) {
      console.warn(`Buffer feature ${idx}:`, e.message);
    }
  });

  // 3. Uncovered villages
  villagesAll.features.forEach((f, idx) => {
    try {
      if (!f.geometry?.coordinates) return;
      const p = f.properties;
      const name = p.VILLAGE || p.name || p.NAME || p.NOM || 'Unknown';
      if (!bufferedNames.has(name)) {
        const lng = f.geometry.coordinates[0];
        const lat = f.geometry.coordinates[1];
        if (lat && lng) allUncovered.push({ village: name, lat, lng });
      }
    } catch (e) {
      console.warn(`Uncovered feature ${idx}:`, e.message);
    }
  });

  // 4. Centres
  centres.features.forEach(f => {
    try {
      if (!f.geometry?.coordinates) return;
      const p = f.properties;
      const name = p.Name || p.NAME || p.NOM || 'Centre de santé';
      const district = p.DISTRICT || '';
      const lng = f.geometry.coordinates[0];
      const lat = f.geometry.coordinates[1];
      if (!lat || !lng) return;

      const pulseIcon = L.divIcon({
        className: '',
        html: `<div class="pulse-dot"></div>`,
        iconSize: [12, 12], iconAnchor: [6, 6],
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
    } catch (e) {
      console.warn('Centre error:', e.message);
    }
  });

  document.getElementById('s-centres').textContent = centres.features.length;

  // 5. Search index
  distMatrix.features.forEach(f => {
    if (!f.geometry?.coordinates) return;
    const p = f.properties;
    if (!p.InputID) return;
    const c0 = f.geometry.coordinates[0];
    searchData.push({
      label: p.InputID,
      type:  'Village couvert / Covered',
      sub:   p.TargetID || '',
      lat:   c0[1],
      lng:   c0[0],
    });
  });

  villagesAll.features.forEach(f => {
    if (!f.geometry?.coordinates) return;
    const p = f.properties;
    const name = p.VILLAGE || p.name || p.NAME || p.NOM;
    if (!name) return;
    searchData.push({
      label:   name,
      type:    'Village',
      sub:     [p.NOMREG, p.NOMDEP, p.NOM_ARRO, p.NOMCR].filter(Boolean).join(' › '),
      nomreg:  (p.NOMREG  || '').toLowerCase(),
      nomdep:  (p.NOMDEP  || '').toLowerCase(),
      nom_arro:(p.NOM_ARRO|| '').toLowerCase(),
      nomcr:   (p.NOMCR   || '').toLowerCase(),
      lat:     f.geometry.coordinates[1],
      lng:     f.geometry.coordinates[0],
    });
  });

  // 6. Render
  renderBufferVillages();
  renderUncoveredVillages();
  buildLegend();
  buildChart();
  updateStats();
})
.catch(err => {
  console.error('Error loading GeoJSON files:', err);
  alert('Error loading data. Make sure Live Server is running and files are in the layers/ folder.');
});

function renderBufferVillages() {
  bufferLayer.clearLayers();
  allBuffer.forEach(v => {
    const bi = BANDS.indexOf(v.band);
    if (!activeBands.has(bi) || v.distKm > activeFilter) return;

    const marker = L.circleMarker([v.lat, v.lng], {
      radius: 6, fillColor: v.band.color, color: '#fff', weight: 0.8, fillOpacity: 0.9,
    });

    marker.on('mouseover', function () {
      this.setStyle({ radius: 9, weight: 1.5 });
      this.bindTooltip(`<b>${v.village}</b><br>📍 ${v.distKm.toFixed(1)} km → ${v.centre}`,
        { sticky: true, offset: [10, -5] }).openTooltip();
    });

    marker.on('mouseout', function () {
      this.setStyle({ radius: 6, weight: 0.8 });
      this.closeTooltip();
    });

    marker.on('click', function () {
      marker.bindPopup(`
        <div class="popup-header">📍 ${v.village}</div>
        <div class="popup-body">
          <b>Nearest centre:</b><br>${v.centre}<br>
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
      radius: 1.5, fillColor: '#bbb', color: '#bbb', weight: 0.2, fillOpacity: 0.35,
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
          <div class="popup-body"><i>No health centre within 100 km</i></div>`,
        { maxWidth: 220 }).openPopup();
    });

    uncoveredLayer.addLayer(marker);
  });
}

// Search UI
const searchInput   = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

searchInput.addEventListener('input', function () {
  const q = this.value.trim().toLowerCase();
  searchResults.innerHTML = '';
  if (q.length < 2) { searchResults.style.display = 'none'; return; }

  const matches = searchData.filter(d =>
    d.label.toLowerCase().includes(q) ||
    (d.nomreg   || '').includes(q) ||
    (d.nomdep   || '').includes(q) ||
    (d.nom_arro || '').includes(q) ||
    (d.nomcr    || '').includes(q)
  ).slice(0, 8);

  if (!matches.length) { searchResults.style.display = 'none'; return; }

  matches.forEach(m => {
    const item = document.createElement('div');
    item.className = 'search-item';
    item.innerHTML = `<b>${m.label}</b><br><small>${m.type}${m.sub ? ' · ' + m.sub : ''}</small>`;
    item.addEventListener('click', () => {
      map.setView([m.lat, m.lng], 13);
      searchResults.style.display = 'none';
      searchInput.value = m.label;

      const flash = L.circleMarker([m.lat, m.lng], {
        radius: 14, fillColor: '#f59e0b', color: '#fff', weight: 2, fillOpacity: 0.7,
      }).addTo(map);

      setTimeout(() => map.removeLayer(flash), 2000);
    });
    searchResults.appendChild(item);
  });

  searchResults.style.display = 'block';
});

document.addEventListener('click', e => {
  if (!e.target.closest('#searchBox')) searchResults.style.display = 'none';
});

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
  chart = new Chart(document.getElementById('distChart'), {
    type: 'bar',
    data: {
      labels: BANDS.map(b => b.label),
      datasets: [{
        data: BANDS.map(b => allBuffer.filter(v => v.distKm >= b.min && v.distKm < b.max).length),
        backgroundColor: BANDS.map(b => b.color),
        borderWidth: 1,
        borderColor: '#ccc',
        borderRadius: 4
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 9 }, color: '#555' }, grid: { display: false } },
        y: { ticks: { font: { size: 9 }, color: '#555' }, grid: { color: '#eee' } },
      },
      animation: { duration: 400 },
    }
  });
}

function updateStats() {
  const visible = allBuffer.filter(v => activeBands.has(BANDS.indexOf(v.band)) && v.distKm <= activeFilter);
  const avg = visible.length ? (visible.reduce((s, v) => s + v.distKm, 0) / visible.length).toFixed(1) : '--';

  document.getElementById('s-total').textContent     = visible.length;
  document.getElementById('s-uncovered').textContent = allUncovered.length;
  document.getElementById('s-avg').textContent       = avg;
}

// Slider and layer toggles

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

// Export PNG
async function exportPNG() {
  const btn = document.getElementById('btn-png');
  btn.disabled = true; btn.textContent = '⏳ Préparation...';
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
    link.download = 'LougaMap_RN.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (e) {
    if (e.name !== 'AbortError') alert('Capture non supportée ou annulée : ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '📷 Capture écran PNG';
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
    v.village, '', '', '', v.lat.toFixed(6), v.lng.toFixed(6), 'Non couvert / Uncovered'
  ]));

  const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = 'LougaMap_RN_villages.csv';
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

document.getElementById('btn-csv').addEventListener('click', exportCSV);

