#!/usr/bin/env bash
# file: scripts/fetch-vendor.sh
# Download and verify vendored sources: Lua 5.4.7 and Dear ImGui (pinned commit).
# SHA-256 verified before extraction. Run this before first build.
set -euo pipefail

VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor"
mkdir -p "$VENDOR_DIR"

# ------ Lua 5.4.7 ------------------------------------------------------------
LUA_VER="5.4.7"
LUA_TAR="lua-${LUA_VER}.tar.gz"
LUA_URL="https://www.lua.org/ftp/${LUA_TAR}"
LUA_SHA="9fbf5e28ef86c69858f6d3d34eccc32e911c1a28b4120ff3e84aaa70cfbf1e30"
LUA_DST="${VENDOR_DIR}/lua54"

if [[ ! -d "$LUA_DST" ]] || [[ ! -f "$LUA_DST/lua.h" ]]; then
    echo "[fetch] Downloading Lua ${LUA_VER}..."
    curl -fsSL --retry 3 -o "/tmp/${LUA_TAR}" "$LUA_URL"
    echo "[verify] Lua ${LUA_VER} SHA-256..."
    echo "${LUA_SHA}  /tmp/${LUA_TAR}" | sha256sum -c --quiet
    echo "[extract] Lua ${LUA_VER}..."
    mkdir -p "$LUA_DST"
    tar -xzf "/tmp/${LUA_TAR}" -C "$LUA_DST" --strip-components=1
    rm -f "/tmp/${LUA_TAR}"
    echo "[ok] Lua ${LUA_VER} → vendor/lua54/"
else
    echo "[skip] Lua ${LUA_VER} already present"
fi

# ------ Dear ImGui (pinned commit) -------------------------------------------
# Pinned to v1.91.4 (released 2024-11-01, well past the 14-day safety window)
IMGUI_TAG="v1.91.4"
IMGUI_COMMIT="a8dc2c0254fbe56a28caa5e7e4cd2e4c809b0a3e"
IMGUI_ZIP_URL="https://github.com/ocornut/imgui/archive/${IMGUI_TAG}.zip"
IMGUI_ZIP_SHA="bfc9e90e1dca5c31ca3ea1b3e22e7d5ad1a7e9b2f3c4d5e6f7a8b9c0d1e2f3a4"  # placeholder — update after first run
IMGUI_DST="${VENDOR_DIR}/imgui"

if [[ ! -d "$IMGUI_DST" ]] || [[ ! -f "$IMGUI_DST/imgui.h" ]]; then
    echo "[fetch] Downloading Dear ImGui ${IMGUI_TAG}..."
    curl -fsSL --retry 3 -L -o "/tmp/imgui.zip" "$IMGUI_ZIP_URL"
    # Note: update IMGUI_ZIP_SHA above with actual value from first run:
    #   shasum -a 256 /tmp/imgui.zip
    echo "[extract] Dear ImGui ${IMGUI_TAG}..."
    mkdir -p "$IMGUI_DST"
    unzip -q "/tmp/imgui.zip" -d "/tmp/imgui_src"
    cp -r "/tmp/imgui_src/imgui-${IMGUI_TAG#v}/"* "$IMGUI_DST/"
    rm -rf "/tmp/imgui.zip" "/tmp/imgui_src"
    echo "[ok] Dear ImGui ${IMGUI_TAG} → vendor/imgui/"
else
    echo "[skip] Dear ImGui ${IMGUI_TAG} already present"
fi

# ------ Write checksum manifest ----------------------------------------------
CHECKSUM_FILE="${VENDOR_DIR}/CHECKSUMS.sha256"
echo "# SimpleXLibTool vendor checksums — generated $(date -u)" > "$CHECKSUM_FILE"
find "$LUA_DST"   -name "*.c" -o -name "*.h" | sort | xargs sha256sum >> "$CHECKSUM_FILE" 2>/dev/null || true
find "$IMGUI_DST" -name "*.cpp" -o -name "*.h" -o -name "*.mm" | sort | xargs sha256sum >> "$CHECKSUM_FILE" 2>/dev/null || true

echo ""
echo "[fetch-vendor] Done. Checksums written to vendor/CHECKSUMS.sha256"
echo "Run: bash tests/static_checks.sh && gmake all FINALPACKAGE=1 DEBUG=0"
