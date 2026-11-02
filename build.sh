#!/bin/sh
# Builds 4ever-quick-panel.zip, ready for: gnome-extensions install --force 4ever-quick-panel.zip
set -e
cd "$(dirname "$0")"
glib-compile-schemas --strict schemas/
rm -f 4ever-quick-panel.zip
zip -qr 4ever-quick-panel.zip metadata.json extension.js prefs.js stylesheet.css LICENSE \
    schemas/*.gschema.xml schemas/gschemas.compiled
echo "Built 4ever-quick-panel.zip"
