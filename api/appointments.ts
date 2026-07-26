import type { IncomingMessage, ServerResponse } from 'node:http';
import { readData } from '../src/index.js';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(res: ServerResponse) {
  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }

  try {
    const data = await readData();
    const appointments = data.sessions.map((session) => ({
      id: session.id,
      coachId: session.coachId,
      coachUsername: session.coachUsername,
      playerUsername: session.playerUsername,
      slot: session.slot,
      createdAt: session.createdAt
    }));
    sendJson(res, 200, { appointments });
  } catch (error: any) {
    console.error('Failed to load appointments', error);
    sendJson(res, 500, { error: 'Failed to load appointments' });
  }
}
