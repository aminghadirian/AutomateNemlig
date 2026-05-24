'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const BASE          = 'https://www.nemlig.com';
const SEARCH_URL    = 'https://webapi.prod.knl.nemlig.it/api/v2/search';
const TRANSLATE_URL = 'https://api.mymemory.translated.net/get';
const CORS_PROXY    = 'https://corsproxy.io/?';

// ── State ──────────────────────────────────────────────────────────────────────
const translationCache = {};

// ── Unit helpers (ported from Python) ─────────────────────────────────────────
const UNIT_TO_BASE_ML_OR_G = {
  kg: 1000, g: 1,
  l: 1000, liter: 1000, litre: 1000,
  dl: 100, cl: 10, ml: 1,
};
const VOLUME_UNITS = new Set(['l','liter','litre','dl','cl','ml']);
const WEIGHT_UNITS = new Set(['kg','g']);
const COUNT_UNITS  = new Set(['stk','pcs','stuk','piece','pieces']);

const SIZE_RE = new RegExp(
  String.raw`(\d+[,.]?\d*)\s*x\s*(\d+[,.]?\d*)\s*(kg|g|l|dl|cl|ml|liter|litre)\b` +
  String.raw`|(\d+[,.]?\d*)\s*(kg|g|l|dl|cl|ml|liter|litre)\b`,
  'gi'
);

function parsePackSize(name) {
  SIZE_RE.lastIndex = 0;
  let match, last = null;
  while ((match = SIZE_RE.exec(name)) !== null) last = match;
  if (!last) return { qty: null, unitType: null };

  let qty, unit;
  if (last[1]) {                         // multipack: n x m unit
    qty  = parseFloat(last[1].replace(',','.')) * parseFloat(last[2].replace(',','.'));
    unit = last[3].toLowerCase();
  } else {                               // simple: n unit
    qty  = parseFloat(last[4].replace(',','.'));
    unit = last[5].toLowerCase();
  }

  const basePerUnit = UNIT_TO_BASE_ML_OR_G[unit];
  if (!basePerUnit) return { qty: null, unitType: null };

  const qtyBase = qty * basePerUnit;        // in ml or g

  let unitType;
  if (VOLUME_UNITS.has(unit)) unitType = 'volume';
  else if (WEIGHT_UNITS.has(unit)) unitType = 'weight';
  else unitType = 'other';

  return { qty: qtyBase, unitType };         // qty in ml or g
}

function extractPrice(product) {
  const paths = [
    ['pricing','currentPrice'], ['pricing','price'], ['pricing','salesPrice'],
    ['price','currentPrice'],   ['price','price'],   ['price','value'],
    ['Price'], ['price'], ['currentPrice'], ['CurrentPrice'], ['salesPrice'],
  ];
  for (const path of paths) {
    let obj = product;
    for (const k of path) obj = (obj && typeof obj === 'object') ? obj[k] : undefined;
    const n = parseFloat(obj);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

function productUrl(product) {
  const rel = product.relativeUrl || product.RelativeUrl || '';
  return rel ? BASE + rel : null;
}

function productName(product) {
  return product.displayName || product.DisplayName || product.name || product.Name || '';
}

// ── Translation ────────────────────────────────────────────────────────────────
async function toDanish(text) {
  const key = text.toLowerCase().trim();
  if (translationCache[key]) return translationCache[key];

  try {
    const url = `${TRANSLATE_URL}?q=${encodeURIComponent(text)}&langpair=auto|da`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('translate fetch failed');
    const data = await r.json();
    const translated = data?.responseData?.translatedText;
    if (translated && translated !== text) {
      translationCache[key] = { term: translated, translated: true };
      return translationCache[key];
    }
  } catch (_) { /* fall through */ }

  translationCache[key] = { term: text, translated: false };
  return translationCache[key];
}

// ── Search ─────────────────────────────────────────────────────────────────────
async function searchProducts(query) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', '48');
  url.searchParams.set('pageIndex', '0');
  const directUrl = url.toString();
  const proxyUrl  = CORS_PROXY + encodeURIComponent(directUrl);

  // Try direct first; if CORS blocks it, retry via proxy
  for (const endpoint of [directUrl, proxyUrl]) {
    try {
      const r = await fetch(endpoint);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return extractProductList(data);
    } catch (e) {
      if (endpoint === proxyUrl) throw new Error(`Search failed: ${e.message}`);
      // else try proxy next
    }
  }
  return [];
}

function extractProductList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['products','Products','items','Items','results','Results']) {
    if (Array.isArray(data[key]) && data[key].length) return data[key];
  }
  for (const v of Object.values(data)) {
    if (typeof v === 'object' && v !== null) {
      const found = extractProductList(v);
      if (found.length) return found;
    }
  }
  return [];
}

// ── Cheapest-for-amount ────────────────────────────────────────────────────────
const ITEM_RE = /^(\d+[.,]?\d*)\s*(kg|g|l|dl|cl|ml|stk|pcs|stuk|piece|pieces)?\s+(.+)$/i;

function parseShoppingLine(line) {
  const m = line.trim().match(ITEM_RE);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(',', '.'));
  const unit   = (m[2] || '').toLowerCase() || 'stk';
  const name   = m[3].trim();

  let amountBase, unitType;
  if (WEIGHT_UNITS.has(unit)) {
    amountBase = amount * UNIT_TO_BASE_ML_OR_G[unit];
    unitType = 'weight';
  } else if (VOLUME_UNITS.has(unit)) {
    amountBase = amount * UNIT_TO_BASE_ML_OR_G[unit];
    unitType = 'volume';
  } else {
    amountBase = amount;
    unitType = 'count';
  }
  return { amount, unit, amountBase, unitType, name };
}

function findCheapest(products, parsed) {
  const { amountBase, unitType } = parsed;
  const candidates = [];

  for (const p of products) {
    const price = extractPrice(p);
    if (!price || price <= 0) continue;
    const name = productName(p);

    if (unitType === 'count') {
      // For count items, compare by price / count
      // Try to find a count in the product name like "12 stk" or just use 1
      const countMatch = name.match(/(\d+)\s*stk\b/i);
      const packCount = countMatch ? parseInt(countMatch[1]) : 1;
      const packsNeeded = Math.ceil(amountBase / packCount);
      candidates.push({
        name, price, url: productUrl(p),
        packCount, packsNeeded, total: packsNeeded * price,
        unitLabel: `${packCount} stk`,
      });
    } else {
      const { qty, unitType: packUnitType } = parsePackSize(name);
      if (!qty || packUnitType !== unitType) continue;
      const packsNeeded = Math.ceil(amountBase / qty);
      candidates.push({
        name, price, url: productUrl(p),
        packCount: qty, packsNeeded, total: packsNeeded * price,
        unitLabel: unitType === 'volume'
          ? `${(qty/1000).toFixed(qty % 1000 === 0 ? 0 : 2)} L`
          : `${(qty >= 1000 ? (qty/1000).toFixed(qty%1000===0?0:2)+'kg' : qty+'g')}`,
      });
    }
  }

  candidates.sort((a, b) => a.total - b.total);
  return candidates[0] || null;
}

// ── DOM helpers ────────────────────────────────────────────────────────────────
function setStatus(msg, spinner = false) {
  const el = document.getElementById('statusBar');
  el.innerHTML = spinner ? `<span class="spinner"></span>${msg}` : msg;
}

function showBanner(msg, type = 'error') {
  const el = document.getElementById('banner');
  el.className = `banner ${type}`;
  el.textContent = msg;
  el.hidden = false;
}

function hideBanner() {
  document.getElementById('banner').hidden = true;
}

function fmtAmount(parsed) {
  const { amount, unit } = parsed;
  return `${amount} ${unit}`;
}

function fmtPrice(kr) {
  return kr.toFixed(2) + ' kr';
}

// ── Main flow ──────────────────────────────────────────────────────────────────
async function run() {
  hideBanner();
  const listRaw = document.getElementById('list').value;
  const lines   = listRaw.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) { showBanner('Please enter at least one item.'); return; }

  const btn = document.getElementById('findBtn');
  btn.disabled = true;
  document.getElementById('resultsSection').style.display = 'none';

  try {
    // Process each line
    const rows = [];
    const skipped = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      setStatus(`Processing item ${i+1} of ${lines.length}: ${line}`, true);

      const parsed = parseShoppingLine(line);
      if (!parsed) { skipped.push(line); continue; }

      // Translate
      const { term: searchTerm, translated } = await toDanish(parsed.name);

      // Search
      let products;
      try {
        products = await searchProducts(searchTerm);
      } catch (e) {
        skipped.push(`${line} (search error: ${e.message})`);
        continue;
      }

      if (!products.length) { skipped.push(`${line} (no results)`); continue; }

      const best = findCheapest(products, parsed);
      if (!best) { skipped.push(`${line} (no matching pack size found)`); continue; }

      rows.push({ line, parsed, searchTerm, translated, best });
    }

    renderResults(rows, skipped);
    setStatus('Done.');
  } catch (e) {
    showBanner(e.message || 'An error occurred.');
    setStatus('');
  } finally {
    btn.disabled = false;
  }
}

function renderResults(rows, skipped) {
  const section = document.getElementById('resultsSection');
  const tbody   = document.getElementById('resultsTbody');
  tbody.innerHTML = '';

  let grandTotal = 0;

  for (const { line, parsed, searchTerm, translated, best } of rows) {
    grandTotal += best.total;
    const tr = document.createElement('tr');

    const nameCell = translated
      ? `${parsed.name}<span class="tag-translated" title="Translated to Danish">${searchTerm}</span>`
      : parsed.name;

    const productCell = best.url
      ? `<a href="${best.url}" target="_blank" rel="noopener">${best.name}</a>`
      : best.name;

    tr.innerHTML = `
      <td>${nameCell}</td>
      <td>${fmtAmount(parsed)}</td>
      <td>${productCell}</td>
      <td>${best.unitLabel}</td>
      <td style="text-align:right">${best.packsNeeded}</td>
      <td style="text-align:right">${fmtPrice(best.price)}</td>
      <td style="text-align:right;font-weight:600">${fmtPrice(best.total)}</td>
    `;
    tbody.appendChild(tr);
  }

  // Grand total row
  const totalRow = document.createElement('tr');
  totalRow.innerHTML = `
    <td colspan="6" style="text-align:right;font-weight:700">Total</td>
    <td style="text-align:right;font-weight:700">${fmtPrice(grandTotal)}</td>
  `;
  tbody.appendChild(totalRow);

  // Skipped items note
  const note = document.getElementById('skippedNote');
  if (skipped.length) {
    note.textContent = `Could not process: ${skipped.join('; ')}`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  section.style.display = '';
}

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('findBtn').addEventListener('click', run);
});
