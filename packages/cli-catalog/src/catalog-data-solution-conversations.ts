/** Staff conversation history operations (ADR 0241); imported by the solutions family. Data only. */
import {
  INSTALLATION_ARGUMENT,
  OPTIONAL_FLAG,
  SOLUTION_COMMON_FLAGS,
} from './catalog-data-solution-flags.js';
import type { FlagSpec, SubcommandSpec } from './catalog-types.js';

const STATUS_CHOICES = ['new', 'needs-attention', 'reviewed'];
const CONVERSATION_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  required: true,
  name: 'conversation',
  type: 'string',
  value: '<id>',
  summary: 'Conversation id from conversations list.',
};
const paging = (maximum: number): readonly FlagSpec[] => [
  {
    ...OPTIONAL_FLAG,
    name: 'limit',
    type: 'integer',
    value: '<count>',
    summary: 'Maximum conversations in this page.',
    constraints: { minimum: 1, maximum },
  },
  {
    ...OPTIONAL_FLAG,
    name: 'cursor',
    type: 'string',
    value: '<cursor>',
    summary: 'Opaque continuation from the prior page.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'channel',
    type: 'string',
    value: '<channel>',
    summary: 'Only conversations from this channel.',
    constraints: { choices: ['website', 'whatsapp'] },
  },
  {
    ...OPTIONAL_FLAG,
    name: 'status',
    type: 'string',
    value: '<status>',
    summary: 'Only conversations with this review status.',
    constraints: { choices: STATUS_CHOICES },
  },
];
const SELECTORS = ['conversation', 'customer', 'participant'] as const;
const SELECTOR_SUMMARIES = {
  conversation: 'Conversation id to erase.',
  customer: 'Verified customer reference whose conversations are erased.',
  participant: 'WhatsApp participant reference whose conversations are erased.',
} as const;

export const SOLUTION_CONVERSATIONS: SubcommandSpec = {
  name: 'conversations',
  summary: 'Read, review, note, export and forget customer conversation history.',
  arguments: [],
  flags: [],
  subcommands: [
    {
      name: 'list',
      summary: 'List conversations with unexpired messages, newest first.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: [...SOLUTION_COMMON_FLAGS, ...paging(100)],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'show',
      summary: 'Show one conversation with its messages and private notes; the read is audited.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: [...SOLUTION_COMMON_FLAGS, CONVERSATION_FLAG],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'review',
      summary: 'Set the review status of one conversation (Operator or above); audited.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: [
        ...SOLUTION_COMMON_FLAGS,
        CONVERSATION_FLAG,
        {
          ...OPTIONAL_FLAG,
          required: true,
          name: 'status',
          type: 'string',
          value: '<status>',
          summary: 'New review status.',
          constraints: { choices: STATUS_CHOICES },
        },
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'note',
      summary: 'Add a private staff note the customer never sees (Operator or above); audited.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: [
        ...SOLUTION_COMMON_FLAGS,
        CONVERSATION_FLAG,
        {
          ...OPTIONAL_FLAG,
          required: true,
          name: 'text',
          type: 'string',
          value: '<text>',
          summary: 'Note text, up to 2000 characters.',
          constraints: { maxLength: 2000 },
        },
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'export',
      summary: 'Export one page of conversations with messages (Owner or Administrator).',
      arguments: [INSTALLATION_ARGUMENT],
      flags: [...SOLUTION_COMMON_FLAGS, ...paging(25)],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'forget',
      summary: 'Erase one conversation, or every conversation of a customer or participant.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: [
        ...SOLUTION_COMMON_FLAGS,
        ...SELECTORS.map(
          (name): FlagSpec => ({
            ...OPTIONAL_FLAG,
            name,
            type: 'string',
            value: name === 'conversation' ? '<id>' : '<ref>',
            summary: SELECTOR_SUMMARIES[name],
            conflictsWith: SELECTORS.filter((other) => other !== name),
          }),
        ),
        {
          ...OPTIONAL_FLAG,
          name: 'confirm',
          type: 'boolean',
          required: true,
          summary: 'Confirm permanently erasing the selected conversation history.',
        },
      ],
      jsonOutput: { mode: 'single' },
    },
  ],
};
