#pragma once
// language: C++20, file: include/LibTool/Memory.hpp, target: iOS arm64/arm64e
// Memory engine — fault-contained read/write, PAC stripping, region enumeration.
// Axiom: every dereference is guarded. SIGSEGV in a game thread surfaces as
// an instant crash with zero context. Single-digit nanosecond guard overhead.

#include <cstdint>
#include <cstddef>
#include <span>
#include <optional>
#include <string>
#include <vector>
#include <mach/mach.h>

// ------ PAC stripping — arm64e Pointer Authentication (A12+) -----------------
#if __has_feature(ptrauth_intrinsics)
#  include <ptrauth.h>
#  define LT_STRIP_PTR(p)  ptrauth_strip((p), ptrauth_key_process_independent_data)
#  define LT_STRIP_FPTR(p) ptrauth_strip((p), ptrauth_key_function_pointer)
#else
#  define LT_STRIP_PTR(p)  (p)
#  define LT_STRIP_FPTR(p) (p)
#endif

namespace lt::mem {

// Install guarded-read signal handlers after the host runtime has registered its own.
void install_fault_handlers() noexcept;

// Il2CppString layout: object header, UTF-16 length, then character data.
inline constexpr size_t IL2CPP_STRING_LENGTH_OFFSET = 0x10;
inline constexpr size_t IL2CPP_STRING_CHARS_OFFSET = 0x14;

// ------ Result types ----------------------------------------------------------
enum class MemStatus : uint8_t {
    Ok,
    Fault,        // SIGSEGV / SIGBUS caught
    Unmapped,     // address not in any mapped region
    Misaligned,   // address not aligned to alignof(T)
    ProtectFail,  // vm_protect returned non-KERN_SUCCESS
    NullAddress,
    TooLarge,     // requested size exceeds safe limit
};

template<typename T>
struct ReadResult {
    MemStatus status{ MemStatus::NullAddress };
    T value{};
    [[nodiscard]] bool ok() const noexcept { return status == MemStatus::Ok; }
    [[nodiscard]] T    or_default(T fallback = {}) const noexcept {
        return ok() ? value : fallback;
    }
};

struct WriteResult {
    MemStatus status{ MemStatus::NullAddress };
    [[nodiscard]] bool ok() const noexcept { return status == MemStatus::Ok; }
};

// ------ Core read primitives --------------------------------------------------
// Typed read — strips PAC on arm64e, returns Fault on bad address.
template<typename T>
[[nodiscard]] ReadResult<T> read(uintptr_t addr) noexcept;

// Raw byte read into caller-owned buffer.
[[nodiscard]] MemStatus read_bytes(uintptr_t addr, void* out_buf, size_t count) noexcept;

// Null-terminated C string, up to max_len bytes.
[[nodiscard]] std::optional<std::string> read_cstr(uintptr_t addr,
                                                    size_t max_len = 4096) noexcept;

// Il2CppString: 16-byte header, int32_t length at +0x10, UTF-16 chars at +0x14.
[[nodiscard]] std::optional<std::string> read_il2cpp_string(uintptr_t str_obj_addr) noexcept;

// Single pointer hop with PAC strip.
[[nodiscard]] ReadResult<uintptr_t> read_ptr(uintptr_t addr) noexcept;

// Pointer chain: read_ptr_chain(base, {0x10, 0x28, 0x00})
//   == *(*(*(base+0x10)+0x28)+0x00)
[[nodiscard]] ReadResult<uintptr_t>
    read_ptr_chain(uintptr_t base, std::span<const ptrdiff_t> offsets) noexcept;

// Scatter-gather batch read.
struct ScatterEntry { uintptr_t addr; void* buf; size_t size; MemStatus result; };
void read_scatter(std::span<ScatterEntry> entries) noexcept;

// ------ Core write primitives -------------------------------------------------
// Typed write — elevates page to RW if needed, restores after.
template<typename T>
[[nodiscard]] WriteResult write(uintptr_t addr, T value) noexcept;

// Raw byte write.
[[nodiscard]] WriteResult write_bytes(uintptr_t addr, const void* data, size_t count) noexcept;

// Pointer write (raw address, no PAC signing).
[[nodiscard]] WriteResult write_ptr(uintptr_t addr, uintptr_t value) noexcept;

// Atomic compare-and-swap (uses __atomic_compare_exchange on aligned targets).
[[nodiscard]] bool compare_and_write(uintptr_t addr,
                                     uint64_t expected, uint64_t desired) noexcept;

// NOP patch — writes count ARM64 NOP instructions (0xD503201F each).
[[nodiscard]] WriteResult patch_nop(uintptr_t addr, uint32_t count) noexcept;

// RET patch — writes ARM64 RET (0xD65F03C0).
[[nodiscard]] WriteResult patch_ret(uintptr_t addr) noexcept;

// ------ Protection management ------------------------------------------------
struct ProtectGuard {
    uintptr_t addr{};
    size_t    size{};
    vm_prot_t original_prot{};
    bool      valid{ false };
    ~ProtectGuard() noexcept;  // restores original_prot on scope exit
    ProtectGuard(uintptr_t address, size_t length, vm_prot_t protection, bool is_valid) noexcept
        : addr(address), size(length), original_prot(protection), valid(is_valid) {}
    ProtectGuard(const ProtectGuard&) = delete;
    ProtectGuard& operator=(const ProtectGuard&) = delete;
    ProtectGuard(ProtectGuard&& o) noexcept
        : addr(o.addr), size(o.size), original_prot(o.original_prot), valid(o.valid)
    { o.valid = false; }
};

[[nodiscard]] std::optional<ProtectGuard> elevate_rw(uintptr_t addr, size_t size) noexcept;
[[nodiscard]] std::optional<ProtectGuard> elevate_rwx(uintptr_t addr, size_t size) noexcept;

// ------ Region & image enumeration -------------------------------------------
struct RegionInfo {
    uintptr_t base;
    size_t    size;
    vm_prot_t prot;
    vm_prot_t max_prot;
    uint32_t  depth;     // from mach_vm_region_recurse
    bool      is_submap;
};
[[nodiscard]] std::vector<RegionInfo> enumerate_regions() noexcept;

struct MachOImage {
    uintptr_t    header_addr;
    uintptr_t    vmaddr_slide;
    const char*  name;        // from _dyld_get_image_name; do not free
};
[[nodiscard]] std::vector<MachOImage> enumerate_images() noexcept;

// ASLR slide for a named image (substring match, case-sensitive).
[[nodiscard]] std::optional<uintptr_t> image_slide(const char* name_substr) noexcept;

// Address validation.
[[nodiscard]] bool is_readable(uintptr_t addr, size_t size = 1) noexcept;
[[nodiscard]] bool is_writable(uintptr_t addr, size_t size = 1) noexcept;
[[nodiscard]] bool is_executable(uintptr_t addr) noexcept;

// Search a readable region for a byte pattern. Returns first match or 0.
[[nodiscard]] uintptr_t find_bytes(uintptr_t region_start, size_t region_size,
                                   const uint8_t* pattern, size_t pattern_len) noexcept;

} // namespace lt::mem
