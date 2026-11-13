import type { Config } from '@netlify/functions';
import { engineStatuses, loadConfig } from '../../server/config.ts';

/**
 * GET /api/engines - which engines have keys configured, and whether live checks are
 * unlocked by an ACCESS_CODE. Never returns keys or the code itself.
 */
export default async () => {
  const engines = engineStatuses(loadConfig());
  const accessConfigured = (process.env.ACCESS_CODE?.trim().length ?? 0) >= 8;
  return Response.json({ engines, accessConfigured }, { headers: { 'cache-control': 'no-store' } });
};

export const config: Config = { path: '/api/engines', method: 'GET' };
