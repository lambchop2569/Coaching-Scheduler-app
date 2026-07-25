import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelBookedSession,
  formatAvailableSlotRanges,
  removeBookedSlot,
  restoreSavedAvailability
} from '../dist/schedulerLogic.js';

test('removes the accepted slot from the coach profile', () => {
  const data = {
    coaches: [
      {
        id: 'coach-1',
        slots: ['09:00', '14:00']
      }
    ]
  };

  const removed = removeBookedSlot(data, 'coach-1', '09:00');

  assert.equal(removed, true);
  assert.deepEqual(data.coaches[0].slots, ['14:00']);
});

test('returns false when the slot is not present', () => {
  const data = {
    coaches: [
      {
        id: 'coach-1',
        slots: ['09:00']
      }
    ]
  };

  const removed = removeBookedSlot(data, 'coach-1', '14:00');

  assert.equal(removed, false);
  assert.deepEqual(data.coaches[0].slots, ['09:00']);
});

test('restores saved availability without expired slots', () => {
  const coach = {
    id: 'coach-1',
    slots: [],
    savedAvailability: ['Monday 09:00', 'Tuesday 14:00']
  };

  const count = restoreSavedAvailability(coach, (slot) => slot === 'Monday 09:00');

  assert.equal(count, 1);
  assert.deepEqual(coach.slots, ['Tuesday 14:00']);
});

test('handles legacy profiles that have no saved availability', () => {
  const coach = { id: 'coach-1', slots: [] };

  const count = restoreSavedAvailability(coach, () => false);

  assert.equal(count, 0);
  assert.deepEqual(coach.slots, []);
});

test('can materialize saved templates into dated bookable slots', () => {
  const coach = {
    id: 'coach-1',
    slots: [],
    savedAvailability: ['Saturday 9am']
  };

  restoreSavedAvailability(
    coach,
    () => false,
    (slot) => slot.replace('Saturday', 'Saturday July 26th, 2026 at').replace(' 9am', ' 9am')
  );

  assert.deepEqual(coach.slots, ['Saturday July 26th, 2026 at 9am']);
});

test('cancels a booked session and restores the coach slot', () => {
  const data = {
    coaches: [
      {
        id: 'coach-1',
        slots: []
      }
    ],
    sessions: [
      {
        id: 'session-1',
        coachId: 'coach-1',
        coachUsername: 'Coach',
        playerId: 'player-1',
        playerUsername: 'Player',
        slot: 'Friday August 1st, 2026 at 5pm',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]
  };

  const result = cancelBookedSession(data, 'session-1');

  assert.equal(result.cancelled, true);
  assert.deepEqual(data.coaches[0].slots, ['Friday August 1st, 2026 at 5pm']);
  assert.equal(data.sessions.length, 0);
});

test('formats consecutive hourly slots as a display range', () => {
  const slots = [
    'Friday August 1st, 2026 at 5pm',
    'Friday August 1st, 2026 at 6pm',
    'Friday August 1st, 2026 at 7pm',
    'Friday August 1st, 2026 at 8pm'
  ];

  assert.deepEqual(formatAvailableSlotRanges(slots), [
    'Friday August 1st, 2026 at 5pm–8pm'
  ]);
});
