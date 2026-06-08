// test_sandbox.ts
import { executeCode } from './src/sandbox/docker';

async function runTests() {
  console.log("=========================================================");
  console.log("   DOCKER SANDBOX ISOLATION & SECURITY TEST SUITE   ");
  console.log("=========================================================\n");

  // Test Case 1: Simple Python execution
  try {
    const py = await executeCode('print("Hello from Python Runtime")', 'python');
    console.log("Testing Case 1: Standard Python execution...");
    console.log(`Output: ${py.trim()}\n`);
  } catch (err) {
    console.error("Test Case 1 failed:", err);
  }

  // Test Case 2: Interactive stdin reading
  try {
    const stdin = await executeCode('val = input()\nprint(f"Read: {val}")', 'python', 'SecretValue\n');
    console.log("Testing Case 2: Interactive standard input reading...");
    console.log(`Output: ${stdin.trim()}\n`);
  } catch (err) {
    console.error("Test Case 2 failed:", err);
  }

  // Test Case 3: Timeout Limits
  try {
    console.log("Testing Case 3: Infinite loop timeout limit (2000ms)...");
    const timeoutRes = await executeCode('while True: pass', 'python');
    console.log(`Output: ${timeoutRes.trim()}\n`);
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
    console.log(`Output: ${oomRes.trim() || '[PASS] Process terminated (OOM-killed)'}\n`);
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
    console.log(`Output: ${forkRes.trim()}\n`);
  } catch (err) {
    console.log("Error running fork bomb test:", err);
  }

  // Test Case 6: External Network block
  try {
    console.log("Testing Case 6: External network access block (NetworkMode: none)...");
    const netTest = `
import urllib.request
try:
    urllib.request.urlopen("https://www.google.com", timeout=2)
    print("Network connected")
except Exception as e:
    print(f"Blocked: {e}")
`;
    const netRes = await executeCode(netTest, 'python');
    console.log(`Output: ${netRes.trim()}\n`);
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
    console.log(`Output: ${mutateRes.trim()}\n`);
  } catch (err) {
    console.log("Error running write protection test:", err);
  }

  console.log("=========================================================");
  console.log("               TEST EXECUTION COMPLETED                  ");
  console.log("=========================================================");
}

runTests();
