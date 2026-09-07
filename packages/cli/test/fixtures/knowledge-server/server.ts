import { file, knowledge, server } from '@noodleseed/one';

const guide = knowledge('guide', {
  title: 'Fixture guide',
  description: 'Package-local knowledge fixture for the deploy hashing regression test.',
  documents: [file('./knowledge/guide.md', { title: 'Guide' })],
});

export default server('knowledge_fixture', {
  title: 'Knowledge fixture',
  version: '1.0.0',
  knowledge: [guide],
});
