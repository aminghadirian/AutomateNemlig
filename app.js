'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const BASE       = 'https://www.nemlig.com';
const SEARCH_URL = `${BASE}/webapi/s/0/1/0/Search/Search`;
const CORS_PROXY = 'https://corsproxy.io/?';

// ── State ──────────────────────────────────────────────────────────────────────
let lastRows = [];

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
  const rel = product.relativeUrl || product.RelativeUrl
           || product.url         || product.Url
           || product.productUrl  || product.ProductUrl
           || product.link        || product.Link
           || product.seoUrl      || product.SeoUrl
           || '';
  if (rel) return rel.startsWith('http') ? rel : BASE + (rel.startsWith('/') ? rel : '/' + rel);
  const name = productName(product);
  return name ? `${BASE}/forside?search=${encodeURIComponent(name)}` : null;
}

function productName(product) {
  return product.displayName || product.DisplayName || product.name || product.Name || '';
}

function productId(product) {
  return product.id ?? product.Id ?? product.productId ?? product.ProductId
      ?? product.stockcode ?? product.Stockcode ?? null;
}

// ── Search ─────────────────────────────────────────────────────────────────────
async function searchProducts(query) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('take', '48');
  // Always route through CORS proxy — www.nemlig.com blocks cross-origin requests
  const proxied = CORS_PROXY + encodeURIComponent(url.toString());
  const r = await fetch(proxied);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const products = extractProductList(data);
  if (!products.length) {
    // Log top-level keys to help debug unexpected response shapes
    const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : String(data);
    console.debug('Search response keys:', keys);
  }
  return products;
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

// ── Translation dictionary (EN/DE → DA) ───────────────────────────────────────
const TRANSLATIONS = {
  // English → Danish
  'milk':'mælk','whole milk':'sødmælk','semi-skimmed milk':'letmælk',
  'skimmed milk':'skummetmælk','butter':'smør','cream':'fløde',
  'heavy cream':'piskefløde','whipping cream':'piskefløde',
  'sour cream':'creme fraiche','yogurt':'yoghurt','yoghurt':'yoghurt',
  'cream cheese':'flødeost','cheese':'ost','parmesan':'parmesan',
  'parmesan cheese':'parmesanost','mozzarella':'mozzarella',
  'goat cheese':'gedeost',"goat's cheese":'gedeost',
  'feta':'feta','ricotta':'ricotta','mascarpone':'mascarpone',
  'egg':'æg','eggs':'æg',
  'chicken':'kylling','chicken breast':'kyllingebryst',
  'chicken thigh':'kyllingelår','chicken thighs':'kyllingelår',
  'beef':'oksekød','ground beef':'hakket oksekød','minced beef':'hakket oksekød',
  'pork':'svinekød','bacon':'bacon','ham':'skinke','lamb':'lammekød',
  'turkey':'kalkun','salmon':'laks','tuna':'tun',
  'shrimp':'rejer','prawns':'rejer','cod':'torsk',
  'onion':'løg','onions':'løg','red onion':'rødløg','garlic':'hvidløg',
  'tomato':'tomat','tomatoes':'tomater',
  'carrot':'gulerod','carrots':'gulerødder',
  'potato':'kartoffel','potatoes':'kartofler','sweet potato':'søde kartofler',
  'bell pepper':'peberfrugt','red pepper':'rød peberfrugt',
  'cucumber':'agurk','zucchini':'squash','courgette':'squash',
  'spinach':'spinat','lettuce':'salat','broccoli':'broccoli',
  'cauliflower':'blomkål','cabbage':'kål',
  'mushroom':'svamp','mushrooms':'svampe',
  'leek':'porre','celery':'selleri','aubergine':'aubergine','eggplant':'aubergine',
  'asparagus':'asparges','green beans':'grønne bønner',
  'corn':'majs','peas':'ærter','avocado':'avocado',
  'apple':'æble','apples':'æbler','lemon':'citron','lemons':'citroner',
  'lime':'lime','orange':'appelsin','banana':'banan',
  'strawberry':'jordbær','strawberries':'jordbær',
  'blueberry':'blåbær','blueberries':'blåbær',
  'flour':'mel','all-purpose flour':'hvedemel','bread flour':'hvedemel',
  'sugar':'sukker','brown sugar':'brun farin',
  'salt':'salt','pepper':'peber','black pepper':'sort peber',
  'olive oil':'olivenolie','oil':'olie','vegetable oil':'olie',
  'vinegar':'eddike','soy sauce':'sojasauce','honey':'honning',
  'tomato paste':'tomatpuré','tomato purée':'tomatpuré',
  'canned tomatoes':'hakkede tomater','pasta':'pasta',
  'spaghetti':'spaghetti','rice':'ris',
  'basmati rice':'basmatiris','jasmine rice':'jasminris',
  'bread':'brød','breadcrumbs':'rasp',
  'baking powder':'bagepulver','baking soda':'natron',
  'hazelnut':'hasselnød','hazelnuts':'hasselnødder',
  'pine nut':'pinjekernen','pine nuts':'pinjekerner',
  'almond':'mandel','almonds':'mandler',
  'walnut':'valnød','walnuts':'valnødder',
  'cashew':'cashewnød','cashews':'cashewnødder',
  'peanut':'jordnød','peanuts':'jordnødder',
  'salted peanuts':'saltede jordnødder',
  'sesame seeds':'sesamfrø','sunflower seeds':'solsikkekerner',
  'basil':'basilikum','oregano':'oregano','thyme':'timian',
  'rosemary':'rosmarin','parsley':'persille',
  'cilantro':'koriander','coriander':'koriander',
  'chili':'chili','paprika':'paprika','cumin':'spidskommen',
  'cinnamon':'kanel','nutmeg':'muskatnød','bay leaves':'laurbærblade',
  // German → Danish
  'milch':'mælk','vollmilch':'sødmælk','fettarme milch':'letmælk',
  'magermilch':'skummetmælk','sahne':'fløde','schlagsahne':'piskefløde',
  'joghurt':'yoghurt','käse':'ost','parmesankäse':'parmesanost',
  'ziegenkäse':'gedeost','ei':'æg','eier':'æg',
  'hähnchen':'kylling','hühnerbrust':'kyllingebryst',
  'hähnchenbrustfilet':'kyllingebryst','hähnchenkeule':'kyllingelår',
  'rinderhack':'hakket oksekød','hackfleisch':'hakket kød',
  'rindfleisch':'oksekød','schweinefleisch':'svinekød',
  'speck':'bacon','schinken':'skinke','lammfleisch':'lammekød',
  'truthahn':'kalkun','lachs':'laks','thunfisch':'tun',
  'garnelen':'rejer','kabeljau':'torsk',
  'zwiebel':'løg','zwiebeln':'løg','rote zwiebeln':'rødløg',
  'knoblauch':'hvidløg','tomate':'tomat','tomaten':'tomater',
  'karotte':'gulerod','karotten':'gulerødder','möhren':'gulerødder',
  'kartoffeln':'kartofler','süßkartoffel':'søde kartofler',
  'gurke':'agurk','zucchini':'squash','spinat':'spinat',
  'brokkoli':'broccoli','blumenkohl':'blomkål','kohl':'kål',
  'champignon':'svamp','champignons':'svampe','pilze':'svampe',
  'lauch':'porre','sellerie':'selleri',
  'spargel':'asparges','grüne bohnen':'grønne bønner',
  'mais':'majs','erbsen':'ærter',
  'apfel':'æble','äpfel':'æbler','zitrone':'citron','zitronen':'citroner',
  'limette':'lime','banane':'banan',
  'erdbeere':'jordbær','erdbeeren':'jordbær',
  'blaubeere':'blåbær','blaubeeren':'blåbær',
  'mehl':'mel','weizenmehl':'hvedemel','zucker':'sukker',
  'brauner zucker':'brun farin','salz':'salt','pfeffer':'peber',
  'schwarzer pfeffer':'sort peber','olivenöl':'olivenolie','öl':'olie',
  'essig':'eddike','sojasauce':'sojasauce','honig':'honning',
  'tomatenmark':'tomatpuré','nudeln':'pasta','reis':'ris',
  'basmatireis':'basmatiris','jasminreis':'jasminris',
  'brot':'brød','semmelbrösel':'rasp','backpulver':'bagepulver',
  'haselnuss':'hasselnød','haselnüsse':'hasselnødder',
  'pinienkerne':'pinjekerner','mandel':'mandel','mandeln':'mandler',
  'walnuss':'valnød','walnüsse':'valnødder',
  'cashewkerne':'cashewnødder','erdnüsse':'jordnødder',
  'gesalzene erdnüsse':'saltede jordnødder',
  'sesamsamen':'sesamfrø','sonnenblumenkerne':'solsikkekerner',
  'basilikum':'basilikum','thymian':'timian','rosmarin':'rosmarin',
  'petersilie':'persille','koriander':'koriander',
  'paprikapulver':'paprika','kreuzkümmel':'spidskommen',
  'zimt':'kanel','muskatnuss':'muskatnød','lorbeerblätter':'laurbærblade',
};

function toDanish(name) {
  const key = name.toLowerCase().trim();
  if (TRANSLATIONS[key]) return TRANSLATIONS[key];
  if (key.endsWith('s') && TRANSLATIONS[key.slice(0, -1)]) return TRANSLATIONS[key.slice(0, -1)];
  return name;
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

function parseCookidooFormat(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const pairs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1];
    const lineIsName   = !/^\d/.test(line);
    const nextIsAmount = next && /^\d/.test(next);
    if (lineIsName && nextIsAmount) {
      const amtMatch = next.match(/^(\d+[.,]?\d*)(?:\s*-\s*\d+[.,]?\d*)?\s*(\S+)?/);
      const amt  = amtMatch ? amtMatch[1] : '';
      const unit = amtMatch ? (amtMatch[2] || '') : '';
      pairs.push(`${amt}${unit ? ' ' + unit : ''} ${line}`);
      i += 2;
    } else {
      i += 1;
    }
  }
  return pairs.length >= 2 ? pairs.join('\n') : null;
}

function extractPackInfo(product) {
  const price = extractPrice(product);
  if (!price) return null;

  // Strategy 1: use API-provided unitPrice + unitPriceLabel to calculate pack size
  const po = product.pricing || product.Pricing || product.price || {};
  const unitPrice = parseFloat(
    po.unitPrice || po.UnitPrice || po.pricePerUnit || po.PricePerUnit || 0
  );
  const rawLabel = (po.unitPriceLabel || po.UnitPriceLabel || po.unitLabel || po.UnitLabel || '').toLowerCase();

  if (unitPrice > 0 && rawLabel) {
    const isVol    = /\/\s*l\b|liter|litre/.test(rawLabel);
    const isWeight = /\/\s*kg\b/.test(rawLabel);
    const isCount  = /stk|stuk|pcs|piece/.test(rawLabel);

    if (isVol || isWeight) {
      // packSize in L or kg, then convert to ml or g (base units)
      const packSizeInUnit = price / unitPrice;
      const qty = packSizeInUnit * 1000;
      const unitType = isVol ? 'volume' : 'weight';
      const label = isVol
        ? `${packSizeInUnit.toFixed(packSizeInUnit % 1 === 0 ? 0 : 2)} L`
        : packSizeInUnit >= 1
          ? `${packSizeInUnit.toFixed(packSizeInUnit % 1 === 0 ? 0 : 2)} kg`
          : `${Math.round(packSizeInUnit * 1000)} g`;
      return { qty, unitType, label };
    }
    if (isCount) {
      const packCount = Math.max(1, Math.round(price / unitPrice));
      return { qty: packCount, unitType: 'count', label: `${packCount} stk` };
    }
  }

  // Strategy 2: regex across all text fields
  const allText = [
    productName(product),
    product.description || product.Description || '',
    product.subtitle    || product.Subtitle    || '',
    product.salesUnitShortName || product.SalesUnitShortName || '',
    product.unitSize    || product.UnitSize    || '',
  ].join(' ');

  const { qty, unitType } = parsePackSize(allText);
  if (qty && unitType && unitType !== 'other') {
    const label = unitType === 'volume'
      ? `${(qty/1000).toFixed(qty % 1000 === 0 ? 0 : 2)} L`
      : qty >= 1000 ? `${(qty/1000).toFixed(0)} kg` : `${qty} g`;
    return { qty, unitType, label };
  }

  // Strategy 3: stk count in text (for count items)
  const stkMatch = allText.match(/(\d+)\s*stk\b/i);
  if (stkMatch) {
    const packCount = parseInt(stkMatch[1]);
    return { qty: packCount, unitType: 'count', label: `${packCount} stk` };
  }

  return null;
}

function nameMatchesQuery(name, query) {
  const nameLc = name.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  if (!words.length) return true;
  return words.some(w => nameLc.includes(w));
}

function findCheapest(products, parsed, searchTerm) {
  const { amountBase, unitType } = parsed;
  const candidates = [];

  for (const p of products) {
    const price = extractPrice(p);
    if (!price || price <= 0) continue;

    const name = productName(p);
    if (!nameMatchesQuery(name, searchTerm)) continue;

    const packInfo = extractPackInfo(p);
    if (!packInfo || packInfo.unitType !== unitType) continue;

    const packsNeeded = Math.ceil(amountBase / packInfo.qty);
    candidates.push({
      id: productId(p), name, price, url: productUrl(p),
      packsNeeded, total: packsNeeded * price,
      unitLabel: packInfo.label,
    });
  }

  if (!candidates.length && products.length) {
    // Debug: show first product's top-level field names so we can adapt if needed
    console.debug('No matches. First product keys:', Object.keys(products[0]).join(', '));
    console.debug('First product pricing:', JSON.stringify(products[0].pricing || products[0].price || products[0].Price || {}));
  }

  candidates.sort((a, b) => a.total - b.total);
  return candidates[0] || null;
}

// ── DOM helpers ────────────────────────────────────────────────────────────────
function log(msg, type = 'info', url = null) {
  const panel = document.getElementById('log');
  panel.classList.add('active');
  const div = document.createElement('div');
  div.className = `log-${type}`;
  div.textContent = msg;
  if (url) {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = ' → nemlig.com';
    a.target = '_blank';
    a.rel = 'noopener';
    div.appendChild(a);
  }
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

function clearLog() {
  const panel = document.getElementById('log');
  panel.innerHTML = '';
  panel.classList.remove('active');
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
  clearLog();

  const listRaw = document.getElementById('list').value;
  const lines   = listRaw.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) { showBanner('Please enter at least one item.'); return; }

  const btn = document.getElementById('findBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  document.getElementById('resultsSection').hidden = true;

  try {
    const rows = [];
    const skipped = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      log(`[${i+1}/${lines.length}] "${line}"`);

      const parsed = parseShoppingLine(line);
      if (!parsed) {
        log(`  ✗ Could not parse — use format like "2L milk" or "500g smør"`, 'warn');
        skipped.push(line);
        continue;
      }

      // Search
      const searchTerm = toDanish(parsed.name);
      log(`  Searching Nemlig for "${searchTerm}"...`);
      let products;
      try {
        products = await searchProducts(searchTerm);
      } catch (e) {
        log(`  ✗ Search failed: ${e.message}`, 'error');
        skipped.push(`${line} (${e.message})`);
        continue;
      }

      if (!products.length) {
        log(`  ✗ No products found`, 'warn');
        skipped.push(`${line} (no results)`);
        continue;
      }
      log(`  Found ${products.length} products`, 'ok');

      // Find cheapest for required amount
      const best = findCheapest(products, parsed, searchTerm);
      if (!best) {
        log(`  ✗ No product matched the unit type (${parsed.unitType})`, 'warn');
        if (products.length) {
          log(`  ℹ API fields: ${Object.keys(products[0]).join(', ')}`, 'info');
        }
        skipped.push(`${line} (no matching pack size)`);
        continue;
      }

      log(`  ✓ Best: ${best.name} — ${best.total.toFixed(2)} kr (${best.packsNeeded}×${best.price.toFixed(2)} kr)`, 'ok', best.url || null);
      rows.push({ line, parsed, searchTerm, best });
    }

    if (rows.length === 0) {
      showBanner(
        `Nothing could be matched. Check your format (e.g. "2L milk", "500g smør", "12 eggs"). ` +
        `See the log above for details.`,
        'error'
      );
    } else {
      renderResults(rows, skipped);
    }

    log(rows.length ? `Done — ${rows.length} item(s) matched.` : 'Done (0 items matched).', rows.length ? 'ok' : 'warn');
  } catch (e) {
    showBanner(e.message || 'An unexpected error occurred.');
    log(`✗ ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

function renderResults(rows, skipped) {
  lastRows = rows;

  const section = document.getElementById('resultsSection');
  const tbody   = document.getElementById('resultsTbody');
  tbody.innerHTML = '';

  let grandTotal = 0;

  for (const { parsed, searchTerm, best } of rows) {
    grandTotal += best.total;
    const tr = document.createElement('tr');
    const nameCell = parsed.name;

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

  section.hidden = false;
}

// ── Open search tabs ───────────────────────────────────────────────────────────
function openSearchTabs() {
  const lines = document.getElementById('list').value
    .split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    showBanner('Enter items in the shopping list first.', 'warning');
    return;
  }
  for (const line of lines) {
    const parsed = parseShoppingLine(line);
    const term = toDanish(parsed ? parsed.name : line);
    window.open(`${BASE}/forside?search=${encodeURIComponent(term)}`, '_blank', 'noopener');
  }
}

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('findBtn').addEventListener('click', run);
  document.getElementById('openSearchBtn').addEventListener('click', openSearchTabs);
  document.getElementById('list').addEventListener('paste', e => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    const reformatted = parseCookidooFormat(text);
    if (reformatted) {
      e.preventDefault();
      document.getElementById('list').value = reformatted;
      showBanner('Cookidoo list reformatted — review before searching.', 'info');
    }
  });
});
