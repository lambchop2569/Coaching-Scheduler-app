const state = {
  view: 'home',
  selectedCoach: null,
  selectedSlot: null,
  playerId: null,
  playerUsername: '',
  discordIdentityError: null,
  loadingDiscordIdentity: true,
  availabilityDraft: [],
  appointments: [],
  coaches: [],
  loadingCoaches: true
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPlayerNameField() {
  const playerNameField = document.getElementById('playerNameField');
  if (!playerNameField) return;

  if (state.loadingDiscordIdentity) {
    playerNameField.innerHTML = '<p>Loading Discord identity…</p>';
    return;
  }

  if (state.playerId !== 'activity-user') {
    playerNameField.innerHTML = `
      <label>Your Discord username</label>
      <div class="readonly">${escapeHtml(state.playerUsername)}</div>
      <p class="hint">This username is sent to the coach in the DM.</p>
    `;
    return;
  }

  playerNameField.innerHTML = `
    <label for="playerName">Your name</label>
    <input id="playerName" type="text" value="${escapeHtml(state.playerUsername)}" placeholder="Enter your name" />
    <p class="hint">This name is shown to the coach in the DM.</p>
    ${state.discordIdentityError ? `<p class="error">${escapeHtml(state.discordIdentityError)}</p>` : ''}
  `;
}

function onInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === 'playerName') {
    state.playerUsername = target.value;
  }
}

async function loadCoaches() {
  try {
    const response = await fetch('/api/coaches');
    if (!response.ok) throw new Error(`failed: ${response.status}`);
    const payload = await response.json();
    state.coaches = (payload.coaches || []).map((coach) => ({
      id: coach.id,
      name: coach.username,
      bio: coach.bio || 'No bio provided yet.',
      specialties: coach.specialties || [],
      slots: coach.slots || [],
      avatarUrl: coach.avatarUrl || null,
      timezone: coach.timezone || null,
      visibility: coach.visibility || 'all'
    }));
    state.loadingCoaches = false;
    render();
  } catch (error) {
    console.error('Failed to load coaches', error);
    state.coaches = [];
    state.loadingCoaches = false;
    render();
  }
}

async function loadAppointments() {
  try {
    const response = await fetch('/api/appointments');
    if (!response.ok) throw new Error(`failed: ${response.status}`);
    const payload = await response.json();
    state.appointments = (payload.appointments || []).map((appointment) => ({
      id: appointment.id,
      label: `${appointment.coachUsername || 'Coach'} • ${appointment.slot}`,
      slot: appointment.slot,
      coachUsername: appointment.coachUsername || 'Coach',
      playerUsername: appointment.playerUsername || 'Player'
    }));
    render();
  } catch (error) {
    console.error('Failed to load appointments', error);
    state.appointments = [];
    render();
  }
}

function render() {
  const actions = document.getElementById('actions');
  const details = document.getElementById('details');
  const description = document.getElementById('description');
  renderPlayerNameField();

  if (state.view === 'home') {
    description.textContent = 'Pick an action to get started.';
    actions.innerHTML = `
      <button data-action="browse">Browse coaches</button>
      <button data-action="availability">Set availability</button>
      <button data-action="cancel">Cancel appointment</button>
    `;
    details.innerHTML = '<p>Use the buttons above to explore the scheduler experience.</p>';
    return;
  }

  if (state.view === 'browse') {
    description.textContent = 'Select a coach to view their availability.';
    actions.innerHTML = '<button class="secondary" data-action="home">Back</button>';

    if (state.loadingCoaches) {
      details.innerHTML = '<p>Loading available coaches…</p>';
      return;
    }

    details.innerHTML = state.coaches.length > 0 ? state.coaches.map((coach) => `
      <div class="coach-item">
        <div class="coach-summary">
          ${coach.avatarUrl ? `<img class="avatar" src="${coach.avatarUrl}" alt="${coach.name}" />` : `<div class="avatar placeholder">${coach.name.charAt(0).toUpperCase()}</div>`}
          <div>
            <strong>${coach.name}</strong><br />
            <small>${coach.specialties.length > 0 ? coach.specialties.join(', ') : 'No specialties listed'}</small>
          </div>
        </div>
        <button data-action="coach" data-id="${coach.id}">View</button>
      </div>
    `).join('') : '<p>No coaches are available yet.</p>';
    return;
  }

  if (state.view === 'coach') {
    const coach = state.coaches.find((entry) => entry.id === state.selectedCoach);
    description.textContent = coach ? `Viewing ${coach.name}.` : 'Coach not found.';
    actions.innerHTML = `
      <button class="secondary" data-action="browse">Back</button>
      <button data-action="home">Main menu</button>
      ${state.selectedSlot ? `<button class="secondary" data-action="cancel-selection">Cancel selection</button><button class="success confirm-action" data-action="confirm-booking">Confirm ${state.selectedSlot}</button>` : ''}
    `;
    if (!coach) {
      details.innerHTML = '<p>That coach is no longer available.</p>';
      return;
    }

    const weekdayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const slotsByDay = weekdayOrder.reduce((acc, day) => {
      acc[day] = [];
      return acc;
    }, {});

    coach.slots.forEach((slot) => {
      const day = slot.split(' ')[0];
      if (weekdayOrder.includes(day)) {
        slotsByDay[day].push(slot);
      }
    });

    const slotButton = (slot) => {
      const time = slot.includes(' at ') ? slot.split(' at ').pop() : slot;
      const selectedClass = state.selectedSlot === slot ? 'selected-slot' : '';
      return `<button class="${selectedClass}" data-action="select-slot" data-slot="${slot}">${time}</button>`;
    };

    details.innerHTML = `
      <div class="coach-summary">
        ${coach.avatarUrl ? `<img class="avatar large" src="${coach.avatarUrl}" alt="${coach.name}" />` : `<div class="avatar placeholder large">${coach.name.charAt(0).toUpperCase()}</div>`}
        <div>
          <h3>${coach.name}</h3>
          <p>${coach.bio}</p>
        </div>
      </div>
      <p><strong>Specialties:</strong> ${coach.specialties.length > 0 ? coach.specialties.join(', ') : 'Not listed'}</p>
      <p><strong>Timezone:</strong> ${coach.timezone || 'Not set'}</p>
      ${coach.slots.length > 0 ? `
      <div class="weekday-grid">
        ${weekdayOrder.map((day) => `
          <div class="weekday-column">
            <h4>${day}</h4>
            ${slotsByDay[day].length > 0 ? slotsByDay[day].map((slot) => slotButton(slot)).join('') : '<div class="no-slots">No slots</div>'}
          </div>
        `).join('')}
      </div>
      ` : '<p>No availability published yet.</p>'}
      ${state.selectedSlot ? `<p>Selected slot: <strong>${state.selectedSlot}</strong></p>` : ''}
    `;
    return;
  }

  if (state.view === 'availability') {
    description.textContent = 'Choose the availability you want to publish.';
    actions.innerHTML = `
      <button class="secondary" data-action="home">Back</button>
      <button class="success" data-action="save-availability">Save draft</button>
    `;
    details.innerHTML = `
      <div>
        <button data-action="add-slot" data-slot="Monday 6pm">Monday 6pm</button>
        <button data-action="add-slot" data-slot="Wednesday 8pm">Wednesday 8pm</button>
        <button data-action="add-slot" data-slot="Friday 5pm">Friday 5pm</button>
      </div>
      <p>Draft slots: ${state.availabilityDraft.length > 0 ? state.availabilityDraft.join(', ') : 'none yet'}</p>
    `;
    return;
  }

  if (state.view === 'cancel') {
    description.textContent = 'Choose an appointment to cancel.';
    actions.innerHTML = '<button class="secondary" data-action="home">Back</button>';
    details.innerHTML = state.appointments.length > 0 ? state.appointments.map((appointment) => `
      <div class="appointment-item">
        <span>${appointment.label} · ${appointment.playerUsername}</span>
        <button class="danger" data-action="cancel-appointment" data-id="${appointment.id}">Cancel</button>
      </div>
    `).join('') : '<p>No appointments to cancel.</p>';
  }
}

function setStatus(message) {
  const details = document.getElementById('details');
  if (!details) return;
  details.insertAdjacentHTML('beforeend', `<p>${message}</p>`);
}

async function sendActivityAction(payload) {
  try {
    const response = await fetch('/api/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`request failed: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    console.error('Activity action failed', error);
    return { ok: false, message: 'Unable to reach the scheduler backend.' };
  }
}

async function handleAction(action, button) {
  if (action === 'browse') {
    state.view = 'browse';
    render();
    return;
  }

  if (action === 'availability') {
    state.view = 'availability';
    render();
    return;
  }

  if (action === 'cancel') {
    state.view = 'cancel';
    render();
    return;
  }

  if (action === 'home') {
    state.view = 'home';
    state.selectedCoach = null;
    state.selectedSlot = null;
    render();
    return;
  }

  if (action === 'coach') {
    state.selectedCoach = button.getAttribute('data-id');
    state.view = 'coach';
    render();
    return;
  }

  if (action === 'select-slot') {
    state.selectedSlot = button.getAttribute('data-slot');
    state.view = 'coach';
    render();
    return;
  }

  if (action === 'cancel-selection') {
    state.selectedSlot = null;
    render();
    return;
  }

  if (action === 'confirm-booking') {
    if (!state.selectedSlot || !state.selectedCoach) {
      setStatus('No slot selected.');
      return;
    }

    const playerUsername = state.playerUsername.trim();
    if (!playerUsername) {
      setStatus('Please enter your name before sending the request.');
      return;
    }

    const result = await sendActivityAction({
      action: 'request-slot',
      coachId: state.selectedCoach,
      playerId: state.playerId || 'activity-user',
      playerUsername,
      slot: state.selectedSlot
    });

    const message = result.ok
      ? `Request sent for ${state.selectedSlot}. Coach will confirm or reject the booking.`
      : result.message || 'Request failed.';
    if (result.ok) {
      state.selectedSlot = null;
    }
    render();
    setStatus(message);
    return;
  }

  if (action === 'add-slot') {
    const slot = button.getAttribute('data-slot');
    if (slot && !state.availabilityDraft.includes(slot)) {
      state.availabilityDraft.push(slot);
    }
    render();
    return;
  }

  if (action === 'save-availability') {
    const summary = state.availabilityDraft.length > 0 ? state.availabilityDraft.join(', ') : 'none';
    document.getElementById('details').innerHTML = `<p>Availability saved: ${summary}</p>`;
    return;
  }

  if (action === 'cancel-appointment') {
    const id = Number(button.getAttribute('data-id'));
    const result = await sendActivityAction({
      action: 'cancel-appointment',
      appointmentId: String(id)
    });

    if (result.ok) {
      state.appointments = state.appointments.filter((entry) => entry.id !== id);
    }

    render();
    setStatus(result.ok ? 'Appointment canceled.' : result.message || 'Cancel failed.');
    return;
  }
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const button = target?.closest('button[data-action]');
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();
  handleAction(button.getAttribute('data-action'), button);

  window.parent?.postMessage({
    type: 'coach-scheduler-action',
    action: button.getAttribute('data-action'),
    slot: button.getAttribute('data-slot') || null,
    id: button.getAttribute('data-id') || null
  }, '*');
}

async function loadDiscordIdentity() {
  if (!window.DISCORD_CLIENT_ID) {
    state.loadingDiscordIdentity = false;
    render();
    return;
  }

  try {
    const sdkModule = await import('/embedded-app-sdk/index.mjs');
    const { DiscordSDK } = sdkModule;
    const sdk = new DiscordSDK(window.DISCORD_CLIENT_ID, { disableConsoleLogOverride: true });
    await sdk.ready();

    let username = undefined;
    let userId = undefined;

    try {
      const channel = await sdk.commands.getChannel({ channel_id: sdk.channelId });
      const author = channel.messages?.[0]?.author; 
      if (author) {
        username = author.global_name || author.username;
        userId = author.id;
      }
    } catch (error) {
      console.warn('getChannel identity lookup failed', error);
    }

    if (!username) {
      const response = await sdk.commands.getActivityInstanceConnectedParticipants();
      const participant = (response.participants || []).find((entry) => !entry.bot) || response.participants?.[0];
      if (participant) {
        username = participant.global_name || participant.username;
        userId = participant.id;
      }
    }

    if (username) {
      state.playerId = userId || state.playerId;
      state.playerUsername = username;
    } else {
      state.discordIdentityError = 'Unable to determine Discord username; please enter your name manually.';
    }
  } catch (error) {
    console.warn('Discord identity lookup failed', error);
    state.discordIdentityError = 'Unable to load Discord identity; please enter your name manually.';
  } finally {
    state.loadingDiscordIdentity = false;
    render();
  }
}

async function init() {
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  await Promise.all([loadCoaches(), loadAppointments(), loadDiscordIdentity()]);
}

window.addEventListener('DOMContentLoaded', init);
