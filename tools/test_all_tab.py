#!/usr/bin/env python3
"""전체시간표 탭 검사 (노드 없이 quickjs + 가짜 DOM)."""
import json
import sys
from pathlib import Path

import quickjs

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_render import STUB, ROOT  # noqa: E402


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
    for _ in range(400):
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

    ctx.eval("window.__dj.state.all.date='2026-11-18'; window.__dj.setTab('all')")
    for _ in range(200):
        try:
            if not ctx.execute_pending_job():
                break
        except Exception:
            break

    rows = (node('#allRows') or {}).get('html') or ''
    head = (node('#allHead') or {}).get('html') or ''
    dates = (node('#allDateChips') or {}).get('html') or ''
    routes = (node('#allRouteChips') or {}).get('html') or ''
    foot = (node('#allFoot') or {}).get('html') or ''

    times = [t.split('</b>')[0] for t in rows.split('<b class="atime">')[1:]]
    times = [t.split('<')[0] for t in times]
    checks = [
        ('행이 그려짐', len(times) == 233),
        ('시간 오름차순', times == sorted(times)),
        ('첫 줄 04:40', times[:1] == ['04:40']),
        ('head 에 회수', '233회' in head),
        ('날짜 칩 있음', 'data-date="2026-11-18"' in dates),
        ('노선 칩 전체', '>전체<' in routes),
        ('데이터 없는 노선 준비 중', '준비 중' in routes),
        ('내 배차 강조', 'arow mine' in rows),
        ('각주 있음', '이어받아' in foot),
    ]
    ok = True
    for label, cond in checks:
        print(('OK   ' if cond else 'FAIL ') + label)
        ok = ok and cond

    print('--- head:', head)
    print('--- 첫 3행:', rows[:300])
    print('--- 내 배차 줄 수:', rows.count('arow mine'))
    print('RESULT:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
