// language: Objective-C++, file: src/UI/Tab_Tools.mm, target: iOS arm64/arm64e
// Tools tab — live class tree, object inspector, method invoker, Patcher, Hooker.

#include "LibTool/Overlay.hpp"
#include "LibTool/IL2CPP.hpp"
#include "LibTool/Hook.hpp"
#include "LibTool/Memory.hpp"
#include "LibTool/LuaRuntime.hpp"
#import <dispatch/dispatch.h>
#include "imgui.h"
#include <vector>
#include <string>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <atomic>
#include <mutex>
#include <thread>

namespace lt::ui {

// ------ State ----------------------------------------------------------------
static char  g_filter_buf[256]{};
static bool  g_fullscreen{ false };

struct PinnedClass { std::string name; lt::il2cpp::ClassHandle handle; };
static std::vector<PinnedClass> g_pinned;
static int   g_pinned_sel{ -1 };

struct BreadcrumbFrame {
    std::string label;       // display text for breadcrumb
    uintptr_t   obj_addr;
    lt::il2cpp::ClassHandle klass;
};
static std::vector<BreadcrumbFrame> g_breadcrumb;
static lt::il2cpp::ClassHandle g_active_class{};
static std::mutex g_objects_mutex;
static std::vector<uintptr_t> g_found_objects;
static std::atomic<bool> g_objects_fetched{false};
static std::atomic<bool> g_object_scan_running{false};
static int  g_sel_object{ 0 };
static bool g_show_methods{ false };
static char g_method_filter[128]{};

static std::string g_active_fullname;
static std::mutex g_class_cache_mutex;
static std::vector<lt::il2cpp::FieldDesc> g_cached_fields;
static std::vector<lt::il2cpp::MethodDesc> g_cached_methods;
static std::atomic<bool> g_metadata_loading{false};
static std::atomic<uint64_t> g_class_generation{0};

// ------ Helpers --------------------------------------------------------------
static void schedule_class_metadata(lt::il2cpp::ClassHandle klass, uint64_t generation) {
    g_metadata_loading.store(true, std::memory_order_release);
    std::thread([klass, generation] {
        @autoreleasepool {
            lt::il2cpp::Il2CppThreadScope thread_scope;
            auto fields = klass.fields();
            auto methods = klass.methods();
            if (generation == g_class_generation.load(std::memory_order_acquire)) {
                std::lock_guard<std::mutex> lock(g_class_cache_mutex);
                g_cached_fields = std::move(fields);
                g_cached_methods = std::move(methods);
                g_metadata_loading.store(false, std::memory_order_release);
            }
        }
    }).detach();
}

static void activate_class(lt::il2cpp::ClassHandle klass, const std::string& name) {
    g_active_class = klass;
    g_active_fullname = name;
    g_sel_object = 0;
    {
        std::lock_guard<std::mutex> lock(g_objects_mutex);
        g_found_objects.clear();
    }
    g_objects_fetched.store(false, std::memory_order_release);
    const uint64_t generation =
        g_class_generation.fetch_add(1, std::memory_order_acq_rel) + 1;
    {
        std::lock_guard<std::mutex> lock(g_class_cache_mutex);
        g_cached_fields.clear();
        g_cached_methods.clear();
    }
    schedule_class_metadata(klass, generation);
}

static void set_active_class(const std::string& name) {
    auto ch = lt::il2cpp::class_from_full_name(name, true);
    if (!ch) {
        lt::lua::console_append("[WARN] Class not found: " + name);
        return;
    }
    g_breadcrumb.clear();
    activate_class(*ch, name);
    g_breadcrumb.push_back({ name, 0, *ch });
}

static std::vector<lt::il2cpp::FieldDesc> cached_fields_snapshot() {
    std::lock_guard<std::mutex> lock(g_class_cache_mutex);
    return g_cached_fields;
}
static std::vector<lt::il2cpp::MethodDesc> cached_methods_snapshot() {
    std::lock_guard<std::mutex> lock(g_class_cache_mutex);
    return g_cached_methods;
}
static std::vector<uintptr_t> found_objects_snapshot() {
    std::lock_guard<std::mutex> lock(g_objects_mutex);
    return g_found_objects;
}

static void start_object_scan(lt::il2cpp::ClassHandle klass, uint64_t generation) {
    bool expected = false;
    if (!g_object_scan_running.compare_exchange_strong(expected, true)) return;
    g_objects_fetched.store(false, std::memory_order_release);
    std::thread([klass, generation] {
        @autoreleasepool {
            lt::il2cpp::Il2CppThreadScope thread_scope;
            auto objects = klass.find_objects(LT_FINDOBJ_MAX);
            if (generation == g_class_generation.load(std::memory_order_acquire)) {
                std::lock_guard<std::mutex> lock(g_objects_mutex);
                g_found_objects = std::move(objects);
                g_objects_fetched.store(true, std::memory_order_release);
            }
            g_object_scan_running.store(false, std::memory_order_release);
        }
    }).detach();
}

// ------ Render ---------------------------------------------------------------
void draw_tab_tools() noexcept {
    if (!lt::il2cpp::api().resolved) {
        ImGui::TextDisabled("IL2CPP API not resolved.");
        ImGui::TextDisabled("Check console — stripped binary may need extra time.");
        return;
    }

    float aw = ImGui::GetContentRegionAvail().x;

    // --- Fullscreen toggle
    if (ImGui::SmallButton(g_fullscreen ? "Exit Fullscreen" : "Fullscreen")) {
        g_fullscreen = !g_fullscreen;
        lt::ui::state().fullscreen = g_fullscreen;
    }
    ImGui::SameLine(0, 8);

    // --- Pinned class chips
    for (int i = 0; i < (int)g_pinned.size(); ++i) {
        ImGui::PushID(i);
        bool sel = (g_pinned_sel == i);
        if (sel) ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(0,100,200,220));
        if (ImGui::SmallButton(g_pinned[i].name.c_str())) {
            g_pinned_sel = i;
            g_breadcrumb.clear();
            activate_class(g_pinned[i].handle, g_pinned[i].name);
            g_breadcrumb.push_back({ g_pinned[i].name, 0, g_pinned[i].handle });
        }
        if (sel) ImGui::PopStyleColor();
        ImGui::PopID();
        ImGui::SameLine(0, 4);
    }
    ImGui::NewLine();

    // --- Image picker + filter
    ImGui::PushItemWidth(aw * 0.55f);
    ImGui::InputText("##filter", g_filter_buf, sizeof(g_filter_buf));
    ImGui::PopItemWidth();
    ImGui::SameLine(0, 6);
    if (ImGui::Button("Search", { 70, 0 }) && g_filter_buf[0]) {
        set_active_class(g_filter_buf);
    }
    ImGui::SameLine(0, 4);
    if (ImGui::Button("Pin", { 40, 0 }) && g_active_class.valid()) {
        g_pinned.push_back({ g_active_fullname, g_active_class });
        if (g_pinned.size() > 8) g_pinned.erase(g_pinned.begin());
    }

    AnimSeparator("tools_top");

    if (!g_active_class.valid()) {
        ImGui::Spacing();
        ImGui::TextDisabled("Type a class name and press Search.");
        ImGui::TextDisabled("Example: Managers.Hunters.HeroesProgressManager");
        return;
    }

    // --- Breadcrumb navigation
    for (size_t i = 0; i < g_breadcrumb.size(); ++i) {
        if (i > 0) { ImGui::SameLine(0,2); ImGui::TextDisabled(">"); ImGui::SameLine(0,2); }
        ImGui::PushID(static_cast<int>(i));
        if (ImGui::SmallButton(g_breadcrumb[i].label.c_str())) {
            // Navigate to this breadcrumb frame
            g_breadcrumb.resize(i + 1);
            activate_class(g_breadcrumb[i].klass, g_breadcrumb[i].label);
        }
        ImGui::PopID();
    }
    if (g_breadcrumb.size() > 1) {
        ImGui::SameLine(0, 6);
        if (ImGui::SmallButton("< Back")) {
            g_breadcrumb.pop_back();
            if (!g_breadcrumb.empty()) {
                activate_class(g_breadcrumb.back().klass, g_breadcrumb.back().label);
            }
        }
    }
    ImGui::Separator();

    // --- Class header
    const std::string fullname = g_active_fullname;
    GlowText(fullname, IM_COL32(140,200,255,255), IM_COL32(0,100,220,255), 2.5f);

    // --- Inspect Objects + Trace all
    if (ImGui::Button("Inspect Objects", { 130, 22 }) &&
        !g_object_scan_running.load(std::memory_order_acquire)) {
        start_object_scan(g_active_class, g_class_generation.load(std::memory_order_acquire));
    }
    ImGui::SameLine(0, 6);
    if (ImGui::Button("Trace all", { 80, 22 })) {
        const auto methods = cached_methods_snapshot();
        lt::lua::console_append("[Trace] " + std::to_string(methods.size()) +
                                " methods enumerated for " + fullname);
    }
    if (g_object_scan_running.load(std::memory_order_acquire)) {
        ImGui::SameLine(0, 8);
        ImGui::TextDisabled("Scanning objects in background...");
    }

    const auto found_objects = found_objects_snapshot();
    if (g_objects_fetched.load(std::memory_order_acquire)) {
        char obj_label[64];
        std::snprintf(obj_label, sizeof(obj_label), "%zu instances", found_objects.size());
        ImGui::TextDisabled("%s", obj_label);
        if (!found_objects.empty()) {
            if (g_sel_object < 0 || g_sel_object >= static_cast<int>(found_objects.size()))
                g_sel_object = 0;
            char combo_buf[64];
            std::snprintf(combo_buf, sizeof(combo_buf), "0x%llX (sel #%d)",
                          static_cast<unsigned long long>(found_objects[static_cast<size_t>(g_sel_object)]),
                          g_sel_object);
            if (ImGui::BeginCombo("##obj_sel", combo_buf)) {
                for (size_t i = 0; i < found_objects.size(); ++i) {
                    char lbl[48];
                    std::snprintf(lbl, sizeof(lbl), "#%zu 0x%llX", i,
                                  static_cast<unsigned long long>(found_objects[i]));
                    const bool sel = (g_sel_object == static_cast<int>(i));
                    if (ImGui::Selectable(lbl, sel)) g_sel_object = static_cast<int>(i);
                    if (sel) ImGui::SetItemDefaultFocus();
                }
                ImGui::EndCombo();
            }
        }
    }

    ImGui::Separator();

    // --- Field list
    float avail_h = ImGui::GetContentRegionAvail().y;
    bool show_methods = g_show_methods;
    float field_h = show_methods ? avail_h * 0.5f : avail_h - 50.0f;

    ImGui::BeginChild("##fields", { 0, field_h }, false,
                      ImGuiWindowFlags_HorizontalScrollbar);
    {
        const auto fields = cached_fields_snapshot();
        const uintptr_t obj_addr =
            (!found_objects.empty() && g_sel_object >= 0 &&
             g_sel_object < static_cast<int>(found_objects.size()))
            ? found_objects[static_cast<size_t>(g_sel_object)] : 0;
        if (g_metadata_loading.load(std::memory_order_acquire))
            ImGui::TextDisabled("Loading class metadata...");
        for (const auto& fd : fields) {
            ImGui::PushID(fd.name.c_str());

            // Type badge
            TypeBadge(fd.type_name.empty() ? "?" : fd.type_name);
            ImGui::SameLine(0, 4);

            // Static indicator
            if (fd.is_static) {
                ImGui::PushStyleColor(ImGuiCol_Text, IM_COL32(255, 180, 60, 255));
                ImGui::Text("*");
                ImGui::PopStyleColor();
                ImGui::SameLine(0, 2);
            }

            // Field name
            ImGui::TextUnformatted(fd.name.c_str());
            ImGui::SameLine(0, 6);

            // Live value read
            if (obj_addr && !fd.is_static) {
                using ::Il2CppTypeEnum;
                char val_buf[64] = "?";
                switch (fd.type_enum) {
                    case Il2CppTypeEnum::IL2CPP_TYPE_BOOLEAN: {
                        bool v = false;
                        if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 1) == lt::mem::MemStatus::Ok)
                            snprintf(val_buf, sizeof(val_buf), "%s", v ? "true" : "false");
                        break;
                    }
                    case Il2CppTypeEnum::IL2CPP_TYPE_I4:
                    case Il2CppTypeEnum::IL2CPP_TYPE_U4: {
                        int32_t v = 0;
                        if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 4) == lt::mem::MemStatus::Ok)
                            snprintf(val_buf, sizeof(val_buf), "%d", v);
                        break;
                    }
                    case Il2CppTypeEnum::IL2CPP_TYPE_R4: {
                        float v = 0;
                        if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 4) == lt::mem::MemStatus::Ok)
                            snprintf(val_buf, sizeof(val_buf), "%.4f", v);
                        break;
                    }
                    case Il2CppTypeEnum::IL2CPP_TYPE_I8:
                    case Il2CppTypeEnum::IL2CPP_TYPE_U8: {
                        int64_t v = 0;
                        if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 8) == lt::mem::MemStatus::Ok)
                            snprintf(val_buf, sizeof(val_buf), "%lld", (long long)v);
                        break;
                    }
                    case Il2CppTypeEnum::IL2CPP_TYPE_STRING: {
                        auto ptr = lt::mem::read_ptr(obj_addr + fd.offset);
                        if (ptr.ok() && ptr.value) {
                            auto s = lt::mem::read_il2cpp_string(ptr.value);
                            snprintf(val_buf, sizeof(val_buf), "\"%s\"",
                                     s ? s->c_str() : "null");
                        } else snprintf(val_buf, sizeof(val_buf), "null");
                        break;
                    }
                    default: {
                        auto ptr = lt::mem::read_ptr(obj_addr + fd.offset);
                        if (ptr.ok()) snprintf(val_buf, sizeof(val_buf), "0x%llX", (unsigned long long)ptr.value);
                        break;
                    }
                }
                ImGui::PushStyleColor(ImGuiCol_Text, IM_COL32(140, 200, 140, 255));
                ImGui::TextUnformatted(val_buf);
                ImGui::PopStyleColor();
            }

            ImGui::PopID();
        }
    }
    ImGui::EndChild();

    // --- Methods collapsing section
    if (ImGui::Button(g_show_methods ? "v Methods" : "> Methods", { aw * 0.55f, 22 }))
        g_show_methods = !g_show_methods;
    ImGui::SameLine(0, 6);
    if (ImGui::Button("Dump to file", { aw * 0.4f, 22 })) {
        const char* home = std::getenv("HOME");
        std::string path = home && *home
            ? std::string(home) + "/Documents/LibTool_dump.txt"
            : "/tmp/LibTool_dump.txt";
        const auto fields = cached_fields_snapshot();
        const auto methods = cached_methods_snapshot();
        std::ofstream out(path, std::ios::out | std::ios::trunc);
        if (out) {
            out << "// Dumped by SimpleXLibTool v" << LT_VERSION_STR
                << "\n// Class: " << g_active_fullname << "\n\n";
            for (const auto& fd : fields) {
                out << "  [" << (fd.is_static ? "static" : "field") << "] "
                    << fd.type_name << " " << fd.name << " (offset 0x"
                    << std::hex << std::uppercase << fd.offset << std::dec << ")\n";
            }
            for (const auto& md : methods)
                out << "  " << md.signature << "\n";
            out.close();
            lt::lua::console_append("[LibTool] Dumped to " + path);
        } else {
            lt::lua::console_append("[LibTool] Failed to write class dump: " + path);
        }
    }

    if (g_show_methods) {
        ImGui::PushItemWidth(aw - 10);
        ImGui::InputText("##mfilter", g_method_filter, sizeof(g_method_filter));
        ImGui::PopItemWidth();

        ImGui::BeginChild("##methods", { 0, 0 }, false);
        const uintptr_t obj_addr =
            (!found_objects.empty() && g_sel_object >= 0 &&
             g_sel_object < static_cast<int>(found_objects.size()))
            ? found_objects[static_cast<size_t>(g_sel_object)] : 0;
        const auto methods = cached_methods_snapshot();
        if (g_metadata_loading.load(std::memory_order_acquire))
            ImGui::TextDisabled("Loading methods...");
        for (const auto& md : methods) {
            if (g_method_filter[0] &&
                md.name.find(g_method_filter) == std::string::npos) continue;

            ImGui::PushID(md.info);

            // Method signature with coloring
            char sig_disp[256];
            snprintf(sig_disp, sizeof(sig_disp), "%s", md.signature.c_str());
            if (ImGui::TreeNode(sig_disp)) {
                // Action buttons
                ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(30, 90, 170, 220));
                if (ImGui::Button("Caller", { 60, 20 }) && obj_addr) {
                    if (lt::il2cpp::api().runtime_invoke && md.info) {
                        lt::il2cpp::Il2CppThreadScope scope;
                        Il2CppException* exc = nullptr;
                        lt::il2cpp::api().runtime_invoke(
                            md.info, reinterpret_cast<void*>(obj_addr), nullptr, &exc);
                        lt::lua::console_append("[Call] " + md.name + " → invoked");
                    }
                }
                ImGui::PopStyleColor();
                ImGui::SameLine(0, 4);

                ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(140, 80, 20, 220));
                if (ImGui::Button("Patcher", { 65, 20 })) {
                    uintptr_t mptr = lt::il2cpp::method_ptr(md.info);
                    if (mptr) {
                        const uint32_t hook_id = lt::hook::patch_ret(mptr, md.name.c_str());
                        lt::lua::console_append(hook_id ? "[Patch] " + md.name + " → RET patched" : "[Patch] " + md.name + " → patch failed");
                    }
                }
                ImGui::PopStyleColor();
                ImGui::SameLine(0, 4);

                ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(140, 20, 20, 220));
                if (ImGui::Button("Hooker", { 60, 20 })) {
                    uintptr_t mptr = lt::il2cpp::method_ptr(md.info);
                    if (mptr) {
                        // Log-only hook for demonstration
                        char address[32]{};
                        std::snprintf(address, sizeof(address), " at 0x%llX", (unsigned long long)mptr);
                        lt::lua::console_append("[Hook] " + md.name + address);
                    }
                }
                ImGui::PopStyleColor();
                ImGui::SameLine(0, 8);

                // Call / Call MainThread
                if (ImGui::Button("▶ Call", { 55, 20 }) && obj_addr) {
                    if (lt::il2cpp::api().runtime_invoke) {
                        lt::il2cpp::Il2CppThreadScope scope;
                        Il2CppException* exc = nullptr;
                        lt::il2cpp::api().runtime_invoke(
                            md.info, reinterpret_cast<void*>(obj_addr), nullptr, &exc);
                    }
                }
                ImGui::SameLine(0, 4);
                if (ImGui::Button("⚡ Call MainThread", { 140, 20 }) && obj_addr) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (lt::il2cpp::api().runtime_invoke) {
                            lt::il2cpp::Il2CppThreadScope scope;
                            Il2CppException* exc = nullptr;
                            lt::il2cpp::api().runtime_invoke(
                                md.info, reinterpret_cast<void*>(obj_addr), nullptr, &exc);
                        }
                    });
                }

                // Param info
                ImGui::TextDisabled("Params: %d  |  Ptr: 0x%llX",
                    md.param_count, (unsigned long long)lt::il2cpp::method_ptr(md.info));
                ImGui::TreePop();
            }
            ImGui::PopID();
        }
        ImGui::EndChild();
    }
}

} // namespace lt::ui
