# Collaborative Cloud IDE & Sandbox

A production-oriented collaborative cloud IDE and sandbox built with React, Vite, Express, PostgreSQL, Yjs, and WebSockets. The project is being developed in weekly milestones, and **Week 2 is complete**.

## Current Status

Week 2 delivered the core collaboration and offline editing features:

- **Real-Time Collaboration:** Full CRDT-based multi-user sync using Yjs, `y-websocket`, and `y-monaco`.
- **Live User Awareness:** Remote cursor tracking and selection sharing with dynamic user color tags and tooltips.
- **Durable Yjs Persistence:** Automatic, debounced binary `yjs_state` and plaintext document sync to the PostgreSQL database on file updates.
- **Offline Editing:** Seamless local persistence using IndexedDB (`y-indexeddb`) when connection is lost, automatically merging changes on reconnection.
- **Connection Status UI:** Live status indicator showing `Live Sync` (Connected), `Connecting...`, or `Offline` states.
- **Enhanced Directory & UI:** Breadcrumb folder path navigation, nested directory structuring, and inline folder/file creation in the explorer.

This README is a living document and will be updated as the project moves through later weeks.

## Tech Stack

- Frontend: React, Vite, TypeScript, Tailwind CSS
- Editor: Monaco Editor
- Collaboration: Yjs, y-websocket, y-monaco, y-indexeddb
- Backend: Node.js, Express, TypeScript
- Database: PostgreSQL
- Sandbox: Local execution for now, with Docker-based isolation planned next

## Project Structure

- `frontend/` - React client application
- `backend/` - Express API, auth, workspace routes, and execution logic
- `database/` - PostgreSQL schema and initialization scripts
- `reports/` - Architecture notes, week summaries, and roadmap documents

## Week 2 Highlights

- Added fully synchronized editing sessions via WebSockets.
- Created custom Monaco extensions to render active collaborator cursors and name badges.
- Configured IndexedDB offline backups so user edits are safe even during network drops.
- Polished the explorer and workspace UI with fluid inputs, transitions, and breadcrumbs.

## Next Milestones

- Week 3: Docker-based sandbox isolation and execution hardening
- Week 4: Polish, deployment, and interview prep

## Local Development

The exact setup may evolve, but the project is currently split into frontend and backend services.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Backend

```bash
cd backend
npm install
npm run dev
```

### Database

Use the SQL in `database/schema.sql` and the docker setup in `docker-compose.yml` to bring up PostgreSQL locally.

## Notes

- The dashboard is located at `/dashboard`.
- The IDE is located at `/ide/:workspaceId/:fileId`.
- Documents and guides for Week 1 & 2 are placed in `reports/`.
