#!/bin/sh

set -eu

source_dir=${1:-/src}
output_dir=${2:-/dist}
static_dir="$output_dir/static"

rm -rf "$output_dir"
mkdir -p "$static_dir"
cp "$source_dir/index.html" "$output_dir/index.html"
cp -R "$source_dir/static/." "$static_dir/"

for asset in style.css app.js; do
  extension=${asset##*.}
  basename=${asset%.*}
  hash=$(sha256sum "$source_dir/static/$asset" | cut -c1-12)
  fingerprinted_asset="$basename.$hash.$extension"

  mv "$static_dir/$asset" "$static_dir/$fingerprinted_asset"
  sed "s|/static/$asset|/static/$fingerprinted_asset|g" "$output_dir/index.html" > "$output_dir/index.html.tmp"
  mv "$output_dir/index.html.tmp" "$output_dir/index.html"
done
