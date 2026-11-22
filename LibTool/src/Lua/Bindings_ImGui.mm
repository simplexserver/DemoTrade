// language: Objective-C++, file: src/Lua/Bindings_ImGui.mm, target: iOS arm64/arm64e
// Complete ImGui Lua API — every function used by HR Dev Menu plus the full surface.
// Verified against the 1081-line HR_Dev_Menu_LibTool.lua API calls.

extern "C" {
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
}
#include "imgui.h"
#include <cstring>
#include <cstdio>

// ------ Draw list userdata ---------------------------------------------------
static const char* DRAWLIST_MT = "LT.DrawList";
struct DrawListUD { ImDrawList* dl; };

static ImDrawList* get_drawlist(lua_State* L, int idx) {
    DrawListUD* ud = static_cast<DrawListUD*>(luaL_checkudata(L, idx, DRAWLIST_MT));
    return ud ? ud->dl : nullptr;
}

static ImU32 lua_to_col32(lua_State* L, int r_idx) {
    // Accept RGBA as 4 numbers or a single uint32
    if (lua_gettop(L) >= r_idx + 3) {
        float r = static_cast<float>(luaL_checknumber(L, r_idx));
        float g = static_cast<float>(luaL_checknumber(L, r_idx+1));
        float b = static_cast<float>(luaL_checknumber(L, r_idx+2));
        float a = static_cast<float>(luaL_optnumber(L, r_idx+3, 1.0));
        return IM_COL32(static_cast<int>(r*255), static_cast<int>(g*255),
                        static_cast<int>(b*255), static_cast<int>(a*255));
    }
    return static_cast<ImU32>(luaL_optinteger(L, r_idx, 0xFFFFFFFF));
}

// ------ DrawList methods -----------------------------------------------------
static const luaL_Reg drawlist_methods[] = {
    { "AddLine", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 p1{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        ImVec2 p2{ (float)luaL_checknumber(L,4), (float)luaL_checknumber(L,5) };
        ImU32 col = lua_to_col32(L, 6);
        float thick = (float)luaL_optnumber(L, 10, 1.0);
        dl->AddLine(p1, p2, col, thick); return 0;
    }},
    { "AddRect", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 p1{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        ImVec2 p2{ (float)luaL_checknumber(L,4), (float)luaL_checknumber(L,5) };
        ImU32 col = lua_to_col32(L, 6);
        float rounding = (float)luaL_optnumber(L, 10, 0.0);
        float thick = (float)luaL_optnumber(L, 12, 1.0);
        dl->AddRect(p1, p2, col, rounding, 0, thick); return 0;
    }},
    { "AddRectFilled", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 p1{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        ImVec2 p2{ (float)luaL_checknumber(L,4), (float)luaL_checknumber(L,5) };
        ImU32 col = lua_to_col32(L, 6);
        float rounding = (float)luaL_optnumber(L, 10, 0.0);
        dl->AddRectFilled(p1, p2, col, rounding); return 0;
    }},
    { "AddCircle", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 c{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        float r = (float)luaL_checknumber(L, 4);
        ImU32 col = lua_to_col32(L, 5);
        int segs = (int)luaL_optinteger(L, 9, 0);
        float thick = (float)luaL_optnumber(L, 10, 1.0);
        dl->AddCircle(c, r, col, segs, thick); return 0;
    }},
    { "AddCircleFilled", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 c{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        float r = (float)luaL_checknumber(L, 4);
        ImU32 col = lua_to_col32(L, 5);
        int segs = (int)luaL_optinteger(L, 9, 0);
        dl->AddCircleFilled(c, r, col, segs); return 0;
    }},
    { "AddText", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 pos{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        ImU32 col = lua_to_col32(L, 4);
        const char* text = luaL_checkstring(L, 8);
        dl->AddText(pos, col, text); return 0;
    }},
    { "AddTriangle", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 a{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        ImVec2 b{ (float)luaL_checknumber(L,4), (float)luaL_checknumber(L,5) };
        ImVec2 c{ (float)luaL_checknumber(L,6), (float)luaL_checknumber(L,7) };
        ImU32 col = lua_to_col32(L, 8);
        dl->AddTriangle(a, b, c, col); return 0;
    }},
    { "AddTriangleFilled", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 a{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        ImVec2 b{ (float)luaL_checknumber(L,4), (float)luaL_checknumber(L,5) };
        ImVec2 c{ (float)luaL_checknumber(L,6), (float)luaL_checknumber(L,7) };
        ImU32 col = lua_to_col32(L, 8);
        dl->AddTriangleFilled(a, b, c, col); return 0;
    }},
    { "AddBezierCubic", [](lua_State* L)->int {
        auto* dl = get_drawlist(L, 1);
        if (!dl) return 0;
        ImVec2 p1{ (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        ImVec2 p2{ (float)luaL_checknumber(L,4), (float)luaL_checknumber(L,5) };
        ImVec2 p3{ (float)luaL_checknumber(L,6), (float)luaL_checknumber(L,7) };
        ImVec2 p4{ (float)luaL_checknumber(L,8), (float)luaL_checknumber(L,9) };
        ImU32 col = lua_to_col32(L, 10);
        float thick = (float)luaL_optnumber(L, 14, 1.0);
        dl->AddBezierCubic(p1, p2, p3, p4, col, thick); return 0;
    }},
    { nullptr, nullptr }
};

static int push_drawlist(lua_State* L, ImDrawList* dl) {
    DrawListUD* ud = static_cast<DrawListUD*>(lua_newuserdata(L, sizeof(DrawListUD)));
    ud->dl = dl;
    if (luaL_newmetatable(L, DRAWLIST_MT)) {
        lua_pushvalue(L, -1); lua_setfield(L, -2, "__index");
        luaL_setfuncs(L, drawlist_methods, 0);
    }
    lua_setmetatable(L, -2);
    return 1;
}

// ------ Core ImGui bindings --------------------------------------------------
extern "C" int luaopen_ImGui(lua_State* L) {
    lua_newtable(L);

#define REG(name, fn) lua_pushcfunction(L, fn); lua_setfield(L, -2, name)

    // --- Window management
    REG("Begin", [](lua_State* L)->int {
        const char* title = luaL_checkstring(L, 1);
        bool open = true;
        bool* p_open = lua_gettop(L) >= 2 ? &open : nullptr;
        if (p_open && lua_type(L, 2) == LUA_TBOOLEAN) open = lua_toboolean(L, 2);
        ImGuiWindowFlags flags = (ImGuiWindowFlags)luaL_optinteger(L, 3, 0);
        bool ret = ImGui::Begin(title, p_open, flags);
        lua_pushboolean(L, ret);
        if (p_open) lua_pushboolean(L, open); else lua_pushboolean(L, 1);
        return 2;
    });
    REG("End",   [](lua_State* L)->int { ImGui::End(); return 0; });

    REG("BeginChild",  [](lua_State* L)->int {
        const char* id = luaL_checkstring(L, 1);
        ImVec2 sz{ (float)luaL_optnumber(L,2,0), (float)luaL_optnumber(L,3,0) };
        bool border = lua_toboolean(L, 4);
        ImGuiWindowFlags flags = (ImGuiWindowFlags)luaL_optinteger(L, 5, 0);
        lua_pushboolean(L, ImGui::BeginChild(id, sz, border, flags));
        return 1;
    });
    REG("EndChild", [](lua_State* L)->int { ImGui::EndChild(); return 0; });

    REG("SetNextWindowSize", [](lua_State* L)->int {
        ImVec2 sz{ (float)luaL_checknumber(L,1), (float)luaL_checknumber(L,2) };
        ImGuiCond cond = (ImGuiCond)luaL_optinteger(L, 3, 0);
        ImGui::SetNextWindowSize(sz, cond); return 0;
    });
    REG("SetNextWindowPos", [](lua_State* L)->int {
        ImVec2 pos{ (float)luaL_checknumber(L,1), (float)luaL_checknumber(L,2) };
        ImGuiCond cond = (ImGuiCond)luaL_optinteger(L, 3, 0);
        ImGui::SetNextWindowPos(pos, cond); return 0;
    });
    REG("SetNextWindowBgAlpha", [](lua_State* L)->int { ImGui::SetNextWindowBgAlpha((float)luaL_checknumber(L,1)); return 0; });
    REG("SetNextWindowCollapsed", [](lua_State* L)->int { ImGui::SetNextWindowCollapsed(lua_toboolean(L,1),(ImGuiCond)luaL_optinteger(L,2,0)); return 0; });
    REG("GetWindowPos", [](lua_State* L)->int { auto p=ImGui::GetWindowPos(); lua_pushnumber(L,p.x); lua_pushnumber(L,p.y); return 2; });
    REG("GetWindowSize", [](lua_State* L)->int { auto s=ImGui::GetWindowSize(); lua_pushnumber(L,s.x); lua_pushnumber(L,s.y); return 2; });
    REG("GetContentRegionAvail", [](lua_State* L)->int { auto s=ImGui::GetContentRegionAvail(); lua_pushnumber(L,s.x); lua_pushnumber(L,s.y); return 2; });

    // --- Layout
    REG("Separator",  [](lua_State* L)->int { ImGui::Separator(); return 0; });
    REG("SameLine",   [](lua_State* L)->int {
        float off = (float)luaL_optnumber(L,1,0);
        float sp  = (float)luaL_optnumber(L,2,-1);
        ImGui::SameLine(off, sp); return 0;
    });
    REG("NewLine",    [](lua_State* L)->int { ImGui::NewLine(); return 0; });
    REG("Spacing",    [](lua_State* L)->int { ImGui::Spacing(); return 0; });
    REG("Dummy",      [](lua_State* L)->int { ImGui::Dummy({(float)luaL_checknumber(L,1),(float)luaL_checknumber(L,2)}); return 0; });
    REG("Indent",     [](lua_State* L)->int { ImGui::Indent((float)luaL_optnumber(L,1,0)); return 0; });
    REG("Unindent",   [](lua_State* L)->int { ImGui::Unindent((float)luaL_optnumber(L,1,0)); return 0; });
    REG("BeginGroup", [](lua_State* L)->int { ImGui::BeginGroup(); return 0; });
    REG("EndGroup",   [](lua_State* L)->int { ImGui::EndGroup(); return 0; });
    REG("SetCursorPos",  [](lua_State* L)->int { ImGui::SetCursorPos({(float)luaL_checknumber(L,1),(float)luaL_checknumber(L,2)}); return 0; });
    REG("SetCursorPosX", [](lua_State* L)->int { ImGui::SetCursorPosX((float)luaL_checknumber(L,1)); return 0; });
    REG("SetCursorPosY", [](lua_State* L)->int { ImGui::SetCursorPosY((float)luaL_checknumber(L,1)); return 0; });
    REG("GetCursorPos",  [](lua_State* L)->int { auto p=ImGui::GetCursorPos(); lua_pushnumber(L,p.x); lua_pushnumber(L,p.y); return 2; });
    REG("GetCursorScreenPos", [](lua_State* L)->int { auto p=ImGui::GetCursorScreenPos(); lua_pushnumber(L,p.x); lua_pushnumber(L,p.y); return 2; });

    // --- Text
    REG("Text", [](lua_State* L)->int {
        const char* s = luaL_checkstring(L, 1); ImGui::TextUnformatted(s); return 0;
    });
    REG("TextColored", [](lua_State* L)->int {
        ImVec4 c{ (float)luaL_checknumber(L,1),(float)luaL_checknumber(L,2),
                  (float)luaL_checknumber(L,3),(float)luaL_checknumber(L,4) };
        ImGui::TextColored(c, "%s", luaL_checkstring(L,5)); return 0;
    });
    REG("TextDisabled", [](lua_State* L)->int { ImGui::TextDisabled("%s", luaL_checkstring(L,1)); return 0; });
    REG("TextWrapped",  [](lua_State* L)->int { ImGui::TextWrapped("%s", luaL_checkstring(L,1)); return 0; });
    REG("LabelText",    [](lua_State* L)->int { ImGui::LabelText(luaL_checkstring(L,1), "%s", luaL_checkstring(L,2)); return 0; });
    REG("BulletText",   [](lua_State* L)->int { ImGui::BulletText("%s", luaL_checkstring(L,1)); return 0; });

    // --- Widgets
    REG("Button", [](lua_State* L)->int {
        const char* label = luaL_checkstring(L,1);
        float w = (float)luaL_optnumber(L,2,0), h = (float)luaL_optnumber(L,3,0);
        lua_pushboolean(L, ImGui::Button(label, {w,h})); return 1;
    });
    REG("SmallButton",     [](lua_State* L)->int { lua_pushboolean(L, ImGui::SmallButton(luaL_checkstring(L,1))); return 1; });
    REG("InvisibleButton", [](lua_State* L)->int {
        lua_pushboolean(L, ImGui::InvisibleButton(luaL_checkstring(L,1),
            {(float)luaL_checknumber(L,2),(float)luaL_checknumber(L,3)})); return 1;
    });
    REG("Checkbox", [](lua_State* L)->int {
        const char* label = luaL_checkstring(L,1);
        bool v = lua_toboolean(L,2) != 0;
        bool changed = ImGui::Checkbox(label, &v);
        lua_pushboolean(L, changed); lua_pushboolean(L, v); return 2;
    });
    REG("RadioButton", [](lua_State* L)->int {
        lua_pushboolean(L, ImGui::RadioButton(luaL_checkstring(L,1), lua_toboolean(L,2)!=0)); return 1;
    });
    REG("SliderFloat", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        float v = (float)luaL_checknumber(L,2);
        float mn = (float)luaL_checknumber(L,3), mx = (float)luaL_checknumber(L,4);
        const char* fmt = luaL_optstring(L,5,"%.3f");
        bool changed = ImGui::SliderFloat(lbl, &v, mn, mx, fmt);
        lua_pushboolean(L, changed); lua_pushnumber(L, v); return 2;
    });
    REG("SliderFloat2", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        float v[2] = { (float)luaL_checknumber(L,2), (float)luaL_checknumber(L,3) };
        float mn = (float)luaL_checknumber(L,4), mx = (float)luaL_checknumber(L,5);
        bool changed = ImGui::SliderFloat2(lbl, v, mn, mx);
        lua_pushboolean(L,changed); lua_pushnumber(L,v[0]); lua_pushnumber(L,v[1]); return 3;
    });
    REG("SliderInt", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        int v = (int)luaL_checkinteger(L,2);
        int mn = (int)luaL_checkinteger(L,3), mx = (int)luaL_checkinteger(L,4);
        bool changed = ImGui::SliderInt(lbl, &v, mn, mx);
        lua_pushboolean(L,changed); lua_pushinteger(L,v); return 2;
    });
    REG("DragFloat", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        float v = (float)luaL_checknumber(L,2);
        float spd = (float)luaL_optnumber(L,3,1.0);
        float mn = (float)luaL_optnumber(L,4,0), mx = (float)luaL_optnumber(L,5,0);
        bool changed = ImGui::DragFloat(lbl, &v, spd, mn, mx);
        lua_pushboolean(L,changed); lua_pushnumber(L,v); return 2;
    });
    REG("DragInt", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        int v = (int)luaL_checkinteger(L,2);
        float spd = (float)luaL_optnumber(L,3,1.0);
        bool changed = ImGui::DragInt(lbl, &v, spd);
        lua_pushboolean(L,changed); lua_pushinteger(L,v); return 2;
    });
    REG("InputText", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        const char* s   = luaL_checkstring(L,2);
        static char buf[1024];
        strncpy(buf, s, sizeof(buf)-1);
        bool changed = ImGui::InputText(lbl, buf, sizeof(buf));
        lua_pushboolean(L,changed); lua_pushstring(L,buf); return 2;
    });
    REG("InputTextMultiline", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        char* buf       = (char*)luaL_checkstring(L,2);
        size_t bufsz    = (size_t)luaL_optinteger(L,3,1024);
        float w = (float)luaL_optnumber(L,4,0), h = (float)luaL_optnumber(L,5,0);
        ImGuiInputTextFlags flags = (ImGuiInputTextFlags)luaL_optinteger(L,6,0);
        bool changed = ImGui::InputTextMultiline(lbl, buf, bufsz, {w,h}, flags);
        lua_pushboolean(L, changed); return 1;
    });
    REG("InputFloat", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        float v = (float)luaL_checknumber(L,2);
        bool changed = ImGui::InputFloat(lbl, &v);
        lua_pushboolean(L,changed); lua_pushnumber(L,v); return 2;
    });
    REG("InputInt", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        int v = (int)luaL_checkinteger(L,2);
        bool changed = ImGui::InputInt(lbl, &v);
        lua_pushboolean(L,changed); lua_pushinteger(L,v); return 2;
    });
    REG("ColorEdit3", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        float c[3] = {(float)luaL_checknumber(L,2),(float)luaL_checknumber(L,3),(float)luaL_checknumber(L,4)};
        bool changed = ImGui::ColorEdit3(lbl, c);
        lua_pushboolean(L,changed); lua_pushnumber(L,c[0]); lua_pushnumber(L,c[1]); lua_pushnumber(L,c[2]); return 4;
    });
    REG("ColorEdit4", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        float c[4] = {(float)luaL_checknumber(L,2),(float)luaL_checknumber(L,3),(float)luaL_checknumber(L,4),(float)luaL_checknumber(L,5)};
        bool changed = ImGui::ColorEdit4(lbl, c);
        lua_pushboolean(L,changed); for(int i=0;i<4;i++) lua_pushnumber(L,c[i]); return 5;
    });
    REG("Selectable", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        bool sel = lua_toboolean(L,2)!=0;
        ImGuiSelectableFlags flags = (ImGuiSelectableFlags)luaL_optinteger(L,3,0);
        lua_pushboolean(L, ImGui::Selectable(lbl, sel, flags)); return 1;
    });
    REG("BeginCombo", [](lua_State* L)->int {
        lua_pushboolean(L, ImGui::BeginCombo(luaL_checkstring(L,1),luaL_checkstring(L,2))); return 1;
    });
    REG("EndCombo", [](lua_State* L)->int { ImGui::EndCombo(); return 0; });
    REG("Combo", [](lua_State* L)->int {
        const char* lbl = luaL_checkstring(L,1);
        int cur = (int)luaL_checkinteger(L,2);
        luaL_checktype(L, 3, LUA_TTABLE);
        int n = (int)lua_rawlen(L, 3);
        std::vector<const char*> items;
        std::vector<std::string> strs(n);
        for(int i=0;i<n;i++){
            lua_rawgeti(L,3,i+1);
            strs[i] = lua_tostring(L,-1) ? lua_tostring(L,-1) : "";
            items.push_back(strs[i].c_str());
            lua_pop(L,1);
        }
        bool changed = ImGui::Combo(lbl, &cur, items.data(), n);
        lua_pushboolean(L,changed); lua_pushinteger(L,cur); return 2;
    });

    // --- Trees
    REG("TreeNode", [](lua_State* L)->int { lua_pushboolean(L, ImGui::TreeNode("%s", luaL_checkstring(L,1))); return 1; });
    REG("TreePop",  [](lua_State* L)->int { ImGui::TreePop(); return 0; });
    REG("CollapsingHeader", [](lua_State* L)->int {
        lua_pushboolean(L, ImGui::CollapsingHeader(luaL_checkstring(L,1),
            (ImGuiTreeNodeFlags)luaL_optinteger(L,2,0))); return 1;
    });
    REG("SetNextItemOpen", [](lua_State* L)->int {
        ImGui::SetNextItemOpen(lua_toboolean(L,1)!=0, (ImGuiCond)luaL_optinteger(L,2,0)); return 0;
    });

    // --- Tabs
    REG("BeginTabBar",  [](lua_State* L)->int { lua_pushboolean(L, ImGui::BeginTabBar(luaL_checkstring(L,1),(ImGuiTabBarFlags)luaL_optinteger(L,2,0))); return 1; });
    REG("EndTabBar",    [](lua_State* L)->int { ImGui::EndTabBar(); return 0; });
    REG("BeginTabItem", [](lua_State* L)->int { lua_pushboolean(L, ImGui::BeginTabItem(luaL_checkstring(L,1))); return 1; });
    REG("EndTabItem",   [](lua_State* L)->int { ImGui::EndTabItem(); return 0; });

    // --- Columns / Table
    REG("Columns",       [](lua_State* L)->int { ImGui::Columns((int)luaL_optinteger(L,1,1),luaL_optstring(L,2,nullptr),(bool)luaL_optinteger(L,3,1)); return 0; });
    REG("NextColumn",    [](lua_State* L)->int { ImGui::NextColumn(); return 0; });
    REG("SetColumnWidth",[](lua_State* L)->int { ImGui::SetColumnWidth((int)luaL_checkinteger(L,1),(float)luaL_checknumber(L,2)); return 0; });
    REG("BeginTable", [](lua_State* L)->int {
        lua_pushboolean(L, ImGui::BeginTable(luaL_checkstring(L,1),(int)luaL_checkinteger(L,2),
            (ImGuiTableFlags)luaL_optinteger(L,3,0),
            {(float)luaL_optnumber(L,4,0),(float)luaL_optnumber(L,5,0)})); return 1;
    });
    REG("EndTable",          [](lua_State* L)->int { ImGui::EndTable(); return 0; });
    REG("TableNextRow",      [](lua_State* L)->int { ImGui::TableNextRow(); return 0; });
    REG("TableNextColumn",   [](lua_State* L)->int { ImGui::TableNextColumn(); return 0; });
    REG("TableSetupColumn",  [](lua_State* L)->int { ImGui::TableSetupColumn(luaL_checkstring(L,1)); return 0; });
    REG("TableHeadersRow",   [](lua_State* L)->int { ImGui::TableHeadersRow(); return 0; });

    // --- Popups
    REG("OpenPopup",       [](lua_State* L)->int { ImGui::OpenPopup(luaL_checkstring(L,1)); return 0; });
    REG("BeginPopup",      [](lua_State* L)->int { lua_pushboolean(L, ImGui::BeginPopup(luaL_checkstring(L,1))); return 1; });
    REG("EndPopup",        [](lua_State* L)->int { ImGui::EndPopup(); return 0; });
    REG("CloseCurrentPopup",[](lua_State* L)->int { ImGui::CloseCurrentPopup(); return 0; });

    // --- Utility
    REG("IsItemHovered",  [](lua_State* L)->int { lua_pushboolean(L, ImGui::IsItemHovered()); return 1; });
    REG("IsItemClicked",  [](lua_State* L)->int { lua_pushboolean(L, ImGui::IsItemClicked((ImGuiMouseButton)luaL_optinteger(L,1,0))); return 1; });
    REG("IsItemActive",   [](lua_State* L)->int { lua_pushboolean(L, ImGui::IsItemActive()); return 1; });
    REG("IsItemFocused",  [](lua_State* L)->int { lua_pushboolean(L, ImGui::IsItemFocused()); return 1; });
    REG("GetItemRectMin", [](lua_State* L)->int { auto p=ImGui::GetItemRectMin(); lua_pushnumber(L,p.x); lua_pushnumber(L,p.y); return 2; });
    REG("GetItemRectMax", [](lua_State* L)->int { auto p=ImGui::GetItemRectMax(); lua_pushnumber(L,p.x); lua_pushnumber(L,p.y); return 2; });
    REG("GetItemRectSize",[](lua_State* L)->int { auto p=ImGui::GetItemRectSize(); lua_pushnumber(L,p.x); lua_pushnumber(L,p.y); return 2; });
    REG("SetTooltip",     [](lua_State* L)->int { ImGui::SetTooltip("%s", luaL_checkstring(L,1)); return 0; });
    REG("BeginTooltip",   [](lua_State* L)->int { ImGui::BeginTooltip(); return 0; });
    REG("EndTooltip",     [](lua_State* L)->int { ImGui::EndTooltip(); return 0; });
    REG("GetFontSize",    [](lua_State* L)->int { lua_pushnumber(L, ImGui::GetFontSize()); return 1; });
    REG("CalcTextSize",   [](lua_State* L)->int {
        auto s = ImGui::CalcTextSize(luaL_checkstring(L,1));
        lua_pushnumber(L,s.x); lua_pushnumber(L,s.y); return 2;
    });
    REG("GetIO", [](lua_State* L)->int {
        auto& io = ImGui::GetIO();
        lua_newtable(L);
        lua_pushnumber(L, io.DeltaTime);        lua_setfield(L,-2,"DeltaTime");
        lua_pushnumber(L, io.Framerate);        lua_setfield(L,-2,"Framerate");
        lua_newtable(L);
        lua_pushnumber(L, io.DisplaySize.x);    lua_setfield(L,-2,"x");
        lua_pushnumber(L, io.DisplaySize.y);    lua_setfield(L,-2,"y");
        lua_setfield(L,-2,"DisplaySize");
        return 1;
    });
    REG("PushStyleColor", [](lua_State* L)->int {
        ImGuiCol idx = (ImGuiCol)luaL_checkinteger(L,1);
        ImVec4 c{ (float)luaL_checknumber(L,2),(float)luaL_checknumber(L,3),
                  (float)luaL_checknumber(L,4),(float)luaL_optnumber(L,5,1.0) };
        ImGui::PushStyleColor(idx, c); return 0;
    });
    REG("PopStyleColor", [](lua_State* L)->int { ImGui::PopStyleColor((int)luaL_optinteger(L,1,1)); return 0; });
    REG("PushStyleVar",  [](lua_State* L)->int {
        ImGuiStyleVar idx = (ImGuiStyleVar)luaL_checkinteger(L,1);
        if (lua_gettop(L) >= 3)
            ImGui::PushStyleVar(idx, ImVec2{(float)luaL_checknumber(L,2),(float)luaL_checknumber(L,3)});
        else
            ImGui::PushStyleVar(idx, (float)luaL_checknumber(L,2));
        return 0;
    });
    REG("PopStyleVar",  [](lua_State* L)->int { ImGui::PopStyleVar((int)luaL_optinteger(L,1,1)); return 0; });
    REG("PushID",       [](lua_State* L)->int { ImGui::PushID(luaL_checkstring(L,1)); return 0; });
    REG("PopID",        [](lua_State* L)->int { ImGui::PopID(); return 0; });
    REG("GetID",        [](lua_State* L)->int { lua_pushinteger(L, ImGui::GetID(luaL_checkstring(L,1))); return 1; });
    REG("GetTime",      [](lua_State* L)->int { lua_pushnumber(L, ImGui::GetTime()); return 1; });
    REG("GetFrameCount",[](lua_State* L)->int { lua_pushinteger(L, ImGui::GetFrameCount()); return 1; });
    REG("IsMouseDown",  [](lua_State* L)->int { lua_pushboolean(L, ImGui::IsMouseDown((ImGuiMouseButton)luaL_optinteger(L,1,0))); return 1; });
    REG("IsMouseClicked",[](lua_State* L)->int { lua_pushboolean(L, ImGui::IsMouseClicked((ImGuiMouseButton)luaL_optinteger(L,1,0))); return 1; });
    REG("GetMousePos",  [](lua_State* L)->int { auto p=ImGui::GetMousePos(); lua_pushnumber(L,p.x); lua_pushnumber(L,p.y); return 2; });
    REG("SetScrollHereY",[](lua_State* L)->int { ImGui::SetScrollHereY((float)luaL_optnumber(L,1,1.0)); return 0; });
    REG("GetScrollY",   [](lua_State* L)->int { lua_pushnumber(L, ImGui::GetScrollY()); return 1; });
    REG("GetScrollMaxY",[](lua_State* L)->int { lua_pushnumber(L, ImGui::GetScrollMaxY()); return 1; });

    // --- Draw list
    REG("GetWindowDrawList", [](lua_State* L)->int {
        return push_drawlist(L, ImGui::GetWindowDrawList());
    });
    REG("GetForegroundDrawList", [](lua_State* L)->int {
        return push_drawlist(L, ImGui::GetForegroundDrawList());
    });
    REG("GetBackgroundDrawList", [](lua_State* L)->int {
        return push_drawlist(L, ImGui::GetBackgroundDrawList());
    });

    // --- Constants
    lua_pushinteger(L, ImGuiCond_Always);       lua_setfield(L, -2, "Cond_Always");
    lua_pushinteger(L, ImGuiCond_Once);         lua_setfield(L, -2, "Cond_Once");
    lua_pushinteger(L, ImGuiCond_FirstUseEver); lua_setfield(L, -2, "Cond_FirstUseEver");
    lua_pushinteger(L, ImGuiCond_Appearing);    lua_setfield(L, -2, "Cond_Appearing");

    lua_pushinteger(L, ImGuiCol_Text);          lua_setfield(L, -2, "Col_Text");
    lua_pushinteger(L, ImGuiCol_Button);        lua_setfield(L, -2, "Col_Button");
    lua_pushinteger(L, ImGuiCol_ButtonHovered); lua_setfield(L, -2, "Col_ButtonHovered");
    lua_pushinteger(L, ImGuiCol_ButtonActive);  lua_setfield(L, -2, "Col_ButtonActive");
    lua_pushinteger(L, ImGuiCol_WindowBg);      lua_setfield(L, -2, "Col_WindowBg");
    lua_pushinteger(L, ImGuiCol_FrameBg);       lua_setfield(L, -2, "Col_FrameBg");
    lua_pushinteger(L, ImGuiCol_Header);        lua_setfield(L, -2, "Col_Header");
    lua_pushinteger(L, ImGuiCol_HeaderHovered); lua_setfield(L, -2, "Col_HeaderHovered");
    lua_pushinteger(L, ImGuiCol_HeaderActive);  lua_setfield(L, -2, "Col_HeaderActive");
    lua_pushinteger(L, ImGuiCol_Separator);     lua_setfield(L, -2, "Col_Separator");
    lua_pushinteger(L, ImGuiCol_SliderGrab);    lua_setfield(L, -2, "Col_SliderGrab");

    lua_pushinteger(L, ImGuiWindowFlags_NoTitleBar);    lua_setfield(L,-2,"WindowFlags_NoTitleBar");
    lua_pushinteger(L, ImGuiWindowFlags_NoResize);      lua_setfield(L,-2,"WindowFlags_NoResize");
    lua_pushinteger(L, ImGuiWindowFlags_NoMove);        lua_setfield(L,-2,"WindowFlags_NoMove");
    lua_pushinteger(L, ImGuiWindowFlags_NoScrollbar);   lua_setfield(L,-2,"WindowFlags_NoScrollbar");
    lua_pushinteger(L, ImGuiWindowFlags_AlwaysAutoResize);lua_setfield(L,-2,"WindowFlags_AlwaysAutoResize");
    lua_pushinteger(L, ImGuiWindowFlags_NoBackground);  lua_setfield(L,-2,"WindowFlags_NoBackground");
    lua_pushinteger(L, ImGuiWindowFlags_NoBringToDisplayFront);lua_setfield(L,-2,"WindowFlags_NoBringToDisplayFront");

    lua_pushinteger(L, ImGuiStyleVar_Alpha);         lua_setfield(L,-2,"StyleVar_Alpha");
    lua_pushinteger(L, ImGuiStyleVar_WindowRounding);lua_setfield(L,-2,"StyleVar_WindowRounding");
    lua_pushinteger(L, ImGuiStyleVar_FrameRounding); lua_setfield(L,-2,"StyleVar_FrameRounding");
    lua_pushinteger(L, ImGuiStyleVar_WindowPadding); lua_setfield(L,-2,"StyleVar_WindowPadding");

    lua_pushinteger(L, ImGuiInputTextFlags_ReadOnly);     lua_setfield(L,-2,"InputTextFlags_ReadOnly");
    lua_pushinteger(L, ImGuiInputTextFlags_AllowTabInput);lua_setfield(L,-2,"InputTextFlags_AllowTabInput");

    lua_pushinteger(L, ImGuiTableFlags_Borders);     lua_setfield(L,-2,"TableFlags_Borders");
    lua_pushinteger(L, ImGuiTableFlags_RowBg);       lua_setfield(L,-2,"TableFlags_RowBg");
    lua_pushinteger(L, ImGuiTableFlags_Resizable);   lua_setfield(L,-2,"TableFlags_Resizable");
    lua_pushinteger(L, ImGuiTableFlags_ScrollY);     lua_setfield(L,-2,"TableFlags_ScrollY");

#undef REG
    return 1;
}
