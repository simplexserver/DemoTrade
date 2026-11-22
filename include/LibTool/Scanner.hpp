#pragma once
// language: C++20, file: include/LibTool/Scanner.hpp, target: iOS arm64/arm64e
// Runtime scanner: AOB patterns, pointer chains, live value diff (Cheat Engine style).

#include <cstdint>
#include <cstddef>
#include <vector>
#include <string>
#include <optional>
#include <functional>
#include <atomic>

namespace lt::scanner {

// ------ AOB scan -------------------------------------------------------------
// pattern_str: "48 8B ?? 00 ?? 00 00 48" — ?? or ? are wildcards.
// Runs only over readable pages in [start, end).
// If start==0 && end==0: scans all readable executable pages.
[[nodiscard]] std::vector<uintptr_t>
    aob_scan(std::string_view pattern_str,
             uintptr_t start = 0, uintptr_t end = 0) noexcept;

// Async AOB scan — calls on_match for each result, calls on_done when finished.
// Returns a cancel token; call it to abort early.
using CancelFn = std::function<void()>;
[[nodiscard]] CancelFn
    aob_scan_async(std::string_view pattern_str,
                   std::function<void(uintptr_t)> on_match,
                   std::function<void(size_t total)> on_done,
                   uintptr_t start = 0, uintptr_t end = 0);

// ------ Pointer chain --------------------------------------------------------
// Dereferences base + offsets[0], then + offsets[1], ..., + offsets[n-1].
// Returns the final resolved address, or nullopt on any fault.
[[nodiscard]] std::optional<uintptr_t>
    resolve_chain(uintptr_t base,
                  const std::vector<ptrdiff_t>& offsets) noexcept;

// ------ Value diff scanner (Cheat Engine style) --------------------------------
enum class ScanCondition : uint8_t {
    ExactValue,     // val == target
    Decreased,      // val < prev
    Increased,      // val > prev
    Changed,        // val != prev
    Unchanged,      // val == prev
    LessThan,       // val < target
    GreaterThan,    // val > target
    Between,        // target <= val <= target2
};

enum class ScanValueType : uint8_t {
    Int8, Int16, Int32, Int64,
    UInt8, UInt16, UInt32, UInt64,
    Float32, Float64,
};

struct ScanResult {
    uintptr_t  addr;
    uint64_t   prev_value;  // from last scan pass
    uint64_t   curr_value;  // from latest read
};

struct ScanSession {
    ScanValueType value_type{ ScanValueType::Int32 };
    std::vector<ScanResult> candidates;
    uint64_t  target{ 0 };
    uint64_t  target2{ 0 };
    bool      first_scan{ true };
    size_t    scan_pass_count{ 0 };
};

// First scan: find all addresses matching condition(value, target).
void scan_first(ScanSession& session, ScanCondition cond,
                uint64_t target, uint64_t target2 = 0) noexcept;

// Subsequent scan: filter existing candidates by new condition.
void scan_next(ScanSession& session, ScanCondition cond,
               uint64_t target = 0, uint64_t target2 = 0) noexcept;

// Refresh current values in existing candidates without filtering.
void scan_refresh(ScanSession& session) noexcept;

// Reset session to start fresh.
void scan_reset(ScanSession& session) noexcept;

// ------ Scan state for async operations --------------------------------------
struct AsyncScanState {
    std::atomic<bool>     running{ false };
    std::atomic<size_t>   progress{ 0 };
    std::atomic<size_t>   total{ 0 };
    std::atomic<size_t>   match_count{ 0 };
    std::vector<uintptr_t> results;
    std::string last_error;
};

} // namespace lt::scanner
