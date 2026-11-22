#pragma once
// language: C++20, file: include/LibTool/LuaRuntime.hpp, target: iOS arm64/arm64e
// Embedded Lua 5.4 runtime — VM init, script runner, OnDraw/OnUpdate dispatch.

#include <string>
#include <string_view>
#include <functional>

// Forward-declare lua_State so callers don't need lua.h
struct lua_State;

namespace lt::lua {

// Initialize the Lua VM, open standard libs, register all LibTool bindings.
// Must be called after lt::il2cpp::resolve_api().
bool initialize() noexcept;

// Shut down the VM — frees all Lua state.
void shutdown() noexcept;

// Run a script string asynchronously (on the Lua serial dispatch queue).
// Errors are appended to the script console panel automatically.
bool run_script(std::string_view source) noexcept;

// Stop the currently running OnDraw/OnUpdate script.
void stop_script() noexcept;

// Called each ImGui frame — dispatches OnDraw() global if defined.
void dispatch_on_draw() noexcept;

// Called each physics/update tick — dispatches OnUpdate() global if defined.
void dispatch_on_update() noexcept;

// Check if a script is currently loaded and running.
[[nodiscard]] bool is_running() noexcept;

// Append a line to the script console (thread-safe).
void console_append(std::string line) noexcept;

// Low-level access for bindings.
[[nodiscard]] lua_State* state() noexcept;

// Execute a Lua expression and return its string representation.
[[nodiscard]] std::string eval_string(std::string_view expr) noexcept;

} // namespace lt::lua
