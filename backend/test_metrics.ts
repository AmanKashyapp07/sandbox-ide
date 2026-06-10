import { executeCode } from './src/sandbox/docker';
import { warmPoolManager } from './src/sandbox/pool';

interface TestResultMetrics {
  durationMs: number;
  exitCode: number;
  oomKilled: boolean;
  cpuUsagePercent?: number;
  memoryUsageBytes?: number;
  output: string;
}

async function runTest(
  name: string,
  language: string,
  code: string,
  input?: string
): Promise<TestResultMetrics> {
  console.log(`\n[TEST EXECUTION] Running: "${name}" (${language})`);
  const start = Date.now();
  const result = await executeCode(code, language, input);
  const end = Date.now();
  const totalWrapperTime = end - start;

  console.log(`  ├─ Reported Duration : ${result.durationMs.toFixed(2)} ms (E2E Wall Time: ${totalWrapperTime} ms)`);
  console.log(`  ├─ Process Exit Code : ${result.exitCode}`);
  console.log(`  ├─ Linux OOM Killed  : ${result.oomKilled}`);
  console.log(`  ├─ Peak CPU Record   : ${result.cpuUsagePercent ?? 0}%`);
  console.log(`  └─ Memory Footprint  : ${((result.memoryUsageBytes ?? 0) / 1024 / 1024).toFixed(2)} MB`);
  
  return {
    ...result,
    cpuUsagePercent: result.cpuUsagePercent ?? 0,
    memoryUsageBytes: result.memoryUsageBytes ?? 0
  };
}

async function runTestSuite() {
  console.log("=========================================================================");
  console.log("             SANDBOX PRODUCTION RESOURCE METRICS TEST SUITE             ");
  console.log("=========================================================================");

  console.log("[Setup] Provisioning warm container pools synchronously...");
  await warmPoolManager.initializePools();

  let totalTests = 0;
  let passedTests = 0;

  const evaluate = (testName: string, evaluationBlock: () => boolean) => {
    totalTests++;
    try {
      if (evaluationBlock()) {
        console.log(`\x1b[32m[PASS]\x1b[0m ${testName} metrics verified.`);
        passedTests++;
      } else {
        console.error(`\x1b[31m[FAIL]\x1b[0m ${testName} failed bounds matching assertions.`);
      }
    } catch (e) {
      console.error(`\x1b[31m[FAIL]\x1b[0m ${testName} threw an unexpected validation error:`, e);
    }
  };

  // -------------------------------------------------------------------------
  // TEST 1: Ephemeral Code execution (Verify lower-bound limits)
  // -------------------------------------------------------------------------
  try {
    const res = await runTest(
      "Sub-sampling Window Execution (Simple Print)",
      "python",
      "print('Metrics Baseline Checking')"
    );
    evaluate("Test 1: Simple Print Baseline Bounds", () => {
      // Ephemeral code should complete instantly and consume nominal base memory
      return res.exitCode === 0 && res.durationMs < 1000 && res.cpuUsagePercent! <= 25;
    });
  } catch (err) {
    console.error("[CRASH] Simple Print test encountered an error:", err);
  }

  // -------------------------------------------------------------------------
  // TEST 2: Single-Thread CPU Saturation (JS Event Loop Pinning)
  // -------------------------------------------------------------------------
  try {
    const jsLoop = `
      const targetTime = Date.now() + 3000;
      let counter = 0;
      while (Date.now() < targetTime) { counter = (counter ^ 0xABC) * 3.1415; }
      console.log('Pinning Complete.');
    `;
    const res = await runTest("Single-Thread Continuous CPU Saturation", "javascript", jsLoop);
    evaluate("Test 2: Single-Thread CPU Saturation Tracking", () => {
      // Node is single threaded, running inside a 0.5 CPU cgroup cap.
      // It must sustain load for ~3 seconds, and record a multi-frame CPU delta.
      return res.exitCode === 0 && res.durationMs >= 3000 && res.cpuUsagePercent! > 0;
    });
  } catch (err) {
    console.error("[CRASH] JS CPU Saturation test encountered an error:", err);
  }

  // -------------------------------------------------------------------------
  // TEST 3: Multi-Threaded Scheduler Stress Test (Python Thread Concurrency)
  // -------------------------------------------------------------------------
  try {
    const pythonConcurrency = `
import time
import threading
def load():
    end = time.time() + 3.0
    while time.time() < end: _ = [x**0.5 for x in range(500)]
threads = [threading.Thread(target=load) for _ in range(4)]
for t in threads: t.start()
for t in threads: t.join()
print('Concurrency Finished.')
    `;
    const res = await runTest("Multi-Threaded Concurrency CPU Max Out", "python", pythonConcurrency);
    evaluate("Test 3: Multi-Threaded cgroup CPU Cap Verification", () => {
      // Due to core normalization, peak CPU should correctly report near 100% (fully saturating the 0.5 core sandbox limit)
      return res.exitCode === 0 && res.cpuUsagePercent! >= 80;
    });
  } catch (err) {
    console.error("[CRASH] Multi-threaded scheduler test encountered an error:", err);
  }

  // -------------------------------------------------------------------------
  // TEST 4: Controlled Allocation (Sustained Memory Below Cgroup Cap)
  // -------------------------------------------------------------------------
  try {
    const safeAllocation = `
import time
# Allocate an array roughly occupying ~40-50MB of RAM
managed_blobs = ["X" * (1024 * 1024) for _ in range(45)]
print(f"Allocated array holding {len(managed_blobs)} megabyte blocks safely.")
time.sleep(1.5)
    `;
    const res = await runTest("Safe Sub-threshold Allocation", "python", safeAllocation);
    evaluate("Test 4: Memory Statistics Tracking (Below Threshold)", () => {
      const memoryMb = res.memoryUsageBytes! / 1024 / 1024;
      // Must accurately track that memory holds above 40MB without triggering an OOM crash
      return res.exitCode === 0 && !res.oomKilled && memoryMb >= 40 && memoryMb < 100;
    });
  } catch (err) {
    console.error("[CRASH] Controlled memory test encountered an error:", err);
  }

  // -------------------------------------------------------------------------
  // TEST 5: Complete Memory Exhaustion (Hard OOM Triggering)
  // -------------------------------------------------------------------------
  try {
    const explicitOom = `
# Rapidly force allocation scaling to breach the 100MB boundary instantly
blobs = []
while True:
    blobs.append("M" * (1024 * 1024))
    `;
    const res = await runTest("Forced Memory Exhaustion (OOM Target)", "python", explicitOom);
    evaluate("Test 5: Host Cgroup OOM Intervention Tracking", () => {
      // The process must be intercepted by the host kernel OOM killer (Exit Code 137, oomKilled: true)
      return res.oomKilled === true || res.exitCode === 137;
    });
  } catch (err) {
    console.error("[CRASH] Memory exhaustion test encountered an error:", err);
  }

  // -------------------------------------------------------------------------
  // TEST 6: Absolute Loop Hang Timeouts (POSIX Signal Killing)
  // -------------------------------------------------------------------------
  try {
    const InfiniteLoop = `
import time
while True:
    time.sleep(0.5)
    `;
    const res = await runTest("Sustained Loop Hang Interception", "python", InfiniteLoop);
    evaluate("Test 6: Execution Timeout Bounds Enforcement", () => {
      // 10 second timeout cap configuration should fire, reporting standard SIGKILL 137 code
      return res.exitCode === 137 && res.durationMs >= 10000;
    });
  } catch (err) {
    console.error("[CRASH] Execution timeout test encountered an error:", err);
  }

  // -------------------------------------------------------------------------
  // TEST 7: Native Binary Pipeline Overhead (C++ Compilation + Execution)
  // -------------------------------------------------------------------------
  try {
    const cppCode = `
#include <iostream>
int main() {
    std::cout << "Native Executable Lifecycle Testing" << std::endl;
    return 0;
}
    `;
    const res = await runTest("Native Compiler Chain Execution", "cpp", cppCode);
    evaluate("Test 7: Compiled Languages Overhead Verification", () => {
      // Ensures the compiled code runs successfully through the one-liner pipe hook
      return res.exitCode === 0 && res.output.includes("Native Executable Lifecycle Testing");
    });
  } catch (err) {
    console.error("[CRASH] Native compilation pipeline test encountered an error:", err);
  }

  // -------------------------------------------------------------------------
  // TEST 8: Custom Signal Interception
  // -------------------------------------------------------------------------
  try {
    const customExit = "import sys; sys.exit(88)";
    const res = await runTest("Custom Process Return Status Verification", "python", customExit);
    evaluate("Test 8: Process Non-Zero Return Codes propagation", () => {
      return res.exitCode === 88;
    });
  } catch (err) {
    console.error("[CRASH] Custom return status test encountered an error:", err);
  }

  // -------------------------------------------------------------------------
  // CLEANUP & SUMMARY REPORT
  // -------------------------------------------------------------------------
  console.log("\n[Teardown] Clearing pre-warmed resource pools gracefully...");
  await warmPoolManager.cleanup();

  console.log("\n=========================================================================");
  console.log(`                     METRICS MATRIX VERIFICATION REPORT                 `);
  console.log(`                     PASSED: ${passedTests} / ${totalTests} TESTS                    `);
  console.log("=========================================================================");
  
  if (passedTests === totalTests) {
    console.log("\x1b[32m[SUCCESS] SYSTEM IS ARCHITECTURALLY STABLE AND RECORDING VALID METRICS.\x1b[0m\n");
  } else {
    console.error("\x1b[31m[CRITICAL] METRIC COLLECTION OUTLIERS OR IRREGULARITIES RECORDED.\x1b[0m\n");
    process.exit(1);
  }
}

// Check execution context hook
if (require.main === module) {
  runTestSuite().catch((err) => {
    console.error("Fatal suite crash:", err);
    process.exit(1);
  });
}

export { runTestSuite };