import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { cancelBookedSession, createBookedSession, removeBookedSlot } from './schedulerLogic.js';
import { client, fallbackChannelName, readData, writeData, writeScheduledAppointments, sendDmToUser } from './index.js';
export async function handleActivityAction(payload, options) {
    const dataFile = options?.dataFile ?? path.join(process.cwd(), 'data', 'scheduler-data.json');
    const appointmentsFile = options?.appointmentsFile ?? path.join(process.cwd(), 'data', 'scheduled-appointments.json');
    const data = options?.dataFile ? await readJsonFile(dataFile, { coaches: [], players: [], sessions: [] }) : await readData();
    const coach = data.coaches.find((entry) => entry.id === payload.coachId);
    if (payload.action === 'book-slot') {
        if (!coach || !payload.playerId || !payload.playerUsername || !payload.slot) {
            return { ok: false, message: 'Missing booking information.' };
        }
        const removed = removeBookedSlot(data, coach.id, payload.slot);
        if (!removed) {
            return { ok: false, message: 'That slot is no longer available.' };
        }
        const session = createBookedSession(data, coach.id, coach.username, payload.playerId, payload.playerUsername, payload.slot, undefined);
        if (options?.dataFile) {
            await writeJsonFile(dataFile, data);
            await writeJsonFile(appointmentsFile, data.sessions);
        }
        else {
            await writeData(data);
            await writeScheduledAppointments(data.sessions);
        }
        if (!options?.dataFile) {
            await writeData(data);
            await writeScheduledAppointments(data.sessions);
            void sendDmToUser(coach.userId, coach.guildId, {
                embeds: [
                    {
                        title: 'New coaching session booked',
                        description: `${payload.playerUsername} booked ${payload.slot} with you.`,
                        color: 0x57f287
                    }
                ]
            }).catch(async (err) => {
                console.error(`Failed to DM coach ${coach.userId}`, err);
                if (coach.guildId) {
                    try {
                        const guild = await client.guilds.fetch(coach.guildId);
                        const channels = await guild.channels.fetch();
                        const fallbackChannel = channels.find((channel) => channel?.isTextBased() &&
                            channel.name === fallbackChannelName);
                        if (fallbackChannel && 'send' in fallbackChannel) {
                            await fallbackChannel.send({
                                content: `<@${coach.userId}> ${payload.playerUsername} booked ${payload.slot} with you.`,
                                embeds: [
                                    {
                                        title: 'New coaching session booked',
                                        description: `${payload.playerUsername} booked ${payload.slot} with you.`,
                                        color: 0x57f287
                                    }
                                ]
                            });
                        }
                    }
                    catch (fallbackErr) {
                        console.error(`Failed to fallback notify coach ${coach.userId} in ${fallbackChannelName}`, fallbackErr);
                    }
                }
            });
        }
        return { ok: true, message: 'Booking created.', session };
    }
    if (payload.action === 'cancel-appointment') {
        if (!payload.appointmentId) {
            return { ok: false, message: 'Missing appointment id.' };
        }
        const result = cancelBookedSession(data, payload.appointmentId);
        if (!result.cancelled) {
            return { ok: false, message: 'Appointment not found.' };
        }
        if (options?.dataFile) {
            await writeJsonFile(dataFile, data);
            await writeJsonFile(appointmentsFile, data.sessions);
        }
        else {
            await writeData(data);
            await writeScheduledAppointments(data.sessions);
        }
        return { ok: true, message: 'Appointment canceled.' };
    }
    return { ok: false, message: 'Unsupported action.' };
}
async function readJsonFile(filePath, fallback) {
    try {
        const contents = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(contents);
        return parsed;
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            await writeJsonFile(filePath, fallback);
            return fallback;
        }
        throw error;
    }
}
async function writeJsonFile(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, filePath);
}
