import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';


// Extend Express Request type to include user
export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
  };
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; username: string };
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// this file defines an Express middleware function called requireAuth that checks for a valid JWT token in the Authorization header of incoming requests. If the token is valid, it decodes the token to extract user information and attaches it to the request object for use in subsequent route handlers. If the token is missing or invalid, it responds with a 401 Unauthorized error. This middleware can be applied to any route that requires authentication to ensure that only authenticated users can access those routes.
// it validates the presence of a JWT token in the Authorization header, verifies its validity, and extracts user information from it. If the token is valid, it allows the request to proceed; otherwise, it responds with an error indicating that authentication is required or that the token is invalid.