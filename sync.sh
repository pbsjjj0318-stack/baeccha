#!/bin/sh
# 배차 데이터를 이 저장소로 옮기고 GitHub 에 올린다.
# 사용: sh sync.sh [워크스페이스 경로]      (기본값 /workspace)
set -e
WS="${1:-/workspace}"
cd "$(dirname "$0")"
# 다른 실행이 먼저 올렸을 수 있으니 최신 상태로 맞춘다
git pull --rebase --autostash -q origin main 2>/dev/null || true
python3 build_data.py "$WS"
if [ -z "$(git status --porcelain)" ]; then
  echo "바뀐 내용 없음 — 올리지 않았습니다."
  exit 0
fi
git add -A
git -c user.name="pbsjjj0318-stack" \
    -c user.email="pbsjjj0318-stack@users.noreply.github.com" \
    commit -m "배차 데이터 갱신 $(date +%Y-%m-%d)"
git push origin main
echo "올렸습니다: https://pbsjjj0318-stack.github.io/baeccha/"
