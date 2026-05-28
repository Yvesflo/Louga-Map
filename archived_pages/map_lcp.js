// ── DISTANCE BANDS ───────────────────────────────────────────────────────────
// Inspired by map.js and RN UI; extended to support distances > 10km.
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

// ── NORTH ARROW ───────────────────────────────────────────────────────────────
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
const bufferLayer = L.layerGroup().addTo(map);
const uncoveredLayer = L.layerGroup();
const centresLayer = L.layerGroup().addTo(map);
const boundaryLayer = L.layerGroup().addTo(map);

// ── STATE ─────────────────────────────────────────────────────────────────────
let activeFilter = 100;
let activeBands = new Set(BANDS.map((_, i) => i));
let allBuffer = [];
let allUncovered = [];
let searchData = [];
let chart = null;

function coordsToKey(pt) {
  if (!pt || pt.length < 2) return null;
  return `${pt[0]},${pt[1]}`;
}

// Try to extract two points (centre + village) from the MultiPoint.
// RN files have MultiPoint(2). Some LCP files may be MultiPoint(1).
function extractCentreAndVillageFromFeature(feature, centreCoordKeys) {
  if (!feature?.geometry || feature.geometry.type !== 'MultiPoint') return null;
  const cs = feature.geometry.coordinates;
  if (!Array.isArray(cs) || cs.length < 1) return null;

  const key0 = coordsToKey(cs[0]);
  const key1 = cs.length > 1 ? coordsToKey(cs[1]) : null;

  // If we have 2 points, decide which one is centre.
  if (cs.length >= 2) {
    // centre keys match either point
    if (key0 && centreCoordKeys.has(key0)) {
      return { centre: cs[0], village: cs[1] };
    }
    if (key1 && centreCoordKeys.has(key1)) {
      return { centre: cs[1], village: cs[0] };
    }

    // fallback: keep RN-style order (point0/point1)
    return { centre: cs[0], village: cs[1] };
  }

  // If only 1 point exists: cannot infer centre/village reliably.
  // Return the only point as village and centre as null.
  // This keeps the app functional even with malformed LCP GeoJSON.
  return { centre: null, village: cs[0] };
}

// ── LOAD GEOJSON (LCP) ───────────────────────────────────────────────────────
Promise.all([
  fetch('Layers/LCP_DistanceMatrix_Louga.geojson').then(r => r.json()),
  fetch('Layers/Villages_all.geojson').then(r => r.json()),
  fetch('Layers/Limites_louga.geojson').then(r => r.json()),
  fetch('Layers/Centredesante_louga.geojson').then(r => r.json()),
])
  .then(([distMatrix, villagesAll, boundary, centres]) => {
    // 1. Boundary
    const boundaryGeo = L.geoJSON(boundary, {
      style: { color: '#1E5A7A', weight: 2, fillColor: '#e8f4f8', fillOpacity: 0.15, dashArray: '5 5' }
    }).addTo(boundaryLayer);
    map.fitBounds(boundaryGeo.getBounds(), { padding: [20, 20] });

    // 2. Build exact centre coordinate keys
    const centreCoordKeys = new Set();
    centres.features.forEach(f => {
      const c = f.geometry?.coordinates;
      const key = coordsToKey(c);
      if (key) centreCoordKeys.add(key);
    });

    // 3. Buffer villages from the distance matrix
    const bufferedVillageNames = new Set();

    distMatrix.features.forEach((f, idx) => {
      try {
        if (!f.geometry?.coordinates) return;

        const { InputID: villageName, TargetID: centreName, Distance: distM } = f.properties || {};
        if (!villageName) return;
        if (distM == null) return;
        if (typeof distM !== 'number' || !Number.isFinite(distM)) return;

        const distKm = distM / 1000;

        const extracted = extractCentreAndVillageFromFeature(f, centreCoordKeys);
        if (!extracted?.village) return;

        const villageLngLat = { lng: extracted.village[0], lat: extracted.village[1] };
        if (!villageLngLat.lat || !villageLngLat.lng) return;

        const band = getBand(distKm);

        bufferedVillageNames.add(villageName);

        allBuffer.push({
          village: villageName,
          centre: centreName || null,
          distKm,
          lat: villageLngLat.lat,
          lng: villageLngLat.lng,
          band,
          props: f.properties
        });
      } catch (e) {
        console.warn(`LCP buffer feature ${idx}:`, e.message);
      }
    });

    // 4. Uncovered villages
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
        console.warn(`LCP uncovered feature ${idx}:`, e.message);
      }
    });

    // 5. Centres layer
    centres.features.forEach((f, idx) => {
      try {
        if (!f.geometry?.coordinates) return;
        const p = f.properties || {};
        const name = p.Name || p.NAME || p.NOM || 'Centre de santé';
        const district = p.DISTRICT || '';
        const lng = f.geometry.coordinates[0];
        const lat = f.geometry.coordinates[1];
        if (!lat || !lng) return;

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
      } catch (e) {
        console.warn(`Centre ${idx}:`, e.message);
      }
    });

    document.getElementById('s-centres').textContent = centres.features.length;

    // 6. Search index (use buffered villages from matrix + uncovered villages from Villages_all)
    // Covered villages
    distMatrix.features.forEach(f => {
      if (!f.geometry?.coordinates) return;
      const p = f.properties || {};
      const label = p.InputID;
      if (!label) return;

      // Use the MultiPoint first coordinate as the best-effort position.
      const first = f.geometry.coordinates?.[0];
      const lat = first?.[1];
      const lng = first?.[0];

      searchData.push({
        label,
        type: 'Village couvert / Covered',
        sub: p.TargetID || '',
        lat,
        lng
      });
    });

    // Uncovered villages
    villagesAll.features.forEach(f => {
      if (!f.geometry?.coordinates) return;
      const p = f.properties || {};
      const name = p.VILLAGE || p.name || p.NAME || p.NOM;
      if (!name) return;

      searchData.push({
        label: name,
        type: 'Village',
        sub: [p.NOMREG, p.NOMDEP, p.NOM_ARRO, p.NOMCR].filter(Boolean).join(' › '),
        nomreg: (p.NOMREG || '').toLowerCase(),
        nomdep: (p.NOMDEP || '').toLowerCase(),
        nom_arro: (p.NOM_ARRO || '').toLowerCase(),
        nomcr: (p.NOMCR || '').toLowerCase(),
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0]
      });
    });

    // Render
    renderBufferVillages();
    renderUncoveredVillages();
    buildLegend();
    buildChart();
    updateStats();
  })
  .catch(err => {
    console.error('Error loading GeoJSON files:', err);
    alert('Error loading data. Make sure Live Server is running and files are in the Layers/ folder.');
  });

// ── RENDER BUFFER VILLAGES ───────────────────────────────────────────────────
function renderBufferVillages() {
  bufferLayer.clearLayers();
  if (!allBuffer.length) {
    console.warn('LCP: allBuffer empty');
    return;
  }

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

    marker.on('mouseover', function () {
      this.setStyle({ radius: 9, weight: 1.5 });
      this.bindTooltip(
        `<b>${v.village}</b><br>📍 ${v.distKm.toFixed(1)} km → ${v.centre || 'Centre inconnu'}`,
        { sticky: true, offset: [10, -5] }
      ).openTooltip();
    });

    marker.on('mouseout', function () {
      this.setStyle({ radius: 6, weight: 0.8 });
      this.closeTooltip();
    });

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

// ── RENDER UNCOVERED VILLAGES ───────────────────────────────────────────────
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
      this.bindTooltip(
        `<b>${v.village}</b><br>⚠️ Non couvert / Uncovered`,
        { sticky: true, offset: [10, -5] }
      ).openTooltip();
    });

    marker.on('mouseout', function () {
      this.setStyle({ radius: 1.5 });
      this.closeTooltip();
    });

    marker.on('click', function () {
      marker.bindPopup(`
        <div class="popup-header" style="background:#888">⚠️ ${v.village}</div>
        <div class="popup-body"><i>No health centre within 100 km</i></div>`, { maxWidth: 220 })
        .openPopup();
    });

    uncoveredLayer.addLayer(marker);
  });
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

searchInput.addEventListener('input', function () {
  const q = this.value.trim().toLowerCase();
  searchResults.innerHTML = '';

  if (q.length < 2) {
    searchResults.style.display = 'none';
    return;
  }

  const matches = searchData
    .filter(d =>
      (d.label || '').toLowerCase().includes(q) ||
      (d.nomreg || '').includes(q) ||
      (d.nomdep || '').includes(q) ||
      (d.nom_arro || '').includes(q) ||
      (d.nomcr || '').includes(q)
    )
    .slice(0, 8);

  if (!matches.length) {
    searchResults.style.display = 'none';
    return;
  }

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

// ── LEGEND ──────────────────────────────────────────────────────────────────
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

// ── CHART ───────────────────────────────────────────────────────────────────
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
        borderRadius: 4,
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

// ── STATS ───────────────────────────────────────────────────────────────────
function updateStats() {
  const visible = allBuffer.filter(v => activeBands.has(BANDS.indexOf(v.band)) && v.distKm <= activeFilter);
  const avg = visible.length ? (visible.reduce((s, v) => s + v.distKm, 0) / visible.length).toFixed(1) : '--';

  document.getElementById('s-total').textContent = visible.length;
  document.getElementById('s-uncovered').textContent = allUncovered.length;
  document.getElementById('s-avg').textContent = avg;
}

// ── FILTER & TOGGLES ───────────────────────────────────────────────────────
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

// ── EXPORT: PNG ─────────────────────────────────────────────────────────────
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
    link.download = 'LougaMap_LCP.png';
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

// ── EXPORT: PDF (print dialog) ───────────────────────────────────────────────
function exportPDF() {
  document.getElementById('print-date').textContent = new Date().toLocaleDateString('fr-FR');
  window.print();
}

document.getElementById('btn-pdf').addEventListener('click', exportPDF);

// ── EXPORT: CSV ─────────────────────────────────────────────────────────────
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
  link.download = 'LougaMap_LCP_villages.csv';
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

document.getElementById('btn-csv').addEventListener('click', exportCSV);

