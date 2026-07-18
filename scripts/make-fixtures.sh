#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/fixtures/clips"
mkdir -p "$OUT"
# 90s from ~2:00 into each long mix — gentle CPU later
ffmpeg -y -ss 120 -t 90 -i "/home/madcoolseed/Music/140MarchPrep.wav" \
  -ac 2 -ar 44100 "$OUT/clip_a.wav"
ffmpeg -y -ss 180 -t 90 -i "/home/madcoolseed/Music/SamSupaRadioMix4Ntype0524EDIT.wav" \
  -ac 2 -ar 44100 "$OUT/clip_b.wav"
ffprobe -hide_banner "$OUT/clip_a.wav"
ffprobe -hide_banner "$OUT/clip_b.wav"
