// language: Objective-C++, file: src/Core/Memory.mm, target: iOS arm64/arm64e
// Memory engine — fault containment, PAC stripping, protect elevation, region scan.
//
// FIXES applied:
//   FIX-1: elevate_rwx now queries original protection BEFORE calling vm_protect.
//          Previously it queried after, so info.protection reflected the NEW (RWX)
//          value and the RAII guard restored to RWX instead of the original.
//   FIX-2: Signal handler now chains the previous SIGBUS/SIGSEGV handler (Unity's
//          crash reporter, LLDB, etc.) instead of hard-resetting to SIG_DFL.

#import <Foundation/Foundation.h>
#include "LibTool/Memory.hpp"
#include <mach-o/dyld.h>
#include <mach/vm_map.h>
#include <libkern/OSCacheControl.h>
#include <dlfcn.h>
#include <setjmp.h>
#include <signal.h>
#include <sys/mman.h>
#include <cstring>
#include <algorithm>
#include <mutex>
#include <limits>

// ------ Thread-local fault guard state ---------------------------------------
namespace {

thread_local sigjmp_buf  g_fault_buf;
thread_local bool        g_in_fault_guard{ false };

// FIX-2: Save previous handlers so we can chain them on non-guarded faults.
// Unity installs its own SIGBUS/SIGSEGV handlers before our dylib constructor
// runs (via its own constructors and runtime init). We must chain them, not
// discard them, otherwise Unity's crash reporter and LLDB stop working.
static struct sigaction g_prev_sigbus{};
static struct sigaction g_prev_sigsegv{};

void fault_signal_handler(int sig, siginfo_t* info, void* ctx) noexcept {
    if (g_in_fault_guard) {
        siglongjmp(g_fault_buf, sig);
    }
    // Not inside a fault guard — chain the previous handler instead of
    // resetting to SIG_DFL, which would discard Unity's crash reporter.
    struct sigaction* prev = (sig == SIGBUS) ? &g_prev_sigbus : &g_prev_sigsegv;
    if (prev->sa_sigaction && (prev->sa_flags & SA_SIGINFO)) {
        prev->sa_sigaction(sig, info, ctx);
    } else if (prev->sa_handler && prev->sa_handler != SIG_DFL
               && prev->sa_handler != SIG_IGN) {
        prev->sa_handler(sig);
    } else {
        // No useful previous handler — reinstall default and re-raise so the
        // OS generates the crash report normally.
        struct sigaction sa{};
        sa.sa_handler = SIG_DFL;
        sigemptyset(&sa.sa_mask);
        sigaction(sig, &sa, nullptr);
        raise(sig);
    }
}

struct FaultGuard {
    FaultGuard()  noexcept { g_in_fault_guard = true;  }
    ~FaultGuard() noexcept { g_in_fault_guard = false; }
    FaultGuard(const FaultGuard&) = delete;
};


} // namespace

// ------ Template read implementation -----------------------------------------
namespace lt::mem {

void install_fault_handlers() noexcept {
    static std::once_flag once;
    std::call_once(once, [] {
        struct sigaction sa{};
        sa.sa_sigaction = fault_signal_handler;
        // Do not use SA_NODEFER: the same fault must remain blocked while the
        // handler is running to avoid recursive signal-handler entry.
        sa.sa_flags = SA_SIGINFO;
        sigemptyset(&sa.sa_mask);
        sigaction(SIGBUS,  &sa, &g_prev_sigbus);
        sigaction(SIGSEGV, &sa, &g_prev_sigsegv);
    });
}

template<typename T>
ReadResult<T> read(uintptr_t addr) noexcept {
    if (addr == 0) return { MemStatus::NullAddress };
    if (alignof(T) > 1 && (addr & (alignof(T) - 1)))
        return { MemStatus::Misaligned };

    addr = reinterpret_cast<uintptr_t>(
        LT_STRIP_PTR(reinterpret_cast<void*>(addr)));

    FaultGuard guard;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return { MemStatus::Fault };

    T val = *reinterpret_cast<const volatile T*>(addr);
    return { MemStatus::Ok, val };
}

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

MemStatus read_bytes(uintptr_t addr, void* out_buf, size_t count) noexcept {
    if (!addr || !out_buf) return MemStatus::NullAddress;
    if (count == 0) return MemStatus::Ok;
    if (count > 64 * 1024 * 1024) return MemStatus::TooLarge;

    if (count >= 64) {
        vm_size_t out_size = 0;
        kern_return_t kr = vm_read_overwrite(
            mach_task_self(),
            static_cast<vm_address_t>(addr),
            static_cast<vm_size_t>(count),
            reinterpret_cast<vm_address_t>(out_buf),
            &out_size);
        if (kr == KERN_SUCCESS && out_size == count) return MemStatus::Ok;
    }

    FaultGuard guard;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return MemStatus::Fault;
    std::memcpy(out_buf, reinterpret_cast<const void*>(addr), count);
    return MemStatus::Ok;
}

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

std::optional<std::string> read_il2cpp_string(uintptr_t str_obj_addr) noexcept {
    if (!str_obj_addr) return std::nullopt;

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

ReadResult<uintptr_t> read_ptr(uintptr_t addr) noexcept {
    auto r = read<uintptr_t>(addr);
    if (!r.ok()) return r;
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

template<typename T>
WriteResult write(uintptr_t addr, T value) noexcept {
    if (!addr) return { MemStatus::NullAddress };

    auto guard = elevate_rw(addr, sizeof(T));
    if (!guard) return { MemStatus::ProtectFail };

    FaultGuard fg;
    int sig = sigsetjmp(g_fault_buf, 1);
    if (sig != 0) return { MemStatus::Fault };

    *reinterpret_cast<volatile T*>(addr) = value;
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
    if (!guard) return { MemStatus::ProtectFail };

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
    if (!guard) return false;
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
    if (!guard) return { MemStatus::ProtectFail };
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
    return write<uint32_t>(addr, 0xD65F03C0u);
}

// ------ Protection elevation -------------------------------------------------

static bool page_range(uintptr_t addr, size_t size,
                       uintptr_t& base, size_t& length) noexcept {
    const uintptr_t page = static_cast<uintptr_t>(vm_page_size);
    if (!addr || !size || !page || (page & (page - 1)) != 0) return false;
    if (addr > std::numeric_limits<uintptr_t>::max() - size) return false;
    const uintptr_t end = addr + size;
    if (end > std::numeric_limits<uintptr_t>::max() - (page - 1)) return false;
    base = addr & ~(page - 1);
    const uintptr_t rounded_end = (end + page - 1) & ~(page - 1);
    if (rounded_end <= base) return false;
    const uintptr_t span = rounded_end - base;
    length = static_cast<size_t>(span);
    return true;
}

static bool query_single_region(uintptr_t base, size_t length,
                                vm_prot_t& protection) noexcept {
    vm_address_t region_addr = static_cast<vm_address_t>(base);
    vm_size_t region_size = 0;
    vm_region_basic_info_data_64_t info{};
    mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t object = MACH_PORT_NULL;
    const kern_return_t kr = vm_region_64(
        mach_task_self(), &region_addr, &region_size, VM_REGION_BASIC_INFO_64,
        reinterpret_cast<vm_region_info_t>(&info), &count, &object);
    if (kr != KERN_SUCCESS || region_size == 0) return false;
    const uintptr_t rb = static_cast<uintptr_t>(region_addr);
    if (region_size > std::numeric_limits<uintptr_t>::max() - rb) return false;
    const uintptr_t re = rb + static_cast<uintptr_t>(region_size);
    if (rb > base || length > std::numeric_limits<uintptr_t>::max() - base ||
        re < base + length) return false;
    protection = info.protection;
    return true;
}

std::optional<ProtectGuard> elevate_rw(uintptr_t addr, size_t size) noexcept {
    uintptr_t base = 0;
    size_t length = 0;
    if (!page_range(addr, size, base, length)) return std::nullopt;

    vm_prot_t original = VM_PROT_NONE;
    if (!query_single_region(base, length, original)) return std::nullopt;
    if ((original & VM_PROT_READ) && (original & VM_PROT_WRITE))
        return ProtectGuard{ base, length, original, true };

    const kern_return_t kr = vm_protect(
        mach_task_self(), static_cast<vm_address_t>(base),
        static_cast<vm_size_t>(length), FALSE,
        original | VM_PROT_READ | VM_PROT_WRITE);
    if (kr != KERN_SUCCESS) return std::nullopt;
    return ProtectGuard{ base, length, original, true };
}

std::optional<ProtectGuard> elevate_rwx(uintptr_t addr, size_t size) noexcept {
    uintptr_t base = 0;
    size_t length = 0;
    if (!page_range(addr, size, base, length)) return std::nullopt;

    // Query before changing protection. Never guess the original protection:
    // restoring a guessed value can leave code pages writable or corrupt VM state.
    vm_prot_t original = VM_PROT_NONE;
    if (!query_single_region(base, length, original)) return std::nullopt;

    const kern_return_t kr = vm_protect(
        mach_task_self(), static_cast<vm_address_t>(base),
        static_cast<vm_size_t>(length), FALSE,
        VM_PROT_READ | VM_PROT_WRITE | VM_PROT_EXECUTE);
    if (kr != KERN_SUCCESS) return std::nullopt;
    return ProtectGuard{ base, length, original, true };
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

static bool range_has_protection(uintptr_t addr, size_t size,
                                 vm_prot_t required) noexcept {
    if (!addr) return false;
    if (size == 0) return true;
    if (addr > std::numeric_limits<uintptr_t>::max() - size) return false;
    const uintptr_t end = addr + size;
    uintptr_t cursor = addr;

    while (cursor < end) {
        vm_address_t region_addr = static_cast<vm_address_t>(cursor);
        vm_size_t region_size = 0;
        vm_region_basic_info_data_64_t info{};
        mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object = MACH_PORT_NULL;
        const kern_return_t kr = vm_region_64(
            mach_task_self(), &region_addr, &region_size, VM_REGION_BASIC_INFO_64,
            reinterpret_cast<vm_region_info_t>(&info), &count, &object);
        if (kr != KERN_SUCCESS || region_size == 0) return false;

        const uintptr_t region_begin = static_cast<uintptr_t>(region_addr);
        if (region_size > std::numeric_limits<uintptr_t>::max() - region_begin)
            return false;
        const uintptr_t region_end = region_begin + static_cast<uintptr_t>(region_size);
        if (region_begin > cursor || region_end <= cursor ||
            (info.protection & required) != required) return false;
        cursor = std::min(end, region_end);
    }
    return true;
}

bool is_readable(uintptr_t addr, size_t size) noexcept {
    return range_has_protection(addr, size, VM_PROT_READ);
}

bool is_writable(uintptr_t addr, size_t size) noexcept {
    return range_has_protection(addr, size, VM_PROT_WRITE);
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
