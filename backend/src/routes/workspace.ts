import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { requireWorkspaceRole, WorkspaceAuthRequest, CollaboratorRole } from '../middleware/workspaceAuth';
import { executeCode } from '../sandbox/docker';
import { getPool } from '../db';

const router = Router();

// =============================================================================
// ORCHESTRATION BACKEND & WORKSPACE ROUTER
// =============================================================================
//
// PURPOSE:
//   Serves as the main control plane REST API gateway for managing workspace
//   lifecycles, collaborator associations, directory structures (file trees),
//   and delegating code execution requests to the isolated Docker sandboxes.
//
// ARCHITECTURE & REST SYSTEM DESIGN:
//
//   1. Sub-resource Representation:
//      - The design adheres to clean REST conventions. Workspaces form the root resource,
//        and dependent elements are structured as nested sub-resources:
//          GET    /api/workspace/:id/files         (File tree query)
//          POST   /api/workspace/:id/collaborators (Collaborator enrollment)
//          POST   /api/workspace/:id/execute       (Isolated sandboxed execution)
//      - This makes the API intuitive and enforces resource boundaries early in routing.
//
//   2. Relational Schema Integrity & Cascades:
//      - Dependent entities like `files` and `workspace_collaborators` reference 
//        `workspaces(id)` with a SQL `ON DELETE CASCADE` constraint.
//      - When a workspace is deleted via DELETE /:id, we perform a single SQL deletion.
//        PostgreSQL automatically and atomically cleans up all associated files and 
//        collaborator rows. This guarantees no orphaned rows, saving manual transaction management.
//
//   3. SQL Performance: UNION vs. OR / JOIN:
//      - To populate the user's dashboard, we need workspaces they own AND workspaces they collaborate on.
//      - We use a SQL `UNION` to combine:
//        (SELECT workspaces WHERE owner_id = $1) UNION (SELECT workspaces JOIN collaborators WHERE user_id = $1)
//      - WHY UNION INSTEAD OF A JOIN WITH OR?
//        - An `OR` clause (e.g., `WHERE owner_id = $1 OR user_id = $1`) frequently confuses the
//          query optimizer, prompting it to skip B-Tree index lookups and execute a slow Full Table Scan.
//        - A `UNION` splits the lookup into two independent queries. The database engine can utilize
//          separate index scans for each query (on `owner_id` index and `user_id` index) and perform
//          a fast in-memory merge/de-duplication.
//
//   4. Atomic Database Upserts (ON CONFLICT):
//      - For adding/updating collaborators, we leverage:
//        `INSERT INTO ... ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`
//      - This avoids a "Read-Modify-Write" anti-pattern in Node.js (checking if they exist, then
//        deciding to run INSERT or UPDATE).
//      - Performing this atomically at the database layer avoids race conditions where two parallel
//        requests could cause key violations or duplicate records.
//
// SECURITY & INTERVIEW TOPICS:
//
//   - Broken Object-Level Authorization (BOLA / IDOR):
//     - The routes `/api/workspace/:id/files`, `/api/workspace/:id/collaborators`, and
//       `/api/workspace/:id/execute` are guarded by the `requireWorkspaceRole` middleware.
//     - This ensures that a authenticated user cannot simply swap out the `id` in the API URL
//       to view, edit, or execute code inside a workspace that does not belong to them or
//       is not shared with them.
//
//   - Bootstrapping & "Empty State" UX Optimization:
//     - When creating a workspace, we programmatically seed an initial `index.js` file.
//     - This provides instant visual feedback to the frontend editor, avoiding "empty editor shell-shock"
//       and enabling the user to run code immediately without manual file creation.
//
// =============================================================================

// =============================================================================
// WORKSPACE LIFECYCLE ROUTES
// =============================================================================

// GET / - Retrieve all workspaces for the authenticated user (owned + collaborated)
//
// PERFORMANCE INTERVIEW TALKING POINT (UNION vs JOIN OR):
//   Instead of:
//     SELECT * FROM workspaces w LEFT JOIN workspace_collaborators c ON w.id = c.workspace_id 
//     WHERE w.owner_id = $1 OR c.user_id = $1
//   Which forces index failures due to the OR clause, we split this into two clean queries
//   using UNION. PostgreSQL runs independent Index Scans and merges them instantly.
//   We sort by updated_at DESC to natively support a "Recent Projects" dashboard UI.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    
    const workspaces = await getPool().query(
      `SELECT w.id, w.title, w.created_at, w.updated_at, w.owner_id, 'owner' AS user_role
       FROM workspaces w 
       WHERE w.owner_id = $1 
       UNION 
       SELECT w.id, w.title, w.created_at, w.updated_at, w.owner_id, wc.role::text AS user_role
       FROM workspaces w 
       INNER JOIN workspace_collaborators wc ON w.id = wc.workspace_id 
       WHERE wc.user_id = $1
       ORDER BY updated_at DESC`,
      [userId]
    );
    res.json(workspaces.rows);
  } catch (err: any) {
    console.error('Error fetching workspaces:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - Create a new workspace or update an existing one's metadata (Rename)
//
// DESIGN CHOICE — Upsert Pattern vs Restful Separation:
//   Here we handle both creation (POST /) and renaming in a single endpoint by checking for the `id`.
//   - If ID is present: It acts as an UPDATE operation. We check credentials first (IDOR mitigation).
//   - If ID is absent: It acts as an INSERT operation. We also seed a default file (bootstrapping).
//
// SECURITY (IDOR / Metadata Protection):
//   Before updating the workspace name, we verify if the user is the owner or an admin. 
//   This prevents a collaborator with 'viewer' or 'editor' roles from modifying project settings.
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, title } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    
    try {
      let result;
      if (id) {
        // IDOR Mitigation: Check permissions on the target workspace before modifying it
        const checkRes = await getPool().query(
          `SELECT w.owner_id, wc.role 
           FROM workspaces w 
           LEFT JOIN workspace_collaborators wc ON w.id = wc.workspace_id AND wc.user_id = $2
           WHERE w.id = $1`,
          [id, userId]
        );

        if (checkRes.rows.length === 0) {
          res.status(404).json({ error: 'Workspace not found' });
          return;
        }

        const { owner_id, role } = checkRes.rows[0];
        if (owner_id !== userId && role !== 'admin') {
          res.status(403).json({ error: 'Forbidden: Requires admin role to rename workspace' });
          return;
        }

        result = await getPool().query(
          `UPDATE workspaces SET title = $1 WHERE id = $2 RETURNING *`,
          [title || 'Untitled Project', id]
        );
      } else {
        // Insert a brand new workspace
        result = await getPool().query(
          `INSERT INTO workspaces (owner_id, title) 
           VALUES ($1, $2)
           RETURNING *`,
          [userId, title || 'Untitled Project']
        );
        
        // BOOTSTRAPPING: Auto-inject a default index.js file
        // This ensures the workspace is immediately functional without requiring the user to
        // manually create their first file.
        if (result.rows.length > 0) {
          await getPool().query(
            `INSERT INTO files (workspace_id, name, type, language, content) VALUES ($1, $2, $3, $4, $5)`,
            [result.rows[0].id, 'index.js', 'file', 'javascript', '']
          );
        }
      }
      
      res.json(result.rows[0]);
    } catch (dbError) {
      console.warn("Database error during workspace creation/update:", dbError);
      res.status(500).json({ error: 'Database error' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /default - Retrieve or create a fallback workspace
//
// SYSTEM DESIGN — Zero Friction User Onboarding:
//   When a user first logs in, they need a workspace to land on. Instead of breaking the UI
//   with empty-states or demanding they click "Create Workspace", this endpoint acts as a
//   virtual onboarding hook. It returns their first workspace if it exists, or creates one on the fly.
router.get('/default', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    
    let wsResult = await getPool().query('SELECT * FROM workspaces WHERE owner_id = $1 LIMIT 1', [userId]);
    
    if (wsResult.rows.length === 0) {
      wsResult = await getPool().query(
        'INSERT INTO workspaces (owner_id, title) VALUES ($1, $2) RETURNING *',
        [userId, 'My First Sandbox']
      );
      // Bootstrap default workspace files
      await getPool().query(
        `INSERT INTO files (workspace_id, name, type, language, content) VALUES ($1, $2, $3, $4, $5)`,
        [wsResult.rows[0].id, 'index.js', 'file', 'javascript', '']
      );
    }
    res.json(wsResult.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id - Retrieve workspace metadata by ID
//
// SECURITY (BOLA Guard):
//   Guarded by requireWorkspaceRole('viewer') to prevent unauthenticated or non-permitted users
//   from inspecting private workspace records.
//   Also passes the resolved `req.workspaceRole` back to the client, allowing the frontend to dynamically
//   toggle read-only controls (e.g. graying out write buttons for viewers).
router.get('/:id', requireWorkspaceRole('viewer'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const wsResult = await getPool().query('SELECT id, title, owner_id, is_public FROM workspaces WHERE id = $1', [id]);
    
    if (wsResult.rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    
    const workspace = wsResult.rows[0];
    res.json({
      ...workspace,
      userRole: req.workspaceRole
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id - Delete a workspace
//
// SYSTEM DESIGN — Cascade Operations:
//   This destructive action relies on relational integrity. We check ownership first (only Owner can delete).
//   Once confirmed, deleting the row in `workspaces` triggers a cascade delete across `files` and
//   `workspace_collaborators` tables, avoiding partial deletions or orphaned resources.
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    
    // SECURITY CHECK (IDOR Mitigation):
    // Ensure the user actually owns the workspace before executing a destructive action.
    const wsResult = await getPool().query('SELECT owner_id FROM workspaces WHERE id = $1', [id]);
    
    if (wsResult.rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    
    if (wsResult.rows[0].owner_id !== userId) {
      res.status(403).json({ error: 'Forbidden: Only the workspace creator can delete the workspace' });
      return;
    }
    
    await getPool().query('DELETE FROM workspaces WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// =============================================================================
// COLLABORATOR MANAGEMENT
// =============================================================================

// GET /:id/collaborators - Retrieve list of enrolled collaborators
// Guarded by 'viewer' role: Anyone with read access can see who else is in the project.
router.get('/:id/collaborators', requireWorkspaceRole('viewer'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    
    const result = await getPool().query(
      `SELECT u.id, u.username, u.email, wc.role, wc.joined_at 
       FROM workspace_collaborators wc 
       JOIN users u ON wc.user_id = u.id 
       WHERE wc.workspace_id = $1 
       ORDER BY wc.joined_at ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/collaborators - Add or update a collaborator role (Requires Admin role)
//
// DATABASE PATTERN — Upsert via ON CONFLICT:
//   If the user is already a collaborator, instead of crashing on a primary key conflict or writing
//   an extra SELECT check, we handle updates gracefully using PostgreSQL's ON CONFLICT clause.
//
// BUSINESS RULE:
//   We prevent adding the workspace creator as an explicit collaborator, since the owner's admin status
//   is already implicitly checked and resolved at the middleware level.
router.post('/:id/collaborators', requireWorkspaceRole('admin'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { usernameOrEmail, role } = req.body;

    if (!usernameOrEmail || !role || !['viewer', 'editor', 'admin'].includes(role)) {
      res.status(400).json({ error: 'Valid usernameOrEmail and role are required' });
      return;
    }

    const userRes = await getPool().query('SELECT id FROM users WHERE username = $1 OR email = $1', [usernameOrEmail]);
    if (userRes.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const targetUserId = userRes.rows[0].id;

    // Check if trying to add the owner
    const wsRes = await getPool().query('SELECT owner_id FROM workspaces WHERE id = $1', [id]);
    if (wsRes.rows[0].owner_id === targetUserId) {
      res.status(400).json({ error: 'Workspace creator is implicitly an admin' });
      return;
    }

    const result = await getPool().query(
      `INSERT INTO workspace_collaborators (workspace_id, user_id, role) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (workspace_id, user_id) DO UPDATE 
       SET role = EXCLUDED.role 
       RETURNING *`,
      [id, targetUserId, role]
    );

    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /:id/collaborators/:userId - Modify a collaborator's role (Requires Admin role)
router.put('/:id/collaborators/:userId', requireWorkspaceRole('admin'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id, userId } = req.params;
    const { role } = req.body;

    if (!role || !['viewer', 'editor', 'admin'].includes(role)) {
      res.status(400).json({ error: 'Valid role is required' });
      return;
    }

    const result = await getPool().query(
      'UPDATE workspace_collaborators SET role = $1 WHERE workspace_id = $2 AND user_id = $3 RETURNING *',
      [role, id, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Collaborator not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id/collaborators/:userId - Revoke a collaborator's access (Requires Admin role)
router.delete('/:id/collaborators/:userId', requireWorkspaceRole('admin'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id, userId } = req.params;
    
    const result = await getPool().query(
      'DELETE FROM workspace_collaborators WHERE workspace_id = $1 AND user_id = $2 RETURNING *',
      [id, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Collaborator not found' });
      return;
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// =============================================================================
// FILE TREE MANAGEMENT
// =============================================================================

// GET /:id/files - Retrieve the directory structure of a workspace
// Guarded by requireWorkspaceRole('viewer')
//
// DATA FORMATTING & UI PAIN POINTS:
//   Retrieves all files and folders flat. The database uses a parent_id hierarchy.
//   We order by `type DESC` (directories first) and then alphabetically.
//   This optimizes client-side construction of the collapsible file tree UI.
router.get('/:id/files', requireWorkspaceRole('viewer'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const files = await getPool().query('SELECT id, parent_id, name, type, language FROM files WHERE workspace_id = $1 ORDER BY type DESC, name ASC', [id]);
    res.json(files.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/files - Create a new file or directory (Requires Editor role)
//
// CONSTRAINTS & SQL CODE 23505:
//   A unique constraint `unique_workspace_folder_file_name` enforces unique names per folder.
//   If a conflict occurs, PostgreSQL throws error code `23505` (unique_violation).
//   We catch this code specifically to return a clean, user-friendly 400 Bad Request message,
//   keeping raw Postgres stack traces hidden from the client.
router.post('/:id/files', requireWorkspaceRole('editor'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, type, parent_id, language } = req.body;

    if (!name || !type || !['file', 'directory'].includes(type)) {
      res.status(400).json({ error: 'Name and valid type are required' });
      return;
    }

    const resolvedLanguage = type === 'file' ? (language || 'javascript') : null;
    
    const newFile = await getPool().query(
      `INSERT INTO files (workspace_id, name, type, parent_id, language) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id, parent_id, name, type, language`,
      [id, name, type, parent_id || null, resolvedLanguage]
    );
    res.status(201).json(newFile.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') { 
      res.status(400).json({ error: 'A file with this name already exists in this folder' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// DELETE /:id/files/:fileId - Delete a file or directory (Requires Editor role)
router.delete('/:id/files/:fileId', requireWorkspaceRole('editor'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id, fileId } = req.params;
    await getPool().query('DELETE FROM files WHERE id = $1 AND workspace_id = $2', [fileId, id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// SANDBOX EXECUTION GATEWAY
// =============================================================================

// POST /:id/execute - Trigger secure code execution (Requires Editor role)
//
// SYSTEM GATEWAY:
//   Guarded strictly. A 'viewer' can read code, but cannot trigger executions.
//   This prevents unauthorized resource exhaustion of our Docker host.
//   Proxies execution payloads to the helper in `docker.ts`, capturing runtime
//   metrics (OOM, duration, exit code, CPU, RAM) for tracking sandbox performance.
router.post('/:id/execute', requireWorkspaceRole('editor'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user?.id;
  const { code, language, input, fileName } = req.body;

  if (!code || !language) {
    res.status(400).json({ error: 'Code and language are required' });
    return;
  }

  let status: 'success' | 'failed' | 'timeout' | 'error' = 'success';
  let result;

  try {
    result = await executeCode(code, language, input || undefined);
    
    if (result.oomKilled) {
      status = 'failed';
    } else if (result.exitCode === 137) {
      status = 'timeout';
    } else if (result.exitCode === 0) {
      status = 'success';
    } else {
      status = 'failed';
    }
  } catch (error: any) {
    // Write an error log entry to database
    try {
      await getPool().query(
        `INSERT INTO execution_history (
          workspace_id, user_id, language, code_snapshot, output, status, duration_ms, memory_usage_bytes, cpu_usage_percent, file_name
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          userId || null,
          language,
          code,
          error.message || String(error),
          'error',
          0,
          0,
          0.0,
          fileName || null
        ]
      );
    } catch (dbErr) {
      console.error('[db] Failed to log failed execution into history:', dbErr);
    }
    
    res.status(500).json({ error: error.message || 'Execution failed' });
    return;
  }

  // Log code execution to database
  try {
    await getPool().query(
      `INSERT INTO execution_history (
        workspace_id, user_id, language, code_snapshot, output, status, duration_ms, memory_usage_bytes, cpu_usage_percent, file_name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        userId || null,
        language,
        code,
        result.output,
        status,
        Math.round(result.durationMs),
        result.memoryUsageBytes || 0,
        result.cpuUsagePercent || 0.0,
        fileName || null
      ]
    );
  } catch (dbErr) {
    console.error('[db] Failed to log execution into history:', dbErr);
  }

  res.json({
    output: result.output,
    metrics: {
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      oomKilled: result.oomKilled,
      cpuUsagePercent: result.cpuUsagePercent,
      memoryUsageBytes: result.memoryUsageBytes
    }
  });
});

// GET /:id/execution-history - Retrieve the last 10 execution records for a workspace
// Guarded by requireWorkspaceRole('viewer')
router.get('/:id/execution-history', requireWorkspaceRole('viewer'), async (req: WorkspaceAuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const history = await getPool().query(
      `SELECT eh.id, eh.user_id, u.username, eh.language, eh.status, eh.duration_ms, eh.memory_usage_bytes, eh.cpu_usage_percent, eh.file_name, eh.executed_at 
       FROM execution_history eh
       LEFT JOIN users u ON eh.user_id = u.id
       WHERE eh.workspace_id = $1 
       ORDER BY eh.executed_at DESC 
       LIMIT 10`,
      [id]
    );
    res.json(history.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback for global execution if any legacy frontend endpoints attempt it.
router.post('/execute', async (req: AuthRequest, res: Response): Promise<void> => {
  res.status(400).json({ error: 'Please use the workspace-specific execute endpoint: /api/workspace/:id/execute' });
});

export default router;