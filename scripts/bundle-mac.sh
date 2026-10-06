#!/bin/bash
# Build a double-clickable macOS app that opens the anonymizer in the browser.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build

APP="$ROOT/release/ONUS-Tools.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/www"

if clang -arch arm64 -arch x86_64 -O2 -Wall -Wextra -o "$APP/Contents/MacOS/onus-serve" scripts/onus-serve.c; then
  :
else
  echo "Universal compile failed; building for this Mac only."
  clang -O2 -Wall -Wextra -o "$APP/Contents/MacOS/onus-serve" scripts/onus-serve.c
fi

cp scripts/macos-launcher.sh "$APP/Contents/MacOS/onus"
chmod +x "$APP/Contents/MacOS/onus" "$APP/Contents/MacOS/onus-serve"
cp -R dist/. "$APP/Contents/Resources/www/"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>ONUS-Tools</string>
  <key>CFBundleDisplayName</key>
  <string>ONUS-Tools</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.audiohacking.onus-tools</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleExecutable</key>
  <string>onus</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

codesign --force --sign - "$APP/Contents/MacOS/onus-serve"
codesign --force --sign - "$APP"
ditto -c -k --keepParent "$APP" "$ROOT/release/ONUS-Tools-mac.zip"
echo "Built $APP"
echo "Zip: $ROOT/release/ONUS-Tools-mac.zip"
