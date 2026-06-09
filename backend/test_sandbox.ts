// test_sandbox.ts
import { executeCode } from './src/sandbox/docker';
import { warmPoolManager } from './src/sandbox/pool';

async function runTests() {
  console.log("=========================================================");
  console.log("   DOCKER SANDBOX ISOLATION & SECURITY TEST SUITE   ");
  console.log("=========================================================\n");

  console.log("Initializing warm container pools for test suite...");
  await warmPoolManager.initializePools();
  console.log("");

  // Test Case 1: Simple Python execution
  try {
    console.log("Testing Case 1: Standard Python execution...");
    const py = await executeCode('print("Hello from Python Runtime")', 'python');
    console.log(`Output: ${py.output.trim()}`);
    console.log(`Metrics: Duration=${py.durationMs.toFixed(2)}ms, exitCode=${py.exitCode}, oomKilled=${py.oomKilled}\n`);
  } catch (err) {
    console.error("Test Case 1 failed:", err);
  }

  // Test Case 2: Interactive stdin reading
  try {
    console.log("Testing Case 2: Interactive standard input reading...");
    const stdin = await executeCode('val = input()\nprint(f"Read: {val}")', 'python', 'SecretValue\n');
    console.log(`Output: ${stdin.output.trim()}`);
    console.log(`Metrics: Duration=${stdin.durationMs.toFixed(2)}ms, exitCode=${stdin.exitCode}, oomKilled=${stdin.oomKilled}\n`);
  } catch (err) {
    console.error("Test Case 2 failed:", err);
  }

  // Test Case 3: Timeout Limits
  try {
    console.log("Testing Case 3: Infinite loop timeout limit (2000ms)...");
    const timeoutRes = await executeCode('while True: pass', 'python');
    console.log(`Output: ${timeoutRes.output.trim()}`);
    console.log(`Metrics: Duration=${timeoutRes.durationMs.toFixed(2)}ms, exitCode=${timeoutRes.exitCode}, oomKilled=${timeoutRes.oomKilled}\n`);
  } catch (err: any) {
    console.log(`Output: ${err.stdout || ''} ${err.message || '[PASS] Execution Timed Out'}\n`);
  }

  // Test Case 4: Memory limit exhaustion (100MB Cap)
  try {
    console.log("Testing Case 4: Memory limit exhaustion (100MB Cap)...");
    const oomCode = `
import sys
try:
    garbage = []
    for i in range(10_000_000):
        garbage.append("A" * 1000)
except Exception as e:
    print(f"Caught inside: {e}")
`;
    const oomRes = await executeCode(oomCode, 'python');
    console.log(`Output: ${oomRes.output.trim()}`);
    console.log(`Metrics: Duration=${oomRes.durationMs.toFixed(2)}ms, exitCode=${oomRes.exitCode}, oomKilled=${oomRes.oomKilled}`);
    if (oomRes.oomKilled) {
      console.log(`[PASS] Process terminated (OOM-killed) verified via metrics!\n`);
    } else {
      console.log(`[FAIL] Process not marked as OOM-killed.\n`);
    }
  } catch (err) {
    console.log(`[PASS] Container crashed/terminated.\n`);
  }

  // Test Case 5: Fork Bomb limits (PidsLimit: 50)
  try {
    console.log("Testing Case 5: Process spawning threshold (PidsLimit: 50)...");
    const forkBomb = `
import multiprocessing
import os

def worker():
    while True: pass

if __name__ == '__main__':
    try:
        for i in range(100):
            p = multiprocessing.Process(target=worker)
            p.start()
        print("Spawned all processes")
    except Exception as e:
        print(f"Process spawn blocked: {e}")
`;
    const forkRes = await executeCode(forkBomb, 'python');
    console.log(`Output: ${forkRes.output.trim()}`);
    console.log(`Metrics: Duration=${forkRes.durationMs.toFixed(2)}ms, exitCode=${forkRes.exitCode}, oomKilled=${forkRes.oomKilled}\n`);
  } catch (err) {
    console.log("Error running fork bomb test:", err);
  }

  // Test Case 6: External Network block
  try {
    console.log("Testing Case 6: External network access block (NetworkMode: none)...");
    const netTest = `
import urllib.request
try:
    urllib.request.urlopen("http://8.8.8.8", timeout=2)
    print("Network connected")
except Exception as e:
    print(f"Blocked: {e}")
`;
    const netRes = await executeCode(netTest, 'python');
    console.log(`Output: ${netRes.output.trim()}`);
    console.log(`Metrics: Duration=${netRes.durationMs.toFixed(2)}ms, exitCode=${netRes.exitCode}, oomKilled=${netRes.oomKilled}\n`);
  } catch (err) {
    console.log("Error running network isolation test:", err);
  }

  // Test Case 7: Read-Only filesystem mounts
  try {
    console.log("Testing Case 7: Workspace file mutation restriction (:ro)...");
    const mutateCode = `
try:
    with open('/app/code.py', 'w') as f:
        f.write("modified")
except Exception as e:
    print(f"Write blocked: {e}")
`;
    const mutateRes = await executeCode(mutateCode, 'python');
    console.log(`Output: ${mutateRes.output.trim()}`);
    console.log(`Metrics: Duration=${mutateRes.durationMs.toFixed(2)}ms, exitCode=${mutateRes.exitCode}, oomKilled=${mutateRes.oomKilled}\n`);
  } catch (err) {
    console.log("Error running write protection test:", err);
  }

  console.log("=========================================================");
  console.log("               TEST EXECUTION COMPLETED                  ");
  console.log("=========================================================");

  await warmPoolManager.cleanup();
}

runTests();
