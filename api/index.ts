import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleActivityHttpRequest } from '../src/index.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleActivityHttpRequest(req, res);
}
