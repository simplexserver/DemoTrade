// language: Objective-C++, file: src/Lua/LuaRuntime.mm, target: iOS arm64/arm64e
// Embedded Lua 5.4 VM — init, pcall runner, OnDraw/OnUpdate dispatch.

#import <Foundation/Foundation.h>
#include "LibTool/LuaRuntime.hpp"
#include "LibTool/IL2CPP.hpp"
#include "LibTool/Config.hpp"
extern "C" {
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
}
#include <mutex>
#include <vector>
#include <string>
#include <atomic>

extern "C" {
int luaopen_ImGui(lua_State* L);
int luaopen_Class(lua_State* L);
int luaopen_Memory(lua_State* L);
int luaopen_Hook(lua_State* L);
}

namespace lt::lua {

static lua_State*         g_L{ nullptr };
static dispatch_queue_t   g_lua_queue{ nullptr };
static std::atomic<bool>  g_running{ false };
static std::vector<std::string> g_console;
static std::mutex               g_console_mutex;
// Lua states are not thread-safe. Serialize the render callback and queued VM work.
static std::recursive_mutex      g_lua_state_mutex;

void console_append(std::string line) noexcept {
    std::lock_guard lock(g_console_mutex);
    g_console.push_back(std::move(line));
    if (g_console.size() > LT_CONSOLE_MAX_LINES)
        g_console.erase(g_console.begin());
}

std::vector<std::string> console_snapshot() {
    std::lock_guard lock(g_console_mutex);
    return g_console;
}

static int lua_print_impl(lua_State* L) {
    int n = lua_gettop(L);
    std::string out;
    for (int i = 1; i <= n; ++i) {
        if (i > 1) out += "\t";
        size_t len = 0;
        const char* s = luaL_tolstring(L, i, &len);
        out.append(s, len);
        lua_pop(L, 1);
    }
    console_append(std::move(out));
    return 0;
}

bool initialize() noexcept {
    std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
    if (g_L) return true;
    g_lua_queue = dispatch_queue_create("lt.lua", DISPATCH_QUEUE_SERIAL);
    if (!g_lua_queue) return false;

    g_L = luaL_newstate();
    if (!g_L) return false;

    luaL_openlibs(g_L);
    lua_pushcfunction(g_L, lua_print_impl); lua_setglobal(g_L, "print");

    luaL_requiref(g_L, "ImGui",  luaopen_ImGui,  1); lua_pop(g_L, 1);
    luaL_requiref(g_L, "Class",  luaopen_Class,  1); lua_pop(g_L, 1);
    luaL_requiref(g_L, "Memory", luaopen_Memory, 1); lua_pop(g_L, 1);
    luaL_requiref(g_L, "Hook",   luaopen_Hook,   1); lua_pop(g_L, 1);

    // HR Dev Menu accesses these as globals without require
    lua_getglobal(g_L, "ImGui");  lua_setglobal(g_L, "ImGui");
    lua_getglobal(g_L, "Class");  lua_setglobal(g_L, "Class");
    lua_getglobal(g_L, "Memory"); lua_setglobal(g_L, "Memory");
    lua_getglobal(g_L, "Hook");   lua_setglobal(g_L, "Hook");

    // Sandbox: remove os.execute, os.exit
    lua_getglobal(g_L, "os");
    lua_pushnil(g_L); lua_setfield(g_L, -2, "execute");
    lua_pushnil(g_L); lua_setfield(g_L, -2, "exit");
    lua_pop(g_L, 1);

    console_append("Lua runtime initialized (bundled) " LT_LUA_VERSION);
    return true;
}

void shutdown() noexcept {
    std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
    g_running.store(false);
    if (g_L) { lua_close(g_L); g_L = nullptr; }
}

bool run_script(std::string_view source) noexcept {
    std::string src(source);
    dispatch_queue_t queue = nullptr;
    {
        std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
        if (!g_L || !g_lua_queue) return false;
        queue = g_lua_queue;
        g_running.store(true);
    }

    dispatch_async(queue, ^{
        std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
        if (!g_L) {
            g_running.store(false);
            return;
        }
        int err = luaL_loadbuffer(g_L, src.c_str(), src.size(), "script");
        if (err == LUA_OK) {
            console_append("UI script loaded");
            err = lua_pcall(g_L, 0, LUA_MULTRET, 0);
        }
        if (err != LUA_OK) {
            const char* msg = lua_tostring(g_L, -1);
            console_append(std::string("[ERR] ") + (msg ? msg : "unknown error"));
            lua_pop(g_L, 1);
        }
        lua_getglobal(g_L, "OnDraw");
        const bool has = lua_isfunction(g_L, -1);
        lua_pop(g_L, 1);
        if (!has) g_running.store(false);
    });
    return true;
}

void stop_script() noexcept {
    g_running.store(false);
    dispatch_queue_t queue = nullptr;
    {
        std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
        if (!g_L || !g_lua_queue) return;
        queue = g_lua_queue;
    }
    dispatch_async(queue, ^{
        std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
        if (!g_L) return;
        lua_pushnil(g_L); lua_setglobal(g_L, "OnDraw");
        lua_pushnil(g_L); lua_setglobal(g_L, "OnUpdate");
    });
    console_append("UI script stopped");
}

void dispatch_on_draw() noexcept {
    std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
    if (!g_L || !g_running.load()) return;
    lua_getglobal(g_L, "OnDraw");
    if (!lua_isfunction(g_L, -1)) { lua_pop(g_L, 1); return; }
    if (lua_pcall(g_L, 0, 0, 0) != LUA_OK) {
        const char* msg = lua_tostring(g_L, -1);
        if (msg) console_append(std::string("[ERR] OnDraw: ") + msg);
        lua_pop(g_L, 1);
    }
}

void dispatch_on_update() noexcept {
    std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
    if (!g_L || !g_running.load()) return;
    lua_getglobal(g_L, "OnUpdate");
    if (!lua_isfunction(g_L, -1)) { lua_pop(g_L, 1); return; }
    if (lua_pcall(g_L, 0, 0, 0) != LUA_OK) lua_settop(g_L, 0);
    else lua_pop(g_L, 1);
}

bool is_running() noexcept { return g_running.load(); }
lua_State* state() noexcept { return g_L; }

std::string eval_string(std::string_view expr) noexcept {
    std::lock_guard<std::recursive_mutex> lock(g_lua_state_mutex);
    if (!g_L) return "";
    std::string code = "return tostring(" + std::string(expr) + ")";
    if (luaL_dostring(g_L, code.c_str()) == LUA_OK) {
        const char* s = lua_tostring(g_L, -1);
        std::string r = s ? s : "nil";
        lua_pop(g_L, 1);
        return r;
    }
    lua_pop(g_L, 1);
    return "(error)";
}

} // namespace lt::lua
