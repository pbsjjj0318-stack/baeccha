#!/usr/bin/env python3
"""워크스페이스의 배차 데이터를 웹 앱용 data/ 폴더로 옮긴다.

사용: python3 build_data.py [/workspace]
입력: {WORKSPACE}/data/baeccha/2026-MM-DD.json
출력: data/2026-MM-DD.json, data/index.json, data/app-config.json

config.json 의 nameMode 로 이름 노출 방식을 정한다.
  mask : 동료 이름은 가운데 글자를 * 로 가리고, 본인(selfName)은 그대로 둔다 (현재 설정)
  full : 실명 그대로
  self : 본인 배차 줄만 남기고 다른 기사 이름은 지운다
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WS = sys.argv[1] if len(sys.argv) > 1 else "/workspace"
SRC = os.path.join(WS, "data", "baeccha")
OUT = os.path.join(HERE, "data")

# 판독이 불확실한 줄 (이름 대신 표의 위치로 표시한다 — 공개 저장소에 이름을 남기지 않기 위해)
# (노선, 연번, 교대)
UNCERTAIN_ROWS = {
    "2026-11-20": [("189-1", 11, "am")],
    "2026-11-21": [("189-1", 8, "am")],
    "2026-11-22": [("189-1", 3, "am")],
    "2026-11-23": [("189-1", 14, "pm")],
    "2026-11-24": [("189-1", 11, "pm")],
    "2026-11-25": [("189-1", 8, "pm")],
    "2026-11-26": [("189-1", 5, "pm")],
}


def load_name_fixes():
    """판독 오류 이름 교정표 (워크스페이스 data/baeccha/name-fixes.json). 없으면 빈 표."""
    p = os.path.join(SRC, "name-fixes.json")
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        d = json.load(f)
    return {k: v for k, v in d.items() if not k.startswith("_")}


NAME_FIXES = {}


def fix_name(name):
    """이름 하나를 교정표로 바로잡는다(뒤에 붙은 중복 구분 숫자는 보존)."""
    if not name:
        return name
    core = re.sub(r"\d+$", "", name)
    tail = name[len(core):]
    return NAME_FIXES.get(core, core) + tail


def load_config():
    p = os.path.join(HERE, "config.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {}


def mask_name(name, me=None):
    """동료 이름의 가운데 글자를 * 로 가린다. 본인 이름은 그대로 둔다."""
    if not name:
        return name
    if me and name == me:
        return name
    core = re.sub(r"\d+$", "", name)
    digits = name[len(core):]
    n = len(core)
    if n >= 4:
        return core[0] + "*" * (n - 2) + core[-1] + digits
    if n == 3:
        return core[0] + "*" + core[-1] + digits
    if n == 2:
        return core[0] + "*" + digits
    return core + digits


def full_vehicle(v):
    """차량번호를 4자리로 통일한다 (표에는 64 처럼 뒤 두 자리만 인쇄되는 칸이 있다).
    2자리 -> 18xx, 앞자리가 잘못 읽힌 3·4자리(278, 2770) -> 18 + 뒤 두 자리."""
    s = str(v or "").strip()
    if not s.isdigit():
        return v
    if len(s) == 2:
        return "18" + s
    if len(s) == 3:
        return "18" + s[-2:]
    if len(s) == 4 and not s.startswith("18"):
        return "18" + s[-2:]
    return s


def trim_vehicle(v, mode, me):
    trips = []
    for t in v.get("trips", []):
        item = {"no": t.get("no"), "depart": t.get("depart"), "derived": bool(t.get("derived"))}
        if not t.get("depart"):
            item["raw"] = t.get("raw")
        trips.append(item)
    out = {
        "no": v.get("no"),
        "vehicle": full_vehicle(v.get("vehicle")),
        "trips": trips,
    }
    if v.get("company"):
        out["company"] = v["company"]
    am, pm = fix_name(v.get("am_driver")), fix_name(v.get("pm_driver"))
    if mode == "self":
        if me not in (am, pm):
            return None
        out["am_driver"] = am if am == me else None
        out["pm_driver"] = pm if pm == me else None
    elif mode == "mask":
        out["am_driver"] = mask_name(am, me)
        out["pm_driver"] = mask_name(pm, me)
    else:
        out["am_driver"] = am
        out["pm_driver"] = pm
    return out


def trim_furlough(f, mode, me):
    if not f:
        return f
    if mode == "full":
        return {r: " / ".join(" ".join(fix_name(n) for n in p.split() if n) for p in str(v).split("/")) if v else v
                for r, v in f.items()}
    out = {}
    for route, val in f.items():
        parts = str(val).split("/") if val else []
        kept = []
        for part in parts:
            names = [fix_name(n) for n in part.split() if n]
            if mode == "self":
                names = [n for n in names if n == me]
            else:
                names = [mask_name(n, me) for n in names]
            kept.append(" ".join(names))
        joined = " / ".join(kept)
        if joined.strip(" /"):
            out[route] = joined
    return out



# ---------------- 주간 식단표 ----------------
MEAL_KEYS = {"아침": "breakfast", "점심": "lunch", "저녁": "dinner"}


def find_menu_md(ws):
    base = os.path.join(ws, "scheduled-actions")
    if not os.path.isdir(base):
        return None
    for name in sorted(os.listdir(base)):
        p = os.path.join(base, name, "menu.md")
        if os.path.exists(p):
            return p
    return None


def parse_menu_md(path):
    """menu.md 를 읽어 주차별 날짜별 아침·점심·저녁으로 나눈다."""
    weeks = []
    week = None
    day = None
    meal = None
    for line in open(path, encoding="utf-8").read().splitlines():
        m = re.match(r"^##\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})", line)
        if m:
            week = {"start": m.group(1), "end": m.group(2), "days": []}
            weeks.append(week)
            day = None
            continue
        if week is None:
            continue
        m = re.match(r"^-\s*(\d{4}-\d{2}-\d{2})\s*\(([^)]+)\)", line)
        if m:
            day = {"date": m.group(1), "dow": m.group(2), "breakfast": [], "lunch": [], "dinner": []}
            week["days"].append(day)
            continue
        m = re.match(r"^\s+-\s*(아침|점심|저녁)\s*:\s*(.+?)\s*$", line)
        if m and day is not None:
            items = [x.strip() for x in m.group(2).split(",") if x.strip()]
            day[MEAL_KEYS[m.group(1)]] = items
    return [w for w in weeks if w["days"]]


def build_menu(ws):
    path = find_menu_md(ws)
    if not path:
        return 0
    weeks = parse_menu_md(path)
    if not weeks:
        return 0
    with open(os.path.join(OUT, "menu.json"), "w", encoding="utf-8") as f:
        json.dump({"weeks": weeks, "source": "대진지부 주간식단표"}, f,
                  ensure_ascii=False, separators=(",", ":"))
    return len(weeks)


def main():
    global NAME_FIXES
    NAME_FIXES = load_name_fixes()
    cfg = load_config()
    mode = cfg.get("nameMode", "mask")
    me = cfg.get("selfName", "박병수")
    # 안전장치: 실명 그대로 배포는 저장소에 ALLOW_FULL_NAMES 파일이 있을 때만 허용한다.
    if mode == "full" and not os.path.exists(os.path.join(HERE, "ALLOW_FULL_NAMES")):
        sys.exit("중단: nameMode=full 은 ALLOW_FULL_NAMES 파일이 있을 때만 허용됩니다. "
                 "(공개 저장소에 동료 실명이 올라갑니다)")
    os.makedirs(OUT, exist_ok=True)

    files = sorted(f for f in os.listdir(SRC) if re.match(r"^\d{4}-\d{2}-\d{2}\.json$", f))
    index = []
    kept = []
    for fn in files:
        with open(os.path.join(SRC, fn), encoding="utf-8") as f:
            d = json.load(f)
        date = d.get("date") or fn[:-5]
        routes = []
        for r in d.get("routes", []):
            vehicles = []
            for v in r.get("vehicles", []):
                tv = trim_vehicle(v, mode, me)
                if tv is not None:
                    vehicles.append(tv)
            if not vehicles and mode == "self":
                continue
            routes.append({
                "route": r.get("route"),
                "vehicle_count": r.get("vehicle_count") or len(vehicles),
                "vehicles": vehicles,
            })
        if not routes:
            continue
        out = {
            "date": date,
            "weekday": d.get("weekday"),
            "routes": routes,
        }
        fur = trim_furlough(d.get("furlough"), mode, me)
        if fur:
            out["furlough"] = fur
        unc = [{"route": r_, "no": n_, "shift": s_}
               for (r_, n_, s_) in UNCERTAIN_ROWS.get(date, [])]
        if unc:
            out["uncertain"] = unc
        with open(os.path.join(OUT, date + ".json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        kept.append(date)
        index.append({"date": date, "weekday": out.get("weekday"),
                      "routes": [r["route"] for r in routes]})

    # 워크스페이스에서 사라진 날짜의 옛 파일은 지운다
    for old in os.listdir(OUT):
        if re.match(r"^\d{4}-\d{2}-\d{2}\.json$", old) and old[:-5] not in kept:
            os.remove(os.path.join(OUT, old))

    index.sort(key=lambda x: x["date"])
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"dates": index, "updated": kept[-1] if kept else None}, f,
                  ensure_ascii=False, separators=(",", ":"))

    default_person = me if mode in ("mask", "self") else me
    with open(os.path.join(OUT, "app-config.json"), "w", encoding="utf-8") as f:
        json.dump({"defaultPerson": default_person,
                   "masked": mode == "mask",
                   "nameMode": mode,
                   "updated": kept[-1] if kept else None}, f, ensure_ascii=False)

    nw = build_menu(WS)
    print("nameMode=%s, dates=%d (%s ~ %s), menu weeks=%d" % (mode, len(kept), kept[0] if kept else "-", kept[-1] if kept else "-", nw))


if __name__ == "__main__":
    main()
