/**
 * Funding & provisioning policy
 *
 * - Users can NOT add credits themselves (no card / UPI / crypto deposits, no gift vouchers, no AFK rewards).
 *   Only an administrator adds credits (Admin -> Users -> Credits).
 * - Users can NOT create servers (Minecraft or bot hosting). Only an administrator creates a server for a user;
 *   the price of the chosen plan is taken from that user's credits.
 *
 * To turn self-service back on later, set ALLOW_SELF_FUNDING=true / ALLOW_SELF_DEPLOY=true in .env.
 */
import { Request, Response, NextFunction } from 'express';

export const ALLOW_SELF_FUNDING = String(process.env.ALLOW_SELF_FUNDING || '').toLowerCase() === 'true';
export const ALLOW_SELF_DEPLOY = String(process.env.ALLOW_SELF_DEPLOY || '').toLowerCase() === 'true';

/** Credits given to new accounts. 0 while self-funding is off (every credit comes from the admin). */
export const WELCOME_CREDITS = ALLOW_SELF_FUNDING ? 10.0 : 0;

export const ADMIN_ROLES = ['admin', 'super_admin'];
export const isAdminRole = (role?: string) => !!role && ADMIN_ROLES.includes(role);

export const SELF_FUNDING_ERROR = {
  success: false,
  error: {
    code: 'SELF_FUNDING_DISABLED',
    message: 'Adding funds yourself is disabled. Only an administrator can add credits to your account - please open a support ticket.'
  }
};

export const SELF_DEPLOY_ERROR = {
  success: false,
  error: {
    code: 'SELF_DEPLOY_DISABLED',
    message: 'Creating servers yourself is disabled. An administrator creates servers for you - please open a support ticket.'
  }
};

/** Route guard: blocks every self-service credit route while self-funding is off. */
export function blockSelfFunding(_req: Request, res: Response, next: NextFunction) {
  if (ALLOW_SELF_FUNDING) return next();
  return res.status(403).json(SELF_FUNDING_ERROR);
}
