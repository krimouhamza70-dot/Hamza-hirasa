#!/usr/bin/env bash
# يجلب موضوع البكالوريا في الرياضيات وإجابته النموذجية من eddirasa.com ويحوّل صفحاتهما إلى صور
# الاستعمال: tools/fetch-bac.sh <رمز الشعبة في الموقع: se|m|tm|ge|lp|lg> <السنة> <مجلد الإخراج>
set -euo pipefail
code="$1"; year="$2"; out="$3"
mkdir -p "$out"
UA="Mozilla/5.0"
for kind in subject correction; do
  if [ "$kind" = subject ]; then page="bac-math-$year-$code"; else page="correction-bac-math-$year-$code"; fi
  html="$out/$kind.html"
  curl -sL -m 40 -A "$UA" "https://eddirasa.com/$page/" -o "$html"
  pdf=$(grep -oE 'file=https%3A%2F%2Feddirasa\.com%2Fwp-content%2Fuploads%2F[^"&#]+\.pdf' "$html" | head -1 | sed 's/^file=//' | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))')
  if [ -z "$pdf" ]; then
    pdf=$(grep -oE 'https://eddirasa\.com/wp-content/uploads/[^"]+\.pdf' "$html" | head -1 || true)
  fi
  if [ -z "$pdf" ]; then echo "$kind: لم أجد ملف PDF في https://eddirasa.com/$page/"; continue; fi
  curl -sL -m 90 -A "$UA" "$pdf" -o "$out/$kind.pdf"
  pages=$(pdfinfo "$out/$kind.pdf" 2>/dev/null | awk '/^Pages/{print $2}')
  pdftoppm -r 110 -png "$out/$kind.pdf" "$out/$kind"
  echo "$kind: $pdf ($pages صفحات)"
done
