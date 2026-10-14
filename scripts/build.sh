#!/bin/sh
# Build dist/thwunderthreads-<version>.xpi from the source tree.
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="dist/thwunderthreads-$version.xpi"
mkdir -p dist
rm -f "$out"
zip -q -X -r "$out" manifest.json schema.json api.js content icons LICENSE README.md -x "*.DS_Store"
echo "$out"
