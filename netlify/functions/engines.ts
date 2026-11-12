import type { Config } from '@netlify/functions';
import { engineStatuses, loadConfig } from '../../server/config.ts';

/** GET /api/engines - which engines have keys configured. Never returns the keys. */
export default async () => {
  const engines = engineStatuses(loadConfig());
  return Response.json({ engines }, { headers: { 'cache-control': 'no-store' } });
};

export const config: Config = { path: '/api/engines', method: 'GET' };
