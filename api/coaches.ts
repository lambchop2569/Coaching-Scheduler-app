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
    const coaches = data.coaches.map((coach) => ({
      id: coach.id,
      username: coach.username,
      bio: coach.bio,
      specialties: coach.specialties,
      slots: coach.slots,
      avatarUrl: coach.avatarUrl,
      timezone: coach.timezone,
      visibility: coach.visibility
    }));
    sendJson(res, 200, { coaches });
  } catch (error: any) {
    console.error('Failed to load coaches', error);
    sendJson(res, 500, { error: 'Failed to load coaches' });
  }
}
