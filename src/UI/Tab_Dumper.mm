// language: Objective-C++, file: src/UI/Tab_Dumper.mm, target: iOS arm64/arm64e
// Dumper tab — assembly image list, class filter, dump.cs export.

#import <Foundation/Foundation.h>
#include "LibTool/Overlay.hpp"
#include "LibTool/IL2CPP.hpp"
#include "LibTool/LuaRuntime.hpp"
#include "LibTool/Config.hpp"
#include "imgui.h"
#include <cstdio>
#include <cstring>
#include <vector>
#include <string>
#include <atomic>
#include <thread>

namespace lt::ui {

static char  g_dump_filter[128]{};
static bool  g_dump_running{ false };
static float g_dump_progress{ 0.0f };
static size_t g_dump_found{ 0 };
static std::vector<std::pair<std::string, size_t>> g_image_list; // name, class count
static bool g_images_fetched{ false };
static int  g_sel_image{ 0 };

static void refresh_images() {
    g_image_list.clear();
    for (auto& [img, name] : lt::il2cpp::all_images()) {
        size_t cnt = lt::il2cpp::api().image_get_class_count
            ? lt::il2cpp::api().image_get_class_count(img) : 0;
        g_image_list.push_back({ name, cnt });
    }
    g_images_fetched = true;
}

static void run_dump(int image_idx) {
    g_dump_running  = true;
    g_dump_progress = 0.0f;
    g_dump_found    = 0;

    auto images = lt::il2cpp::all_images();
    if (image_idx < 0 || image_idx >= (int)images.size()) {
        g_dump_running = false; return;
    }
    auto& [img, iname] = images[image_idx];

    std::thread([img, iname]() {
        NSString* path = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject
                          stringByAppendingPathComponent:@"dump.cs"];
        FILE* f = fopen(path.UTF8String, "w");
        if (!f) { g_dump_running = false; return; }

        fprintf(f, "// SimpleXLibTool v%s — Dump\n// Image: %s\n\n",
                LT_VERSION_STR, iname.c_str());

        size_t total = lt::il2cpp::api().image_get_class_count
            ? lt::il2cpp::api().image_get_class_count(img) : 0;

        for (size_t i = 0; i < total; ++i) {
            g_dump_progress = total ? (float)i / total : 0.0f;
            if (!lt::il2cpp::api().image_get_class) break;
            Il2CppClass* k = lt::il2cpp::api().image_get_class(img, i);
            if (!k) continue;

            lt::il2cpp::ClassHandle ch{ k, lt::il2cpp::detected_version() };
            std::string fullname = ch.full_name();
            if (g_dump_filter[0] &&
                fullname.find(g_dump_filter) == std::string::npos) continue;

            fprintf(f, "// Class: %s (size 0x%X)\n", fullname.c_str(), ch.instance_size());
            for (auto& fd : ch.fields()) {
                fprintf(f, "    [%s 0x%zX] %s %s\n",
                        fd.is_static ? "static" : "field",
                        fd.offset, fd.type_name.c_str(), fd.name.c_str());
            }
            for (auto& md : ch.methods()) {
                uintptr_t ptr = lt::il2cpp::method_ptr(md.info);
                fprintf(f, "    // RVA: 0x%llX  %s\n",
                        (unsigned long long)ptr, md.signature.c_str());
            }
            fprintf(f, "\n");
            ++g_dump_found;
        }
        fclose(f);
        g_dump_progress = 1.0f;
        g_dump_running  = false;
        lt::lua::console_append(
            "[Dumper] Wrote " + std::to_string(g_dump_found) + " classes to dump.cs");
    }).detach();
}

void draw_tab_dumper() noexcept {
    if (!lt::il2cpp::api().resolved) {
        ImGui::TextDisabled("IL2CPP not resolved."); return;
    }

    float aw = ImGui::GetContentRegionAvail().x;

    if (!g_images_fetched || ImGui::Button("Refresh##dump", { 70, 22 }))
        refresh_images();

    ImGui::SameLine(0, 8);
    ImGui::SetNextItemWidth(aw - 80);
    ImGui::InputText("Filter##dumpf", g_dump_filter, sizeof(g_dump_filter));
    ImGui::Separator();

    // Image list
    ImGui::BeginChild("##img_list", { 0, ImGui::GetContentRegionAvail().y * 0.55f }, true);
    for (int i = 0; i < (int)g_image_list.size(); ++i) {
        auto& [name, cnt] = g_image_list[i];
        char lbl[256];
        snprintf(lbl, sizeof(lbl), "%s | %zu classes", name.c_str(), cnt);
        bool sel = (g_sel_image == i);
        if (ImGui::Selectable(lbl, sel)) g_sel_image = i;
    }
    ImGui::EndChild();

    ImGui::Separator();
    ScanProgress(g_dump_progress, g_dump_found, g_dump_running);
    ImGui::Spacing();

    if (!g_dump_running) {
        if (ImGui::Button("Export dump.cs", { aw * 0.6f, 28 }))
            run_dump(g_sel_image);
        ImGui::SameLine(0, 6);
        if (ImGui::Button("Copy path", { aw * 0.35f, 28 })) {
            NSString* p = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject
                           stringByAppendingPathComponent:@"dump.cs"];
            ImGui::SetClipboardText(p.UTF8String);
        }
    } else {
        ImGui::TextDisabled("Dumping — please wait...");
    }

    ImGui::Spacing();
    ImGui::TextDisabled("Output: Documents/dump.cs");
}

} // namespace lt::ui
