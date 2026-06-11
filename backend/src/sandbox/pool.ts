import Docker from 'dockerode';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// =============================================================================
// WARM CONTAINER POOL — Pre-warmed Docker Container Manager
// =============================================================================
//
// PURPOSE:
//   Eliminate cold-start container creation latency by maintaining a pool of
//   pre-created, already-running Docker containers. When a user submits code,
//   we pop an idle container from the pool instead of creating one from scratch.
//
// WHY IS THIS NECESSARY?
//   Docker container creation involves multiple kernel calls:
//     1. Image layer assembly (overlay2 union mount)
//     2. Namespace creation (PID, NET, MNT, IPC, UTS)
//     3. cgroup setup (memory, cpu, pids controllers)
//     4. Network namespace configuration
//     5. Process fork + exec of the container init
//   On a typical machine, this takes 400–800ms. For an interactive IDE where
//   users expect instant feedback (like hitting "Run" in VS Code), this
//   latency makes the experience feel sluggish.
//
// HOW THE POOL WORKS:
//   ┌─────────────────────────────────────────────────────────────────┐
//   │  Server Boot                                                    │
//   │    └─→ initializePools()                                        │
//   │         └─→ For each language, create POOL_SIZE containers      │
//   │              Each container runs `sleep infinity` (idle, alive)  │
//   ├─────────────────────────────────────────────────────────────────┤
//   │  User Request ("Run Python code")                               │
//   │    └─→ popContainer('python')                                   │
//   │         ├─→ Shift one container from pools['python']            │
//   │         ├─→ Return it immediately (~0ms instead of ~600ms)      │
//   │         └─→ Fire-and-forget: fillPool('python') to replenish    │
//   ├─────────────────────────────────────────────────────────────────┤
//   │  Server Shutdown (SIGINT / SIGTERM)                             │
//   │    └─→ cleanup()                                                │
//   │         └─→ Force-remove all pooled containers to prevent leaks │
//   └─────────────────────────────────────────────────────────────────┘
//
// PERFORMANCE IMPACT:
//   Without pool: User waits ~600ms (container create + start) before code
//                 even begins executing. Total response time ≈ 600ms + runtime.
//   With pool:    Container is already running. We inject code via `docker exec`
//                 and execute immediately. Total overhead ≈ 10–50ms.
//
// TRADEOFF — MEMORY vs LATENCY:
//   Each idle container consumes a small amount of host memory (~5–15 MB for
//   Alpine-based images, ~30–50 MB for gcc:12). With POOL_SIZE=2 and 5 languages,
//   that's 10 containers ≈ 100–300 MB of idle RAM. This is an acceptable tradeoff
//   for sub-100ms response times in an interactive IDE.
//
// =============================================================================

// =============================================================================
// DOCKER DAEMON CONNECTION
// =============================================================================
//
// The Docker daemon (dockerd) exposes its API over a Unix domain socket.
// On Linux this is always /var/run/docker.sock.
// On macOS with Docker Desktop, the socket location varies by version:
//   - Older versions: /var/run/docker.sock (symlinked by Docker Desktop)
//   - Newer versions: ~/.docker/run/docker.sock (no symlink)
//
// We probe the macOS-specific path first, falling back to the standard Linux
// path. This avoids "connect ENOENT" errors on macOS Docker Desktop ≥4.18
// where the /var/run/docker.sock symlink was removed.
const homeDir = process.env.HOME || '';
const defaultMacSocket = path.join(homeDir, '.docker/run/docker.sock');
const finalSocketPath = process.platform === 'darwin' && existsSync(defaultMacSocket)
  ? defaultMacSocket
  : '/var/run/docker.sock';

// Exported so docker.ts can reuse the same Dockerode instance.
// Creating multiple Dockerode instances is harmless (they're stateless HTTP
// clients), but sharing one avoids redundant configuration and makes it clear
// there's a single connection path to the daemon.
export const docker = new Docker({ socketPath: finalSocketPath });

// =============================================================================
// TYPES
// =============================================================================

export interface WarmContainer {
  container: Docker.Container;  // Dockerode container handle (wraps container ID)
  id: string;                   // Docker container ID (64-char hex SHA-256 prefix)
}

// =============================================================================
// POOL CONFIGURATION
// =============================================================================

// Number of pre-warmed containers to maintain per language.
//
// WHY 2 AND NOT 1?
//   If POOL_SIZE=1, a user request pops the only container, leaving the pool
//   empty. If a second request arrives before the background replenishment
//   finishes (~600ms), it falls through to on-demand creation — defeating the
//   purpose of the pool. POOL_SIZE=2 gives us a buffer: the first request is
//   instant, and the second still has a warm container while the pool refills.
//
// WHY NOT 5 OR 10?
//   More idle containers = more host RAM consumed for no benefit when traffic
//   is low. For a single-server IDE, 2 provides headroom without waste.
//   In production with high concurrency, this should be tuned based on
//   request rate per language (e.g., POOL_SIZE = ceil(RPS * avg_create_time)).
const POOL_SIZE = 2;

// =============================================================================
// TERMINAL POOL CONFIGURATION
// =============================================================================
//
// WHY A SEPARATE POOL FOR TERMINALS?
//   Interactive terminals are held open for minutes, not seconds. That means
//   their containers are occupied much longer than code-execution containers,
//   so the pool needs its own sizing policy and replenishment strategy.
//
// POOL SIZE POLICY:
//   - MIN: keeps at least one container warm so the first shell is instant
//   - MAX: caps idle memory usage when many terminals are open
//   - TARGET: grows/shrinks with the number of active sessions
//
// DIFFERENCE TABLE — EXECUTION POOL VS TERMINAL POOL:
//   ┌──────────────────────┬──────────────────────────────┬──────────────────────────────┐
//   │ Aspect               │ Code Execution Pool          │ Terminal Pool                │
//   ├──────────────────────┼──────────────────────────────┼──────────────────────────────┤
//   │ Container lifetime   │ Single run, then discard     │ Session-bound, minutes long  │
//   │ Target image         │ Language-specific images     │ Generic Alpine shell image   │
//   │ Pool sizing          │ Fixed per language           │ Dynamic based on active users │
//   │ Reuse policy         │ Never reused after run       │ Reused only while idle        │
//   │ Performance goal     │ Fast code start-up           │ Fast interactive reconnect    │
//   └──────────────────────┴──────────────────────────────┴──────────────────────────────┘
const TERMINAL_POOL_MIN = 1;
const TERMINAL_POOL_MAX = 5;
let TERMINAL_POOL_SIZE = 2;

// Languages for which we pre-warm containers.
// This must be kept in sync with CONFIGS in docker.ts.
const WARM_LANGUAGES = ['python', 'javascript', 'cpp', 'c', 'bash'];

// Language → Docker image mapping.
// Duplicated from docker.ts intentionally: pool.ts is a standalone module that
// should not import from docker.ts (circular dependency risk, since docker.ts
// imports from pool.ts). The duplication is a conscious tradeoff — changing a
// language image requires updating both files, but avoids import cycles.
const IMAGE_CONFIGS: Record<string, string> = {
  python: 'python:3.10-alpine',
  javascript: 'node:20-alpine',
  cpp: 'gcc:12',
  c: 'gcc:12',
  bash: 'alpine:3.18'
};

// Terminal sandbox dev environment image pre-installed with Node, NPM, Python, GCC, Git, Curl, Bash
const TERMINAL_IMAGE = 'sandbox-dev-env:v2';

// =============================================================================
// WARM POOL MANAGER
// =============================================================================
//
// Manages the lifecycle of pre-warmed containers: creation, allocation,
// replenishment, and cleanup.
//
// THREAD SAFETY / CONCURRENCY:
//   Node.js is single-threaded (event loop), so there are no true data races
//   on `this.pools`. However, async operations (container creation) can
//   interleave. The `this.replenishing` guard prevents two concurrent
//   fillPool() calls from over-allocating containers for the same language.
//
class WarmPoolManager {
  // Pool storage: language → array of idle, started containers.
  // Array is used as a FIFO queue: push() to add, shift() to remove.
  // FIFO ensures the oldest container is used first, which helps with
  // container age distribution and keeps idle resource usage predictable.
  private pools: Record<string, WarmContainer[]> = {};

  // Dedicated pool for interactive terminal sessions.
  private terminalPool: WarmContainer[] = [];
  
  // Track active terminal sessions so we can scale the warm pool target size.
  private activeTerminalSessions = 0;

  // Concurrency guard: prevents parallel fillPool() calls for the same
  // language from creating more containers than POOL_SIZE.
  //
  // WHY IS THIS NEEDED?
  //   Scenario without guard:
  //     1. Request A pops last python container → pool empty
  //     2. fillPool('python') starts, begins creating container #1
  //     3. Request B arrives, pool is still empty → falls back to on-demand
  //     4. Request B also triggers fillPool('python')
  //     5. Now TWO fillPool() calls are running concurrently
  //     6. Both create POOL_SIZE containers → pool ends up with 2×POOL_SIZE
  //   With the guard, step 4's fillPool() sees replenishing=true and returns
  //   immediately, preventing over-allocation.
  private replenishing: Record<string, boolean> = {};
  private replenishingTerminal: boolean = false;

  constructor() {
    for (const lang of WARM_LANGUAGES) {
      this.pools[lang] = [];
      this.replenishing[lang] = false;
    }
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Initialize all pools on server startup
  // ---------------------------------------------------------------------------
  // Called once from server.ts after the HTTP server starts listening.
  // Creates POOL_SIZE containers for each language in parallel.
  //
  // WHY PARALLEL (Promise.all) AND NOT SEQUENTIAL?
  //   Creating 10 containers sequentially at ~600ms each = ~6 seconds of
  //   startup time. In parallel, all 10 creation requests hit the Docker
  //   daemon concurrently, and total time ≈ max(individual times) ≈ 600ms–1s.
  //
  // FAILURE MODE:
  //   If one language's pool fails to initialize (e.g., image not pulled),
  //   Promise.all rejects and the error propagates to server.ts which logs it.
  //   The server still starts — failed languages will fall back to on-demand
  //   container creation (slower but functional).
  private async ensureTerminalImageExists(): Promise<void> {
    const imageName = 'sandbox-dev-env:v2';
    try {
      await docker.getImage(imageName).inspect();
      console.log('[WarmPool] Terminal developer sandbox image is already built and ready.');
    } catch (err) {
      console.log('[WarmPool] sandbox-dev-env:v2 does not exist, building image now...');
      const dockerfileContent = `FROM alpine:3.18
RUN apk add --no-cache \
    nodejs \
    npm \
    python3 \
    py3-pip \
    g++ \
    gcc \
    make \
    libc-dev \
    git \
    curl \
    bash
RUN mkdir -p /viewer_bin && \
    ln -s /bin/busybox /viewer_bin/ls && \
    ln -s /bin/busybox /viewer_bin/cat && \
    ln -s /bin/busybox /viewer_bin/echo && \
    ln -s /bin/busybox /viewer_bin/pwd && \
    ln -s /bin/busybox /viewer_bin/clear && \
    ln -s /bin/busybox /viewer_bin/grep
WORKDIR /app
`;
      try {
        execSync('docker build -t sandbox-dev-env:v2 -', { input: dockerfileContent, stdio: 'pipe' });
        console.log('[WarmPool] Terminal developer sandbox image built successfully.');
      } catch (buildErr: any) {
        console.error('[WarmPool] Failed to build custom terminal developer sandbox image:', buildErr.message);
        throw buildErr;
      }
    }
  }

  public async initializePools(): Promise<void> {
    console.log('[WarmPool] Initializing warm container pools...');
    
    // Ensure the terminal sandbox developer environment image exists
    await this.ensureTerminalImageExists();

    const promises = [
      ...WARM_LANGUAGES.map((lang) => this.fillPool(lang)),
      this.fillTerminalPool()
    ];
    await Promise.all(promises);
    console.log('[WarmPool] All pools initialized successfully.');
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Pop a warm container for code execution
  // ---------------------------------------------------------------------------
  // Called by docker.ts when a user submits code. Returns a pre-warmed container
  // that is already running and ready to accept `docker exec` commands.
  //
  // IMPORTANT: The caller (docker.ts) is responsible for removing the container
  // after use via container.remove({ force: true }). Warm containers are
  // single-use — once code runs in them, they are discarded (not returned to
  // the pool) to prevent state leakage between user executions.
  //
  // FALLBACK BEHAVIOR:
  //   If the pool is empty (burst traffic or initialization failure), we create
  //   a container on-demand synchronously. This is the same ~600ms path as
  //   the pre-pool architecture, ensuring we never fail a request — just
  //   serve it slower.
  public async popContainer(lang: string): Promise<WarmContainer> {
    const pool = this.pools[lang];
    if (!pool || pool.length === 0) {
      console.warn(`[WarmPool] Pool for ${lang} is empty! Falling back to on-demand container creation.`);
      return this.createWarmContainer(lang);
    }

    // shift() removes from the front of the array (FIFO — oldest first).
    const warmContainer = pool.shift()!;

    // Trigger background replenishment immediately after popping.
    // This runs asynchronously — the user's request doesn't wait for it.
    // The .catch() ensures replenishment errors don't become unhandled
    // promise rejections (which would crash Node.js in strict mode).
    this.fillPool(lang).catch((err) => {
      console.error(`[WarmPool] Failed to replenish pool for ${lang}:`, err.message);
    });

    return warmContainer;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: Replenish a language's pool to POOL_SIZE
  // ---------------------------------------------------------------------------
  // Creates containers one at a time until pool.length === POOL_SIZE.
  //
  // WHY SEQUENTIAL CREATION (not parallel)?
  //   This runs in the background after a user request. Creating containers
  //   one-by-one reduces instantaneous load on the Docker daemon and avoids
  //   CPU spikes on the host. The user is already served; there's no urgency
  //   to fill the pool as fast as possible.
  //
  // CONCURRENCY GUARD:
  //   The `replenishing` flag ensures only one fillPool() call per language
  //   is active at any time. See the class-level comment for the race scenario.
  private async fillPool(lang: string): Promise<void> {
    if (this.replenishing[lang]) return;
    this.replenishing[lang] = true;

    try {
      const pool = this.pools[lang];
      if (pool) {
        while (pool.length < POOL_SIZE) {
          console.log(`[WarmPool] Creating warm container for ${lang} (${pool.length + 1}/${POOL_SIZE})...`);
          const warm = await this.createWarmContainer(lang);
          pool.push(warm);
        }
      }
    } finally {
      // Always reset the flag, even if creation throws.
      // Otherwise, a transient Docker error would permanently block
      // replenishment for this language until server restart.
      this.replenishing[lang] = false;
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: Create a single warm container
  // ---------------------------------------------------------------------------
  // Creates a Docker container with full security hardening, starts it, and
  // returns a handle. The container runs `sleep infinity` — an idle process
  // that keeps the container alive indefinitely until we exec into it.
  //
  // WHY `sleep infinity` INSTEAD OF THE ACTUAL LANGUAGE RUNTIME?
  //   We don't know what command the user will run yet. The container needs
  //   to stay alive and generic. `sleep infinity` is a POSIX-compatible way
  //   to keep a process running with near-zero CPU usage. When docker.ts
  //   receives user code, it uses `docker exec` to run the actual command
  //   (e.g., `python /app/code.py`) inside this already-running container.
  //
  // SECURITY CONFIGURATION — DEFENSE IN DEPTH:
  //   Each layer below addresses a specific attack vector:
  //
  //   ┌─────────────────────────┬────────────────────────────────────────┐
  //   │ Setting                 │ What it prevents                       │
  //   ├─────────────────────────┼────────────────────────────────────────┤
  //   │ Memory: 100 MB          │ Memory exhaustion (malloc bombs)       │
  //   │ MemorySwap: 100 MB      │ Swap abuse (swap = RAM - RAM = 0)      │
  //   │ NanoCpus: 0.5 vCPU      │ CPU starvation of host/other users     │
  //   │ PidsLimit: 50           │ Fork bombs (exponential process spawn)  │
  //   │ NetworkMode: 'none'     │ Data exfiltration, reverse shells       │
  //   │ ReadonlyRootfs: true    │ Filesystem tampering, persistence       │
  //   │ Tmpfs /app (rw,exec)    │ N/A — allows code write + binary exec  │
  //   │ Tmpfs /tmp (rw,exec)    │ N/A — allows compiler temp files        │
  //   └─────────────────────────┴────────────────────────────────────────┘
  //
  //   ReadonlyRootfs + Tmpfs EXPLAINED:
  //     ReadonlyRootfs makes the entire container filesystem read-only.
  //     This prevents malicious code from modifying system binaries, planting
  //     backdoors, or persisting state between executions.
  //
  //     But we NEED writable directories for:
  //       /app — where we inject the user's code file (via `docker exec cat >`)
  //       /tmp — where compilers write intermediate files (e.g., g++ temp .o files)
  //
  //     Tmpfs mounts solve this: they create in-memory filesystems (backed by
  //     RAM, not disk) that are writable but vanish when the container is removed.
  //     The `size=10m` cap prevents a user from filling host RAM via file writes.
  //
  //   WHY `exec` FLAG ON TMPFS?
  //     By default, tmpfs mounts have the `noexec` flag — the kernel refuses
  //     to execute any binary stored there (EACCES on execve() syscall).
  //     For interpreted languages (Python, JS, Bash), this doesn't matter
  //     because the interpreter binary lives on the read-only rootfs.
  //     But for C/C++, the compilation output (/app/code.out) is a native ELF
  //     binary stored on the tmpfs mount. Without `exec`, running it would fail
  //     with "Permission denied". The `exec` flag allows binary execution on
  //     tmpfs — a necessary tradeoff for compiled language support.
  //
  private async createWarmContainer(lang: string): Promise<WarmContainer> {
    const image = IMAGE_CONFIGS[lang];
    if (!image) {
      throw new Error(`Unsupported pool language: ${lang}`);
    }

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['sh', '-c', 'sleep infinity'],
      // --- RESOURCE LIMITS (cgroup v2 controllers) ---
      HostConfig: {
        Memory: 100 * 1024 * 1024,     // 100 MB RAM hard limit (OOM killer fires beyond this)
        MemorySwap: 100 * 1024 * 1024, // Total memory+swap = 100 MB → effective swap = 0
        NanoCpus: 500_000_000,         // 0.5 vCPU (CFS quota: 500ms per 1000ms period)
        PidsLimit: 50,                 // Max 50 processes/threads (fork bomb ceiling)
        NetworkMode: 'none',           // No network interfaces (not even loopback in some configs)
        // --- FILESYSTEM SECURITY ---
        ReadonlyRootfs: true,          // Immutable root filesystem (prevent tampering)
        Tmpfs: {
          '/app': 'rw,exec,size=10m',  // Writable+executable in-memory mount for user code
          '/tmp': 'rw,exec,size=10m'   // Writable+executable in-memory mount for compiler temps
        }
      },
      // --- STREAM CONFIGURATION ---
      // These flags configure the container's stdio file descriptors.
      // We need stdin attached and open so that `docker exec` commands can
      // stream data into the running process (e.g., piping user code via cat,
      // or feeding stdin input to the user's program).
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      // Tty: false — We do NOT allocate a pseudo-terminal.
      // WHY?
      //   With Tty:true, Docker multiplexes stdout and stderr into a single
      //   stream (the TTY). We lose the ability to distinguish between them.
      //   With Tty:false, Docker uses a multiplexed stream protocol where each
      //   frame has an 8-byte header: [stream_type(1), padding(3), size(4)].
      //   stream_type=1 is stdout, stream_type=2 is stderr. This lets us
      //   parse and separate stdout/stderr in docker.ts's frame parser.
      Tty: false
    });

    await container.start();
    return {
      container,
      id: container.id
    };
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Pop a terminal container for interactive shell sessions
  // ---------------------------------------------------------------------------
  //
  // WHY THIS IS DIFFERENT FROM code execution:
  //   Terminal containers stay attached to a WebSocket session for as long as
  //   the user keeps the shell open. We therefore keep them warm, but we also
  //   replenish and resize the pool more conservatively than the execution path.
  public async popTerminalContainer(): Promise<WarmContainer> {
    // Increment active session counter for dynamic pool sizing
    this.activeTerminalSessions++;
    this.adjustTerminalPoolSize();

    if (this.terminalPool.length === 0) {
      console.warn('[WarmPool] Terminal pool is empty! Falling back to on-demand container creation.');
      const container = await this.createTerminalContainer();
      
      // If the pool is empty, replenish immediately so the next session is warm.
      this.fillTerminalPool().catch((err) => {
        console.error('[WarmPool] Failed to replenish terminal pool:', err.message);
      });
      
      return container;
    }

    const warmContainer = this.terminalPool.shift()!;

    // Refill in the background so the next terminal connect stays fast.
    this.fillTerminalPool().catch((err) => {
      console.error('[WarmPool] Failed to replenish terminal pool:', err.message);
    });

    return warmContainer;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Mark a terminal session as closed for pool optimization
  // ---------------------------------------------------------------------------
  public releaseTerminalContainer(): void {
    if (this.activeTerminalSessions > 0) {
      this.activeTerminalSessions--;
      this.adjustTerminalPoolSize();
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: Dynamically adjust terminal pool target size
  // ---------------------------------------------------------------------------
  //
  // WHY active + 2?
  //   Keeping a small buffer ahead of current demand gives us room for the
  //   next connection without overshooting memory usage. The clamp preserves
  //   a floor and ceiling so the pool stays predictable under burst traffic.
  private adjustTerminalPoolSize(): void {
    const previousSize = TERMINAL_POOL_SIZE;
    
    // Keep 2 spare containers beyond active sessions
    const targetSize = Math.max(
      TERMINAL_POOL_MIN,
      Math.min(TERMINAL_POOL_MAX, this.activeTerminalSessions + 2)
    );
    
    if (targetSize !== previousSize) {
      console.log(
        `[WarmPool] Adjusting terminal pool size: ${previousSize} → ${targetSize} ` +
        `(${this.activeTerminalSessions} active sessions)`
      );
      TERMINAL_POOL_SIZE = targetSize;
      
      // Grow the pool immediately when demand rises.
      if (targetSize > previousSize) {
        this.fillTerminalPool().catch((err) => {
          console.error('[WarmPool] Failed to expand terminal pool:', err.message);
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: Replenish the terminal pool
  // ---------------------------------------------------------------------------
  private async fillTerminalPool(): Promise<void> {
    if (this.replenishingTerminal) return;
    this.replenishingTerminal = true;

    try {
      while (this.terminalPool.length < TERMINAL_POOL_SIZE) {
        console.log(`[WarmPool] Creating warm terminal container (${this.terminalPool.length + 1}/${TERMINAL_POOL_SIZE})...`);
        const warm = await this.createTerminalContainer();
        this.terminalPool.push(warm);
      }
    } finally {
      this.replenishingTerminal = false;
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: Create a single terminal container
  // ---------------------------------------------------------------------------
  //
  // Terminal containers only need a shell and a minimal filesystem. Alpine
  // keeps the image small and the cold-start path fast while still supporting
  // the `/bin/sh` session spawned by terminalHandler.ts.
  private async createTerminalContainer(): Promise<WarmContainer> {
    const HISTORY_DIR = path.join('/Users/amankashyap/Documents/sandbox/backend', 'terminal_history');
    if (!existsSync(HISTORY_DIR)) {
      try {
        mkdirSync(HISTORY_DIR, { recursive: true });
      } catch (err: any) {
        console.error('[WarmPool] Failed to create terminal history directory:', err.message);
      }
    }

    const container = await docker.createContainer({
      Image: TERMINAL_IMAGE,
      Cmd: ['sh', '-c', 'sleep infinity'],
      HostConfig: {
        Memory: 100 * 1024 * 1024,
        MemorySwap: 100 * 1024 * 1024,
        NanoCpus: 500_000_000,
        PidsLimit: 50,
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Tmpfs: {
          '/app': 'rw,exec,size=10m',
          '/tmp': 'rw,exec,size=10m'
        },
        Binds: [
          `${HISTORY_DIR}:/history`
        ]
      },
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      // Tty: true is critical here. It forces Docker to allocate a Pseudo-Terminal (PTY).
      // Without this, Docker multiplexes stdout and stderr into an 8-byte frame header
      // [TYPE, 0, 0, 0, LEN1, LEN2, LEN3, LEN4], where the length byte (e.g., 40) is
      // parsed as an ASCII character (e.g., '('), causing terminal output corruption.
      Tty: true
    });

    await container.start();
    return {
      container,
      id: container.id
    };
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Graceful shutdown cleanup
  // ---------------------------------------------------------------------------
  // Called from server.ts on SIGINT/SIGTERM.
  // Force-removes all idle containers in all pools to prevent Docker resource
  // leaks (zombie containers consuming memory and PIDs on the host).
  //
  // NOTE: This only cleans up POOLED (idle) containers. Containers that were
  // popped and are actively running user code are cleaned up by docker.ts in
  // its `finally` block (container.remove({ force: true })). Between these
  // two cleanup paths, no containers are leaked on graceful shutdown.
  //
  // ON UNGRACEFUL SHUTDOWN (kill -9, OOM kill, power loss):
  //   Orphaned containers will persist until manually removed or until Docker
  //   daemon restart. In production, a cron job or Docker's --rm flag could
  //   be used as a safety net. We don't use --rm here because we need the
  //   container to survive after creation (it's idle in the pool, not
  //   immediately executing a command that would trigger auto-removal).
  public async cleanup(): Promise<void> {
    console.log('[WarmPool] Cleaning up all warm containers...');
    
    // Clean up language-specific pools
    for (const lang of WARM_LANGUAGES) {
      const pool = this.pools[lang];
      if (pool) {
        while (pool.length > 0) {
          const warm = pool.shift()!;
          try {
            await warm.container.remove({ force: true });
          } catch (err: any) {
            console.error(`[WarmPool] Failed to remove warm container ${warm.id}:`, err.message);
          }
        }
      }
    }

    // Clean up terminal pool separately because it uses its own sizing policy.
    while (this.terminalPool.length > 0) {
      const warm = this.terminalPool.shift()!;
      try {
        await warm.container.remove({ force: true });
      } catch (err: any) {
        console.error(`[WarmPool] Failed to remove terminal container ${warm.id}:`, err.message);
      }
    }

    console.log('[WarmPool] Warm pool cleanup completed.');
  }
}

// Singleton instance — shared across the application.
// Imported by docker.ts (to pop containers) and server.ts (to initialize/cleanup).
export const warmPoolManager = new WarmPoolManager();
