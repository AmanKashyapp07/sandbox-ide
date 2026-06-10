# NexusIDE: Collaborative Cloud IDE & Secure Sandbox Engine

NexusIDE is a high-performance, production-grade cloud development environment engineered to support real-time distributed file synchronization, peer-to-peer multimedia workspaces, and isolated multi-tenant code execution sandboxes. 

Architected from first principles, this platform solves two critical distributed computing challenges: **Strong Eventual Consistency (SEC)** across concurrent, high-frequency text mutations, and **Multi-Tenant Secure Compute Isolation** against arbitrary or malicious code execution.

---

## 🛠 Architectural Pillars & Core Systems

### 1. Conflict-Free Concurrency & Real-Time Sync
* **Mathematical State Convergence:** Leveraging **Yjs (Conflict-free Replicated Data Types - CRDTs)** configured as a bounded join-semilattice. Every keystroke is tracked using an append-only graph of unique operational blocks mapped to absolute **Lamport Timestamps `(siteId, clock)`**. This eliminates the centralized CPU sequencing bottlenecks common in traditional Operational Transformation (OT) setups.
* **Dual-Channel Persistence Matrix:** Driven by custom backend hooks inside `y-websocket`, the server intercepts mutations and splits persistence into a dual-storage scheme:
  * **`yjs_state` (BYTEA):** Serializes the entire historical CRDT change-ledger into raw compressed binary arrays to guarantee exact timeline hydration on reconnects.
  * **`content` (TEXT):** Flattens the current view into human-readable plaintext strings, allowing the runtime execution engine to fetch scripts instantly with zero CRDT decoding overhead.
* **Asynchronous Write-Back Caching:** To insulate the PostgreSQL storage engine from Disk I/O exhaustion, document flushes are managed via an optimized, server-side debouncing layer that accumulates keystroke deltas in memory before executing parameterized SQL updates.
* **Fault-Tolerant Offline Sync:** Integrates IndexedDB client storage arrays (`y-indexeddb`) to cache transactional state matrices locally during network drops, seamlessly executing a binary state-vector synchronization handshake upon reconnection.

### 2. Real-Time P2P Voice Infrastructure (Audio)
* **Decoupled Decentralized Mesh:** Incorporates a fully decentralized **WebRTC Peer-to-Peer Mesh Network** for ultra-low latency voice/audio communication. Audio streams travel via the shortest geographical path over Secure Real-time Transport Protocols (SRTP), completely bypassing backend servers to ensure zero cloud media-routing overhead.
* **Full-Duplex Signaling Broker:** Built using **Socket.io** to manage multi-tenant room namespaces, coordinate Session Description Protocol (SDP) cryptographic handshakes (Offers/Answers), and dynamically relay Interactive Connectivity Establishment (ICE) candidates.
* **NAT Traversal Network:** Interacts with public Session Traversal Utilities for NAT (STUN) servers to crack firewalls, discover public-facing WAN IP coordinates, and map reliable direct transport pathways natively.

### 3. File System & Security Foundations
* **Adjacency List Directories:** The Workspace File Explorer maps nested directory trees in a highly relational PostgreSQL schema using self-referencing foreign keys (`parent_id REFERENCES files(id)`). This avoids heavy NoSQL collection nesting and allows the server to fetch entire folder hierarchies in a single database trip using **Recursive Common Table Expressions (CTEs)**.
* **Stateless Authorization Boundaries:** Implements cryptographically signed JSON Web Tokens (JWT) for authentication. Backed by `bcrypt` brute-force insulation on the identity gateway, the architecture remains entirely stateless to facilitate horizontal scaling behind standard network load balancers.

### 4. Sandbox Resource Diagnostics & Multi-File Execution Engine
* **Direct cgroups v2 Kernel Profiling:** Instead of host-side stats stream querying which introduces 1-2s of latency, the server executes a fast `cat /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.peak` inside the container namespace. This returns real-time CPU and peak memory metrics in under ~20ms.
* **Baseline Overhead Subtraction & Normalization:** The engine automatically subtracts language-specific runtime startup costs (Node/Python VM initialization and exec process overhead) to isolate the user script's actual CPU footprint. CPU usage is then normalized against the container's 0.5 CPU cap to display the precise percentage of allocated resources utilized.
* **In-Memory Tar Archiving & Hydration:** To support multi-file imports and module dependencies without host bind-mounting, the database files are pulled recursively via a Common Table Expression (CTE) and packaged into an in-memory tar stream, which is piped directly into `tar -xf - -C /app` in the sandbox container before code execution.
* **Custom Run Configuration Overlays:** Enables users to specify custom execution and compilation scripts via `.nexusrun` or `nexus.config.json` files in the workspace root, bypassing default single-file executors.

---

## 🏗 Tech Stack

* **Frontend:** React, Vite, TypeScript, Tailwind CSS, Monaco Editor, Xterm.js
* **Real-Time Core:** Yjs, `y-websocket`, `y-monaco`, `y-indexeddb`, Socket.io
* **Media Orchestration:** WebRTC (Native RTCPeerConnection APIs for Audio Chat)
* **Backend:** Node.js, Express, TypeScript, Raw `pg` Driver
* **Database:** PostgreSQL (with strict relational constraints)
* **Sandbox Runtime:** Local Execution via asynchronous `child_process` isolation hooks

---

## 📂 System Topology

```text
├── backend/                  # Fastify/Express API and WebSocket Protocol Orchestration
│   ├── src/
│   │   ├── middleware/       # Cryptographic JWT & Row-Level Access Controls
│   │   ├── routes/           # Stateless Authentication and Workspace Metadata Routers
│   │   ├── services/         # Code Execution Runtimes and Process Sockets
│   │   └── server.ts         # Multi-Protocol HTTP/WS Single-Port Entry Server
├── frontend/                 # React Client Application
│   ├── src/
│   │   ├── components/       # Monaco Binder, Explorer Trees, and Voice Managers
│   │   ├── hooks/            # WebRTC Peer Connection and Socket Lifecycle Triggers
│   │   └── context/          # Global Real-Time Collaboration Core States
├── database/                 # Relational Schemas & Index Initializations
└── reports/                  # Systems Architecture & Deep-Dive Specifications
```

---

## 🚀 Execution & Milestone Roadmap

### Milestone 1: The "Single Player" Base Engine (Complete)

* [x] Integrated the GitHub-themed Monaco Editor view layer.
* [x] Formulated the core PostgreSQL relational schema with cascading foreign key deletions.
* [x] Scripted local execution environments for Node.js, Python, C++, and Bash using programmatic execution wrappers.
* [x] Implemented a 2000ms hard kernel timeout utilizing `SIGTERM` kill signals to stop thread starvation.

### Milestone 2: Advanced Concurrency & Multimedia Mesh (Complete)

* [x] Configured real-time, zero-collision document syncing using multi-room Yjs partitioning.
* [x] Added visual awareness extensions to project collaborator cursor tracking coordinates and name tags into Monaco.
* [x] Completed the WebRTC P2P Mesh voice/audio chat engine with native hardware track-toggling for low-overhead audio muting.
* [x] Resolved the multi-file room memory race condition by pairing server-side `setPersistence` memory pools with `BYTEA` storage sectors.

### Milestone 3: Containerized Sandbox Isolation & Performance Diagnostics (Complete)

* [x] Transition the runtime engine from local child processes to the **Docker Engine API** via the Unix Domain Socket (`/var/run/docker.sock`).
* [x] Limit execution resource footprints programmatically via **Linux Kernel Control Groups (cgroups)** (100MB RAM, 0.5 CPU CFS cap, PIDs limit of 50).
* [x] Multiplex output streams (`stdout`/`stderr`) dynamically to push compiler updates over WebSockets in real time.
* [x] **Live Performance Diagnostics Panel**: Retrieve real-time cgroups v2 CPU and memory statistics with sub-20ms latency, cancel process initialization overhead, and display visual HSL tailored graphs and tabular execution logs.

### Milestone 4: Multi-File Workspace Execution & Custom Configurations (In Progress)

* [ ] **Pre-Execution Workspace Hydration**: Retrieve workspace folder/file hierarchies recursively using Recursive CTEs and stream them into the sandbox container via in-memory tar archiving.
* [ ] **Custom Execution Config overlays**: Add support for `.nexusrun` or `nexus.config.json` custom compilation/run commands inside the sandbox root.

---

## 💻 Local Infrastructure Deployment

### Prerequisites

* Node.js v20+
* PostgreSQL v15+

### Database Initialization

1. Spin up your local PostgreSQL engine instance.
2. Initialize the relational structures using the schema definition file:
```bash
psql -U your_user -d nexus_ide -f database/schema.sql
```

### Backend Configuration

1. Navigate to the server environment and pull dependencies:
```bash
cd backend
npm install
```

2. Create a `.env` deployment profile in the root of the backend folder:
```env
PORT=4000
DATABASE_URL=postgresql://user:password@localhost:5432/nexus_ide
JWT_SECRET=your_system_cryptographic_secret_key
```

3. Initialize the server runtime loop:
```bash
npm run dev
```

### Frontend Configuration

1. Move to the client workspace and pull dependencies:
```bash
cd frontend
npm install
```

2. Run the development bundler to open up the application interface:
```bash
npm run dev
```

3. Access the administrative panel at `/dashboard` or spin up isolated workspace files via `/ide/:workspaceId/:fileId`.