// language: Objective-C++, file: src/Core/Scanner.mm, target: iOS arm64/arm64e
// Runtime scanner: AOB patterns with ?? wildcards, pointer chains, live diff scanner.

#import <Foundation/Foundation.h>
#include "LibTool/Scanner.hpp"
#include "LibTool/Memory.hpp"
#include <thread>
#include <sstream>
#include <charconv>
#include <cstring>

namespace lt::scanner {

// ------ AOB pattern parsing --------------------------------------------------
struct PatternByte { uint8_t byte; bool wildcard; };

static std::vector<PatternByte> parse_pattern(std::string_view pattern_str) {
    std::vector<PatternByte> result;
    result.reserve(32);
    size_t i = 0;
    while (i < pattern_str.size()) {
        while (i < pattern_str.size() && pattern_str[i] == ' ') ++i;
        if (i >= pattern_str.size()) break;
        // Wildcard: "??" or "?"
        if (pattern_str[i] == '?') {
            result.push_back({ 0, true });
            while (i < pattern_str.size() && pattern_str[i] == '?') ++i;
        } else {
            // Hex byte
            if (i + 1 < pattern_str.size() &&
                std::isxdigit(pattern_str[i]) && std::isxdigit(pattern_str[i+1])) {
                uint8_t byte = 0;
                std::from_chars(pattern_str.data() + i,
                                pattern_str.data() + i + 2, byte, 16);
                result.push_back({ byte, false });
                i += 2;
            } else {
                ++i;  // skip unknown
            }
        }
    }
    return result;
}

// ------ AOB scan (synchronous) -----------------------------------------------
std::vector<uintptr_t>
aob_scan(std::string_view pattern_str, uintptr_t start, uintptr_t end) noexcept {
    std::vector<uintptr_t> results;
    auto pattern = parse_pattern(pattern_str);
    if (pattern.empty()) return results;
    size_t plen = pattern.size();

    auto scan_region = [&](uintptr_t base, size_t size) {
        if (size < plen) return;
        // Read region into local buffer to avoid per-byte fault guards.
        std::vector<uint8_t> buf(size);
        if (lt::mem::read_bytes(base, buf.data(), size) != lt::mem::MemStatus::Ok) return;

        const uint8_t* p   = buf.data();
        const uint8_t* end_p = p + size - plen;
        for (; p <= end_p; ++p) {
            bool match = true;
            for (size_t j = 0; j < plen; ++j) {
                if (!pattern[j].wildcard && p[j] != pattern[j].byte) {
                    match = false; break;
                }
            }
            if (match) {
                results.push_back(base + static_cast<uintptr_t>(p - buf.data()));
            }
        }
    };

    if (start != 0 || end != 0) {
        scan_region(start, end > start ? end - start : 0);
    } else {
        for (auto& region : lt::mem::enumerate_regions()) {
            if (!(region.prot & VM_PROT_READ)) continue;
            if (region.is_submap) continue;
            if (region.size > 256 * 1024 * 1024) continue;
            scan_region(region.base, region.size);
        }
    }
    return results;
}

// ------ Async AOB scan -------------------------------------------------------
CancelFn aob_scan_async(std::string_view pattern_str,
                         std::function<void(uintptr_t)> on_match,
                         std::function<void(size_t)> on_done,
                         uintptr_t start, uintptr_t end) {
    auto cancelled = std::make_shared<std::atomic<bool>>(false);
    auto pattern = std::make_shared<std::vector<PatternByte>>(parse_pattern(pattern_str));

    std::thread([cancelled, pattern, on_match, on_done, start, end]() {
        size_t total = 0;
        auto scan_region = [&](uintptr_t base, size_t size) {
            if (cancelled->load()) return;
            size_t plen = pattern->size();
            if (size < plen) return;
            std::vector<uint8_t> buf(size);
            if (lt::mem::read_bytes(base, buf.data(), size) != lt::mem::MemStatus::Ok) return;
            const uint8_t* p     = buf.data();
            const uint8_t* endp  = p + size - plen;
            for (; p <= endp; ++p) {
                if (cancelled->load()) return;
                bool match = true;
                for (size_t j = 0; j < plen; ++j) {
                    if (!(*pattern)[j].wildcard && p[j] != (*pattern)[j].byte) {
                        match = false; break;
                    }
                }
                if (match) {
                    uintptr_t addr = base + static_cast<uintptr_t>(p - buf.data());
                    if (on_match) on_match(addr);
                    ++total;
                }
            }
        };

        if (start != 0 || end != 0) {
            scan_region(start, end > start ? end - start : 0);
        } else {
            for (auto& region : lt::mem::enumerate_regions()) {
                if (cancelled->load()) break;
                if (!(region.prot & VM_PROT_READ)) continue;
                if (region.is_submap) continue;
                if (region.size > 256 * 1024 * 1024) continue;
                scan_region(region.base, region.size);
            }
        }
        if (on_done) on_done(total);
    }).detach();

    return [cancelled]() { cancelled->store(true); };
}

// ------ Pointer chain resolver -----------------------------------------------
std::optional<uintptr_t>
resolve_chain(uintptr_t base, const std::vector<ptrdiff_t>& offsets) noexcept {
    uintptr_t cur = base;
    for (ptrdiff_t off : offsets) {
        auto r = lt::mem::read_ptr(cur + off);
        if (!r.ok() || !r.value) return std::nullopt;
        cur = r.value;
    }
    return cur;
}

// ------ Value read helper ----------------------------------------------------
static uint64_t read_value(uintptr_t addr, ScanValueType type) noexcept {
    switch (type) {
        case ScanValueType::Int8:   { auto r = lt::mem::read<int8_t>(addr);   return r.ok() ? static_cast<uint64_t>(r.value) : 0; }
        case ScanValueType::Int16:  { auto r = lt::mem::read<int16_t>(addr);  return r.ok() ? static_cast<uint64_t>(r.value) : 0; }
        case ScanValueType::Int32:  { auto r = lt::mem::read<int32_t>(addr);  return r.ok() ? static_cast<uint64_t>(r.value) : 0; }
        case ScanValueType::Int64:  { auto r = lt::mem::read<int64_t>(addr);  return r.ok() ? static_cast<uint64_t>(r.value) : 0; }
        case ScanValueType::UInt8:  { auto r = lt::mem::read<uint8_t>(addr);  return r.ok() ? r.value : 0; }
        case ScanValueType::UInt16: { auto r = lt::mem::read<uint16_t>(addr); return r.ok() ? r.value : 0; }
        case ScanValueType::UInt32: { auto r = lt::mem::read<uint32_t>(addr); return r.ok() ? r.value : 0; }
        case ScanValueType::UInt64: { auto r = lt::mem::read<uint64_t>(addr); return r.ok() ? r.value : 0; }
        case ScanValueType::Float32: {
            auto r = lt::mem::read<float>(addr);
            if (!r.ok()) return 0;
            uint32_t bits; std::memcpy(&bits, &r.value, 4); return bits;
        }
        case ScanValueType::Float64: {
            auto r = lt::mem::read<double>(addr);
            if (!r.ok()) return 0;
            uint64_t bits; std::memcpy(&bits, &r.value, 8); return bits;
        }
    }
    return 0;
}

static size_t value_size(ScanValueType type) noexcept {
    switch (type) {
        case ScanValueType::Int8:  case ScanValueType::UInt8:  return 1;
        case ScanValueType::Int16: case ScanValueType::UInt16: return 2;
        case ScanValueType::Int32: case ScanValueType::UInt32: case ScanValueType::Float32: return 4;
        case ScanValueType::Int64: case ScanValueType::UInt64: case ScanValueType::Float64: return 8;
    }
    return 4;
}

static bool matches(uint64_t curr, uint64_t prev, uint64_t target, uint64_t target2,
                    ScanCondition cond) noexcept {
    switch (cond) {
        case ScanCondition::ExactValue:   return curr == target;
        case ScanCondition::Decreased:    return curr < prev;
        case ScanCondition::Increased:    return curr > prev;
        case ScanCondition::Changed:      return curr != prev;
        case ScanCondition::Unchanged:    return curr == prev;
        case ScanCondition::LessThan:     return curr < target;
        case ScanCondition::GreaterThan:  return curr > target;
        case ScanCondition::Between:      return curr >= target && curr <= target2;
    }
    return false;
}

void scan_first(ScanSession& session, ScanCondition cond,
                uint64_t target, uint64_t target2) noexcept {
    session.candidates.clear();
    session.target  = target;
    session.target2 = target2;
    size_t vsize = value_size(session.value_type);

    for (auto& region : lt::mem::enumerate_regions()) {
        if (!(region.prot & VM_PROT_READ) || !(region.prot & VM_PROT_WRITE)) continue;
        if (region.is_submap) continue;
        if (region.size > 128 * 1024 * 1024) continue;

        uintptr_t addr = region.base;
        uintptr_t end  = region.base + region.size - vsize;
        while (addr < end) {
            uint64_t val = read_value(addr, session.value_type);
            if (matches(val, 0, target, target2, cond)) {
                session.candidates.push_back({ addr, 0, val });
                if (session.candidates.size() >= 1'000'000) goto done;
            }
            addr += vsize;
        }
    }
    done:
    session.first_scan = false;
    ++session.scan_pass_count;
}

void scan_next(ScanSession& session, ScanCondition cond,
               uint64_t target, uint64_t target2) noexcept {
    if (session.first_scan) { scan_first(session, cond, target, target2); return; }
    session.target  = target ? target  : session.target;
    session.target2 = target2 ? target2 : session.target2;

    std::vector<ScanResult> kept;
    kept.reserve(session.candidates.size());

    for (auto& cand : session.candidates) {
        uint64_t curr = read_value(cand.addr, session.value_type);
        if (matches(curr, cand.curr_value, session.target, session.target2, cond)) {
            kept.push_back({ cand.addr, cand.curr_value, curr });
        }
    }
    session.candidates = std::move(kept);
    ++session.scan_pass_count;
}

void scan_refresh(ScanSession& session) noexcept {
    for (auto& cand : session.candidates) {
        cand.prev_value = cand.curr_value;
        cand.curr_value = read_value(cand.addr, session.value_type);
    }
}

void scan_reset(ScanSession& session) noexcept {
    session.candidates.clear();
    session.first_scan = true;
    session.scan_pass_count = 0;
}

} // namespace lt::scanner
