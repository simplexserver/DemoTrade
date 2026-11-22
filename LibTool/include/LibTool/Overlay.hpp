#pragma once
// language: C++20, file: include/LibTool/Overlay.hpp, target: iOS arm64/arm64e
// ImGui Metal overlay system — eye toggle, five-tab window, custom widget library.

#include "Config.hpp"
#include <cstdint>
#include <string>
#include <string_view>

// Forward declarations
struct ImDrawList;
struct ImVec2;
struct ImVec4;

// ------ Overlay lifecycle (called from EntryPoint) ----------------------------
#ifdef __cplusplus
extern "C" {
#endif
void LTStartOverlay(void);  // must be called on main thread
#ifdef __cplusplus
}
#endif

namespace lt::ui {

// Active tab index
enum class Tab : int {
    Tools   = 0,
    Dumper  = 1,
    Script  = 2,
    Settings= 3,
    LibTool = 4,
};

// Global overlay state accessible to all tab renderers
struct OverlayState {
    Tab    active_tab{ Tab::Script };
    bool   visible{ true };          // main window shown
    float  ui_scale{ 1.0f };
    int    fps_cap{ 60 };
    float  scroll_speed{ 0.027f };
    int    style_index{ 0 };         // 0=DeepOcean, 1=Sapphire, 2=Forest, 3=Crimson
    bool   fullscreen{ false };
    bool   compact_mode{ false };
};

[[nodiscard]] OverlayState& state() noexcept;

// Apply the ImGui style theme for the current style_index.
void apply_theme() noexcept;

// Main per-frame render — called by the Metal view delegate.
void draw_frame() noexcept;

// ------ Custom widget library (LT:: prefix) ----------------------------------

// StatusLED: animated pulsing circle indicator.
// active=true → green pulse; false → dim red.
void StatusLED(bool active, float radius = 6.0f) noexcept;

// Badge: colored pill with text, like a GitHub label.
void Badge(std::string_view text, uint32_t bg_color, uint32_t text_color = 0xFFFFFFFF) noexcept;

// TypeBadge: IL2CPP type-specific colored badge.
void TypeBadge(std::string_view type_name) noexcept;

// GlowText: text rendered with a bloom/glow effect using multiple alpha passes.
void GlowText(std::string_view text, uint32_t text_col, uint32_t glow_col, float glow_radius = 3.0f) noexcept;

// AnimSeparator: horizontal separator that animates from left to right on first draw.
void AnimSeparator(std::string_view id = "") noexcept;

// HexByte: render a single hex byte value with background color based on category.
void HexByte(uint8_t byte, bool modified = false, bool selected = false) noexcept;

// MemSparkline: miniature inline line chart from an array of float values.
void MemSparkline(const float* values, int count, float width, float height,
                  uint32_t line_col = lt::theme::ACCENT_CYAN) noexcept;

// AddressInput: hex-formatted address input with "0x" prefix, monospace font.
// Returns true when value changed.
bool AddressInput(const char* label, uintptr_t* addr) noexcept;

// MethodSignature: render a method signature with syntax coloring.
// return_type=cyan, method_name=white, params=dim.
void MethodSignature(std::string_view sig) noexcept;

// ScanProgress: animated scanner progress bar with count overlay.
void ScanProgress(float fraction, size_t found, bool running) noexcept;

// CopyableText: text that shows "Copied!" tooltip and writes to clipboard on click.
void CopyableText(std::string_view text, bool mono = false) noexcept;

// Discord/Telegram link buttons — open URL or copy to clipboard.
void DiscordButton(float width = 0.0f) noexcept;
void TelegramButton(float width = 0.0f) noexcept;

// Draw the two-eye logo onto a draw list at a given center position.
void DrawEyesLogo(ImDrawList* dl, ImVec2 center, float size) noexcept;

// Draw the floating eye toggle button (master show/hide).
// Returns true if the toggle was pressed this frame.
bool DrawEyeToggle() noexcept;

} // namespace lt::ui

// Tab draw functions — implemented in Tab_*.mm
namespace lt::ui {
void draw_tab_tools() noexcept;
void draw_tab_dumper() noexcept;
void draw_tab_script() noexcept;
void draw_tab_settings() noexcept;
void draw_tab_libtool() noexcept;
}
