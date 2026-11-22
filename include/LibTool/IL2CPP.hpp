#pragma once
// language: C++20, file: include/LibTool/IL2CPP.hpp, target: iOS arm64/arm64e
// IL2CPP runtime bridge. Resolves live from metadata — no offline dump.cs needed.

#include "IL2CPPTypes.hpp"
#include "Config.hpp"
#include <optional>
#include <string>
#include <vector>
#include <string_view>
#include <functional>

// Forward types that the bridge uses internally
struct Il2CppException;

namespace lt::il2cpp {

// ------ Metadata version detection -------------------------------------------
enum class MetaVersion : uint8_t {
    Unknown = 0,
    V24  = 24,  // Unity 2019.x
    V245 = 25,  // Unity 2020.x
    V27  = 27,  // Unity 2021.x
    V29  = 29,  // Unity 2022.x
    V31  = 31,  // Unity 6 (6000.x) — primary target
};

[[nodiscard]] MetaVersion detected_version() noexcept;
[[nodiscard]] const char*  version_string() noexcept;

// ------ API function table (resolved once at startup) ------------------------
struct Api {
    // Domain / threading
    Il2CppDomain*          (*domain_get)();
    void*                  (*thread_attach)(Il2CppDomain*);
    void*                  (*thread_current)();
    void                   (*thread_detach)(void*);

    // Assembly enumeration
    const Il2CppAssembly** (*domain_get_assemblies)(Il2CppDomain*, size_t* count);

    // Image / class
    const Il2CppImage*     (*assembly_get_image)(const Il2CppAssembly*);
    const char*            (*image_get_name)(const Il2CppImage*);
    Il2CppClass*           (*class_from_name)(const Il2CppImage*, const char* ns, const char* name);
    Il2CppClass*           (*class_from_type)(const Il2CppType*);

    // Object lifecycle
    Il2CppObject*          (*object_new)(Il2CppClass*);
    Il2CppObject*          (*value_box)(Il2CppClass*, void* value);
    void*                  (*object_unbox)(Il2CppObject*);

    // Field access
    FieldInfo*             (*class_get_fields)(Il2CppClass*, void** iter);
    const char*            (*field_get_name)(FieldInfo*);
    Il2CppType*            (*field_get_type)(FieldInfo*);
    size_t                 (*field_get_offset)(FieldInfo*);
    void                   (*field_get_value)(Il2CppObject*, FieldInfo*, void* value);
    void                   (*field_set_value)(Il2CppObject*, FieldInfo*, void* value);
    void                   (*field_static_get_value)(FieldInfo*, void* value);
    void                   (*field_static_set_value)(FieldInfo*, void* value);

    // Method access
    const MethodInfo*      (*class_get_methods)(Il2CppClass*, void** iter);
    const char*            (*method_get_name)(const MethodInfo*);
    uint8_t                (*method_get_param_count)(const MethodInfo*);
    Il2CppObject*          (*runtime_invoke)(const MethodInfo*, void* obj,
                                             void** params, Il2CppException** exc);

    // Type system
    const Il2CppType*      (*class_get_type)(Il2CppClass*);
    uint32_t               (*type_get_type)(const Il2CppType*);
    const char*            (*type_get_name)(const Il2CppType*);

    // String helpers
    Il2CppString*          (*string_new)(const char*);
    Il2CppString*          (*string_new_len)(const char*, uint32_t len);

    // Array
    Il2CppArray*           (*array_new)(Il2CppClass* elem_class, il2cpp_array_size_t length);
    il2cpp_array_size_t    (*array_length)(Il2CppArray*);

    // GC handles — pin objects so the GC won't move or collect them
    uint32_t               (*gchandle_new)(Il2CppObject*, bool pinned);
    void                   (*gchandle_free)(uint32_t handle);
    Il2CppObject*          (*gchandle_get_target)(uint32_t handle);

    // Class metadata
    const char*            (*class_get_name)(Il2CppClass*);
    const char*            (*class_get_namespace)(Il2CppClass*);
    Il2CppClass*           (*class_get_parent)(Il2CppClass*);
    bool                   (*class_is_valuetype)(Il2CppClass*);
    bool                   (*class_is_enum)(Il2CppClass*);
    uint32_t               (*class_get_instance_size)(Il2CppClass*);
    Il2CppClass*           (*class_get_element_class)(Il2CppClass*);

    // Image metadata
    size_t                 (*image_get_class_count)(const Il2CppImage*);
    Il2CppClass*           (*image_get_class)(const Il2CppImage*, size_t idx);

    bool resolved{ false };
};

// Singleton — resolve_api() must be called after IL2CPP runtime init.
[[nodiscard]] Api& api() noexcept;
bool resolve_api();  // returns true if fully resolved

// ------ Thread-safety RAII helper --------------------------------------------
// Attach the calling thread to the IL2CPP domain before any il2cpp_* calls.
// Detaches only threads this scope attached itself. Existing Unity-owned
// threads must never be detached by a short-lived inspection scope.
struct Il2CppThreadScope {
    void* thread{ nullptr };
    bool owns_attachment{ false };
    Il2CppThreadScope() noexcept;
    ~Il2CppThreadScope() noexcept;
    Il2CppThreadScope(const Il2CppThreadScope&) = delete;
    Il2CppThreadScope& operator=(const Il2CppThreadScope&) = delete;
};

// ------ ClassHandle: safe wrapper around Il2CppClass* -----------------------
struct FieldDesc {
    std::string name;
    std::string type_name;
    Il2CppTypeEnum type_enum;
    size_t offset;      // -1 for static fields
    bool   is_static;
    FieldInfo* info;
};

struct MethodDesc {
    std::string name;
    std::string return_type;
    std::string signature;  // full "RetType MethodName(Param1, ...)"
    uint8_t param_count;
    const MethodInfo* info;
};

struct ClassHandle {
    Il2CppClass*  klass{ nullptr };
    MetaVersion   version{ MetaVersion::Unknown };

    [[nodiscard]] bool valid() const noexcept { return klass != nullptr; }
    [[nodiscard]] const char* name() const noexcept;
    [[nodiscard]] const char* ns()   const noexcept;
    [[nodiscard]] std::string full_name() const;      // "Namespace.ClassName"
    [[nodiscard]] ClassHandle parent() const noexcept;
    [[nodiscard]] bool is_valuetype() const noexcept;
    [[nodiscard]] bool is_enum() const noexcept;
    [[nodiscard]] uint32_t instance_size() const noexcept;

    [[nodiscard]] std::vector<FieldDesc>  fields() const;
    [[nodiscard]] std::vector<MethodDesc> methods() const;

    // Enumerate live GC heap instances whose klass pointer matches this class.
    // Runs synchronously; call on a background thread for large heaps.
    [[nodiscard]] std::vector<uintptr_t>  find_objects(size_t limit = LT_FINDOBJ_MAX) const;

    // Field access on a live instance (or null for static)
    bool field_get(uintptr_t obj_addr, const char* field_name, void* out, size_t out_size) const;
    bool field_set(uintptr_t obj_addr, const char* field_name, const void* in, size_t in_size) const;

    // Method invocation
    Il2CppObject* invoke(const MethodInfo* m, void* obj, void** params) const;
};

// Primary resolution — splits "Namespace.ClassName" on the final dot.
[[nodiscard]] std::optional<ClassHandle>
    class_from_full_name(std::string_view full_name, bool search_all_images = true);

// Low-level: resolve from a specific image
[[nodiscard]] std::optional<ClassHandle>
    class_from_name_image(const Il2CppImage* image,
                          const char* ns, const char* name);

// Enumerate all loaded images as (image_ptr, name) pairs
[[nodiscard]] std::vector<std::pair<const Il2CppImage*, std::string>> all_images();

// Walk all classes in all images and call visitor(classHandle) for each.
// Return false from visitor to stop iteration.
void enum_classes(std::function<bool(const ClassHandle&)> visitor);

// Method pointer extraction with PAC stripping
[[nodiscard]] uintptr_t method_ptr(const MethodInfo* m) noexcept;

// Type name for display (readable, not mangled)
[[nodiscard]] std::string type_display_name(const Il2CppType* t) noexcept;

} // namespace lt::il2cpp

// Convenience alias
using LTClassHandle = lt::il2cpp::ClassHandle;

// Need this for Bindings_IL2CPP and LuaRuntime
#ifndef LT_FINDOBJ_MAX
#  define LT_FINDOBJ_MAX 2048
#endif
