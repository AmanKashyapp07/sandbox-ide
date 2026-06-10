import Docker from 'dockerode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Writable } from 'stream';

export interface ExecutionResult {
  output: string;
  durationMs: number;
  exitCode: number;
  oomKilled: boolean;
  cpuUsagePercent?: number;
  memoryUsageBytes?: number;
}


// =============================================================================
// DOCKER SANDBOX EXECUTION ENGINE
// =============================================================================
//
// PURPOSE:
//   Execute untrusted, arbitrary user code safely by isolating it inside a
//   pre-warmed Docker container from the warm pool (see pool.ts). The container
//   is torn down after every run — each execution is ephemeral.
//
// ARCHITECTURE — WARM POOL + EXEC INJECTION:
//   This engine uses a two-phase approach to achieve sub-100ms execution latency:
//
//   Phase 1 — Pool Pop (handled by pool.ts):
//     Pre-warmed containers are created at server startup and maintained in a
//     pool. When a user submits code, we pop an idle container instantly (~0ms)
//     instead of paying the ~600ms cold-start penalty of docker.createContainer().
//
//   Phase 2 — Code Injection + Execution (handled here):
//     We inject the user's source code into the running container via
//     `docker exec sh -c 'cat > /app/filename'` (streaming the code over stdin).
//     Then we execute the language-specific run command via a second `docker exec`.
//     This avoids bind-mounting host files, which eliminates host filesystem
//     exposure and removes the need for a temp_sandbox directory.
//
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │  OLD FLOW (bind-mount, pre-pool):                                   │
//   │    Write code to temp file → Create container (mount file :ro) →     │
//   │    Start container → Wait → Read output → Remove container           │
//   │    Latency: ~600ms container create + ~runtime                       │
//   │                                                                      │
//   │  NEW FLOW (warm pool + exec injection):                              │
//   │    Pop warm container from pool (~0ms) →                             │
//   │    Exec: inject code via stdin cat > /app/file (~10ms) →             │
//   │    Exec: run command (~runtime) →                                    │
//   │    Collect output → Remove container                                 │
//   │    Latency: ~10–50ms overhead + ~runtime                             │
//   └─────────────────────────────────────────────────────────────────────┘
//
// WHY DOCKER INSTEAD OF child_process.exec / VM?
//   - child_process.exec runs code directly on the host OS. A malicious user
//     could delete files, exfiltrate data, or fork-bomb the server.
//   - Node's 'vm' module only sandboxes JavaScript and still shares the same
//     process memory — a prototype-pollution attack can escape it.
//   - Docker uses Linux kernel primitives (namespaces + cgroups) to give each
//     container its own isolated view of the filesystem, network, PIDs, and
//     resource limits. Even if the code inside is malicious, it cannot affect
//     the host or other containers.
//
// LINUX KERNEL PRIMITIVES DOCKER USES INTERNALLY:
//   1. Namespaces — isolate what a process can *see*:
//        PID namespace  → container processes have their own PID tree (PID 1
//                         inside the container is the container init, not host)
//        NET namespace  → separate network stack; NetworkMode:'none' means no
//                         network interfaces exist at all inside the container
//        MNT namespace  → own filesystem mount table; tmpfs-backed /app and /tmp
//                         are the only writable locations (rootfs is read-only)
//        IPC namespace  → isolated shared memory and semaphores
//        UTS namespace  → own hostname and domain name
//   2. cgroups (Control Groups) — limit what a process can *use*:
//        memory         → hard cap on RAM; OOM killer fires if exceeded
//        cpu            → NanoCpus limits CPU time share (CFS scheduler)
//        pids           → max number of processes/threads; blocks fork bombs
//
// SECURITY PROPERTIES OF THIS ENGINE:
//   - No network access (NetworkMode: 'none')         → can't exfiltrate data
//   - Read-only rootfs + tmpfs mounts                 → can't tamper with system binaries
//   - Code injected via exec stdin (no bind mounts)   → host filesystem never exposed
//   - Memory cap 100 MB + swap disabled               → no OOM bomb
//   - CPU cap 0.5 vCPU                                → can't starve host
//   - PID limit 50                                    → fork bombs contained
//   - Hard timeout 10 s                               → no infinite loops
//   - Output cap 1 MB                                 → no OOM from print loops
//   - Container removed after every run               → no state leaks between users
//
// =============================================================================

import { docker, warmPoolManager } from './pool';
// docker and warmPoolManager are singletons exported from pool.ts.
// - docker: the Dockerode instance connected to the Docker daemon socket
// - warmPoolManager: manages the pre-warmed container pool lifecycle

// Max bytes we accumulate from stdout + stderr combined before truncating.
// Without this cap, a user's `while True: print("x" * 10000)` loop would
// accumulate gigabytes in memory and crash the Node.js process.
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1 MB

// Language → Docker image + run command + expected source filename.
//
// WHY ALPINE-BASED IMAGES (python:3.10-alpine, node:20-alpine)?
//   Alpine Linux uses musl libc instead of glibc and strips most tools.
//   python:3.10-alpine is ~50 MB vs python:3.10 at ~900 MB.
//   Smaller image = faster container start time = faster execution response.
//   Smaller attack surface = fewer binaries the sandboxed code could abuse.
//
// WHY gcc:12 FOR C/C++ INSTEAD OF gcc:12-alpine?
//   gcc on Alpine has known linking issues with some standard library functions
//   (musl vs glibc ABI differences). gcc:12 uses Debian slim which is more
//   compatible with standard coursework and competitive programming code.
//
// HOW COMPILED LANGUAGES WORK:
//   For C and C++, cmd is a shell one-liner: "compile && run".
//   The '&&' means: only run /app/code.out if compilation succeeded.
//   If compilation fails, g++ exits non-zero, '&&' short-circuits, and the
//   compiler error message goes to stderr, which we capture and return.
//
// NOTE ON DUPLICATION WITH pool.ts:
//   pool.ts also defines IMAGE_CONFIGS. This is intentional — pool.ts only
//   needs the image name, while this file needs image + cmd + filename.
//   Merging them would create a circular import (pool imports from docker,
//   docker imports from pool). The duplication is a conscious tradeoff.
const CONFIGS: Record<string, { image: string; cmd: string[]; filename: string }> = {
  python: {
    image: 'python:3.10-alpine',
    cmd: ['python', '/app/code.py'],
    filename: 'code.py'
  },
  javascript: {
    image: 'node:20-alpine',
    cmd: ['node', '/app/code.js'],
    filename: 'code.js'
  },
  cpp: {
    // sh -c runs the argument as a shell command, enabling && chaining.
    image: 'gcc:12',
    cmd: ['sh', '-c', 'g++ /app/code.cpp -o /app/code.out && /app/code.out'],
    filename: 'code.cpp'
  },
  c: {
    image: 'gcc:12',
    cmd: ['sh', '-c', 'gcc /app/code.c -o /app/code.out && /app/code.out'],
    filename: 'code.c'
  },
  bash: {
    image: 'alpine:3.18',
    cmd: ['sh', '/app/code.sh'],
    filename: 'code.sh'
  }
};

// =============================================================================
// LOGGING HELPER
// =============================================================================
// Appends a structured log entry to execution_requests.log after every run.
// Non-fatal: if the write fails (disk full, permission denied), we log to
// console but do NOT surface the error to the caller — logging is observability
// infrastructure, not part of the execution contract.
async function logRequest(
  language: string,
  code: string,
  input: string | undefined,
  output: string
): Promise<void> {
  const logPath = path.join(__dirname, '..', '..', 'execution_requests.log');
  const entry =
    `\n================================================================================\n` +
    `TIMESTAMP : ${new Date().toISOString()}\n` +
    `LANGUAGE  : ${language}\n` +
    `INPUT     : ${input ?? 'None'}\n` +
    `CODE:\n${code}\n` +
    `--------------------------------------------------------------------------------\n` +
    `OUTPUT:\n${output}\n` +
    `================================================================================\n`;
  try {
    await fs.appendFile(logPath, entry, 'utf8');
    // appendFile is O_APPEND under the hood. On Linux, O_APPEND writes are
    // atomic for writes smaller than PIPE_BUF (~4 KB) on most filesystems.
    // For our log entries (usually <1 KB), concurrent writes from parallel
    // executions won't interleave mid-entry.
  } catch (err) {
    console.error('[docker] Failed to write execution log:', err);
  }
}

// =============================================================================
// INPUT NORMALIZER
// =============================================================================
// Users provide stdin in many natural formats; we normalize them all to the
// format every language's input() / scanf / cin expects: one token per line.
//
// HOW Python's input() WORKS INTERNALLY:
//   input() calls sys.stdin.readline() under the hood, which reads bytes from
//   file descriptor 0 (stdin) until it encounters '\n' or EOF.
//   So for TWO input() calls, stdin must have TWO newline-terminated lines:
//     "Aman\n25\n"
//
// THE PROBLEM WITH SPACE-SEPARATED INPUT:
//   If the user types "Aman 25" (one line), Python's first input() call reads
//   the entire line "Aman 25" as a single string. The second input() blocks
//   forever waiting for another line that never comes → the container hangs
//   until the 10-second timeout fires.
//
// OUR STRATEGY — tokenize on ANY whitespace, rejoin with '\n':
//   "Aman 25"    → ["Aman", "25"] → "Aman\n25\n"   ✓
//   "Aman\n25"   → ["Aman", "25"] → "Aman\n25\n"   ✓ (same result)
//   "Aman\n\n25" → ["Aman", "25"] → "Aman\n25\n"   ✓ (blank lines collapsed)
//   "1 2 3 4 5"  → ["1","2","3","4","5"] → "1\n2\n3\n4\n5\n"  ✓
//
// This matches how competitive programming judges (Codeforces, LeetCode) feed
// stdin — all whitespace (spaces, tabs, newlines) is treated equivalently as
// a token separator.
function normalizeInput(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  return tokens.join('\n') + '\n';
}

interface CgroupMetrics {
  cpuUsec: number;
  memoryBytes: number;
}

// Helper to query CPU usage (microseconds) and peak memory usage (bytes) from cgroups v2.
async function getCgroupMetrics(container: Docker.Container): Promise<CgroupMetrics> {
  try {
    const exec = await container.exec({
      Cmd: ['cat', '/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/memory.peak'],
      AttachStdout: true,
      AttachStderr: false
    });
    const stream = await exec.start({ hijack: true });
    const output = await new Promise<string>((resolve) => {
      let data = '';
      const writable = new Writable({
        write(chunk, encoding, callback) {
          data += chunk.toString('utf8');
          callback();
        }
      });
      container.modem.demuxStream(stream, writable, writable);
      stream.on('end', () => resolve(data));
    });
    const lines = output.trim().split('\n');
    let cpuUsec = 0;
    let memoryBytes = 0;
    for (const line of lines) {
      if (line.startsWith('usage_usec')) {
        cpuUsec = parseInt(line.split(/\s+/)[1] || '0', 10);
      }
    }
    const lastLine = lines[lines.length - 1];
    if (lastLine && /^\d+$/.test(lastLine.trim())) {
      memoryBytes = parseInt(lastLine.trim(), 10);
    }
    return { cpuUsec, memoryBytes };
  } catch (e) {
    return { cpuUsec: 0, memoryBytes: 0 };
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================
// Entry point called by the Express route handler (workspace.ts).
// Orchestrates: pool pop → code injection → execution → cleanup → logging.
export async function executeCode(
  code: string,
  language: string,
  input?: string
): Promise<ExecutionResult> {
  const config = CONFIGS[language];
  if (!config) {
    return {
      output: `Error: Unsupported language "${language}". Supported: ${Object.keys(CONFIGS).join(', ')}.`,
      durationMs: 0,
      exitCode: -1,
      oomKilled: false
    };
  }

  try {
    const result = await runInDocker(language, code, config.filename, config.cmd, input, 10_000);
    await logRequest(language, code, input, result.output);
    return result;
  } catch (error: any) {
    // runInDocker throws a plain object (not an Error instance) so we can
    // pass typed fields without TypeScript narrowing issues:
    //   { killed: true,  stdout: string, stderr: string }          → timeout
    //   { killed: false, stdout: string, stderr: string, message } → runtime error
    const errorMsg = error.killed
      ? (error.stdout || '') + '\n[Error] Execution timed out (10 000 ms).'
      : (error.stdout || '') + (error.stderr || error.message || 'Unknown execution error');
    await logRequest(language, code, input, errorMsg);
    return {
      output: errorMsg.trimEnd(),
      durationMs: error.durationMs ?? 0,
      exitCode: error.exitCode ?? -1,
      oomKilled: error.oomKilled ?? false,
      cpuUsagePercent: error.cpuUsagePercent ?? 0,
      memoryUsageBytes: error.memoryUsageBytes ?? 0
    };
  }
}

// =============================================================================
// CORE DOCKER RUNNER — Warm Pool + Exec Injection Pipeline
// =============================================================================
//
// WHY A PLAIN async FUNCTION INSTEAD OF new Promise(async executor)?
//   The "new Promise(async executor)" pattern is an anti-pattern because:
//   If the async executor throws SYNCHRONOUSLY before the first `await`,
//   the Promise constructor catches it internally but does nothing with it —
//   the outer promise stays pending forever (memory leak + hang).
//   A plain async function propagates all throws as rejected promises, which
//   the caller can catch with try/catch or .catch().
//
// EXECUTION LIFECYCLE (warm pool flow):
//   1. Pop warm container from pool         → ~0ms (container already running)
//   2. Inject code via `docker exec cat >`  → ~10ms (stream write over socket)
//   3. Execute run command via `docker exec` → ~runtime (user code execution)
//   4. Parse multiplexed stdout/stderr      → concurrent with step 3
//   5. Race execution against timeout       → 10s hard cap
//   6. Inspect exec exit code + OOM status  → ~5ms (Docker API call)
//   7. Remove container (fire-and-forget)   → async, doesn't block response
//
// WHY `docker exec` INSTEAD OF BIND MOUNTS?
//   The previous approach bind-mounted a host temp file into the container:
//     Binds: ['/host/temp/code.py:/app/code.py:ro']
//   Problems with bind mounts:
//     1. Exposes host filesystem paths to the container (information leak)
//     2. Requires a host-side temp directory (disk I/O + cleanup complexity)
//     3. On macOS with Docker Desktop, bind mounts go through a FUSE layer
//        (osxfs/virtiofs) that adds 5–20ms latency per file operation
//     4. Temp file cleanup on crashes is error-prone (orphaned files)
//   `docker exec` streams code directly into the container over the Docker
//   socket — no host filesystem involvement at all.
//
async function runInDocker(
  language: string,
  code: string,
  filename: string,
  cmd: string[],
  input: string | undefined,
  timeoutMs: number
): Promise<ExecutionResult> {
  let container: Docker.Container | null = null;
  const startTime = performance.now();

  let maxMemory = 0;
  let peakCpuPercent = 0.0;
  let startMetrics: CgroupMetrics | null = null;
  let runStartTime = 0;

  // Hoisted outside try so the catch block can include partial output
  // captured before a timeout or runtime crash.
  let stdoutData = '';
  let stderrData = '';

  try {
    // -------------------------------------------------------------------------
    // STEP 1: Pop a pre-warmed container from the pool
    // -------------------------------------------------------------------------
    // The container is already running `sleep infinity` (see pool.ts).
    // If the pool is empty (burst traffic), this falls back to creating
    // a container on-demand (~600ms penalty).
    const warm = await warmPoolManager.popContainer(language);
    container = warm.container;

    // -------------------------------------------------------------------------
    // STEP 2: Inject user code into the container via `docker exec`
    // -------------------------------------------------------------------------
    // We use `cat > /app/<filename>` to write the code into the container's
    // tmpfs-backed /app directory. The code is streamed over stdin using
    // Docker's hijacked stream protocol.
    //
    // WHY `cat >` INSTEAD OF `docker cp`?
    //   `docker cp` requires the Docker daemon to create a tar archive,
    //   transfer it, and extract it. For a single small file (~1 KB of code),
    //   the tar overhead is wasteful. `cat >` with stdin streaming is the
    //   simplest and fastest way to write a single file into a container.
    //
    // WHY `hijack: true`?
    //   Docker's exec API supports two stream modes:
    //     1. Non-hijacked: Docker handles framing and buffering internally.
    //        You get a Node.js stream that Docker writes to.
    //     2. Hijacked: You get raw access to the Docker socket's TCP/Unix
    //        stream. This lets you write stdin AND read stdout/stderr on
    //        the same connection (full-duplex). Required when AttachStdin=true.
    //   We use hijack mode because we need to write the code via stdin.
    const execWrite = await container.exec({
      Cmd: ['sh', '-c', `cat > /app/${filename}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true
    });
    const writeStream = await execWrite.start({ hijack: true, stdin: true });
    writeStream.write(code);
    writeStream.end();

    // Wait for the write stream to fully flush and close.
    // Without this await, we'd proceed to step 3 before the file is fully
    // written, causing a race condition where the run command reads a
    // partially-written or empty file.
    await new Promise<void>((resolve, reject) => {
      writeStream.on('end', () => resolve());
      writeStream.on('error', (err) => reject(err));
    });

    // Fetch initial cgroup CPU and Memory usage metrics before executing code
    startMetrics = await getCgroupMetrics(container);
    runStartTime = performance.now();

    // -------------------------------------------------------------------------
    // STEP 3: Execute the user's code inside the container
    // -------------------------------------------------------------------------
    // This is the actual code execution. The command varies by language
    // (e.g., `python /app/code.py` or `sh -c 'gcc ... && ./code.out'`).
    const execRun = await container.exec({
      Cmd: cmd,
      AttachStdin: true,    // Needed to pipe user-provided stdin input
      AttachStdout: true,   // Capture program's stdout
      AttachStderr: true,   // Capture program's stderr (errors, warnings)
      Tty: false            // Multiplexed stream mode (see frame parser below)
    });

    const execStream = await execRun.start({
      hijack: true,
      stdin: true
    });

    // -------------------------------------------------------------------------
    // STEP 4: Parse the Docker multiplexed stream (stdout + stderr frames)
    // -------------------------------------------------------------------------
    //
    // WHY DO WE NEED A CUSTOM FRAME PARSER?
    //   When Tty=false, Docker's exec API uses a multiplexed binary protocol
    //   to separate stdout and stderr on a single bidirectional stream.
    //   Each frame has an 8-byte header:
    //
    //     Byte 0:     Stream type — 1 = stdout, 2 = stderr
    //     Bytes 1-3:  Padding (always 0x00 0x00 0x00)
    //     Bytes 4-7:  Payload size (big-endian uint32)
    //     Bytes 8+:   Payload data (the actual output text)
    //
    //   Example: a "Hello\n" on stdout would arrive as:
    //     [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, H, e, l, l, o, \n]
    //     │      │                  │                       └─ payload (6 bytes)
    //     │      └─ padding         └─ size = 6
    //     └─ stdout
    //
    //   Dockerode does NOT parse this protocol automatically when using
    //   hijacked streams. We must parse it ourselves to correctly separate
    //   stdout from stderr and to avoid returning binary frame headers as
    //   part of the user-visible output.
    //
    // ALIGNMENT SCAN (the first while loop):
    //   In some Docker versions / connection states, the stream may begin
    //   mid-frame or with garbage bytes. The first while loop scans forward
    //   byte-by-byte until it finds a valid frame header (byte 0 is 1 or 2,
    //   bytes 1-3 are 0x00). This self-synchronizes the parser to the frame
    //   boundary. In normal operation, the stream starts frame-aligned and
    //   this loop doesn't execute at all.
    //
    let outputBytes = 0;
    let outputCapped = false;
    let frameBuffer = Buffer.alloc(0);

    execStream.on('data', (chunk: Buffer) => {
      frameBuffer = Buffer.concat([frameBuffer, chunk]);

      // --- ALIGNMENT SCAN: find the first valid frame header ---
      while (frameBuffer.length >= 4) {
        const b0 = frameBuffer[0];
        if ((b0 === 1 || b0 === 2) &&
            frameBuffer[1] === 0 &&
            frameBuffer[2] === 0 &&
            frameBuffer[3] === 0) {
          break;  // Found a valid header — proceed to frame parsing
        }
        frameBuffer = frameBuffer.slice(1);  // Discard one byte and retry
      }

      // --- FRAME PARSER: extract payload from complete frames ---
      while (frameBuffer.length >= 8) {
        const streamType  = frameBuffer[0];          // 1=stdout, 2=stderr
        const payloadSize = frameBuffer.readUInt32BE(4); // bytes 4-7, big-endian

        // Wait for the full payload to arrive before parsing
        if (frameBuffer.length < 8 + payloadSize) break;

        if (streamType === 1 || streamType === 2) {
          const payload = frameBuffer.slice(8, 8 + payloadSize).toString('utf8');
          // Enforce the MAX_OUTPUT_BYTES cap to prevent memory exhaustion
          // from programs that print in infinite loops.
          if (outputBytes < MAX_OUTPUT_BYTES) {
            outputBytes += Buffer.byteLength(payload, 'utf8');
            if (streamType === 1) stdoutData += payload;  // stdout
            else                  stderrData += payload;  // stderr
          } else {
            outputCapped = true;
          }
        }
        // Advance past this frame to the next one
        frameBuffer = frameBuffer.slice(8 + payloadSize);
      }
    });

    execStream.on('error', (err) => {
      stderrData += err.message;
    });

    // -------------------------------------------------------------------------
    // STEP 4b: Feed user-provided stdin input to the running program
    // -------------------------------------------------------------------------
    // If the user provided input (e.g., for programs using input() or scanf),
    // write it to the exec stream's stdin. normalizeInput() converts any
    // whitespace-separated format to newline-separated tokens.
    if (input) {
      execStream.write(normalizeInput(input));
    }
    // End stdin to signal EOF. Without this, programs waiting for input
    // (e.g., a bare input() call) would hang until the timeout fires.
    execStream.end();

    // -------------------------------------------------------------------------
    // STEP 5: Race execution against the hard timeout
    // -------------------------------------------------------------------------
    // Promise.race ensures we never wait longer than timeoutMs for the
    // program to complete. If the timeout fires first, we reject with
    // { killed: true } which the catch block converts into a user-friendly
    // timeout error message.
    //
    // WHY 10 SECONDS?
    //   Short enough to prevent resource exhaustion from infinite loops.
    //   Long enough for most educational/interview code (sorting algorithms,
    //   dynamic programming, etc.) to complete. Competitive programming
    //   judges typically use 1–5 seconds, but we're more lenient for
    //   learning-oriented use cases.
    let timeoutId: NodeJS.Timeout | null = null;
    const runPromise = new Promise<void>((resolve, reject) => {
      execStream.on('end', () => resolve());
      execStream.on('error', (err) => reject(err));
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject({ killed: true });
      }, timeoutMs);
    });

    await Promise.race([runPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);

    // Fetch final cgroup CPU and Memory usage metrics after execution completed
    const runEndTime = performance.now();
    const endMetrics = await getCgroupMetrics(container);
    maxMemory = endMetrics.memoryBytes;
    const cpuDurationMs = runEndTime - runStartTime;
    const rawCpuDeltaUsec = endMetrics.cpuUsec - (startMetrics?.cpuUsec || 0);
    let overheadUsec = 12_000;
    if (language === 'python') overheadUsec = 40_000;
    else if (language === 'javascript') overheadUsec = 60_000;
    const adjustedCpuUsec = Math.max(0, rawCpuDeltaUsec - overheadUsec);
    const durationUsec = cpuDurationMs * 1000;
    const rawCpuPercent = durationUsec > 0 ? (adjustedCpuUsec / durationUsec) * 100 : 0.0;
    const containerLimit = 0.5; // container has 0.5 CPU core limit
    peakCpuPercent = Math.min(100.0, Math.max(0.0, rawCpuPercent / containerLimit));

    // -------------------------------------------------------------------------
    // STEP 5b: Flush the Node.js event loop microtask queue
    // -------------------------------------------------------------------------
    // After the exec stream ends, there may be pending 'data' event callbacks
    // in the microtask queue that haven't fired yet. Two setImmediate() calls
    // yield control back to the event loop twice, ensuring all queued data
    // chunks are processed before we read stdoutData/stderrData.
    //
    // WHY TWO setImmediate() AND NOT ONE?
    //   The first setImmediate drains the current I/O callback queue.
    //   The second catches any callbacks that were queued by the first batch
    //   (cascading events). In practice, one is usually enough, but two
    //   provides a safety margin against edge cases in stream teardown.
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    // -------------------------------------------------------------------------
    // STEP 6: Inspect execution results (exit code + OOM status)
    // -------------------------------------------------------------------------
    // Docker exec maintains its own exit code separate from the container's.
    // execRun.inspect() returns the exit code of the command we ran, which
    // may differ from the container's exit code (the container is still
    // running `sleep infinity` — it hasn't exited).
    const execInspect = await execRun.inspect();
    const exitCode = execInspect.ExitCode ?? -1;

    // Check if the container's cgroup memory limit was hit.
    // OOMKilled is set by the kernel's OOM killer when a process exceeds its
    // memory cgroup limit. This is a container-level flag, not exec-level,
    // because the OOM killer terminates the entire cgroup (container).
    const inspectData = await container.inspect();
    const oomKilled = inspectData.State.OOMKilled;

    const capNotice = outputCapped
      ? `\n[Warning] Output truncated at ${MAX_OUTPUT_BYTES / 1024} KB.`
      : '';

    const durationMs = performance.now() - startTime;
    return {
      output: (stdoutData + (stderrData ? '\n' + stderrData : '') + capNotice).trimEnd(),
      durationMs,
      exitCode,
      oomKilled,
      cpuUsagePercent: Number(peakCpuPercent.toFixed(2)),
      memoryUsageBytes: maxMemory
    };

  } catch (err: any) {
    // -------------------------------------------------------------------------
    // ERROR HANDLING: Timeout vs Runtime Error
    // -------------------------------------------------------------------------
    // We distinguish two failure modes:
    //   1. Timeout (err.killed === true): The program ran longer than timeoutMs.
    //      We report exit code 137 (128 + SIGKILL=9) which is the conventional
    //      exit code for processes killed by a signal.
    //   2. Runtime error: Docker API failure, container crash, or exec error.
    //      We try to inspect the container for its exit code and OOM status,
    //      but the container might already be gone (removed by another path
    //      or Docker garbage collection), so we wrap inspection in try/catch.
    // Fetch final cgroup CPU and Memory usage metrics on error
    if (container) {
      try {
        const runEndTime = performance.now();
        const endMetrics = await getCgroupMetrics(container);
        maxMemory = endMetrics.memoryBytes;
        const cpuDurationMs = runEndTime - runStartTime;
        const rawCpuDeltaUsec = endMetrics.cpuUsec - (startMetrics?.cpuUsec || 0);
        let overheadUsec = 12_000;
        if (language === 'python') overheadUsec = 40_000;
        else if (language === 'javascript') overheadUsec = 60_000;
        const adjustedCpuUsec = Math.max(0, rawCpuDeltaUsec - overheadUsec);
        const durationUsec = cpuDurationMs * 1000;
        const rawCpuPercent = durationUsec > 0 ? (adjustedCpuUsec / durationUsec) * 100 : 0.0;
        const containerLimit = 0.5;
        peakCpuPercent = Math.min(100.0, Math.max(0.0, rawCpuPercent / containerLimit));
      } catch (e) {
        // ignore
      }
    }

    const durationMs = performance.now() - startTime;
    if (err && err.killed) {
      throw {
        killed: true,
        stdout: stdoutData,
        stderr: stderrData,
        durationMs,
        exitCode: 137,
        oomKilled: false,
        cpuUsagePercent: Number(peakCpuPercent.toFixed(2)),
        memoryUsageBytes: maxMemory
      };
    }
    let containerExitCode = -1;
    let containerOomKilled = false;
    if (container) {
      try {
        const inspectData = await container.inspect();
        containerExitCode = inspectData.State.ExitCode;
        containerOomKilled = inspectData.State.OOMKilled;
      } catch {
        // Container might already be removed or in an uninspectable state.
        // Fall through with default values.
      }
    }
    throw {
      killed: false,
      stdout: stdoutData,
      stderr: stderrData,
      message: err?.message ?? String(err),
      durationMs,
      exitCode: containerExitCode !== -1 ? containerExitCode : (err?.exitCode ?? -1),
      oomKilled: containerOomKilled || (err?.oomKilled ?? false),
      cpuUsagePercent: Number(peakCpuPercent.toFixed(2)),
      memoryUsageBytes: maxMemory
    };
  } finally {
    // -------------------------------------------------------------------------
    // STEP 7: Container cleanup (fire-and-forget)
    // -------------------------------------------------------------------------
    // Force-remove the container asynchronously. We don't await this because
    // the user doesn't need to wait for cleanup to receive their output.
    //
    // WHY force:true?
    //   The container might still be running (e.g., timeout killed the exec
    //   but the `sleep infinity` process is still alive). force:true sends
    //   SIGKILL to all processes and removes the container in one API call.
    //
    // WHY .catch() INSTEAD OF try/catch?
    //   Since we're not awaiting the promise, an uncaught rejection would
    //   crash the process (unhandledRejection). The .catch() ensures cleanup
    //   errors are logged but don't affect the user's response.
    //
    // NOTE: This handles containers that were popped from the pool.
    //   Pooled (idle) containers are cleaned up separately by
    //   warmPoolManager.cleanup() on server shutdown (see pool.ts).
    if (container) {
      container.remove({ force: true }).catch((err) => {
        console.error('[docker] Asynchronous container cleanup failed:', err.message);
      });
    }
  }
}
