import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { executeCode } from '../sandbox/docker';
import { getPool } from '../db';

const router = Router();

// Create or get workspace
router.post('/', async (req, res) => {
  try {
    const { id, title, language } = req.body;
    
    // For this minimal setup, we return a dummy workspace if Postgres is not running.
    // Try to connect and insert/update
    try {
      let result;
      if (id) {
        // Upsert by ID (ON CONFLICT not simple for uuid if it's generated, but assuming UUID is PK)
        result = await getPool().query(
          `INSERT INTO workspaces (id, title, language) 
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE 
           SET title = EXCLUDED.title, language = EXCLUDED.language
           RETURNING *`,
          [id, title || 'Untitled Project', language || 'javascript']
        );
      } else {
        result = await getPool().query(
          `INSERT INTO workspaces (title, language) 
           VALUES ($1, $2)
           RETURNING *`,
          [title || 'Untitled Project', language || 'javascript']
        );
      }
      
      res.json(result.rows[0]);
    } catch (dbError) {
      console.warn("Database connection failed, falling back to dummy workspace response:", dbError);
      res.json({ id: id || 'test-uuid', title: 'Fallback Project', language: 'javascript' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
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
        [wsResult.rows[0].id, 'index.js', 'file', 'javascript', '// Welcome to your new sandbox!\nconsole.log("Hello World");']
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
    
    const newFile = await getPool().query(
      `INSERT INTO files (workspace_id, name, type, parent_id, language) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id, parent_id, name, type, language`,
      [id, name, type, parent_id || null, language || 'javascript']
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
    const { code, language } = req.body;
    if (!code || !language) {
      res.status(400).json({ error: 'Code and language are required' });
      return;
    }

    const output = await executeCode(code, language);
    res.json({ output });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Execution failed' });
  }
});

export default router;
