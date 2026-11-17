'use strict';
/* 대진여객 배차 — 휴대폰용 배차 조회 앱
   데이터: data/index.json, data/YYYY-MM-DD.json (카페 일일 배차표를 옮겨 적은 파일)
   설정: data/app-config.json  {"defaultPerson":"박병수"}  (없으면 기본값 사용) */
(function () {

  var ROUTES = ['115-1', '189-1', '129-1', '189', '187'];
  /* 표의 굵은 세로선 = 교대 경계. 값은 '오전 마지막 회차' 번호 */
  var BOUNDARY = { '189-1': 3, '115-1': 2, '129-1': 2 };
  var WD = ['일', '월', '화', '수', '목', '금', '토'];
  var STORE_KEY = 'dj_person_v1';
  var FALLBACK_PERSON = '박병수';

  var S = {
    person: null,
    tab: 'mine',
    index: [],          // [{date, weekday, routes}]
    data: {},           // date -> 배차 JSON | null
    loading: {},
    config: null,
    lookup: { date: null, route: null, shift: 'am' },
    open: null,
    booted: false
  };

  /* ---------------- 유틸 ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) { return String(s == null ? '' : s).replace(/[\s?？]/g, ''); }

  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  function kstToday() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (e) {
      var d = new Date();
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
  }
  function pdate(s) {
    var a = String(s).split('-').map(Number);
    return new Date(Date.UTC(a[0], a[1] - 1, a[2]));
  }
  function isoOf(d) { return d.toISOString().slice(0, 10); }
  function addDays(s, n) {
    var d = pdate(s); d.setUTCDate(d.getUTCDate() + n); return isoOf(d);
  }
  function wdOf(s) { return WD[pdate(s).getUTCDay()]; }
  function dLabel(s) { var a = String(s).split('-').map(Number); return a[1] + '/' + a[2]; }
  function mLabel(s) { var a = String(s).split('-').map(Number); return a[1] + '월 ' + a[2] + '일'; }
  function fullLabel(s) { return mLabel(s) + ' (' + wdOf(s) + ')'; }
  function mondayOf(s) {
    var d = pdate(s); var w = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - w); return isoOf(d);
  }
  function weekDays(mon) {
    var out = []; for (var i = 0; i < 7; i++) out.push(addDays(mon, i)); return out;
  }

  /* ---------------- 데이터 ---------------- */
  function loadConfig() {
    return fetch('data/app-config.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (c) { S.config = c || {}; return S.config; });
  }

  function loadIndex() {
    return fetch('data/index.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function (j) {
        var list = (j && j.dates) || [];
        S.index = list.map(function (x) {
          return typeof x === 'string' ? { date: x } : { date: x.date, routes: x.routes || [] };
        }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        return S.index;
      })
      .catch(function () { return probeDates(); });
  }

  /* index.json 이 없을 때: 최근 날짜 파일을 직접 확인 */
  function probeDates() {
    var today = kstToday();
    var list = [];
    var checks = [];
    for (var i = -21; i <= 14; i++) {
      (function (ds) {
        checks.push(fetch('data/' + ds + '.json', { method: 'HEAD', cache: 'no-store' })
          .then(function (r) { if (r.ok) list.push({ date: ds }); })
          .catch(function () {}));
      })(addDays(today, i));
    }
    return Promise.all(checks).then(function () {
      list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      S.index = list;
      return S.index;
    });
  }

  function loadDate(ds) {
    if (Object.prototype.hasOwnProperty.call(S.data, ds)) return Promise.resolve(S.data[ds]);
    return fetch('data/' + ds + '.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .catch(function () { return null; })
      .then(function (j) { S.data[ds] = j; return j; });
  }

  /* 표 판독이 불확실한 줄인지 (이름 대신 노선·연번·교대로 표시) */
  function isUncertainRow(ds, route, no, shift) {
    var d = S.data[ds];
    if (!d) return false;
    var list = d.uncertain || [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (x && x.route === route && x.no === no && (!x.shift || x.shift === shift)) return true;
    }
    return false;
  }

  function tripList(v, shift, route) {
    var b = BOUNDARY[route];
    var trips = v.trips || [];
    if (!b) return trips.slice();
    return trips.filter(function (t) { return shift === 'am' ? t.no <= b : t.no > b; });
  }

  function hasName(str, p) {
    if (!str) return false;
    var toks = String(str).split(/[\s,·、]+/);
    for (var i = 0; i < toks.length; i++) if (toks[i] && norm(toks[i]) === p) return true;
    return false;
  }

  function furloughHits(d, person) {
    var f = (d && d.furlough) || {};
    var p = norm(person);
    var hits = [];
    Object.keys(f).forEach(function (route) {
      if (route === '예비') return;
      var str = String(f[route] || '');
      if (!str) return;
      var parts = str.split('/');
      if (parts.length === 1) {
        if (hasName(parts[0], p)) hits.push({ route: route, shift: 'all' });
      } else {
        if (hasName(parts[0], p)) hits.push({ route: route, shift: 'am' });
        if (hasName(parts.slice(1).join('/'), p)) hits.push({ route: route, shift: 'pm' });
      }
    });
    return hits;
  }

  function reserveHit(d, person) {
    var f = (d && d.furlough) || {};
    return hasName(f['예비'] || '', norm(person));
  }

  /* 그 날 그 사람의 배차 상태 */
  function resolveDay(ds, person) {
    if (S.loading[ds]) return { kind: 'loading' };
    var d = S.data[ds];
    if (d === undefined || d === null) return { kind: 'nodata' };
    var p = norm(person);
    var items = [];
    (d.routes || []).forEach(function (r) {
      var hasB = !!BOUNDARY[r.route];
      (r.vehicles || []).forEach(function (v) {
        if (v.am_driver && norm(v.am_driver) === p) {
          items.push({
            route: r.route, vehicle: v.vehicle, company: v.company, shift: 'am', vno: v.no,
            driver: v.am_driver, trips: tripList(v, 'am', r.route), hasBoundary: hasB
          });
        }
        if (v.pm_driver && norm(v.pm_driver) === p) {
          items.push({
            route: r.route, vehicle: v.vehicle, company: v.company, shift: 'pm', vno: v.no,
            driver: v.pm_driver, trips: tripList(v, 'pm', r.route), hasBoundary: hasB
          });
        }
      });
    });
    if (items.length) return { kind: 'ok', items: items };
    var off = furloughHits(d, person);
    if (off.length) return { kind: 'off', hits: off };
    if (reserveHit(d, person)) return { kind: 'reserve' };
    return { kind: 'none' };
  }

  function pickDate(today) {
    if (!S.index.length) return null;
    var dates = S.index.map(function (x) { return x.date; });
    if (dates.indexOf(today) >= 0) return today;
    for (var i = 0; i < dates.length; i++) if (dates[i] > today) return dates[i];
    return dates[dates.length - 1];
  }

  /* ---------------- 그리기: 내 배차 ---------------- */
  function tripHtml(t, big) {
    var time = t.depart ? t.depart : (t.raw || '—');
    if (big) {
      return '<span class="cell"><em>' + t.no + '회</em><strong>' + esc(time) + '</strong>' +
        (t.depart && t.derived ? '<span class="approx">≈</span>' : '') + '</span>';
    }
    return '<span class="tr"><b>' + t.no + '회</b>' + esc(time) +
      (t.depart && t.derived ? '<span class="approx">≈</span>' : '') + '</span>';
  }

  function cardHtml(ds, opts) {
    var info = resolveDay(ds, S.person);
    var isToday = (ds === opts.todayDate);
    var cls = 'card' + (isToday ? ' today' : '');
    var dateBit = '<span class="cdate">' + fullLabel(ds) + '</span>';

    if (info.kind === 'loading') {
      return '<div class="' + cls + ' empty"><div class="ctop">' + dateBit +
        '<span class="pill">불러오는 중</span></div></div>';
    }
    if (info.kind === 'nodata') {
      var future = ds > kstToday();
      return '<div class="' + cls + ' empty"><div class="ctop">' + dateBit +
        '<span class="pill">' + (future ? '배차표 준비 중' : '배차표 없음') + '</span></div>' +
        '<div class="cnote">' + (future ? '이 날 표가 아직 카페에 올라오지 않았습니다.'
          : '이 날짜 배차표가 아직 없습니다.') + '</div></div>';
    }
    if (info.kind === 'off') {
      var h = info.hits[0];
      var sh = h.shift === 'am' ? '오전 ' : (h.shift === 'pm' ? '오후 ' : '');
      return '<div class="' + cls + ' empty"><div class="ctop">' + dateBit +
        '<span class="pill pill-off">휴무</span></div>' +
        '<div class="cnote">' + esc(h.route) + '번 ' + sh + '휴무 · 이 날은 배차가 없습니다.</div></div>';
    }
    if (info.kind === 'reserve') {
      return '<div class="' + cls + ' empty"><div class="ctop">' + dateBit +
        '<span class="pill">예비</span></div>' +
        '<div class="cnote">예비 명단에 있습니다. 배차는 당일 정해질 수 있습니다.</div></div>';
    }
    if (info.kind === 'none') {
      return '<div class="' + cls + ' empty"><div class="ctop">' + dateBit +
        '<span class="pill">배차 없음</span></div>' +
        '<div class="cnote">이 날짜 표에 내 이름이 없습니다.</div></div>';
    }

    var pills = info.items.map(function (it) {
      return '<span class="pill pill-shift">' + (it.shift === 'am' ? '오전' : '오후') + '</span>';
    }).join('');
    var body = info.items.map(function (it) {
      var meta = it.route + '번 · ' + (it.vehicle ? ('차량 ' + it.vehicle + '번') : (it.company || '차량 정보 없음'));
      var trips = it.trips.length
        ? it.trips.map(function (t) { return tripHtml(t, false); }).join('')
        : '<span class="hint">이 교대 회차 없음</span>';
      var extra = '';
      if (!it.hasBoundary) {
        extra = '<div class="cnote">이 노선은 표에 교대 구분선이 없어 전체 회차를 표시합니다.</div>';
      }
      if (isUncertainRow(ds, it.route, it.vno, it.shift)) {
        extra += '<div class="cnote">이 줄은 이름 판독이 불확실합니다(다른 이름일 수 있음).</div>';
      }
      return '<div class="citem"><div class="cmeta">' + esc(meta) + '</div>' +
        '<div class="ctrips">' + trips + '</div>' + extra + '</div>';
    }).join('');

    return '<div class="' + cls + '"><div class="ctop">' + dateBit +
      (isToday ? '<span class="pill pill-today">오늘</span>' : '') +
      '<span class="cspacer"></span>' + pills + '</div>' + body + '</div>';
  }

  function renderMine() {
    var wrap = $('#mine');
    var today = kstToday();
    var todayDate = pickDate(today);
    if (!todayDate) {
      wrap.innerHTML = '<div class="loading">배차 데이터를 불러오는 중…</div>';
      $('#mineFoot').innerHTML = '';
      return;
    }
    var html = '';
    html += '<h2 class="grouphead"><span>' +
      (todayDate === today ? '오늘 내 배차' : '가장 가까운 날 내 배차') +
      '</span><span class="grange">' + esc(S.person) + ' 님</span></h2>';
    html += cardHtml(todayDate, { todayDate: todayDate });

    var mon = mondayOf(today);
    var w1 = weekDays(mon);
    var w2 = weekDays(addDays(mon, 7));
    html += '<h2 class="grouphead"><span>이번 주 내 배차</span><span class="grange">' +
      dLabel(w1[0]) + '~' + dLabel(w1[6]) + '</span></h2>';
    html += w1.map(function (d) { return cardHtml(d, { todayDate: todayDate }); }).join('');
    html += '<h2 class="grouphead"><span>다음 주 내 배차</span><span class="grange">' +
      dLabel(w2[0]) + '~' + dLabel(w2[6]) + '</span></h2>';
    html += w2.map(function (d) { return cardHtml(d, { todayDate: todayDate }); }).join('');
    wrap.innerHTML = html;

    var first = S.index.length ? S.index[0].date : '';
    var last = S.index.length ? S.index[S.index.length - 1].date : '';
    var foot = '≈ 표에 분(分)만 인쇄된 칸은 위 회차의 시(時)를 이어받아 복원한 시각입니다.';
    if (first && last) foot += '<br><b>배차 데이터</b> ' + dLabel(first) + '~' + dLabel(last) +
      ' (' + S.index.length + '일치) · 휴무는 그 날 배차표의 휴무 명단을 근거로 표시합니다.';
    $('#mineFoot').innerHTML = foot;
  }

  /* ---------------- 그리기: 조회 ---------------- */
  function maxTripNo(r) {
    var m = 0;
    (r.vehicles || []).forEach(function (v) {
      (v.trips || []).forEach(function (t) { if (t.no > m) m = t.no; });
    });
    return m;
  }

  function ensureLookup() {
    if (!S.index.length) return;
    var dates = S.index.map(function (x) { return x.date; });
    if (!S.lookup.date || dates.indexOf(S.lookup.date) < 0) {
      var today = kstToday();
      S.lookup.date = dates.indexOf(today) >= 0 ? today : dates[0];
    }
    if (!S.lookup.route) S.lookup.route = '189-1';
    if (dates.indexOf(S.lookup.date) >= 0) {
      var d = S.data[S.lookup.date];
      if (d && d.routes) {
        var have = d.routes.map(function (r) { return r.route; });
        if (have.indexOf(S.lookup.route) < 0) S.lookup.route = have[0] || null;
      }
    }
  }

  function renderLookup() {
    ensureLookup();
    var today = kstToday();

    /* 날짜 칩 */
    var dc = $('#dateChips');
    if (!S.index.length) {
      dc.innerHTML = '<span class="hint">날짜를 불러오는 중…</span>';
    } else {
      dc.innerHTML = S.index.map(function (x) {
        var on = x.date === S.lookup.date;
        return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-date="' + x.date + '">' +
          dLabel(x.date) + '<span class="w">' + wdOf(x.date) + '</span></button>';
      }).join('');
      var onChip = dc.querySelector('.chip.on');
      if (onChip && dc.clientWidth) {
        dc.scrollLeft = Math.max(0, onChip.offsetLeft - (dc.clientWidth - onChip.clientWidth) / 2);
      }
    }

    /* 노선 칩 */
    var rc = $('#routeChips');
    var d = S.data[S.lookup.date];
    var have = [];
    if (d && d.routes) have = d.routes.map(function (r) { return r.route; });
    rc.innerHTML = ROUTES.map(function (r) {
      var ok = have.indexOf(r) >= 0;
      var on = r === S.lookup.route;
      return '<button type="button" class="chip' + (on ? ' on' : '') + (ok ? '' : ' off') +
        '" data-route="' + r + '"' + (ok ? '' : ' disabled aria-disabled="true"') + '>' + r +
        (ok ? '' : '<span class="w">준비 중</span>') + '</button>';
    }).join('');

    /* 오전/오후 */
    Array.prototype.forEach.call($('#shiftSeg').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-shift') === S.lookup.shift);
      b.setAttribute('aria-selected', b.getAttribute('data-shift') === S.lookup.shift ? 'true' : 'false');
    });

    renderRows();
  }

  function renderRows() {
    var ds = S.lookup.date, route = S.lookup.route, shift = S.lookup.shift;
    var box = $('#rows');
    var head = $('#listHead');
    var d = ds ? S.data[ds] : undefined;

    if (!ds) { box.innerHTML = '<div class="loading">불러오는 중…</div>'; head.innerHTML = ''; return; }
    if (S.loading[ds]) {
      box.innerHTML = '<div class="loading">불러오는 중…</div>';
      head.innerHTML = '<span>' + dLabel(ds) + ' 배차표</span>';
      return;
    }
    if (!d) {
      head.innerHTML = '<span>' + fullLabel(ds) + '</span><span class="cnt">배차표 준비 중</span>';
      box.innerHTML = '<div class="emptybox">이 날짜 배차표가 아직 없습니다.<br>표가 올라오면 자동으로 채워집니다.</div>';
      $('#lookupFoot').innerHTML = '';
      return;
    }
    var r = null;
    (d.routes || []).forEach(function (x) { if (x.route === route) r = x; });
    if (!r) {
      head.innerHTML = '<span>' + fullLabel(ds) + ' · ' + esc(route || '') + '번</span><span class="cnt">준비 중</span>';
      box.innerHTML = '<div class="emptybox">' + fullLabel(ds) + ' 표에 ' + esc(route || '') +
        '번은 아직 옮겨 적지 않았습니다.<br>지금은 115-1·189-1 두 노선만 들어 있습니다.</div>';
      $('#lookupFoot').innerHTML = '';
      return;
    }

    var b = BOUNDARY[route];
    var mx = maxTripNo(r);
    var rangeTxt = b ? (shift === 'am' ? '오전 1~' + b + '회' : '오후 ' + (b + 1) + '~' + mx + '회')
      : '전체 회차';
    head.innerHTML = '<span>' + esc(route) + '번 · ' + rangeTxt + '</span><span class="cnt">' +
      (r.vehicles || []).length + '대</span>';

    var rows = (r.vehicles || []).slice().sort(function (a, b2) { return a.no - b2.no; });
    var p = norm(S.person);
    var html = rows.map(function (v) {
      var driver = shift === 'am' ? v.am_driver : v.pm_driver;
      var mine = !!driver && norm(driver) === p;
      var unc = isUncertainRow(ds, route, v.no, shift);
      var trips = tripList(v, shift, route);
      var key = ds + '|' + route + '|' + shift + '|' + v.no;
      var open = (S.open === key);
      var nameHtml = driver
        ? '<span class="rowname">' + esc(driver) + (unc ? '<span class="qmark">?</span>' : '') + '</span>'
        : '<span class="rowname muted">이름 없음</span>';
      var veh = v.vehicle ? ('차량 ' + v.vehicle + '번') : (v.company || '차량 정보 없음');
      var tripsHtml = trips.length
        ? trips.map(function (t) { return tripHtml(t, false); }).join('')
        : '<span class="hint">이 교대 회차 없음</span>';
      var bigHtml = trips.map(function (t) { return tripHtml(t, true); }).join('');
      var saveBtn = (driver && !mine)
        ? '<button type="button" class="rowsave" data-save="' + esc(driver) + '">' +
          esc(driver) + ' 님을 내 이름으로 저장</button>'
        : '';
      var unsure = unc
        ? '<div class="rowunsure">이 줄은 표 판독이 불확실합니다. 다른 이름일 수 있습니다.</div>'
        : '';
      return '<div class="row' + (mine ? ' mine' : '') + (open ? ' open' : '') + '" role="button" tabindex="0" data-key="' +
        esc(key) + '"><div class="rowline">' + nameHtml +
        '<span class="rowveh">' + esc(veh) + '</span>' +
        (mine ? '<span class="badge">내 배차</span>' : '') + '</div>' +
        '<div class="rtrips">' + tripsHtml + '</div>' +
        '<div class="rbig">' + bigHtml + '</div>' + unsure + saveBtn + '</div>';
    }).join('');

    box.innerHTML = html || '<div class="emptybox">이 교대에 근무자가 없습니다.</div>';

    var foot = '≈ 표에 분(分)만 인쇄된 칸은 위 회차의 시(時)를 이어받아 복원한 시각입니다.';
    if (!b) foot += '<br>이 노선은 표에 오전/오후 굵은 구분선이 없어 차량 전체 회차를 보여줍니다.';
    $('#lookupFoot').innerHTML = foot;
  }

  /* ---------------- 이름 시트 ---------------- */
  function allNames() {
    var set = {};
    Object.keys(S.data).forEach(function (ds) {
      var d = S.data[ds];
      if (!d || !d.routes) return;
      d.routes.forEach(function (r) {
        (r.vehicles || []).forEach(function (v) {
          if (v.am_driver) set[v.am_driver] = 1;
          if (v.pm_driver) set[v.pm_driver] = 1;
        });
      });
    });
    var arr = Object.keys(set);
    arr.sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    var def = defaultPerson();
    if (arr.indexOf(def) < 0) arr.unshift(def);
    return arr;
  }
  function defaultPerson() {
    return (S.config && S.config.defaultPerson) || FALLBACK_PERSON;
  }

  function renderNameList(filter) {
    var q = norm(filter || '');
    var list = allNames().filter(function (n) { return !q || norm(n).indexOf(q) >= 0; });
    var cur = norm(S.person);
    $('#nameList').innerHTML = list.length
      ? list.map(function (n) {
        var on = norm(n) === cur;
        return '<button type="button" class="nameitem' + (on ? ' cur' : '') + '" data-name="' + esc(n) + '">' +
          '<span>' + esc(n) + '</span>' + (on ? '<span class="ck">내 배차</span>' : '') + '</button>';
      }).join('')
      : '<div class="emptybox">그런 이름이 없습니다.</div>';
  }

  function openSheet() {
    $('#sheetWrap').hidden = false;
    $('#nameSearch').value = '';
    renderNameList('');
    setTimeout(function () { try { $('#nameSearch').focus(); } catch (e) {} }, 60);
  }
  function closeSheet() { $('#sheetWrap').hidden = true; }

  function setPerson(name) {
    if (!name) return;
    S.person = name;
    storeSet(STORE_KEY, name);
    closeSheet();
    render();
  }

  /* ---------------- 공통 그리기 ---------------- */
  function renderChrome() {
    $('#personName').textContent = S.person || defaultPerson();
    var today = kstToday();
    var t = '오늘 ' + fullLabel(today);
    if (!S.index.length) t += ' · 불러오는 중';
    $('#topSub').textContent = t;
  }

  function render() {
    renderChrome();
    if (S.tab === 'mine') {
      $('#viewMine').hidden = false;
      $('#viewLookup').hidden = true;
      renderMine();
    } else {
      $('#viewMine').hidden = true;
      $('#viewLookup').hidden = false;
      renderLookup();
    }
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === S.tab);
    });
  }

  function setTab(tab) {
    if (tab !== 'mine' && tab !== 'lookup') return;
    S.tab = tab;
    storeSet('dj_tab_v1', tab);
    render();
    window.scrollTo(0, 0);
  }

  /* ---------------- 이벤트 ---------------- */
  function wire() {
    $('#personBtn').addEventListener('click', openSheet);
    $('#sheetWrap').addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-close')) closeSheet();
      var btn = t && t.closest ? t.closest('[data-name]') : null;
      if (btn) setPerson(btn.getAttribute('data-name'));
    });
    $('#nameSearch').addEventListener('input', function (e) { renderNameList(e.target.value); });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
    });

    $('#dateChips').addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-date]') : null;
      if (!c) return;
      S.lookup.date = c.getAttribute('data-date');
      S.lookup.route = null;
      S.open = null;
      ensureLookup();
      renderLookup();
    });

    $('#routeChips').addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-route]') : null;
      if (!c || c.disabled) return;
      S.lookup.route = c.getAttribute('data-route');
      S.open = null;
      renderLookup();
    });

    $('#shiftSeg').addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-shift]') : null;
      if (!c) return;
      S.lookup.shift = c.getAttribute('data-shift');
      S.open = null;
      renderLookup();
    });

    $('#rows').addEventListener('click', function (e) {
      var save = e.target.closest ? e.target.closest('[data-save]') : null;
      if (save) { e.stopPropagation(); setPerson(save.getAttribute('data-save')); return; }
      var row = e.target.closest ? e.target.closest('.row') : null;
      if (!row) return;
      var key = row.getAttribute('data-key');
      S.open = (S.open === key) ? null : key;
      renderRows();
    });

    $('#rows').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target.closest ? e.target.closest('.row') : null;
      if (!row || e.target !== row) return;
      e.preventDefault();
      var key = row.getAttribute('data-key');
      S.open = (S.open === key) ? null : key;
      renderRows();
    });
  }

  /* ---------------- 시작 ---------------- */
  var lastLoad = 0;

  /* 앱을 다시 열었을 때 새 배차표를 다시 확인한다 */
  function refreshData() {
    return loadIndex().then(function () {
      var today = kstToday();
      var todo = S.index.map(function (x) { return x.date; }).filter(function (d) {
        return d >= today || !Object.prototype.hasOwnProperty.call(S.data, d);
      });
      if (!todo.length) { render(); return null; }
      todo.forEach(function (d) {
        if (Object.prototype.hasOwnProperty.call(S.data, d)) delete S.data[d];
        S.loading[d] = true;
      });
      render();
      return Promise.all(todo.map(function (d) {
        return loadDate(d).then(function () { delete S.loading[d]; });
      })).then(function () { render(); });
    }).catch(function () {});
  }

  function boot() {
    wire();
    ensureStart();
    lastLoad = Date.now();
    S.tab = storeGet('dj_tab_v1') === 'lookup' ? 'lookup' : 'mine';
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad > 5 * 60 * 1000) {
        lastLoad = Date.now();
        refreshData();
      }
    });

    var today = kstToday();
    var first = pickDate(today);

    Promise.all([loadConfig(), loadIndex()]).then(function () {
      S.person = storeGet(STORE_KEY) || defaultPerson();
      first = pickDate(today);
      if (S.index.length) {
        S.index.forEach(function (x) { if (!Object.prototype.hasOwnProperty.call(S.data, x.date)) S.loading[x.date] = true; });
      }
      ensureLookup();
      render();

      if (!first) return;

      loadDate(first).then(function () {
        delete S.loading[first];
        render();
        var rest = S.index.map(function (x) { return x.date; });
        return Promise.all(rest.map(function (ds) {
          return loadDate(ds).then(function () { delete S.loading[ds]; });
        }));
      }).then(function () {
        render();
        S.booted = true;
      });
    }).catch(function () {
      $('#mine').innerHTML = '<div class="emptybox">배차 데이터를 불러오지 못했습니다.<br>인터넷 연결을 확인한 뒤 앱을 다시 열어 주세요.</div>';
    });
  }

  function ensureStart() {
    /* localStorage 에 저장된 이름이 비어 있으면 기본값 */
    S.person = storeGet(STORE_KEY) || FALLBACK_PERSON;
    renderChrome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 화면 점검용 통로 (앱 동작에는 영향 없음) */
  window.__dj = {
    state: S,
    render: render,
    setTab: setTab,
    lookup: function (o) {
      o = o || {};
      if (o.date) S.lookup.date = o.date;
      if (o.route) S.lookup.route = o.route;
      if (o.shift) S.lookup.shift = o.shift;
      S.open = null;
      render();
    },
    person: function (n) { S.person = n; render(); },
    resolveDay: resolveDay
  };

  /* 서비스 워커 (홈 화면 앱처럼 동작) */
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
