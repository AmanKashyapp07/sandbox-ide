import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { executeCode } from '../sandbox/docker';
import { getPool } from '../db';

const router = Router();

// Get all workspaces for the authenticated user
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    
    const workspaces = await getPool().query(
      'SELECT id, title, created_at, updated_at FROM workspaces WHERE owner_id = $1 ORDER BY updated_at DESC',
      [userId]
    );
    res.json(workspaces.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create or get workspace
router.post('/', async (req: AuthRequest, res: Response) => {
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
        // Upsert by ID
        result = await getPool().query(
          `INSERT INTO workspaces (id, owner_id, title) 
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE 
           SET title = EXCLUDED.title
           RETURNING *`,
          [id, userId, title || 'Untitled Project']
        );
      } else {
        result = await getPool().query(
          `INSERT INTO workspaces (owner_id, title) 
           VALUES ($1, $2)
           RETURNING *`,
          [userId, title || 'Untitled Project']
        );
        
        // Auto-create a default index.js file for new workspaces
        if (result.rows.length > 0) {
          await getPool().query(
            `INSERT INTO files (workspace_id, name, type, language, content) VALUES ($1, $2, $3, $4, $5)`,
            [result.rows[0].id, 'index.js', 'file', 'javascript', '']
          );
        }
      }
      
      res.json(result.rows[0]);
    } catch (dbError) {
      console.warn("Database connection failed, falling back to dummy workspace response:", dbError);
      res.status(500).json({ error: 'Database error' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get workspace by ID
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const wsResult = await getPool().query('SELECT id, title, owner_id FROM workspaces WHERE id = $1', [id]);
    
    if (wsResult.rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    
    res.json(wsResult.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete workspace
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    
    // Make sure the user owns the workspace before deleting
    const wsResult = await getPool().query('SELECT owner_id FROM workspaces WHERE id = $1', [id]);
    
    if (wsResult.rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    
    if (wsResult.rows[0].owner_id !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    
    await getPool().query('DELETE FROM workspaces WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get or Create Default Workspace
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
      // Create a default index.js file
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

// GET /:id/files
router.get('/:id/files', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const files = await getPool().query('SELECT id, parent_id, name, type, language FROM files WHERE workspace_id = $1 ORDER BY type DESC, name ASC', [id]);
    res.json(files.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/files
router.post('/:id/files', async (req: AuthRequest, res: Response): Promise<void> => {
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

// DELETE /:id/files/:fileId
router.delete('/:id/files/:fileId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { fileId } = req.params;
    await getPool().query('DELETE FROM files WHERE id = $1', [fileId]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Execute code route
router.post('/execute', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { code, language, input } = req.body;
    if (!code || !language) {
      res.status(400).json({ error: 'Code and language are required' });
      return;
    }

    const output = await executeCode(code, language, input || undefined);
    res.json({ output });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Execution failed' });
  }
});

export default router;


// what each route does -
// GET /:id - Get workspace details of a specific workspace by ID
// PUT /:id - Update workspace details of a specific workspace by ID (e.g. rename)
// DELETE /:id - Delete workspace by ID (and all associated files)
// GET /default - Get all workspaces for the authenticated user, or create a default one if none exist
// GET /:id/files - Get all files in a workspace by workspace ID
// POST /:id/files - Create a new file in a workspace by workspace ID (expects name, type, parent_id, language in body)
// DELETE /:id/files/:fileId - Delete a file from a workspace by file ID
// POST /execute - Execute code and return output (expects code and language in body)