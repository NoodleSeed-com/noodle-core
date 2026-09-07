// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const callTool = vi.fn();
const followUp = vi.fn();
const initial = {
  value: { title: 'Team launch', audience: 'New teammates', goal: 'Complete their first project' },
  revision: 4,
  status: 'active',
};
let entry: unknown = initial;
vi.mock('../src/helpers.js', () => ({
  useToolInfo: () => ({ structuredContent: entry }),
  useCallTool: () => ({ callTool }),
  useSendFollowUpMessage: () => followUp,
}));

import DraftCard from '../src/views/draft-card.js';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  callTool.mockReset();
  followUp.mockReset();
  entry = initial;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<DraftCard />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

it('saves using the server revision and displays only the returned result', async () => {
  callTool.mockResolvedValue({ structuredContent: { ...initial, revision: 8 } });
  await act(async () => button('Save brief').click());
  expect(callTool).toHaveBeenCalledWith({ ...initial.value, expectedRevision: 4 });
  expect(host.textContent).toContain('Your brief is saved.');
  expect(button('Continue with an account').disabled).toBe(false);
});

it('shows a proposed brief without pretending it is already saved', async () => {
  entry = { value: {}, revision: 0, status: 'active', proposal: initial.value };
  await act(async () => root.render(<DraftCard />));
  expect(host.querySelector('input')?.value).toBe('Team launch');
  expect(button('Continue with an account').disabled).toBe(true);
  callTool.mockResolvedValue({ structuredContent: { ...initial, revision: 1 } });
  await act(async () => button('Save brief').click());
  expect(callTool).toHaveBeenCalledWith({ ...initial.value, expectedRevision: 0 });
});

it('does not invent a save when confirmation is pending or the response is missing', async () => {
  callTool.mockResolvedValue({});
  await act(async () => button('Save brief').click());
  expect(host.textContent).not.toContain('Your brief is saved.');
  expect(host.textContent).toContain('No save was confirmed.');
});

it('retains edits on a stale write and requires a reload before another save', async () => {
  callTool.mockResolvedValue({ isError: true });
  await act(async () => button('Save brief').click());
  expect(host.querySelector('input')?.value).toBe('Team launch');
  expect(button('Save brief').disabled).toBe(true);
  expect(host.textContent).toContain('Reload saved');
  callTool.mockResolvedValue({ structuredContent: { ...initial, revision: 7 } });
  await act(async () => button('Reload saved').click());
  await act(async () => button('Save brief').click());
  expect(callTool).toHaveBeenLastCalledWith({ ...initial.value, expectedRevision: 7 });
});

it('keeps continuing separate from saving and makes no project-creation claim', async () => {
  await act(async () => button('Continue with an account').click());
  expect(callTool).not.toHaveBeenCalled();
  expect(followUp).toHaveBeenCalledWith({
    prompt: 'I would like to continue with my saved brief in an account.',
  });
  expect(host.textContent).not.toContain('Project created');
});
