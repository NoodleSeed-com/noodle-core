/** Generated source files for the developer-facing React design-system showcase. */

export const widgetShowcaseHelpers = `import type { ServerDefinition } from '@noodleseed/one';
import { generateHelpers } from '@noodleseed/one/react';

export type { CallToolState, HandoffController } from '@noodleseed/one/react';
export {
  Action,
  ActionBar,
  AppShell,
  AsyncBoundary,
  Avatar,
  AvatarGroup,
  Checkbox,
  ChoiceGroup,
  Collection,
  DataCard,
  DataList,
  EmptyState,
  ErrorState,
  ExpandButton,
  Fact,
  Feedback,
  Field,
  Flow,
  Form,
  Frame,
  FullscreenShell,
  HandoffButton,
  InlineCard,
  InlineCarousel,
  InlineList,
  Input,
  LoadingState,
  Menu,
  Overlay,
  Popover,
  QuantityStepper,
  RadioGroup,
  Region,
  SegmentedControl,
  Select,
  ShellHeader,
  ShellNav,
  Slider,
  Spinner,
  StatusBadge,
  SubmitButton,
  Switch,
  Textarea,
  Tooltip,
  View,
  ViewNav,
  ViewStack,
} from '@noodleseed/one/react';

export type AppType = ServerDefinition;

export const {
  useAppFlow,
  useCallTool,
  useHandoff,
  useLayout,
  useToolInfo,
  useViewState,
  useWidgetReady,
} = generateHelpers<AppType>();
`;

export const widgetShowcaseView = `import '@noodleseed/one/react/styles.css';
import { useState } from 'react';
import {
  AppShell,
  Frame,
  FullscreenShell,
  SegmentedControl,
  StatusBadge,
  View,
  ViewNav,
  ViewStack,
  useAppFlow,
  useLayout,
  useToolInfo,
} from '../helpers.js';
import {
  DataSection,
  FeedbackSection,
  FormsSection,
  FoundationsSection,
  LayoutSection,
  OverlaysSection,
} from './showcase-sections.js';

type GalleryView = 'foundations' | 'forms' | 'data' | 'feedback' | 'overlays' | 'layouts';
type ShellPreview = 'frame' | 'app-shell' | 'fullscreen';

const galleryViews: readonly GalleryView[] = [
  'foundations',
  'forms',
  'data',
  'feedback',
  'overlays',
  'layouts',
];

const navigation = [
  { view: 'foundations' as const, label: 'Foundations' },
  { view: 'forms' as const, label: 'Forms' },
  { view: 'data' as const, label: 'Data display' },
  { view: 'feedback' as const, label: 'Feedback' },
  { view: 'overlays' as const, label: 'Overlays' },
  { view: 'layouts' as const, label: 'Layouts' },
];

type ShowcaseInfo = {
  readonly title?: string;
  readonly version?: string;
  readonly description?: string;
};

export default function DesignSystemShowcase() {
  const layout = useLayout();
  const info = (useToolInfo('show_design_system').structuredContent ?? {}) as ShowcaseInfo;
  const flow = useAppFlow<GalleryView>({
    key: 'design_system_showcase',
    initialView: 'foundations',
    views: galleryViews,
  });
  const [shell, setShell] = useState<ShellPreview>('frame');

  const content = (
    <>
      <SegmentedControl
        aria-label="Preview shell"
        name="preview-shell"
        value={shell}
        onValueChange={(value) => setShell(value as ShellPreview)}
        options={[
          { value: 'frame', label: 'Frame' },
          { value: 'app-shell', label: 'AppShell' },
          { value: 'fullscreen', label: 'FullscreenShell' },
        ]}
      />

      <ViewNav
        activeView={flow.activeView}
        items={navigation}
        onNavigate={flow.navigate}
        variant="segmented"
        aria-label="Design-system categories"
      />

      <ViewStack flow={flow}>
        <View name="foundations"><FoundationsSection /></View>
        <View name="forms"><FormsSection /></View>
        <View name="data"><DataSection /></View>
        <View name="feedback"><FeedbackSection /></View>
        <View name="overlays"><OverlaysSection /></View>
        <View name="layouts"><LayoutSection /></View>
      </ViewStack>
    </>
  );

  const title = info.title ?? 'Noodle React design system';
  const subtitle = info.description ?? 'Interactive reference for every public component family.';
  const badge = <StatusBadge tone="info">v{info.version ?? 'local'}</StatusBadge>;
  const common = {
    className: layout.theme === 'dark' ? 'dark' : '',
    'data-llm': 'Developer-facing Noodle React design-system component showcase',
  };

  if (shell === 'app-shell') {
    return <AppShell {...common} title={title} subtitle={subtitle} badge={badge} displayMode="auto" footer="Host-neutral MCP Apps components">{content}</AppShell>;
  }
  if (shell === 'fullscreen') {
    return <FullscreenShell {...common} title={title} subtitle={subtitle} toolbar={badge} footer="Use the shell switcher to return to an inline preview.">{content}</FullscreenShell>;
  }
  return <Frame {...common} title={title} subtitle={subtitle} status={badge} footer="Reference implementation, not a product UX prescription.">{content}</Frame>;
}
`;

export const widgetShowcaseSections = `import { useState } from 'react';
import {
  Action,
  ActionBar,
  AsyncBoundary,
  Avatar,
  AvatarGroup,
  Checkbox,
  ChoiceGroup,
  Collection,
  DataCard,
  DataList,
  EmptyState,
  ErrorState,
  ExpandButton,
  Fact,
  Feedback,
  Field,
  Flow,
  Form,
  HandoffButton,
  InlineCard,
  InlineCarousel,
  InlineList,
  Input,
  LoadingState,
  Menu,
  Overlay,
  Popover,
  QuantityStepper,
  RadioGroup,
  Region,
  SegmentedControl,
  Select,
  ShellHeader,
  ShellNav,
  Slider,
  Spinner,
  StatusBadge,
  SubmitButton,
  Switch,
  Textarea,
  Tooltip,
  useCallTool,
  useHandoff,
  useViewState,
  useWidgetReady,
} from '../helpers.js';

export function FoundationsSection() {
  const handoff = useHandoff();
  return (
    <Flow variant="stack">
      <Region title="Actions" description="Button, link, pending, disabled, handoff, and display-mode actions.">
        <ActionBar>
          <Action variant="primary">Primary</Action>
          <Action variant="secondary">Secondary</Action>
          <Action variant="quiet">Quiet</Action>
          <Action variant="danger">Danger</Action>
          <Action pending pendingLabel="Working…">Pending</Action>
          <Action disabled>Disabled</Action>
          <Action as="a" href="https://modelcontextprotocol.io" external>External link</Action>
          <ExpandButton>Request fullscreen</ExpandButton>
          <HandoffButton handoff={handoff} target="https://example.com" disabled>Handoff</HandoffButton>
        </ActionBar>
      </Region>

      <Region title="Status badges" description="Semantic tones remain host-adaptive.">
        <Flow variant="cluster">
          <StatusBadge>Neutral</StatusBadge>
          <StatusBadge tone="success">Success</StatusBadge>
          <StatusBadge tone="warning">Warning</StatusBadge>
          <StatusBadge tone="danger">Danger</StatusBadge>
          <StatusBadge tone="info">Info</StatusBadge>
        </Flow>
      </Region>

      <Region title="Avatars" description="Image-free fallbacks and overflow grouping.">
        <AvatarGroup max={3}>
          <Avatar name="Ada Lovelace" size={40} />
          <Avatar name="Grace Hopper" size={40} />
          <Avatar name="Alan Turing" size={40} />
          <Avatar name="Katherine Johnson" size={40} />
        </AvatarGroup>
      </Region>
    </Flow>
  );
}

export function FormsSection() {
  const ready = useWidgetReady();
  const demo = useCallTool('run_component_demo');
  const [email, setEmail] = useViewState('showcase_email', 'ada@example.com');
  const [notes, setNotes] = useState('Host-neutral controls with native semantics.');
  const [selectValue, setSelectValue] = useState('comfortable');
  const [radioValue, setRadioValue] = useState('daily');
  const [switchValue, setSwitchValue] = useState(true);
  const [sliderValue, setSliderValue] = useState(60);
  const [segmentValue, setSegmentValue] = useState('preview');
  const [choices, setChoices] = useState<readonly string[]>(['forms']);
  const [quantity, setQuantity] = useState(2);

  return (
    <Form onSubmit={() => {
      void demo.callTool({ component: 'Form controls', value: email }).catch(() => undefined);
    }}>
      <Flow variant="stack">
        <Region title="Text controls" description="Labels, descriptions, errors, refs, and native form behavior.">
          <Flow variant="grid">
            <Field label="Email" detail="Field connects every accessible relationship." required>
              <Input name="email" type="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
            </Field>
            <Field label="Notes">
              <Textarea name="notes" value={notes} onChange={(event) => setNotes(event.currentTarget.value)} />
            </Field>
            <Field label="Density">
              <Select name="density" value={selectValue} onChange={(event) => setSelectValue(event.currentTarget.value)} options={[
                { value: 'compact', label: 'Compact' },
                { value: 'comfortable', label: 'Comfortable' },
              ]} />
            </Field>
          </Flow>
        </Region>

        <Region title="Choice controls" description="Native checkbox, radio, switch, range, and segmented interaction.">
          <Flow variant="grid">
            <Checkbox name="updates" defaultChecked label="Checkbox" />
            <Switch name="enabled" checked={switchValue} onCheckedChange={setSwitchValue} label="Switch" />
            <Field label="Cadence" group required>
              <RadioGroup name="cadence" value={radioValue} onValueChange={setRadioValue} options={[
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
              ]} />
            </Field>
            <Field label="Volume">
              <Slider aria-label="Volume" name="volume" min={0} max={100} value={sliderValue} onChange={(event) => setSliderValue(Number(event.currentTarget.value))} />
            </Field>
            <Field label="Mode" group>
              <SegmentedControl name="mode" value={segmentValue} onValueChange={setSegmentValue} options={[
                { value: 'preview', label: 'Preview' },
                { value: 'code', label: 'Code' },
              ]} />
            </Field>
          </Flow>
        </Region>

        <Region title="Composite controls" description="Controlled multi-choice and quantity patterns.">
          <Flow variant="cluster">
            <ChoiceGroup values={['forms', 'data', 'overlays']} selected={choices} onChange={setChoices} labelFor={(value) => value} />
            <QuantityStepper value={quantity} min={0} max={5} onChange={setQuantity} />
          </Flow>
        </Region>

        <ActionBar>
          <SubmitButton disabled={!ready} pending={demo.isPending} pendingLabel="Running demo…">Run form demo</SubmitButton>
          <Action type="reset" variant="quiet">Native reset</Action>
        </ActionBar>
      </Flow>
    </Form>
  );
}

export function DataSection() {
  const cards = [
    { id: 'alpha', title: 'Alpha', description: 'Ready for review', meta: '12 items' },
    { id: 'beta', title: 'Beta', description: 'Needs attention', meta: '4 items' },
    { id: 'gamma', title: 'Gamma', description: 'Recently updated', meta: '8 items' },
  ];
  return (
    <Flow variant="stack">
      <Region title="Facts" description="Compact label/value summaries with semantic tone.">
        <Flow variant="grid">
          <Fact label="Latency" value="42 ms" detail="p95" />
          <Fact label="Success" value="99.9%" tone="success" trend="+0.4%" />
          <Fact label="Budget" value="72%" tone="warning" detail="monthly" />
          <Fact label="Errors" value="3" tone="danger" detail="last hour" />
        </Flow>
      </Region>

      <Region title="Collections" description="List, grid, and selected repeated-data treatments.">
        <Collection variant="grid" selectionMode="single">
          {cards.map((card, index) => <Collection.Item key={card.id} as="button" type="button" selected={index === 0} title={card.title} description={card.description} meta={card.meta} badge={<StatusBadge tone={index === 1 ? 'warning' : 'success'}>{index === 1 ? 'Review' : 'Ready'}</StatusBadge>} />)}
        </Collection>
      </Region>

      <Region title="DataCard and DataList">
        <DataList>
          <DataCard as="article"><strong>DataCard</strong><p>Low-level content card for application-specific composition.</p></DataCard>
          <DataCard as="button" type="button"><strong>Interactive DataCard</strong><p>Uses native button behavior.</p></DataCard>
        </DataList>
      </Region>
    </Flow>
  );
}

export function FeedbackSection() {
  const demo = useCallTool('run_component_demo');
  return (
    <Flow variant="stack">
      <Region title="Feedback states" description="Loading, empty, error, success, partial, permission, and unsupported.">
        <Flow variant="grid">
          <Feedback status="loading" description="Fetching the latest result…" />
          <Feedback status="empty" description="Try changing the filters." />
          <Feedback status="error" description="The request could not be completed." />
          <Feedback status="success" description="Everything is up to date." />
          <Feedback status="partial" description="Some sources are still pending." />
          <Feedback status="permission-denied" description="Reconnect the required account." />
          <Feedback status="unsupported" description="This host does not expose that capability." />
        </Flow>
      </Region>

      <Region title="State wrappers">
        <Flow variant="grid">
          <LoadingState><Spinner label="Loading state" /> LoadingState</LoadingState>
          <EmptyState>EmptyState</EmptyState>
          <ErrorState>ErrorState</ErrorState>
        </Flow>
      </Region>

      <Region title="AsyncBoundary" actions={<Action onClick={() => void demo.callTool({ component: 'AsyncBoundary', value: 'demo' }).catch(() => undefined)}>Run tool</Action>}>
        <AsyncBoundary state={demo} loading="Calling the app-only demo tool…" error={(error) => error.message} empty="No tool result yet" isEmpty={demo.isIdle}>
          <Feedback status="success" description={String(demo.structuredContent ? 'The demo tool returned structured content.' : 'Complete.')} />
        </AsyncBoundary>
      </Region>
    </Flow>
  );
}

export function OverlaysSection() {
  const [overlay, setOverlay] = useState<'modal' | 'sheet' | undefined>();
  const [activity, setActivity] = useState('No overlay action selected.');
  return (
    <Flow variant="stack">
      <Region title="Anchored overlays" description="Focus, keyboard behavior, dismissal, portals, and collision are Radix-backed.">
        <ActionBar>
          <Tooltip content="Tooltip content"><Action>Tooltip</Action></Tooltip>
          <Popover trigger="Popover" triggerLabel="Open popover"><Flow variant="stack"><strong>Popover content</strong><Action onClick={() => setActivity('Popover action selected.')}>Select</Action></Flow></Popover>
          <Menu trigger="Menu" triggerLabel="Open menu" items={[
            { label: 'Rename', onSelect: () => setActivity('Rename selected.') },
            { label: 'Archive', onSelect: () => setActivity('Archive selected.') },
            'separator',
            { label: 'Delete', danger: true, onSelect: () => setActivity('Delete selected.') },
          ]} />
        </ActionBar>
        <Feedback status="partial" title="Interaction log" description={activity} />
      </Region>

      <Region title="Dialog and sheet">
        <ActionBar>
          <Action onClick={() => setOverlay('modal')}>Open modal</Action>
          <Action onClick={() => setOverlay('sheet')}>Open sheet</Action>
        </ActionBar>
        <Overlay open={overlay !== undefined} onOpenChange={(open) => { if (!open) setOverlay(undefined); }} mode={overlay ?? 'modal'} title={overlay === 'sheet' ? 'Sheet example' : 'Modal example'} description="Escape, outside click, and the close button dismiss this surface.">
          <Action variant="primary" onClick={() => setOverlay(undefined)}>Complete</Action>
          <Menu trigger="Nested menu" items={[{ label: 'Nested action' }]} />
        </Overlay>
      </Region>

      <Overlay mode="detail" open title="Detail overlay" description="Detail mode remains an inline named region.">
        Use detail mode when content belongs in the document flow rather than a modal layer.
      </Overlay>
    </Flow>
  );
}

export function LayoutSection() {
  const [shellView, setShellView] = useState('overview');
  const carouselItems = [
    { id: 'one', title: 'First card' },
    { id: 'two', title: 'Second card' },
    { id: 'three', title: 'Third card' },
  ];
  return (
    <Flow variant="stack">
      <Region title="ShellHeader and ShellNav">
        <ShellHeader title="Application shell" subtitle="Header composition" badge={<StatusBadge tone="success">Live</StatusBadge>} />
        <ShellNav activeView={shellView} onNavigate={setShellView} items={[
          { view: 'overview', label: 'Overview' },
          { view: 'activity', label: 'Activity' },
          { view: 'settings', label: 'Settings' },
        ]} />
      </Region>

      <Region title="Flow variants" description="Stack, cluster, split, grid, and sidebar compositions share one primitive.">
        <Flow variant="split"><InlineCard title="Split A" description="First column" /><InlineCard title="Split B" description="Second column" /></Flow>
        <Flow variant="sidebar"><InlineCard title="Sidebar" description="Supporting rail" /><InlineCard title="Content" description="Primary area" /></Flow>
      </Region>

      <Region title="InlineCard">
        <InlineCard title="Compact inline surface" description="A host-blending card with two actions." primaryAction={<Action variant="primary">Primary</Action>} secondaryAction={<Action variant="quiet">Secondary</Action>}>InlineCard content</InlineCard>
      </Region>

      <Region title="InlineList">
        <InlineList items={carouselItems.map((item, index) => ({ id: item.id, title: item.title, description: 'List item description', meta: String(index + 1), action: <Action variant="quiet">Open</Action> }))} />
      </Region>

      <Region title="InlineCarousel">
        <InlineCarousel items={carouselItems}>{(item) => <InlineCard title={item.title} description="Horizontally scrollable item" />}</InlineCarousel>
      </Region>
    </Flow>
  );
}
`;
