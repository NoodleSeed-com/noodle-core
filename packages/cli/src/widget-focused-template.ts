/** Focused production starter for `noodle init --template widget`. */
export const widgetFocusedHelpers = `import type { ServerDefinition } from '@noodleseed/one';
import { generateHelpers } from '@noodleseed/one/react';

export { Action, ActionBar, AsyncBoundary, Feedback, Field, Flow, Frame, Region, Select } from '@noodleseed/one/react';
export const { useCallTool, useLayout, useToolInfo, useViewState, useWidgetReady } = generateHelpers<ServerDefinition>();
`;

export const widgetFocusedView = `import '@noodleseed/one/react/styles.css';
import { useRef, useState } from 'react';
import {
  Action,
  ActionBar,
  AsyncBoundary,
  Feedback,
  Field,
  Flow,
  Frame,
  Region,
  Select,
  useCallTool,
  useLayout,
  useToolInfo,
  useViewState,
  useWidgetReady,
} from '../helpers.js';

type Preferences = { readonly channel: 'email' | 'sms'; readonly summary: string; readonly demo: true };

function isPreferences(value: unknown): value is Preferences {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<Preferences>;
  return (
    (candidate.channel === 'email' || candidate.channel === 'sms') &&
    typeof candidate.summary === 'string' &&
    candidate.summary.trim().length > 0 && candidate.demo === true
  );
}

function preferenceStatus(status: 'loading' | 'error', message: string) {
  return (
    <Frame displayMode="auto" title="Notification preferences">
      <Feedback status={status}>{message}</Feedback>
    </Frame>
  );
}

export default function PreferencesCard() {
  const ready = useWidgetReady();
  const layout = useLayout();
  const toolInfo = useToolInfo('show_preferences');
  const isPending = !ready || Object.keys(toolInfo).length === 0;
  const shown = isPreferences(toolInfo.structuredContent)
    ? toolInfo.structuredContent
    : undefined;
  const save = useCallTool('save_preferences');
  const [channel, setChannel] = useViewState('channel', shown?.channel ?? 'email');
  const [saved, setSaved] = useState<Preferences>();
  const [issue, setIssue] = useState<string>();
  const inFlight = useRef(false);

  async function previewPreference() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setSaved(undefined);
    setIssue(undefined);
    try {
      const result = await save.callTool({ channel });
      if (result.isError || !isPreferences(result.structuredContent) || result.structuredContent.channel !== channel) {
        throw new Error('Unverified preview');
      }
      setSaved(result.structuredContent);
    } catch {
      setIssue('Could not verify the preview. Inspect the local result before retrying.');
    } finally { inFlight.current = false; }
  }

  if (isPending) return preferenceStatus('loading', 'Loading preferences…');
  if (toolInfo.isError) return preferenceStatus('error', 'Could not load preferences.');
  if (!shown) return preferenceStatus('error', 'The preference result was incomplete.');

  return (
    <Frame
      className={layout.theme === 'dark' ? 'dark' : ''}
      displayMode="auto"
      title="Notification preferences"
      subtitle="Synthetic preview only. No customer preference is saved."
      data-llm={saved?.summary ?? \`Notification channel: \${channel}\`}
    >
      <Flow variant="stack" density={layout.displayMode === 'inline' ? 'compact' : 'comfortable'}>
        <AsyncBoundary
          state={save}
          loading="Previewing your preference…"
          error={() => <Flow variant="stack">
            <p>Could not preview. Inspect the local tool result before retrying.</p>
            <Action type="button" onClick={save.reset}>Try again</Action>
          </Flow>}
        >
          {issue ? <Feedback status="error">{issue}</Feedback> : null}
          {saved?.summary ? <Feedback status="partial">{saved.summary}</Feedback> : null}
          <Region title="Delivery channel" description="You can change this later.">
            <Field label="Channel" detail="Email is the safe default for this starter.">
              <Select
                value={channel}
                onChange={(event) => setChannel(event.currentTarget.value as 'email' | 'sms')}
                options={[{ value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }]}
              />
            </Field>
          </Region>
          <ActionBar>
            <Action
              type="button"
              variant="primary"
              disabled={!ready || save.isPending}
              pending={save.isPending}
              pendingLabel="Previewing…"
              onClick={previewPreference}
            >
              Preview preference
            </Action>
          </ActionBar>
        </AsyncBoundary>
      </Flow>
    </Frame>
  );
}
`;
