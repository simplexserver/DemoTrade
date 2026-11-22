#pragma once
// language: C++20, file: include/LibTool/Config.hpp, target: iOS arm64/arm64e
// SimpleXLibTool — runtime inspection engine
// Credits: discord.gg/Kr2pvPfEUR | t.me/IL2CPPTool

#include <cstdint>

// ------ Version ---------------------------------------------------------------
#define LT_VERSION_MAJOR 1
#define LT_VERSION_MINOR 1
#define LT_VERSION_PATCH 0
#define LT_VERSION_STR   "1.1.0"
#define LT_TOOL_TITLE    "SimpleXLibTool"
#define LT_LUA_VERSION   "vLua 5.4"

// ------ Brand -----------------------------------------------------------------
#define LT_DISCORD_URL   "https://discord.gg/Kr2pvPfEUR"
#define LT_TELEGRAM_URL  "https://t.me/IL2CPPTool"
#define LT_CREDIT_LINE   "discord.gg/Kr2pvPfEUR"
#define LT_CREDIT_TG     "t.me/IL2CPPTool"

// ------ Feature flags ---------------------------------------------------------
#ifndef LT_USE_DOBBY
#  define LT_USE_DOBBY 0          // set 1 to link DobbyHook instead of from-scratch trampoline
#endif

#ifndef LT_MAX_HOOKS
#  define LT_MAX_HOOKS 256
#endif

#ifndef LT_CONSOLE_MAX_LINES
#  define LT_CONSOLE_MAX_LINES 512
#endif

#ifndef LT_SCRIPT_EDITOR_SIZE
#  define LT_SCRIPT_EDITOR_SIZE (64 * 1024)   // 64 KB editor buffer
#endif

#ifndef LT_FINDOBJ_MAX
#  define LT_FINDOBJ_MAX 2048
#endif

// ------ Deep Ocean theme palette (ImU32 for DrawList, ImVec4 for style) -------
namespace lt::theme {

// Backgrounds
constexpr uint32_t BG_WINDOW    = 0xF7190D0A;   // #0A0D19 — deepest navy
constexpr uint32_t BG_CHILD     = 0xF5120B08;   // #080B12
constexpr uint32_t BG_FRAME     = 0xFF160C07;   // #07 0C16
constexpr uint32_t BG_HEADER    = 0xFF2A1A0E;   // pinned row

// Accents
constexpr uint32_t ACCENT_CYAN  = 0xFFFF9900;   // #0099FF — primary cyan
constexpr uint32_t ACCENT_BLUE  = 0xFFBF6F1E;   // #1E6FBF — button base
constexpr uint32_t ACCENT_HOV   = 0xFFDF8F2A;   // hover
constexpr uint32_t ACCENT_ACT   = 0xFFFF9F00;   // active/pressed

// Status
constexpr uint32_t COL_OK       = 0xFF72BF1D;   // #1DBF72 green
constexpr uint32_t COL_ERR      = 0xFF5050E0;   // #E05050 red
constexpr uint32_t COL_WARN     = 0xFF4090E0;   // #E09040 amber
constexpr uint32_t COL_INFO     = 0xFF9999CC;   // muted blue-grey

// Type badge colors (for IL2CPP type annotation)
constexpr uint32_t TYPE_NUMBER  = 0xFF803C00;   // #003C80 blue
constexpr uint32_t TYPE_FLOAT   = 0xFF006E8C;   // teal
constexpr uint32_t TYPE_BOOL    = 0xFF005AD4;   // orange
constexpr uint32_t TYPE_STRING  = 0xFF2DBF1D;   // green
constexpr uint32_t TYPE_OBJECT  = 0xFFBF7700;   // gold
constexpr uint32_t TYPE_ARRAY   = 0xFF8C1E8C;   // purple
constexpr uint32_t TYPE_ENUM    = 0xFF8C4500;   // dark orange
constexpr uint32_t TYPE_STRUCT  = 0xFF4A6E8C;   // steel

// Text
constexpr uint32_t TEXT_BRIGHT  = 0xFFF0E8E0;   // primary text
constexpr uint32_t TEXT_DIM     = 0xFF907060;   // secondary
constexpr uint32_t TEXT_FAINT   = 0xFF503C2C;   // disabled

// Eye toggle
constexpr uint32_t EYE_IRIS     = 0xFFE69930;   // #3099E6 blue iris
constexpr uint32_t EYE_OUTLINE  = 0xFFDCEBF0;   // near-white outline

} // namespace lt::theme
