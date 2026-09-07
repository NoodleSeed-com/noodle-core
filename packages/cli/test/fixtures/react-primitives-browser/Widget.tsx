import '@noodleseed/one/react/styles.css';
import { useState } from 'react';
import {
  Action,
  Field,
  Flow,
  Form,
  Frame,
  Input,
  Menu,
  Overlay,
  Popover,
  SegmentedControl,
  Spinner,
  Switch,
  Tooltip,
  useLayout,
} from '@noodleseed/one/react';

export default function Widget() {
  const layout = useLayout();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formIntents, setFormIntents] = useState(0);
  const [directActions, setDirectActions] = useState(0);

  return (
    <Frame
      data-testid="fixture"
      className={layout.theme === 'dark' ? 'dark' : ''}
      title="Primitive browser fixture"
      displayMode="auto"
    >
      <Flow variant="stack">
        <Field label="Email" detail="Browser-tested association" required>
          <Input name="email" type="email" defaultValue="ada@example.com" />
        </Field>

        <Form onSubmit={() => setFormIntents((current) => current + 1)}>
          <Field label="Job title" required>
            <Input data-testid="form-title" name="title" required />
          </Field>
          <Action data-testid="form-submit" type="submit" variant="primary">
            Create job
          </Action>
        </Form>
        <output data-testid="form-intents">{formIntents}</output>
        <Action data-testid="direct-action" onClick={() => setDirectActions((current) => current + 1)}>
          Direct action
        </Action>
        <output data-testid="direct-actions">{directActions}</output>

        <Switch name="alerts" defaultChecked label="Alerts" />

        <SegmentedControl
          aria-label="Layout"
          name="layout"
          defaultValue="list"
          options={[
            { value: 'list', label: 'List' },
            { value: 'grid', label: 'Grid' },
            { value: 'board', label: 'Board', disabled: true },
          ]}
        />

        <Flow variant="cluster" style={{ justifyContent: 'flex-end' }}>
          <Tooltip content="Helpful description">
            <Action data-testid="tooltip-trigger">Help</Action>
          </Tooltip>
          <Popover trigger="Details" triggerLabel="Show details" align="end">
            <Action data-testid="popover-action">Inside popover</Action>
          </Popover>
          <Menu
            trigger="Actions"
            triggerLabel="Open actions"
            align="end"
            items={[
              { label: 'Rename', textValue: 'Rename' },
              { label: 'Archive', textValue: 'Archive', disabled: true },
              { label: 'Delete', textValue: 'Delete', danger: true },
            ]}
          />
          <Action data-testid="dialog-trigger" onClick={() => setDialogOpen(true)}>
            Open dialog
          </Action>
        </Flow>

        <Spinner label="Fixture spinner" />
      </Flow>

      <Overlay
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Confirm action"
        description="Keyboard focus stays in this modal."
      >
        <Action data-testid="dialog-action">Confirm</Action>
        <Menu
          trigger="Dialog menu"
          triggerLabel="Open dialog menu"
          items={[{ label: 'Nested action', textValue: 'Nested action' }]}
        />
      </Overlay>
    </Frame>
  );
}
