// language: Objective-C++, file: src/UI/Tab_Script.mm, target: iOS arm64/arm64e
// Script tab — editor, console with color parsing, API reference, HR Dev Menu compatible.

#import <Foundation/Foundation.h>
#include "LibTool/Overlay.hpp"
#include "LibTool/LuaRuntime.hpp"
#include "LibTool/Config.hpp"
#include "imgui.h"
#include <cstring>
#include <cstdio>

namespace lt::ui {

static char g_editor[LT_SCRIPT_EDITOR_SIZE]{};
static bool g_editor_init{ false };

static const char* k_sample_script = R"(-- SimpleXLibTool Sample Script
-- discord.gg/Kr2pvPfEUR | t.me/IL2CPPTool
local Time = Class.fromName("UnityEngine.Time")

function OnDraw()
    ImGui.SetNextWindowSize(280, 130, ImGui.Cond_FirstUseEver)
    if ImGui.Begin("Sample — SXL") then
        local ts = Time and tostring(Time.timeScale) or "?"
        ImGui.Text("timeScale: " .. ts)
        ImGui.Separator()
        if ImGui.Button("2x Speed", 120, 24) then
            if Time then Time:set_timeScale(2.0) end
        end
        ImGui.SameLine(0, 4)
        if ImGui.Button("1x Speed", 120, 24) then
            if Time then Time:set_timeScale(1.0) end
        end
    end
    ImGui.End()
end
)";

static const char* k_api_docs =
"=== Class API ===\n"
"Class.fromName(\"Namespace.ClassName\")  → cls or nil\n"
"cls:findObjects()  → table of objects\n"
"obj.fieldName  → value\n"
"obj.fieldName = value  → write\n"
"obj:MethodName(args)  → result\n"
"cls.new([args])  → new instance\n"
"\n=== Memory API ===\n"
"Memory.read_int32(addr)\n"
"Memory.read_float(addr)\n"
"Memory.read_ptr(addr)\n"
"Memory.read_ptr_chain(base, {offsets})\n"
"Memory.read_cstr(addr)\n"
"Memory.write_int32(addr, val)\n"
"Memory.write_float(addr, val)\n"
"Memory.write_ptr(addr, ptr)\n"
"Memory.aob_scan(pattern, [start], [end])\n"
"Memory.patch_ret(addr)\n"
"Memory.patch_nop(addr, [count])\n"
"\n=== Hook API ===\n"
"Hook.patch_ret(addr, [label])  → id\n"
"Hook.patch_nop(addr, [count], [label])  → id\n"
"Hook.disable(id)\n"
"Hook.enable(id)\n"
"Hook.remove(id)\n"
"\n=== ImGui (key) ===\n"
"ImGui.Begin(title [,open]) → bool\n"
"ImGui.End()\n"
"ImGui.Text(str)\n"
"ImGui.Button(label [,w,h]) → bool\n"
"ImGui.SliderFloat(lbl,v,min,max) → changed,v\n"
"ImGui.Checkbox(lbl,v) → changed,v\n"
"ImGui.InputText(lbl,s) → changed,s\n"
"ImGui.SetNextWindowSize(w,h [,cond])\n"
"ImGui.SameLine([offset])\n"
"ImGui.Separator()\n"
"ImGui.CollapsingHeader(lbl) → bool\n"
"ImGui.TreeNode(lbl) / TreePop()\n"
"ImGui.GetWindowDrawList() → DrawList\n"
"DrawList:AddLine/AddRect/AddCircle...\n"
"\n=== Callbacks ===\n"
"function OnDraw()  -- called every frame\n"
"function OnUpdate() -- called every physics tick\n";

// Colorize a console line based on prefix
static ImVec4 console_line_color(const char* line) {
    if (!line) return { 0.78f, 0.84f, 0.90f, 1.0f };
    if (strncmp(line, "[ERR]", 5) == 0)  return { 0.90f, 0.30f, 0.30f, 1.0f };
    if (strncmp(line, "[WARN]", 6) == 0) return { 0.90f, 0.65f, 0.20f, 1.0f };
    if (strncmp(line, "[Hook]", 6) == 0) return { 0.60f, 0.90f, 0.60f, 1.0f };
    if (strncmp(line, "[Patch]",7)== 0)  return { 1.00f, 0.70f, 0.30f, 1.0f };
    if (strncmp(line, "[Call]", 6) == 0) return { 0.60f, 0.80f, 1.00f, 1.0f };
    if (strncmp(line, "[LT]",  4) == 0)  return { 0.40f, 0.80f, 1.00f, 1.0f };
    if (strncmp(line, "[LibTool]",9)==0)  return { 0.40f, 0.80f, 1.00f, 1.0f };
    if (strncmp(line, "[Trace]", 7) == 0) return { 0.80f, 0.60f, 1.00f, 1.0f };
    if (strncmp(line, "Overload", 8) == 0) return { 0.60f, 1.00f, 0.80f, 1.0f };
    if (strncmp(line, "Method not found", 16) == 0) return { 1.0f, 0.60f, 0.40f, 1.0f };
    if (strncmp(line, "Lua runtime", 11) == 0) return { 0.50f, 0.90f, 1.00f, 1.0f };
    return { 0.78f, 0.84f, 0.90f, 1.0f };
}

void draw_tab_script() noexcept {
    if (!g_editor_init) {
        strncpy(g_editor, k_sample_script, LT_SCRIPT_EDITOR_SIZE - 1);
        g_editor_init = true;
    }

    bool running = lt::lua::is_running();
    float aw = ImGui::GetContentRegionAvail().x;

    // --- Toolbar row ---
    ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, { 8.0f, 4.0f });

    // Paste
    if (ImGui::Button("Paste", { 60, 24 })) {
        const char* cb = ImGui::GetClipboardText();
        if (cb) strncpy(g_editor, cb, LT_SCRIPT_EDITOR_SIZE - 1);
    }
    ImGui::SameLine(0, 4);
    // Sample
    if (ImGui::Button("</> Sample", { 76, 24 }))
        strncpy(g_editor, k_sample_script, LT_SCRIPT_EDITOR_SIZE - 1);
    ImGui::SameLine(0, 4);
    // Clear
    if (ImGui::Button("Clear", { 52, 24 }))
        memset(g_editor, 0, sizeof(g_editor));
    ImGui::SameLine(0, 4);

    // Run / Stop (color-coded)
    if (!running) {
        ImGui::PushStyleColor(ImGuiCol_Button,        IM_COL32(10, 140, 60, 220));
        ImGui::PushStyleColor(ImGuiCol_ButtonHovered, IM_COL32(20, 180, 80, 255));
        ImGui::PushStyleColor(ImGuiCol_ButtonActive,  IM_COL32(5,  110, 50, 255));
        if (ImGui::Button("▶ Run", { 56, 24 }))
            lt::lua::run_script(g_editor);
        ImGui::PopStyleColor(3);
    } else {
        ImGui::PushStyleColor(ImGuiCol_Button,        IM_COL32(160, 20, 20, 220));
        ImGui::PushStyleColor(ImGuiCol_ButtonHovered, IM_COL32(200, 30, 30, 255));
        ImGui::PushStyleColor(ImGuiCol_ButtonActive,  IM_COL32(130, 15, 15, 255));
        if (ImGui::Button("■ Stop", { 56, 24 }))
            lt::lua::stop_script();
        ImGui::PopStyleColor(3);
    }
    ImGui::SameLine(0, 8);

    // Status indicator with animated LED
    StatusLED(running, 5.0f);
    ImGui::SameLine(0, 4);
    ImGui::TextDisabled(running ? "UI script running" : "UI script stopped");

    ImGui::PopStyleVar();
    ImGui::Separator();

    // --- Editor (scrollable, with line numbers drawn via DrawList overlay) ---
    float avail_h = ImGui::GetContentRegionAvail().y;
    float editor_h = avail_h * 0.48f;
    float console_h = avail_h * 0.32f;

    // Line-number gutter width
    float ln_w = 36.0f;

    // Dark editor background
    ImVec2 editor_tl = ImGui::GetCursorScreenPos();
    ImGui::GetWindowDrawList()->AddRectFilled(
        editor_tl, { editor_tl.x + aw, editor_tl.y + editor_h },
        IM_COL32(5, 10, 22, 220), 4.0f);

    // Line numbers drawn in fixed column
    ImGui::GetWindowDrawList()->AddRectFilled(
        editor_tl, { editor_tl.x + ln_w, editor_tl.y + editor_h },
        IM_COL32(8, 15, 32, 240), 0.0f);

    // Count lines for numbering
    int line_count = 1;
    for (int i = 0; g_editor[i]; ++i)
        if (g_editor[i] == '\n') ++line_count;
    float lh = ImGui::GetTextLineHeight();
    for (int i = 0; i < std::min(line_count, (int)(editor_h / lh) + 1); ++i) {
        char ln_buf[8]; snprintf(ln_buf, sizeof(ln_buf), "%d", i + 1);
        ImGui::GetWindowDrawList()->AddText(
            { editor_tl.x + 2, editor_tl.y + i * lh },
            IM_COL32(60, 80, 110, 200), ln_buf);
    }

    // Editor offset right of line numbers
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ln_w);
    ImGui::PushStyleColor(ImGuiCol_FrameBg,         IM_COL32(0, 0, 0, 0));
    ImGui::PushStyleColor(ImGuiCol_ScrollbarBg,     IM_COL32(5, 10, 22, 160));
    ImGui::PushStyleColor(ImGuiCol_ScrollbarGrab,   IM_COL32(0, 80, 160, 200));

    ImGui::InputTextMultiline("##script_ed",
        g_editor, LT_SCRIPT_EDITOR_SIZE,
        { aw - ln_w, editor_h },
        ImGuiInputTextFlags_AllowTabInput);

    ImGui::PopStyleColor(3);

    // --- Console panel ---
    ImGui::Separator();
    // Header row
    ImGui::PushStyleColor(ImGuiCol_Text, IM_COL32(140, 180, 220, 255));
    ImGui::Text(">_ Console");
    ImGui::PopStyleColor();
    ImGui::SameLine(0, 6);
    ImGui::PushStyleColor(ImGuiCol_Button,        IM_COL32(50, 20, 20, 180));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, IM_COL32(90, 30, 30, 220));
    if (ImGui::SmallButton("■ Clear##console")) {
        // Clear by writing empty lines (console_snapshot returns a copy,
        // clearing via repeated console_append is not ideal; just invoke stop + re-init)
        lt::lua::console_append("\x01CLEAR");  // special token handled below
    }
    ImGui::PopStyleColor(2);

    ImGui::PushStyleColor(ImGuiCol_ChildBg, IM_COL32(5, 10, 22, 220));
    ImGui::BeginChild("##console_panel", { 0, console_h }, false,
                      ImGuiWindowFlags_HorizontalScrollbar);
    {
        auto lines = lt::lua::console_snapshot();
        // Handle clear token
        bool do_clear = false;
        for (auto& l : lines) if (l == "\x01CLEAR") { do_clear = true; break; }
        if (!do_clear) {
            for (auto& line : lines) {
                ImVec4 col = console_line_color(line.c_str());
                ImGui::PushStyleColor(ImGuiCol_Text, col);
                ImGui::TextUnformatted(line.c_str());
                ImGui::PopStyleColor();
            }
        }
        // Auto-scroll
        if (ImGui::GetScrollY() >= ImGui::GetScrollMaxY() - 2.0f)
            ImGui::SetScrollHereY(1.0f);
    }
    ImGui::EndChild();
    ImGui::PopStyleColor();

    // --- API Reference collapsible ---
    ImGui::Separator();
    if (ImGui::CollapsingHeader("API Reference")) {
        // Tab selector
        static int api_tab = 0;
        static const char* api_tabs[] = { "Class", "Memory", "Hook", "ImGui" };
        for (int i = 0; i < 4; ++i) {
            if (i > 0) ImGui::SameLine(0, 4);
            bool sel = (api_tab == i);
            if (sel) ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(0, 80, 160, 200));
            if (ImGui::SmallButton(api_tabs[i])) api_tab = i;
            if (sel) ImGui::PopStyleColor();
        }

        ImGui::PushStyleColor(ImGuiCol_ChildBg, IM_COL32(5, 10, 22, 180));
        ImGui::BeginChild("##api_docs", { 0, 180 }, true);
        // Show relevant section of k_api_docs
        const char* sections[] = { "=== Class API ===", "=== Memory API ===",
                                   "=== Hook API ===", "=== ImGui" };
        const char* start = strstr(k_api_docs, sections[api_tab]);
        const char* next  = api_tab < 3 ? strstr(start + 1, "===") : nullptr;
        if (start) {
            char buf[2048]{};
            if (next) {
                size_t len = std::min(sizeof(buf)-1, (size_t)(next - start));
                strncpy(buf, start, len);
            } else {
                strncpy(buf, start, sizeof(buf) - 1);
            }
            ImGui::PushStyleColor(ImGuiCol_Text, IM_COL32(140, 200, 255, 220));
            ImGui::TextUnformatted(buf);
            ImGui::PopStyleColor();
        }
        ImGui::EndChild();
        ImGui::PopStyleColor();
    }
}

} // namespace lt::ui
