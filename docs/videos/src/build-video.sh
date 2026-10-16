#!/bin/bash
# The instruction-video build: the made-up demo under a made-up company name, no logo.
set -e
cd /home/claude/real-sandbox/mobile
SEED="$(cat ${SP:?set SP to a scratch folder}/video/seed.json | tr -d '\n')"
EXPO_PUBLIC_TESTER=1 EXPO_PUBLIC_VIDEO=1 EXPO_PUBLIC_REAL_DEMO="$SEED" npx expo export --platform web --output-dir ${SP:?set SP to a scratch folder}/tester-video --clear > ${SP:?set SP to a scratch folder}/build-video.log 2>&1
python3 - <<'PY'
import re
sp='${SP:?set SP to a scratch folder}'
html=open(f'{sp}/tester-video/index.html').read()
src=re.search(r'<script src="([^"]+)"', html).group(1)
js=open(f'{sp}/tester-video{src}').read().replace('</script','<\\/script')
page='<!doctype html><html><head><meta charset="utf-8"><title>Real Sandbox</title><style>:root{color-scheme:dark}html,body{height:100%;margin:0;background:#17191C}body{overflow:hidden}#root{display:flex;height:100%;flex:1}</style></head><body><div id="root"></div><script>'+js+'</script></body></html>'
open(f'{sp}/video/plain.html','w').write(page); print(len(page)//1024,'KB')
PY
