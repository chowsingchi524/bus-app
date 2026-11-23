const KMB_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const CTB_BASE = 'https://rt.data.gov.hk/v2/transport/citybus';
const GMB_BASE = 'https://data.etagmb.gov.hk';

const CO_NAMES = {
  KMB: '九巴',
  CTB: '城巴',
  GMB: '專線小巴',
  JOINT: '九巴+城巴'
};

const AREA_KEYWORDS = {
  kaitak: ['kai tak', '啟德', '啓德', '郵輪碼頭', '德朗', '啟晴', '沐安'],
  tokwawan: ['to kwa wan', '土瓜灣', '馬頭圍', '馬頭角', '宋皇臺', '樂民', '木廠'],
  hunghom: ['hung hom', '紅磡', '黃埔', '紅鸞', '海底隧道', '理工大學', '海逸'],
  kowloonbay: ['kowloon bay', '九龍灣', 'megabox', '啟業', '彩福', '彩盈', '臨華', '宏照', '常悅', '麗晶'],
  telford: ['telford', '德福', '九龍灣站', '九龍灣鐵路站']
};

const REFRESH_SECONDS = 30;

const savedFavs = JSON.parse(localStorage.getItem('hk_bus_favs') || '[]').map((f) => ({
  ...f,
  group: f.group === 'home' ? 'home' : 'out'
}));

const savedHistory = JSON.parse(localStorage.getItem('hk_search_history') || '[]');

const state = {
  favorites: savedFavs,
  searchHistory: Array.isArray(savedHistory) ? savedHistory : [],
  editHistoryMode: false,
  activeGroup: localStorage.getItem('hk_active_group') || 'out',
  editMode: false,
  countdown: REFRESH_SECONDS,
  kmbRoutes: [],
  kmbStops: [],
  kmbStopMap: new Map(),
  ctbRoutes: [],
  ctbStopCache: JSON.parse(localStorage.getItem('hk_ctb_stops') || '{}'),
  gmbRoutes: { KLN: new Set(), NT: new Set(), HKI: new Set() },
  gmbLoaded: false,
  activeArea: 'kaitak',
  map: null,
  pendingPin: null
};

// --- 工具函數 ---
function esc(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function renderBadgesHtml(co) {
  if (co === 'JOINT') {
    return `<div class="badge-group"><span class="badge badge-KMB">九巴</span><span class="badge badge-CTB">城巴</span></div>`;
  }
  return `<span class="badge badge-${co}">${CO_NAMES[co] || co}</span>`;
}

function saveFavs() {
  localStorage.setItem('hk_bus_favs', JSON.stringify(state.favorites));
}

function saveSearchHistory() {
  localStorage.setItem('hk_search_history', JSON.stringify(state.searchHistory));
}

function recordSearchHistory(route) {
  state.searchHistory = [route, ...state.searchHistory.filter((r) => r !== route)].slice(0, 20);
  saveSearchHistory();
  renderSearchHistoryChips();
}

function findFav(id) {
  return state.favorites.find((f) => f.id === id);
}

function removeFav(id) {
  state.favorites = state.favorites.filter((f) => f.id !== id);
  saveFavs();
}

function addFav(favObj, group) {
  const existing = findFav(favObj.id);
  if (existing) {
    existing.group = group;
  } else {
    state.favorites.push({ ...favObj, group });
  }
  saveFavs();
}

function openGroupPicker(favObj, onDone) {
  const existing = findFav(favObj.id);
  if (existing) {
    removeFav(favObj.id);
    if (onDone) onDone();
    return;
  }
  state.pendingPin = { favObj, onDone };
  document.getElementById('pickerStopLabel').textContent =
    `${CO_NAMES[favObj.co] || favObj.co} ${favObj.route} · ${favObj.stopNameTc}`;
  document.getElementById('groupPickerBackdrop').classList.add('open');
}

function calcMinutes(isoStr) {
  if (!isoStr) return null;
  const m = Math.round((new Date(isoStr).getTime() - Date.now()) / 60000);
  return m === 0 ? 0 : m;
}

function formatClock(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function ensureCtbStops(stopIds) {
  const missing = [...new Set(stopIds)].filter((id) => id && !state.ctbStopCache[id]);
  if (missing.length === 0) return;
  await Promise.allSettled(
    missing.map((id) =>
      fetchJson(`${CTB_BASE}/stop/${id}`).then((r) => {
        if (r.data) state.ctbStopCache[id] = r.data;
      })
    )
  );
  try { localStorage.setItem('hk_ctb_stops', JSON.stringify(state.ctbStopCache)); } catch (_) {}
}

// --- 初始化路線及車站資料 ---
async function initData() {
  try {
    const cachedStops = JSON.parse(localStorage.getItem('hk_kmb_stops_v1') || 'null');
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    const tasks = [
      fetchJson(`${KMB_BASE}/route/`).then((r) => { state.kmbRoutes = r.data || []; }),
      fetchJson(`${CTB_BASE}/route/ctb`).then((r) => { state.ctbRoutes = r.data || []; }),
      Promise.all([
        fetchJson(`${GMB_BASE}/route/KLN`).then((r) => { state.gmbRoutes.KLN = new Set(r.data?.routes || []); }),
        fetchJson(`${GMB_BASE}/route/NT`).then((r) => { state.gmbRoutes.NT = new Set(r.data?.routes || []); }),
        fetchJson(`${GMB_BASE}/route/HKI`).then((r) => { state.gmbRoutes.HKI = new Set(r.data?.routes || []); })
      ]).then(() => { state.gmbLoaded = true; })
    ];

    if (cachedStops && Date.now() - cachedStops.ts < weekMs) {
      state.kmbStops = cachedStops.stops;
    } else {
      tasks.push(
        fetchJson(`${KMB_BASE}/stop`).then((r) => {
          state.kmbStops = (r.data || []).map((s) => ({
            s: s.stop, e: s.name_en, t: s.name_tc, a: parseFloat(s.lat), o: parseFloat(s.long)
          }));
          try {
            localStorage.setItem('hk_kmb_stops_v1', JSON.stringify({ ts: Date.now(), stops: state.kmbStops }));
          } catch (_) {}
        })
      );
    }

    await Promise.allSettled(tasks);
    state.kmbStopMap = new Map(state.kmbStops.map((s) => [s.s, s]));
    if (document.getElementById('tab-area').classList.contains('active')) {
      renderAreaStops();
    }
  } catch (_) {}
}

// --- 整理並按時間排序 ETA ---
function extractTimedEtas(rawList, bound, opTag = '') {
  return (rawList || [])
    .filter((x) => (!bound || x.dir === bound) && x.eta)
    .map((x) => ({
      ts: new Date(x.eta).getTime(),
      min: calcMinutes(x.eta),
      clock: formatClock(x.eta),
      rmk: x.rmk_tc || '',
      op: opTag
    }))
    .filter((x) => !Number.isNaN(x.ts) && x.min >= -1);
}

function processBusEtas(rawList, bound) {
  const timed = extractTimedEtas(rawList, bound)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 3);

  if (timed.length > 0) return timed;

  const remarkOnly = (rawList || []).find((x) => (!bound || x.dir === bound) && x.rmk_tc);
  if (remarkOnly) {
    return [{ min: null, clock: '', rmk: remarkOnly.rmk_tc }];
  }
  return [];
}

// --- 獲取到站預報 ETA ---
async function fetchFavEta(fav) {
  if (fav.co === 'JOINT') {
    const reqs = [];
    if (fav.kmbStopId) {
      reqs.push(
        fetchJson(`${KMB_BASE}/eta/${fav.kmbStopId}/${fav.route}/${fav.serviceType || '1'}`)
          .then((r) => ({ op: 'KMB', bound: fav.kmbBound, data: r.data || [] }))
      );
    }
    if (fav.ctbStopId) {
      reqs.push(
        fetchJson(`${CTB_BASE}/eta/ctb/${fav.ctbStopId}/${fav.route}`)
          .then((r) => ({ op: 'CTB', bound: fav.ctbBound, data: r.data || [] }))
      );
    }

    const settled = await Promise.allSettled(reqs);
    let combinedTimed = [];
    let fallbackRemarks = [];

    settled.forEach((res) => {
      if (res.status !== 'fulfilled') return;
      const { op, bound, data } = res.value;
      const timed = extractTimedEtas(data, bound, op);
      combinedTimed = combinedTimed.concat(timed);
      const rmk = data.find((x) => (!bound || x.dir === bound) && x.rmk_tc);
      if (rmk) fallbackRemarks.push({ min: null, clock: '', rmk: rmk.rmk_tc, op });
    });

    if (combinedTimed.length > 0) {
      return combinedTimed.sort((a, b) => a.ts - b.ts).slice(0, 3);
    }
    return fallbackRemarks.slice(0, 1);
  }

  if (fav.co === 'KMB') {
    const res = await fetchJson(`${KMB_BASE}/eta/${fav.stopId}/${fav.route}/${fav.serviceType || '1'}`);
    return processBusEtas(res.data, fav.bound);
  }
  if (fav.co === 'CTB') {
    const res = await fetchJson(`${CTB_BASE}/eta/ctb/${fav.stopId}/${fav.route}`);
    return processBusEtas(res.data, fav.bound);
  }
  if (fav.co === 'GMB') {
    const res = await fetchJson(`${GMB_BASE}/eta/route-stop/${fav.routeId}/${fav.routeSeq}/${fav.stopSeq}`);
    if (!res.data || res.data.enabled === false) {
      return [{ min: null, clock: '', rmk: res.data?.description_tc || '未有實時班次' }];
    }
    return (res.data.eta || [])
      .filter((x) => x.diff >= -1)
      .sort((a, b) => a.diff - b.diff)
      .slice(0, 3)
      .map((x) => ({
        min: x.diff,
        clock: formatClock(x.timestamp),
        rmk: x.remarks_tc || ''
      }));
  }
  return [];
}

function renderEtaPills(etas) {
  if (!etas || etas.length === 0) {
    return `<div class="eta-row"><span class="dest-text">暫無班次資料</span></div>`;
  }
  return `<div class="eta-row">${etas.map((e) => {
    const opBadge = e.op === 'KMB'
      ? `<span class="op-tag op-KMB">九</span>`
      : (e.op === 'CTB' ? `<span class="op-tag op-CTB">城</span>` : '');

    if (e.min === null || Number.isNaN(e.min)) {
      return `<div class="eta-pill">${opBadge}<span class="eta-rmk">${esc(e.rmk || '未有資料')}</span></div>`;
    }
    const isDue = e.min <= 1;
    const minLabel = isDue ? '即將到站' : `${e.min} 分鐘`;
    return `
      <div class="eta-pill">
        ${opBadge}
        <span class="eta-min ${isDue ? 'due' : ''}">${minLabel}</span>
        <span class="eta-time">${esc(e.clock)}</span>
        ${e.rmk ? `<span class="eta-rmk">${esc(e.rmk)}</span>` : ''}
      </div>`;
  }).join('')}</div>`;
}

// --- 渲染「我的車站」---
async function renderFavorites() {
  const container = document.getElementById('favoritesList');
  const groupItems = state.favorites.filter((f) => f.group === state.activeGroup);
  const groupLabel = state.activeGroup === 'out' ? '出街' : '屋企';

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.group === state.activeGroup);
  });

  if (groupItems.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:2rem;margin-bottom:8px;">${state.activeGroup === 'out' ? '🚶' : '🏠'}</div>
        <strong>「${groupLabel}」暫時未有收藏車站</strong><br/>
        去「<b>搜尋路線</b>」或「<b>分區車站</b>」揀選巴士或小巴站，<br/>再撳 <b>☆ 收藏</b> 加入到「${groupLabel}」即可！
      </div>`;
    return;
  }

  container.innerHTML = groupItems.map((fav, idx) => `
    <div class="card" id="fav-${esc(fav.id)}">
      <div class="card-header">
        <div class="route-num">
          ${renderBadgesHtml(fav.co)}
          <div style="margin-top:4px;">${esc(fav.route)}</div>
        </div>
        <div class="route-meta">
          <div class="stop-title">${esc(fav.stopNameTc || fav.stopNameEn)}</div>
          <div class="dest-text">往 ${esc(fav.destTc || fav.destEn)}</div>
        </div>
      </div>
      ${state.editMode ? `
        <div class="edit-controls">
          <button class="edit-btn" data-move-up="${esc(fav.id)}" ${idx === 0 ? 'disabled' : ''}>↑ 上移</button>
          <button class="edit-btn" data-move-down="${esc(fav.id)}" ${idx === groupItems.length - 1 ? 'disabled' : ''}>↓ 下移</button>
          <button class="edit-btn" data-switch-group="${esc(fav.id)}">
            移至${state.activeGroup === 'out' ? '屋企' : '出街'}
          </button>
          <button class="edit-btn danger" data-del-fav="${esc(fav.id)}">✕ 刪除</button>
        </div>
      ` : `
        <div class="eta-holder"><div class="eta-row"><span class="dest-text">載入到站時間…</span></div></div>
      `}
    </div>
  `).join('');

  if (state.editMode) {
    bindEditControls();
    return;
  }

  document.getElementById('lastUpdated').textContent = '更新中…';
  await Promise.allSettled(groupItems.map(async (fav) => {
    const card = document.getElementById(`fav-${fav.id}`);
    if (!card) return;
    const holder = card.querySelector('.eta-holder');
    try {
      const etas = await fetchFavEta(fav);
      holder.innerHTML = renderEtaPills(etas);
    } catch {
      holder.innerHTML = `<div class="eta-row"><span class="dest-text">未能取得實時資料</span></div>`;
    }
  }));

  const nowStr = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  document.getElementById('lastUpdated').textContent = `更新 ${nowStr}`;
  state.countdown = REFRESH_SECONDS;
  updateCountdownUI();
}

function bindEditControls() {
  const moveWithinGroup = (id, delta) => {
    const groupIndices = [];
    state.favorites.forEach((item, i) => {
      if (item.group === state.activeGroup) groupIndices.push(i);
    });
    const posInGroup = groupIndices.findIndex((idx) => state.favorites[idx].id === id);
    const targetPos = posInGroup + delta;
    if (posInGroup < 0 || targetPos < 0 || targetPos >= groupIndices.length) return;

    const idxA = groupIndices[posInGroup];
    const idxB = groupIndices[targetPos];
    [state.favorites[idxA], state.favorites[idxB]] = [state.favorites[idxB], state.favorites[idxA]];
    saveFavs();
    renderFavorites();
  };

  document.querySelectorAll('[data-move-up]').forEach((btn) => {
    btn.addEventListener('click', () => moveWithinGroup(btn.dataset.moveUp, -1));
  });
  document.querySelectorAll('[data-move-down]').forEach((btn) => {
    btn.addEventListener('click', () => moveWithinGroup(btn.dataset.moveDown, 1));
  });
  document.querySelectorAll('[data-switch-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = findFav(btn.dataset.switchGroup);
      if (item) {
        item.group = item.group === 'out' ? 'home' : 'out';
        saveFavs();
        renderFavorites();
      }
    });
  });
  document.querySelectorAll('[data-del-fav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      removeFav(btn.dataset.delFav);
      renderFavorites();
    });
  });
}

function updateCountdownUI() {
  const el = document.getElementById('countdownText');
  if (!el) return;
  el.textContent = state.editMode ? '編輯排序模式' : `${state.countdown} 秒後自動更新`;
}

// --- 搜尋路線記錄 Chips ---
function renderSearchHistoryChips() {
  const container = document.getElementById('searchHistoryChips');
  const actionsEl = document.getElementById('historyActions');
  const clearBtn = document.getElementById('clearHistoryBtn');
  const editBtn = document.getElementById('editHistoryBtn');

  if (state.searchHistory.length === 0) {
    state.editHistoryMode = false;
    actionsEl.style.display = 'none';
    container.innerHTML = `<span class="dest-text">暫無搜尋記錄</span>`;
    return;
  }

  actionsEl.style.display = 'flex';
  clearBtn.style.display = state.editHistoryMode ? 'inline-block' : 'none';
  editBtn.classList.toggle('editing', state.editHistoryMode);
  editBtn.textContent = state.editHistoryMode ? '✓ 完成' : '✎ 編輯';

  container.innerHTML = state.searchHistory.map((r) => `
    <button class="chip ${state.editHistoryMode ? 'removable' : ''}" data-hroute="${esc(r)}">
      ${esc(r)} ${state.editHistoryMode ? '<span class="chip-del">✕</span>' : ''}
    </button>
  `).join('');

  container.querySelectorAll('[data-hroute]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const route = btn.dataset.hroute;
      if (state.editHistoryMode) {
        state.searchHistory = state.searchHistory.filter((r) => r !== route);
        saveSearchHistory();
        renderSearchHistoryChips();
      } else {
        document.getElementById('routeInput').value = route;
        searchRoute(route);
      }
    });
  });
}

// --- 聯營路線配對 (九巴 + 城巴) ---
async function tryPairJointRoutes(kmbItems, ctbItems) {
  if (kmbItems.length === 0 || ctbItems.length === 0 || state.kmbStopMap.size === 0) {
    return null;
  }

  await Promise.allSettled([
    ...kmbItems.map(async (k) => {
      const dirStr = k.bound === 'O' ? 'outbound' : 'inbound';
      const res = await fetchJson(`${KMB_BASE}/route-stop/${k.route}/${dirStr}/${k.serviceType}`);
      k.rawStops = res.data || [];
    }),
    ensureCtbStops(ctbItems.flatMap((c) => {
      const s = c.rawStops || [];
      if (s.length === 0) return [];
      return [s[0].stop, s[Math.floor(s.length / 2)].stop, s[s.length - 1].stop];
    }))
  ]);

  const stopDist = (kStopId, cStopId) => {
    const ks = state.kmbStopMap.get(kStopId);
    const cs = state.ctbStopCache[cStopId];
    if (!ks || !cs) return Infinity;
    return haversineMeters(ks.a, ks.o, parseFloat(cs.lat), parseFloat(cs.long));
  };

  const merged = [];
  const usedCtb = new Set();

  kmbItems.forEach((k) => {
    const ks = k.rawStops || [];
    if (k.serviceType !== '1' || ks.length === 0) {
      merged.push(k);
      return;
    }

    let bestCtb = null;
    let bestScore = Infinity;

    ctbItems.forEach((c, cIdx) => {
      if (usedCtb.has(cIdx)) return;
      const cs = c.rawStops || [];
      if (cs.length === 0) return;

      const dStart = stopDist(ks[0].stop, cs[0].stop);
      const dMid = stopDist(ks[Math.floor(ks.length / 2)].stop, cs[Math.floor(cs.length / 2)].stop);
      const dEnd = stopDist(ks[ks.length - 1].stop, cs[cs.length - 1].stop);

      if (dStart < 1200 && dMid < 1200 && dEnd < 1200) {
        const score = dStart + dMid + dEnd;
        if (score < bestScore) {
          bestScore = score;
          bestCtb = { c, cIdx };
        }
      }
    });

    if (bestCtb) {
      usedCtb.add(bestCtb.cIdx);
      merged.push({
        co: 'JOINT',
        route: k.route,
        kmbBound: k.bound,
        serviceType: k.serviceType,
        ctbBound: bestCtb.c.bound,
        kmbStops: ks,
        ctbStops: bestCtb.c.rawStops,
        origTc: k.origTc,
        destTc: k.destTc,
        extra: '九巴 + 城巴聯營（合併實時到站時間）'
      });
    } else {
      merged.push(k);
    }
  });

  ctbItems.forEach((c, cIdx) => {
    if (!usedCtb.has(cIdx)) merged.push(c);
  });

  return merged;
}

// --- 搜尋路線 ---
async function searchRoute(rawQuery) {
  const q = rawQuery.trim().toUpperCase();
  const out = document.getElementById('searchResults');
  if (!q) return;
  out.innerHTML = `<div class="empty-state">正在搜尋「${esc(q)}」…</div>`;

  const kmbItems = [];
  const ctbItems = [];
  const gmbItems = [];

  state.kmbRoutes
    .filter((r) => r.route === q)
    .forEach((r) => {
      kmbItems.push({
        co: 'KMB',
        route: r.route,
        bound: r.bound,
        serviceType: r.service_type,
        origTc: r.orig_tc || r.orig_en,
        destTc: r.dest_tc || r.dest_en,
        extra: r.service_type !== '1' ? `特別班次 #${r.service_type}` : ''
      });
    });

  const ctbMatch = state.ctbRoutes.find((r) => r.route === q);
  if (ctbMatch) {
    const [outStops, inStops] = await Promise.allSettled([
      fetchJson(`${CTB_BASE}/route-stop/ctb/${q}/outbound`),
      fetchJson(`${CTB_BASE}/route-stop/ctb/${q}/inbound`)
    ]);
    if (outStops.status === 'fulfilled' && (outStops.value.data || []).length > 0) {
      ctbItems.push({
        co: 'CTB', route: q, bound: 'O', direction: 'outbound',
        origTc: ctbMatch.orig_tc || ctbMatch.orig_en,
        destTc: ctbMatch.dest_tc || ctbMatch.dest_en,
        rawStops: outStops.value.data
      });
    }
    if (inStops.status === 'fulfilled' && (inStops.value.data || []).length > 0) {
      ctbItems.push({
        co: 'CTB', route: q, bound: 'I', direction: 'inbound',
        origTc: ctbMatch.dest_tc || ctbMatch.dest_en,
        destTc: ctbMatch.orig_tc || ctbMatch.orig_en,
        rawStops: inStops.value.data
      });
    }
  }

  let busResults = [...kmbItems, ...ctbItems];
  if (kmbItems.length > 0 && ctbItems.length > 0) {
    const paired = await tryPairJointRoutes(kmbItems, ctbItems);
    if (paired) busResults = paired;
  }

  const regionLabel = { KLN: '九龍', NT: '新界', HKI: '港島' };
  const gmbRegions = state.gmbLoaded
    ? ['KLN', 'NT', 'HKI'].filter((reg) => state.gmbRoutes[reg].has(q))
    : ['KLN', 'NT', 'HKI'];

  let gmbNetworkBlocked = false;
  await Promise.allSettled(
    gmbRegions.map(async (reg) => {
      try {
        const res = await fetchJson(`${GMB_BASE}/route/${reg}/${q}`);
        (res.data || []).forEach((variant) => {
          (variant.directions || []).forEach((dir) => {
            gmbItems.push({
              co: 'GMB',
              region: reg,
              route: q,
              routeId: variant.route_id,
              routeSeq: dir.route_seq,
              origTc: dir.orig_tc || dir.orig_en,
              destTc: dir.dest_tc || dir.dest_en,
              extra: `${regionLabel[reg]} ${variant.description_tc || ''}`.trim()
            });
          });
        });
      } catch (err) {
        if (err instanceof TypeError) gmbNetworkBlocked = true;
      }
    })
  );

  const results = [...busResults, ...gmbItems];

  let html = '';
  if (results.length === 0) {
    html = `<div class="empty-state">找不到路線「${esc(q)}」。<br/>請確認路線號碼（例如 <b>5A</b>、<b>22M</b>、<b>107</b>、<b>88</b>），或該路線暫未納入政府實時開放數據。</div>`;
  } else {
    recordSearchHistory(q);
    html = results.map((item, idx) => `
      <div class="card" style="cursor:pointer;" data-route-idx="${idx}">
        <div class="card-header">
          <div class="route-num">
            ${renderBadgesHtml(item.co)}
            <div style="margin-top:4px;">${esc(item.route)}</div>
          </div>
          <div class="route-meta">
            <div class="stop-title">${esc(item.origTc)} → ${esc(item.destTc)}</div>
            ${item.extra ? `<div class="eta-rmk" style="margin-top:4px;">${esc(item.extra)}</div>` : ''}
          </div>
          <span style="color:var(--muted);font-size:1.3rem;">›</span>
        </div>
      </div>
    `).join('');
  }

  if (gmbNetworkBlocked) {
    html += `<div class="warn-note">⚠️ 專線小巴資料暫時未能連線。若你正於電腦直接雙擊打開本機檔案（<code>file://</code>），部分瀏覽器會限制小巴伺服器連線；上載至 GitHub Pages 後即可正常使用。</div>`;
  }

  out.innerHTML = html;
  out.querySelectorAll('[data-route-idx]').forEach((el) => {
    el.addEventListener('click', () => openRouteStopsModal(results[Number(el.dataset.routeIdx)]));
  });
}

// --- 路線車站彈窗 ---
async function openRouteStopsModal(routeObj) {
  const backdrop = document.getElementById('modalBackdrop');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');

  title.innerHTML = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${renderBadgesHtml(routeObj.co)} <span>${esc(routeObj.route)} 往 ${esc(routeObj.destTc)}</span></div>`;
  body.innerHTML = `<div class="empty-state">正在載入沿途車站…</div>`;
  backdrop.classList.add('open');

  try {
    let stops = [];

    if (routeObj.co === 'JOINT') {
      const kStops = routeObj.kmbStops || [];
      const cStops = routeObj.ctbStops || [];
      await ensureCtbStops(cStops.map((s) => s.stop));

      const matchedCtbIndices = new Set();
      stops = kStops.map((ks, kIdx) => {
        const kInfo = state.kmbStopMap.get(ks.stop) || {};
        let bestCIdx = -1;
        let bestDist = 250;

        if (kInfo.a && kInfo.o) {
          cStops.forEach((cs, cIdx) => {
            if (matchedCtbIndices.has(cIdx)) return;
            const cInfo = state.ctbStopCache[cs.stop];
            if (!cInfo) return;
            const d = haversineMeters(kInfo.a, kInfo.o, parseFloat(cInfo.lat), parseFloat(cInfo.long));
            if (d < bestDist) {
              bestDist = d;
              bestCIdx = cIdx;
            }
          });
        }

        let ctbStopId = null;
        if (bestCIdx >= 0) {
          matchedCtbIndices.add(bestCIdx);
          ctbStopId = cStops[bestCIdx].stop;
        }

        return {
          seq: ks.seq || (kIdx + 1),
          kmbStopId: ks.stop,
          ctbStopId,
          nameTc: kInfo.t || kInfo.e || ks.stop
        };
      });

      cStops.forEach((cs, cIdx) => {
        if (matchedCtbIndices.has(cIdx)) return;
        const cInfo = state.ctbStopCache[cs.stop] || {};
        stops.push({
          seq: stops.length + 1,
          kmbStopId: null,
          ctbStopId: cs.stop,
          nameTc: `${cInfo.name_tc || cInfo.name_en || cs.stop} (城巴站)`
        });
      });
    } else if (routeObj.co === 'KMB') {
      let raw = routeObj.rawStops;
      if (!raw) {
        const dirStr = routeObj.bound === 'O' ? 'outbound' : 'inbound';
        const res = await fetchJson(`${KMB_BASE}/route-stop/${routeObj.route}/${dirStr}/${routeObj.serviceType}`);
        raw = res.data || [];
      }
      stops = raw.map((rs) => {
        const info = state.kmbStopMap.get(rs.stop) || {};
        return {
          seq: rs.seq,
          stopId: rs.stop,
          nameTc: info.t || info.e || rs.stop
        };
      });
    } else if (routeObj.co === 'CTB') {
      const raw = routeObj.rawStops || [];
      await ensureCtbStops(raw.map((s) => s.stop));
      stops = raw.map((rs) => {
        const info = state.ctbStopCache[rs.stop] || {};
        return {
          seq: rs.seq,
          stopId: rs.stop,
          nameTc: info.name_tc || info.name_en || rs.stop
        };
      });
    } else if (routeObj.co === 'GMB') {
      const res = await fetchJson(`${GMB_BASE}/route-stop/${routeObj.routeId}/${routeObj.routeSeq}`);
      stops = (res.data?.route_stops || []).map((rs) => ({
        seq: rs.stop_seq,
        stopId: String(rs.stop_id),
        stopSeq: rs.stop_seq,
        nameTc: rs.name_tc || rs.name_en
      }));
    }

    const pinButtonLabel = (fav) => {
      if (!fav) return '☆ 收藏';
      return fav.group === 'home' ? '★ 屋企' : '★ 出街';
    };

    const buildFavId = (st) => {
      if (routeObj.co === 'JOINT') {
        return `JOINT-${routeObj.route}-${routeObj.kmbBound}-${routeObj.ctbBound}-${st.kmbStopId || ''}-${st.ctbStopId || ''}`;
      }
      if (routeObj.co === 'GMB') {
        return `GMB-${routeObj.routeId}-${routeObj.routeSeq}-${st.stopSeq}`;
      }
      return `${routeObj.co}-${routeObj.route}-${routeObj.bound}-${routeObj.serviceType || '1'}-${st.stopId}`;
    };

    body.innerHTML = stops.map((st, idx) => {
      const existing = findFav(buildFavId(st));
      return `
        <div class="stop-item" data-stop-idx="${idx}">
          <div class="stop-item-top">
            <div class="stop-title" style="margin:0;">${st.seq}. ${esc(st.nameTc)}</div>
            <button class="pin-btn ${existing ? 'pinned' : ''}" data-pin-idx="${idx}">
              ${pinButtonLabel(existing)}
            </button>
          </div>
          <div class="stop-eta-box" id="modal-eta-${idx}"></div>
        </div>
      `;
    }).join('');

    body.querySelectorAll('[data-stop-idx]').forEach((row) => {
      const idx = Number(row.dataset.stopIdx);
      const st = stops[idx];
      const favObj = routeObj.co === 'JOINT'
        ? {
            id: buildFavId(st),
            co: 'JOINT',
            route: routeObj.route,
            kmbBound: routeObj.kmbBound,
            serviceType: routeObj.serviceType || '1',
            kmbStopId: st.kmbStopId,
            ctbBound: routeObj.ctbBound,
            ctbStopId: st.ctbStopId,
            stopNameTc: st.nameTc,
            destTc: routeObj.destTc
          }
        : {
            id: buildFavId(st),
            co: routeObj.co,
            route: routeObj.route,
            bound: routeObj.bound || '',
            serviceType: routeObj.serviceType || '1',
            routeId: routeObj.routeId || '',
            routeSeq: routeObj.routeSeq || '',
            stopSeq: st.stopSeq || '',
            stopId: st.stopId,
            stopNameTc: st.nameTc,
            destTc: routeObj.destTc
          };

      const pinBtn = row.querySelector('[data-pin-idx]');
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openGroupPicker(favObj, () => {
          const updated = findFav(favObj.id);
          pinBtn.classList.toggle('pinned', !!updated);
          pinBtn.textContent = pinButtonLabel(updated);
          renderFavorites();
        });
      });

      row.addEventListener('click', async () => {
        const box = document.getElementById(`modal-eta-${idx}`);
        box.innerHTML = `<div class="eta-row"><span class="dest-text">載入到站時間…</span></div>`;
        try {
          const etas = await fetchFavEta(favObj);
          box.innerHTML = renderEtaPills(etas);
        } catch {
          box.innerHTML = `<div class="eta-row"><span class="dest-text">未能取得實時資料</span></div>`;
        }
      });
    });
  } catch {
    body.innerHTML = `<div class="empty-state">無法載入車站資料。</div>`;
  }
}

// --- 分區 / 附近車站 ---
function renderAreaStops() {
  const list = document.getElementById('areaStopsList');
  if (state.kmbStops.length === 0) {
    list.innerHTML = `<div class="empty-state">正在同步香港車站資料庫…</div>`;
    return;
  }

  if (state.activeArea === 'nearby') {
    list.innerHTML = `<div class="empty-state">正在取得 GPS 定位…</div>`;
    if (!navigator.geolocation) {
      list.innerHTML = `<div class="empty-state">此裝置不支援定位功能。</div>`;
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const nearest = state.kmbStops
          .map((s) => ({ ...s, dist: haversineMeters(latitude, longitude, s.a, s.o) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 20);
        displayStopList(nearest, list);
      },
      () => {
        list.innerHTML = `<div class="empty-state">未能取得定位權限，請點擊上方分區標籤瀏覽車站！</div>`;
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
    return;
  }

  const keywords = AREA_KEYWORDS[state.activeArea] || [];
  const matches = state.kmbStops
    .filter((s) => {
      const en = (s.e || '').toLowerCase();
      const tc = s.t || '';
      return keywords.some((kw) => en.includes(kw) || tc.includes(kw));
    })
    .slice(0, 45);

  displayStopList(matches, list);
}

function displayStopList(stops, container) {
  if (stops.length === 0) {
    container.innerHTML = `<div class="empty-state">找不到相關車站。</div>`;
    return;
  }
  container.innerHTML = stops.map((s, idx) => `
    <div class="card" data-area-stop="${idx}" style="cursor:pointer;">
      <div class="card-header">
        <div class="route-meta">
          <div class="stop-title">${esc(s.t || s.e)}</div>
        </div>
        ${s.dist !== undefined ? `<span class="sub-pill">${s.dist} 米</span>` : '<span style="color:var(--muted);font-size:0.85rem;">查看班次 ›</span>'}
      </div>
      <div id="area-stop-etas-${idx}"></div>
    </div>
  `).join('');

  container.querySelectorAll('[data-area-stop]').forEach((el) => {
    el.addEventListener('click', async () => {
      const idx = Number(el.dataset.areaStop);
      const stop = stops[idx];
      const box = document.getElementById(`area-stop-etas-${idx}`);
      if (box.dataset.loaded === '1') {
        box.innerHTML = '';
        box.dataset.loaded = '0';
        return;
      }
      box.innerHTML = `<div class="eta-row"><span class="dest-text">載入該站所有巴士班次…</span></div>`;
      try {
        const res = await fetchJson(`${KMB_BASE}/stop-eta/${stop.s}`);
        const rawByRoute = new Map();
        (res.data || []).forEach((item) => {
          const key = `${item.route}-${item.dir}-${item.service_type}`;
          if (!rawByRoute.has(key)) {
            rawByRoute.set(key, {
              route: item.route,
              dir: item.dir,
              serviceType: item.service_type,
              destTc: item.dest_tc || item.dest_en,
              items: []
            });
          }
          rawByRoute.get(key).items.push(item);
        });

        if (rawByRoute.size === 0) {
          box.innerHTML = `<div class="eta-row"><span class="dest-text">此站現時未有班次。</span></div>`;
        } else {
          const pinLabel = (fav) => !fav ? '☆' : (fav.group === 'home' ? '★ 屋企' : '★ 出街');
          box.innerHTML = Array.from(rawByRoute.values()).map((g) => {
            const sortedEtas = processBusEtas(g.items, g.dir).slice(0, 2);
            const favId = `KMB-${g.route}-${g.dir}-${g.serviceType}-${stop.s}`;
            const existing = findFav(favId);
            const etaText = sortedEtas.length === 0
              ? '暫無班次'
              : sortedEtas.map((e) => {
                  if (e.min === null) return e.rmk || '-';
                  return e.min <= 1 ? '即將到站' : `${e.min}分`;
                }).join('、');

            return `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid rgba(148,163,184,0.15);">
                <div>
                  <span class="badge badge-KMB">${esc(g.route)}</span>
                  <span style="font-size:0.86rem;margin-left:6px;">往 ${esc(g.destTc)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <strong style="color:var(--accent);font-size:0.88rem;">${esc(etaText)}</strong>
                  <button class="pin-btn ${existing ? 'pinned' : ''}"
                    data-pin-area='${esc(JSON.stringify({
                      id: favId, co: 'KMB', route: g.route, bound: g.dir, serviceType: g.serviceType,
                      stopId: stop.s, stopNameTc: stop.t || stop.e, destTc: g.destTc
                    }))}'>${pinLabel(existing)}</button>
                </div>
              </div>`;
          }).join('');

          box.querySelectorAll('[data-pin-area]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const obj = JSON.parse(btn.dataset.pinArea);
              openGroupPicker(obj, () => {
                const updated = findFav(obj.id);
                btn.classList.toggle('pinned', !!updated);
                btn.textContent = !updated ? '☆' : (updated.group === 'home' ? '★ 屋企' : '★ 出街');
                renderFavorites();
              });
            });
          });
        }
        box.dataset.loaded = '1';
      } catch {
        box.innerHTML = `<div class="eta-row"><span class="dest-text">載入班次失敗。</span></div>`;
      }
    });
  });
}

// --- 地圖 (即時交通頁) ---
function initMap() {
  if (state.map || typeof L === 'undefined') return;
  state.map = L.map('map').setView([22.3215, 114.2035], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(state.map);

  const landmarks = [
    { name: '啟德', lat: 22.3305, lng: 114.1995 },
    { name: '土瓜灣', lat: 22.3175, lng: 114.1885 },
    { name: '紅磡', lat: 22.3030, lng: 114.1815 },
    { name: '九龍灣 / 德福', lat: 22.3233, lng: 114.2140 }
  ];
  landmarks.forEach((lm) => {
    L.circleMarker([lm.lat, lm.lng], { radius: 7, color: '#38bdf8', fillOpacity: 0.85 })
      .addTo(state.map)
      .bindPopup(lm.name);
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
        radius: 8, color: '#4ade80', fillColor: '#4ade80', fillOpacity: 1
      }).addTo(state.map).bindPopup('你嘅位置');
    });
  }
}

// --- 頁面導航及按鈕事件 ---
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');

    if (tab === 'home') renderFavorites();
    if (tab === 'area') renderAreaStops();
    if (tab === 'traffic') {
      initMap();
      setTimeout(() => state.map && state.map.invalidateSize(), 150);
    }
  });
});

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.activeGroup = btn.dataset.group;
    localStorage.setItem('hk_active_group', state.activeGroup);
    renderFavorites();
  });
});

document.getElementById('editOrderBtn').addEventListener('click', (e) => {
  state.editMode = !state.editMode;
  e.currentTarget.classList.toggle('editing', state.editMode);
  e.currentTarget.textContent = state.editMode ? '✓ 完成' : '✎ 編輯';
  updateCountdownUI();
  renderFavorites();
});

// 編輯 / 清除搜尋路線記錄
document.getElementById('editHistoryBtn').addEventListener('click', () => {
  state.editHistoryMode = !state.editHistoryMode;
  renderSearchHistoryChips();
});

document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  state.searchHistory = [];
  saveSearchHistory();
  renderSearchHistoryChips();
});

document.querySelectorAll('[data-pick-group]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.pendingPin) {
      addFav(state.pendingPin.favObj, btn.dataset.pickGroup);
      if (state.pendingPin.onDone) state.pendingPin.onDone();
      state.pendingPin = null;
    }
    document.getElementById('groupPickerBackdrop').classList.remove('open');
  });
});

document.getElementById('cancelPickerBtn').addEventListener('click', () => {
  state.pendingPin = null;
  document.getElementById('groupPickerBackdrop').classList.remove('open');
});

document.getElementById('searchBtn').addEventListener('click', () => {
  searchRoute(document.getElementById('routeInput').value);
});
document.getElementById('routeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchRoute(e.target.value);
});

document.querySelectorAll('#areaChips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#areaChips .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.activeArea = chip.dataset.area;
    renderAreaStops();
  });
});

document.getElementById('closeModalBtn').addEventListener('click', () => {
  document.getElementById('modalBackdrop').classList.remove('open');
});
document.getElementById('modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') e.currentTarget.classList.remove('open');
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  if (document.getElementById('tab-home').classList.contains('active') && !state.editMode) {
    renderFavorites();
  }
  if (document.getElementById('tab-area').classList.contains('active')) {
    renderAreaStops();
  }
});

setInterval(() => {
  if (
    document.hidden ||
    state.editMode ||
    !document.getElementById('tab-home').classList.contains('active')
  ) {
    return;
  }
  state.countdown -= 1;
  if (state.countdown <= 0) {
    state.countdown = REFRESH_SECONDS;
    renderFavorites();
  } else {
    updateCountdownUI();
  }
}, 1000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

renderSearchHistoryChips();
renderFavorites();
initData();