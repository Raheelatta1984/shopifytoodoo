/**
 * Authentication and authorisation.
 *
 * The API is protected by API keys that are stored hashed.  Every request is
 * attributed to a named user with a role, and every state changing endpoint
 * declares the permission it requires.  This implements the "only authorised
 * roles, with an audit trail" control (EV-A4B816C198, REQ-007) and the
 * "approvals depend on a threshold" rule (EV-EA0FC6E04E).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRepository, Role } from '../repositories/user-repository.js';

export const PERMISSIONS = {
  'order:read': ['viewer', 'operator', 'approver', 'integrator', 'auditor', 'admin'],
  'order:ingest': ['operator', 'integrator', 'admin'],
  'order:validate': ['operator', 'integrator', 'approver', 'admin'],
  'order:approve': ['approver', 'admin'],
  'order:reject': ['operator', 'approver', 'admin'],
  'order:publish': ['operator', 'approver', 'integrator', 'admin'],
  'order:dmf': ['operator', 'approver', 'integrator', 'admin'],
  'settings:read': ['viewer', 'operator', 'approver', 'integrator', 'auditor', 'admin'],
  'settings:write': ['admin'],
  'mapping:read': ['viewer', 'operator', 'approver', 'integrator', 'admin'],
  'mapping:write': ['integrator', 'admin'],
  'audit:read': ['auditor', 'admin'],
  'user:manage': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export interface AuthenticatedUser {
  id: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function hasPermission(role: Role, permission: Permission): boolean {
  const allowed = PERMISSIONS[permission] as readonly Role[];
  return allowed.includes(role);
}

export function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  return null;
}

/**
 * Fastify preHandler that authenticates the request.
 */
export function createAuthenticator(users: UserRepository) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
      throw new AuthError('An API key is required (X-API-Key header)', 401);
    }
    const user = await users.findByApiKey(apiKey);
    if (!user) {
      throw new AuthError('The API key is not valid', 401);
    }
    request.user = { id: user.id, name: user.name, role: user.role };
  };
}

/**
 * Fastify preHandler factory that checks a permission.
 */
export function requirePermission(permission: Permission) {
  return async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = request.user;
    if (!user) {
      throw new AuthError('Authentication is required', 401);
    }
    if (!hasPermission(user.role, permission)) {
      await reply.code(403).send({
        error: 'forbidden',
        message: `The role "${user.role}" is not allowed to perform "${permission}"`,
      });
      return;
    }
  };
}
