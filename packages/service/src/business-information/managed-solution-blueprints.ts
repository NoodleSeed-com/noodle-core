import { type CompileError, compileVariableDeclarations } from '@noodle-borg/compiler';
import type { BuiltInProfileKey } from './contracts.js';

/** Curated first-party executable intent; collection declarations never synthesize tools. */
const BLUEPRINTS = {
  travel: {
    release: 3,
    collection: 'travel_requests',
    tool: 'submit_travel_request',
    title: 'Submit a travel request',
    description:
      'Send a travel service request to the business for staff review. This records a request; it does not change a reservation or issue a refund.',
  },
  ecommerce: {
    release: 2,
    collection: 'return_requests',
    tool: 'submit_commerce_request',
    title: 'Submit a return request',
    description:
      'Send an order or return request to the business for staff review. This records a request; it does not issue a refund or change an order.',
  },
  restaurant: {
    release: 2,
    collection: 'guest_requests',
    tool: 'submit_restaurant_request',
    title: 'Submit a guest request',
    description:
      'Send a guest request to the restaurant for staff review. This records a request; it does not confirm a reservation or place an order.',
  },
} as const;

export function managedSolutionBlueprint(key: BuiltInProfileKey, release: number) {
  if (key === 'b2b_saas') return undefined;
  const blueprint = BLUEPRINTS[key];
  if ((key === 'travel' || key === 'restaurant') && release === blueprint.release + 1)
    return {
      ...blueprint,
      release,
      followUpContact: true,
      description: `${blueprint.description} Ask for the guest's reply email before submission so staff can follow up. Explain that the business receives this address; never invent it or claim it is verified.`,
    };
  return blueprint.release === release ? blueprint : undefined;
}

export function managedSolutionVariables() {
  const errors: CompileError[] = [];
  const variables = compileVariableDeclarations(
    [
      {
        name: 'WEBSITE_ORIGIN',
        schemaVersion: 1,
        valueSchema: { type: 'string', minLength: 1, maxLength: 2048 },
        portal: {
          label: 'Website origin',
          help: 'The exact HTTPS origin where your assistant will be embedded, for example https://www.example.com.',
          group: 'Publishing',
        },
        requiredFor: [],
      },
    ],
    [],
    errors,
  );
  if (errors.length > 0) throw new Error('Invalid first-party solution settings declaration');
  return variables;
}
