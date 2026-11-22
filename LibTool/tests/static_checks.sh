#!/usr/bin/env bash
# file: tests/static_checks.sh — SimpleXLibTool pre-build static validation
# Runs before every CI build and locally via: bash tests/static_checks.sh
set -euo pipefail

ERRORS=0
PASS=0

fail() { echo "  FAIL: $1"; ERRORS=$((ERRORS+1)); }
pass() { echo "  pass: $1"; PASS=$((PASS+1)); }

echo "=== SimpleXLibTool Static Checks ==="

# ------ Makefile gates -------------------------------------------------------
echo ""
echo "[ Makefile ]"
test -f Makefile                                 || fail "Makefile missing"
grep -q 'LIBRARY_NAME := LibTool'    Makefile    || fail "LIBRARY_NAME not LibTool"
grep -q 'library.mk'                 Makefile    || fail "library.mk not included"
grep -q 'arm64 arm64e'               Makefile    || fail "ARCHS must include arm64e"
grep -q 'std=c++20'                  Makefile    || fail "C++20 required"
grep -q 'lua54'                      Makefile    || fail "Lua 5.4 vendor source missing from Makefile"
grep -q 'imgui'                      Makefile    || fail "ImGui vendor source missing from Makefile"
grep -q 'imgui_impl_metal'           Makefile    || fail "imgui_impl_metal missing from Makefile"
pass "Makefile"

# ------ Required source files ------------------------------------------------
echo ""
echo "[ Source files ]"
SOURCES=(
    src/Core/Memory.mm
    src/Core/IL2CPP.mm
    src/Core/Scanner.mm
    src/Core/Hook.mm
    src/Lua/LuaRuntime.mm
    src/Lua/Bindings_ImGui.mm
    src/Lua/Bindings_IL2CPP.mm
    src/Lua/Bindings_Memory.mm
    src/Lua/Bindings_Hook.mm
    src/UI/Overlay.mm
    src/UI/Tab_Tools.mm
    src/UI/Tab_Dumper.mm
    src/UI/Tab_Script.mm
    src/UI/Tab_Settings.mm
    src/UI/Tab_LibTool.mm
    src/Hooks/EntryPoint.mm
)
for f in "${SOURCES[@]}"; do
    test -f "$f" || fail "Missing: $f"
done
pass "Source files (${#SOURCES[@]} checked)"

# ------ Required headers -----------------------------------------------------
echo ""
echo "[ Headers ]"
HEADERS=(
    include/LibTool/Config.hpp
    include/LibTool/Memory.hpp
    include/LibTool/IL2CPP.hpp
    include/LibTool/IL2CPPTypes.hpp
    include/LibTool/Hook.hpp
    include/LibTool/Scanner.hpp
    include/LibTool/LuaRuntime.hpp
    include/LibTool/Overlay.hpp
)
for h in "${HEADERS[@]}"; do
    test -f "$h" || fail "Missing header: $h"
    # Check for include guard or pragma once
    grep -q '#pragma once' "$h" || fail "Missing #pragma once in $h"
done
pass "Headers (${#HEADERS[@]} checked)"

# ------ Brand constants in Config.hpp ----------------------------------------
echo ""
echo "[ Brand constants ]"
grep -q 'LT_DISCORD_URL'   include/LibTool/Config.hpp || fail "LT_DISCORD_URL missing"
grep -q 'LT_TELEGRAM_URL'  include/LibTool/Config.hpp || fail "LT_TELEGRAM_URL missing"
grep -q 'discord.gg/Kr2pvPfEUR' include/LibTool/Config.hpp || fail "Discord URL content wrong"
grep -q 't.me/IL2CPPTool'  include/LibTool/Config.hpp || fail "Telegram URL content wrong"
grep -q 'LT_TOOL_TITLE'    include/LibTool/Config.hpp || fail "LT_TOOL_TITLE missing"
pass "Brand constants"

# ------ Lua bindings exports -------------------------------------------------
echo ""
echo "[ Lua binding exports ]"
grep -q 'luaopen_ImGui'   src/Lua/Bindings_ImGui.mm   || fail "luaopen_ImGui not defined"
grep -q 'luaopen_Class'   src/Lua/Bindings_IL2CPP.mm  || fail "luaopen_Class not defined"
grep -q 'luaopen_Memory'  src/Lua/Bindings_IL2CPP.mm  || fail "luaopen_Memory not defined"
grep -q 'luaopen_Hook'    src/Lua/Bindings_IL2CPP.mm  || fail "luaopen_Hook not defined"
pass "Lua binding exports"

# ------ ARM64 instruction coverage in Hook.mm --------------------------------
echo ""
echo "[ Hook.mm instruction coverage ]"
grep -q 'CBZ'   src/Core/Hook.mm || fail "CBZ  relocation missing from Hook.mm"
grep -q 'CBNZ'  src/Core/Hook.mm || fail "CBNZ relocation missing from Hook.mm"
grep -q 'TBZ'   src/Core/Hook.mm || fail "TBZ  relocation missing from Hook.mm"
grep -q 'TBNZ'  src/Core/Hook.mm || fail "TBNZ relocation missing from Hook.mm"
grep -q 'ADRP'  src/Core/Hook.mm || fail "ADRP relocation missing from Hook.mm"
grep -q 'ADR'   src/Core/Hook.mm || fail "ADR  relocation missing from Hook.mm"
pass "ARM64 instruction relocation coverage"

# ------ Resolution strategies in IL2CPP.mm -----------------------------------
echo ""
echo "[ IL2CPP resolution strategies ]"
grep -q 'resolve_via_dlsym'           src/Core/IL2CPP.mm || fail "dlsym strategy missing"
grep -q 'resolve_via_pattern_scan'    src/Core/IL2CPP.mm || fail "pattern scan strategy missing"
grep -q 'resolve_via_codereg_scan'    src/Core/IL2CPP.mm || fail "CodeReg scan strategy missing"
grep -q 'IL2CPP Root Domain'          src/Core/IL2CPP.mm || fail "domain string anchor missing"
pass "IL2CPP resolution strategies"

# ------ Overlay key functions ------------------------------------------------
echo ""
echo "[ Overlay UI ]"
grep -q 'LTStartOverlay'              src/UI/Overlay.mm   || fail "LTStartOverlay not implemented"
grep -q 'DrawEyeToggle'               src/UI/Overlay.mm   || fail "Eye toggle missing"
grep -q 'DrawEyesLogo'                src/UI/Overlay.mm   || fail "Eye logo drawing missing"
grep -q 'apply_theme'                 src/UI/Overlay.mm   || fail "apply_theme missing"
grep -q 'DiscordButton'               src/UI/Overlay.mm   || fail "Discord button missing"
grep -q 'TelegramButton'              src/UI/Overlay.mm   || fail "Telegram button missing"
grep -q 'LT_DISCORD_URL'              src/UI/Overlay.mm   || fail "Discord URL not referenced in Overlay"
pass "Overlay UI functions"

# ------ Credit URLs in Tab_Settings ------------------------------------------
echo ""
echo "[ Credits ]"
grep -q 'DiscordButton'               src/UI/Tab_Settings.mm || fail "Discord button not in Settings"
grep -q 'TelegramButton'              src/UI/Tab_Settings.mm || fail "Telegram button not in Settings"
grep -q 'LT_TOOL_TITLE'               src/UI/Tab_Settings.mm || fail "Tool title not in Settings"
pass "Credits / URLs"

# ------ PAC stripping --------------------------------------------------------
echo ""
echo "[ PAC / arm64e ]"
grep -q 'LT_STRIP_PTR'   include/LibTool/Memory.hpp    || fail "LT_STRIP_PTR macro missing"
grep -q 'LT_STRIP_FPTR'  include/LibTool/Memory.hpp    || fail "LT_STRIP_FPTR macro missing"
grep -q 'ptrauth'        include/LibTool/Memory.hpp    || fail "ptrauth include/check missing"
pass "PAC stripping macros"

# ------ Vendor checksum verification (optional — present in CI) --------------
echo ""
echo "[ Vendor checksums ]"
if [[ -f vendor/CHECKSUMS.sha256 ]]; then
    if command -v sha256sum &>/dev/null; then
        sha256sum -c vendor/CHECKSUMS.sha256 --quiet || fail "Vendor checksum mismatch"
        pass "Vendor checksums verified"
    else
        echo "  skip: sha256sum not available on this platform"
    fi
else
    echo "  skip: vendor/CHECKSUMS.sha256 not present (run scripts/fetch-vendor.sh first)"
fi

# ------ Final report ---------------------------------------------------------
echo ""
echo "==========================================="
echo "Checks passed: $PASS"
if [[ $ERRORS -gt 0 ]]; then
    echo "Checks FAILED: $ERRORS"
    echo "==========================================="
    exit 1
else
    echo "All static checks passed."
    echo "==========================================="
fi
