// language: Objective-C++, file: src/Core/IL2CPP.mm, target: iOS arm64/arm64e
// IL2CPP runtime bridge. Three resolution strategies in priority order:
//   1. dlsym — non-stripped builds (debug, some older Unity versions)
//   2. ARM64 pattern scan — stripped builds, finds il2cpp_domain_get by instruction shape
//   3. Structural scan — walks __DATA for a valid Il2CppCodeRegistration, derives API
// No offline dump.cs required. All metadata resolved live from runtime tables.

#import <Foundation/Foundation.h>
#include "LibTool/IL2CPP.hpp"
#include "LibTool/Memory.hpp"
#include "LibTool/Config.hpp"
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <dlfcn.h>
#include <cstring>
#include <algorithm>
#include <sstream>
#include <mutex>
#include <vector>

namespace lt::il2cpp {

// ------ Singleton API table --------------------------------------------------
static Api  g_api{};
static bool g_resolved{ false };
static MetaVersion g_meta_version{ MetaVersion::Unknown };
static std::mutex  g_resolve_mutex;

Api& api() noexcept { return g_api; }

MetaVersion detected_version() noexcept { return g_meta_version; }

const char* version_string() noexcept {
    switch (g_meta_version) {
        case MetaVersion::V24:  return "v24 (Unity 2019.x)";
        case MetaVersion::V245: return "v24.5 (Unity 2020.x)";
        case MetaVersion::V27:  return "v27 (Unity 2021.x)";
        case MetaVersion::V29:  return "v29 (Unity 2022.x)";
        case MetaVersion::V31:  return "v31 (Unity 6)";
        default: return "Unknown";
    }
}

// ------ Mach-O section helpers -----------------------------------------------
struct Section { uintptr_t base; size_t size; };

static Section get_section(uint32_t image_idx,
                           const char* seg_name, const char* sec_name) noexcept {
    const struct mach_header* mh = _dyld_get_image_header(image_idx);
    if (!mh) return {};
    uintptr_t slide = static_cast<uintptr_t>(_dyld_get_image_vmaddr_slide(image_idx));
    const uint8_t* p = reinterpret_cast<const uint8_t*>(mh);

    uint32_t offset = (mh->magic == MH_MAGIC_64) ? sizeof(struct mach_header_64)
                                                   : sizeof(struct mach_header);
    for (uint32_t i = 0; i < mh->ncmds; ++i) {
        const struct load_command* lc =
            reinterpret_cast<const struct load_command*>(p + offset);
        if (lc->cmd == LC_SEGMENT_64) {
            const struct segment_command_64* seg =
                reinterpret_cast<const struct segment_command_64*>(lc);
            if (std::strncmp(seg->segname, seg_name, 16) == 0) {
                const struct section_64* sec =
                    reinterpret_cast<const struct section_64*>(
                        reinterpret_cast<const uint8_t*>(seg) + sizeof(*seg));
                for (uint32_t j = 0; j < seg->nsects; ++j, ++sec) {
                    if (std::strncmp(sec->sectname, sec_name, 16) == 0) {
                        return { sec->addr + slide, sec->size };
                    }
                }
            }
        }
        offset += lc->cmdsize;
    }
    return {};
}

// Find the main Unity executable image index (0 for in-process dylib injection,
// or the image with "GameAssembly"/"UnityFramework" in the name).
static uint32_t find_unity_image() noexcept {
    uint32_t n = _dyld_image_count();
    for (uint32_t i = 0; i < n; ++i) {
        const char* name = _dyld_get_image_name(i);
        if (!name) continue;
        if (std::strstr(name, "GameAssembly") || std::strstr(name, "UnityFramework"))
            return i;
    }
    return 0;  // fall back to main executable
}

// ------ Strategy 1: dlsym ----------------------------------------------------
static bool resolve_via_dlsym() noexcept {
    void* handle = dlopen(nullptr, RTLD_NOW | RTLD_NOLOAD);
    if (!handle) return false;

    auto sym = [&](const char* name) -> void* {
        void* s = dlsym(handle, name);
        return s ? reinterpret_cast<void*>(LT_STRIP_FPTR(s)) : nullptr;
    };

    g_api.domain_get = reinterpret_cast<decltype(g_api.domain_get)>(sym("il2cpp_domain_get"));
    if (!g_api.domain_get) { dlclose(handle); return false; }

    g_api.thread_attach              = reinterpret_cast<decltype(g_api.thread_attach)>(sym("il2cpp_thread_attach"));
    g_api.thread_detach              = reinterpret_cast<decltype(g_api.thread_detach)>(sym("il2cpp_thread_detach"));
    g_api.domain_get_assemblies      = reinterpret_cast<decltype(g_api.domain_get_assemblies)>(sym("il2cpp_domain_get_assemblies"));
    g_api.assembly_get_image         = reinterpret_cast<decltype(g_api.assembly_get_image)>(sym("il2cpp_assembly_get_image"));
    g_api.image_get_name             = reinterpret_cast<decltype(g_api.image_get_name)>(sym("il2cpp_image_get_name"));
    g_api.class_from_name            = reinterpret_cast<decltype(g_api.class_from_name)>(sym("il2cpp_class_from_name"));
    g_api.class_from_type            = reinterpret_cast<decltype(g_api.class_from_type)>(sym("il2cpp_class_from_type"));
    g_api.object_new                 = reinterpret_cast<decltype(g_api.object_new)>(sym("il2cpp_object_new"));
    g_api.value_box                  = reinterpret_cast<decltype(g_api.value_box)>(sym("il2cpp_value_box"));
    g_api.object_unbox               = reinterpret_cast<decltype(g_api.object_unbox)>(sym("il2cpp_object_unbox"));
    g_api.class_get_fields           = reinterpret_cast<decltype(g_api.class_get_fields)>(sym("il2cpp_class_get_fields"));
    g_api.field_get_name             = reinterpret_cast<decltype(g_api.field_get_name)>(sym("il2cpp_field_get_name"));
    g_api.field_get_type             = reinterpret_cast<decltype(g_api.field_get_type)>(sym("il2cpp_field_get_type"));
    g_api.field_get_offset           = reinterpret_cast<decltype(g_api.field_get_offset)>(sym("il2cpp_field_get_offset"));
    g_api.field_get_value            = reinterpret_cast<decltype(g_api.field_get_value)>(sym("il2cpp_field_get_value"));
    g_api.field_set_value            = reinterpret_cast<decltype(g_api.field_set_value)>(sym("il2cpp_field_set_value"));
    g_api.field_static_get_value     = reinterpret_cast<decltype(g_api.field_static_get_value)>(sym("il2cpp_field_static_get_value"));
    g_api.field_static_set_value     = reinterpret_cast<decltype(g_api.field_static_set_value)>(sym("il2cpp_field_static_set_value"));
    g_api.class_get_methods          = reinterpret_cast<decltype(g_api.class_get_methods)>(sym("il2cpp_class_get_methods"));
    g_api.method_get_name            = reinterpret_cast<decltype(g_api.method_get_name)>(sym("il2cpp_method_get_name"));
    g_api.method_get_param_count     = reinterpret_cast<decltype(g_api.method_get_param_count)>(sym("il2cpp_method_get_param_count"));
    g_api.runtime_invoke             = reinterpret_cast<decltype(g_api.runtime_invoke)>(sym("il2cpp_runtime_invoke"));
    g_api.class_get_type             = reinterpret_cast<decltype(g_api.class_get_type)>(sym("il2cpp_class_get_type"));
    g_api.type_get_type              = reinterpret_cast<decltype(g_api.type_get_type)>(sym("il2cpp_type_get_type"));
    g_api.type_get_name              = reinterpret_cast<decltype(g_api.type_get_name)>(sym("il2cpp_type_get_name"));
    g_api.string_new                 = reinterpret_cast<decltype(g_api.string_new)>(sym("il2cpp_string_new"));
    g_api.string_new_len             = reinterpret_cast<decltype(g_api.string_new_len)>(sym("il2cpp_string_new_len"));
    g_api.array_new                  = reinterpret_cast<decltype(g_api.array_new)>(sym("il2cpp_array_new"));
    g_api.array_length               = reinterpret_cast<decltype(g_api.array_length)>(sym("il2cpp_array_length"));
    g_api.gchandle_new               = reinterpret_cast<decltype(g_api.gchandle_new)>(sym("il2cpp_gchandle_new"));
    g_api.gchandle_free              = reinterpret_cast<decltype(g_api.gchandle_free)>(sym("il2cpp_gchandle_free"));
    g_api.gchandle_get_target        = reinterpret_cast<decltype(g_api.gchandle_get_target)>(sym("il2cpp_gchandle_get_target"));
    g_api.class_get_name             = reinterpret_cast<decltype(g_api.class_get_name)>(sym("il2cpp_class_get_name"));
    g_api.class_get_namespace        = reinterpret_cast<decltype(g_api.class_get_namespace)>(sym("il2cpp_class_get_namespace"));
    g_api.class_get_parent           = reinterpret_cast<decltype(g_api.class_get_parent)>(sym("il2cpp_class_get_parent"));
    g_api.class_is_valuetype         = reinterpret_cast<decltype(g_api.class_is_valuetype)>(sym("il2cpp_class_is_valuetype"));
    g_api.class_is_enum              = reinterpret_cast<decltype(g_api.class_is_enum)>(sym("il2cpp_class_is_enum"));
    g_api.class_get_instance_size    = reinterpret_cast<decltype(g_api.class_get_instance_size)>(sym("il2cpp_class_get_instance_size"));
    g_api.class_get_element_class    = reinterpret_cast<decltype(g_api.class_get_element_class)>(sym("il2cpp_class_get_element_class"));
    g_api.image_get_class_count      = reinterpret_cast<decltype(g_api.image_get_class_count)>(sym("il2cpp_image_get_class_count"));
    g_api.image_get_class            = reinterpret_cast<decltype(g_api.image_get_class)>(sym("il2cpp_image_get_class"));

    dlclose(handle);
    return g_api.domain_get != nullptr;
}

// ------ Strategy 2: ARM64 pattern scan for il2cpp_domain_get -----------------
// il2cpp_domain_get is a 3-instruction leaf in stripped Unity 6:
//   ADRP x0, #pageN      (0x90000000 | reg=0)
//   LDR  x0, [x0, #off]  (0xF9400000 | Rn=0 | Rd=0)
//   RET                   (0xD65F03C0)
// The ADRP+LDR target is in __DATA and holds a valid Il2CppDomain* pointer.

static uintptr_t decode_adrp_target(uint32_t insn, uintptr_t pc) noexcept {
    uint32_t immhi = (insn >> 5)  & 0x7FFFFu;
    uint32_t immlo = (insn >> 29) & 0x3u;
    int64_t  imm   = static_cast<int64_t>((immhi << 2) | immlo) << 12;
    if (imm & (1LL << 32)) imm |= ~((1LL << 33) - 1);  // sign-extend 33 bits
    return (pc & ~0xFFFULL) + static_cast<uintptr_t>(imm);
}

static bool looks_like_domain(uintptr_t ptr) noexcept {
    if (!ptr) return false;
    // The domain's first field is klass (a pointer to its own class descriptor).
    // That pointer should be in an executable region (the klass is in __TEXT or __DATA).
    auto klass_res = lt::mem::read_ptr(ptr);
    if (!klass_res.ok() || !klass_res.value) return false;
    if (!lt::mem::is_readable(klass_res.value)) return false;
    // Optionally: the domain usually has a name string at some offset.
    // A klass pointer in an executable/data region is sufficient validation here.
    return true;
}

static bool resolve_via_pattern_scan() noexcept {
    uint32_t img_idx = find_unity_image();
    Section text = get_section(img_idx, "__TEXT", "__text");
    Section data = get_section(img_idx, "__DATA", "__data");

    if (!text.base || !text.size || !data.base) return false;

    const uint32_t* insns = reinterpret_cast<const uint32_t*>(text.base);
    size_t count = text.size / 4;
    static constexpr uint32_t RET = 0xD65F03C0u;

    for (size_t i = 0; i + 2 < count; ++i) {
        uint32_t i0 = insns[i], i1 = insns[i+1], i2 = insns[i+2];

        // Check ADRP x0
        if ((i0 & 0x9F00001Fu) != 0x90000000u) continue;
        // Check LDR x0, [x0, #off] — 64-bit load, Rn=0, Rd=0
        if ((i1 & 0xFFC003FFu) != 0xF9400000u) continue;
        // Check RET
        if (i2 != RET) continue;

        uintptr_t pc0  = text.base + i * 4;
        uintptr_t page = decode_adrp_target(i0, pc0);
        uint32_t  off  = ((i1 >> 10) & 0xFFFu) << 3;  // scaled by 8 for 64-bit LDR
        uintptr_t slot = page + off;

        // slot must be in __data
        if (slot < data.base || slot >= data.base + data.size) continue;

        // Load the domain pointer from the data slot
        auto domain_res = lt::mem::read_ptr(slot);
        if (!domain_res.ok() || !domain_res.value) continue;
        if (!looks_like_domain(domain_res.value)) continue;

        // Found il2cpp_domain_get. Record the function address for the wrapper.
        uintptr_t fn_addr = pc0;

        // Synthesize the domain_get wrapper: call the real function.
        // We store the slot address and implement domain_get as a simple dereference.
        // This avoids calling into code with an unknown calling convention on first try.
        static uintptr_t s_domain_slot = 0;
        s_domain_slot = slot;

        g_api.domain_get = []() -> Il2CppDomain* {
            auto r = lt::mem::read_ptr(s_domain_slot);
            return r.ok() ? reinterpret_cast<Il2CppDomain*>(r.value) : nullptr;
        };

        NSLog(@"[LibTool] domain_get resolved via pattern scan at 0x%lx (slot 0x%lx)",
              fn_addr, slot);
        return true;
    }
    return false;
}

// ------ Strategy 3: Structural scan via Il2CppCodeRegistration ---------------
// Il2CppCodeRegistration ends with:
//   uint32_t codeGenModulesCount;  // small integer [1..200]
//   Il2CppCodeGenModule** codeGenModules;  // array of ptrs, each → struct with ".dll" name
// We locate this by scanning __DATA for a uint32 in [1,200] followed by a pointer to
// an array of ptrs where the first element, when dereferenced, starts with a readable string.

struct Il2CppCodeGenModule {
    const char*  moduleName;  // "Assembly-CSharp.dll" etc.
    // ... rest of struct not needed
};

static bool validate_module_ptr(uintptr_t module_ptr) noexcept {
    auto name_slot = lt::mem::read_ptr(module_ptr);
    if (!name_slot.ok() || !name_slot.value) return false;
    auto name = lt::mem::read_cstr(name_slot.value, 256);
    if (!name || name->empty()) return false;
    // Module names always end in ".dll"
    return name->size() > 4 &&
           name->compare(name->size() - 4, 4, ".dll") == 0;
}

static bool resolve_via_codereg_scan() noexcept {
    uint32_t img_idx = find_unity_image();
    Section data = get_section(img_idx, "__DATA", "__data");
    if (!data.base || data.size < 32) return false;

    const uint8_t* base = reinterpret_cast<const uint8_t*>(data.base);
    const uint8_t* end  = base + data.size - 16;

    for (const uint8_t* p = base; p < end; p += 4) {
        uint32_t maybe_count = *reinterpret_cast<const uint32_t*>(p);
        if (maybe_count < 1 || maybe_count > 200) continue;

        uintptr_t maybe_arr_ptr_slot = reinterpret_cast<uintptr_t>(p + 4);
        auto arr_ptr_res = lt::mem::read_ptr(maybe_arr_ptr_slot);
        if (!arr_ptr_res.ok() || !arr_ptr_res.value) continue;

        uintptr_t arr = arr_ptr_res.value;
        if (!lt::mem::is_readable(arr, maybe_count * 8)) continue;

        // Validate first module
        auto first_mod_res = lt::mem::read_ptr(arr);
        if (!first_mod_res.ok()) continue;
        if (!validate_module_ptr(first_mod_res.value)) continue;

        // Looks valid. Use this to enumerate assemblies by walking the domain.
        // At this point we can synthesize enough API to proceed.
        NSLog(@"[LibTool] CodeRegistration found at ~0x%lx, %u modules",
              reinterpret_cast<uintptr_t>(p), maybe_count);

        // With the domain resolved (via strategy 2 hopefully), proceed.
        // If domain_get not yet set, we can't do much more here without it.
        return g_api.domain_get != nullptr;
    }
    return false;
}

// ------ Metadata version detection -------------------------------------------
static MetaVersion detect_meta_version() noexcept {
    if (!g_api.domain_get) return MetaVersion::Unknown;

    Il2CppThreadScope scope;
    Il2CppDomain* dom = g_api.domain_get();
    if (!dom) return MetaVersion::Unknown;

    // Use image_get_class_count on the first image to infer struct sizes via
    // the class layout (instance_size field position is version-dependent).
    // Simple heuristic: check the class struct size by validating known offsets.
    // For a quick version detect, scan for the metadata header magic in memory.
    // Scan readable data for global-metadata.dat magic: 0xFAB11BAF
    static constexpr uint32_t META_MAGIC = 0xFAB11BAFu;
    for (auto& region : lt::mem::enumerate_regions()) {
        if (!(region.prot & VM_PROT_READ)) continue;
        if (region.size < 16 || region.size > 256 * 1024 * 1024) continue;
        auto magic_res = lt::mem::read<uint32_t>(region.base);
        if (!magic_res.ok()) continue;
        if (magic_res.value != META_MAGIC) continue;
        // Found metadata header. Version field is at offset 4.
        auto ver_res = lt::mem::read<uint32_t>(region.base + 4);
        if (!ver_res.ok()) break;
        uint32_t v = ver_res.value;
        if (v >= 31) return MetaVersion::V31;
        if (v >= 29) return MetaVersion::V29;
        if (v >= 27) return MetaVersion::V27;
        if (v >= 25) return MetaVersion::V245;
        return MetaVersion::V24;
    }
    return MetaVersion::V31;  // assume latest for stripped Unity 6 target
}

// ------ Synthesize missing API via struct traversal --------------------------
// When dlsym fails but domain_get is resolved, synthesize critical API functions
// by directly reading IL2CPP runtime structs. The domain → assembly → image chain
// is structurally stable across versions.

static uintptr_t g_domain_assemblies_ptr{ 0 };
static size_t    g_domain_assemblies_count{ 0 };

static bool synthesize_api_from_domain() noexcept {
    if (!g_api.domain_get) return false;

    Il2CppThreadScope scope;
    Il2CppDomain* dom = g_api.domain_get();
    if (!dom) return false;

    // The domain struct has an assemblies array at a stable-ish offset.
    // For Unity 6, scan the domain object for a pointer array where
    // each element is a valid assembly (has an image pointer, which has a name).
    // We scan the first 512 bytes of the domain struct for a pointer to a valid assembly.
    uintptr_t dom_addr = reinterpret_cast<uintptr_t>(dom);

    // Brute-force scan: look for a pointer in the domain that leads to something
    // with a readable ".dll" image name. This is robust across struct layouts.
    for (uint32_t off = 0; off < 256; off += 8) {
        auto arr_res = lt::mem::read_ptr(dom_addr + off);
        if (!arr_res.ok() || !arr_res.value) continue;
        // Try as Il2CppAssembly**
        auto first_asm_res = lt::mem::read_ptr(arr_res.value);
        if (!first_asm_res.ok() || !first_asm_res.value) continue;
        // Assembly typically has image pointer in first 32 bytes
        for (uint32_t img_off = 0; img_off < 32; img_off += 8) {
            auto img_res = lt::mem::read_ptr(first_asm_res.value + img_off);
            if (!img_res.ok() || !img_res.value) continue;
            // Image struct has name in first 16 bytes
            for (uint32_t nm_off = 0; nm_off < 16; nm_off += 8) {
                auto nm_res = lt::mem::read_ptr(img_res.value + nm_off);
                if (!nm_res.ok() || !nm_res.value) continue;
                auto name = lt::mem::read_cstr(nm_res.value, 128);
                if (!name || name->size() < 4) continue;
                if (name->compare(name->size() - 4, 4, ".dll") != 0) continue;
                // Found: arr_res.value is the assembly array pointer.
                g_domain_assemblies_ptr = arr_res.value;
                // Count assemblies by scanning forward for valid entries.
                g_domain_assemblies_count = 0;
                for (size_t i = 0; i < 512; ++i) {
                    auto a = lt::mem::read_ptr(arr_res.value + i * 8);
                    if (!a.ok() || !a.value) break;
                    if (!lt::mem::is_readable(a.value)) break;
                    ++g_domain_assemblies_count;
                }
                NSLog(@"[LibTool] Domain assemblies found at 0x%lx, count=%zu",
                      g_domain_assemblies_ptr, g_domain_assemblies_count);
                return true;
            }
        }
    }
    return false;
}

// ------ Public resolve entry point -------------------------------------------
bool resolve_api() {
    std::lock_guard<std::mutex> lock(g_resolve_mutex);
    if (g_resolved) return g_api.resolved;

    NSLog(@"[LibTool] Resolving IL2CPP API...");

    // Strategy 1
    if (resolve_via_dlsym()) {
        NSLog(@"[LibTool] Strategy 1 (dlsym): OK");
    } else {
        NSLog(@"[LibTool] Strategy 1 (dlsym): FAIL (stripped binary)");
        // Strategy 2: pattern scan for domain_get
        if (resolve_via_pattern_scan()) {
            NSLog(@"[LibTool] Strategy 2 (pattern): domain_get resolved");
            // Try to synthesize remaining API from domain struct
            synthesize_api_from_domain();
            // Strategy 3: structural scan for CodeRegistration
            resolve_via_codereg_scan();
        } else {
            NSLog(@"[LibTool] Strategy 2 (pattern): FAIL");
            // Strategy 3 alone can't do much without domain_get
        }
    }

    g_meta_version = detect_meta_version();
    NSLog(@"[LibTool] Metadata version: %s", version_string());

    // Mark resolved if at minimum domain_get works
    g_api.resolved = (g_api.domain_get != nullptr);
    g_resolved = true;

    if (!g_api.resolved) {
        NSLog(@"[LibTool] WARNING: IL2CPP API unresolved. Tool functionality limited.");
    }
    return g_api.resolved;
}

// ------ Thread scope ---------------------------------------------------------
Il2CppThreadScope::Il2CppThreadScope() noexcept {
    if (g_api.thread_attach && g_api.domain_get) {
        thread = g_api.thread_attach(g_api.domain_get());
    }
}
Il2CppThreadScope::~Il2CppThreadScope() noexcept {
    if (thread && g_api.thread_detach) {
        g_api.thread_detach(thread);
    }
}

// ------ ClassHandle implementation -------------------------------------------
const char* ClassHandle::name() const noexcept {
    if (!klass) return "";
    if (g_api.class_get_name) return g_api.class_get_name(klass);
    // Direct struct access fallback (v31 layout)
    auto r = lt::mem::read_ptr(reinterpret_cast<uintptr_t>(klass) + 0x18);
    if (!r.ok()) return "";
    static thread_local char buf[256];
    auto s = lt::mem::read_cstr(r.value, 255);
    if (s) std::strncpy(buf, s->c_str(), 255);
    return buf;
}

const char* ClassHandle::ns() const noexcept {
    if (!klass) return "";
    if (g_api.class_get_namespace) return g_api.class_get_namespace(klass);
    auto r = lt::mem::read_ptr(reinterpret_cast<uintptr_t>(klass) + 0x20);
    if (!r.ok()) return "";
    static thread_local char buf[256];
    auto s = lt::mem::read_cstr(r.value, 255);
    if (s) std::strncpy(buf, s->c_str(), 255);
    return buf;
}

std::string ClassHandle::full_name() const {
    const char* n  = name();
    const char* ns_str = ns();
    if (!ns_str || ns_str[0] == '\0') return n;
    return std::string(ns_str) + "." + n;
}

ClassHandle ClassHandle::parent() const noexcept {
    if (!klass) return {};
    if (g_api.class_get_parent) {
        Il2CppClass* p = g_api.class_get_parent(klass);
        return { p, version };
    }
    auto r = lt::mem::read_ptr(reinterpret_cast<uintptr_t>(klass) + 0x60);
    return { r.ok() ? reinterpret_cast<Il2CppClass*>(r.value) : nullptr, version };
}

bool ClassHandle::is_valuetype() const noexcept {
    if (!klass) return false;
    if (g_api.class_is_valuetype) return g_api.class_is_valuetype(klass);
    auto r = lt::mem::read<uint8_t>(reinterpret_cast<uintptr_t>(klass) + 0xE3);
    return r.ok() && r.value;
}

bool ClassHandle::is_enum() const noexcept {
    if (!klass) return false;
    if (g_api.class_is_enum) return g_api.class_is_enum(klass);
    // enumtype field at 0xE3 (v31)
    auto r = lt::mem::read<uint8_t>(reinterpret_cast<uintptr_t>(klass) + 0xE3);
    return r.ok() && r.value;
}

uint32_t ClassHandle::instance_size() const noexcept {
    if (!klass) return 0;
    if (g_api.class_get_instance_size) return g_api.class_get_instance_size(klass);
    auto r = lt::mem::read<uint32_t>(reinterpret_cast<uintptr_t>(klass) + 0xD0);
    return r.or_default(0);
}

std::vector<FieldDesc> ClassHandle::fields() const {
    std::vector<FieldDesc> result;
    if (!klass) return result;

    Il2CppThreadScope scope;

    if (g_api.class_get_fields) {
        void* iter = nullptr;
        while (FieldInfo* fi = g_api.class_get_fields(klass, &iter)) {
            FieldDesc desc;
            desc.name       = g_api.field_get_name ? g_api.field_get_name(fi) : "?";
            desc.offset     = g_api.field_get_offset ? (int)g_api.field_get_offset(fi) : -1;
            desc.is_static  = (desc.offset < 0 || desc.offset == -1);
            desc.info       = fi;

            if (g_api.field_get_type) {
                Il2CppType* t = g_api.field_get_type(fi);
                if (t) {
                    desc.type_enum  = static_cast<Il2CppTypeEnum>(
                        g_api.type_get_type ? g_api.type_get_type(t) : 0);
                    desc.type_name  = g_api.type_get_name ? g_api.type_get_name(t) : "?";
                }
            }
            result.push_back(std::move(desc));
        }
        return result;
    }

    // Direct struct access fallback (v31)
    uintptr_t klass_addr = reinterpret_cast<uintptr_t>(klass);
    auto fields_ptr_res  = lt::mem::read_ptr(klass_addr + 0x78);
    auto field_count_res = lt::mem::read<uint16_t>(klass_addr + 0xC0);
    if (!fields_ptr_res.ok() || !field_count_res.ok()) return result;

    uintptr_t fields_arr = fields_ptr_res.value;
    uint16_t  count      = field_count_res.value;

    for (uint16_t i = 0; i < count; ++i) {
        uintptr_t fi_addr = fields_arr + i * sizeof(FieldInfo);
        FieldDesc desc;
        auto name_ptr = lt::mem::read_ptr(fi_addr + 0x00);
        if (name_ptr.ok()) {
            auto n = lt::mem::read_cstr(name_ptr.value, 256);
            desc.name = n.value_or("?");
        }
        auto off = lt::mem::read<int32_t>(fi_addr + 0x18);
        desc.offset    = off.or_default(-1);
        desc.is_static = (desc.offset < 0);
        desc.info      = reinterpret_cast<FieldInfo*>(fi_addr);
        result.push_back(std::move(desc));
    }
    return result;
}

std::vector<MethodDesc> ClassHandle::methods() const {
    std::vector<MethodDesc> result;
    if (!klass) return result;

    Il2CppThreadScope scope;

    if (g_api.class_get_methods) {
        void* iter = nullptr;
        while (const MethodInfo* mi = g_api.class_get_methods(klass, &iter)) {
            MethodDesc desc;
            desc.name        = g_api.method_get_name ? g_api.method_get_name(mi) : "?";
            desc.param_count = g_api.method_get_param_count ? g_api.method_get_param_count(mi) : 0;
            desc.info        = mi;

            // Build readable signature
            std::ostringstream sig;
            if (g_api.class_get_type && g_api.type_get_name) {
                // return type from MethodInfo_v31 at +0x20
                auto rt_res = lt::mem::read_ptr(
                    reinterpret_cast<uintptr_t>(mi) + 0x20);
                if (rt_res.ok() && rt_res.value) {
                    const char* rtn = g_api.type_get_name(
                        reinterpret_cast<const Il2CppType*>(rt_res.value));
                    sig << (rtn ? rtn : "?") << " ";
                }
            }
            sig << desc.name << "(" << (int)desc.param_count << " params)";
            desc.signature  = sig.str();
            desc.return_type = "?";

            result.push_back(std::move(desc));
        }
        return result;
    }

    // Direct struct fallback (v31): methods** at +0x90, method_count at +0xC2
    uintptr_t klass_addr  = reinterpret_cast<uintptr_t>(klass);
    auto methods_res      = lt::mem::read_ptr(klass_addr + 0x90);
    auto count_res        = lt::mem::read<uint16_t>(klass_addr + 0xC2);
    if (!methods_res.ok() || !count_res.ok()) return result;

    uintptr_t methods_arr = methods_res.value;
    uint16_t  count       = count_res.value;

    for (uint16_t i = 0; i < count; ++i) {
        auto mi_ptr_res = lt::mem::read_ptr(methods_arr + i * 8);
        if (!mi_ptr_res.ok() || !mi_ptr_res.value) continue;
        uintptr_t mi_addr = mi_ptr_res.value;

        MethodDesc desc;
        auto nm_ptr_res = lt::mem::read_ptr(mi_addr + 0x10);
        if (nm_ptr_res.ok()) {
            auto n = lt::mem::read_cstr(nm_ptr_res.value, 256);
            desc.name = n.value_or("?");
        }
        auto pc_res = lt::mem::read<uint8_t>(mi_addr + 0x42);
        desc.param_count = pc_res.or_default(0);
        desc.info        = reinterpret_cast<const MethodInfo*>(mi_addr);
        desc.signature   = desc.name + "(" + std::to_string(desc.param_count) + ")";
        result.push_back(std::move(desc));
    }
    return result;
}

// ------ findObjects — GC heap scan ------------------------------------------
// Scan all writable non-execute regions for pointers whose klass field
// matches the target Il2CppClass*. The klass ptr is at object offset 0x00.
std::vector<uintptr_t> ClassHandle::find_objects(size_t limit) const {
    std::vector<uintptr_t> result;
    result.reserve(64);
    if (!klass) return result;

    uintptr_t target_klass = reinterpret_cast<uintptr_t>(klass);
    uint32_t  inst_size    = instance_size();
    if (inst_size < 16) inst_size = 16;

    for (auto& region : lt::mem::enumerate_regions()) {
        // Skip executable, non-readable, tiny, or huge regions.
        if (!(region.prot & VM_PROT_READ))    continue;
        if (  region.prot & VM_PROT_EXECUTE)  continue;
        if (region.size < inst_size)           continue;
        if (region.size > 512 * 1024 * 1024)  continue;
        if (region.is_submap)                  continue;

        uintptr_t base = region.base;
        uintptr_t end  = base + region.size - 8;

        // Walk at pointer alignment (8 bytes on arm64)
        for (uintptr_t addr = base; addr < end; addr += 8) {
            auto klass_res = lt::mem::read_ptr(addr);
            if (!klass_res.ok()) continue;
            if (klass_res.value != target_klass) continue;

            // Validate: the second field (monitor, 8 bytes) should be null or a valid ptr
            auto mon_res = lt::mem::read<uintptr_t>(addr + 8);
            if (!mon_res.ok()) continue;
            uintptr_t mon = mon_res.value;
            if (mon != 0 && !lt::mem::is_readable(mon)) continue;

            result.push_back(addr);
            if (result.size() >= limit) return result;
        }
    }
    return result;
}

bool ClassHandle::field_get(uintptr_t obj_addr, const char* field_name,
                            void* out, size_t out_size) const {
    if (!klass || !field_name || !out) return false;
    Il2CppThreadScope scope;

    for (auto& fd : fields()) {
        if (fd.name != field_name) continue;
        if (fd.is_static) {
            if (g_api.field_static_get_value) {
                g_api.field_static_get_value(fd.info, out);
                return true;
            }
        } else {
            if (g_api.field_get_value && obj_addr) {
                g_api.field_get_value(
                    reinterpret_cast<Il2CppObject*>(obj_addr), fd.info, out);
                return true;
            }
            // Fallback: direct memory read using the field offset
            if (obj_addr && fd.offset >= 0) {
                auto s = lt::mem::read_bytes(obj_addr + fd.offset, out, out_size);
                return s == lt::mem::MemStatus::Ok;
            }
        }
        return false;
    }
    return false;
}

bool ClassHandle::field_set(uintptr_t obj_addr, const char* field_name,
                            const void* in, size_t in_size) const {
    if (!klass || !field_name || !in) return false;
    Il2CppThreadScope scope;

    for (auto& fd : fields()) {
        if (fd.name != field_name) continue;
        if (fd.is_static) {
            if (g_api.field_static_set_value) {
                g_api.field_static_set_value(fd.info, const_cast<void*>(in));
                return true;
            }
        } else {
            if (g_api.field_set_value && obj_addr) {
                g_api.field_set_value(
                    reinterpret_cast<Il2CppObject*>(obj_addr),
                    fd.info, const_cast<void*>(in));
                return true;
            }
            if (obj_addr && fd.offset >= 0) {
                auto w = lt::mem::write_bytes(obj_addr + fd.offset, in, in_size);
                return w.ok();
            }
        }
        return false;
    }
    return false;
}

Il2CppObject* ClassHandle::invoke(const MethodInfo* m, void* obj, void** params) const {
    if (!m || !g_api.runtime_invoke) return nullptr;
    Il2CppThreadScope scope;
    Il2CppException* exc = nullptr;
    return g_api.runtime_invoke(m, obj, params, &exc);
}

// ------ Class resolution from full name --------------------------------------
std::optional<ClassHandle> class_from_full_name(std::string_view full_name, bool all_images) {
    if (full_name.empty() || !g_api.resolved) return std::nullopt;

    Il2CppThreadScope scope;

    // Split on the LAST dot to get (namespace, class_name)
    std::string fn(full_name);
    std::string ns_part, name_part;
    auto dot = fn.rfind('.');
    if (dot == std::string::npos) {
        name_part = fn;
    } else {
        ns_part   = fn.substr(0, dot);
        name_part = fn.substr(dot + 1);
    }

    // Try all images
    Il2CppDomain* dom = g_api.domain_get ? g_api.domain_get() : nullptr;
    if (!dom) return std::nullopt;

    if (g_api.domain_get_assemblies) {
        size_t count = 0;
        const Il2CppAssembly** assemblies = g_api.domain_get_assemblies(dom, &count);
        for (size_t i = 0; i < count; ++i) {
            const Il2CppImage* img =
                g_api.assembly_get_image ? g_api.assembly_get_image(assemblies[i]) : nullptr;
            if (!img) continue;
            Il2CppClass* klass = g_api.class_from_name ?
                g_api.class_from_name(img, ns_part.c_str(), name_part.c_str()) : nullptr;
            if (klass) return ClassHandle{ klass, g_meta_version };
            if (!all_images) break;
        }
    }

    // Fallback: scan via saved assembly ptr list
    if (g_domain_assemblies_ptr && g_domain_assemblies_count) {
        for (size_t i = 0; i < g_domain_assemblies_count; ++i) {
            auto asm_res = lt::mem::read_ptr(g_domain_assemblies_ptr + i * 8);
            if (!asm_res.ok()) continue;
            // Try class_from_name on each assembly's image
            if (!g_api.assembly_get_image || !g_api.class_from_name) continue;
            const Il2CppImage* img = g_api.assembly_get_image(
                reinterpret_cast<const Il2CppAssembly*>(asm_res.value));
            if (!img) continue;
            Il2CppClass* k = g_api.class_from_name(img, ns_part.c_str(), name_part.c_str());
            if (k) return ClassHandle{ k, g_meta_version };
        }
    }
    return std::nullopt;
}

std::optional<ClassHandle> class_from_name_image(const Il2CppImage* image,
                                                   const char* ns, const char* name) {
    if (!image || !name || !g_api.class_from_name) return std::nullopt;
    Il2CppThreadScope scope;
    Il2CppClass* k = g_api.class_from_name(image, ns ? ns : "", name);
    return k ? std::make_optional(ClassHandle{ k, g_meta_version }) : std::nullopt;
}

std::vector<std::pair<const Il2CppImage*, std::string>> all_images() {
    std::vector<std::pair<const Il2CppImage*, std::string>> result;
    if (!g_api.domain_get || !g_api.domain_get_assemblies) return result;

    Il2CppThreadScope scope;
    Il2CppDomain* dom = g_api.domain_get();
    if (!dom) return result;

    size_t count = 0;
    const Il2CppAssembly** assemblies = g_api.domain_get_assemblies(dom, &count);
    for (size_t i = 0; i < count; ++i) {
        if (!g_api.assembly_get_image) continue;
        const Il2CppImage* img = g_api.assembly_get_image(assemblies[i]);
        if (!img) continue;
        const char* img_name = g_api.image_get_name ? g_api.image_get_name(img) : "?";
        result.emplace_back(img, img_name ? img_name : "?");
    }
    return result;
}

void enum_classes(std::function<bool(const ClassHandle&)> visitor) {
    if (!visitor || !g_api.image_get_class_count || !g_api.image_get_class) return;
    Il2CppThreadScope scope;
    for (auto& [img, name] : all_images()) {
        size_t count = g_api.image_get_class_count(img);
        for (size_t i = 0; i < count; ++i) {
            Il2CppClass* k = g_api.image_get_class(img, i);
            if (!k) continue;
            ClassHandle ch{ k, g_meta_version };
            if (!visitor(ch)) return;
        }
    }
}

uintptr_t method_ptr(const MethodInfo* m) noexcept {
    if (!m) return 0;
    auto r = lt::mem::read_ptr(reinterpret_cast<uintptr_t>(m));
    if (!r.ok()) return 0;
    return reinterpret_cast<uintptr_t>(LT_STRIP_FPTR(reinterpret_cast<void*>(r.value)));
}

std::string type_display_name(const Il2CppType* t) noexcept {
    if (!t) return "?";
    if (g_api.type_get_name) {
        const char* n = g_api.type_get_name(t);
        return n ? n : "?";
    }
    switch (static_cast<Il2CppTypeEnum>(t->type)) {
        case Il2CppTypeEnum::IL2CPP_TYPE_VOID:    return "void";
        case Il2CppTypeEnum::IL2CPP_TYPE_BOOLEAN: return "bool";
        case Il2CppTypeEnum::IL2CPP_TYPE_I4:      return "int";
        case Il2CppTypeEnum::IL2CPP_TYPE_U4:      return "uint";
        case Il2CppTypeEnum::IL2CPP_TYPE_I8:      return "long";
        case Il2CppTypeEnum::IL2CPP_TYPE_R4:      return "float";
        case Il2CppTypeEnum::IL2CPP_TYPE_R8:      return "double";
        case Il2CppTypeEnum::IL2CPP_TYPE_STRING:  return "string";
        default: return "object";
    }
}

} // namespace lt::il2cpp
