// language: Objective-C++, file: src/Core/Memory.mm, target: iOS arm64/arm64e
// Memory engine — fault containment, PAC stripping, protect elevation, region scan.
// Two-layer fault guard: mach_vm_region pre-validation + sigsetjmp/siglongjmp fallback.

#import <Foundation/Foundation.h>
#include "LibTool/Memory.hpp"
#include <mach-o/dyld.h>
#include <mach/vm_map.h>
#include <libkern/OSCacheControl.h>
#include <dlfcn.h>
#include <setjmp.h>
#include <signal.h>
#include <sys/mman.h>
#include <codecvt>
#include <locale>
#include <cstring>
#include <algorithm>

// ------ Thread-local fault guard state ---------------------------------------
namespace {

thread_local sigjmp_buf  g_fault_buf;
thread_local bool        g_in_fault_guard{ false };

void fault_signal_handler(int sig, siginfo_t*, void*) noexcept {
    if (g_in_fault_guard) {
        siglongjmp(g_fault_buf, sig);
    }
    // Not guarded — re-raise with default action (crash with diagnostic context).
    struct sigaction sa{};
    sa.sa_handler = SIG_DFL;
    sigemptyset(&sa.sa_mask);
    sigaction(sig, &sa, nullptr);
    raise(sig);
}

struct FaultGuard {
    FaultGuard()  noexcept { g_in_fault_guard = true;  }
    ~FaultGuard() noexcept { g_in_fault_guard = false; }
    FaultGuard(const FaultGuard&) = delete;
};

// Register SIGBUS and SIGSEGV handlers on first use.
// Priority 101 so it runs before EntryPoint (priority 102).
__attribute__((constructor(101)))
static void install_fault_handlers() {
    struct sigaction sa{};
    sa.sa_sigaction = fault_signal_handler;
    sa.sa_flags     = SA_SIGINFO | SA_NODEFER;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGBUS,  &sa, nullptr);
    sigaction(SIGSEGV, &sa, nullptr);
}

} // namespace

// ------ Template read implementation -----------------------------------------
namespace lt::mem {

template<typename T>
ReadResult<T> read(uintptr_t addr) noexcept {
    if (addr == 0) return { MemStatus::NullAddress };
    if (alignof(T) > 1 && (addr & (alignof(T) - 1)))
        return { MemStatus::Misaligned };

    // PAC-strip on arm64e before dereferencing stored pointers.
    addr = reinterpret_cast<uintptr_t>(
        LT_STRIP_PTR(reinterpret_cast<void*>(addr)));

    FaultGuard guard;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return { MemStatus::Fault };

    T val = *reinterpret_cast<const volatile T*>(addr);
    return { MemStatus::Ok, val };
}

// Explicit instantiations for the most common types used by the bridge.
template ReadResult<uint8_t>   read<uint8_t>(uintptr_t) noexcept;
template ReadResult<uint16_t>  read<uint16_t>(uintptr_t) noexcept;
template ReadResult<uint32_t>  read<uint32_t>(uintptr_t) noexcept;
template ReadResult<uint64_t>  read<uint64_t>(uintptr_t) noexcept;
template ReadResult<int8_t>    read<int8_t>(uintptr_t) noexcept;
template ReadResult<int16_t>   read<int16_t>(uintptr_t) noexcept;
template ReadResult<int32_t>   read<int32_t>(uintptr_t) noexcept;
template ReadResult<int64_t>   read<int64_t>(uintptr_t) noexcept;
template ReadResult<float>     read<float>(uintptr_t) noexcept;
template ReadResult<double>    read<double>(uintptr_t) noexcept;
template ReadResult<uintptr_t> read<uintptr_t>(uintptr_t) noexcept;
template ReadResult<void*>     read<void*>(uintptr_t) noexcept;

// ------ Byte-level read -------------------------------------------------------
MemStatus read_bytes(uintptr_t addr, void* out_buf, size_t count) noexcept {
    if (!addr || !out_buf) return MemStatus::NullAddress;
    if (count == 0) return MemStatus::Ok;
    if (count > 64 * 1024 * 1024) return MemStatus::TooLarge;

    // For large reads, use vm_read_overwrite to avoid per-byte fault guards.
    if (count >= 64) {
        vm_size_t out_size = 0;
        kern_return_t kr = vm_read_overwrite(
            mach_task_self(),
            static_cast<vm_address_t>(addr),
            static_cast<vm_size_t>(count),
            reinterpret_cast<vm_address_t>(out_buf),
            &out_size);
        if (kr == KERN_SUCCESS && out_size == count) return MemStatus::Ok;
        // Fall through to guarded copy on failure.
    }

    FaultGuard guard;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return MemStatus::Fault;
    std::memcpy(out_buf, reinterpret_cast<const void*>(addr), count);
    return MemStatus::Ok;
}

// ------ C string read --------------------------------------------------------
std::optional<std::string> read_cstr(uintptr_t addr, size_t max_len) noexcept {
    if (!addr) return std::nullopt;
    std::string result;
    result.reserve(64);

    FaultGuard guard;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return std::nullopt;

    const char* p = reinterpret_cast<const char*>(addr);
    for (size_t i = 0; i < max_len; ++i, ++p) {
        char c = *p;
        if (c == '\0') break;
        result.push_back(c);
    }
    return result;
}

// ------ IL2CPP string read ---------------------------------------------------
std::optional<std::string> read_il2cpp_string(uintptr_t str_obj_addr) noexcept {
    if (!str_obj_addr) return std::nullopt;

    // Read length (int32_t at +0x10)
    auto len_res = read<int32_t>(str_obj_addr + IL2CPP_STRING_LENGTH_OFFSET);
    if (!len_res.ok() || len_res.value <= 0 || len_res.value > 65536)
        return std::nullopt;

    int32_t len = len_res.value;
    std::vector<char16_t> chars(static_cast<size_t>(len));

    MemStatus s = read_bytes(
        str_obj_addr + IL2CPP_STRING_CHARS_OFFSET,
        chars.data(),
        static_cast<size_t>(len) * sizeof(char16_t));

    if (s != MemStatus::Ok) return std::nullopt;

    // Convert UTF-16 LE to UTF-8
    std::string result;
    result.reserve(static_cast<size_t>(len));
    for (char16_t ch : chars) {
        if (ch < 0x80) {
            result.push_back(static_cast<char>(ch));
        } else if (ch < 0x800) {
            result.push_back(static_cast<char>(0xC0 | (ch >> 6)));
            result.push_back(static_cast<char>(0x80 | (ch & 0x3F)));
        } else {
            result.push_back(static_cast<char>(0xE0 | (ch >> 12)));
            result.push_back(static_cast<char>(0x80 | ((ch >> 6) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | (ch & 0x3F)));
        }
    }
    return result;
}

// ------ Pointer reads --------------------------------------------------------
ReadResult<uintptr_t> read_ptr(uintptr_t addr) noexcept {
    auto r = read<uintptr_t>(addr);
    if (!r.ok()) return r;
    // Strip PAC bits from the loaded pointer value itself.
    uintptr_t stripped = reinterpret_cast<uintptr_t>(
        LT_STRIP_PTR(reinterpret_cast<void*>(r.value)));
    return { MemStatus::Ok, stripped };
}

ReadResult<uintptr_t>
read_ptr_chain(uintptr_t base, std::span<const ptrdiff_t> offsets) noexcept {
    uintptr_t cur = base;
    for (ptrdiff_t off : offsets) {
        auto r = read_ptr(cur + off);
        if (!r.ok()) return r;
        cur = r.value;
    }
    return { MemStatus::Ok, cur };
}

void read_scatter(std::span<ScatterEntry> entries) noexcept {
    for (auto& e : entries) {
        e.result = read_bytes(e.addr, e.buf, e.size);
    }
}

// ------ Write implementation --------------------------------------------------
template<typename T>
WriteResult write(uintptr_t addr, T value) noexcept {
    if (!addr) return { MemStatus::NullAddress };

    auto guard = elevate_rw(addr, sizeof(T));  // elevate if read-only (.text hooks etc.)

    FaultGuard fg;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return { MemStatus::Fault };

    *reinterpret_cast<volatile T*>(addr) = value;

    // Flush instruction cache for code patches (critical for hook installation).
    sys_icache_invalidate(reinterpret_cast<void*>(addr), sizeof(T));
    return { MemStatus::Ok };
}

template WriteResult write<uint8_t>(uintptr_t, uint8_t) noexcept;
template WriteResult write<uint16_t>(uintptr_t, uint16_t) noexcept;
template WriteResult write<uint32_t>(uintptr_t, uint32_t) noexcept;
template WriteResult write<uint64_t>(uintptr_t, uint64_t) noexcept;
template WriteResult write<int32_t>(uintptr_t, int32_t) noexcept;
template WriteResult write<int64_t>(uintptr_t, int64_t) noexcept;
template WriteResult write<float>(uintptr_t, float) noexcept;
template WriteResult write<double>(uintptr_t, double) noexcept;
template WriteResult write<uintptr_t>(uintptr_t, uintptr_t) noexcept;

WriteResult write_bytes(uintptr_t addr, const void* data, size_t count) noexcept {
    if (!addr || !data) return { MemStatus::NullAddress };
    if (count == 0) return { MemStatus::Ok };

    auto guard = elevate_rw(addr, count);

    FaultGuard fg;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return { MemStatus::Fault };

    std::memcpy(reinterpret_cast<void*>(addr), data, count);
    sys_icache_invalidate(reinterpret_cast<void*>(addr), count);
    return { MemStatus::Ok };
}

WriteResult write_ptr(uintptr_t addr, uintptr_t value) noexcept {
    return write<uintptr_t>(addr, value);
}

bool compare_and_write(uintptr_t addr, uint64_t expected, uint64_t desired) noexcept {
    if (!addr) return false;
    auto guard = elevate_rw(addr, sizeof(uint64_t));
    FaultGuard fg;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return false;
    return __atomic_compare_exchange_n(
        reinterpret_cast<uint64_t*>(addr),
        &expected, desired,
        false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
}

WriteResult patch_nop(uintptr_t addr, uint32_t count) noexcept {
    if (!addr || count == 0) return { MemStatus::NullAddress };
    auto guard = elevate_rwx(addr, count * 4);
    FaultGuard fg;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return { MemStatus::Fault };
    static constexpr uint32_t NOP = 0xD503201F;
    uint32_t* p = reinterpret_cast<uint32_t*>(addr);
    for (uint32_t i = 0; i < count; ++i) p[i] = NOP;
    sys_icache_invalidate(reinterpret_cast<void*>(addr), count * 4);
    return { MemStatus::Ok };
}

WriteResult patch_ret(uintptr_t addr) noexcept {
    return write<uint32_t>(addr, 0xD65F03C0u);  // ARM64 RET
}

// ------ Protection elevation -------------------------------------------------
std::optional<ProtectGuard> elevate_rw(uintptr_t addr, size_t size) noexcept {
    if (!addr) return std::nullopt;
    const vm_size_t pg = vm_page_size;
    uintptr_t base = addr & ~(pg - 1);
    size_t len = ((addr + size + pg - 1) & ~(pg - 1)) - base;

    vm_address_t  raddr = static_cast<vm_address_t>(base);
    vm_size_t     rsize = 0;
    vm_region_basic_info_data_64_t info{};
    mach_msg_type_number_t info_count = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t object_name = MACH_PORT_NULL;

    kern_return_t kr = vm_region_64(
        mach_task_self(), &raddr, &rsize,
        VM_REGION_BASIC_INFO_64,
        reinterpret_cast<vm_region_info_t>(&info),
        &info_count, &object_name);

    if (kr != KERN_SUCCESS) return std::nullopt;
    const vm_prot_t orig = info.protection;
    if ((orig & VM_PROT_WRITE) && (orig & VM_PROT_READ))
        return ProtectGuard{ base, len, orig, true };  // already RW

    kr = vm_protect(mach_task_self(), base, len, FALSE,
                    orig | VM_PROT_READ | VM_PROT_WRITE);
    if (kr != KERN_SUCCESS) return std::nullopt;
    return ProtectGuard{ base, len, orig, true };
}

std::optional<ProtectGuard> elevate_rwx(uintptr_t addr, size_t size) noexcept {
    if (!addr) return std::nullopt;
    const vm_size_t pg = vm_page_size;
    uintptr_t base = addr & ~(pg - 1);
    size_t len = ((addr + size + pg - 1) & ~(pg - 1)) - base;
    kern_return_t kr = vm_protect(mach_task_self(), base, len, FALSE,
                                  VM_PROT_READ | VM_PROT_WRITE | VM_PROT_EXECUTE);
    if (kr != KERN_SUCCESS) return std::nullopt;

    // Query original for RAII restore
    vm_address_t raddr = base;
    vm_size_t rsize = 0;
    vm_region_basic_info_data_64_t info{};
    mach_msg_type_number_t cnt = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t obj = MACH_PORT_NULL;
    vm_region_64(mach_task_self(), &raddr, &rsize, VM_REGION_BASIC_INFO_64,
                 reinterpret_cast<vm_region_info_t>(&info), &cnt, &obj);
    return ProtectGuard{ base, len, info.protection, true };
}

ProtectGuard::~ProtectGuard() noexcept {
    if (valid)
        vm_protect(mach_task_self(), addr, size, FALSE, original_prot);
}

// ------ Region & image enumeration -------------------------------------------
std::vector<RegionInfo> enumerate_regions() noexcept {
    std::vector<RegionInfo> result;
    result.reserve(256);
    vm_address_t addr = 0;
    while (true) {
        vm_size_t size = 0;
        vm_region_basic_info_data_64_t info{};
        mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object = MACH_PORT_NULL;
        kern_return_t kr = vm_region_64(
            mach_task_self(), &addr, &size, VM_REGION_BASIC_INFO_64,
            reinterpret_cast<vm_region_info_t>(&info), &count, &object);
        if (kr != KERN_SUCCESS || size == 0) break;
        result.push_back({
            static_cast<uintptr_t>(addr),
            static_cast<size_t>(size),
            info.protection, info.max_protection,
            0, false
        });
        if (addr > UINT64_MAX - size) break;
        addr += size;
    }
    return result;
}

std::vector<MachOImage> enumerate_images() noexcept {
    std::vector<MachOImage> result;
    uint32_t n = _dyld_image_count();
    result.reserve(n);
    for (uint32_t i = 0; i < n; ++i) {
        const struct mach_header* hdr = _dyld_get_image_header(i);
        result.push_back({
            reinterpret_cast<uintptr_t>(hdr),
            static_cast<uintptr_t>(_dyld_get_image_vmaddr_slide(i)),
            _dyld_get_image_name(i)
        });
    }
    return result;
}

std::optional<uintptr_t> image_slide(const char* name_substr) noexcept {
    for (auto& img : enumerate_images()) {
        if (img.name && std::strstr(img.name, name_substr))
            return img.vmaddr_slide;
    }
    return std::nullopt;
}

bool is_readable(uintptr_t addr, size_t size) noexcept {
    vm_address_t raddr = static_cast<vm_address_t>(addr & ~(vm_page_size - 1));
    vm_size_t rsize = 0;
    vm_region_basic_info_data_64_t info{};
    mach_msg_type_number_t cnt = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t obj = MACH_PORT_NULL;
    kern_return_t kr = vm_region_64(mach_task_self(), &raddr, &rsize,
        VM_REGION_BASIC_INFO_64,
        reinterpret_cast<vm_region_info_t>(&info), &cnt, &obj);
    return kr == KERN_SUCCESS && (info.protection & VM_PROT_READ);
}

bool is_writable(uintptr_t addr, size_t size) noexcept {
    vm_address_t raddr = static_cast<vm_address_t>(addr & ~(vm_page_size - 1));
    vm_size_t rsize = 0;
    vm_region_basic_info_data_64_t info{};
    mach_msg_type_number_t cnt = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t obj = MACH_PORT_NULL;
    kern_return_t kr = vm_region_64(mach_task_self(), &raddr, &rsize,
        VM_REGION_BASIC_INFO_64,
        reinterpret_cast<vm_region_info_t>(&info), &cnt, &obj);
    return kr == KERN_SUCCESS && (info.protection & VM_PROT_WRITE);
}

bool is_executable(uintptr_t addr) noexcept {
    vm_address_t raddr = static_cast<vm_address_t>(addr & ~(vm_page_size - 1));
    vm_size_t rsize = 0;
    vm_region_basic_info_data_64_t info{};
    mach_msg_type_number_t cnt = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t obj = MACH_PORT_NULL;
    kern_return_t kr = vm_region_64(mach_task_self(), &raddr, &rsize,
        VM_REGION_BASIC_INFO_64,
        reinterpret_cast<vm_region_info_t>(&info), &cnt, &obj);
    return kr == KERN_SUCCESS && (info.protection & VM_PROT_EXECUTE);
}

uintptr_t find_bytes(uintptr_t region_start, size_t region_size,
                     const uint8_t* pattern, size_t pattern_len) noexcept {
    if (!region_start || !pattern || !pattern_len || pattern_len > region_size)
        return 0;
    const uint8_t* base = reinterpret_cast<const uint8_t*>(region_start);
    const uint8_t* end  = base + region_size - pattern_len;
    FaultGuard guard;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return 0;
    for (const uint8_t* p = base; p <= end; ++p) {
        if (std::memcmp(p, pattern, pattern_len) == 0)
            return reinterpret_cast<uintptr_t>(p);
    }
    return 0;
}

} // namespace lt::mem
