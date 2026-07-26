import 'dotenv/config';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, EmbedBuilder, GatewayIntentBits, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { kvGetSchedulerData, kvSetSchedulerData, kvGetAppointments, kvSetAppointments, kvAvailable } from './kvAdapter.js';
import { cancelBookedSession, coachHasNoSlots, createBookedSession, formatAvailableSlotRanges, removeBookedSlot, restoreSavedAvailability } from './schedulerLogic.js';
import { startActivity } from './activity.js';
import { handleActivityAction } from './activityBridge.js';
/* -------------------------------------------------------
   Constants & Setup
-------------------------------------------------------- */
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});
export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers
    ]
});
// Keep a recoverable Discord API failure from terminating the scheduler.
client.on('error', (error) => {
    console.error('Discord client error:', error);
});
export const dataFile = path.join(process.cwd(), 'data', 'scheduler-data.json');
export const appointmentsFile = path.join(process.cwd(), 'data', 'scheduled-appointments.json');
export const pendingRequests = new Map();
export const pendingAvailability = new Map();
export const pendingScheduleSelections = new Map();
export const availabilityByDay = new Map();
export const availabilityDayQueue = new Map();
export const availabilityCurrentDay = new Map();
export const coachListMessages = new Map();
export const fallbackChannelName = process.env.FALLBACK_CHANNEL_NAME ?? 'schedule-requests';
const activityServerPort = Number(process.env.ACTIVITY_PORT ?? process.env.PORT ?? 3000);
const activityServerHost = process.env.ACTIVITY_HOST ?? '0.0.0.0';
const publicDirectory = path.join(process.cwd(), 'public');
const shouldRunActivityPreview = process.env.ACTIVITY_PREVIEW === '1' || process.env.SKIP_DISCORD_LOGIN === '1';
function getContentType(filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case '.html': return 'text/html; charset=utf-8';
        case '.js': return 'application/javascript; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        default: return 'application/octet-stream';
    }
}
async function serveStaticAsset(req, res, routePath) {
    const safePath = path.normalize(routePath).replace(/^([a-zA-Z]:)?[\\/]+/, '');
    const resolvedPath = path.join(publicDirectory, safePath);
    if (!resolvedPath.startsWith(publicDirectory)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }
    try {
        const contents = await readFile(resolvedPath);
        res.writeHead(200, { 'Content-Type': getContentType(resolvedPath) });
        res.end(contents);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server error');
    }
}
async function handleActivityHttpRequest(req, res) {
    if (req.method === 'POST' && req.url === '/api/activity') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const result = await handleActivityAction(payload);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(result));
            }
            catch (error) {
                console.error('Activity API request failed', error);
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Invalid activity payload.' }));
            }
        });
        return;
    }
    if (req.method === 'GET') {
        const requestPath = (req.url ?? '/').split('?')[0] || '/';
        if (requestPath === '/' || requestPath === '/index.html') {
            await serveStaticAsset(req, res, 'index.html');
            return;
        }
        if (requestPath === '/activity.js') {
            await serveStaticAsset(req, res, 'activity.js');
            return;
        }
        if (requestPath === '/api/coaches') {
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
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ coaches }));
            return;
        }
        if (requestPath === '/api/appointments') {
            const data = await readData();
            const appointments = data.sessions.map((session) => ({
                id: session.id,
                coachId: session.coachId,
                coachUsername: session.coachUsername,
                playerUsername: session.playerUsername,
                slot: session.slot,
                createdAt: session.createdAt
            }));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ appointments }));
            return;
        }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
}
export async function handleActivityRequest(payload) {
    return handleActivityAction(payload);
}
if (shouldRunActivityPreview) {
    const activityHttpServer = createServer((req, res) => {
        void handleActivityHttpRequest(req, res);
    });
    activityHttpServer.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.warn(`Activity preview server could not bind ${activityServerHost}:${activityServerPort}; port is already in use.`);
            return;
        }
        console.error('Activity preview server error', error);
    });
    activityHttpServer.listen(activityServerPort, activityServerHost, () => {
        console.log(`Activity preview server listening on http://${activityServerHost}:${activityServerPort}`);
    });
}
export const availabilityDays = [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
];
export const availabilityTimes = [
    '1am', '2am', '3am', '4am', '5am', '6am', '7am', '8am', '9am', '10am', '11am', '12pm',
    '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm', '11pm', '12am'
];
/* -------------------------------------------------------
   Slot Expiry Helpers
-------------------------------------------------------- */
export const WEEKDAY_NAMES = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];
export const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];
export const DEFAULT_COACH_TIMEZONE = process.env.DEFAULT_COACH_TIMEZONE ?? 'America/Los_Angeles';
export const coachTimezones = [
    { name: 'US Pacific', value: 'America/Los_Angeles' },
    { name: 'US Mountain', value: 'America/Denver' },
    { name: 'US Central', value: 'America/Chicago' },
    { name: 'US Eastern', value: 'America/New_York' },
    { name: 'United Kingdom', value: 'Europe/London' },
    { name: 'Central Europe', value: 'Europe/Berlin' },
    { name: 'UTC', value: 'UTC' }
];
export const SLOT_EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export function parseSlotTime(time) {
    const match = time.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (!match)
        return null;
    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const meridiem = match[3];
    if (hour === 12)
        hour = 0;
    if (meridiem === 'pm')
        hour += 12;
    return { hour, minute };
}
function ordinal(day) {
    const remainder = day % 100;
    if (remainder >= 11 && remainder <= 13)
        return `${day}th`;
    switch (day % 10) {
        case 1: return `${day}st`;
        case 2: return `${day}nd`;
        case 3: return `${day}rd`;
        default: return `${day}th`;
    }
}
/** Turns a weekly template such as "Saturday 9am" into a bookable dated slot. */
export function buildDatedSlot(template, now = new Date()) {
    const [day, ...timeParts] = template.split(' ');
    const time = timeParts.join(' ');
    const weekday = WEEKDAY_NAMES.indexOf(day);
    if (weekday === -1 || !parseSlotTime(time))
        return template;
    const slotDate = new Date(now);
    slotDate.setHours(0, 0, 0, 0);
    slotDate.setDate(now.getDate() + ((weekday - now.getDay() + 7) % 7));
    return `${day} ${MONTH_NAMES[slotDate.getMonth()]} ${ordinal(slotDate.getDate())}, ${slotDate.getFullYear()} at ${time}`;
}
function isDatedSlot(slot) {
    return /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4}\s+at\s+/i.test(slot);
}
function templateFromSlot(slot) {
    const match = slot.match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4}\s+at\s+(.+)$/i);
    return match ? `${match[1]} ${match[2]}` : slot;
}
export function isSlotExpiredToday(slot, now = new Date()) {
    const datedMatch = slot.match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\s+at\s+(.+)$/i);
    if (datedMatch) {
        const [, , monthName, dayText, yearText, time] = datedMatch;
        const parsed = parseSlotTime(time);
        const month = MONTH_NAMES.findIndex(name => name.toLowerCase() === monthName.toLowerCase());
        if (!parsed || month === -1)
            return false;
        const slotDate = new Date(Number(yearText), month, Number(dayText), parsed.hour, parsed.minute);
        return slotDate.getTime() <= now.getTime();
    }
    const [day, ...timeParts] = slot.split(' ');
    const time = timeParts.join(' ');
    const parsed = parseSlotTime(time);
    if (!parsed)
        return false;
    const todayName = WEEKDAY_NAMES[now.getDay()];
    if (day !== todayName)
        return false;
    const slotMinutes = parsed.hour * 60 + parsed.minute;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return slotMinutes <= nowMinutes;
}
function timestampForSlot(slot, timezone) {
    const match = slot.match(/^[A-Za-z]+\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))$/i);
    if (!match)
        return null;
    const month = MONTH_NAMES.findIndex(name => name.toLowerCase() === match[1].toLowerCase());
    const time = parseSlotTime(match[4]);
    if (month === -1 || !time)
        return null;
    const year = Number(match[3]);
    const day = Number(match[2]);
    const targetAsUtc = Date.UTC(year, month, day, time.hour, time.minute);
    const initial = new Date(targetAsUtc);
    // Translate the coach's wall-clock time in their selected timezone into
    // an absolute instant, which Discord can localize for every viewer.
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(initial);
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const observedAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute);
    return Math.floor((targetAsUtc + (targetAsUtc - observedAsUtc)) / 1000);
}
function formatSlotsForViewer(slots, timezone) {
    return formatAvailableSlotRanges(slots).map(range => {
        const match = range.match(/^(.*\sat\s)(\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:–(\d{1,2}(?::\d{2})?\s*(?:am|pm)))?$/i);
        if (!match)
            return range;
        const start = timestampForSlot(`${match[1]}${match[2]}`, timezone);
        const end = match[3] ? timestampForSlot(`${match[1]}${match[3]}`, timezone) : null;
        if (!start)
            return range;
        return end
            ? `<t:${start}:f>–<t:${end}:t>`
            : `<t:${start}:f>`;
    });
}
function formatSlotForPlayer(slot, coachTimezone, playerTimezone) {
    const timestamp = timestampForSlot(slot, coachTimezone);
    if (!timestamp)
        return slot;
    return new Intl.DateTimeFormat('en-US', {
        timeZone: playerTimezone,
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
    }).format(new Date(timestamp * 1000));
}
export function getActiveSlots(coach) {
    return coach.slots.filter(slot => !isSlotExpiredToday(slot));
}
export async function pruneExpiredSlots() {
    try {
        const data = await readData();
        let changed = false;
        for (const coach of data.coaches) {
            const active = getActiveSlots(coach);
            if (active.length !== coach.slots.length) {
                coach.slots = active;
                changed = true;
            }
        }
        if (changed) {
            await writeData(data);
            console.log('Pruned expired slots.');
        }
    }
    catch (err) {
        console.error('Failed to prune expired slots', err);
    }
}
/* -------------------------------------------------------
   Data Storage Helpers
-------------------------------------------------------- */
export async function publishSchedulerUi() {
    for (const guild of client.guilds.cache.values()) {
        const channel = guild.channels.cache.find((candidate) => {
            if (!candidate.isTextBased() || candidate.isDMBased())
                return false;
            return 'send' in candidate;
        });
        if (!channel || !('send' in channel))
            continue;
        try {
            await channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Coach Scheduler')
                        .setDescription('Use the buttons below to browse coaches, set your timezone, manage availability, or cancel an appointment.')
                        .setColor(0x5865f2)
                ],
                components: buildSchedulerMainMenuButtons()
            });
        }
        catch (err) {
            console.error(`Failed to publish scheduler UI in ${guild.name}`, err);
        }
    }
}
export async function readScheduledAppointments() {
    // Try KV first when available
    if (kvAvailable) {
        const kv = await kvGetAppointments();
        if (kv !== null)
            return kv;
    }
    try {
        const contents = await readFile(appointmentsFile, 'utf8');
        const sessions = JSON.parse(contents);
        return Array.isArray(sessions) ? sessions : [];
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            await writeScheduledAppointments([]);
            return [];
        }
        throw err;
    }
}
export async function writeScheduledAppointments(sessions) {
    // Try to persist to KV when available; fall back to filesystem for local/dev
    if (kvAvailable) {
        const ok = await kvSetAppointments(sessions);
        if (ok)
            return;
    }
    await mkdir(path.dirname(appointmentsFile), { recursive: true });
    const tmp = `${appointmentsFile}.tmp`;
    await writeFile(tmp, JSON.stringify(sessions, null, 2), 'utf8');
    await rename(tmp, appointmentsFile);
}
export async function readData() {
    // Try KV first when available
    if (kvAvailable) {
        const kv = await kvGetSchedulerData();
        if (kv !== null) {
            const data = kv;
            data.coaches ??= [];
            data.players ??= [];
            data.sessions ??= [];
            const persistedSessions = await readScheduledAppointments();
            data.sessions = persistedSessions.length > 0 ? persistedSessions : data.sessions;
            for (const coach of data.coaches) {
                if (!Array.isArray(coach.savedAvailability)) {
                    coach.savedAvailability = [...coach.slots];
                }
                coach.savedAvailability = coach.savedAvailability.map(templateFromSlot);
                coach.timezone ??= DEFAULT_COACH_TIMEZONE;
                coach.slots = coach.slots.map(slot => isDatedSlot(slot) ? slot : buildDatedSlot(slot));
            }
            return data;
        }
    }
    try {
        const contents = await readFile(dataFile, 'utf8');
        const data = JSON.parse(contents);
        data.coaches ??= [];
        data.players ??= [];
        data.sessions ??= [];
        const persistedSessions = await readScheduledAppointments();
        data.sessions = persistedSessions.length > 0 ? persistedSessions : data.sessions;
        for (const coach of data.coaches) {
            if (!Array.isArray(coach.savedAvailability)) {
                coach.savedAvailability = [...coach.slots];
            }
            coach.savedAvailability = coach.savedAvailability.map(templateFromSlot);
            coach.timezone ??= DEFAULT_COACH_TIMEZONE;
            coach.slots = coach.slots.map(slot => isDatedSlot(slot) ? slot : buildDatedSlot(slot));
        }
        return data;
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            const initial = { coaches: [], players: [], sessions: [] };
            await writeData(initial);
            return initial;
        }
        throw err;
    }
}
let writeQueue = Promise.resolve();
export async function writeData(data) {
    writeQueue = writeQueue.then(async () => {
        // Try to persist to KV first when available.
        if (kvAvailable) {
            const ok = await kvSetSchedulerData(data);
            if (ok)
                return;
        }
        await mkdir(path.dirname(dataFile), { recursive: true });
        const tmp = `${dataFile}.tmp`;
        await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await rename(tmp, dataFile);
    });
    return writeQueue;
}
/* -------------------------------------------------------
   UI Builders (Embeds, Menus, Buttons)
-------------------------------------------------------- */
export function buildCoachEmbed(coach) {
    const activeSlots = getActiveSlots(coach);
    const embed = new EmbedBuilder()
        .setTitle(coach.username)
        .setDescription(coach.bio || 'No bio provided yet.')
        .addFields({
        name: 'Specialties',
        value: coach.specialties.length > 0
            ? coach.specialties.join(', ')
            : 'Not listed',
        inline: false
    }, {
        name: 'Open Slots',
        value: activeSlots.length > 0
            ? formatSlotsForViewer(activeSlots, coach.timezone ?? DEFAULT_COACH_TIMEZONE).join('\n')
            : 'No slots available',
        inline: false
    }, {
        name: 'Visibility',
        value: coach.visibility === 'all'
            ? 'All servers'
            : 'This server only',
        inline: false
    })
        .setColor(0x5865f2);
    if (coach.avatarUrl) {
        embed.setThumbnail(coach.avatarUrl);
    }
    return embed;
}
function getSlotDay(slot) {
    return slot.split(' ')[0];
}
export function buildScheduleDayButtons(coach) {
    const activeSlots = getActiveSlots(coach);
    const availableDays = availabilityDays.filter(day => activeSlots.some(slot => getSlotDay(slot) === day));
    // Discord permits at most five buttons in an action row. There are only
    // seven possible days, so two rows are enough to show every available day.
    return Array.from({ length: Math.ceil(availableDays.length / 5) }, (_, index) => {
        const row = new ActionRowBuilder();
        row.addComponents(...availableDays.slice(index * 5, index * 5 + 5).map(day => {
            const slotCount = activeSlots.filter(slot => getSlotDay(slot) === day).length;
            return new ButtonBuilder()
                .setCustomId(`request-day:${coach.id}:${day}`)
                .setLabel(`${day} (${slotCount})`)
                .setStyle(ButtonStyle.Primary);
        }));
        return row;
    });
}
export function buildSlotSelectMenu(coach, playerTimezone, day) {
    const activeSlots = getActiveSlots(coach).filter(slot => getSlotDay(slot) === day);
    const row = new ActionRowBuilder();
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`request-slot:${coach.id}:${day}`)
        .setPlaceholder(activeSlots.length === 0
        ? 'No slots available'
        : `Select a time on ${day}`)
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(activeSlots.length === 0)
        .addOptions(activeSlots.length > 0
        ? activeSlots.slice(0, 25).map(slot => new StringSelectMenuOptionBuilder()
            .setLabel(formatSlotForPlayer(slot, coach.timezone ?? DEFAULT_COACH_TIMEZONE, playerTimezone))
            .setValue(slot))
        : [
            new StringSelectMenuOptionBuilder()
                .setLabel('No slots available')
                .setValue('none')
        ]);
    row.addComponents(menu);
    return [row];
}
export function buildScheduleButton(coach) {
    const row = new ActionRowBuilder();
    row.addComponents(new ButtonBuilder()
        .setCustomId(`schedule-coach:${coach.id}`)
        .setLabel('Schedule')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(getActiveSlots(coach).length === 0));
    return [row];
}
export function buildSchedulerMainMenuButtons() {
    const row = new ActionRowBuilder();
    row.addComponents(new ButtonBuilder()
        .setCustomId('ui-player')
        .setLabel('Player')
        .setStyle(ButtonStyle.Primary), new ButtonBuilder()
        .setCustomId('ui-coach')
        .setLabel('Coach')
        .setStyle(ButtonStyle.Success));
    return [row];
}
export function buildPlayerMenuButtons() {
    const row = new ActionRowBuilder();
    row.addComponents(new ButtonBuilder()
        .setCustomId('ui-player-browse')
        .setLabel('Browse coaches')
        .setStyle(ButtonStyle.Primary), new ButtonBuilder()
        .setCustomId('ui-player-timezone')
        .setLabel('Set timezone')
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId('ui-player-cancel')
        .setLabel('Cancel appointment')
        .setStyle(ButtonStyle.Danger));
    return [row];
}
export function buildCoachMenuButtons() {
    const row = new ActionRowBuilder();
    row.addComponents(new ButtonBuilder()
        .setCustomId('ui-coach-availability')
        .setLabel('Set availability')
        .setStyle(ButtonStyle.Success), new ButtonBuilder()
        .setCustomId('ui-coach-remove')
        .setLabel('Remove profile')
        .setStyle(ButtonStyle.Danger), new ButtonBuilder()
        .setCustomId('ui-coach-cancel')
        .setLabel('Cancel appointment')
        .setStyle(ButtonStyle.Secondary));
    return [row];
}
export function buildTimezoneSelectionMenu() {
    const row = new ActionRowBuilder();
    const menu = new StringSelectMenuBuilder()
        .setCustomId('ui-timezone-select')
        .setPlaceholder('Select your timezone')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(...coachTimezones.map(zone => new StringSelectMenuOptionBuilder()
        .setLabel(zone.name)
        .setValue(zone.value)));
    row.addComponents(menu);
    return [row];
}
export function buildRequestConfirmationButtons() {
    const row = new ActionRowBuilder();
    row.addComponents(new ButtonBuilder()
        .setCustomId('schedule-confirm:confirm')
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success), new ButtonBuilder()
        .setCustomId('schedule-confirm:cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId('schedule-confirm:reselect')
        .setLabel('Reselect time')
        .setStyle(ButtonStyle.Primary));
    return [row];
}
export function buildDaySelectionMenu() {
    const row = new ActionRowBuilder();
    const menu = new StringSelectMenuBuilder()
        .setCustomId('availability-day')
        .setPlaceholder('Select days')
        .setMinValues(1)
        .setMaxValues(availabilityDays.length)
        .addOptions(...availabilityDays.map(day => {
        const datedDay = buildDatedSlot(`${day} 12pm`);
        const dateLabel = datedDay.match(/^[A-Za-z]+\s+(.+)\s+at\s+12pm$/)?.[1] ?? day;
        return (new StringSelectMenuOptionBuilder()
            .setLabel(`${day} (${dateLabel})`)
            .setValue(day));
    }));
    row.addComponents(menu);
    return [row];
}
export function buildTimeSelectionMenu(day) {
    const row = new ActionRowBuilder();
    const menu = new StringSelectMenuBuilder()
        .setCustomId('availability-time')
        .setPlaceholder(`Select times for ${day}`)
        .setMinValues(1)
        .setMaxValues(availabilityTimes.length)
        .addOptions(...availabilityTimes.map(time => new StringSelectMenuOptionBuilder()
        .setLabel(time)
        .setValue(time)));
    row.addComponents(menu);
    return [row];
}
export function buildAvailabilityCompleteButtons() {
    const row = new ActionRowBuilder();
    row.addComponents(new ButtonBuilder()
        .setCustomId('availability-finish')
        .setLabel('Finish')
        .setStyle(ButtonStyle.Success));
    return [row];
}
function formatAppointmentLabel(session) {
    return `${session.coachUsername} • ${session.slot}`;
}
export function buildAppointmentCancellationMenu(sessions) {
    const row = new ActionRowBuilder();
    const menu = new StringSelectMenuBuilder()
        .setCustomId('cancel-appointment-select')
        .setPlaceholder('Select an appointment to cancel')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(sessions.slice(0, 25).map(session => new StringSelectMenuOptionBuilder()
        .setLabel(session.coachUsername)
        .setDescription(session.slot)
        .setValue(session.id)));
    row.addComponents(menu);
    return [row];
}
export function buildAppointmentCancellationConfirmationButtons(sessionId) {
    const row = new ActionRowBuilder();
    row.addComponents(new ButtonBuilder()
        .setCustomId(`cancel-appointment:confirm:${sessionId}`)
        .setLabel('Confirm cancellation')
        .setStyle(ButtonStyle.Danger), new ButtonBuilder()
        .setCustomId(`cancel-appointment:cancel:${sessionId}`)
        .setLabel('Keep appointment')
        .setStyle(ButtonStyle.Secondary));
    return [row];
}
export function buildMondayRestoreButtons(coachId) {
    const row = new ActionRowBuilder();
    row.addComponents(new ButtonBuilder()
        .setCustomId(`monday-restore:accept:${coachId}`)
        .setLabel('Restore next Monday')
        .setStyle(ButtonStyle.Success), new ButtonBuilder()
        .setCustomId(`monday-restore:reject:${coachId}`)
        .setLabel('Not now')
        .setStyle(ButtonStyle.Secondary));
    return [row];
}
/* -------------------------------------------------------
   Notifications & DM Helpers
-------------------------------------------------------- */
export async function sendDmToUser(userId, guildId, payload) {
    const user = await client.users.fetch(userId);
    const dm = await user.createDM();
    await dm.send(payload);
}
export async function notifyCoachOfRequest(coach, requesterUsername, slot, requestId, fallbackChannelId, guildId) {
    const description = `${requesterUsername} requested a coaching session with you for ${slot}.`;
    try {
        await sendDmToUser(coach.userId, guildId, {
            embeds: [
                new EmbedBuilder()
                    .setTitle('New coaching session request')
                    .setDescription(description)
                    .setColor(0x5865f2)
            ],
            components: [
                new ActionRowBuilder().addComponents(new ButtonBuilder()
                    .setCustomId(`request-action:accept:${requestId}`)
                    .setLabel('Accept')
                    .setStyle(ButtonStyle.Success), new ButtonBuilder()
                    .setCustomId(`request-action:reject:${requestId}`)
                    .setLabel('Reject')
                    .setStyle(ButtonStyle.Danger))
            ]
        });
        return;
    }
    catch (err) {
        console.error(`Failed to DM coach ${coach.userId}`, err);
    }
    // Fallback to server channel
    if (!guildId)
        return;
    try {
        const guild = await client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        const fallbackChannel = channels.find((channel) => channel?.isTextBased() &&
            channel.name === fallbackChannelName);
        if (fallbackChannel && 'send' in fallbackChannel) {
            const mention = `<@${coach.userId}>`;
            await fallbackChannel.send({
                content: `${mention} ${description}`,
                embeds: [
                    new EmbedBuilder()
                        .setTitle('New coaching session request')
                        .setDescription(description)
                        .setColor(0x5865f2)
                ],
                components: [
                    new ActionRowBuilder().addComponents(new ButtonBuilder()
                        .setCustomId(`request-action:accept:${requestId}`)
                        .setLabel('Accept')
                        .setStyle(ButtonStyle.Success), new ButtonBuilder()
                        .setCustomId(`request-action:reject:${requestId}`)
                        .setLabel('Reject')
                        .setStyle(ButtonStyle.Danger))
                ]
            });
        }
    }
    catch (fallbackErr) {
        console.error(`Failed to fallback notify coach ${coach.userId} in ${fallbackChannelName}`, fallbackErr);
    }
}
export async function notifyRequesterOfDecision(requesterId, coachUsername, slot, accepted, reason, requestInteraction, guildId) {
    const description = accepted
        ? `${coachUsername} accepted your coaching request for ${slot}.`
        : `${coachUsername} rejected your coaching request for ${slot}.` +
            (reason ? ` Reason: ${reason}` : '');
    try {
        await sendDmToUser(requesterId, guildId, {
            embeds: [
                new EmbedBuilder()
                    .setTitle(accepted
                    ? 'Coaching request accepted'
                    : 'Coaching request rejected')
                    .setDescription(description)
                    .setColor(accepted ? 0x57f287 : 0xed4245)
            ]
        });
        return;
    }
    catch (err) {
        console.error(`Failed to DM requester ${requesterId}. Falling back to ephemeral reply.`, err);
    }
    if (!requestInteraction?.isRepliable())
        return;
    try {
        const payload = {
            embeds: [
                new EmbedBuilder()
                    .setTitle(accepted
                    ? 'Coaching request accepted'
                    : 'Coaching request rejected')
                    .setDescription(description)
                    .setColor(accepted ? 0x57f287 : 0xed4245)
            ],
            ephemeral: requestInteraction.inGuild()
        };
        if (requestInteraction.replied || requestInteraction.deferred) {
            await requestInteraction.followUp(payload);
        }
        else {
            await requestInteraction.reply(payload);
        }
    }
    catch (fallbackErr) {
        console.error(`Failed to fallback notify requester ${requesterId} via interaction reply`, fallbackErr);
    }
}
/* -------------------------------------------------------
   Notify Coach When All Slots Are Booked
-------------------------------------------------------- */
export async function notifyAvailabilityEmpty(coach) {
    try {
        await sendDmToUser(coach.userId, coach.guildId, {
            embeds: [
                new EmbedBuilder()
                    .setTitle('Your coaching schedule is full!')
                    .setDescription('All of your available coaching slots have been booked. Would you like your saved availability restored next Monday?')
                    .setColor(0x57f287)
            ],
            components: buildMondayRestoreButtons(coach.id)
        });
    }
    catch (err) {
        console.error('Failed to notify coach of empty availability', err);
    }
}
/* -------------------------------------------------------
   Slash Commands
-------------------------------------------------------- */
export const commands = [
    new SlashCommandBuilder()
        .setName('coach-register')
        .setDescription('Register yourself as a coach with available time slots')
        .addStringOption((option) => option
        .setName('bio')
        .setDescription('Short intro about your coaching style')
        .setRequired(true))
        .addStringOption((option) => option
        .setName('specialties')
        .setDescription('Comma-separated specialties')
        .setRequired(true))
        .addStringOption((option) => option
        .setName('visibility')
        .setDescription('Show your coaching profile on this server only or on all servers')
        .setRequired(true)
        .addChoices({ name: 'This server only', value: 'server' }, { name: 'All servers', value: 'all' }))
        .addStringOption((option) => option
        .setName('timezone')
        .setDescription('Timezone used when entering your availability')
        .setRequired(false)
        .addChoices(...coachTimezones))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('coach-list')
        .setDescription('List available coaches and their open slots')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('player-registration')
        .setDescription('Set your timezone for locally displayed coaching availability')
        .addStringOption((option) => option
        .setName('timezone')
        .setDescription('Your local timezone')
        .setRequired(true)
        .addChoices(...coachTimezones))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('update-availability')
        .setDescription('Update your available coaching times')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('coach-remove')
        .setDescription('Remove your coach profile')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('cancel-appointment')
        .setDescription('Cancel one of your coaching appointments')
        .toJSON()
];
/* -------------------------------------------------------
   Interaction Handlers
-------------------------------------------------------- */
client.on('interactionCreate', async (interaction) => {
    /* ---------------------------------------------------
       Slash Command Handling
    ---------------------------------------------------- */
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        try {
            /* -----------------------------
               /coach-register
            ------------------------------ */
            if (commandName === 'coach-register') {
                const bio = interaction.options.getString('bio', true);
                const specialtiesRaw = interaction.options.getString('specialties') ?? '';
                const visibility = interaction.options.getString('visibility', true);
                const timezone = interaction.options.getString('timezone') ?? DEFAULT_COACH_TIMEZONE;
                pendingAvailability.set(interaction.user.id, {
                    userId: interaction.user.id,
                    bio,
                    specialties: specialtiesRaw.split(',').map(s => s.trim()).filter(Boolean),
                    visibility,
                    guildId: interaction.guildId ?? undefined,
                    timezone
                });
                availabilityByDay.set(interaction.user.id, {});
                availabilityDayQueue.delete(interaction.user.id);
                availabilityCurrentDay.delete(interaction.user.id);
                await interaction.reply({
                    content: 'Choose the days you are available.',
                    components: buildDaySelectionMenu(),
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            /* -----------------------------
               /player-registration
            ------------------------------ */
            if (commandName === 'player-registration') {
                const timezone = interaction.options.getString('timezone', true);
                const data = await readData();
                const existing = data.players.find(player => player.userId === interaction.user.id);
                if (existing) {
                    existing.timezone = timezone;
                }
                else {
                    data.players.push({
                        userId: interaction.user.id,
                        timezone,
                        createdAt: new Date().toISOString()
                    });
                }
                await writeData(data);
                await interaction.reply({
                    content: `Your timezone has been set to ${coachTimezones.find(zone => zone.value === timezone)?.name ?? timezone}.`,
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            /* -----------------------------
               /update-availability
            ------------------------------ */
            if (commandName === 'update-availability') {
                const data = await readData();
                const profile = data.coaches.find(coach => coach.userId === interaction.user.id &&
                    (coach.guildId === interaction.guildId || coach.visibility === 'all'));
                if (!profile) {
                    await interaction.reply({
                        content: 'You do not have a coach profile here yet. Please run /coach-register first.',
                        ephemeral: interaction.inGuild()
                    });
                    return;
                }
                pendingAvailability.set(interaction.user.id, {
                    userId: interaction.user.id,
                    bio: profile.bio,
                    specialties: profile.specialties,
                    visibility: profile.visibility,
                    guildId: profile.guildId,
                    coachId: profile.id,
                    timezone: profile.timezone ?? DEFAULT_COACH_TIMEZONE
                });
                availabilityByDay.set(interaction.user.id, {});
                availabilityDayQueue.delete(interaction.user.id);
                availabilityCurrentDay.delete(interaction.user.id);
                await interaction.reply({
                    content: 'Choose the days you are available. This will replace your current availability.',
                    components: buildDaySelectionMenu(),
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            /* -----------------------------
               /coach-list
            ------------------------------ */
            if (commandName === 'coach-list') {
                const data = await readData();
                const player = data.players.find(entry => entry.userId === interaction.user.id);
                if (!player) {
                    await interaction.reply({
                        content: 'Please run /player-registration and choose your timezone before viewing coaching availability.',
                        ephemeral: interaction.inGuild()
                    });
                    return;
                }
                const visibleCoaches = data.coaches.filter(coach => coach.visibility === 'all' ||
                    coach.guildId === interaction.guildId);
                if (visibleCoaches.length === 0) {
                    await interaction.reply({
                        content: 'No coaches are available in this server yet.',
                        ephemeral: interaction.inGuild()
                    });
                    return;
                }
                await interaction.deferReply({ ephemeral: interaction.inGuild() });
                const listMessages = [];
                for (const coach of visibleCoaches) {
                    const message = await interaction.followUp({
                        embeds: [buildCoachEmbed(coach)],
                        components: buildScheduleButton(coach),
                        ephemeral: interaction.inGuild()
                    });
                    listMessages.push(message.id);
                }
                coachListMessages.set(interaction.user.id, {
                    messageIds: listMessages,
                    // Follow-ups, especially ephemeral ones, must be deleted
                    // through the webhook that created them.
                    deleteMessage: (messageId) => interaction.webhook.deleteMessage(messageId)
                });
                return;
            }
            /* -----------------------------
               /coach-remove
            ------------------------------ */
            if (commandName === 'coach-remove') {
                const guildId = interaction.guildId ?? undefined;
                const data = await readData();
                const before = data.coaches.length;
                data.coaches = data.coaches.filter(coach => {
                    if (coach.userId !== interaction.user.id)
                        return true;
                    const belongsHere = coach.guildId === guildId || coach.visibility === 'all';
                    return !belongsHere;
                });
                if (data.coaches.length === before) {
                    await interaction.reply('You do not currently have a coach profile in this server.');
                    return;
                }
                await writeData(data);
                await interaction.reply('Removed your coach profile for this server.');
                return;
            }
            /* -----------------------------
               /cancel-appointment
            ------------------------------ */
            if (commandName === 'cancel-appointment') {
                const data = await readData();
                const coachIds = data.coaches
                    .filter(coach => coach.userId === interaction.user.id)
                    .map(coach => coach.id);
                const sessions = data.sessions.filter(session => session.playerId === interaction.user.id || coachIds.includes(session.coachId));
                if (sessions.length === 0) {
                    await interaction.reply({
                        content: 'You do not have any appointments to cancel.',
                        ephemeral: interaction.inGuild()
                    });
                    return;
                }
                await interaction.reply({
                    content: 'Select the appointment you want to cancel.',
                    components: buildAppointmentCancellationMenu(sessions),
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            await interaction.reply('Unknown command.');
        }
        catch (err) {
            console.error(err);
            await interaction.reply({
                content: 'Something went wrong while processing that command.',
                ephemeral: interaction.inGuild()
            });
        }
    }
    /* ---------------------------------------------------
       Availability Day Selection
    ---------------------------------------------------- */
    if (interaction.isStringSelectMenu()) {
        /* -----------------------------
           Select Days
        ------------------------------ */
        if (interaction.customId === 'availability-day') {
            const pending = pendingAvailability.get(interaction.user.id);
            if (!pending) {
                await interaction.reply({
                    content: 'Your availability setup has expired. Please run /coach-register again.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            const days = [...interaction.values];
            const firstDay = days.shift();
            if (!firstDay) {
                await interaction.reply({
                    content: 'Please select at least one day.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            availabilityByDay.set(interaction.user.id, {});
            availabilityDayQueue.set(interaction.user.id, days);
            availabilityCurrentDay.set(interaction.user.id, firstDay);
            await interaction.reply({
                content: `Select the times you're available on **${firstDay}**.`,
                components: buildTimeSelectionMenu(firstDay),
                ephemeral: interaction.inGuild()
            });
            return;
        }
        /* -----------------------------
           Select Times
        ------------------------------ */
        if (interaction.customId === 'availability-time') {
            const pending = pendingAvailability.get(interaction.user.id);
            const currentDay = availabilityCurrentDay.get(interaction.user.id);
            if (!pending || !currentDay) {
                await interaction.reply({
                    content: 'Your availability setup has expired. Please run /coach-register again.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            const dayTimes = availabilityByDay.get(interaction.user.id) ?? {};
            dayTimes[currentDay] = interaction.values;
            availabilityByDay.set(interaction.user.id, dayTimes);
            const queue = availabilityDayQueue.get(interaction.user.id) ?? [];
            const nextDay = queue.shift();
            if (nextDay) {
                availabilityDayQueue.set(interaction.user.id, queue);
                availabilityCurrentDay.set(interaction.user.id, nextDay);
                await interaction.update({
                    content: `Selected **${currentDay}**: ${interaction.values.join(', ')}\nNow select the times you're available on **${nextDay}**.`,
                    components: buildTimeSelectionMenu(nextDay)
                });
                return;
            }
            // Finished selecting all days
            availabilityCurrentDay.delete(interaction.user.id);
            availabilityDayQueue.delete(interaction.user.id);
            const summary = Object.entries(dayTimes)
                .map(([day, times]) => `**${day}**: ${times.join(', ')}`)
                .join('\n');
            await interaction.update({
                content: `Here's your availability:\n${summary}`,
                components: buildAvailabilityCompleteButtons()
            });
            return;
        }
        /* -----------------------------
           Timezone selection for UI flow
        ------------------------------ */
        if (interaction.customId === 'ui-timezone-select') {
            const timezone = interaction.values[0];
            const data = await readData();
            const existing = data.players.find(player => player.userId === interaction.user.id);
            if (existing) {
                existing.timezone = timezone;
            }
            else {
                data.players.push({
                    userId: interaction.user.id,
                    timezone,
                    createdAt: new Date().toISOString()
                });
            }
            await writeData(data);
            await interaction.update({
                content: `Your timezone has been set to ${coachTimezones.find(zone => zone.value === timezone)?.name ?? timezone}.`,
                components: []
            });
            return;
        }
        /* -----------------------------
           Cancel Appointment (Select Session)
        ------------------------------ */
        if (interaction.customId === 'cancel-appointment-select') {
            const sessionId = interaction.values[0];
            const data = await readData();
            const session = data.sessions.find(entry => entry.id === sessionId);
            if (!session) {
                await interaction.reply({
                    content: 'That appointment is no longer available.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            const coachIds = data.coaches
                .filter(coach => coach.userId === interaction.user.id)
                .map(coach => coach.id);
            const isParticipant = session.playerId === interaction.user.id || coachIds.includes(session.coachId);
            if (!isParticipant) {
                await interaction.reply({
                    content: 'You are not part of that appointment.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            await interaction.update({
                content: `You selected ${formatAppointmentLabel(session)}. Do you want to cancel it?`,
                components: buildAppointmentCancellationConfirmationButtons(sessionId)
            });
            return;
        }
        /* ---------------------------------------------------
           Slot Request (User selects a coach slot)
        ---------------------------------------------------- */
        if (interaction.customId.startsWith('request-slot:')) {
            const [, coachId, day] = interaction.customId.split(':');
            const slot = interaction.values[0];
            if (slot === 'none') {
                await interaction.reply({
                    content: 'That coach has no open slots right now.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            const data = await readData();
            const coach = data.coaches.find(c => c.id === coachId);
            if (!coach) {
                await interaction.reply({
                    content: 'That coach profile is no longer available.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            if (!getActiveSlots(coach).includes(slot)) {
                await interaction.reply({
                    content: 'That slot is no longer available. Please try again.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            pendingScheduleSelections.set(interaction.user.id, {
                coachId: coach.id,
                day,
                slot,
                coachUsername: coach.username,
                requesterId: interaction.user.id,
                requesterUsername: interaction.user.username,
                channelId: interaction.channelId ?? undefined,
                guildId: interaction.guildId ?? undefined
            });
            await interaction.update({
                content: `You selected **${slot}** with ${coach.username}. Confirm this request?`,
                components: buildRequestConfirmationButtons()
            });
            return;
        }
    }
    /* ---------------------------------------------------
       Button Handlers
    ---------------------------------------------------- */
    if (interaction.isButton()) {
        const [type, action, requestId] = interaction.customId.split(':');
        /* -----------------------------
           Main UI entry points
        ------------------------------ */
        if (interaction.customId === 'ui-player') {
            await interaction.update({
                content: 'Player options',
                components: buildPlayerMenuButtons()
            });
            return;
        }
        if (interaction.customId === 'ui-coach') {
            await interaction.update({
                content: 'Coach options',
                components: buildCoachMenuButtons()
            });
            return;
        }
        if (interaction.customId === 'ui-player-browse') {
            const data = await readData();
            const player = data.players.find(entry => entry.userId === interaction.user.id);
            if (!player) {
                await interaction.update({
                    content: 'Please set your timezone first so coach availability can be shown in your local time.',
                    components: buildPlayerMenuButtons()
                });
                return;
            }
            const visibleCoaches = data.coaches.filter(coach => coach.visibility === 'all' || coach.guildId === interaction.guildId);
            if (visibleCoaches.length === 0) {
                await interaction.update({
                    content: 'No coaches are available in this server yet.',
                    components: buildPlayerMenuButtons()
                });
                return;
            }
            const listMessages = [];
            const listMessage = await interaction.update({
                embeds: visibleCoaches.map(coach => buildCoachEmbed(coach)),
                content: 'Here are the available coaches.',
                components: visibleCoaches.map(coach => buildScheduleButton(coach)).flat()
            });
            listMessages.push(listMessage.id);
            return;
        }
        if (interaction.customId === 'ui-player-timezone') {
            await interaction.update({
                content: 'Choose your timezone.',
                components: buildTimezoneSelectionMenu()
            });
            return;
        }
        if (interaction.customId === 'ui-player-cancel') {
            const data = await readData();
            const coachIds = data.coaches
                .filter(coach => coach.userId === interaction.user.id)
                .map(coach => coach.id);
            const sessions = data.sessions.filter(session => session.playerId === interaction.user.id || coachIds.includes(session.coachId));
            if (sessions.length === 0) {
                await interaction.update({
                    content: 'You do not have any appointments to cancel.',
                    components: buildPlayerMenuButtons()
                });
                return;
            }
            await interaction.update({
                content: 'Select the appointment you want to cancel.',
                components: buildAppointmentCancellationMenu(sessions)
            });
            return;
        }
        if (interaction.customId === 'ui-coach-availability') {
            const data = await readData();
            const profile = data.coaches.find(coach => coach.userId === interaction.user.id &&
                (coach.guildId === interaction.guildId || coach.visibility === 'all'));
            pendingAvailability.set(interaction.user.id, {
                userId: interaction.user.id,
                bio: profile?.bio ?? '',
                specialties: profile?.specialties ?? [],
                visibility: profile?.visibility ?? 'server',
                guildId: profile?.guildId,
                coachId: profile?.id,
                timezone: profile?.timezone ?? DEFAULT_COACH_TIMEZONE
            });
            availabilityByDay.set(interaction.user.id, {});
            availabilityDayQueue.delete(interaction.user.id);
            availabilityCurrentDay.delete(interaction.user.id);
            await interaction.update({
                content: 'Choose the days you are available.',
                components: buildDaySelectionMenu()
            });
            return;
        }
        if (interaction.customId === 'ui-coach-remove') {
            const guildId = interaction.guildId ?? undefined;
            const data = await readData();
            const before = data.coaches.length;
            data.coaches = data.coaches.filter(coach => {
                if (coach.userId !== interaction.user.id)
                    return true;
                const belongsHere = coach.guildId === guildId || coach.visibility === 'all';
                return !belongsHere;
            });
            if (data.coaches.length === before) {
                await interaction.update({
                    content: 'You do not currently have a coach profile in this server.',
                    components: buildCoachMenuButtons()
                });
                return;
            }
            await writeData(data);
            await interaction.update({
                content: 'Removed your coach profile for this server.',
                components: []
            });
            return;
        }
        if (interaction.customId === 'ui-coach-cancel') {
            const data = await readData();
            const coachIds = data.coaches
                .filter(coach => coach.userId === interaction.user.id)
                .map(coach => coach.id);
            const sessions = data.sessions.filter(session => session.playerId === interaction.user.id || coachIds.includes(session.coachId));
            if (sessions.length === 0) {
                await interaction.update({
                    content: 'You do not have any appointments to cancel.',
                    components: buildCoachMenuButtons()
                });
                return;
            }
            await interaction.update({
                content: 'Select the appointment you want to cancel.',
                components: buildAppointmentCancellationMenu(sessions)
            });
            return;
        }
        if (interaction.customId === 'ui-main') {
            await interaction.update({
                content: 'Choose your role.',
                components: buildSchedulerMainMenuButtons()
            });
            return;
        }
        /* -----------------------------
           Select Coach to Schedule
        ------------------------------ */
        if (type === 'schedule-coach') {
            const coachId = action;
            const data = await readData();
            const player = data.players.find(entry => entry.userId === interaction.user.id);
            const coach = data.coaches.find(entry => entry.id === coachId);
            if (!player || !coach) {
                await interaction.reply({
                    content: 'That coach or your player profile is no longer available.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            await interaction.update({
                embeds: [buildCoachEmbed(coach)],
                content: 'Choose a day, then choose a time.',
                components: buildScheduleDayButtons(coach)
            });
            const listSession = coachListMessages.get(interaction.user.id);
            await Promise.all((listSession?.messageIds ?? [])
                .filter(messageId => messageId !== interaction.message.id)
                .map(messageId => listSession.deleteMessage(messageId).catch(() => undefined)));
            coachListMessages.delete(interaction.user.id);
            return;
        }
        /* -----------------------------
           Select a Day to Schedule
        ------------------------------ */
        if (type === 'request-day') {
            const coachId = action;
            const day = requestId;
            const data = await readData();
            const player = data.players.find(entry => entry.userId === interaction.user.id);
            const coach = data.coaches.find(entry => entry.id === coachId);
            if (!player || !coach || !day) {
                await interaction.reply({
                    content: 'That coach or your player profile is no longer available.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            const hasSlotsOnDay = getActiveSlots(coach).some(slot => getSlotDay(slot) === day);
            if (!hasSlotsOnDay) {
                await interaction.update({
                    content: 'That day no longer has open slots. Please choose another day.',
                    components: buildScheduleDayButtons(coach)
                });
                return;
            }
            await interaction.update({
                content: `Choose a time on **${day}**.`,
                components: buildSlotSelectMenu(coach, player.timezone, day)
            });
            return;
        }
        /* -----------------------------
           Confirm / Cancel / Reselect Scheduling Request
        ------------------------------ */
        if (type === 'schedule-confirm') {
            const pendingSelection = pendingScheduleSelections.get(interaction.user.id);
            if (!pendingSelection) {
                await interaction.update({
                    content: 'Your scheduling selection has expired. Please choose a day and time again.',
                    components: []
                });
                return;
            }
            if (action === 'cancel') {
                pendingScheduleSelections.delete(interaction.user.id);
                await interaction.update({
                    content: 'Request canceled.',
                    components: []
                });
                return;
            }
            if (action === 'reselect') {
                pendingScheduleSelections.delete(interaction.user.id);
                const data = await readData();
                const player = data.players.find(entry => entry.userId === interaction.user.id);
                const coach = data.coaches.find(entry => entry.id === pendingSelection.coachId);
                if (!player || !coach) {
                    await interaction.update({
                        content: 'That coach or your player profile is no longer available.',
                        components: []
                    });
                    return;
                }
                await interaction.update({
                    content: `Choose a day, then choose a time.`,
                    components: buildScheduleDayButtons(coach)
                });
                return;
            }
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            pendingRequests.set(requestId, {
                coachId: pendingSelection.coachId,
                coachUsername: pendingSelection.coachUsername,
                requesterId: pendingSelection.requesterId,
                requesterUsername: pendingSelection.requesterUsername,
                requesterChannelId: pendingSelection.channelId,
                requestChannelId: pendingSelection.channelId,
                guildId: pendingSelection.guildId,
                requestInteraction: interaction,
                slot: pendingSelection.slot
            });
            const data = await readData();
            const coach = data.coaches.find(entry => entry.id === pendingSelection.coachId);
            if (!coach) {
                pendingScheduleSelections.delete(interaction.user.id);
                await interaction.update({
                    content: 'That coach profile is no longer available.',
                    components: []
                });
                return;
            }
            await notifyCoachOfRequest(coach, pendingSelection.requesterUsername, pendingSelection.slot, requestId, pendingSelection.channelId, pendingSelection.guildId);
            pendingScheduleSelections.delete(interaction.user.id);
            await interaction.update({
                content: `You requested a coaching session with ${coach.username} for ${pendingSelection.slot}. They have been notified to confirm the booking.`,
                components: []
            });
            return;
        }
        /* -----------------------------
           Finish Availability Setup
        ------------------------------ */
        if (interaction.customId === 'availability-finish') {
            const pending = pendingAvailability.get(interaction.user.id);
            const dayTimes = availabilityByDay.get(interaction.user.id);
            if (!pending || !dayTimes) {
                await interaction.reply({
                    content: 'Your availability setup has expired. Please run /coach-register again.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            const availabilityTemplates = Object.entries(dayTimes)
                .flatMap(([day, times]) => times.map(time => `${day} ${time}`));
            const normalizedSlots = availabilityTemplates.map(template => buildDatedSlot(template));
            const data = await readData();
            const existing = pending.coachId
                ? data.coaches.find(coach => coach.id === pending.coachId)
                : data.coaches.find(coach => coach.userId === interaction.user.id &&
                    (coach.guildId === pending.guildId || coach.visibility === 'all'));
            if (existing) {
                existing.bio = pending.bio;
                existing.specialties = pending.specialties;
                existing.slots = normalizedSlots;
                existing.savedAvailability = [...availabilityTemplates];
                existing.scheduledRestoreDate = undefined;
                existing.username = interaction.user.username;
                existing.avatarUrl = interaction.user.displayAvatarURL({ extension: 'png' });
                existing.visibility = pending.visibility;
                existing.guildId = pending.guildId;
                existing.timezone = pending.timezone ?? existing.timezone ?? DEFAULT_COACH_TIMEZONE;
                await writeData(data);
                await interaction.reply({
                    content: `Updated your coach profile. You now have ${normalizedSlots.length} slot(s) available.`,
                    ephemeral: interaction.inGuild()
                });
            }
            else {
                const profile = {
                    id: `${Date.now()}`,
                    userId: interaction.user.id,
                    username: interaction.user.username,
                    avatarUrl: interaction.user.displayAvatarURL({ extension: 'png' }),
                    bio: pending.bio,
                    specialties: pending.specialties,
                    slots: normalizedSlots,
                    savedAvailability: [...availabilityTemplates],
                    visibility: pending.visibility,
                    guildId: pending.guildId,
                    timezone: pending.timezone ?? DEFAULT_COACH_TIMEZONE,
                    createdAt: new Date().toISOString()
                };
                data.coaches.push(profile);
                await writeData(data);
                await interaction.reply({
                    content: `Registered ${interaction.user.username} as a coach.`,
                    ephemeral: interaction.inGuild()
                });
            }
            pendingAvailability.delete(interaction.user.id);
            availabilityByDay.delete(interaction.user.id);
            availabilityDayQueue.delete(interaction.user.id);
            availabilityCurrentDay.delete(interaction.user.id);
            return;
        }
        /* -----------------------------
           Accept / Reject Request
        ------------------------------ */
        if (type === 'request-action') {
            const pendingRequest = pendingRequests.get(requestId);
            if (!pendingRequest) {
                await interaction.reply({
                    content: 'That request is no longer available.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            /* -----------------------------
               Accept Request
            ------------------------------ */
            if (action === 'accept') {
                // Discord interactions must be acknowledged within roughly
                // three seconds. Booking can include disk and DM requests, so
                // acknowledge first and replace this response when complete.
                await interaction.deferReply({ ephemeral: interaction.inGuild() });
                const data = await readData();
                const coach = data.coaches.find(c => c.id === pendingRequest.coachId);
                if (!coach || coach.userId !== interaction.user.id) {
                    await interaction.editReply({
                        content: 'Only the coach who received this request can accept it.'
                    });
                    return;
                }
                const removed = removeBookedSlot(data, pendingRequest.coachId, pendingRequest.slot);
                if (!removed) {
                    pendingRequests.delete(requestId);
                    await interaction.editReply({
                        content: 'That slot is no longer available to accept.'
                    });
                    return;
                }
                coach.slots = getActiveSlots(coach);
                const session = createBookedSession(data, coach.id, coach.username, pendingRequest.requesterId, pendingRequest.requesterUsername, pendingRequest.slot, pendingRequest.guildId);
                await writeData(data);
                await writeScheduledAppointments(data.sessions);
                // Notify coach if schedule is empty after this booking.
                if (coachHasNoSlots(coach)) {
                    await notifyAvailabilityEmpty(coach);
                }
                pendingRequests.delete(requestId);
                await interaction.editReply({
                    content: `You accepted ${pendingRequest.requesterUsername}'s request for ${pendingRequest.slot}. Appointment ID: ${session.id}`
                });
                await notifyRequesterOfDecision(pendingRequest.requesterId, pendingRequest.coachUsername, pendingRequest.slot, true, undefined, pendingRequest.requestInteraction, pendingRequest.guildId);
                return;
            }
            /* -----------------------------
               Reject Request → Show Modal
            ------------------------------ */
            if (action === 'reject') {
                const data = await readData();
                const coach = data.coaches.find(c => c.id === pendingRequest.coachId);
                if (!coach || coach.userId !== interaction.user.id) {
                    await interaction.reply({
                        content: 'Only the coach who received this request can reject it.',
                        ephemeral: interaction.inGuild()
                    });
                    return;
                }
                const modal = new ModalBuilder()
                    .setCustomId(`reject-reason:${requestId}`)
                    .setTitle('Reason for rejection');
                const reasonInput = new TextInputBuilder()
                    .setCustomId('rejectionReason')
                    .setLabel('Optional reason')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false);
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
                return;
            }
        }
        /* -----------------------------
           Cancel Appointment Confirmation
        ------------------------------ */
        if (type === 'cancel-appointment') {
            const sessionId = requestId;
            const data = await readData();
            const session = data.sessions.find(entry => entry.id === sessionId);
            if (!session) {
                await interaction.update({
                    content: 'That appointment is no longer available.',
                    components: []
                });
                return;
            }
            const coachIds = data.coaches
                .filter(coach => coach.userId === interaction.user.id)
                .map(coach => coach.id);
            const isParticipant = session.playerId === interaction.user.id || coachIds.includes(session.coachId);
            if (!isParticipant) {
                await interaction.update({
                    content: 'You are not part of that appointment.',
                    components: []
                });
                return;
            }
            if (action === 'cancel') {
                await interaction.update({
                    content: `Okay — ${formatAppointmentLabel(session)} was not canceled.`,
                    components: []
                });
                return;
            }
            const result = cancelBookedSession(data, sessionId);
            if (!result.cancelled) {
                await interaction.update({
                    content: 'That appointment could not be canceled.',
                    components: []
                });
                return;
            }
            await writeData(data);
            await writeScheduledAppointments(data.sessions);
            const coach = data.coaches.find(entry => entry.id === session.coachId);
            const notificationText = `${interaction.user.username} canceled your coaching session for ${session.slot}.`;
            if (coach) {
                try {
                    await sendDmToUser(coach.userId, coach.guildId, {
                        embeds: [
                            new EmbedBuilder()
                                .setTitle('Coaching Session Canceled')
                                .setDescription(notificationText)
                                .setColor(0xed4245)
                        ]
                    });
                }
                catch (err) {
                    console.error('Failed to notify coach of appointment cancellation', err);
                }
            }
            try {
                await sendDmToUser(session.playerId, undefined, {
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Coaching Session Canceled')
                            .setDescription(notificationText)
                            .setColor(0xed4245)
                    ]
                });
            }
            catch (err) {
                console.error('Failed to notify player of appointment cancellation', err);
            }
            await interaction.update({
                content: `Canceled ${formatAppointmentLabel(session)}.`,
                components: []
            });
            return;
        }
        /* -----------------------------
           Restore Availability Button
        ------------------------------ */
        if (type === 'restore-availability') {
            await interaction.reply({
                content: 'This button has been replaced. When your schedule is full, choose whether to restore availability next Monday.',
                ephemeral: interaction.inGuild()
            });
            return;
        }
        /* -----------------------------
           Schedule Monday Availability Restore
        ------------------------------ */
        if (type === 'monday-restore') {
            const coachId = requestId;
            const data = await readData();
            const coach = data.coaches.find(c => c.id === coachId);
            if (!coach || coach.userId !== interaction.user.id) {
                await interaction.reply({
                    content: 'Only the coach who owns this availability can make that choice.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            if (action === 'accept') {
                coach.scheduledRestoreDate = getNextMondayDate();
                await writeData(data);
                await interaction.reply({
                    content: `Your saved availability will be restored automatically on Monday, ${formatLocalDate(coach.scheduledRestoreDate)}.`,
                    ephemeral: interaction.inGuild()
                });
                return;
            }
            if (action === 'reject') {
                coach.scheduledRestoreDate = undefined;
                await writeData(data);
                await interaction.reply({
                    content: 'Okay—your availability will not be restored automatically.',
                    ephemeral: interaction.inGuild()
                });
                return;
            }
        }
    }
    /* ---------------------------------------------------
       Modal Submission (Reject Reason)
    ---------------------------------------------------- */
    if (interaction.isModalSubmit()) {
        const [type, requestId] = interaction.customId.split(':');
        if (type !== 'reject-reason')
            return;
        const pendingRequest = pendingRequests.get(requestId);
        if (!pendingRequest) {
            await interaction.reply({
                content: 'That request is no longer available.',
                ephemeral: interaction.inGuild()
            });
            return;
        }
        const data = await readData();
        const coach = data.coaches.find(c => c.id === pendingRequest.coachId);
        if (!coach || coach.userId !== interaction.user.id) {
            await interaction.reply({
                content: 'Only the coach who received this request can reject it.',
                ephemeral: interaction.inGuild()
            });
            return;
        }
        const reason = interaction.fields.getTextInputValue('rejectionReason').trim();
        pendingRequests.delete(requestId);
        await notifyRequesterOfDecision(pendingRequest.requesterId, pendingRequest.coachUsername, pendingRequest.slot, false, reason || undefined, pendingRequest.requestInteraction, pendingRequest.guildId);
        await interaction.reply({
            content: 'You rejected the request and the requester has been notified.',
            ephemeral: interaction.inGuild()
        });
    }
});
/* -------------------------------------------------------
   Restore Availability Logic
-------------------------------------------------------- */
/**
 * Returns true if the coach has zero active (non-expired) slots.
 */
export function coachHasNoActiveSlots(coach) {
    return getActiveSlots(coach).length === 0;
}
/**
 * Restores a coach's saved availability, filtering out expired slots.
 * This ensures coaches never restore slots that have already passed today.
 */
export function restoreCoachAvailability(coach) {
    coach.slots = coach.savedAvailability
        .map(template => buildDatedSlot(template))
        .filter(slot => !isSlotExpiredToday(slot));
}
/**
 * Attempts to restore availability for a coach and writes the updated
 * scheduler data to disk.
 */
export async function restoreAvailabilityAndSave(coachId) {
    const data = await readData();
    const coach = data.coaches.find((c) => c.id === coachId);
    if (!coach) {
        return { restored: false, count: 0 };
    }
    restoreCoachAvailability(coach);
    await writeData(data);
    return { restored: true, count: coach.slots.length };
}
/* -------------------------------------------------------
   Scheduled Monday Availability Restore
-------------------------------------------------------- */
function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
export function getNextMondayDate(now = new Date()) {
    const nextMonday = new Date(now);
    const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    return localDateKey(nextMonday);
}
function formatLocalDate(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
    }).format(new Date(year, month - 1, day));
}
export async function processScheduledMondayRestores(now = new Date()) {
    const today = localDateKey(now);
    const data = await readData();
    let changed = false;
    for (const coach of data.coaches) {
        if (!coach.scheduledRestoreDate || coach.scheduledRestoreDate > today) {
            continue;
        }
        restoreSavedAvailability(coach, slot => isSlotExpiredToday(slot, now), template => buildDatedSlot(template, now));
        coach.scheduledRestoreDate = undefined;
        changed = true;
    }
    if (changed) {
        await writeData(data);
        console.log('Restored scheduled Monday availability.');
    }
}
/* -------------------------------------------------------
   Client Startup & Command Registration
-------------------------------------------------------- */
client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);
    // Show guilds the bot is connected to
    console.log(client.guilds.cache.map((g) => ({
        id: g.id,
        name: g.name
    })));
    // const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
    // // Support multiple env variable formats
    // const configuredGuildIds = (
    //     process.env.GUILD_IDS ??
    //     process.env.GUILD_ID ??
    //     process.env.DISCORD_GUILD_ID ??
    //     ''
    // )
    //     .split(',')
    //     .map((value) => value.trim())
    //     .filter(Boolean);
    // try {
    //     if (configuredGuildIds.length > 0) {
    //         // Register commands per guild
    //         for (const guildId of configuredGuildIds) {
    //             await rest.put(
    //                 Routes.applicationGuildCommands(
    //                     process.env.DISCORD_CLIENT_ID!,
    //                     guildId
    //                 ),
    //                 { body: commands }
    //             );
    //             console.log(`Slash commands registered for guild ${guildId}`);
    //         }
    //     } else {
    //         // Register globally
    //         await rest.put(
    //             Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!),
    //             { body: commands }
    //         );
    //         console.log('Slash commands registered globally');
    //     }
    // } catch (error) {
    //     console.error('Failed to register slash commands', error);
    // }
    // Prune expired slots immediately on startup
    await pruneExpiredSlots();
    await processScheduledMondayRestores();
    await publishSchedulerUi();
    try {
        await startActivity();
    }
    catch (err) {
        console.error('Failed to start Discord activity shell', err);
    }
    // Check both expiry and Monday restores every 5 minutes.
    setInterval(async () => {
        await pruneExpiredSlots();
        await processScheduledMondayRestores();
    }, SLOT_EXPIRY_CHECK_INTERVAL_MS);
});
/* -------------------------------------------------------
   Login
-------------------------------------------------------- */
if (process.env.SKIP_DISCORD_LOGIN === '1' || !process.env.DISCORD_TOKEN) {
    console.log('Skipping Discord login; activity preview server is running without a bot token.');
}
else {
    client.login(process.env.DISCORD_TOKEN);
}
