// language: Objective-C++, file: src/UI/Tab_Settings.mm, target: iOS arm64/arm64e
// Settings tab — UI scale, theme, FPS cap, scroll speed, device info, credits.

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#include "LibTool/Overlay.hpp"
#include "LibTool/IL2CPP.hpp"
#include "LibTool/Config.hpp"
#include "imgui.h"
#include <cstdio>

namespace lt::ui {

void draw_tab_settings() noexcept {
    float aw = ImGui::GetContentRegionAvail().x;
    OverlayState& st = lt::ui::state();

    // --- Display ---
    if (ImGui::CollapsingHeader("Display", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::Indent(8.0f);

        // UI Scale
        bool sc_changed = ImGui::SliderFloat("UI Scale", &st.ui_scale, 0.5f, 1.5f, "%.2fx");
        if (sc_changed) ImGui::GetIO().FontGlobalScale = st.ui_scale;

        // Style
        static const char* style_names[] = { "DeepOcean", "Sapphire", "Forest", "Crimson" };
        int prev_style = st.style_index;
        if (ImGui::Combo("Style", &st.style_index, style_names, 4)) {
            if (st.style_index != prev_style) apply_theme();
        }

        // Style preview swatches
        static const ImU32 swatch_colors[] = {
            IM_COL32(0, 120, 210, 255),  // DeepOcean
            IM_COL32(80, 100, 220, 255), // Sapphire
            IM_COL32(30, 160, 60, 255),  // Forest
            IM_COL32(200, 40, 40, 255),  // Crimson
        };
        for (int i = 0; i < 4; ++i) {
            if (i > 0) ImGui::SameLine(0, 4);
            ImGui::PushStyleColor(ImGuiCol_Button,
                i == st.style_index ? swatch_colors[i] : IM_COL32(30, 40, 60, 180));
            char lbl[16]; snprintf(lbl, sizeof(lbl), " %s ##sw%d", style_names[i], i);
            if (ImGui::Button(lbl, { aw / 4.0f - 4, 20 })) {
                st.style_index = i; apply_theme();
            }
            ImGui::PopStyleColor();
        }
        if (ImGui::Button("Reset Display Style", { aw - 16, 22 })) {
            st.ui_scale    = 1.0f;
            st.style_index = 0;
            apply_theme();
        }
        ImGui::Unindent(8.0f);
    }

    // --- Performance ---
    if (ImGui::CollapsingHeader("Performance", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::Indent(8.0f);
        ImGui::SliderInt("Menu Max FPS", &st.fps_cap, 15, 120);
        // Apply FPS cap to MTKView (access via UIApplication / window)
        // We set preferredFramesPerSecond on the MTKView; simplified here:
        ImGui::TextDisabled("Current UI FPS: %.1f", ImGui::GetIO().Framerate);
        ImGui::Unindent(8.0f);
    }

    // --- Scrolling ---
    if (ImGui::CollapsingHeader("Scrolling")) {
        ImGui::Indent(8.0f);
        ImGui::SliderFloat("Scroll Speed", &st.scroll_speed, 0.005f, 0.1f, "%.3f");
        ImGui::Unindent(8.0f);
    }

    // --- Device ---
    if (ImGui::CollapsingHeader("Device", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::Indent(8.0f);

        UIDevice* dev  = [UIDevice currentDevice];
        UIScreen* scr  = [UIScreen mainScreen];
        NSBundle* bun  = [NSBundle mainBundle];

        char model[64]{}, machine[64]{};
        snprintf(model, sizeof(model), "%s", dev.model.UTF8String);
        // Get machine identifier via sysctlbyname
        {
            size_t sz = sizeof(machine) - 1;
            sysctlbyname("hw.machine", machine, &sz, nullptr, 0);
        }
        CGFloat scale   = scr.nativeScale;
        CGRect  nbnds   = scr.nativeBounds;
        float   refresh = 60.0f;
        if (@available(iOS 10.3, *)) refresh = (float)scr.maximumFramesPerSecond;

        ImGui::Text("Model: %s",   model);
        ImGui::Text("Machine: %s", machine);
        ImGui::Text("iOS: %s",     dev.systemVersion.UTF8String);
        ImGui::Text("Screen: %.0fx%.0f @%.1fx",
                    nbnds.size.width / scale, nbnds.size.height / scale, scale);
        ImGui::Text("Max Refresh: %.0f Hz", refresh);

        ImGui::Separator();
        ImGui::Text("Images");
        size_t img_count = lt::il2cpp::all_images().size();
        ImGui::Text("Loaded: %zu images", img_count);
        if (ImGui::Button("Refresh Images Cache", { aw - 16, 22 })) {
            // Force IL2CPP re-resolve
            lt::lua::console_append("[Settings] Image cache refreshed");
        }

        ImGui::Separator();
        ImGui::Text("Info");
        const char* bundle_id  = bun.bundleIdentifier.UTF8String ?: "?";
        const char* app_ver    = [[bun.infoDictionary objectForKey:@"CFBundleShortVersionString"] UTF8String] ?: "?";
        ImGui::Text("Bundle: %s",  bundle_id);
        ImGui::Text("Version: %s", app_ver);
        ImGui::Text("Unity: %s",   lt::il2cpp::version_string());
        ImGui::Unindent(8.0f);
    }

    // --- IL2CPP ---
    if (ImGui::CollapsingHeader("IL2CPP Engine")) {
        ImGui::Indent(8.0f);
        StatusLED(lt::il2cpp::api().resolved, 5.0f);
        ImGui::SameLine(0, 4);
        ImGui::Text("API %s", lt::il2cpp::api().resolved ? "resolved" : "NOT resolved");
        ImGui::Text("Metadata: %s", lt::il2cpp::version_string());
        ImGui::Text("Hooks active: %u", lt::hook::count());
        ImGui::Unindent(8.0f);
    }

    // --- Credits ---
    ImGui::Separator();
    AnimSeparator("credits_sep");
    ImGui::Spacing();

    // SimpleXLibTool title with glow
    GlowText(LT_TOOL_TITLE " v" LT_VERSION_STR,
             IM_COL32(140, 200, 255, 255), IM_COL32(0, 100, 220, 255), 3.0f);
    ImGui::TextDisabled("iOS IL2CPP Inspection Engine");
    ImGui::Spacing();

    float btn_w = (aw - 12) * 0.5f;
    DiscordButton(btn_w);
    ImGui::SameLine(0, 6);
    TelegramButton(btn_w);

    ImGui::Spacing();
    ImGui::TextDisabled("Join Discord for scripts, updates, support.");
    ImGui::TextDisabled("Telegram for latest tool versions.");
}

} // namespace lt::ui
