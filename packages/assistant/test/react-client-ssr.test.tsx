// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useNoodleAssistant } from '../src/react-client.js';

describe('useNoodleAssistant server rendering', () => {
  it('renders its initial snapshot without browser globals or a network request', () => {
    const fetchMock = vi.fn<typeof fetch>();

    function Probe() {
      const state = useNoodleAssistant({
        sessionEndpoint: '/api/assistant/session',
        principalKey: 'principal-1',
        fetch: fetchMock,
      });
      return <output data-status={state.status}>{state.messages.length}</output>;
    }

    expect(renderToString(<Probe />)).toContain('data-status="ready"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
