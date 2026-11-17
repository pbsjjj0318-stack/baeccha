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

# 판독이 불확실한 이름 (그 날짜에서만 표시)
UNCERTAIN = {
    "박진신": ["2026-11-20", "2026-11-21", "2026-11-22"],
}


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


def trim_vehicle(v, mode, me):
    trips = []
    for t in v.get("trips", []):
        item = {"no": t.get("no"), "depart": t.get("depart"), "derived": bool(t.get("derived"))}
        if not t.get("depart"):
            item["raw"] = t.get("raw")
        trips.append(item)
    out = {
        "no": v.get("no"),
        "vehicle": v.get("vehicle"),
        "trips": trips,
    }
    if v.get("company"):
        out["company"] = v["company"]
    am, pm = v.get("am_driver"), v.get("pm_driver")
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
        return f
    out = {}
    for route, val in f.items():
        parts = str(val).split("/") if val else []
        kept = []
        for part in parts:
            names = [n for n in part.split() if n]
            if mode == "self":
                names = [n for n in names if n == me]
            else:
                names = [mask_name(n, me) for n in names]
            kept.append(" ".join(names))
        joined = " / ".join(kept)
        if joined.strip(" /"):
            out[route] = joined
    return out


def main():
    cfg = load_config()
    mode = cfg.get("nameMode", "full")
    me = cfg.get("selfName", "박병수")
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
        if d.get("notes"):
            out["notes"] = d["notes"]
        unc = []
        for name, dates in UNCERTAIN.items():
            if date in dates:
                unc.append(mask_name(name, me) if mode == "mask" else name)
        if unc and mode != "self":
            out["uncertain_names"] = unc
        with open(os.path.join(OUT, date + ".json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        kept.append(date)
        index.append({"date": date, "weekday": out.get("weekday"),
                      "routes": [r["route"] for r in routes]})

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

    print("nameMode=%s, dates=%d (%s ~ %s)" % (mode, len(kept), kept[0] if kept else "-", kept[-1] if kept else "-"))


if __name__ == "__main__":
    main()
