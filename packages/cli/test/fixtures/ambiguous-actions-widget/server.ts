import { server, tool, z } from '@noodleseed/one';
const input = z.object({ ticket_id: z.string().default('T-100') });
const output = z.object({ ticket_id: z.string(), status: z.string() });
export default server('ambiguous_actions_widget', { title: 'Ambiguous Actions Widget', version: '1.0.0' }, [
    tool('open_ticket_actions', {
        description: 'Open a ticket workspace with several possible actions.',
        input,
        output,
        fulfil: ({ input }) => ({ ticket_id: input.ticket_id, status: 'open' }),
        viewTitle: 'Ticket actions',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
    tool('assign_ticket', {
        description: 'Assign a ticket.',
        input,
        output,
        fulfil: ({ input }) => ({
        ticket_id: input.ticket_id,
        status: 'assigned',
    }),
    }),
    tool('escalate_ticket', {
        description: 'Escalate a ticket.',
        input,
        output,
        fulfil: ({ input }) => ({
        ticket_id: input.ticket_id,
        status: 'escalated',
    }),
    }),
    tool('close_ticket', {
        description: 'Close a ticket.',
        input,
        output,
        fulfil: ({ input }) => ({
        ticket_id: input.ticket_id,
        status: 'closed',
    }),
    }),
]);
