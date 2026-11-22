// language: Objective-C++, file: src/UI/Tab_LibTool.mm, target: iOS arm64/arm64e
// LibTool tab — Hex Editor, Hook Manager, Scanner (AOB + pointer chain + diff).

#include "LibTool/Overlay.hpp"
#include "LibTool/Hook.hpp"
#include "LibTool/Scanner.hpp"
#include "LibTool/Memory.hpp"
#include "LibTool/LuaRuntime.hpp"
#include "imgui.h"
#include <cstdio>
#include <cstring>
#include <vector>
#include <string>

namespace lt::ui {

static int g_lbt_tab = 0;  // 0=Hex 1=Hooks 2=Scanner 3=AOB 4=Diff

// ------ Hex Editor state -----------------------------------------------------
static uintptr_t g_hex_addr{ 0 };
static char      g_hex_addr_buf[20]{ "0x0000000000000000" };
static int       g_hex_sel_byte{ -1 };
static bool      g_hex_modified[256]{};

// ------ AOB Scanner state ----------------------------------------------------
static char   g_aob_pattern[128]{ "?? 48 8B ?? 00" };
static uintptr_t g_aob_start{ 0 }, g_aob_end{ 0 };
static std::vector<uintptr_t> g_aob_results;
static lt::scanner::AsyncScanState g_aob_state;
static scanner::CancelFn g_aob_cancel;

// ------ Pointer chain state --------------------------------------------------
static char  g_chain_base_buf[20]{ "0x0" };
static uintptr_t g_chain_base{ 0 };
static char  g_chain_offsets_buf[256]{ "0x10, 0x28, 0x00" };
static uintptr_t g_chain_result{ 0 };
static bool  g_chain_resolved{ false };

// ------ Diff scanner state ---------------------------------------------------
static lt::scanner::ScanSession g_diff_session;
static char g_diff_target_buf[32]{ "0" };
static int  g_diff_cond{ 0 };  // index into condition names
static int  g_diff_type{ 2 };  // Int32

static const char* cond_names[] = {
    "Exact Value", "Decreased", "Increased", "Changed",
    "Unchanged", "Less Than", "Greater Than", "Between"
};
static const char* type_names[] = {
    "Int8", "Int16", "Int32", "Int64",
    "UInt8", "UInt16", "UInt32", "UInt64", "Float", "Double"
};

// ------ Hex Editor -----------------------------------------------------------
static void draw_hex_editor(float aw) {
    // Address input
    if (ImGui::InputText("Address##hexaddr", g_hex_addr_buf, sizeof(g_hex_addr_buf))) {
        unsigned long long v = 0;
        sscanf(g_hex_addr_buf, "0x%llX", &v);
        g_hex_addr = static_cast<uintptr_t>(v);
    }
    ImGui::SameLine(0, 6);
    if (ImGui::Button("Go##hex", { 36, 22 })) {
        snprintf(g_hex_addr_buf, sizeof(g_hex_addr_buf), "0x%016llX",
                 (unsigned long long)g_hex_addr);
    }

    if (!g_hex_addr || !lt::mem::is_readable(g_hex_addr, 256)) {
        ImGui::TextColored({ 0.9f, 0.3f, 0.3f, 1.0f }, "Invalid or unmapped address.");
        return;
    }

    uint8_t buf[256]{};
    if (lt::mem::read_bytes(g_hex_addr, buf, sizeof(buf)) != lt::mem::MemStatus::Ok) {
        ImGui::TextColored({ 0.9f, 0.3f, 0.3f, 1.0f }, "Memory read failed.");
        return;
    }

    ImGui::Separator();

    // Protection flags
    char prot_str[32] = "?";
    {
        vm_address_t ra = g_hex_addr & ~(vm_page_size - 1);
        vm_size_t rs = 0;
        vm_region_basic_info_data_64_t ri{};
        mach_msg_type_number_t rc = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t ro = MACH_PORT_NULL;
        if (vm_region_64(mach_task_self(), &ra, &rs, VM_REGION_BASIC_INFO_64,
                         (vm_region_info_t)&ri, &rc, &ro) == KERN_SUCCESS) {
            snprintf(prot_str, sizeof(prot_str), "%s%s%s",
                     ri.protection & VM_PROT_READ    ? "R" : "-",
                     ri.protection & VM_PROT_WRITE   ? "W" : "-",
                     ri.protection & VM_PROT_EXECUTE ? "X" : "-");
        }
    }
    ImGui::TextDisabled("Prot: %s", prot_str);

    // 16-column hex grid
    ImGui::BeginChild("##hex_grid", { 0, 0 }, false,
                      ImGuiWindowFlags_HorizontalScrollbar);

    for (int row = 0; row < 16; ++row) {
        // Address column
        ImGui::TextDisabled("%08llX  ", (unsigned long long)(g_hex_addr + row * 16));
        ImGui::SameLine(0, 0);

        // Hex bytes
        for (int col = 0; col < 16; ++col) {
            int idx = row * 16 + col;
            ImGui::PushID(idx);

            bool selected = (g_hex_sel_byte == idx);
            HexByte(buf[idx], g_hex_modified[idx], selected);
            if (ImGui::IsItemClicked()) g_hex_sel_byte = idx;
            if (ImGui::IsItemHovered()) {
                ImGui::SetTooltip("0x%02X = %d (dec)  addr: 0x%llX",
                    buf[idx], buf[idx], (unsigned long long)(g_hex_addr + idx));
            }
            ImGui::SameLine(0, col == 7 ? 8.0f : 2.0f);
            ImGui::PopID();
        }

        // ASCII sidebar
        ImGui::SameLine(0, 8);
        for (int col = 0; col < 16; ++col) {
            uint8_t b = buf[row * 16 + col];
            char ch = (b >= 0x20 && b < 0x7F) ? (char)b : '.';
            ImGui::PushStyleColor(ImGuiCol_Text,
                b == 0 ? IM_COL32(50,60,80,180) :
                (b >= 0x20 && b < 0x7F) ? IM_COL32(140,210,140,255) :
                IM_COL32(90,110,140,200));
            char s[2] = { ch, 0 };
            ImGui::TextUnformatted(s);
            ImGui::PopStyleColor();
            ImGui::SameLine(0, 0);
        }
        ImGui::NewLine();
    }

    // Write panel for selected byte
    if (g_hex_sel_byte >= 0) {
        ImGui::Separator();
        ImGui::Text("Selected: 0x%llX = 0x%02X (%d)",
            (unsigned long long)(g_hex_addr + g_hex_sel_byte),
            buf[g_hex_sel_byte], buf[g_hex_sel_byte]);

        static int edit_val = 0;
        ImGui::PushItemWidth(100);
        ImGui::InputInt("New value##hexwrite", &edit_val);
        ImGui::PopItemWidth();
        ImGui::SameLine(0, 6);
        ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(160, 80, 10, 220));
        if (ImGui::Button("Write byte", { 90, 22 })) {
            uint8_t v = static_cast<uint8_t>(edit_val);
            const auto result = lt::mem::write<uint8_t>(g_hex_addr + g_hex_sel_byte, v);
            if (result.ok()) {
                g_hex_modified[g_hex_sel_byte] = true;
                char message[128]{};
                std::snprintf(message, sizeof(message), "[HexEd] Write 0x%02X -> 0x%llX",
                    v, (unsigned long long)(g_hex_addr + g_hex_sel_byte));
                lt::lua::console_append(message);
            } else {
                lt::lua::console_append("[HexEd] Memory write failed");
            }
        }
        ImGui::PopStyleColor();
    }

    ImGui::EndChild();
}

// ------ Hook Manager ---------------------------------------------------------
static void draw_hook_manager(float aw) {
    ImGui::Text("Active hooks: %u / %d", lt::hook::count(), LT_MAX_HOOKS);
    ImGui::Separator();

    if (ImGui::BeginTable("##hooks_tbl", 5,
        ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg | ImGuiTableFlags_ScrollY |
        ImGuiTableFlags_Resizable, { 0, 220 })) {

        ImGui::TableSetupColumn("Address",   ImGuiTableColumnFlags_WidthFixed, 110);
        ImGui::TableSetupColumn("Label",     ImGuiTableColumnFlags_WidthStretch);
        ImGui::TableSetupColumn("Kind",      ImGuiTableColumnFlags_WidthFixed, 60);
        ImGui::TableSetupColumn("Status",    ImGuiTableColumnFlags_WidthFixed, 60);
        ImGui::TableSetupColumn("Action",    ImGuiTableColumnFlags_WidthFixed, 80);
        ImGui::TableHeadersRow();

        lt::hook::enumerate([](const lt::hook::HookRecord& rec) -> bool {
            ImGui::TableNextRow();
            ImGui::TableNextColumn();
            char addr_buf[20];
            snprintf(addr_buf, sizeof(addr_buf), "0x%llX", (unsigned long long)rec.target);
            CopyableText(addr_buf, true);
            ImGui::TableNextColumn();
            ImGui::TextUnformatted(rec.label);
            ImGui::TableNextColumn();
            ImGui::TextDisabled(rec.kind == lt::hook::HookKind::Trampoline ? "Tramp" :
                                rec.kind == lt::hook::HookKind::GOT ? "GOT" : "VTbl");
            ImGui::TableNextColumn();
            StatusLED(rec.status == lt::hook::HookStatus::Active, 4.0f);
            ImGui::TableNextColumn();
            ImGui::PushID((int)rec.id);
            if (rec.status == lt::hook::HookStatus::Active) {
                if (ImGui::SmallButton("Disable")) lt::hook::disable(rec.id);
            } else {
                ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(10,120,50,200));
                if (ImGui::SmallButton("Enable")) lt::hook::enable(rec.id);
                ImGui::PopStyleColor();
            }
            ImGui::SameLine(0, 4);
            ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(140, 20, 20, 200));
            if (ImGui::SmallButton("X")) lt::hook::remove(rec.id);
            ImGui::PopStyleColor();
            ImGui::PopID();
            return true;
        });
        ImGui::EndTable();
    }

    // Quick install panel
    ImGui::Separator();
    ImGui::TextDisabled("Quick Patch:");
    static char qp_addr[20]{ "0x0" };
    static int  qp_kind{ 0 };
    ImGui::PushItemWidth(160);
    ImGui::InputText("##qp_addr", qp_addr, sizeof(qp_addr));
    ImGui::PopItemWidth();
    ImGui::SameLine(0, 6);
    static const char* qp_kinds[] = { "RET", "NOP x1", "NOP x4" };
    ImGui::Combo("##qp_kind", &qp_kind, qp_kinds, 3);
    ImGui::SameLine(0, 6);
    if (ImGui::Button("Apply", { 50, 22 })) {
        unsigned long long va = 0;
        sscanf(qp_addr, "0x%llX", &va);
        uintptr_t addr = static_cast<uintptr_t>(va);
        if (addr) {
            uint32_t patch_id = 0;
            if (qp_kind == 0) patch_id = lt::hook::patch_ret(addr);
            else if (qp_kind == 1) patch_id = lt::hook::patch_nop(addr, 1);
            else patch_id = lt::hook::patch_nop(addr, 4);
            lt::lua::console_append(patch_id
                ? "[Quick Patch] applied (id " + std::to_string(patch_id) + ")"
                : "[Quick Patch] failed");
        }
    }
}

// ------ AOB Scanner ----------------------------------------------------------
static void draw_aob_scanner(float aw) {
    ImGui::PushItemWidth(aw - 10);
    ImGui::InputText("Pattern##aob", g_aob_pattern, sizeof(g_aob_pattern));
    ImGui::PopItemWidth();
    ImGui::TextDisabled("Use ?? for wildcards. Example: 48 8B ?? 00 ?? 48");

    ImGui::PushItemWidth((aw - 16) * 0.5f);
    AddressInput("Start##aob_s", &g_aob_start);
    ImGui::SameLine(0, 6);
    AddressInput("End##aob_e",   &g_aob_end);
    ImGui::PopItemWidth();

    bool running = g_aob_state.running.load();
    if (!running) {
        ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(10, 120, 60, 220));
        if (ImGui::Button("Start Scan", { aw * 0.6f, 28 })) {
            g_aob_results.clear();
            g_aob_state.running.store(true);
            g_aob_state.match_count.store(0);
            g_aob_cancel = lt::scanner::aob_scan_async(
                g_aob_pattern,
                [](uintptr_t addr) {
                    g_aob_results.push_back(addr);
                    g_aob_state.match_count.fetch_add(1);
                },
                [](size_t total) {
                    g_aob_state.running.store(false);
                    g_aob_state.total.store(total);
                },
                g_aob_start, g_aob_end);
        }
        ImGui::PopStyleColor();
    } else {
        ImGui::PushStyleColor(ImGuiCol_Button, IM_COL32(140, 20, 20, 220));
        if (ImGui::Button("Cancel Scan", { aw * 0.6f, 28 })) {
            if (g_aob_cancel) g_aob_cancel();
        }
        ImGui::PopStyleColor();
    }
    ImGui::SameLine(0, 6);
    if (ImGui::Button("Clear##aob", { aw * 0.35f, 28 })) g_aob_results.clear();

    ScanProgress(running ? 0.5f : (g_aob_results.empty() ? 0.0f : 1.0f),
                 g_aob_results.size(), running);

    if (!g_aob_results.empty()) {
        char hdr[64];
        snprintf(hdr, sizeof(hdr), "%zu matches [Copy all]", g_aob_results.size());
        if (ImGui::CollapsingHeader(hdr)) {
            ImGui::BeginChild("##aob_res", { 0, 180 }, true);
            for (auto addr : g_aob_results) {
                char s[20]; snprintf(s, sizeof(s), "0x%llX", (unsigned long long)addr);
                ImGui::PushStyleColor(ImGuiCol_Text, IM_COL32(140, 220, 140, 255));
                if (ImGui::Selectable(s)) {
                    // Navigate hex editor to this address
                    g_hex_addr = addr;
                    snprintf(g_hex_addr_buf, sizeof(g_hex_addr_buf), "0x%016llX",
                             (unsigned long long)addr);
                    g_lbt_tab = 0;
                }
                ImGui::PopStyleColor();
            }
            ImGui::EndChild();
        }
        if (ImGui::IsItemClicked(1)) {
            std::string all;
            for (auto addr : g_aob_results) {
                char s[22]; snprintf(s, sizeof(s), "0x%llX\n", (unsigned long long)addr);
                all += s;
            }
            ImGui::SetClipboardText(all.c_str());
        }
    }
}

// ------ Pointer Chain --------------------------------------------------------
static void draw_pointer_chain(float aw) {
    ImGui::Text("Base address:");
    ImGui::PushItemWidth(aw - 10);
    if (ImGui::InputText("##chain_base", g_chain_base_buf, sizeof(g_chain_base_buf))) {
        unsigned long long v = 0;
        sscanf(g_chain_base_buf, "0x%llX", &v);
        g_chain_base = static_cast<uintptr_t>(v);
    }
    ImGui::Text("Offsets (comma-separated hex):");
    ImGui::InputText("##chain_offs", g_chain_offsets_buf, sizeof(g_chain_offsets_buf));
    ImGui::PopItemWidth();

    if (ImGui::Button("Resolve", { aw - 10, 28 })) {
        // Parse offsets
        std::vector<ptrdiff_t> offsets;
        char* p = g_chain_offsets_buf;
        while (*p) {
            while (*p == ' ' || *p == ',') ++p;
            if (!*p) break;
            long long v = 0;
            if (*p == '0' && (*(p+1) == 'x' || *(p+1) == 'X')) {
                sscanf(p, "0x%llX", (unsigned long long*)&v);
            } else {
                v = strtoll(p, nullptr, 0);
            }
            offsets.push_back(static_cast<ptrdiff_t>(v));
            while (*p && *p != ',') ++p;
        }
        auto result = lt::scanner::resolve_chain(g_chain_base, offsets);
        g_chain_resolved = result.has_value();
        g_chain_result   = result.value_or(0);
    }

    if (g_chain_resolved) {
        ImGui::Separator();
        char res_buf[20];
        snprintf(res_buf, sizeof(res_buf), "0x%llX", (unsigned long long)g_chain_result);
        ImGui::PushStyleColor(ImGuiCol_Text, IM_COL32(80, 220, 120, 255));
        ImGui::Text("Result: %s", res_buf);
        ImGui::PopStyleColor();
        ImGui::SameLine(0, 6);
        if (ImGui::SmallButton("Copy##chain")) ImGui::SetClipboardText(res_buf);
        ImGui::SameLine(0, 6);
        if (ImGui::SmallButton("View in Hex##chain")) {
            g_hex_addr = g_chain_result;
            snprintf(g_hex_addr_buf, sizeof(g_hex_addr_buf), "0x%016llX",
                     (unsigned long long)g_chain_result);
            g_lbt_tab = 0;
        }
    } else if (g_chain_base) {
        ImGui::TextColored({ 0.9f, 0.3f, 0.3f, 1.0f }, "Resolution failed — invalid address in chain.");
    }
}

// ------ Diff Scanner ---------------------------------------------------------
static void draw_diff_scanner(float aw) {
    ImGui::Combo("Value type", &g_diff_type, type_names, 10);
    ImGui::Combo("Condition",  &g_diff_cond, cond_names, 8);

    if (g_diff_cond == 0 || g_diff_cond == 5 || g_diff_cond == 6) {
        ImGui::PushItemWidth(120);
        ImGui::InputText("Target##diff", g_diff_target_buf, sizeof(g_diff_target_buf));
        ImGui::PopItemWidth();
    }

    g_diff_session.value_type = static_cast<lt::scanner::ScanValueType>(g_diff_type);
    lt::scanner::ScanCondition cond = static_cast<lt::scanner::ScanCondition>(g_diff_cond);

    ImGui::Spacing();
    bool first = g_diff_session.first_scan;
    if (ImGui::Button(first ? "First Scan" : "Next Scan", { aw * 0.5f - 4, 28 })) {
        uint64_t target = 0;
        sscanf(g_diff_target_buf, "%llu", &target);
        if (first) lt::scanner::scan_first(g_diff_session, cond, target);
        else        lt::scanner::scan_next(g_diff_session, cond, target);
    }
    ImGui::SameLine(0, 6);
    if (ImGui::Button("Reset", { aw * 0.4f, 28 }))
        lt::scanner::scan_reset(g_diff_session);

    ImGui::Spacing();
    size_t count = g_diff_session.candidates.size();
    ImGui::Text("Candidates: %zu  |  Pass #%zu", count, g_diff_session.scan_pass_count);

    if (count > 0 && count <= 200) {
        ImGui::BeginChild("##diff_res", { 0, 220 }, true);
        for (auto& cand : g_diff_session.candidates) {
            char s[64];
            snprintf(s, sizeof(s), "0x%llX  curr=%llu  prev=%llu",
                     (unsigned long long)cand.addr,
                     (unsigned long long)cand.curr_value,
                     (unsigned long long)cand.prev_value);
            if (ImGui::Selectable(s)) {
                g_hex_addr = cand.addr;
                snprintf(g_hex_addr_buf, sizeof(g_hex_addr_buf), "0x%016llX",
                         (unsigned long long)cand.addr);
                g_lbt_tab = 0;
            }
        }
        ImGui::EndChild();
    } else if (count > 200) {
        ImGui::TextDisabled("Too many results (%zu) — refine with Next Scan.", count);
        ScanProgress(1.0f, count, false);
    }
}

// ------ Main draw ------------------------------------------------------------
void draw_tab_libtool() noexcept {
    float aw = ImGui::GetContentRegionAvail().x;

    // Sub-tab bar
    static const char* lbt_tabs[] = { "Hex Editor", "Hook Manager", "Scanner", "Ptr Chain", "Diff" };
    static const ImU32 lbt_cols[] = {
        IM_COL32(20, 90, 180, 220), IM_COL32(180, 60, 20, 220),
        IM_COL32(0, 150, 100, 220), IM_COL32(140, 100, 20, 220),
        IM_COL32(100, 20, 160, 220)
    };
    for (int i = 0; i < 5; ++i) {
        if (i > 0) ImGui::SameLine(0, 3);
        bool sel = (g_lbt_tab == i);
        ImGui::PushStyleColor(ImGuiCol_Button,
            sel ? lbt_cols[i] : IM_COL32(10, 15, 35, 200));
        if (ImGui::Button(lbt_tabs[i], { aw / 5.0f - 3, 22 })) g_lbt_tab = i;
        ImGui::PopStyleColor();
    }
    AnimSeparator("lbt_sep");

    ImGui::BeginChild("##lbt_content", { 0, 0 }, false);
    switch (g_lbt_tab) {
        case 0: draw_hex_editor(aw);     break;
        case 1: draw_hook_manager(aw);   break;
        case 2: draw_aob_scanner(aw);    break;
        case 3: draw_pointer_chain(aw);  break;
        case 4: draw_diff_scanner(aw);   break;
    }
    ImGui::EndChild();
}

} // namespace lt::ui
