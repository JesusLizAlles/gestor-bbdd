#!/usr/bin/env bash
# Genera resources/icon.png (Linux) y resources/icon.ico (Windows) a partir de resources/icon.svg.
# Requiere rsvg-convert (librsvg) e ImageMagick 7 (magick). Los ficheros generados se versionan,
# así que solo hace falta ejecutarlo al cambiar el SVG.
set -euo pipefail

cd "$(dirname "$0")/../resources"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

rsvg-convert -w 512 -h 512 icon.svg -o icon.png

sizes=(16 24 32 48 64 128 256)
frames=()
for size in "${sizes[@]}"; do
  rsvg-convert -w "$size" -h "$size" icon.svg -o "$tmp/$size.png"
  frames+=("$tmp/$size.png")
done
magick "${frames[@]}" icon.ico

echo "Generados icon.png (512 px) e icon.ico (${sizes[*]} px)"
