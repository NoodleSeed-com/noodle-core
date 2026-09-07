import '/sdk/index.js';

const config = await fetch('/demo-config').then((response) => response.json());
const mount = document.querySelector('#assistant');
const status = document.querySelector('#status');
if (config.authenticated && !config.signedIn) {
  document.querySelector('#demo-login').hidden = false;
  status.textContent =
    'Your draft is ready to come with you. This next step simulates the product’s signup.';
} else {
  const assistant = document.createElement('noodle-assistant');
  assistant.setAttribute('theme', 'light');
  if (config.authenticated) {
    assistant.setAttribute('session-endpoint', '/assistant-session');
    status.textContent =
      'You are using a synthetic demo account. Open the chat to continue with your saved brief.';
  } else {
    assistant.setAttribute('embed-id', config.embedId);
    assistant.setAttribute('service-url', config.serviceUrl);
    status.textContent =
      'Start without an account. Open the chat and describe what you want to achieve.';
  }
  mount.append(assistant);
}

document.addEventListener('assistant-sign-in-requested', async (event) => {
  status.textContent = 'Preparing your account handoff…';
  try {
    const response = await fetch('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signInTicket: event.detail.signInTicket }),
    });
    const result = await response.json();
    if (!response.ok) {
      status.textContent = result.error ?? 'Handoff not started';
      return;
    }
    window.location.assign(result.destination);
  } catch {
    status.textContent =
      'The handoff did not start. Your brief has not been moved. Please try again.';
  }
});
