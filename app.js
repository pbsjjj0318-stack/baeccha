'use strict';
/* 대진여객 배차 — 휴대폰용 배차 조회 앱
   데이터: data/index.json, data/YYYY-MM-DD.json (카페 일일 배차표를 옮겨 적은 파일)
   설정: data/app-config.json  {"defaultPerson":"박병수"}  (없으면 기본값 사용) */
(function () {

  var ROUTES = ['115-1', '189-1', '129-1', '189', '187'];
  /* 표의 굵은 세로선 = 교대 경계. 값은 '오전 마지막 회차' 번호 */
  var BOUNDARY = { '189-1': 3, '115-1': 2, '129-1': 2, '189': 3, '187': 3 };
  var WD = ['일', '월', '화', '수', '목', '금', '토'];
  var STORE_KEY = 'dj_person_v1';   // 마지막으로 고른 이름 (앱을 끄면 사라짐)
  var ME_KEY = 'dj_me_v1';          // 이 기기 사용자 본인 이름 (앱을 열 때 기준)
  var FALLBACK_PERSON = '박병수';

  var S = {
    person: null,
    tab: 'mine',
    index: [],          // [{date, weekday, routes}]
    data: {},           // date -> 배차 JSON | null
    loading: {},
    config: null,
    lookup: { date: null, route: null, shift: 'am' },
    all: { date: null, route: 'all', find: '', cal: null },   // 전체시간표 화면
    menu: { data: null, loading: false, week: 0 },            // 식단표 화면
    open: null,
    setupMe: false,     // 이름 시트가 '내 이름 고르기' 모드인지
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

  /* 교대 경계: 노선 기본값. 189·187 은 회차가 적은 차량이 한 회차 앞당겨진다(6회=3, 5회=2). */
  function boundaryOf(route, v) {
    var b = BOUNDARY[route];
    if (!b) return 0;
    if ((route === '189' || route === '187') && v && v.trips && v.trips.length) {
      return Math.max(1, v.trips.length - 3);
    }
    return b;
  }

  function tripList(v, shift, route) {
    var b = boundaryOf(route, v);
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
      return '<div class="' + cls + ' empty offcard"><div class="ctop">' + dateBit +
        '<span class="pill pill-off">휴무</span></div>' +
        '<div class="cnote">이 날은 배차가 없습니다.</div></div>';
    }
    if (info.kind === 'reserve') {
      return '<div class="' + cls + ' empty"><div class="ctop">' + dateBit +
        '<span class="pill">예비</span></div>' +
        '<div class="cnote">예비 명단에 있습니다. 배차는 당일 정해질 수 있습니다.</div></div>';
    }
    if (info.kind === 'none') {
      return '<div class="' + cls + ' empty offcard"><div class="ctop">' + dateBit +
        '<span class="pill pill-off">휴무</span></div>' +
        '<div class="cnote">이 날은 배차가 없습니다.</div></div>';
    }

    var pills = info.items.map(function (it) {
      return (it.vno ? '<span class="pill pill-seq">순번 ' + it.vno + '</span>' : '') +
        '<span class="pill pill-shift ' + (it.shift === 'am' ? 'pill-am' : 'pill-pm') + '">' + (it.shift === 'am' ? '오전' : '오후') + '</span>';
    }).join('');
    var body = info.items.map(function (it) {
      var meta = it.route + '번 · ' + (it.vno ? ('순번 ' + it.vno + ' · ') : '') + (it.vehicle ? ('차량 ' + it.vehicle + '번') : (it.company || '차량 정보 없음'));
      var trips = it.trips.length
        ? it.trips.map(function (t) { return tripHtml(t, false); }).join('')
        : '<span class="hint">이 교대 회차 없음</span>';
      var bigTrips = it.trips.length
        ? '<div class="cbig">' + it.trips.map(function (t) { return tripHtml(t, true); }).join('') + '</div>'
        : '';
      var extra = '';
      if (!it.hasBoundary) {
        extra = '<div class="cnote">이 노선은 표에 교대 구분선이 없어 전체 회차를 표시합니다.</div>';
      }
      if (isUncertainRow(ds, it.route, it.vno, it.shift)) {
        extra += '<div class="cnote">이 줄은 이름 판독이 불확실합니다(다른 이름일 수 있음).</div>';
      }
      return '<div class="citem' + (it.trips.length ? ' tap' : '') + '"' +
        (it.trips.length ? ' role="button" tabindex="0"' : '') +
        '><div class="cmeta">' + esc(meta) + '</div>' +
        '<div class="ctrips">' + trips + '</div>' + bigTrips + extra + '</div>';
    }).join('');

    return '<div class="' + cls + '"><div class="ctop">' + dateBit +
      (isToday ? '<span class="pill pill-today">오늘</span>' : '') +
      '<span class="cspacer"></span>' + pills + '</div>' + body + '</div>';
  }

  function renderMine() {
    var wrap = $('#mine');
    /* 아직 이 기기의 내 이름을 고르지 않았다면 배차 대신 안내만 */
    if (!S.person) {
      wrap.innerHTML = '<div class="emptybox">위의 <b>이름 고르기</b>를 눌러 내 이름을 골라 주세요.' +
        '<br>고르면 내 배차가 여기에 나옵니다.</div>';
      $('#mineFoot').innerHTML = '';
      return;
    }
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

    /* 이번 달을 넘어가는 날짜는 보여 주지 않는다 */
    var ym = today.slice(0, 7);
    function inMonth(d) { return d.slice(0, 7) === ym; }

    var mon = mondayOf(today);
    var groups = [
      { title: '이번 주 내 배차', days: weekDays(mon).filter(function (d) { return d > today; }) },
      { title: '다음 주 내 배차', days: weekDays(addDays(mon, 7)) },
      { title: '그다음 주 내 배차', days: weekDays(addDays(mon, 14)) }
    ];
    groups.forEach(function (g) {
      var days = g.days.filter(inMonth);
      if (!days.length) return;
      html += '<h2 class="grouphead"><span>' + g.title + '</span><span class="grange">' +
        dLabel(days[0]) + '~' + dLabel(days[days.length - 1]) + '</span></h2>';
      html += days.map(function (d) { return cardHtml(d, { todayDate: null }); }).join('');
    });
    wrap.innerHTML = html;

    var first = S.index.length ? S.index[0].date : '';
    var last = S.index.length ? S.index[S.index.length - 1].date : '';
    var foot = '카드를 누르면 회차 시간이 크게 보입니다. 다시 누르면 원래대로 돌아갑니다.' +
      '<br>≈ 표에 분(分)만 인쇄된 칸은 위 회차의 시(時)를 이어받아 복원한 시각입니다.';
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
    if (!S.lookup.date) {
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
      dc.innerHTML = calendarHtml('lookup', S.lookup.date, today);
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

    var mx = maxTripNo(r);
    var bb = boundaryOf(route, (r.vehicles || [])[0]);
    var rangeTxt = BOUNDARY[route]
      ? (shift === 'am' ? '오전 1~' + bb + '회' : '오후 ' + (bb + 1) + '~' + mx + '회')
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
      var veh = (v.no ? '순번 ' + v.no + ' · ' : '') + (v.vehicle ? ('차량 ' + v.vehicle + '번') : (v.company || '차량 정보 없음'));
      var tripsHtml = trips.length
        ? trips.map(function (t) { return tripHtml(t, false); }).join('')
        : '<span class="hint">이 교대 회차 없음</span>';
      var bigHtml = trips.map(function (t) { return tripHtml(t, true); }).join('');
      var unsure = unc
        ? '<div class="rowunsure">이 줄은 표 판독이 불확실합니다. 다른 이름일 수 있습니다.</div>'
        : '';
      return '<div class="row' + (mine ? ' mine' : '') + (open ? ' open' : '') + '" role="button" tabindex="0" data-key="' +
        esc(key) + '"><div class="rowline">' + nameHtml +
        '<span class="rowveh">' + esc(veh) + '</span>' +
        (mine ? '<span class="badge">내 배차</span>' : '') + '</div>' +
        '<div class="rtrips">' + tripsHtml + '</div>' +
        '<div class="rbig">' + bigHtml + '</div>' + unsure + '</div>';
    }).join('');

    box.innerHTML = html || '<div class="emptybox">이 교대에 근무자가 없습니다.</div>';

    var foot = '≈ 표에 분(分)만 인쇄된 칸은 위 회차의 시(時)를 이어받아 복원한 시각입니다.';
    if (!BOUNDARY[route]) foot += '<br>이 노선은 표에 오전/오후 굵은 구분선이 없어 차량 전체 회차를 보여줍니다.';
    $('#lookupFoot').innerHTML = foot;
  }

  /* ---------------- 그리기: 전체시간표 ---------------- */
  /* 달력에서 보고 있는 달 1일~말일 + 그 달 밖 자료가 있으면 그 날짜까지 함께 보여 준다 */
  function calMonth(scope) {
    var box = S[scope];
    if (box.cal) return box.cal;
    box.cal = kstToday().slice(0, 7);
    return box.cal;
  }

  function monthDates(scope) {
    var ym = calMonth(scope || 'all');
    var y = parseInt(ym.slice(0, 4), 10);
    var m = parseInt(ym.slice(5, 7), 10);
    var first = new Date(Date.UTC(y, m - 1, 1));
    var last = new Date(Date.UTC(y, m, 0));
    var out = [];
    for (var d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    S.index.forEach(function (x) {
      if (out.indexOf(x.date) < 0) out.push(x.date);
    });
    out.sort();
    return out;
  }

  function calendarHtml(scope, ds, today) {
    var ym = calMonth(scope);
    var y = parseInt(ym.slice(0, 4), 10);
    var m = parseInt(ym.slice(5, 7), 10);
    var firstW = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    var lastD = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var have = {};
    S.index.forEach(function (x) { if (x.date.slice(0, 7) === ym) have[x.date] = true; });

    var wd = ['일', '월', '화', '수', '목', '금', '토'];
    var cells = wd.map(function (w, i) {
      return '<div class="calwd' + (i === 0 ? ' sun' : (i === 6 ? ' sat' : '')) + '">' + w + '</div>';
    });
    for (var i = 0; i < firstW; i++) cells.push('<div class="calpad"></div>');
    for (var d = 1; d <= lastD; d++) {
      var dt = ym + '-' + (d < 10 ? '0' : '') + d;
      var cls = 'cald';
      if (have[dt]) cls += ' has';
      if (dt === ds) cls += ' on';
      if (dt === today) cls += ' today';
      cells.push('<button type="button" class="' + cls + '" data-date="' + dt + '">' +
        '<span class="dn">' + d + '</span></button>');
    }

    var prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    var next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    return '<div class="cal">' +
      '<div class="calhead">' +
      '<button type="button" class="calnav" data-cal="' + prev + '">◀</button>' +
      '<span class="calmonth">' + y + '년 ' + m + '월</span>' +
      '<button type="button" class="calnav" data-cal="' + next + '">▶</button>' +
      '</div>' +
      '<div class="calgrid">' + cells.join('') + '</div>' +
      '<div class="calfoot">파란 날은 배차표가 들어온 날입니다. 날짜를 누르면 그 날 시간표를 봅니다.</div>' +
      '</div>';
  }

  function ensureAll() {
    if (!S.index.length) return;
    var dates = monthDates('all');
    if (!S.all.date || dates.indexOf(S.all.date) < 0) {
      var today = kstToday();
      S.all.date = dates.indexOf(today) >= 0 ? today : (S.index.length ? S.index[0].date : dates[0]);
    }
  }

  function shiftOfTrip(t, route, v) {
    var b = boundaryOf(route, v);
    if (!b) return null;
    return t.no <= b ? 'am' : 'pm';
  }

  function allEntries(d, routeFilter) {
    var out = [];
    if (!d || !d.routes) return out;
    d.routes.forEach(function (r) {
      if (routeFilter && routeFilter !== 'all' && r.route !== routeFilter) return;
      (r.vehicles || []).forEach(function (v) {
        (v.trips || []).forEach(function (t) {
          if (!t.depart) return;
          var sh = shiftOfTrip(t, r.route, v);
          var driver = sh === 'pm' ? (v.pm_driver || v.am_driver) : (sh === 'am' ? (v.am_driver || v.pm_driver)
            : (v.am_driver || v.pm_driver));
          out.push({
            time: t.depart, route: r.route, vehicle: v.vehicle, company: v.company,
            no: t.no, shift: sh, derived: !!t.derived, driver: driver || '',
            vno: v.no
          });
        });
      });
    });
    out.sort(function (a, b) {
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      if (a.route !== b.route) return a.route < b.route ? -1 : 1;
      return a.vno - b.vno;
    });
    return out;
  }

  function renderAll() {
    ensureAll();
    var ds = S.all.date;
    var today = kstToday();

    /* 날짜 칩 (한 달 전체) */
    var dc = $('#allDateChips');
    if (!S.index.length) {
      dc.innerHTML = '<span class="hint">날짜를 불러오는 중…</span>';
    } else {
      var haveD = {};
      S.index.forEach(function (x) { haveD[x.date] = true; });
      dc.innerHTML = monthDates('all').map(function (dt) {
        var on = dt === ds;
        var ok = !!haveD[dt];
        return '<button type="button" class="chip' + (on ? ' on' : '') + (ok ? '' : ' off') +
          '" data-date="' + dt + '">' + dLabel(dt) + '<span class="w">' +
          (ok ? wdOf(dt) : wdOf(dt) + (dt < today ? ' 자료 없음' : ' 작업 중')) + '</span></button>';
      }).join('');
    }

    var d = ds ? S.data[ds] : undefined;
    var have = [];
    if (d && d.routes) have = d.routes.map(function (r) { return r.route; });
    if (!ds || (!have.length && !S.loading[ds])) S.all.route = 'all';

    /* 노선 칩 */
    $('#allRouteChips').innerHTML = ['all'].concat(ROUTES).map(function (r) {
      var isAll = r === 'all';
      var ok = isAll || have.indexOf(r) >= 0;
      var on = S.all.route === r;
      return '<button type="button" class="chip' + (on ? ' on' : '') + (ok ? '' : ' off') +
        '" data-route="' + r + '"' + (ok ? '' : ' disabled aria-disabled="true"') + '>' +
        (isAll ? '전체' : r) + (ok ? '' : '<span class="w">준비 중</span>') + '</button>';
    }).join('');

    var box = $('#allRows');
    var head = $('#allHead');
    if (!ds) { head.innerHTML = ''; box.innerHTML = '<div class="loading">불러오는 중…</div>'; $('#allFoot').innerHTML = ''; return; }
    if (S.loading[ds] && !d) {
      head.innerHTML = '<span>' + fullLabel(ds) + '</span>';
      box.innerHTML = '<div class="loading">불러오는 중…</div>';
      $('#allFoot').innerHTML = '';
      return;
    }
    if (!d) {
      head.innerHTML = '<span>' + fullLabel(ds) + '</span><span class="cnt">배차표 준비 중</span>';
      box.innerHTML = '<div class="emptybox">이 날짜 배차표가 아직 없습니다.</div>';
      $('#allFoot').innerHTML = '';
      return;
    }

    var list = allEntries(d, S.all.route);
    var q = norm(S.all.find || '');
    if (q) {
      var exact = list.filter(function (e) { return norm(e.vehicle || '') === q || norm(e.driver || '') === q; });
      list = exact.length ? exact : list.filter(function (e) {
        return norm(e.vehicle || '').indexOf(q) >= 0 || norm(e.driver || '').indexOf(q) >= 0;
      });
    }
    var p = norm(S.person);
    head.innerHTML = '<span>' + fullLabel(ds) + (q ? ' · 찾기' : ' 시간표') + '</span><span class="cnt">' +
      list.length + '회</span>';

    if (!list.length) {
      box.innerHTML = '<div class="emptybox">' + (q
        ? '‘' + esc(S.all.find) + '’ 에 해당하는 차량·이름이 없습니다.<br>차량번호를 다시 확인해 주세요.'
        : (S.all.route === 'all' ? '이 날짜 배차표에 옮겨 적은 회차가 없습니다.'
          : esc(S.all.route) + '번은 이 날짜 표에 아직 없습니다.<br>지금은 115-1·189-1 두 노선부터 들어 있습니다.')) +
        '</div>';
      $('#allFoot').innerHTML = '';
      return;
    }

    var rows = [];
    var lastHour = '';
    list.forEach(function (e) {
      var hour = e.time.slice(0, 2);
      if (hour !== lastHour) {
        rows.push('<div class="allhour">' + hour + '시</div>');
        lastHour = hour;
      }
      var mine = !!e.driver && norm(e.driver) === p;
      rows.push('<div class="arow' + (mine ? ' mine' : '') + '">' +
        '<b class="atime">' + esc(e.time) + (e.derived ? '<span class="approx">≈</span>' : '') + '</b>' +
        '<span class="aveh"><b class="vnum">' + esc(e.vehicle ? (e.vehicle + '번') : (e.company || '—')) + '</b>' +
        '<span class="aroute">' + esc(e.route) + '</span></span>' +
        '<span class="aname">' + (e.driver ? esc(e.driver) : '<span class="muted">이름 없음</span>') + '</span>' +
        '<span class="ano">' + e.no + '회' +
        (e.shift ? '<i>' + (e.shift === 'am' ? '오전' : '오후') + '</i>' : '') + '</span>' +
        '</div>');
    });
    box.innerHTML = rows.join('');

    $('#allFoot').innerHTML =
      '≈ 표에 분(分)만 인쇄된 칸은 위 회차의 시(時)를 이어받아 복원한 시각입니다.<br>' +
      '내 이름(' + esc(S.person) + ')이 있는 회차는 파랗게 표시합니다.';
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
    var me = norm(storeGet(ME_KEY) || '');
    $('#nameList').innerHTML = list.length
      ? list.map(function (n) {
        var on = norm(n) === cur;
        var isMe = !!me && norm(n) === me;
        var badge = isMe ? '<span class="ck">내 이름</span>'
          : (on && !S.setupMe ? '<span class="ck">보는 중</span>' : '');
        return '<button type="button" class="nameitem' + (on || isMe ? ' cur' : '') + '" data-name="' + esc(n) + '">' +
          '<span>' + esc(n) + '</span>' + badge + '</button>';
      }).join('')
      : '<div class="emptybox">그런 이름이 없습니다.</div>';
  }

  /* openSheet('me') = 이 기기의 내 이름을 고르는 모드 */
  function openSheet(mode) {
    S.setupMe = (mode === 'me');
    $('#sheetWrap').hidden = false;
    $('#nameSearch').value = '';
    setHint('');
    syncSheetHead();
    renderNameList('');
    setTimeout(function () { try { $('#nameSearch').focus(); } catch (e) {} }, 60);
  }
  function closeSheet() {
    S.setupMe = false;
    $('#sheetWrap').hidden = true;
    syncSheetHead();
  }

  /* 시트 머리말·안내문·버튼 글자를 지금 모드에 맞춘다 */
  function syncSheetHead() {
    var t = $('#sheetTitle'), n = $('#sheetNote'), b = $('#sheetMeBtn');
    if (t) t.textContent = S.setupMe ? '내 이름 고르기' : '이름 선택';
    if (n) {
      n.hidden = !S.setupMe;
      n.textContent = '이 기기에서 내 배차를 볼 이름을 골라 주세요.';
    }
    if (b) b.textContent = S.setupMe ? '그만두기' : '내 이름 바꾸기';
  }

  function setPerson(name) {
    if (!name) return;
    /* 이름 시트에서 다른 사람을 골라 봐도 '내 이름'은 바뀌지 않는다.
       앱을 다시 열면 항상 이 기기의 본인 이름으로 돌아온다. */
    S.person = name;
    closeSheet();
    render();
  }

  /* '내 이름 고르기' 모드에서 고른 이름을 이 기기의 본인 이름으로 저장 */
  function setMyName(name) {
    if (!name) return;
    storeSet(ME_KEY, name);
    S.person = name;
    closeSheet();
    render();
  }

  /* 이 기기 사용자의 본인 이름. 처음 한 번 고른 이름을 기기에 저장해 두고
     앱을 열 때마다 이 값을 기준으로 삼는다. 아직 안 골랐으면 null. */
  function myName() {
    return storeGet(ME_KEY);
  }

  /* ---------------- 이름 음성 찾기 ---------------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var voice = null;

  function setHint(txt) {
    var el = $('#nameHint');
    if (!el) return;
    el.textContent = txt || '';
    el.hidden = !txt;
  }

  /* 들린 말에서 이름을 골라 준다. 딱 하나로 정해지면 바로 그 이름으로 바꾼다. */
  function voicePick(text) {
    var q = norm(text);
    if (!q) return false;
    var names = allNames();
    var hit = names.filter(function (n) { return norm(n) === q; });
    if (!hit.length) {
      hit = names.filter(function (n) {
        var a = norm(n);
        return a.indexOf(q) >= 0 || q.indexOf(a) >= 0;
      });
    }
    $('#nameSearch').value = text;
    renderNameList(text);
    if (hit.length === 1) {
      setHint('');
      setPerson(hit[0]);
      return true;
    }
    setHint(hit.length ? hit.length + '명 찾았어요. 하나를 눌러 주세요.' : '그런 이름이 없어요. 다시 말해 주세요.');
    return false;
  }

  function startVoice() {
    var btn = $('#nameMic');
    if (!SR) {
      setHint('이 브라우저에서는 음성 찾기가 안 돼요. 크롬에서 열어 보시거나 키보드 마이크를 써 주세요.');
      return;
    }
    if (voice) { try { voice.stop(); } catch (e) {} return; }
    /* 키보드가 올라와 있으면 내리고 나서 마이크를 켠다 (소리 잡기 방해 방지) */
    try { var ae = document.activeElement; if (ae && ae.blur) ae.blur(); } catch (e) {}
    setHint('마이크를 켜는 중…');
    setTimeout(function () { launchVoice(btn); }, 350);
  }

  function launchVoice(btn) {
    var got = false, stopTimer = null;
    try {
      voice = new SR();
    } catch (e) {
      voice = null;
      setHint('음성 찾기를 시작하지 못했어요. 다시 눌러 주세요.');
      return;
    }
    voice.lang = 'ko-KR';
    voice.interimResults = false;
    voice.maxAlternatives = 3;
    voice.onstart = function () {
      btn.classList.add('on');
      setHint('듣고 있어요. 이름을 말해 주세요.');
      /* 12초 동안 아무 말도 안 들리면 스스로 끝낸다 */
      clearTimeout(stopTimer);
      stopTimer = setTimeout(function () {
        if (voice && !got) { try { voice.stop(); } catch (e) {} }
      }, 12000);
    };
    voice.onresult = function (e) {
      var res = e.results && e.results[0];
      if (!res) return;
      got = true;
      clearTimeout(stopTimer);
      var picked = false;
      for (var i = 0; i < res.length && !picked; i++) picked = voicePick(res[i].transcript);
      if (!picked) {
        /* 후보를 다 합쳐서 한 번 더 ("박 병수"처럼 띄어 들린 경우) */
        var all = '';
        for (var j = 0; j < res.length; j++) all += res[j].transcript;
        voicePick(all);
      }
    };
    voice.onerror = function (e) {
      var code = (e && e.error) || '';
      got = true;
      clearTimeout(stopTimer);
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setHint('마이크 사용을 허용해 주셔야 음성 찾기가 됩니다.');
      } else if (code === 'no-speech') {
        setHint('못 들었어요. 마이크를 다시 눌러 주세요.');
      } else if (code === 'network') {
        setHint('음성 인식 서버에 연결하지 못했어요. 인터넷을 확인하고 다시 눌러 주세요.');
      } else if (code === 'audio-capture') {
        setHint('마이크를 찾지 못했어요. 다른 앱이 쓰고 있는지 확인해 주세요.');
      } else if (code === 'aborted') {
        /* 사용자가 직접 끊은 경우 — 안내 없음 */
      } else {
        setHint('음성 찾기가 잘 안 됐어요(' + code + '). 다시 눌러 주세요.');
      }
    };
    voice.onend = function () {
      clearTimeout(stopTimer);
      btn.classList.remove('on');
      voice = null;
      if (!got) setHint('못 들었어요. 마이크를 다시 눌러 주세요.');
    };
    try { voice.start(); } catch (e) {
      voice = null; btn.classList.remove('on');
      setHint('음성 찾기를 시작하지 못했어요. 다시 눌러 주세요.');
    }
  }

  /* ---------------- 공통 그리기 ---------------- */
  /* ---------------- 식단표 ---------------- */
  function loadMenu(force) {
    if (S.menu.loading) return Promise.resolve();
    if (S.menu.data && !force) return Promise.resolve();
    S.menu.loading = true;
    return fetch('data/menu.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function (j) { S.menu.data = (j && j.weeks) || []; })
      .catch(function () { S.menu.data = S.menu.data || []; })
      .then(function () { S.menu.loading = false; });
  }

  function weekLabel(w) {
    var a = String(w.start).split('-').map(Number), b = String(w.end).split('-').map(Number);
    return a[1] + '/' + a[2] + '~' + b[1] + '/' + b[2];
  }

  function mealRow(label, items) {
    if (!items || !items.length) return '<div class="mline"><b>' + label + '</b><span class="muted">메뉴 없음</span></div>';
    return '<div class="mline"><b>' + label + '</b><span>' + esc(items.join(', ')) + '</span></div>';
  }

  function renderMenu() {
    var box = $('#weekChips');
    var today = kstToday();
    var rawWeeks = S.menu.data || [];
    var weeks = rawWeeks.filter(function (w) {
      return (w.days || []).some(function (d) { return d.date >= today; });
    });
    if (!weeks.length) {
      $('#menuHead').innerHTML = '';
      $('#menuDays').innerHTML = '<div class="emptybox">' + (S.menu.loading
        ? '식단표를 불러오는 중…'
        : (rawWeeks.length
          ? '오늘 이후 식단표가 아직 없습니다.<br>카페에 새 주간식단표가 올라오면 자동으로 채워집니다.'
          : '아직 식단표가 없습니다.<br>카페에 주간식단표가 올라오면 자동으로 채워집니다.')) + '</div>';
      $('#menuFoot').innerHTML = '';
      box.innerHTML = '';
      return;
    }
    if (!(S.menu.week >= 0 && S.menu.week < weeks.length)) S.menu.week = weeks.length - 1;

    box.innerHTML = weeks.map(function (w, i) {
      return '<button type="button" class="chip' + (i === S.menu.week ? ' on' : '') +
        '" data-week="' + i + '">' + weekLabel(w) + '</button>';
    }).join('');

    var w = weeks[S.menu.week];
    var days = (w.days || []).filter(function (d) { return d.date >= today; });
    $('#menuHead').innerHTML = '<span>' + esc(String(w.start)) + ' ~ ' + esc(String(w.end)) + ' 식단표</span><span class="cnt">' +
      days.length + '일</span>';
    $('#menuDays').innerHTML = days.map(function (d) {
      return '<div class="mcard tap' + (d.date === today ? ' today' : '') + '" role="button" tabindex="0">' +
        '<div class="mtop"><b class="mdate">' + fullLabel(d.date) + '</b>' +
        (d.date === today ? '<span class="pill pill-today">오늘</span>' : '') + '</div>' +
        mealRow('아침', d.breakfast) + mealRow('점심', d.lunch) + mealRow('저녁', d.dinner) +
        '</div>';
    }).join('');
    $('#menuFoot').innerHTML = '날짜 카드를 누르면 글씨가 크게 보입니다. 카페 대진지부 주간식단표 기준이고, 식자재 수급에 따라 바뀔 수 있어요.';
  }

  function renderChrome() {
    $('#personName').textContent = S.person || '이름 고르기';
    var today = kstToday();
    var t = '오늘 ' + fullLabel(today);
    if (!S.index.length) t += ' · 불러오는 중';
    $('#topSub').textContent = t;
  }

  function render() {
    renderChrome();
    var tab = S.tab;
    $('#viewMine').hidden = tab !== 'mine';
    $('#viewLookup').hidden = tab !== 'lookup';
    $('#viewAll').hidden = tab !== 'all';
    $('#viewMenu').hidden = tab !== 'menu';
    if (tab === 'mine') renderMine();
    else if (tab === 'lookup') renderLookup();
    else if (tab === 'menu') { if (!S.menu.data) loadMenu().then(function () { if (S.tab === 'menu') renderMenu(); }); renderMenu(); }
    else renderAll();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === S.tab);
    });
  }

  function setTab(tab) {
    if (tab !== 'mine' && tab !== 'lookup' && tab !== 'all' && tab !== 'menu') return;
    S.tab = tab;
    storeSet('dj_tab_v1', tab);
    render();
    window.scrollTo(0, 0);
  }

  /* ---------------- 이벤트 ---------------- */
  function wire() {
    $('#personBtn').addEventListener('click', function () { openSheet(); });
    $('#sheetWrap').addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-close')) closeSheet();
      var btn = t && t.closest ? t.closest('[data-name]') : null;
      if (btn) {
        var nm = btn.getAttribute('data-name');
        if (S.setupMe) setMyName(nm); else setPerson(nm);
      }
    });
    var meBtn = $('#sheetMeBtn');
    if (meBtn) meBtn.addEventListener('click', function () {
      S.setupMe = !S.setupMe;
      syncSheetHead();
      renderNameList($('#nameSearch').value);
    });
    $('#nameSearch').addEventListener('input', function (e) { renderNameList(e.target.value); });
    var mic = $('#nameMic');
    if (mic) mic.addEventListener('click', startVoice);

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
    });

    $('#dateChips').addEventListener('click', function (e) {
      var nav2 = e.target.closest ? e.target.closest('[data-cal]') : null;
      if (nav2) {
        var ym2 = nav2.getAttribute('data-cal');
        S.lookup.cal = ym2;
        if ((S.lookup.date || '').slice(0, 7) !== ym2) {
          var pick = null;
          S.index.forEach(function (x) { if (!pick && x.date.slice(0, 7) === ym2) pick = x.date; });
          S.lookup.date = pick || (kstToday().slice(0, 7) === ym2 ? kstToday() : ym2 + '-01');
          S.lookup.route = null;
        }
        S.open = null;
        ensureLookup();
        renderLookup();
        return;
      }
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

    $('#menuDays').addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.mcard.tap') : null;
      if (!it) return;
      it.classList.toggle('open');
    });

    $('#menuDays').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var it = e.target.closest ? e.target.closest('.mcard.tap') : null;
      if (!it || e.target !== it) return;
      e.preventDefault();
      it.classList.toggle('open');
    });

    $('#weekChips').addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-week]') : null;
      if (!c) return;
      S.menu.week = parseInt(c.getAttribute('data-week'), 10) || 0;
      renderMenu();
    });

    $('#allDateChips').addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-date]') : null;
      if (!c) return;
      var ds = c.getAttribute('data-date');
      S.all.date = ds;
      S.all.route = 'all';
      if (!Object.prototype.hasOwnProperty.call(S.data, ds) && !S.loading[ds]) {
        S.loading[ds] = true;
        renderAll();
        loadDate(ds).then(function () { delete S.loading[ds]; renderAll(); });
        return;
      }
      renderAll();
    });

    $('#allFind').addEventListener('input', function (e) {
      S.all.find = e.target.value;
      renderAll();
    });

    $('#allRouteChips').addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-route]') : null;
      if (!c || c.disabled) return;
      S.all.route = c.getAttribute('data-route');
      renderAll();
    });

    $('#mine').addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.citem.tap') : null;
      if (!it) return;
      it.classList.toggle('open');
    });

    $('#mine').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var it = e.target.closest ? e.target.closest('.citem.tap') : null;
      if (!it || e.target !== it) return;
      e.preventDefault();
      it.classList.toggle('open');
    });

    $('#rows').addEventListener('click', function (e) {
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
    var savedTab = storeGet('dj_tab_v1');
    S.tab = (savedTab === 'lookup' || savedTab === 'all' || savedTab === 'menu') ? savedTab : 'mine';
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad > 5 * 60 * 1000) {
        lastLoad = Date.now();
        refreshData();
      }
    });

    var today = kstToday();
    var first = pickDate(today);

    Promise.all([loadConfig(), loadIndex(), loadMenu()]).then(function () {
      var savedMe = myName();
      S.person = savedMe || '';
      first = pickDate(today);
      if (S.index.length) {
        S.index.forEach(function (x) { if (!Object.prototype.hasOwnProperty.call(S.data, x.date)) S.loading[x.date] = true; });
      }
      ensureLookup();
      render();

      if (!first) {
        if (!savedMe) openSheet('me');
        return;
      }

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
        /* 이 기기에서 처음 열었다면 내 이름부터 고르게 한다 */
        if (!storeGet(ME_KEY)) openSheet('me');
      });
    }).catch(function () {
      $('#mine').innerHTML = '<div class="emptybox">배차 데이터를 불러오지 못했습니다.<br>인터넷 연결을 확인한 뒤 앱을 다시 열어 주세요.</div>';
    });
  }

  function ensureStart() {
    /* 이름을 아직 안 골랐으면 비워 둔다 (남의 이름으로 시작하지 않게) */
    S.person = storeGet(ME_KEY) || '';
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
