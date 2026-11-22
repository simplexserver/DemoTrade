// language: Objective-C++, file: src/Hooks/EntryPoint.mm, target: iOS arm64/arm64e
// Bootstrap: show the overlay independently of IL2CPP discovery, then resolve
// IL2CPP on a worker queue with bounded retries while Unity finishes startup.

#import <Foundation/Foundation.h>
#include "LibTool/Config.hpp"
#include "LibTool/Memory.hpp"
#include "LibTool/IL2CPP.hpp"
#include "LibTool/LuaRuntime.hpp"
#include "LibTool/Overlay.hpp"
#include <atomic>
#include <unistd.h>

static std::atomic<bool> g_bootstrap_started{false};

__attribute__((constructor(102)))
static void LibToolEntry(void) {
    bool expected = false;
    if (!g_bootstrap_started.compare_exchange_strong(expected, true)) return;

    @autoreleasepool {
        NSLog(@"[" LT_TOOL_TITLE "] v" LT_VERSION_STR " loading...");

        // Schedule UIKit initialization on the main queue without making the
        // menu depend on IL2CPP discovery. LTStartOverlay retries on scene activation.
        dispatch_after(
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)),
            dispatch_get_main_queue(),
            ^{
                @autoreleasepool {
                    LTStartOverlay();

                    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                        @autoreleasepool {
                            // Keep the first memory scan outside the immediate launch
                            // window; UIKit/Unity scene activation and runtime startup
                            // must settle before guarded VM inspection begins.
                            sleep(2);
                            // Install after app/Unity startup has had time to register
                            // its own crash handlers so our guarded reads can chain them.
                            lt::mem::install_fault_handlers();

                            bool api_ok = false;
                            constexpr int kAttempts = 8;
                            for (int attempt = 1; attempt <= kAttempts; ++attempt) {
                                api_ok = lt::il2cpp::resolve_api();
                                if (api_ok) break;
                                NSLog(@"[" LT_TOOL_TITLE "] IL2CPP not ready (attempt %d/%d)",
                                      attempt, kAttempts);
                                if (attempt != kAttempts) sleep(2);
                            }

                            NSLog(@"[" LT_TOOL_TITLE "] IL2CPP API: %s | Metadata: %s",
                                  api_ok ? "OK" : "UNAVAILABLE (runtime not resolved)",
                                  lt::il2cpp::version_string());

                            // Lua is independent of UIKit and is initialized even
                            // when metadata resolution is unavailable; the UI stays usable.
                            const bool lua_ok = lt::lua::initialize();
                            NSLog(@"[" LT_TOOL_TITLE "] Lua runtime: %s",
                                  lua_ok ? "OK" : "FAIL");
                        }
                    });
                }
            }
        );
    }
}
