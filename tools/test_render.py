#!/usr/bin/env python3
"""app.js 를 가짜 DOM + 로컬 데이터로 실행해 화면 출력을 검사한다 (노드 없이 확인용)."""
import json
import re
import sys
from pathlib import Path

import quickjs

ROOT = Path('/workspace/projects/daejin-baeccha')

STUB = r'''
var __nodes = {};
function Node(sel){ this.sel=sel; this.innerHTML=''; this.textContent=''; this.hidden=false;
  this.value=''; this.disabled=false; this.dataset={}; this.style={};
  this.classList={toggle:function(){},add:function(){},remove:function(){},contains:function(){return false;}};
}
Node.prototype.addEventListener=function(){};
Node.prototype.querySelector=function(s){ return __get(this.sel+' '+s); };
Node.prototype.querySelectorAll=function(){ return []; };
Node.prototype.getAttribute=function(){ return null; };
Node.prototype.setAttribute=function(){};
Node.prototype.appendChild=function(){};
Node.prototype.focus=function(){};
Node.prototype.closest=function(){ return null; };
function __get(sel){ if(!__nodes[sel]) __nodes[sel]=new Node(sel); return __nodes[sel]; }
var document = {
  readyState:'complete',
  addEventListener:function(){},
  querySelector:function(s){ return __get(s); },
  querySelectorAll:function(s){ return []; },
  createElement:function(){ return new Node('x'); },
  body:new Node('body')
};
var window = globalThis;
window.localStorage={_d:{},getItem:function(k){return this._d[k]||null;},setItem:function(k,v){this._d[k]=v;},removeItem:function(k){delete this._d[k];}};
window.addEventListener=function(){};
window.scrollTo=function(){};
var navigator = { serviceWorker: undefined };
var location = { protocol:'file:' };
var Intl = { DateTimeFormat: function(locale, opts){
  this.format = function(d){
    var t = new Date(d.getTime() + 9*3600*1000);
    var p=function(n){ return (n<10?'0':'')+n; };
    return t.getUTCFullYear()+'-'+p(t.getUTCMonth()+1)+'-'+p(t.getUTCDate());
  };
}};
function __mkres(r){
  return { ok:r.ok, status:r.status,
    json:function(){ return r.ok ? Promise.resolve(JSON.parse(r.text)) : Promise.reject(new Error('404')); },
    text:function(){ return Promise.resolve(r.text||''); } };
}
function fetch(url){
  var raw = __fetch(String(url));
  var r = JSON.parse(raw);
  return new Promise(function(res){ res(__mkres(r)); });
}
'''


def main():
    ctx = quickjs.Context()

    def js_fetch(url):
        p = ROOT / url.split('?')[0].lstrip('/')
        if not p.exists():
            return json.dumps({'ok': False, 'status': 404})
        return json.dumps({'ok': True, 'status': 200, 'text': p.read_text(encoding='utf-8')})

    ctx.add_callable('__fetch', js_fetch)
    ctx.eval(STUB)
    ctx.eval((ROOT / 'app.js').read_text(encoding='utf-8'))
    for _ in range(300):
        try:
            if not ctx.execute_pending_job():
                break
        except Exception as e:
            print('job error:', e)
            break

    def node(sel):
        raw = ctx.eval(
            "JSON.stringify((function(){var n=__nodes[%s];return n?{html:n.innerHTML,text:n.textContent,hidden:n.hidden}:null;})())"
            % json.dumps(sel))
        return json.loads(raw)

    mine = node('#mine')
    if not mine:
        print('FAIL: #mine 이 비어 있음')
        return 1
    html = mine['html']
    print('--- 내 배차 화면 길이:', len(html))

    src_dir = Path('/workspace/data/baeccha')
    colleagues = set()
    for f in sorted(src_dir.glob('2026-*.json')):
        d = json.loads(f.read_text(encoding='utf-8'))
        for r in d.get('routes', []):
            for v in r.get('vehicles', []):
                for k in ('am_driver', 'pm_driver'):
                    if v.get(k):
                        colleagues.add(v[k])
    colleagues.discard('박병수')

    checks = [
        ('오늘 카드 11월 17일 (화)', '11월 17일 (화)' in html),
        ('오늘 1회 06:00', '06:00' in html),
        ('오늘 2회 08:22', '08:22' in html),
        ('오늘 3회 11:06', '11:06' in html),
        ('11/20 오후 14:31', '14:31' in html),
        ('11/20 오후 17:17', '17:17' in html),
        ('11/20 오후 20:12', '20:12' in html),
        ('11/24 휴무 + 근거', '휴무' in html and '189-1번 오후 휴무' in html),
        ('11/28 배차표 준비 중', '배차표 준비 중' in html),
        ('동료 실명이 화면에 새지 않음', not any(n in html for n in colleagues)),
        ('본인 이름 그대로 (박병수)', '박병수' in html),
        ('≈ 표식', '≈' in html),
        ('내 배차 pill', 'pill-today' in html),
    ]
    ok = True
    for label, cond in checks:
        print(('OK   ' if cond else 'FAIL ') + label)
        ok = ok and cond

    # 조회 화면 검사
    ctx.eval("window.__dj.setTab('lookup'); window.__dj.lookup({date:'2026-11-17',route:'189-1',shift:'am'})")
    for _ in range(50):
        try:
            if not ctx.execute_pending_job():
                break
        except Exception:
            break
    rows = node('#rows')
    rh = rows['html'] if rows else ''
    head = node('#listHead')
    print('--- 조회 head:', (head or {}).get('html'))
    extra = [
        ('조회: 동료 이름 가림 (가운데 *)', re.search(r'[가-힣]\*[가-힣]', rh) is not None),
        ('조회: 본인 내 배차 표시', 'badge' in rh and '박병수' in rh),
        ('조회: 189-1 오전 1~3회', '오전 1~3회' in ((head or {}).get('html') or '')),
        ('조회: 14대', '14대' in ((head or {}).get('html') or '')),
        ('조회: 오전 행은 3회까지만 (21:54 없음)', '21:54' not in rh),
        ('조회: 원본 실명 없음', not any(n in rh for n in colleagues)),
    ]
    for label, cond in extra:
        print(('OK   ' if cond else 'FAIL ') + label)
        ok = ok and cond

    ctx.eval("window.__dj.lookup({date:'2026-11-17',route:'115-1',shift:'pm'})")
    for _ in range(50):
        try:
            if not ctx.execute_pending_job():
                break
        except Exception:
            break
    r115 = node('#rows')
    h115 = r115['html'] if r115 else ''
    print('--- 115-1 오후 head:', (node('#listHead') or {}).get('html'))
    extra2 = [
        ('115-1: 이름 없는 줄(일신) 표시', '이름 없음' in h115 and '일신' in h115),
        ('115-1: 오후는 3회부터', '11:47' in h115),
    ]
    for label, cond in extra2:
        print(('OK   ' if cond else 'FAIL ') + label)
        ok = ok and cond

    # 판독 불확실 표시 (11/20 189-1 오전 연번 11)
    ctx.eval("window.__dj.lookup({date:'2026-11-20',route:'189-1',shift:'am'})")
    for _ in range(50):
        try:
            if not ctx.execute_pending_job():
                break
        except Exception:
            break
    h20 = (node('#rows') or {}).get('html') or ''
    for label, cond in [('11/20 판독 불확실 ? 표시', 'qmark' in h20)]:
        print(('OK   ' if cond else 'FAIL ') + label)
        ok = ok and cond

    print('--- #topSub:', (node('#topSub') or {}).get('text'))
    print('--- #personName:', (node('#personName') or {}).get('text'))
    print('--- footnote:', ((node('#mineFoot') or {}).get('html') or '')[:200])
    print('RESULT:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
