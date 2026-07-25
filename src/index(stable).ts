import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageComponentInteraction
} from 'discord.js';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { removeBookedSlot } from './schedulerLogic.js';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

interface CoachProfile {
  id: string;
  userId: string;
  username: string;
  avatarUrl?: string;
  bio: string;
  specialties: string[];
  slots: string[];
  savedAvailability: string[];
  visibility: 'server' | 'all';
  guildId?: string;
  createdAt: string;
}

interface SchedulerData {
  coaches: CoachProfile[];
}

interface PendingRequest {
  coachId: string;
  coachUsername: string;
  requesterId: string;
  requesterUsername: string;
  requesterChannelId?: string;
  requestChannelId?: string;
  guildId?: string;
  requestInteraction?: MessageComponentInteraction;
  slot: string;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ]
});
const dataFile = path.join(process.cwd(), 'data', 'scheduler-data.json');
const pendingRequests = new Map<string, PendingRequest>();
const fallbackChannelName = process.env.FALLBACK_CHANNEL_NAME ?? 'schedule-requests';
const availabilityDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const availabilityTimes = ['1am', '2am', '3am', '4am', '5am', '6am', '7am', '8am', '9am', '10am', '11am', '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm', '11pm', '12am'];
const pendingAvailability = new Map<string, { userId: string; bio: string; specialties: string[]; visibility: 'server' | 'all'; guildId?: string }>();

const availabilityByDay = new Map<string, Record<string, string[]>>();
const availabilityDayQueue = new Map<string, string[]>();
const availabilityCurrentDay = new Map<string, string>();

const pendingBookings = new Map();

// Fix: automatic same-day slot expiry. Slots are recurring weekly entries
// with no actual date attached ("Friday 10pm"), so there's no way to tell
// "this Friday" from "next Friday." The only thing we can safely expire is
// a slot whose day matches *today's* weekday and whose time has already
// passed today — other days are left alone since they're always upcoming.
//
// Note: this compares against the server process's local time. If the bot
// runs in a different timezone than your coaches expect, times will be off
// by that offset — worth pinning the server/container to the right TZ.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SLOT_EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function parseSlotTime(time: string): { hour: number; minute: number } | null {
  const match = time.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);

  if (!match) {
    return null;
  }

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];

  if (hour === 12) {
    hour = 0;
  }
  if (meridiem === 'pm') {
    hour += 12;
  }

  return { hour, minute };
}

function isSlotExpiredToday(slot: string, now: Date = new Date()): boolean {
  const [day, ...timeParts] = slot.split(' ');
  const time = timeParts.join(' ');
  const parsedTime = parseSlotTime(time);

  // Can't parse the time portion — don't filter it out, better to show a
  // slot than to silently hide one due to an unexpected format.
  if (!parsedTime) {
    return false;
  }

  const todayName = WEEKDAY_NAMES[now.getDay()];
  if (day !== todayName) {
    return false;
  }

  const slotMinutes = parsedTime.hour * 60 + parsedTime.minute;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return slotMinutes <= nowMinutes;
}

function getActiveSlots(coach: CoachProfile): string[] {
  return coach.slots.filter((slot) => !isSlotExpiredToday(slot));
}

// Physically removes expired slots from storage. Run on startup and on a
// recurring interval so scheduler-data.json doesn't accumulate stale
// entries — display-time filtering (getActiveSlots) already hides them
// immediately, this just keeps the file itself clean.
async function pruneExpiredSlots(): Promise<void> {
  try {
    const data = await readData();
    let changed = false;

    for (const coach of data.coaches) {
      const activeSlots = getActiveSlots(coach);
      if (activeSlots.length !== coach.slots.length) {
        coach.slots = activeSlots;
        changed = true;
      }
    }

    if (changed) {
      await writeData(data);
      console.log('Pruned expired slots from scheduler data.');
    }
  } catch (error) {
    console.error('Failed to prune expired slots', error);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('coach-register')
    .setDescription('Register yourself as a coach with available time slots')
    .addStringOption((option) => option.setName('bio').setDescription('Short intro about your coaching style').setRequired(true))
    .addStringOption((option) => option.setName('specialties').setDescription('Comma-separated specialties').setRequired(false))
    .addStringOption((option) => option
      .setName('visibility')
      .setDescription('Show your coaching profile on this server only or on all servers that use the scheduler')
      .setRequired(true)
      .addChoices(
        { name: 'This server only', value: 'server' },
        { name: 'All servers', value: 'all' }
      ))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('coach-list')
    .setDescription('List available coaches and their open slots')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('coach-remove')
    .setDescription('Remove your coach profile')
    .toJSON()
];

async function readData(): Promise<SchedulerData> {
  try {
    const contents = await readFile(dataFile, 'utf8');
    return JSON.parse(contents) as SchedulerData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const initialData: SchedulerData = { coaches: [] };
      await writeData(initialData);
      return initialData;
    }

    throw error;
  }
}

let writeQueue: Promise<void> = Promise.resolve();

async function writeData(data: SchedulerData): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await mkdir(path.dirname(dataFile), { recursive: true });
    const tmpFile = `${dataFile}.tmp`;
    await writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmpFile, dataFile);
  });
  return writeQueue;
}

function sanitizeSlots(raw: string): string[] {
  return raw.split(',').map((slot) => slot.trim()).filter(Boolean);
}

function buildCoachEmbed(coach: CoachProfile): EmbedBuilder {
  const activeSlots = getActiveSlots(coach);
  const embed = new EmbedBuilder()
    .setTitle(coach.username)
    .setDescription(coach.bio || 'No bio provided yet.')
    .addFields(
      { name: 'Specialties', value: coach.specialties.join(', ') || 'Not listed', inline: false },
      { name: 'Open Slots', value: activeSlots.join('\n') || 'No slots available', inline: false },
      { name: 'Visibility', value: coach.visibility === 'all' ? 'All servers' : 'This server only', inline: false }
    )
    .setColor(0x5865f2);

  if (coach.avatarUrl) {
    embed.setThumbnail(coach.avatarUrl);
  }

  return embed;
}

function buildSlotSelectMenu(coach: CoachProfile): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const activeSlots = getActiveSlots(coach);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>();
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`request-slot:${coach.id}`)
    .setPlaceholder(activeSlots.length === 0 ? 'No slots available' : 'Select a time slot')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(activeSlots.length === 0)
    .addOptions(
      activeSlots.length > 0
        ? activeSlots.slice(0, 25).map((slot) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(slot)
              .setValue(slot)
          )
        : [new StringSelectMenuOptionBuilder().setLabel('No slots available').setValue('none')]
    );

  row.addComponents(menu);
  return [row];
}

function buildDaySelectionMenu(): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const row = new ActionRowBuilder<StringSelectMenuBuilder>();
  const menu = new StringSelectMenuBuilder()
    .setCustomId('availability-day')
    .setPlaceholder('Select days')
    .setMinValues(1)
    .setMaxValues(availabilityDays.length)
    .addOptions(
      ...availabilityDays.map((day) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(day)
          .setValue(day)
      )
    );

  row.addComponents(menu);
  return [row];
}

function buildTimeSelectionMenu(day: string): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const row = new ActionRowBuilder<StringSelectMenuBuilder>();
  const menu = new StringSelectMenuBuilder()
    .setCustomId('availability-time')
    .setPlaceholder(`Select times for ${day}`)
    .setMinValues(1)
    .setMaxValues(availabilityTimes.length)
    .addOptions(
      ...availabilityTimes.map((time) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(time)
          .setValue(time)
      )
    );

  row.addComponents(menu);
  return [row];
}

function buildAvailabilityCompleteButtons(): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('availability-finish')
      .setLabel('Finish')
      .setStyle(ButtonStyle.Success)
  );

  return [row];
}

async function replyWithCoachCard(interaction: ChatInputCommandInteraction | MessageComponentInteraction, coach: CoachProfile): Promise<void> {
  const embed = buildCoachEmbed(coach);
  const components = buildSlotSelectMenu(coach);
  await interaction.reply({ embeds: [embed], components, ephemeral: true });
}

async function replyWithCoachList(interaction: ChatInputCommandInteraction | MessageComponentInteraction, coaches: CoachProfile[]): Promise<void> {
  if (coaches.length === 0) {
    await interaction.reply({ content: 'No coaches are available in this server yet.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  for (const coach of coaches) {
    const embed = buildCoachEmbed(coach);
    const components = buildSlotSelectMenu(coach);
    await interaction.followUp({ embeds: [embed], components, ephemeral: true });
  }
}

function isCoachVisible(coach: CoachProfile, guildId?: string | null): boolean {
  return coach.visibility === 'all' || (Boolean(guildId) && coach.guildId === guildId);
}

function buildRequestResponseButtons(requestId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`request-action:accept:${requestId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`request-action:reject:${requestId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
  );

  return [row];
}
function buildRestoreAvailabilityButtons(): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('restore-availability')
      .setLabel('Restore Previous Availability')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId('edit-availability')
      .setLabel('Edit Availability')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row];
}

async function sendDmToUser(userId: string, guildId: string | undefined, payload: any) {
  const user = await client.users.fetch(userId);
  const dm = await user.createDM();
  await dm.send(payload);
}

async function notifyCoachOfRequest(coach: CoachProfile, requesterUsername: string, slot: string, requestId: string, fallbackChannelId?: string, guildId?: string): Promise<void> {
  const description = `${requesterUsername} requested a coaching session with you for ${slot}.`;

  try {
    await sendDmToUser(coach.userId, guildId, {
      embeds: [
        new EmbedBuilder()
          .setTitle('New coaching session request')
          .setDescription(description)
          .setColor(0x5865f2)
      ],
      components: buildRequestResponseButtons(requestId)
    });
    return;
  } catch (error) {
    console.error(`Failed to DM coach ${coach.userId}`, error);
  }

  if (!guildId) {
    return;
  }

  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const fallbackChannel = channels.find((channel) => channel?.isTextBased() && channel.name === fallbackChannelName);

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
        components: buildRequestResponseButtons(requestId)
      });
    }
  } catch (fallbackError) {
    console.error(`Failed to fallback notify coach ${coach.userId} in ${fallbackChannelName}`, fallbackError);
  }
}

async function notifyRequesterOfDecision(requesterId: string, coachUsername: string, slot: string, accepted: boolean, reason?: string, requestInteraction?: MessageComponentInteraction, guildId?: string): Promise<void> {
  const description = accepted
    ? `${coachUsername} accepted your coaching request for ${slot}.`
    : `${coachUsername} rejected your coaching request for ${slot}.${reason ? ` Reason: ${reason}` : ''}`;

  try {
    await sendDmToUser(requesterId, guildId, {
      embeds: [
        new EmbedBuilder()
          .setTitle(accepted ? 'Coaching request accepted' : 'Coaching request rejected')
          .setDescription(description)
          .setColor(accepted ? 0x57f287 : 0xed4245)
      ]
    });
    return;
  } catch (error) {
    console.error(`Failed to DM requester ${requesterId}. Falling back to an ephemeral reply.`, error);
  }

  if (!requestInteraction) {
    return;
  }

  try {
    const payload = {
      embeds: [
        new EmbedBuilder()
          .setTitle(accepted ? 'Coaching request accepted' : 'Coaching request rejected')
          .setDescription(description)
          .setColor(accepted ? 0x57f287 : 0xed4245)
      ],
      ephemeral: true
    };

    if (requestInteraction.replied || requestInteraction.deferred) {
      await requestInteraction.followUp(payload);
    } else {
      await requestInteraction.reply(payload);
    }
  } catch (fallbackError) {
    console.error(`Failed to fallback notify requester ${requesterId} via interaction reply`, fallbackError);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(
    client.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name
    }))
  );

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
  const configuredGuildIds = (process.env.GUILD_IDS ?? process.env.GUILD_ID ?? process.env.DISCORD_GUILD_ID ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    if (configuredGuildIds.length > 0) {
      for (const guildId of configuredGuildIds) {
        await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID!, guildId), { body: commands as never });
        console.log(`Slash commands registered for guild ${guildId}`);
      }
    } else {
      await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), { body: commands as never });
      console.log('Slash commands registered globally');
    }
  } catch (error) {
    console.error('Failed to register slash commands', error);
  }

  // Fix: prune expired slots once at startup, then on a recurring interval.
  await pruneExpiredSlots();
  setInterval(pruneExpiredSlots, SLOT_EXPIRY_CHECK_INTERVAL_MS);
});

async function safeErrorReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const payload = { content, ephemeral: true };
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (replyError) {
    console.error('Failed to send error reply to user', replyError);
  }
}

client.on('interactionCreate', async (interaction: Interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    try {
      if (commandName === 'coach-register') {
        const bio = interaction.options.getString('bio', true);
        const specialtiesRaw = interaction.options.getString('specialties') ?? '';
        const visibility = interaction.options.getString('visibility', true) as 'server' | 'all';
        const guildId = interaction.guildId ?? undefined;

        pendingAvailability.set(interaction.user.id, {
          userId: interaction.user.id,
          bio,
          specialties: specialtiesRaw.split(',').map((item) => item.trim()).filter(Boolean),
          visibility,
          guildId
        });

        availabilityByDay.set(interaction.user.id, {});
        availabilityDayQueue.delete(interaction.user.id);
        availabilityCurrentDay.delete(interaction.user.id);

        await interaction.reply({
          content: 'Choose the days you are available.',
          components: buildDaySelectionMenu(),
          ephemeral: true
        });
        return;
      }

      if (commandName === 'coach-list') {
        const data = await readData();
        const visibleCoaches = data.coaches.filter((coach) => isCoachVisible(coach, interaction.guildId));

        if (visibleCoaches.length === 0) {
          await interaction.reply({
            content: 'No coaches are available in this server yet.',
            ephemeral: true
          });

          return;
        }

        await replyWithCoachList(interaction, visibleCoaches);
        return;
      }

      if (commandName === 'coach-remove') {
        const guildId = interaction.guildId ?? undefined;
        const data = await readData();
        const before = data.coaches.length;

        data.coaches = data.coaches.filter((coach) => {
          if (coach.userId !== interaction.user.id) {
            return true; // not this user — always keep
          }
          const belongsToThisContext = coach.guildId === guildId || coach.visibility === 'all';
          return !belongsToThisContext; // drop it only if it's the profile for *this* server
        });

        if (data.coaches.length === before) {
          await interaction.reply('You do not currently have a coach profile in this server.');
          return;
        }

        await writeData(data);
        await interaction.reply('Removed your coach profile for this server.');
        return;
      }

      await interaction.reply('Unknown command.');
    } catch (error) {
      console.error(error);
      await safeErrorReply(interaction, 'Something went wrong while processing that command.');
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'availability-day') {
      const pending = pendingAvailability.get(interaction.user.id);

      if (!pending) {
        await interaction.reply({ content: 'Your availability setup has expired. Please run /coach-register again.', ephemeral: true });
        return;
      }

      const days = [...interaction.values];
      const firstDay = days.shift();

      if (!firstDay) {
        await interaction.reply({ content: 'Please select at least one day.', ephemeral: true });
        return;
      }

      availabilityByDay.set(interaction.user.id, {});
      availabilityDayQueue.set(interaction.user.id, days);
      availabilityCurrentDay.set(interaction.user.id, firstDay);

      await interaction.reply({
        content: `Select the times you're available on **${firstDay}**.`,
        components: buildTimeSelectionMenu(firstDay),
        ephemeral: true
      });
      return;
    }

    if (interaction.customId === 'availability-time') {
      const pending = pendingAvailability.get(interaction.user.id);
      const currentDay = availabilityCurrentDay.get(interaction.user.id);

      if (!pending || !currentDay) {
        await interaction.reply({ content: 'Your availability setup has expired. Please run /coach-register again.', ephemeral: true });
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

    if (interaction.customId.startsWith('request-slot:')) {
      const [, coachId] = interaction.customId.split(':');
      const slot = interaction.values[0];

      if (slot === 'none') {
        await interaction.reply({ content: 'That coach has no open slots right now.', ephemeral: true });
        return;
      }

      const data = await readData();
      const coach = data.coaches.find((entry) => entry.id === coachId);

      if (!coach) {
        await interaction.reply({ content: 'That coach profile is no longer available.', ephemeral: true });
        return;
      }

      // Fix: check against active (non-expired) slots, in case the slot
      // expired in the moment between the menu being shown and clicked.
      if (!getActiveSlots(coach).includes(slot)) {
        await interaction.reply({ content: 'That slot is no longer available. Please try again.', ephemeral: true });
        return;
      }

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingRequests.set(requestId, {
        coachId: coach.id,
        coachUsername: coach.username,
        requesterId: interaction.user.id,
        requesterUsername: interaction.user.username,
        requesterChannelId: interaction.channelId ?? undefined,
        requestChannelId: interaction.channelId ?? undefined,
        guildId: interaction.guildId ?? undefined,
        requestInteraction: interaction,
        slot
      });

      await notifyCoachOfRequest(coach, interaction.user.username, slot, requestId, interaction.channelId ?? undefined, interaction.guildId ?? undefined);

      await interaction.reply({
        content: `You requested a coaching session with ${coach.username} for ${slot}. They have been notified to confirm the booking.`,
        ephemeral: true
      });
      return;
    }
  }

  if (interaction.isButton()) {
    const [type] = interaction.customId.split(':');

    if (type === 'availability-finish') {
      const pending = pendingAvailability.get(interaction.user.id);
      const dayTimes = availabilityByDay.get(interaction.user.id);

      if (!pending || !dayTimes) {
        await interaction.reply({ content: 'Your availability setup has expired. Please run /coach-register again.', ephemeral: true });
        return;
      }

      const normalizedSlots = Object.entries(dayTimes).flatMap(([day, times]) =>
        times.map((time) => `${day} ${time}`)
      );

      const data = await readData();
      const existing = data.coaches.find((coach) => coach.userId === interaction.user.id && (coach.guildId === pending.guildId || coach.visibility === 'all'));

      if (existing) {
        existing.bio = pending.bio;
        existing.specialties = pending.specialties;
        existing.slots = normalizedSlots;
        existing.savedAvailability = [...normalizedSlots];
        existing.username = interaction.user.username;
        existing.avatarUrl = interaction.user.displayAvatarURL({ extension: 'png' });
        existing.visibility = pending.visibility;
        existing.guildId = pending.guildId;
        await writeData(data);
        await interaction.reply({ content: `Updated your coach profile. You now have ${normalizedSlots.length} slot(s) available.`, ephemeral: true });
      } else {
        const profile: CoachProfile = {
          id: `${Date.now()}`,
          userId: interaction.user.id,
          username: interaction.user.username,
          avatarUrl: interaction.user.displayAvatarURL({ extension: 'png' }),
          bio: pending.bio,
          specialties: pending.specialties,
          slots: normalizedSlots,
          savedAvailability: [...normalizedSlots],
          visibility: pending.visibility,
          guildId: pending.guildId,
          createdAt: new Date().toISOString()
        };

        data.coaches.push(profile);
        await writeData(data);
        await interaction.reply({ content: `Registered ${interaction.user.username} as a coach.`, ephemeral: true });
      }

      pendingAvailability.delete(interaction.user.id);
      availabilityByDay.delete(interaction.user.id);
      availabilityDayQueue.delete(interaction.user.id);
      availabilityCurrentDay.delete(interaction.user.id);
      return;
    }

    if (type === 'request-action') {
      const [, action, requestId] = interaction.customId.split(':');
      const pendingRequest = pendingRequests.get(requestId);

      if (!pendingRequest) {
        await interaction.reply({ content: 'That request is no longer available.', ephemeral: true });
        return;
      }

      if (action === 'accept') {
        const data = await readData();
        const removed = removeBookedSlot(data, pendingRequest.coachId, pendingRequest.slot);

        if (removed) {
          await writeData(data);
        }

        pendingRequests.delete(requestId);
        await notifyRequesterOfDecision(pendingRequest.requesterId, pendingRequest.coachUsername, pendingRequest.slot, true, undefined, pendingRequest.requestInteraction, pendingRequest.guildId);
        await interaction.reply({ content: `You accepted ${pendingRequest.requesterUsername}'s request for ${pendingRequest.slot}.`, ephemeral: true });
        return;
      }

      if (action === 'reject') {
        const modal = new ModalBuilder()
          .setCustomId(`reject-reason:${requestId}`)
          .setTitle('Reason for rejection');

        const reasonInput = new TextInputBuilder()
          .setCustomId('rejectionReason')
          .setLabel('Optional reason')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
        await interaction.showModal(modal);
      }
    }
  }

  if (interaction.isModalSubmit()) {
    const [type, requestId] = interaction.customId.split(':');

    if (type !== 'reject-reason') {
      return;
    }

    const pendingRequest = pendingRequests.get(requestId);

    if (!pendingRequest) {
      await interaction.reply({ content: 'That request is no longer available.', ephemeral: true });
      return;
    }

    const reason = interaction.fields.getTextInputValue('rejectionReason').trim();
    pendingRequests.delete(requestId);
    await notifyRequesterOfDecision(pendingRequest.requesterId, pendingRequest.coachUsername, pendingRequest.slot, false, reason || undefined, pendingRequest.requestInteraction, pendingRequest.guildId);
    await interaction.reply({ content: 'You rejected the request and the requester has been notified.', ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);