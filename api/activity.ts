import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleActivityRequest } from '../src/index.js';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(res: ServerResponse) {
  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body || '{}');
      const result = await handleActivityRequest(payload);
      sendJson(res, 200, result);
    } catch (error: any) {
      console.error('Activity API request failed', error);
      sendJson(res, 400, { ok: false, message: 'Invalid activity payload.' });
    }
  });
}
