#pragma once
// language: C++20, file: include/LibTool/Hook.hpp, target: iOS arm64/arm64e
// ARM64 inline trampoline with full instruction relocation (B, BL, ADR, ADRP,
// LDR literal, CBZ, CBNZ, TBZ, TBNZ) + GOT/PLT redirect + vtable patch.

#include <cstdint>
#include <optional>
#include <string>
#include <functional>

namespace lt::hook {

// ------ Hook types ------------------------------------------------------------
enum class HookKind : uint8_t {
    Trampoline,  // from-scratch ARM64 inline trampoline
    GOT,         // GOT/PLT pointer redirect
    VTable,      // vtable slot replacement
};

enum class HookStatus : uint8_t {
    Active,
    Disabled,
    Failed,
};

// ------ Hook record ----------------------------------------------------------
struct HookRecord {
    uint32_t    id;
    uintptr_t   target;          // original function address
    uintptr_t   hook_fn;         // replacement function address
    uintptr_t   trampoline;      // allocated trampoline page (0 if GOT/vtable)
    HookKind    kind;
    HookStatus  status;
    char        label[64];       // human-readable label (for UI display)
    uint8_t     saved_bytes[20]; // original instructions saved before patch
    uint8_t     saved_count;     // number of saved instruction bytes (4..20)
};

// ------ Core hook API --------------------------------------------------------
// Install an inline trampoline hook at target_addr.
// hook_fn will be called instead; original_ptr (if non-null) receives a pointer
// to the trampoline that calls the original function.
[[nodiscard]] std::optional<uint32_t>
    install(uintptr_t target_addr, uintptr_t hook_fn,
            uintptr_t* original_ptr = nullptr,
            const char* label = "hook") noexcept;

// Template helper for typed function pointers.
template<typename FnPtr>
[[nodiscard]] std::optional<uint32_t>
    install(FnPtr target, FnPtr hook, FnPtr* original = nullptr,
            const char* label = "hook") noexcept
{
    uintptr_t orig_out = 0;
    auto id = install(reinterpret_cast<uintptr_t>(target),
                      reinterpret_cast<uintptr_t>(hook),
                      original ? &orig_out : nullptr, label);
    if (original && id) *original = reinterpret_cast<FnPtr>(orig_out);
    return id;
}

// Redirect a GOT/PLT entry.
[[nodiscard]] std::optional<uint32_t>
    install_got(uintptr_t got_slot_addr, uintptr_t hook_fn,
                const char* label = "got_hook") noexcept;

// Replace a vtable slot.
[[nodiscard]] std::optional<uint32_t>
    install_vtable(uintptr_t vtable_slot_addr, uintptr_t hook_fn,
                   const char* label = "vtable_hook") noexcept;

// Enable / disable a hook by ID.
bool enable(uint32_t hook_id) noexcept;
bool disable(uint32_t hook_id) noexcept;
bool remove(uint32_t hook_id) noexcept;

// NOP patch (ARM64 NOP = 0xD503201F) for count instructions.
[[nodiscard]] uint32_t patch_nop(uintptr_t addr, uint32_t count,
                                  const char* label = "nop") noexcept;

// RET patch — write ARM64 RET (0xD65F03C0) at addr.
[[nodiscard]] uint32_t patch_ret(uintptr_t addr,
                                  const char* label = "ret") noexcept;

// Hook record access — for the UI HookManager panel.
[[nodiscard]] const HookRecord* record(uint32_t hook_id) noexcept;

// Iterate all installed hooks. Return false from visitor to stop.
void enumerate(std::function<bool(const HookRecord&)> visitor);

// Total active hook count.
[[nodiscard]] uint32_t count() noexcept;

// ------ ARM64 instruction relocation (exposed for testing) -------------------
// Returns relocated instruction at new_pc. Returns 0xFFFFFFFF if the instruction
// cannot be relocated at the new address (needs far veneer or sequence rewrite).
[[nodiscard]] uint32_t relocate_insn(uint32_t insn,
                                     uintptr_t old_pc, uintptr_t new_pc) noexcept;

} // namespace lt::hook
