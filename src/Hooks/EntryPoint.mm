// language: Objective-C++, file: src/Hooks/EntryPoint.mm, target: iOS arm64/arm64e
// Bootstrap constructor — runs at dylib load, waits for IL2CPP runtime, then
// initializes all subsystems in dependency order.
//
// Priority 101: Memory.mm installs SIGBUS/SIGSEGV fault handlers (always first)
// Priority 102: This file — waits for IL2CPP, then chains everything else
//
// FIXES applied:
//   FIX-5: resolve_api() and lua::initialize() now run on a background queue,
//          not on the main thread. The original code ran both inside the
//          dispatch_after(main_queue) block, which blocked the main thread while
//          scanning up to 64 MB of __TEXT and __DATA memory. Under memory
//          pressure (or simply due to cache-cold page reads), this scan could
//          stall the main thread long enough for the iOS watchdog to fire, or
//          cause UIKit to miss render deadlines and panic.
//          LTStartOverlay() is still dispatched to the main thread after
//          resolution completes, because UIKit requires all window/view
//          operations to run there.

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

        // Do not occupy the main queue while resolving IL2CPP or creating Lua.
        // UIKit work is handed back to the main queue only after initialization.
        dispatch_after(
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
            dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0),
            ^{
                @autoreleasepool {
                    bool api_ok = lt::il2cpp::resolve_api();
                    NSLog(@"[" LT_TOOL_TITLE "] IL2CPP API: %s | Metadata: %s",
                          api_ok ? "OK" : "PARTIAL (stripped binary)",
                          lt::il2cpp::version_string());

                    bool lua_ok = lt::lua::initialize();
                    NSLog(@"[" LT_TOOL_TITLE "] Lua runtime: %s",
                          lua_ok ? "OK" : "FAIL");

                    dispatch_async(dispatch_get_main_queue(), ^{
                        @autoreleasepool {
                            LTStartOverlay();
                            NSLog(@"[" LT_TOOL_TITLE "] Online. "
                                  "discord.gg/Kr2pvPfEUR | t.me/IL2CPPTool");
                        }
                    });
                }
            }
        );
    }
}
