// language: Objective-C++, file: src/UI/Tab_Dumper.mm, target: iOS arm64/arm64e
// Dumper tab — assembly image list, class filter, dump.cs export.
// IL2CPP work runs on an attached worker thread; the ImGui thread only renders snapshots.

#import <Foundation/Foundation.h>
#include "LibTool/Overlay.hpp"
#include "LibTool/IL2CPP.hpp"
#include "LibTool/LuaRuntime.hpp"
#include "LibTool/Config.hpp"
#include "imgui.h"
#include <cstdio>
#include <algorithm>
#include <utility>
#include <cstring>
#include <vector>
#include <string>
#include <atomic>
#include <thread>
#include <mutex>
#include <cstdlib>

namespace lt::ui {

struct DumpImage {
    const Il2CppImage* image{ nullptr };
    std::string name;
    size_t class_count{ 0 };
};

static char g_dump_filter[128]{};
static std::atomic<bool> g_dump_running{false};
static std::atomic<float> g_dump_progress{0.0f};
static std::atomic<size_t> g_dump_found{0};

static std::mutex g_image_mutex;
static std::vector<DumpImage> g_image_list;
static std::atomic<bool> g_images_fetched{false};
static std::atomic<bool> g_images_loading{false};
static int g_sel_image{0};

static void refresh_images() {
    bool expected = false;
    if (!g_images_loading.compare_exchange_strong(expected, true)) return;

    std::thread([] {
        @autoreleasepool {
            lt::il2cpp::Il2CppThreadScope thread_scope;
            const auto images = lt::il2cpp::all_images();

            std::vector<DumpImage> next;
            next.reserve(images.size());
            for (const auto& entry : images) {
                DumpImage item;
                item.image = entry.first;
                item.name = entry.second;
                item.class_count = lt::il2cpp::api().image_get_class_count
                    ? lt::il2cpp::api().image_get_class_count(item.image) : 0;
                next.push_back(std::move(item));
            }

            {
                std::lock_guard<std::mutex> lock(g_image_mutex);
                g_image_list = std::move(next);
            }
            g_images_fetched.store(true, std::memory_order_release);
            g_images_loading.store(false, std::memory_order_release);
        }
    }).detach();
}

static void run_dump(int image_idx, std::string filter) {
    bool expected = false;
    if (!g_dump_running.compare_exchange_strong(expected, true)) return;

    g_dump_progress.store(0.0f, std::memory_order_release);
    g_dump_found.store(0, std::memory_order_release);

    std::thread([image_idx, filter = std::move(filter)]() {
        @autoreleasepool {
            lt::il2cpp::Il2CppThreadScope thread_scope;
            const auto images = lt::il2cpp::all_images();
            if (image_idx < 0 || image_idx >= static_cast<int>(images.size())) {
                g_dump_running.store(false, std::memory_order_release);
                return;
            }

            const Il2CppImage* image = images[static_cast<size_t>(image_idx)].first;
            const std::string image_name = images[static_cast<size_t>(image_idx)].second;

            const char* home = std::getenv("HOME");
            const std::string path = home && *home
                ? std::string(home) + "/Documents/dump.cs"
                : "/tmp/dump.cs";
            FILE* file = std::fopen(path.c_str(), "w");
            if (!file) {
                lt::lua::console_append("[ERR] Dumper could not open output file.");
                g_dump_running.store(false, std::memory_order_release);
                return;
            }

            fprintf(file, "// SimpleXLibTool v%s — Dump\n// Image: %s\n\n",
                    LT_VERSION_STR, image_name.c_str());

            const size_t total = lt::il2cpp::api().image_get_class_count
                ? lt::il2cpp::api().image_get_class_count(image) : 0;

            for (size_t i = 0; i < total; ++i) {
                if (!lt::il2cpp::api().image_get_class) break;

                Il2CppClass* klass = lt::il2cpp::api().image_get_class(image, i);
                if (!klass) continue;

                lt::il2cpp::ClassHandle handle{ klass, lt::il2cpp::detected_version() };
                const std::string full_name = handle.full_name();
                if (!filter.empty() &&
                    full_name.find(filter) == std::string::npos) {
                    g_dump_progress.store(total ? static_cast<float>(i + 1) / total : 1.0f,
                                          std::memory_order_release);
                    continue;
                }

                fprintf(file, "// Class: %s (size 0x%X)\n",
                        full_name.c_str(), handle.instance_size());

                for (const auto& field : handle.fields()) {
                    fprintf(file, "    [%s 0x%zX] %s %s\n",
                            field.is_static ? "static" : "field",
                            field.offset, field.type_name.c_str(), field.name.c_str());
                }
                for (const auto& method : handle.methods()) {
                    const uintptr_t ptr = lt::il2cpp::method_ptr(method.info);
                    fprintf(file, "    // RVA: 0x%llX  %s\n",
                            static_cast<unsigned long long>(ptr), method.signature.c_str());
                }

                fprintf(file, "\n");
                g_dump_found.fetch_add(1, std::memory_order_relaxed);
                g_dump_progress.store(total ? static_cast<float>(i + 1) / total : 1.0f,
                                      std::memory_order_release);
            }

            std::fclose(file);
            g_dump_progress.store(1.0f, std::memory_order_release);
            g_dump_running.store(false, std::memory_order_release);
            lt::lua::console_append(
                "[Dumper] Wrote " +
                std::to_string(g_dump_found.load(std::memory_order_acquire)) +
                " classes to dump.cs");
        }
    }).detach();
}

void draw_tab_dumper() noexcept {
    if (!lt::il2cpp::api().resolved) {
        ImGui::TextDisabled("IL2CPP not resolved.");
        return;
    }

    const float aw = ImGui::GetContentRegionAvail().x;

    if (ImGui::Button("Refresh##dump", { 82, 24 })) {
        g_images_fetched.store(false, std::memory_order_release);
        refresh_images();
    }
    ImGui::SameLine(0, 8);
    ImGui::SetNextItemWidth(std::max(80.0f, aw - 92.0f));
    ImGui::InputText("Filter##dumpf", g_dump_filter, sizeof(g_dump_filter));

    if (!g_images_fetched.load(std::memory_order_acquire) &&
        !g_images_loading.load(std::memory_order_acquire)) {
        refresh_images();
    }
    if (g_images_loading.load(std::memory_order_acquire)) {
        ImGui::TextDisabled("Loading assemblies on worker thread...");
    }
    ImGui::Separator();

    std::vector<DumpImage> visible_images;
    {
        std::lock_guard<std::mutex> lock(g_image_mutex);
        visible_images = g_image_list;
    }

    ImGui::BeginChild("##img_list",
                      { 0, ImGui::GetContentRegionAvail().y * 0.55f },
                      true);
    for (int i = 0; i < static_cast<int>(visible_images.size()); ++i) {
        const auto& item = visible_images[static_cast<size_t>(i)];
        char label[256];
        std::snprintf(label, sizeof(label), "%s  ·  %zu classes",
                      item.name.c_str(), item.class_count);
        const bool selected = (g_sel_image == i);
        if (ImGui::Selectable(label, selected)) g_sel_image = i;
    }
    ImGui::EndChild();

    if (g_sel_image >= static_cast<int>(visible_images.size()))
        g_sel_image = visible_images.empty() ? 0 : static_cast<int>(visible_images.size() - 1);

    ImGui::Separator();
    ScanProgress(g_dump_progress.load(std::memory_order_acquire),
                 g_dump_found.load(std::memory_order_acquire),
                 g_dump_running.load(std::memory_order_acquire));

    if (!g_dump_running.load(std::memory_order_acquire)) {
        const bool can_export = g_images_fetched.load(std::memory_order_acquire) &&
                                !visible_images.empty();
        ImGui::BeginDisabled(!can_export);
        if (ImGui::Button("Export dump.cs", { aw * 0.60f, 30 })) {
            run_dump(g_sel_image, std::string(g_dump_filter));
        }
        ImGui::EndDisabled();
        ImGui::SameLine(0, 8);
        if (ImGui::Button("Copy path", { aw * 0.35f, 30 })) {
            const char* home = std::getenv("HOME");
            const std::string path = home && *home
                ? std::string(home) + "/Documents/dump.cs"
                : "/tmp/dump.cs";
            ImGui::SetClipboardText(path.c_str());
        }
    } else {
        ImGui::TextDisabled("Exporting metadata in background...");
    }

    ImGui::TextDisabled("Output: Documents/dump.cs");
}

} // namespace lt::ui
