import { annotations, server, tool, z } from '@noodleseed/one';

const videos = [
  {
    title: 'Paris sunset',
    caption: 'Eiffel Tower at sunset',
    posterUrl: 'https://upload.wikimedia.org/paris-poster.jpg',
    videoUrl: 'https://upload.wikimedia.org/paris.webm',
    alt: 'Paris video',
  },
  {
    title: 'Himalayan valley',
    caption: 'Rural mountain landscape',
    posterUrl: 'https://upload.wikimedia.org/himalaya-poster.jpg',
    videoUrl: 'https://upload.wikimedia.org/himalaya.webm',
    alt: 'Mountain video',
  },
] as const;

export default server(
  'travel_discovery_check',
  {
    title: 'Travel Video Carousel Check',
    version: '1.0.0',
    branding: {
      name: 'Travel Video Carousel Check',
      accent: '#0F766E',
      radius: 'md',
      density: 'comfortable',
    },
    shell: {
      displayMode: 'immersive',
      header: { title: 'Travel Video Carousel Check', subtitle: 'Public videos.' },
    },
  },
  [
    tool('show_videos', {
      description: 'Open a simple video carousel.',
      input: z.object({}),
      output: z.object({
        status: z.string(),
        video_count: z.number(),
        summary: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      fulfil: () => ({
        status: 'Ready.',
        video_count: videos.length,
        summary: videos.map((video) => video.title).join(', '),
      }),
      viewName: 'show_videos_widget',
      viewTitle: 'Travel videos',
      viewDescription: 'A simple video carousel fixture.',
      view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
      csp: {
        resourceDomains: ['https://upload.wikimedia.org'],
      },
    }),
  ],
);
