const state = {
  view: 'home',
  selectedCoach: null,
  selectedSlot: null,
  availabilityDraft: [],
  appointments: [],
  coaches: []
};

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
    render();
  } catch (error) {
    console.error('Failed to load coaches', error);
    state.coaches = [];
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
    `;
    if (!coach) {
      details.innerHTML = '<p>That coach is no longer available.</p>';
      return;
    }

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
      <div>
        ${coach.slots.length > 0 ? coach.slots.map((slot) => `
          <button data-action="confirm-slot" data-slot="${slot}">${slot}</button>
        `).join('') : '<p>No availability published yet.</p>'}
      </div>
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

  if (action === 'confirm-slot') {
    state.selectedSlot = button.getAttribute('data-slot');
    state.view = 'coach';
    render();

    if (!state.selectedSlot || !state.selectedCoach) {
      setStatus('No slot selected.');
      return;
    }

    const result = await sendActivityAction({
      action: 'book-slot',
      coachId: state.selectedCoach,
      playerId: 'activity-user',
      playerUsername: 'Activity User',
      slot: state.selectedSlot
    });

    const message = result.ok ? `Booking created for ${state.selectedSlot}.` : result.message || 'Booking failed.';
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

function init() {
  document.addEventListener('click', onClick, true);
  void Promise.all([loadCoaches(), loadAppointments()]);
}

window.addEventListener('DOMContentLoaded', init);
