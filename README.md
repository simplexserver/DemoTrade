# SimpleXLibTool v1.1.0

iOS Unity IL2CPP runtime inspection engine. Works on any Unity IL2CPP game — not locked to one target.

**Discord:** discord.gg/Kr2pvPfEUR  
**Telegram (updates):** t.me/IL2CPPTool

---

## What it does

- **Script tab** — Lua 5.4 editor with full ImGui + IL2CPP API. Run scripts like the HR Dev Menu without modification.
- **Tools tab** — Live class tree, field inspector with live values, method invoker, Patcher (RET), Hooker, Caller/CallMainThread.
- **Dumper tab** — Enumerate all loaded assemblies and export a dump.cs-style file to Documents.
- **LibTool tab** — Hex editor, hook manager table, AOB scanner, pointer chain resolver, Cheat Engine-style diff scanner.
- **Settings tab** — Theme picker (DeepOcean / Sapphire / Forest / Crimson), UI scale, FPS cap, device info, credit links.

---

## Targets

- iOS 14.0+ arm64 / arm64e
- Any Unity IL2CPP game (Unity 2019–Unity 6)
- Jailbroken or jailed-loader injection

---

## Build

```bash
# 1. Fetch vendor sources (Lua 5.4.7 + Dear ImGui pinned)
bash scripts/fetch-vendor.sh

# 2. Run static checks
bash tests/static_checks.sh

# 3. Build
gmake all FINALPACKAGE=1 DEBUG=0

# Debug build (console output + assertions)
gmake all DEBUG=1 FINALPACKAGE=0
```

Requires Theos at `~/theos` and Xcode with the iOS SDK.  
CI runs on `macos-15` via `.github/workflows/build.yml`.

---

## IL2CPP resolution (stripped binaries)

Three strategies run in order:

1. **dlsym** — works on non-stripped builds (debug, some Unity 2019/2020)
2. **ARM64 pattern scan** — finds `il2cpp_domain_get` by its 3-instruction shape (`ADRP + LDR + RET`) in the main executable's `__TEXT` segment
3. **Structural scan** — walks `__DATA` for a valid `Il2CppCodeRegistration` to derive assembly/image access

Unity 6 (metadata v31, fully stripped) uses strategies 2 + 3.

---

## Lua API quick reference

```lua
-- Class resolution
local Hero = Class.fromName("Managers.Hunters.HeroesProgressManager")
local objs = Hero:findObjects()          -- table of live instances
local obj  = objs[1]

-- Field access
local hp = obj.currentHealth             -- read
obj.currentHealth = 999                  -- write

-- Method invocation
obj:MethodName(arg1, arg2)

-- Memory
Memory.read_int32(addr)
Memory.write_float(addr, 1.0)
Memory.aob_scan("48 8B ?? 00")

-- Hooks
Hook.patch_ret(addr)
Hook.patch_nop(addr, 4)

-- Frame callback
function OnDraw()
    ImGui.Begin("My Tool")
    ImGui.Text("hello")
    ImGui.End()
end
```

---

## Project layout

```
LibTool/
├── Makefile                    Theos library.mk, arm64+arm64e, C++20
├── control                     Debian package metadata
├── include/LibTool/            Public headers
│   ├── Config.hpp              Version, brand URLs, theme palette
│   ├── Memory.hpp              Fault-contained R/W engine
│   ├── IL2CPP.hpp              Runtime bridge public API
│   ├── IL2CPPTypes.hpp         Struct layouts v24–v31
│   ├── Hook.hpp                ARM64 trampoline API
│   ├── Scanner.hpp             AOB + diff scanner API
│   ├── LuaRuntime.hpp          Lua VM public API
│   └── Overlay.hpp             UI overlay + custom widgets
├── src/
│   ├── Core/                   Memory, IL2CPP bridge, Hook, Scanner
│   ├── Lua/                    Lua VM + all bindings
│   ├── UI/                     Overlay + 5 tab renderers
│   └── Hooks/EntryPoint.mm     Bootstrap constructor
├── vendor/
│   ├── lua54/                  Lua 5.4.7 source
│   └── imgui/                  Dear ImGui (pinned)
├── scripts/fetch-vendor.sh     Download + verify vendor sources
└── tests/static_checks.sh      Pre-build validation
```

---

## Credits

Built for the SimpleXServer community.  
Join: **discord.gg/Kr2pvPfEUR**  
Latest versions: **t.me/IL2CPPTool**
