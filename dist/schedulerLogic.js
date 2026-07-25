/* -------------------------------------------------------
   schedulerLogic.ts — TypeScript Rewrite
-------------------------------------------------------- */
/**
 * Removes a booked slot from a coach's active availability.
 * Returns true if the slot was removed, false if not found.
 */
export function removeBookedSlot(data, coachId, slot) {
    const coach = data.coaches.find((c) => c.id === coachId);
    if (!coach)
        return false;
    const before = coach.slots.length;
    coach.slots = coach.slots.filter((s) => s !== slot);
    return coach.slots.length !== before;
}
export function createBookedSession(data, coachId, coachUsername, playerId, playerUsername, slot, guildId) {
    const session = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        coachId,
        coachUsername,
        playerId,
        playerUsername,
        slot,
        guildId,
        createdAt: new Date().toISOString()
    };
    data.sessions.push(session);
    return session;
}
export function cancelBookedSession(data, sessionId) {
    const sessionIndex = data.sessions.findIndex((session) => session.id === sessionId);
    if (sessionIndex === -1) {
        return { cancelled: false };
    }
    const session = data.sessions[sessionIndex];
    const coach = data.coaches.find((entry) => entry.id === session.coachId);
    const slot = session.slot;
    data.sessions.splice(sessionIndex, 1);
    if (coach && !coach.slots.includes(slot)) {
        coach.slots = [...coach.slots, slot];
    }
    return { cancelled: true, slot };
}
/**
 * Restores a coach's saved availability, filtering out expired slots.
 * This is used when a coach runs out of active slots.
 */
export function restoreSavedAvailability(coach, isSlotExpiredToday, materializeSlot = (slot) => slot) {
    coach.slots = (coach.savedAvailability ?? [])
        .map(materializeSlot)
        .filter((slot) => !isSlotExpiredToday(slot));
    return coach.slots.length;
}
/**
 * Utility: checks whether a coach has zero active slots.
 */
export function coachHasNoSlots(coach) {
    return coach.slots.length === 0;
}
function slotTimeInMinutes(time) {
    const match = time.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (!match)
        return null;
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? '0');
    const suffix = match[3];
    if (hour > 12 || minute > 59)
        return null;
    if (hour === 12)
        hour = 0;
    if (suffix === 'pm')
        hour += 12;
    return hour * 60 + minute;
}
/**
 * Combines consecutive hourly slots for presentation only. Individual slots
 * remain unchanged for booking menus and storage.
 */
export function formatAvailableSlotRanges(slots) {
    const grouped = new Map();
    const unparsed = [];
    for (const slot of slots) {
        const match = slot.match(/^(.*?\s(?:at\s)?)((?:\d{1,2})(?::\d{2})?\s*(?:am|pm))$/i);
        if (!match) {
            unparsed.push(slot);
            continue;
        }
        const minutes = slotTimeInMinutes(match[2]);
        if (minutes === null) {
            unparsed.push(slot);
            continue;
        }
        const entry = {
            original: slot,
            prefix: match[1],
            time: match[2],
            minutes
        };
        const entries = grouped.get(entry.prefix) ?? [];
        entries.push(entry);
        grouped.set(entry.prefix, entries);
    }
    const ranges = [];
    for (const entries of grouped.values()) {
        entries.sort((a, b) => a.minutes - b.minutes);
        for (let start = 0; start < entries.length;) {
            let end = start;
            while (end + 1 < entries.length && entries[end + 1].minutes - entries[end].minutes === 60) {
                end += 1;
            }
            ranges.push(start === end
                ? entries[start].original
                : `${entries[start].prefix}${entries[start].time}–${entries[end].time}`);
            start = end + 1;
        }
    }
    return [...ranges, ...unparsed];
}
