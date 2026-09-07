/** Vue stays static; complex SDK properties are set before connecting the element, including CSRF. */
export function vueEmbedFiles(): Record<string, string> {
  return {
    'src/components/NoodleAssistant.vue': `<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { NoodleAssistantElement } from '@noodleseed/assistant';
import { assistantSessionFetch } from '../lib/noodle-assistant-transport';

const props = defineProps<{ principalKey: string; csrfToken: string }>();
const host = ref<HTMLDivElement>();
let element: NoodleAssistantElement | undefined;
let disposed = false;

onMounted(async () => {
  await import('@noodleseed/assistant');
  if (disposed || !host.value) return;
  element = document.createElement('noodle-assistant') as NoodleAssistantElement;
  element.fetch = assistantSessionFetch(window.location.origin, () => props.csrfToken);
  element.sessionEndpoint = '/api/assistant/session';
  element.setAttribute('theme', 'auto');
  host.value.append(element);
});
// This key clears browser state, never grants authority. Django re-verifies the actual session.
watch(() => props.principalKey, () => element?.resetSession());
onBeforeUnmount(() => { disposed = true; element?.remove(); element = undefined; });
</script>

<template><div ref="host" /></template>
`,
    'src/lib/noodle-assistant-transport.ts': `/** Preserve Django CSRF without forwarding the token to Noodle or another origin. */
export function assistantSessionFetch(
  origin: string,
  csrfToken: () => string,
  transport: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(input, origin), init);
    const url = new URL(request.url);
    if (url.origin === origin && url.pathname === '/api/assistant/session' && request.method === 'POST') {
      const token = csrfToken();
      if (!token) return Promise.reject(new Error('Application CSRF token is unavailable'));
      request.headers.set('X-CSRFToken', token);
    } else {
      request.headers.delete('X-CSRFToken');
    }
    return transport(request);
  };
}
`,
    'test/noodle-assistant-transport.test.ts': `import { describe, expect, it, vi } from 'vitest';
import { assistantSessionFetch } from '../src/lib/noodle-assistant-transport';

describe('Django session CSRF transport', () => {
  it('adds the current X-CSRFToken only to the same-origin session POST', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    let token = 'synthetic-csrf-one';
    const request = assistantSessionFetch('https://app.example', () => token, transport);
    await request('/api/assistant/session', { method: 'POST', body: '{}' });
    expect((transport.mock.calls[0]?.[0] as Request).headers.get('X-CSRFToken')).toBe(token);
    token = 'synthetic-csrf-two';
    await request('/api/assistant/session', { method: 'POST', body: '{}' });
    expect((transport.mock.calls[1]?.[0] as Request).headers.get('X-CSRFToken')).toBe(token);
    await request('https://cloud.example/v1/assistant/turns', { method: 'POST', headers: { 'X-CSRFToken': token } });
    expect((transport.mock.calls[2]?.[0] as Request).headers.has('X-CSRFToken')).toBe(false);
  });
  it('fails closed before network activity without an application CSRF token', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(assistantSessionFetch('https://app.example', () => '', transport)(
      '/api/assistant/session', { method: 'POST', body: '{}' },
    )).rejects.toThrow('CSRF token');
    expect(transport).not.toHaveBeenCalled();
  });
});
`,
  };
}
