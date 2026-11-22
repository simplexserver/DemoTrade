// language: Objective-C++, file: src/UI/Overlay.mm, target: iOS arm64/arm64e
// ImGui Metal overlay system — transparent MTKView above game, iOS touch forwarding,
// eye-logo master toggle, Deep Ocean theme, five-tab router, full custom widget library.

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>
#import <QuartzCore/QuartzCore.h>
#include "LibTool/Overlay.hpp"
#include "LibTool/LuaRuntime.hpp"
#include "LibTool/Config.hpp"
#include "imgui.h"
static inline ImVec4 IM_COL32_AS_VEC4(ImU32 c);
#include "backends/imgui_impl_metal.h"
#include <cmath>
#include <cstring>
#include <cstdio>
#include <unordered_map>
#include <string>

// ------ Forward declarations for tab renderers --------------------------------
namespace lt::ui {
void draw_tab_tools() noexcept;
void draw_tab_dumper() noexcept;
void draw_tab_script() noexcept;
void draw_tab_settings() noexcept;
void draw_tab_libtool() noexcept;
}

namespace lt::ui {

// ------ Global state ---------------------------------------------------------
static OverlayState g_state;
OverlayState& state() noexcept { return g_state; }

// ------ Theme application ----------------------------------------------------
void apply_theme() noexcept {
    ImGuiStyle& s = ImGui::GetStyle();
    s.WindowRounding       = 10.0f;
    s.FrameRounding        = 5.0f;
    s.ScrollbarRounding    = 7.0f;
    s.GrabRounding         = 5.0f;
    s.TabRounding          = 6.0f;
    s.ChildRounding        = 6.0f;
    s.PopupRounding        = 8.0f;
    s.WindowBorderSize     = 1.0f;
    s.FrameBorderSize      = 0.0f;
    s.WindowPadding        = { 12.0f, 10.0f };
    s.FramePadding         = { 8.0f, 4.0f };
    s.ItemSpacing          = { 8.0f, 6.0f };
    s.ItemInnerSpacing     = { 6.0f, 4.0f };
    s.ScrollbarSize        = 10.0f;
    s.GrabMinSize          = 10.0f;
    s.IndentSpacing        = 20.0f;

    // Style presets: 0=DeepOcean, 1=Sapphire, 2=Forest, 3=Crimson
    struct Palette { ImVec4 bg, panel, accent, accent2, text, dim; float rounding; };
    static const Palette palettes[] = {
        { {0.040f,0.055f,0.098f,0.97f}, {0.030f,0.040f,0.075f,1.0f},
          {0.000f,0.470f,0.800f,1.0f},  {0.000f,0.280f,0.520f,1.0f},
          {0.820f,0.880f,0.950f,1.0f},  {0.350f,0.440f,0.580f,1.0f}, 10.0f },
        { {0.040f,0.060f,0.120f,0.97f}, {0.030f,0.045f,0.090f,1.0f},
          {0.080f,0.360f,0.800f,1.0f},  {0.040f,0.200f,0.550f,1.0f},
          {0.800f,0.870f,0.980f,1.0f},  {0.300f,0.400f,0.600f,1.0f}, 8.0f },
        { {0.028f,0.065f,0.038f,0.97f}, {0.020f,0.050f,0.028f,1.0f},
          {0.100f,0.620f,0.200f,1.0f},  {0.060f,0.380f,0.120f,1.0f},
          {0.780f,0.960f,0.800f,1.0f},  {0.280f,0.500f,0.300f,1.0f}, 6.0f },
        { {0.090f,0.028f,0.030f,0.97f}, {0.070f,0.020f,0.022f,1.0f},
          {0.800f,0.100f,0.100f,1.0f},  {0.550f,0.060f,0.060f,1.0f},
          {0.980f,0.820f,0.800f,1.0f},  {0.600f,0.300f,0.280f,1.0f}, 7.0f },
    };
    int pi = g_state.style_index % 4;
    const auto& P = palettes[pi];
    s.WindowRounding = P.rounding;

    ImVec4* c = s.Colors;
    c[ImGuiCol_WindowBg]         = P.bg;
    c[ImGuiCol_ChildBg]          = P.panel;
    c[ImGuiCol_PopupBg]          = { P.bg.x+0.01f, P.bg.y+0.01f, P.bg.z+0.02f, 0.97f };
    c[ImGuiCol_Border]           = { P.accent2.x, P.accent2.y, P.accent2.z, 0.60f };
    c[ImGuiCol_BorderShadow]     = { 0,0,0,0 };
    c[ImGuiCol_FrameBg]          = { P.panel.x, P.panel.y, P.panel.z*1.5f, 1.0f };
    c[ImGuiCol_FrameBgHovered]   = { P.accent2.x*0.5f, P.accent2.y*0.5f, P.accent2.z*0.5f, 1.0f };
    c[ImGuiCol_FrameBgActive]    = { P.accent2.x*0.8f, P.accent2.y*0.8f, P.accent2.z*0.8f, 1.0f };
    c[ImGuiCol_TitleBg]          = P.panel;
    c[ImGuiCol_TitleBgActive]    = { P.panel.x+0.01f, P.panel.y+0.015f, P.panel.z+0.03f, 1.0f };
    c[ImGuiCol_MenuBarBg]        = P.panel;
    c[ImGuiCol_ScrollbarBg]      = { 0,0,0,0 };
    c[ImGuiCol_ScrollbarGrab]    = P.accent2;
    c[ImGuiCol_ScrollbarGrabHovered] = P.accent;
    c[ImGuiCol_ScrollbarGrabActive]  = P.accent;
    c[ImGuiCol_CheckMark]        = P.accent;
    c[ImGuiCol_SliderGrab]       = P.accent;
    c[ImGuiCol_SliderGrabActive] = P.accent;
    c[ImGuiCol_Button]           = { P.accent2.x, P.accent2.y, P.accent2.z, 0.80f };
    c[ImGuiCol_ButtonHovered]    = P.accent;
    c[ImGuiCol_ButtonActive]     = { P.accent.x*1.2f, P.accent.y*1.2f, P.accent.z*1.2f, 1.0f };
    c[ImGuiCol_Header]           = { P.accent2.x, P.accent2.y, P.accent2.z, 0.60f };
    c[ImGuiCol_HeaderHovered]    = P.accent2;
    c[ImGuiCol_HeaderActive]     = P.accent;
    c[ImGuiCol_Separator]        = { P.accent2.x, P.accent2.y, P.accent2.z, 0.50f };
    c[ImGuiCol_SeparatorHovered] = P.accent;
    c[ImGuiCol_SeparatorActive]  = P.accent;
    c[ImGuiCol_ResizeGrip]       = { 0,0,0,0 };
    c[ImGuiCol_ResizeGripHovered]= P.accent2;
    c[ImGuiCol_ResizeGripActive] = P.accent;
    c[ImGuiCol_Tab]              = P.panel;
    c[ImGuiCol_TabHovered]       = { P.accent2.x, P.accent2.y, P.accent2.z, 0.80f };
    c[ImGuiCol_TabActive]        = { P.accent.x, P.accent.y, P.accent.z, 0.90f };
    c[ImGuiCol_TabUnfocused]     = P.panel;
    c[ImGuiCol_TabUnfocusedActive]= { P.accent2.x, P.accent2.y, P.accent2.z, 0.60f };
    c[ImGuiCol_Text]             = P.text;
    c[ImGuiCol_TextDisabled]     = P.dim;
    c[ImGuiCol_PlotLines]        = P.accent;
    c[ImGuiCol_PlotLinesHovered] = { P.accent.x*1.2f, P.accent.y*1.2f, P.accent.z*1.2f, 1.0f };
    c[ImGuiCol_PlotHistogram]    = P.accent2;
    c[ImGuiCol_PlotHistogramHovered] = P.accent;
    c[ImGuiCol_TableHeaderBg]    = P.panel;
    c[ImGuiCol_TableBorderStrong]= { P.accent2.x, P.accent2.y, P.accent2.z, 0.80f };
    c[ImGuiCol_TableBorderLight] = { P.accent2.x, P.accent2.y, P.accent2.z, 0.30f };
    c[ImGuiCol_TableRowBg]       = { 0,0,0,0 };
    c[ImGuiCol_TableRowBgAlt]    = { P.text.x, P.text.y, P.text.z, 0.03f };
    c[ImGuiCol_NavHighlight]     = P.accent;
}

// ------ Custom widget implementations ----------------------------------------

void StatusLED(bool active, float radius) noexcept {
    ImVec2 pos = ImGui::GetCursorScreenPos();
    ImDrawList* dl = ImGui::GetWindowDrawList();
    float t = static_cast<float>(ImGui::GetTime());
    float pulse = active ? (0.75f + 0.25f * sinf(t * 3.0f)) : 0.5f;
    ImU32 col_outer = active
        ? IM_COL32(10, 180, 80, static_cast<int>(60 * pulse))
        : IM_COL32(180, 40, 40, 60);
    ImU32 col_inner = active
        ? IM_COL32(30, 220, 100, static_cast<int>(200 * pulse))
        : IM_COL32(200, 60, 60, 160);
    ImU32 col_core = active
        ? IM_COL32(80, 255, 140, 255)
        : IM_COL32(240, 80, 80, 255);

    ImVec2 center = { pos.x + radius + 2.0f, pos.y + ImGui::GetTextLineHeight() * 0.5f };
    dl->AddCircleFilled(center, radius * 2.2f, col_outer);
    dl->AddCircleFilled(center, radius * 1.4f, col_inner);
    dl->AddCircleFilled(center, radius,        col_core);
    ImGui::Dummy({ radius * 4.4f + 2.0f, ImGui::GetTextLineHeight() });
}

void Badge(std::string_view text, uint32_t bg_color, uint32_t text_color) noexcept {
    ImVec2 tsize = ImGui::CalcTextSize(text.data(), text.data() + text.size());
    ImVec2 pad  = { 6.0f, 2.0f };
    ImVec2 bmin = ImGui::GetCursorScreenPos();
    ImVec2 bmax = { bmin.x + tsize.x + pad.x * 2, bmin.y + tsize.y + pad.y * 2 };
    ImDrawList* dl = ImGui::GetWindowDrawList();
    dl->AddRectFilled(bmin, bmax, bg_color, 4.0f);
    dl->AddText({ bmin.x + pad.x, bmin.y + pad.y }, text_color,
                text.data(), text.data() + text.size());
    ImGui::Dummy({ bmax.x - bmin.x + 4.0f, bmax.y - bmin.y });
}

void TypeBadge(std::string_view type_name) noexcept {
    uint32_t col = lt::theme::TYPE_OBJECT;
    if (type_name.find("Int") != std::string_view::npos ||
        type_name.find("int") != std::string_view::npos ||
        type_name.find("UInt") != std::string_view::npos)
        col = lt::theme::TYPE_NUMBER;
    else if (type_name.find("Single") != std::string_view::npos ||
             type_name.find("Double") != std::string_view::npos ||
             type_name.find("float") != std::string_view::npos)
        col = lt::theme::TYPE_FLOAT;
    else if (type_name.find("Bool") != std::string_view::npos ||
             type_name.find("bool") != std::string_view::npos)
        col = lt::theme::TYPE_BOOL;
    else if (type_name.find("String") != std::string_view::npos ||
             type_name.find("string") != std::string_view::npos)
        col = lt::theme::TYPE_STRING;
    else if (type_name.find("[]") != std::string_view::npos ||
             type_name.find("List") != std::string_view::npos)
        col = lt::theme::TYPE_ARRAY;
    else if (type_name.find("Enum") != std::string_view::npos)
        col = lt::theme::TYPE_ENUM;
    Badge(type_name, col | 0xCC000000u, 0xFFFFFFFF);
}

void GlowText(std::string_view text, uint32_t text_col, uint32_t glow_col,
              float glow_radius) noexcept {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 pos = ImGui::GetCursorScreenPos();
    const char* s = text.data();
    const char* e = text.data() + text.size();
    // Glow passes (4 directions, fading alpha)
    uint32_t gc = glow_col & 0x00FFFFFFu;
    for (int d = 0; d < 4; ++d) {
        static const float dx[] = {-1,1,0,0};
        static const float dy[] = {0,0,-1,1};
        uint32_t alpha = static_cast<uint32_t>(60.0f * (glow_radius / 3.0f));
        dl->AddText({ pos.x + dx[d]*glow_radius, pos.y + dy[d]*glow_radius },
                    gc | (alpha << 24), s, e);
    }
    // Corner glows (dimmer)
    for (int d = 0; d < 4; ++d) {
        static const float dx[] = {-1,1,-1,1};
        static const float dy[] = {-1,-1,1,1};
        uint32_t alpha = static_cast<uint32_t>(35.0f * (glow_radius / 3.0f));
        dl->AddText({ pos.x + dx[d]*glow_radius*0.7f, pos.y + dy[d]*glow_radius*0.7f },
                    gc | (alpha << 24), s, e);
    }
    // Actual text
    ImVec2 tsize = ImGui::CalcTextSize(s, e);
    dl->AddText(pos, text_col, s, e);
    ImGui::Dummy(tsize);
}

void AnimSeparator(std::string_view id) noexcept {
    static std::unordered_map<std::string, float> s_progress;
    std::string key(id.empty() ? "default" : id);
    float& prog = s_progress[key];
    float dt = ImGui::GetIO().DeltaTime;
    prog = std::min(1.0f, prog + dt * 3.0f);

    ImVec2 pos  = ImGui::GetCursorScreenPos();
    float  w    = ImGui::GetContentRegionAvail().x;
    float  y    = pos.y + 1.0f;
    ImDrawList* dl = ImGui::GetWindowDrawList();

    // Background line
    dl->AddLine({ pos.x, y }, { pos.x + w, y }, IM_COL32(60, 80, 120, 60), 1.0f);
    // Animated glow sweep
    float glow_w = w * prog;
    if (glow_w > 0) {
        dl->AddRectFilledMultiColor(
            { pos.x, y - 1 }, { pos.x + glow_w, y + 1 },
            IM_COL32(0, 150, 255, 0), IM_COL32(0, 150, 255, 180),
            IM_COL32(0, 150, 255, 60), IM_COL32(0, 150, 255, 0));
    }
    ImGui::Dummy({ w, 3.0f });
}

void HexByte(uint8_t byte, bool modified, bool selected) noexcept {
    char buf[3];
    snprintf(buf, sizeof(buf), "%02X", byte);
    uint32_t col = IM_COL32(180, 200, 220, 255);
    if (byte == 0x00)       col = IM_COL32(80, 90, 110, 200);
    else if (byte >= 0x20 && byte < 0x7F) col = IM_COL32(140, 220, 160, 255);
    else if (modified)      col = IM_COL32(255, 180, 60, 255);
    if (selected) {
        ImVec2 p = ImGui::GetCursorScreenPos();
        ImVec2 sz = ImGui::CalcTextSize("FF");
        ImGui::GetWindowDrawList()->AddRectFilled(
            p, { p.x + sz.x + 2, p.y + sz.y },
            IM_COL32(0, 100, 200, 120), 2.0f);
    }
    ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(col), "%s", buf);
}

void MemSparkline(const float* values, int count, float width, float height,
                  uint32_t line_col) noexcept {
    if (!values || count < 2) return;
    ImVec2 origin = ImGui::GetCursorScreenPos();
    ImDrawList* dl = ImGui::GetWindowDrawList();
    dl->AddRectFilled(origin, { origin.x + width, origin.y + height },
                      IM_COL32(10, 15, 30, 180), 3.0f);

    float mn = values[0], mx = values[0];
    for (int i = 1; i < count; ++i) {
        mn = std::min(mn, values[i]);
        mx = std::max(mx, values[i]);
    }
    float range = mx - mn;
    if (range < 0.0001f) range = 1.0f;

    for (int i = 0; i < count - 1; ++i) {
        float x0 = origin.x + (float)i / (count - 1) * width;
        float x1 = origin.x + (float)(i+1) / (count - 1) * width;
        float y0 = origin.y + height - (values[i]   - mn) / range * height;
        float y1 = origin.y + height - (values[i+1] - mn) / range * height;
        // Gradient alpha based on recency
        uint32_t alpha = static_cast<uint32_t>(100 + 155 * (float)i / count);
        uint32_t col = (line_col & 0x00FFFFFF) | (alpha << 24);
        dl->AddLine({ x0, y0 }, { x1, y1 }, col, 1.5f);
    }
    ImGui::Dummy({ width, height });
}

bool AddressInput(const char* label, uintptr_t* addr) noexcept {
    char buf[20];
    snprintf(buf, sizeof(buf), "0x%016llX", static_cast<unsigned long long>(*addr));
    bool changed = ImGui::InputText(label, buf, sizeof(buf));
    if (changed) {
        unsigned long long v = 0;
        sscanf(buf, "0x%llX", &v);
        *addr = static_cast<uintptr_t>(v);
    }
    return changed;
}

void MethodSignature(std::string_view sig) noexcept {
    // Find the space separating return type from method name
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 pos = ImGui::GetCursorScreenPos();
    float x = pos.x;
    float y = pos.y;
    float lh = ImGui::GetTextLineHeight();

    size_t space = sig.find(' ');
    if (space != std::string_view::npos) {
        // Return type in cyan
        std::string ret(sig.substr(0, space + 1));
        dl->AddText({ x, y }, IM_COL32(80, 200, 255, 255), ret.c_str());
        x += ImGui::CalcTextSize(ret.c_str()).x;

        // Find '(' for the method name
        std::string rest(sig.substr(space + 1));
        size_t paren = rest.find('(');
        if (paren != std::string::npos) {
            std::string name = rest.substr(0, paren);
            std::string params = rest.substr(paren);
            dl->AddText({ x, y }, IM_COL32(220, 230, 240, 255), name.c_str());
            x += ImGui::CalcTextSize(name.c_str()).x;
            dl->AddText({ x, y }, IM_COL32(140, 160, 180, 200), params.c_str());
        } else {
            dl->AddText({ x, y }, IM_COL32(220, 230, 240, 255), rest.c_str());
        }
    } else {
        dl->AddText({ x, y }, IM_COL32(220, 230, 240, 255), sig.data(), sig.data() + sig.size());
    }
    ImGui::Dummy({ ImGui::GetContentRegionAvail().x, lh });
}

void ScanProgress(float fraction, size_t found, bool running) noexcept {
    char overlay[64];
    snprintf(overlay, sizeof(overlay), "%s | %zu found",
             running ? "Scanning..." : "Done", found);
    ImVec2 pos  = ImGui::GetCursorScreenPos();
    float  w    = ImGui::GetContentRegionAvail().x;
    float  h    = 18.0f;
    ImDrawList* dl = ImGui::GetWindowDrawList();

    // Track background
    dl->AddRectFilled(pos, { pos.x + w, pos.y + h }, IM_COL32(10, 15, 30, 200), 4.0f);
    // Fill
    float fill = w * std::max(0.0f, std::min(1.0f, fraction));
    if (fill > 0) {
        // Animated gradient if running
        float t = static_cast<float>(ImGui::GetTime());
        uint8_t a1 = running ? static_cast<uint8_t>(180 + 75 * sinf(t * 4.0f)) : 220;
        dl->AddRectFilledMultiColor(
            pos, { pos.x + fill, pos.y + h },
            IM_COL32(0, 80, 200, a1), IM_COL32(0, 160, 255, a1),
            IM_COL32(0, 120, 220, a1), IM_COL32(0, 60, 180, a1));
    }
    // Border
    dl->AddRect(pos, { pos.x + w, pos.y + h }, IM_COL32(0, 80, 160, 180), 4.0f);
    // Overlay text
    ImVec2 tsz = ImGui::CalcTextSize(overlay);
    dl->AddText({ pos.x + (w - tsz.x) * 0.5f, pos.y + (h - tsz.y) * 0.5f },
                IM_COL32(200, 220, 255, 255), overlay);
    ImGui::Dummy({ w, h });
}

void CopyableText(std::string_view text, bool mono) noexcept {
    if (ImGui::Selectable(text.data(), false,
                          ImGuiSelectableFlags_None,
                          { ImGui::GetContentRegionAvail().x,
                            ImGui::GetTextLineHeightWithSpacing() })) {
        ImGui::SetClipboardText(text.data());
    }
    if (ImGui::IsItemHovered()) {
        ImGui::SetTooltip("Click to copy");
    }
}

void DiscordButton(float width) noexcept {
    ImGui::PushStyleColor(ImGuiCol_Button,        IM_COL32_AS_VEC4(0xFF5865F2));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, IM_COL32_AS_VEC4(0xFF7289DA));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive,  IM_COL32_AS_VEC4(0xFF4752C4));
    if (ImGui::Button("  Discord Server", { width, 0 })) {
        NSURL* url = [NSURL URLWithString:@LT_DISCORD_URL];
        [[UIApplication sharedApplication] openURL:url options:@{} completionHandler:nil];
        ImGui::SetClipboardText(LT_DISCORD_URL);  // always copy (belt + suspenders)
    }
    ImGui::PopStyleColor(3);
    if (ImGui::IsItemHovered()) ImGui::SetTooltip(LT_DISCORD_URL);
}

void TelegramButton(float width) noexcept {
    ImGui::PushStyleColor(ImGuiCol_Button,        IM_COL32_AS_VEC4(0xFF0088CC));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, IM_COL32_AS_VEC4(0xFF33AAEE));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive,  IM_COL32_AS_VEC4(0xFF006699));
    if (ImGui::Button("  Telegram Updates", { width, 0 })) {
        NSURL* url = [NSURL URLWithString:@LT_TELEGRAM_URL];
        [[UIApplication sharedApplication] openURL:url options:@{} completionHandler:nil];
        ImGui::SetClipboardText(LT_TELEGRAM_URL);
    }
    ImGui::PopStyleColor(3);
    if (ImGui::IsItemHovered()) ImGui::SetTooltip(LT_TELEGRAM_URL);
}

// ------ Eye logo drawing -----------------------------------------------------
// Draws two stylized eyes (white/grey on dark, like the reference image).
// openness: 0.0=slit, 1.0=fully open. scale: 1.0 = 90x40 px per eye.
static void DrawOneEye(ImDrawList* dl, ImVec2 center, float scale,
                       float openness, bool hovered) noexcept {
    float W = 44.0f * scale;   // half-width
    float H = 20.0f * scale * openness;   // half-height, modulated by openness

    // Control points for upper and lower bezier curves
    float lx = center.x - W, rx = center.x + W;
    float cy = center.y;

    // --- Fill eye interior (dark navy) ---
    dl->PathClear();
    dl->PathLineTo({ lx, cy });
    dl->PathBezierCubicCurveTo(
        { lx + W * 0.30f, cy - H * 1.30f },
        { rx - W * 0.30f, cy - H * 1.30f },
        { rx, cy });
    dl->PathBezierCubicCurveTo(
        { rx - W * 0.28f, cy + H * 0.75f },
        { lx + W * 0.28f, cy + H * 0.75f },
        { lx, cy });
    dl->PathFillConvex(IM_COL32(5, 10, 22, 240));

    // --- Iris ---
    float iris_r = H * 0.88f;
    if (iris_r > 2.0f) {
        // Outer iris glow
        float t = static_cast<float>(ImGui::GetTime());
        uint8_t glow_a = hovered ? 160 : static_cast<uint8_t>(80 + 40 * sinf(t * 1.5f));
        dl->AddCircleFilled(center, iris_r * 1.15f, IM_COL32(30, 90, 180, glow_a));
        // Main iris
        dl->AddCircleFilled(center, iris_r, IM_COL32(25, 80, 180, 220));
        // Iris detail ring
        dl->AddCircle(center, iris_r * 0.75f, IM_COL32(50, 110, 200, 100), 32, 1.0f);
        // Pupil
        dl->AddCircleFilled(center, iris_r * 0.52f, IM_COL32(5, 8, 18, 240));
        // Specular highlight (top-left)
        ImVec2 spec = { center.x - iris_r * 0.28f, center.y - iris_r * 0.32f };
        dl->AddCircleFilled(spec, iris_r * 0.20f, IM_COL32(210, 235, 255, 180));
        // Secondary highlight
        ImVec2 spec2 = { center.x + iris_r * 0.20f, center.y + iris_r * 0.25f };
        dl->AddCircleFilled(spec2, iris_r * 0.09f, IM_COL32(180, 210, 255, 90));
    }

    // --- Eye outline ---
    uint8_t outline_a = hovered ? 255 : 200;
    float   outline_w = hovered ? 1.8f * scale : 1.3f * scale;
    dl->PathClear();
    dl->PathLineTo({ lx, cy });
    dl->PathBezierCubicCurveTo(
        { lx + W * 0.30f, cy - H * 1.30f },
        { rx - W * 0.30f, cy - H * 1.30f },
        { rx, cy });
    dl->PathBezierCubicCurveTo(
        { rx - W * 0.28f, cy + H * 0.75f },
        { lx + W * 0.28f, cy + H * 0.75f },
        { lx, cy });
    dl->PathStroke(IM_COL32(190, 210, 230, outline_a), ImDrawFlags_Closed, outline_w);

    // --- Upper lash line (thicker) ---
    dl->PathClear();
    dl->PathLineTo({ lx + W * 0.05f, cy - H * 0.1f });
    dl->PathBezierCubicCurveTo(
        { lx + W * 0.30f, cy - H * 1.35f },
        { rx - W * 0.30f, cy - H * 1.35f },
        { rx - W * 0.05f, cy - H * 0.1f });
    dl->PathStroke(IM_COL32(210, 225, 240, outline_a), ImDrawFlags_None, outline_w * 1.3f);
}

void DrawEyesLogo(ImDrawList* dl, ImVec2 center, float size) noexcept {
    if (!dl) return;
    float scale  = size / 90.0f;
    float sep    = 50.0f * scale;
    float t      = static_cast<float>(ImGui::GetTime());
    float open   = 0.90f + 0.08f * sinf(t * 1.2f);

    ImVec2 left_eye  = { center.x - sep, center.y };
    ImVec2 right_eye = { center.x + sep, center.y };

    bool hov = ImGui::IsWindowHovered(ImGuiHoveredFlags_RootAndChildWindows);
    DrawOneEye(dl, left_eye,  scale, open, hov);
    DrawOneEye(dl, right_eye, scale, open, hov);
}

// ------ Floating eye toggle button ------------------------------------------
// Small always-on-top ImGui window; click = toggle main tool, drag = reposition.
static ImVec2 g_toggle_pos{ 20.0f, 100.0f };

bool DrawEyeToggle() noexcept {
    bool pressed = false;
    float sz = 56.0f;

    ImGui::SetNextWindowPos(g_toggle_pos, ImGuiCond_Always);
    ImGui::SetNextWindowSize({ sz, sz }, ImGuiCond_Always);
    ImGui::SetNextWindowBgAlpha(0.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, { 0, 0 });
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0f);

    ImGuiWindowFlags flags = ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                             ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse |
                             ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_NoNav;

    if (ImGui::Begin("##eye_toggle", nullptr, flags)) {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        ImVec2 wpos = ImGui::GetWindowPos();

        // Dark rounded background
        float t = static_cast<float>(ImGui::GetTime());
        uint8_t ba = static_cast<uint8_t>(185 + 15 * sinf(t * 2.0f));
        dl->AddRectFilled({ wpos.x, wpos.y }, { wpos.x + sz, wpos.y + sz },
                          IM_COL32(5, 10, 22, ba), 12.0f);
        // Subtle border pulse
        uint8_t brd_a = static_cast<uint8_t>(80 + 60 * sinf(t * 1.5f));
        dl->AddRect({ wpos.x + 1, wpos.y + 1 }, { wpos.x + sz - 1, wpos.y + sz - 1 },
                    IM_COL32(0, 120, 220, brd_a), 11.0f, 0, 1.2f);

        // Eyes centered in the button
        DrawEyesLogo(dl, { wpos.x + sz * 0.5f, wpos.y + sz * 0.5f }, sz * 0.75f);

        // Invisible button for interaction (full button area)
        ImGui::SetCursorPos({ 0, 0 });
        if (ImGui::InvisibleButton("##eye_btn", { sz, sz })) {
            pressed = true;
        }
        // Drag handling
        if (ImGui::IsItemActive() && ImGui::IsMouseDragging(0, 4.0f)) {
            ImVec2 delta = ImGui::GetMouseDragDelta(0);
            g_toggle_pos.x += delta.x;
            g_toggle_pos.y += delta.y;
            // Clamp to screen
            ImVec2 dsz = ImGui::GetIO().DisplaySize;
            g_toggle_pos.x = std::max(0.0f, std::min(dsz.x - sz, g_toggle_pos.x));
            g_toggle_pos.y = std::max(0.0f, std::min(dsz.y - sz, g_toggle_pos.y));
            ImGui::ResetMouseDragDelta(0);
            pressed = false; // drag is not a press
        }
    }
    ImGui::End();
    ImGui::PopStyleVar(2);
    return pressed;
}

// ------ Main frame render ----------------------------------------------------
void draw_frame() noexcept {
    // Eye toggle always on top
    if (DrawEyeToggle()) {
        g_state.visible = !g_state.visible;
    }

    if (!g_state.visible) return;

    // --- Main tool window ---
    ImGuiIO& io = ImGui::GetIO();
    float def_w = 370.0f * g_state.ui_scale;
    float def_h = 580.0f * g_state.ui_scale;

    ImGui::SetNextWindowSize({ def_w, def_h }, ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowPos({ io.DisplaySize.x * 0.5f - def_w * 0.5f,
                              io.DisplaySize.y * 0.5f - def_h * 0.5f },
                            ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowSizeConstraints({ 280, 400 }, { io.DisplaySize.x, io.DisplaySize.y });

    ImGuiWindowFlags wflags = ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse;
    if (g_state.fullscreen) {
        ImGui::SetNextWindowPos({ 0, 0 }, ImGuiCond_Always);
        ImGui::SetNextWindowSize(io.DisplaySize, ImGuiCond_Always);
        wflags |= ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoResize |
                  ImGuiWindowFlags_NoTitleBar;
    }

    // Custom title bar gradient
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, { 0.0f, 0.0f });
    bool open = true;
    if (!ImGui::Begin("##libtool_main", &open, wflags)) {
        ImGui::End();
        ImGui::PopStyleVar();
        return;
    }
    if (!open) {
        g_state.visible = false;
        ImGui::End();
        ImGui::PopStyleVar();
        return;
    }
    ImGui::PopStyleVar();

    // --- Custom title bar ---
    if (!g_state.fullscreen) {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        ImVec2 wpos = ImGui::GetWindowPos();
        float  ww   = ImGui::GetWindowWidth();
        float  tbh  = 32.0f;

        // Title bar gradient
        dl->AddRectFilledMultiColor(
            wpos, { wpos.x + ww, wpos.y + tbh },
            IM_COL32(10, 20, 50, 240), IM_COL32(5, 15, 40, 240),
            IM_COL32(5, 10, 30, 240), IM_COL32(10, 20, 50, 240));
        // Accent line at bottom of title bar
        float t = static_cast<float>(ImGui::GetTime());
        uint8_t la = static_cast<uint8_t>(140 + 60 * sinf(t * 2.0f));
        dl->AddLine({ wpos.x, wpos.y + tbh - 1 },
                    { wpos.x + ww, wpos.y + tbh - 1 },
                    IM_COL32(0, 120, 220, la), 1.5f);

        // Title text
        const char* title = LT_TOOL_TITLE " v" LT_VERSION_STR;
        ImVec2 tsz = ImGui::CalcTextSize(title);
        dl->AddText({ wpos.x + 36.0f, wpos.y + (tbh - tsz.y) * 0.5f },
                    IM_COL32(180, 200, 230, 255), LT_TOOL_TITLE);
        // Version in dimmer color
        ImVec2 ntsz = ImGui::CalcTextSize(LT_TOOL_TITLE);
        dl->AddText({ wpos.x + 36.0f + ntsz.x + 4.0f, wpos.y + (tbh - tsz.y) * 0.5f },
                    IM_COL32(80, 110, 160, 255), " v" LT_VERSION_STR);

        // ▼ collapse button (draws as a triangle)
        ImVec2 btn_min = { wpos.x + 4.0f, wpos.y + 4.0f };
        ImVec2 btn_max = { wpos.x + 28.0f, wpos.y + tbh - 4.0f };
        bool btn_hov = ImGui::IsMouseHoveringRect(btn_min, btn_max);
        dl->AddRectFilled(btn_min, btn_max, btn_hov ? IM_COL32(0,80,160,160) : IM_COL32(0,40,80,100), 4.0f);
        ImVec2 tc = { (btn_min.x + btn_max.x) * 0.5f, (btn_min.y + btn_max.y) * 0.5f };
        dl->AddTriangleFilled(
            { tc.x - 5, tc.y - 3 }, { tc.x + 5, tc.y - 3 }, { tc.x, tc.y + 4 },
            IM_COL32(140, 180, 220, 220));
        if (btn_hov && ImGui::IsMouseClicked(0))
            g_state.visible = false;

        ImGui::SetCursorPos({ 0, tbh });
    }

    // --- Tab bar ---
    float aw = ImGui::GetContentRegionAvail().x;
    static const char* tab_names[] = { "Tools", "Dumper", "Script", "Settings", "LibTool" };
    static const ImU32 tab_active_colors[] = {
        IM_COL32(0,120,210,255), IM_COL32(130,100,200,255),
        IM_COL32(0,160,100,255), IM_COL32(180,130,0,255),
        IM_COL32(200,80,30,255)
    };

    ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, { 0.0f, 0.0f });
    ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, { 0.0f, 6.0f });
    float tab_w = aw / 5.0f;
    for (int i = 0; i < 5; ++i) {
        bool active = (g_state.active_tab == static_cast<Tab>(i));
        if (active) {
            ImGui::PushStyleColor(ImGuiCol_Button, tab_active_colors[i]);
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, tab_active_colors[i]);
            ImGui::PushStyleColor(ImGuiCol_ButtonActive,  tab_active_colors[i]);
        } else {
            ImGui::PushStyleColor(ImGuiCol_Button,        IM_COL32(10, 15, 35, 200));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, IM_COL32(20, 40, 80, 200));
            ImGui::PushStyleColor(ImGuiCol_ButtonActive,  IM_COL32(0, 80, 160, 200));
        }
        if (ImGui::Button(tab_names[i], { tab_w, 0 }))
            g_state.active_tab = static_cast<Tab>(i);
        ImGui::PopStyleColor(3);

        // Active tab underline
        if (active) {
            ImVec2 p0 = ImGui::GetItemRectMin();
            ImVec2 p1 = ImGui::GetItemRectMax();
            ImGui::GetWindowDrawList()->AddLine(
                { p0.x + 2, p1.y - 1.5f }, { p1.x - 2, p1.y - 1.5f },
                tab_active_colors[i], 2.5f);
        }
        if (i < 4) ImGui::SameLine(0, 0);
    }
    ImGui::PopStyleVar(2);
    ImGui::Separator();

    // --- Tab content ---
    ImGui::SetCursorPosY(ImGui::GetCursorPosY() + 2.0f);
    switch (g_state.active_tab) {
        case Tab::Tools:    draw_tab_tools();    break;
        case Tab::Dumper:   draw_tab_dumper();   break;
        case Tab::Script:   draw_tab_script();   break;
        case Tab::Settings: draw_tab_settings(); break;
        case Tab::LibTool:  draw_tab_libtool();  break;
    }

    ImGui::End();
}

} // namespace lt::ui

// ------ Objective-C overlay setup --------------------------------------------
@interface LTMetalView : MTKView <MTKViewDelegate>
@property (nonatomic, strong) id<MTLCommandQueue> commandQueue;
@end

@implementation LTMetalView

- (void)setup {
    self.device        = MTLCreateSystemDefaultDevice();
    self.commandQueue  = [self.device newCommandQueue];
    self.delegate      = self;
    self.clearColor    = MTLClearColorMake(0, 0, 0, 0);
    self.colorPixelFormat = MTLPixelFormatBGRA8Unorm;
    self.opaque        = NO;
    self.backgroundColor = UIColor.clearColor;
    self.paused        = NO;
    self.enableSetNeedsDisplay = NO;
    self.preferredFramesPerSecond = 60;

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;

    // Display size from screen
    CGRect bounds = [UIScreen mainScreen].nativeBounds;
    CGFloat scale = [UIScreen mainScreen].nativeScale;
    io.DisplaySize            = { (float)(bounds.size.width / scale),
                                  (float)(bounds.size.height / scale) };
    io.DisplayFramebufferScale = { (float)scale, (float)scale };

    // Font — load default + slightly larger size
    io.Fonts->AddFontDefault();
    io.FontGlobalScale = lt::ui::g_state.ui_scale;

    ImGui_ImplMetal_Init(self.device);
    lt::ui::apply_theme();
}

- (void)drawInMTKView:(MTKView*)view {
    if (!view.currentDrawable || !view.currentRenderPassDescriptor) return;

    ImGui_ImplMetal_NewFrame(view.currentRenderPassDescriptor);
    ImGui::NewFrame();

    // Font scale (can change in settings)
    ImGui::GetIO().FontGlobalScale = lt::ui::g_state.ui_scale;

    // Script OnDraw runs inside the ImGui frame
    lt::lua::dispatch_on_draw();

    // Tool UI
    lt::ui::draw_frame();

    ImGui::Render();

    id<MTLCommandBuffer> cb = [self.commandQueue commandBuffer];
    id<MTLRenderCommandEncoder> enc =
        [cb renderCommandEncoderWithDescriptor:view.currentRenderPassDescriptor];
    ImGui_ImplMetal_RenderDrawData(ImGui::GetDrawData(), cb, enc);
    [enc endEncoding];
    [cb presentDrawable:view.currentDrawable];
    [cb commit];
}

- (void)mtkView:(MTKView*)view drawableSizeWillChange:(CGSize)size {
    ImGuiIO& io = ImGui::GetIO();
    CGFloat s = [UIScreen mainScreen].nativeScale;
    io.DisplaySize = { (float)(size.width / s), (float)(size.height / s) };
}

// --- iOS Touch forwarding ---
- (void)forwardTouch:(UITouch*)touch down:(BOOL)down {
    CGPoint loc = [touch locationInView:self];
    ImGuiIO& io = ImGui::GetIO();
    CGFloat s   = [UIScreen mainScreen].nativeScale;
    io.AddMousePosEvent(loc.x * s, loc.y * s);
    if (down) io.AddMouseButtonEvent(0, true);
    else      io.AddMouseButtonEvent(0, false);
}
- (void)touchesBegan:(NSSet<UITouch*>*)t  withEvent:(UIEvent*)e { [self forwardTouch:t.anyObject down:YES]; }
- (void)touchesMoved:(NSSet<UITouch*>*)t  withEvent:(UIEvent*)e { [self forwardTouch:t.anyObject down:YES]; }
- (void)touchesEnded:(NSSet<UITouch*>*)t  withEvent:(UIEvent*)e {
    [self forwardTouch:t.anyObject down:NO];
    ImGui::GetIO().AddMousePosEvent(-FLT_MAX, -FLT_MAX);
}
- (void)touchesCancelled:(NSSet<UITouch*>*)t withEvent:(UIEvent*)e {
    ImGui::GetIO().AddMouseButtonEvent(0, false);
    ImGui::GetIO().AddMousePosEvent(-FLT_MAX, -FLT_MAX);
}

@end

// Window that only captures touches inside the ImGui overlay, not in the game.
@interface LTOverlayWindow : UIWindow
@end
@implementation LTOverlayWindow
- (UIView*)hitTest:(CGPoint)point withEvent:(UIEvent*)event {
    UIView* hit = [super hitTest:point withEvent:event];
    return (hit == self) ? nil : hit;
}
@end

// ------ Public entry point ---------------------------------------------------
void LTStartOverlay(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        UIWindowScene* scene = nil;
        for (UIScene* s in [UIApplication sharedApplication].connectedScenes) {
            if ([s isKindOfClass:[UIWindowScene class]]) {
                scene = (UIWindowScene*)s;
                break;
            }
        }

        CGRect frame = [UIScreen mainScreen].bounds;
        LTOverlayWindow* window = [[LTOverlayWindow alloc]
            initWithWindowScene:scene ?: nil];
        if (!window.windowScene) {
            // Fallback for older iOS init paths
            window.frame = frame;
        }
        window.windowLevel = UIWindowLevelAlert + 100;
        window.backgroundColor = UIColor.clearColor;
        window.opaque = NO;
        window.hidden = NO;
        [window makeKeyAndVisible];

        LTMetalView* mv = [[LTMetalView alloc] initWithFrame:frame];
        [mv setup];
        window.rootViewController = [[UIViewController alloc] init];
        window.rootViewController.view = mv;
    });
}

// ImU32 → ImVec4 helper used in apply_theme
static inline ImVec4 IM_COL32_AS_VEC4(ImU32 c) {
    return ImGui::ColorConvertU32ToFloat4(c);
}
