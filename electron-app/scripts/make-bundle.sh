#!/bin/bash
# Build a self-contained GStreamer bundle for uxplay
set -e
BUNDLE=/tmp/uxplay-bundle
rm -rf $BUNDLE
mkdir -p $BUNDLE/bin $BUNDLE/plugins

# GStreamer plugins needed by uxplay pipelines:
# video: appsrc queue h264parse decodebin videoconvert videoscale d3d11videosink
# audio: avdec_aac avdec_alac audioconvert audioresample volume level wasapisink
PLUGINS="libgstapp libgstcoreelements libgsttypefindfunctions libgstplayback \
libgstvideoparsersbad libgstaudioparsers libgstvideoconvertscale libgstd3d11 \
libgstwasapi libgstaudioconvert libgstaudioresample libgstvolume libgstlevel \
libgstlibav libgstopenh264 libgstautodetect libgstvideofilter libgstaudiofx"

for p in $PLUGINS; do
  if [ -f /ucrt64/lib/gstreamer-1.0/$p.dll ]; then
    cp /ucrt64/lib/gstreamer-1.0/$p.dll $BUNDLE/plugins/
    echo "plugin: $p"
  else
    echo "MISSING plugin: $p"
  fi
done

# copy uxplay.exe
cp /tmp/UxPlay/build-dist/uxplay.exe $BUNDLE/bin/

# compute DLL closure via ldd
declare -A seen
queue=()
for f in $BUNDLE/bin/uxplay.exe $BUNDLE/plugins/*.dll; do
  queue+=("$f")
done

while [ ${#queue[@]} -gt 0 ]; do
  f="${queue[0]}"
  queue=("${queue[@]:1}")
  # ldd output lines like: libglib-2.0-0.dll => /ucrt64/bin/libglib-2.0-0.dll (0x...)
  while read -r dep; do
    base=$(basename "$dep")
    if [ -z "${seen[$base]}" ]; then
      seen[$base]=1
      cp "$dep" $BUNDLE/bin/
      queue+=("$dep")
    fi
  done < <(ldd "$f" 2>/dev/null | grep -o '/ucrt64/bin/[^ ]*' || true)
done

echo "---"
echo "Total DLLs: $(ls $BUNDLE/bin | wc -l)"
echo "Total plugins: $(ls $BUNDLE/plugins | wc -l)"
du -sh $BUNDLE
