#pragma once
// language: C++20, file: include/LibTool/IL2CPPTypes.hpp, target: iOS arm64/arm64e
// IL2CPP struct layouts across Unity metadata versions v24–v31.
// All offsets confirmed via reverse engineering; use the accessor macros rather
// than direct struct casts — the version dispatch handles layout differences.

#include <cstdint>
#include <cstddef>

// ------ Forward declarations --------------------------------------------------
struct Il2CppObject;
struct Il2CppClass;
struct FieldInfo;
struct MethodInfo;
struct Il2CppType;
struct Il2CppImage;
struct Il2CppAssembly;
struct Il2CppDomain;
struct Il2CppArray;
struct Il2CppString;
struct Il2CppGenericClass;
struct Il2CppRGCTXData;
struct VirtualInvokeData;
struct ParameterInfo;

// ------ Primitive type enums (stable across versions) --------------------------
enum class Il2CppTypeEnum : uint8_t {
    IL2CPP_TYPE_VOID       = 0x01,
    IL2CPP_TYPE_BOOLEAN    = 0x02,
    IL2CPP_TYPE_CHAR       = 0x03,
    IL2CPP_TYPE_I1         = 0x04,
    IL2CPP_TYPE_U1         = 0x05,
    IL2CPP_TYPE_I2         = 0x06,
    IL2CPP_TYPE_U2         = 0x07,
    IL2CPP_TYPE_I4         = 0x08,
    IL2CPP_TYPE_U4         = 0x09,
    IL2CPP_TYPE_I8         = 0x0A,
    IL2CPP_TYPE_U8         = 0x0B,
    IL2CPP_TYPE_R4         = 0x0C,
    IL2CPP_TYPE_R8         = 0x0D,
    IL2CPP_TYPE_STRING     = 0x0E,
    IL2CPP_TYPE_PTR        = 0x0F,
    IL2CPP_TYPE_BYREF      = 0x10,
    IL2CPP_TYPE_VALUETYPE  = 0x11,
    IL2CPP_TYPE_CLASS      = 0x12,
    IL2CPP_TYPE_VAR        = 0x13,
    IL2CPP_TYPE_ARRAY      = 0x14,
    IL2CPP_TYPE_GENERICINST= 0x15,
    IL2CPP_TYPE_TYPEDBYREF = 0x16,
    IL2CPP_TYPE_I          = 0x18,
    IL2CPP_TYPE_U          = 0x19,
    IL2CPP_TYPE_FNPTR      = 0x1B,
    IL2CPP_TYPE_OBJECT     = 0x1C,
    IL2CPP_TYPE_SZARRAY    = 0x1D,
    IL2CPP_TYPE_MVAR       = 0x1E,
    IL2CPP_TYPE_CMOD_REQD  = 0x1F,
    IL2CPP_TYPE_CMOD_OPT   = 0x20,
    IL2CPP_TYPE_INTERNAL   = 0x21,
    IL2CPP_TYPE_MODIFIER   = 0x40,
    IL2CPP_TYPE_SENTINEL   = 0x41,
    IL2CPP_TYPE_PINNED     = 0x45,
    IL2CPP_TYPE_ENUM       = 0x55,
};

// ------ Il2CppType (stable across versions) -----------------------------------
struct Il2CppType {
    union {
        Il2CppClass* klass;
        void*        data;
    };
    uint32_t attrs;
    Il2CppTypeEnum type;
    uint8_t  num_mods;
    bool     byref;
    bool     pinned;
};

// ------ FieldInfo (stable layout) ---------------------------------------------
struct FieldInfo {
    const char*       name;    // 0x00
    const Il2CppType* type;    // 0x08
    Il2CppClass*      parent;  // 0x10
    int32_t           offset;  // 0x18 — negative for static (use static_fields table)
    uint32_t          token;   // 0x1C
};

// ------ ParameterInfo (stable) ------------------------------------------------
struct ParameterInfo {
    const char*       name;    // 0x00
    const Il2CppType* parameter_type; // 0x08
    const MethodInfo* method;  // 0x10
    uint32_t          token;   // 0x18
    uint16_t          position;// 0x1C
};

// ------ VirtualInvokeData (stable) --------------------------------------------
struct VirtualInvokeData {
    void* methodPointer; // 0x00
    const MethodInfo* method; // 0x08
};

// ------ MethodInfo — version-dispatched offsets -------------------------------
// Use lt::il2cpp::method_pointer(), method_name(), etc. rather than direct access.

// Unity <2022.x (v24–v27):
struct MethodInfo_v24 {
    void*             methodPointer; // 0x00 (PAC-signed on arm64e)
    void*             invoker_method;// 0x08
    const char*       name;          // 0x10
    Il2CppClass*      klass;         // 0x18
    const Il2CppType* return_type;   // 0x20
    const ParameterInfo* parameters; // 0x28
    void*             methodDefinition; // 0x30
    void*             genericContainer;// 0x38
    uint32_t          token;         // 0x40
    uint16_t          flags;         // 0x44
    uint16_t          iflags;        // 0x46
    uint16_t          slot;          // 0x48
    uint8_t           parameters_count; // 0x4A
    bool              is_generic;    // 0x4B
};

// Unity 2022.x (v29):
struct MethodInfo_v29 {
    void*             methodPointer; // 0x00
    void*             virtualMethodPointer; // 0x08
    void*             invoker_method;// 0x10
    const char*       name;          // 0x18
    Il2CppClass*      klass;         // 0x20
    const Il2CppType* return_type;   // 0x28
    const ParameterInfo* parameters; // 0x30
    uint32_t          token;         // 0x38
    uint16_t          flags;         // 0x3C
    uint16_t          iflags;        // 0x3E
    uint16_t          slot;          // 0x40
    uint8_t           parameters_count; // 0x42
    bool              is_generic;    // 0x43
};

// Unity 6 (v31) — target:
struct MethodInfo_v31 {
    void*             methodPointer; // 0x00 (PAC-signed function pointer on arm64e)
    void*             invoker_method;// 0x08
    const char*       name;          // 0x10
    Il2CppClass*      klass;         // 0x18
    const Il2CppType* return_type;   // 0x20
    const ParameterInfo* parameters; // 0x28
    void*             genericContainer; // 0x30
    uint32_t          token;         // 0x38
    uint16_t          flags;         // 0x3C
    uint16_t          iflags;        // 0x3E
    uint16_t          slot;          // 0x40
    uint8_t           parameters_count; // 0x42
    bool              is_generic;    // 0x43
};

// ------ Il2CppClass — partial layout, relevant fields per version -------------
// Offsets for v31 (Unity 6000.x) — confirmed via RE on com.hunt.royale:
struct Il2CppClass_v31 {
    Il2CppClass*   klass;             // 0x00 (metaclass self-ptr)
    void*          monitor;           // 0x08
    Il2CppImage*   image;             // 0x10
    const char*    name;              // 0x18 — class name without namespace
    const char*    namespaze;         // 0x20
    // Il2CppType byval_arg at 0x28 (16 bytes)
    // Il2CppType this_arg  at 0x38 (16 bytes)
    Il2CppClass*   element_class;     // 0x48
    Il2CppClass*   castClass;         // 0x50
    Il2CppClass*   declaringType;     // 0x58
    Il2CppClass*   parent;            // 0x60
    Il2CppGenericClass* generic_class;// 0x68
    uint32_t       typeDefinition;    // 0x70 (TypeDefinitionIndex)
    FieldInfo*     fields;            // 0x78
    void*          events;            // 0x80
    void*          properties;        // 0x88
    const MethodInfo** methods;       // 0x90
    Il2CppClass**  nestedTypes;       // 0x98
    Il2CppClass**  implementedInterfaces; // 0xA0
    void*          interfaceOffsets;  // 0xA8
    void*          static_fields;     // 0xB0
    Il2CppRGCTXData* rgctx_data;     // 0xB8
    uint16_t       field_count;       // 0xC0
    uint16_t       method_count;      // 0xC2
    uint16_t       event_count;       // 0xC4
    uint16_t       property_count;    // 0xC6
    uint16_t       nestedType_count;  // 0xC8
    uint16_t       vtable_count;      // 0xCA
    uint16_t       interfaces_count;  // 0xCC
    uint16_t       interface_offsets_count; // 0xCE
    uint32_t       instance_size;     // 0xD0 — critical for heap scan
    uint32_t       actualSize;        // 0xD4
    uint32_t       typeHierarchyDepth;// 0xD8
    uint32_t       token;             // 0xDC
    uint16_t       flags;             // 0xE0
    uint8_t        initialized;       // 0xE2
    uint8_t        enumtype;          // 0xE3
    uint8_t        is_generic;        // 0xE4
    uint8_t        has_references;    // 0xE5
    uint8_t        init_pending;      // 0xE6
    uint8_t        size_inited;       // 0xE7
    uint8_t        has_finalize;      // 0xE8
    uint8_t        has_cctor;         // 0xE9
    uint8_t        is_blittable;      // 0xEA
    // vtable follows at approx 0x100 (variable count * 16 bytes)
};

// Field offsets by metadata version (for the bridge's version-dispatch table)
struct ClassLayout {
    uint16_t off_name;         // name field offset
    uint16_t off_namespace;    // namespaze field offset
    uint16_t off_parent;       // parent class ptr
    uint16_t off_fields;       // FieldInfo* array
    uint16_t off_methods;      // MethodInfo** array
    uint16_t off_static_fields;// static_fields ptr
    uint16_t off_field_count;  // uint16_t field count
    uint16_t off_method_count;
    uint16_t off_instance_size;// uint32_t
    uint32_t class_struct_size;
};

static constexpr ClassLayout k_class_layout_v31 = {
    0x18, 0x20, 0x60, 0x78, 0x90, 0xB0, 0xC0, 0xC2, 0xD0, 376
};
static constexpr ClassLayout k_class_layout_v29 = {
    0x18, 0x20, 0x60, 0x78, 0x90, 0xAC, 0xC0, 0xC2, 0xCC, 360
};
static constexpr ClassLayout k_class_layout_v27 = {
    0x18, 0x20, 0x58, 0x70, 0x88, 0xA4, 0xB8, 0xBA, 0xC4, 344
};
static constexpr ClassLayout k_class_layout_v24 = {
    0x10, 0x18, 0x50, 0x68, 0x80, 0x9C, 0xAC, 0xAE, 0xB8, 320
};

// ------ Il2CppString ----------------------------------------------------------
// offset 0x00: klass (8 bytes)
// offset 0x08: monitor (8 bytes)
// offset 0x10: int32_t length
// offset 0x14: char16_t chars[]  (UTF-16 LE, NOT null-terminated)
static constexpr uintptr_t IL2CPP_STRING_LENGTH_OFFSET = 0x10;
static constexpr uintptr_t IL2CPP_STRING_CHARS_OFFSET  = 0x14;

// ------ Il2CppArray -----------------------------------------------------------
// offset 0x00: klass (8 bytes)
// offset 0x08: monitor (8 bytes)
// offset 0x10: il2cpp_array_size_t max_length
// offset 0x18: il2cpp_array_size_t bounds_length (for multi-dim, else 0)
// offset 0x20: element data[]
static constexpr uintptr_t IL2CPP_ARRAY_LENGTH_OFFSET = 0x18;
static constexpr uintptr_t IL2CPP_ARRAY_DATA_OFFSET   = 0x20;

using il2cpp_array_size_t = int32_t;
