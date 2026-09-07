// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createInteractionCard } from '../src/interaction-card.js';

describe('business-readable confirmation card', () => {
  it('keeps Additional details hidden when the option is omitted', () => {
    const card = createInteractionCard({
      tool: 'complete_task',
      arguments: {
        taskId: 'task_123',
        action: { connector: 'tasks@1.0.0', operation: 'complete' },
      },
      labels: {
        heading: 'Review and confirm',
        accept: 'Confirm',
        decline: "Don't proceed",
        details: 'Additional details',
        redacted: 'Hidden for security',
      },
      respond: vi.fn(),
    });

    expect(card.querySelector('details.proposal-details')).toBeNull();
    expect(card.textContent).not.toContain('Additional details');
    expect(card.textContent).not.toContain('tasks@1.0.0');
    expect(card.textContent).toContain('task_123');
  });

  it('shows Additional details only when explicitly enabled', () => {
    const card = createInteractionCard({
      tool: 'complete_task',
      arguments: {
        taskId: 'task_123',
        action: { connector: 'tasks@1.0.0', operation: 'complete' },
      },
      showDetails: true,
      labels: {
        heading: 'Review and confirm',
        accept: 'Confirm',
        decline: "Don't proceed",
        details: 'Additional details',
        redacted: 'Hidden for security',
      },
      respond: vi.fn(),
    });

    expect(card.querySelector('details.proposal-details')).not.toBeNull();
    expect(card.textContent).toContain('Additional details');
  });

  it('omits the complete technical disclosure while retaining the business review and decisions', () => {
    const card = createInteractionCard({
      tool: 'complete_task',
      title: 'Complete task',
      description: 'This will mark the task complete.',
      arguments: {
        taskId: 'task_123',
        action: { connector: 'tasks@1.0.0', operation: 'complete' },
      },
      showDetails: false,
      labels: {
        heading: 'Review and confirm',
        accept: 'Confirm',
        decline: "Don't proceed",
        details: 'Additional details',
        redacted: 'Hidden for security',
      },
      respond: vi.fn(),
    });

    expect(card.querySelector('details')).toBeNull();
    expect(card.querySelector('summary')).toBeNull();
    expect(card.textContent).not.toContain('Additional details');
    expect(card.textContent).not.toContain('tasks@1.0.0');
    expect(card.textContent).toContain('Complete task');
    expect(card.textContent).toContain('This will mark the task complete.');
    expect(card.textContent).toContain('task_123');
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Confirm',
      "Don't proceed",
    ]);
  });

  it('submits Confirm exactly once even when activated repeatedly', async () => {
    const respond = vi.fn(() => Promise.resolve());
    const card = createInteractionCard({
      tool: 'complete_task',
      showDetails: false,
      labels: {
        heading: 'Review and confirm',
        accept: 'Confirm',
        decline: "Don't proceed",
        details: 'Additional details',
        redacted: 'Hidden for security',
      },
      respond,
    });
    const confirm = card.querySelector<HTMLButtonElement>('.proposal-accept');
    confirm?.click();
    confirm?.click();
    await Promise.resolve();

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith('accept');
  });

  it('uses portable titles, descriptions, schema labels, and only two visible decisions', () => {
    const card = createInteractionCard({
      tool: 'complete_task',
      title: 'Complete task',
      description: 'This will mark the task complete for everyone on the project.',
      arguments: {
        taskId: 'task_123',
        changes: { owner: 'Maya', dueDate: '2026-07-21' },
      },
      reviewSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', title: 'Task' },
          changes: {
            type: 'object',
            title: 'Updates',
            properties: {
              owner: { type: 'string', title: 'Owner' },
              dueDate: { type: 'string', title: 'Due date', format: 'date' },
            },
          },
        },
      },
      labels: {
        heading: 'Review and confirm',
        accept: 'Confirm',
        decline: "Don't proceed",
        details: 'Additional details',
        redacted: 'Hidden for security',
      },
      respond: vi.fn(),
    });

    expect(card.querySelector('h3')?.textContent).toBe('Complete task');
    expect(card.textContent).toContain('mark the task complete');
    expect(card.textContent).toContain('Task');
    expect(card.textContent).toContain('Updates');
    expect(card.textContent).toContain('Owner');
    expect(card.textContent).toContain('Maya');
    expect(card.textContent).not.toContain('{"owner"');
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Confirm',
      "Don't proceed",
    ]);
  });

  it('turns redaction markers into reassuring business copy', () => {
    const card = createInteractionCard({
      tool: 'save_credentials',
      arguments: { password: '[REDACTED]' },
      labels: {
        heading: 'Review and confirm',
        accept: 'Confirm',
        decline: "Don't proceed",
        details: 'Additional details',
        redacted: 'Hidden for security',
      },
      respond: vi.fn(),
    });

    expect(card.textContent).toContain('Hidden for security');
    expect(card.textContent).not.toContain('[REDACTED]');
  });

  it('never renders a write-only sentinel in the business review or Additional details', () => {
    const sentinel = 'WRITE_ONLY_CART_PAYLOAD_SENTINEL_7e4a';
    const card = createInteractionCard({
      tool: 'create_checkout',
      arguments: {
        cart_payload: sentinel,
        cartName: 'August order',
        action: {
          connector: 'shop@1.0.0',
          operation: 'create_cart',
          arguments: { cart_payload: sentinel },
        },
      },
      reviewSchema: {
        type: 'object',
        properties: {
          cart_payload: { type: 'string', title: 'Cart payload', writeOnly: true },
          cartName: { type: 'string', title: 'Cart' },
          action: {
            type: 'object',
            properties: {
              arguments: {
                type: 'object',
                properties: {
                  cart_payload: { type: 'string', title: 'Cart payload', writeOnly: true },
                },
              },
            },
          },
        },
      },
      showDetails: true,
      labels: {
        heading: 'Review and confirm',
        accept: 'Confirm',
        decline: "Don't proceed",
        details: 'Additional details',
        redacted: 'Hidden for security',
      },
      respond: vi.fn(),
    });

    expect(card.textContent).toContain('August order');
    expect(card.textContent).toContain('Additional details');
    expect(card.textContent).toContain('Hidden for security');
    expect(card.textContent).not.toContain(sentinel);
  });
});
