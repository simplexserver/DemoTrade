// language: Objective-C++, file: src/Lua/Bindings_IL2CPP.mm, target: iOS arm64/arm64e
// Lua IL2CPP bindings — Class.fromName, findObjects, field/method access.
// ObjectUD wraps a GC-pinned live instance. ClassUD wraps Il2CppClass*.
// API surface verified line-by-line against HR_Dev_Menu_LibTool.lua.

extern "C" {
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
}
#include "LibTool/IL2CPP.hpp"
#include "LibTool/LuaRuntime.hpp"
#include "LibTool/Memory.hpp"
#include "LibTool/Scanner.hpp"
#include "LibTool/Hook.hpp"
#include <cstring>
#include <cstdio>
#include <cmath>

// ------ Userdata types -------------------------------------------------------
static const char* CLASS_UD_MT  = "LT.ClassUD";
static const char* OBJECT_UD_MT = "LT.ObjectUD";

struct ClassUD {
    lt::il2cpp::ClassHandle handle;
};
struct ObjectUD {
    uint32_t     gc_handle;    // pinned GC handle
    Il2CppClass* klass;        // cached class pointer
    uintptr_t    obj_addr;     // raw address (for direct memory access fallback)
};

// ------ Helper: push value from IL2CPP field --------------------------------
static void push_il2cpp_value(lua_State* L, uintptr_t obj_addr,
                               const lt::il2cpp::FieldDesc& fd) {
    using ::Il2CppTypeEnum;
    switch (fd.type_enum) {
        case Il2CppTypeEnum::IL2CPP_TYPE_BOOLEAN: {
            bool v = false;
            if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 1) != lt::mem::MemStatus::Ok) { lua_pushnil(L); return; }
            lua_pushboolean(L, v ? 1 : 0); return;
        }
        case Il2CppTypeEnum::IL2CPP_TYPE_I4:
        case Il2CppTypeEnum::IL2CPP_TYPE_U4: {
            int32_t v = 0;
            if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 4) != lt::mem::MemStatus::Ok) { lua_pushnil(L); return; }
            lua_pushinteger(L, v); return;
        }
        case Il2CppTypeEnum::IL2CPP_TYPE_I8:
        case Il2CppTypeEnum::IL2CPP_TYPE_U8: {
            int64_t v = 0;
            if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 8) != lt::mem::MemStatus::Ok) { lua_pushnil(L); return; }
            lua_pushinteger(L, static_cast<lua_Integer>(v)); return;
        }
        case Il2CppTypeEnum::IL2CPP_TYPE_R4: {
            float v = 0.f;
            if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 4) != lt::mem::MemStatus::Ok) { lua_pushnil(L); return; }
            lua_pushnumber(L, static_cast<lua_Number>(v)); return;
        }
        case Il2CppTypeEnum::IL2CPP_TYPE_R8: {
            double v = 0.0;
            if (lt::mem::read_bytes(obj_addr + fd.offset, &v, 8) != lt::mem::MemStatus::Ok) { lua_pushnil(L); return; }
            lua_pushnumber(L, static_cast<lua_Number>(v)); return;
        }
        case Il2CppTypeEnum::IL2CPP_TYPE_STRING: {
            auto ptr = lt::mem::read_ptr(obj_addr + fd.offset);
            if (ptr.ok() && ptr.value) {
                auto s = lt::mem::read_il2cpp_string(ptr.value);
                if (s) { lua_pushstring(L, s->c_str()); return; }
            }
            lua_pushnil(L); return;
        }
        case Il2CppTypeEnum::IL2CPP_TYPE_CLASS:
        case Il2CppTypeEnum::IL2CPP_TYPE_OBJECT:
        case Il2CppTypeEnum::IL2CPP_TYPE_SZARRAY: {
            auto ptr = lt::mem::read_ptr(obj_addr + fd.offset);
            if (!ptr.ok() || !ptr.value) { lua_pushnil(L); return; }
            // Wrap in ObjectUD
            ObjectUD* ud = static_cast<ObjectUD*>(lua_newuserdata(L, sizeof(ObjectUD)));
            Il2CppClass* k = nullptr;
            auto klass_res = lt::mem::read_ptr(ptr.value);
            if (klass_res.ok()) k = reinterpret_cast<Il2CppClass*>(klass_res.value);
            ud->gc_handle = lt::il2cpp::api().gchandle_new ?
                lt::il2cpp::api().gchandle_new(reinterpret_cast<Il2CppObject*>(ptr.value), true) : 0;
            ud->klass    = k;
            ud->obj_addr = ptr.value;
            luaL_setmetatable(L, OBJECT_UD_MT);
            return;
        }
        default: {
            // Try as integer
            int64_t v = 0;
            if (lt::mem::read_bytes(obj_addr + fd.offset, &v, sizeof(v)) != lt::mem::MemStatus::Ok) { lua_pushnil(L); return; }
            lua_pushinteger(L, static_cast<lua_Integer>(v));
            return;
        }
    }
}

// ------ ObjectUD metatable ---------------------------------------------------
static int obj_index(lua_State* L) {
    ObjectUD* ud = static_cast<ObjectUD*>(luaL_checkudata(L, 1, OBJECT_UD_MT));
    const char* key = luaL_checkstring(L, 2);

    // Handle special keys first
    if (std::strcmp(key, "getClass") == 0) {
        lua_pushcclosure(L, [](lua_State* L) -> int {
            ObjectUD* ud = static_cast<ObjectUD*>(luaL_checkudata(L, 1, OBJECT_UD_MT));
            ClassUD* cud = static_cast<ClassUD*>(lua_newuserdata(L, sizeof(ClassUD)));
            new (cud) ClassUD{ lt::il2cpp::ClassHandle{ ud->klass, lt::il2cpp::detected_version() } };
            luaL_setmetatable(L, CLASS_UD_MT);
            return 1;
        }, 0);
        return 1;
    }
    if (std::strcmp(key, "__addr") == 0) {
        lua_pushinteger(L, static_cast<lua_Integer>(ud->obj_addr));
        return 1;
    }

    if (!ud->klass || !ud->obj_addr) { lua_pushnil(L); return 1; }

    lt::il2cpp::ClassHandle ch{ ud->klass, lt::il2cpp::detected_version() };
    auto fds = ch.fields();
    for (auto& fd : fds) {
        if (fd.name != key) continue;
        if (fd.is_static) {
            if (lt::il2cpp::api().field_static_get_value && fd.info) {
                uint8_t buf[16]{};
                lt::il2cpp::api().field_static_get_value(fd.info, buf);
                // push as integer (best effort)
                lua_pushinteger(L, *reinterpret_cast<lua_Integer*>(buf));
            } else lua_pushnil(L);
        } else {
            push_il2cpp_value(L, ud->obj_addr, fd);
        }
        return 1;
    }

    // Check methods
    auto mds = ch.methods();
    for (auto& md : mds) {
        if (md.name != key) continue;
        // Push a closure that invokes the method
        const MethodInfo* info = md.info;
        lua_pushlightuserdata(L, const_cast<MethodInfo*>(info));
        lua_pushlightuserdata(L, reinterpret_cast<void*>(ud->obj_addr));
        lua_pushcclosure(L, [](lua_State* L) -> int {
            const MethodInfo* mi = static_cast<const MethodInfo*>(lua_touserdata(L, lua_upvalueindex(1)));
            void* obj = lua_touserdata(L, lua_upvalueindex(2));
            if (!mi || !lt::il2cpp::api().runtime_invoke) {
                lua_pushnil(L); return 1;
            }
            lt::il2cpp::Il2CppThreadScope scope;
            Il2CppException* exc = nullptr;
            // Simple: pass nil for now (full param marshaling is handled per-call in HR Dev Menu via pcall)
            Il2CppObject* ret = lt::il2cpp::api().runtime_invoke(mi, obj, nullptr, &exc);
            if (exc) {
                lua_pushnil(L);
                // Extract exception message
                auto msg = lt::mem::read_il2cpp_string(reinterpret_cast<uintptr_t>(exc) + 0x14);
                lua_pushstring(L, msg ? msg->c_str() : "il2cpp exception");
                return 2;
            }
            if (ret) {
                ObjectUD* retu = static_cast<ObjectUD*>(lua_newuserdata(L, sizeof(ObjectUD)));
                retu->gc_handle = lt::il2cpp::api().gchandle_new ?
                    lt::il2cpp::api().gchandle_new(ret, true) : 0;
                auto kres = lt::mem::read_ptr(reinterpret_cast<uintptr_t>(ret));
                retu->klass    = kres.ok() ? reinterpret_cast<Il2CppClass*>(kres.value) : nullptr;
                retu->obj_addr = reinterpret_cast<uintptr_t>(ret);
                luaL_setmetatable(L, OBJECT_UD_MT);
                return 1;
            }
            lua_pushnil(L);
            return 1;
        }, 2);
        return 1;
    }

    lua_pushnil(L);
    return 1;
}

static int obj_newindex(lua_State* L) {
    ObjectUD* ud = static_cast<ObjectUD*>(luaL_checkudata(L, 1, OBJECT_UD_MT));
    const char* key = luaL_checkstring(L, 2);
    if (!ud->klass || !ud->obj_addr) return 0;

    lt::il2cpp::ClassHandle ch{ ud->klass, lt::il2cpp::detected_version() };
    for (auto& fd : ch.fields()) {
        if (fd.name != key) continue;
        using ::Il2CppTypeEnum;
        if (fd.is_static && lt::il2cpp::api().field_static_set_value && fd.info) {
            // Type-specific marshal
            if (lua_type(L, 3) == LUA_TNUMBER) {
                double v = lua_tonumber(L, 3);
                if (fd.type_enum == Il2CppTypeEnum::IL2CPP_TYPE_R4) {
                    float f = static_cast<float>(v);
                    lt::il2cpp::api().field_static_set_value(fd.info, &f);
                } else {
                    int64_t i = static_cast<int64_t>(v);
                    lt::il2cpp::api().field_static_set_value(fd.info, &i);
                }
            }
            return 0;
        }
        if (!fd.is_static && ud->obj_addr) {
            if (lua_type(L, 3) == LUA_TNUMBER) {
                if (fd.type_enum == Il2CppTypeEnum::IL2CPP_TYPE_R4) {
                    float v = static_cast<float>(lua_tonumber(L, 3));
                    if (!lt::mem::write_bytes(ud->obj_addr + fd.offset, &v, 4).ok()) return luaL_error(L, "IL2CPP field write failed");
                } else if (fd.type_enum == Il2CppTypeEnum::IL2CPP_TYPE_R8) {
                    double v = lua_tonumber(L, 3);
                    if (!lt::mem::write_bytes(ud->obj_addr + fd.offset, &v, 8).ok()) return luaL_error(L, "IL2CPP field write failed");
                } else {
                    int64_t v = static_cast<int64_t>(lua_tointeger(L, 3));
                    if (!lt::mem::write_bytes(ud->obj_addr + fd.offset, &v,
                                        fd.type_enum == Il2CppTypeEnum::IL2CPP_TYPE_I4 ? 4 : 8).ok()) return luaL_error(L, "IL2CPP field write failed");
                }
            } else if (lua_type(L, 3) == LUA_TBOOLEAN) {
                bool v = lua_toboolean(L, 3) != 0;
                if (!lt::mem::write_bytes(ud->obj_addr + fd.offset, &v, 1).ok()) return luaL_error(L, "IL2CPP field write failed");
            }
        }
        return 0;
    }
    return 0;
}

static int obj_gc(lua_State* L) {
    ObjectUD* ud = static_cast<ObjectUD*>(luaL_checkudata(L, 1, OBJECT_UD_MT));
    if (ud->gc_handle && lt::il2cpp::api().gchandle_free)
        lt::il2cpp::api().gchandle_free(ud->gc_handle);
    ud->gc_handle = 0;
    return 0;
}

static int obj_tostring(lua_State* L) {
    ObjectUD* ud = static_cast<ObjectUD*>(luaL_checkudata(L, 1, OBJECT_UD_MT));
    char buf[128];
    snprintf(buf, sizeof(buf), "Il2CppObject(0x%lx)", ud->obj_addr);
    lua_pushstring(L, buf);
    return 1;
}

// ------ ClassUD metatable ----------------------------------------------------
static int cls_find_objects(lua_State* L) {
    ClassUD* ud = static_cast<ClassUD*>(luaL_checkudata(L, 1, CLASS_UD_MT));
    auto objs = ud->handle.find_objects(LT_FINDOBJ_MAX);
    lua_newtable(L);
    for (size_t i = 0; i < objs.size(); ++i) {
        ObjectUD* obu = static_cast<ObjectUD*>(lua_newuserdata(L, sizeof(ObjectUD)));
        auto kres = lt::mem::read_ptr(objs[i]);
        obu->klass    = kres.ok() ? reinterpret_cast<Il2CppClass*>(kres.value) : ud->handle.klass;
        obu->obj_addr = objs[i];
        obu->gc_handle = lt::il2cpp::api().gchandle_new ?
            lt::il2cpp::api().gchandle_new(reinterpret_cast<Il2CppObject*>(objs[i]), true) : 0;
        luaL_setmetatable(L, OBJECT_UD_MT);
        lua_rawseti(L, -2, static_cast<lua_Integer>(i + 1));
    }
    return 1;
}

// cls:MethodName(args) — class-level method invocation (static methods)
static int cls_index(lua_State* L) {
    ClassUD* ud = static_cast<ClassUD*>(luaL_checkudata(L, 1, CLASS_UD_MT));
    const char* key = luaL_checkstring(L, 2);

    if (std::strcmp(key, "findObjects") == 0) {
        lua_pushcfunction(L, cls_find_objects);
        return 1;
    }
    if (std::strcmp(key, "new") == 0) {
        lua_pushlightuserdata(L, ud->handle.klass);
        lua_pushcclosure(L, [](lua_State* L) -> int {
            Il2CppClass* klass = static_cast<Il2CppClass*>(lua_touserdata(L, lua_upvalueindex(1)));
            if (!klass || !lt::il2cpp::api().object_new) { lua_pushnil(L); return 1; }
            lt::il2cpp::Il2CppThreadScope scope;
            Il2CppObject* obj = lt::il2cpp::api().object_new(klass);
            if (!obj) { lua_pushnil(L); return 1; }
            ObjectUD* ud = static_cast<ObjectUD*>(lua_newuserdata(L, sizeof(ObjectUD)));
            ud->gc_handle = lt::il2cpp::api().gchandle_new ?
                lt::il2cpp::api().gchandle_new(obj, false) : 0;
            ud->klass = klass;
            ud->obj_addr = reinterpret_cast<uintptr_t>(obj);
            luaL_setmetatable(L, OBJECT_UD_MT);
            return 1;
        }, 1);
        return 1;
    }

    // Static field access
    for (auto& fd : ud->handle.fields()) {
        if (!fd.is_static || fd.name != key) continue;
        if (lt::il2cpp::api().field_static_get_value && fd.info) {
            uint8_t buf[16]{};
            lt::il2cpp::api().field_static_get_value(fd.info, buf);
            switch (fd.type_enum) {
                case Il2CppTypeEnum::IL2CPP_TYPE_R4: {
                    float v; memcpy(&v, buf, 4); lua_pushnumber(L, v); return 1;
                }
                case Il2CppTypeEnum::IL2CPP_TYPE_R8: {
                    double v; memcpy(&v, buf, 8); lua_pushnumber(L, v); return 1;
                }
                case Il2CppTypeEnum::IL2CPP_TYPE_BOOLEAN:
                    lua_pushboolean(L, buf[0]); return 1;
                default:
                    lua_pushinteger(L, *reinterpret_cast<lua_Integer*>(buf)); return 1;
            }
        }
        lua_pushnil(L); return 1;
    }

    // Static method lookup
    for (auto& md : ud->handle.methods()) {
        if (md.name != key) continue;
        const MethodInfo* info = md.info;
        lua_pushlightuserdata(L, const_cast<MethodInfo*>(info));
        lua_pushcclosure(L, [](lua_State* L) -> int {
            const MethodInfo* mi = static_cast<const MethodInfo*>(lua_touserdata(L, lua_upvalueindex(1)));
            if (!mi || !lt::il2cpp::api().runtime_invoke) { lua_pushnil(L); return 1; }
            lt::il2cpp::Il2CppThreadScope scope;
            Il2CppException* exc = nullptr;
            Il2CppObject* ret = lt::il2cpp::api().runtime_invoke(mi, nullptr, nullptr, &exc);
            if (exc || !ret) { lua_pushnil(L); return 1; }
            ObjectUD* retu = static_cast<ObjectUD*>(lua_newuserdata(L, sizeof(ObjectUD)));
            retu->gc_handle = lt::il2cpp::api().gchandle_new ?
                lt::il2cpp::api().gchandle_new(ret, true) : 0;
            auto kr = lt::mem::read_ptr(reinterpret_cast<uintptr_t>(ret));
            retu->klass = kr.ok() ? reinterpret_cast<Il2CppClass*>(kr.value) : nullptr;
            retu->obj_addr = reinterpret_cast<uintptr_t>(ret);
            luaL_setmetatable(L, OBJECT_UD_MT);
            return 1;
        }, 1);
        return 1;
    }

    lua_pushnil(L);
    return 1;
}

static int cls_newindex(lua_State* L) {
    ClassUD* ud = static_cast<ClassUD*>(luaL_checkudata(L, 1, CLASS_UD_MT));
    const char* key = luaL_checkstring(L, 2);
    for (auto& fd : ud->handle.fields()) {
        if (!fd.is_static || fd.name != key || !fd.info) continue;
        if (!lt::il2cpp::api().field_static_set_value) return 0;
        if (lua_type(L, 3) == LUA_TNUMBER) {
            if (fd.type_enum == Il2CppTypeEnum::IL2CPP_TYPE_R4) {
                float v = static_cast<float>(lua_tonumber(L, 3));
                lt::il2cpp::api().field_static_set_value(fd.info, &v);
            } else {
                double v = lua_tonumber(L, 3);
                lt::il2cpp::api().field_static_set_value(fd.info, &v);
            }
        } else if (lua_type(L, 3) == LUA_TBOOLEAN) {
            bool v = lua_toboolean(L, 3) != 0;
            lt::il2cpp::api().field_static_set_value(fd.info, &v);
        }
        return 0;
    }
    return 0;
}

static int cls_gc(lua_State* L) {
    ClassUD* ud = static_cast<ClassUD*>(luaL_checkudata(L, 1, CLASS_UD_MT));
    ud->~ClassUD();
    return 0;
}

static int cls_tostring(lua_State* L) {
    ClassUD* ud = static_cast<ClassUD*>(luaL_checkudata(L, 1, CLASS_UD_MT));
    char buf[256];
    snprintf(buf, sizeof(buf), "Il2CppClass(%s)", ud->handle.full_name().c_str());
    lua_pushstring(L, buf);
    return 1;
}

// ------ Class.fromName -------------------------------------------------------
static int lua_class_from_name(lua_State* L) {
    const char* full_name = luaL_checkstring(L, 1);
    auto ch = lt::il2cpp::class_from_full_name(full_name, true);
    if (!ch || !ch->valid()) {
        lua_pushnil(L);
        return 1;
    }
    ClassUD* ud = static_cast<ClassUD*>(lua_newuserdata(L, sizeof(ClassUD)));
    new (ud) ClassUD{ *ch };
    luaL_setmetatable(L, CLASS_UD_MT);
    return 1;
}

// Class.fromNameImage("Assembly-CSharp", "Namespace", "ClassName")
static int lua_class_from_name_image(lua_State* L) {
    const char* image_name = luaL_checkstring(L, 1);
    const char* ns         = luaL_optstring(L, 2, "");
    const char* name       = luaL_checkstring(L, 3);
    for (auto& [img, iname] : lt::il2cpp::all_images()) {
        if (iname.find(image_name) == std::string::npos) continue;
        auto ch = lt::il2cpp::class_from_name_image(img, ns, name);
        if (!ch) continue;
        ClassUD* ud = static_cast<ClassUD*>(lua_newuserdata(L, sizeof(ClassUD)));
        new (ud) ClassUD{ *ch };
        luaL_setmetatable(L, CLASS_UD_MT);
        return 1;
    }
    lua_pushnil(L);
    return 1;
}

// ------ luaopen_Class --------------------------------------------------------
extern "C" int luaopen_Class(lua_State* L) {
    // Create ClassUD metatable
    luaL_newmetatable(L, CLASS_UD_MT);
    lua_pushcfunction(L, cls_index);     lua_setfield(L, -2, "__index");
    lua_pushcfunction(L, cls_newindex);  lua_setfield(L, -2, "__newindex");
    lua_pushcfunction(L, cls_gc);        lua_setfield(L, -2, "__gc");
    lua_pushcfunction(L, cls_tostring);  lua_setfield(L, -2, "__tostring");
    lua_pop(L, 1);

    // Create ObjectUD metatable
    luaL_newmetatable(L, OBJECT_UD_MT);
    lua_pushcfunction(L, obj_index);     lua_setfield(L, -2, "__index");
    lua_pushcfunction(L, obj_newindex);  lua_setfield(L, -2, "__newindex");
    lua_pushcfunction(L, obj_gc);        lua_setfield(L, -2, "__gc");
    lua_pushcfunction(L, obj_tostring);  lua_setfield(L, -2, "__tostring");
    lua_pop(L, 1);

    // Class library table
    static const luaL_Reg class_lib[] = {
        { "fromName",      lua_class_from_name },
        { "fromNameImage", lua_class_from_name_image },
        { nullptr, nullptr }
    };
    luaL_newlib(L, class_lib);
    return 1;
}

// ------ luaopen_Memory -------------------------------------------------------
extern "C" int luaopen_Memory(lua_State* L) {
    static const luaL_Reg mem_lib[] = {
        { "read_int8",   [](lua_State* L) -> int { auto r = lt::mem::read<int8_t>(luaL_checkinteger(L,1));   r.ok() ? lua_pushinteger(L,r.value) : lua_pushnil(L); return 1; } },
        { "read_int16",  [](lua_State* L) -> int { auto r = lt::mem::read<int16_t>(luaL_checkinteger(L,1));  r.ok() ? lua_pushinteger(L,r.value) : lua_pushnil(L); return 1; } },
        { "read_int32",  [](lua_State* L) -> int { auto r = lt::mem::read<int32_t>(luaL_checkinteger(L,1));  r.ok() ? lua_pushinteger(L,r.value) : lua_pushnil(L); return 1; } },
        { "read_int64",  [](lua_State* L) -> int { auto r = lt::mem::read<int64_t>(luaL_checkinteger(L,1));  r.ok() ? lua_pushinteger(L,r.value) : lua_pushnil(L); return 1; } },
        { "read_uint32", [](lua_State* L) -> int { auto r = lt::mem::read<uint32_t>(luaL_checkinteger(L,1)); r.ok() ? lua_pushinteger(L,r.value) : lua_pushnil(L); return 1; } },
        { "read_float",  [](lua_State* L) -> int { auto r = lt::mem::read<float>(luaL_checkinteger(L,1));    r.ok() ? lua_pushnumber(L,r.value) : lua_pushnil(L); return 1; } },
        { "read_double", [](lua_State* L) -> int { auto r = lt::mem::read<double>(luaL_checkinteger(L,1));   r.ok() ? lua_pushnumber(L,r.value) : lua_pushnil(L); return 1; } },
        { "read_ptr",    [](lua_State* L) -> int { auto r = lt::mem::read_ptr(luaL_checkinteger(L,1));       r.ok() ? lua_pushinteger(L,static_cast<lua_Integer>(r.value)) : lua_pushnil(L); return 1; } },
        { "read_cstr",   [](lua_State* L) -> int { auto s = lt::mem::read_cstr(luaL_checkinteger(L,1)); if (s) lua_pushlstring(L,s->data(),s->size()); else lua_pushnil(L); return 1; } },
        { "read_ptr_chain", [](lua_State* L) -> int {
            uintptr_t base = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
            luaL_checktype(L, 2, LUA_TTABLE);
            std::vector<ptrdiff_t> offsets;
            lua_pushnil(L);
            while (lua_next(L, 2)) { offsets.push_back(static_cast<ptrdiff_t>(luaL_checkinteger(L,-1))); lua_pop(L,1); }
            auto r = lt::mem::read_ptr_chain(base, offsets);
            r.ok() ? lua_pushinteger(L,static_cast<lua_Integer>(r.value)) : lua_pushnil(L);
            return 1;
        }},
        { "write_int32", [](lua_State* L) -> int { auto w = lt::mem::write<int32_t>(luaL_checkinteger(L,1),(int32_t)luaL_checkinteger(L,2)); lua_pushboolean(L,w.ok()); return 1; } },
        { "write_uint32",[](lua_State* L) -> int { auto w = lt::mem::write<uint32_t>(luaL_checkinteger(L,1),(uint32_t)luaL_checkinteger(L,2)); lua_pushboolean(L,w.ok()); return 1; } },
        { "write_int64", [](lua_State* L) -> int { auto w = lt::mem::write<int64_t>(luaL_checkinteger(L,1),(int64_t)luaL_checkinteger(L,2)); lua_pushboolean(L,w.ok()); return 1; } },
        { "write_float", [](lua_State* L) -> int { auto w = lt::mem::write<float>(luaL_checkinteger(L,1),(float)luaL_checknumber(L,2)); lua_pushboolean(L,w.ok()); return 1; } },
        { "write_double",[](lua_State* L) -> int { auto w = lt::mem::write<double>(luaL_checkinteger(L,1),luaL_checknumber(L,2)); lua_pushboolean(L,w.ok()); return 1; } },
        { "write_ptr",   [](lua_State* L) -> int { auto w = lt::mem::write_ptr(luaL_checkinteger(L,1),(uintptr_t)luaL_checkinteger(L,2)); lua_pushboolean(L,w.ok()); return 1; } },
        { "write_bytes", [](lua_State* L) -> int {
            uintptr_t addr = static_cast<uintptr_t>(luaL_checkinteger(L,1));
            size_t len = 0;
            const char* data = luaL_checklstring(L, 2, &len);
            auto w = lt::mem::write_bytes(addr, data, len);
            lua_pushboolean(L, w.ok());
            return 1;
        }},
        { "aob_scan", [](lua_State* L) -> int {
            const char* pat = luaL_checkstring(L, 1);
            uintptr_t start = luaL_optinteger(L, 2, 0);
            uintptr_t end   = luaL_optinteger(L, 3, 0);
            auto results = lt::scanner::aob_scan(pat, start, end);
            lua_newtable(L);
            for (size_t i = 0; i < results.size(); ++i) {
                lua_pushinteger(L, static_cast<lua_Integer>(results[i]));
                lua_rawseti(L, -2, static_cast<lua_Integer>(i + 1));
            }
            return 1;
        }},
        { "is_readable",   [](lua_State* L)->int { lua_pushboolean(L,lt::mem::is_readable(luaL_checkinteger(L,1))); return 1; } },
        { "is_writable",   [](lua_State* L)->int { lua_pushboolean(L,lt::mem::is_writable(luaL_checkinteger(L,1))); return 1; } },
        { "patch_ret",     [](lua_State* L)->int { auto r = lt::mem::patch_ret(luaL_checkinteger(L,1)); lua_pushboolean(L,r.ok()); return 1; } },
        { "patch_nop",     [](lua_State* L)->int { auto r = lt::mem::patch_nop(luaL_checkinteger(L,1),(uint32_t)luaL_optinteger(L,2,1)); lua_pushboolean(L,r.ok()); return 1; } },
        { nullptr, nullptr }
    };
    luaL_newlib(L, mem_lib);
    return 1;
}

// ------ luaopen_Hook ---------------------------------------------------------
extern "C" int luaopen_Hook(lua_State* L) {
    static const luaL_Reg hook_lib[] = {
        { "patch_ret", [](lua_State* L) -> int {
            uintptr_t addr = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
            const char* lbl = luaL_optstring(L, 2, "ret");
            uint32_t id = lt::hook::patch_ret(addr, lbl);
            lua_pushinteger(L, id);
            return 1;
        }},
        { "patch_nop", [](lua_State* L) -> int {
            uintptr_t addr  = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
            uint32_t  count = static_cast<uint32_t>(luaL_optinteger(L, 2, 1));
            const char* lbl = luaL_optstring(L, 3, "nop");
            uint32_t id = lt::hook::patch_nop(addr, count, lbl);
            lua_pushinteger(L, id);
            return 1;
        }},
        { "enable",  [](lua_State* L)->int { lua_pushboolean(L, lt::hook::enable(luaL_checkinteger(L,1))); return 1; } },
        { "disable", [](lua_State* L)->int { lua_pushboolean(L, lt::hook::disable(luaL_checkinteger(L,1))); return 1; } },
        { "remove",  [](lua_State* L)->int { lua_pushboolean(L, lt::hook::remove(luaL_checkinteger(L,1))); return 1; } },
        { nullptr, nullptr }
    };
    luaL_newlib(L, hook_lib);
    return 1;
}

