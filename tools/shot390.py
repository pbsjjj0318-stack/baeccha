"""390px 폰 폭 스크린샷 — 배포된 앱을 열어 달력/목록/내 배차를 찍습니다.

필요: LD_LIBRARY_PATH=/workspace/tmpdeps/root/usr/lib/x86_64-linux-gnu:/workspace/tmpdeps/root/lib/x86_64-linux-gnu
사용: python3 tools/shot390.py ../../../downloads/baeccha_390
"""
import sys, os, time
from playwright.sync_api import sync_playwright

URL = 'https://pbsjjj0318-stack.github.io/baeccha/'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'downloads'
EXE = '/workspace/.cache/chs/chrome-headless-shell-linux64/chrome-headless-shell'

os.makedirs(OUT, exist_ok=True)

def shot(page, name):
    p = os.path.join(OUT, name)
    page.screenshot(path=p, full_page=False)
    print('saved', p)

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=EXE, args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                        is_mobile=True, has_touch=True,
                        user_agent='Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36')
    page = ctx.new_page()
    page.goto(URL, wait_until='networkidle')
    page.wait_for_timeout(1200)

    # 이름 고르기 시트가 뜨면 박병수 선택
    try:
        btn = page.get_by_role('button', name='박병수', exact=True)
        if btn.count():
            btn.first.click()
            page.wait_for_timeout(1200)
            print('person selected')
    except Exception as e:
        print('person pick skip', e)

    # 내 배차 탭
    page.get_by_role('button', name='🚌 내 배차').click()
    page.wait_for_timeout(1200)
    shot(page, 'a_mine_tab_390.png')

    # 전체 조회 탭
    page.get_by_role('button', name='🔎 전체 조회').click()
    page.wait_for_timeout(1500)
    print('cal month:', page.locator('.calmonth').first.inner_text())
    shot(page, 'b_nov_calendar_390.png')

    # 다음 달로 (▶)
    page.locator('.calnav').nth(1).click()
    page.wait_for_timeout(1200)
    print('cal month:', page.locator('.calmonth').first.inner_text())
    shot(page, 'c_dec_calendar_390.png')

    # 달력만 크게
    page.locator('.cal').first.screenshot(path=os.path.join(OUT, 'd_dec_calendar_only_390.png'))
    print('saved', os.path.join(OUT, 'd_dec_calendar_only_390.png'))

    # 12/1 선택해서 목록 확인 (되돌림)
    cell = page.locator('.cald.has').first
    cell.click()
    page.wait_for_timeout(1500)
    shot(page, 'e_dec_rows_390.png')

    # computed style 검증
    info = page.evaluate("""() => {
      const has = document.querySelector('.cald.has');
      const plain = document.querySelector('.cald:not(.has):not(.on)');
      const on = document.querySelector('.cald.on');
      const cs = el => el ? getComputedStyle(el) : null;
      const h = cs(has), p = cs(plain), o = cs(on);
      const tr = document.querySelector('.rtrips');
      const tt = document.querySelector('.rtrips .tt, .tr strong');
      const trips = document.querySelector('.rtrips .tr');
      return {
        has: h && {bg:h.backgroundColor, color:h.color, w:h.fontWeight, shadow:h.boxShadow, h:h.height},
        plain: p && {bg:p.backgroundColor, color:p.color, w:p.fontWeight, shadow:p.boxShadow},
        on: o && {bg:o.backgroundColor, color:o.color, shadow:o.boxShadow},
        rtrips: tr && {fs:getComputedStyle(tr).fontSize, fw:getComputedStyle(tr).fontWeight},
        hasStrongInTrips: !!tt,
        trBox: trips && {w:trips.getBoundingClientRect().width, h:trips.getBoundingClientRect().height},
        ctrips: (()=>{const c=document.querySelector('.ctrips'); return c?{fs:getComputedStyle(c).fontSize,fw:getComputedStyle(c).fontWeight}:null})(),
        css: [...document.styleSheets].map(s=>s.href).filter(Boolean)
      };
    }""")
    import json
    print(json.dumps(info, ensure_ascii=False, indent=1))
    b.close()
