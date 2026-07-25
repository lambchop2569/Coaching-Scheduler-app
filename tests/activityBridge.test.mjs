import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleActivityAction } from '../dist/activityBridge.js';

test('activity bridge creates a booked session and persists the change', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'coach-scheduler-activity-'));

  try {
    const dataFile = path.join(tempDir, 'scheduler-data.json');
    const appointmentsFile = path.join(tempDir, 'scheduled-appointments.json');

    await writeFile(
      dataFile,
      JSON.stringify(
        {
          coaches: [
            {
              id: 'coach-1',
              userId: 'coach-user',
              username: 'Maya',
              bio: 'Mindset coach',
              specialties: ['strategy'],
              slots: ['Monday 6pm'],
              savedAvailability: ['Monday 6pm'],
              visibility: 'all',
              createdAt: '2024-01-01T00:00:00.000Z'
            }
          ],
          players: [],
          sessions: []
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await handleActivityAction(
      {
        action: 'book-slot',
        coachId: 'coach-1',
        playerId: 'player-user',
        playerUsername: 'Alex',
        slot: 'Monday 6pm'
      },
      { dataFile, appointmentsFile }
    );

    assert.equal(result.ok, true);
    assert.equal(result.session.slot, 'Monday 6pm');

    const persisted = JSON.parse(await readFile(dataFile, 'utf8'));
    assert.equal(persisted.sessions.length, 1);
    assert.deepEqual(persisted.coaches[0].slots, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
