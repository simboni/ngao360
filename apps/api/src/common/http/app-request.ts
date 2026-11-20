import type { Request } from 'express';
import type { AuthContext } from '../../auth/auth.types';

export interface AppRequest extends Request {
  auth?: AuthContext;
}
