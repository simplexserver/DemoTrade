// language: Objective-C++, file: src/Hooks/EntryPoint.mm, target: iOS arm64/arm64e
// Bootstrap constructor — runs at dylib load, waits for IL2CPP runtime, then
// initializes all subsystems in dependency order.
//
// Priority 101: Memory.mm installs SIGBUS/SIGSEGV fault handlers (always first)
// Priority 102: This file — waits for IL2CPP, then chains everything else

#import <Foundation/Foundation.h>
#include "LibTool/Config.hpp"
#include "LibTool/Memory.hpp"
#include "LibTool/IL2CPP.hpp"
#include "LibTool/LuaRuntime.hpp"
#include "LibTool/Overlay.hpp"

__attribute__((constructor(102)))
static void LibToolEntry(void) {
    @autoreleasepool {
        NSLog(@"[" LT_TOOL_TITLE "] v" LT_VERSION_STR " loading...");

        // Step 1: Wait for Unity IL2CPP runtime to fully initialize.
        // When injected via DYLD_INSERT_LIBRARIES or jailbreak loader, the game's
        // __attribute__((constructor)) chain may not have run yet.
        // A 1.5-second dispatch delay covers Unity 6's slow metadata load on first run.
        dispatch_after(
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
            dispatch_get_main_queue(),
            ^{
                @autoreleasepool {
                    // Step 2: Resolve IL2CPP API (3 strategies: dlsym → pattern → struct)
                    bool api_ok = lt::il2cpp::resolve_api();
                    NSLog(@"[" LT_TOOL_TITLE "] IL2CPP API: %s | Metadata: %s",
                          api_ok ? "OK" : "PARTIAL (stripped binary)",
                          lt::il2cpp::version_string());

                    // Step 3: Initialize Lua VM and register all bindings.
                    // Must follow resolve_api() so bindings can verify the API table.
                    bool lua_ok = lt::lua::initialize();
                    NSLog(@"[" LT_TOOL_TITLE "] Lua runtime: %s", lua_ok ? "OK" : "FAIL");

                    // Step 4: Start the ImGui Metal overlay on the main thread.
                    LTStartOverlay();

                    NSLog(@"[" LT_TOOL_TITLE "] Online. discord.gg/Kr2pvPfEUR | t.me/IL2CPPTool");
                }
            }
        );
    }
}
