import { connector, server, tool, z } from '@noodleseed/one';

const sonarModel = z.enum(['sonar', 'sonar-pro', 'sonar-deep-research', 'sonar-reasoning-pro']);
const searchContextSize = z.enum(['low', 'medium', 'high']);
const searchMode = z.enum(['web', 'academic', 'sec']);
const searchRecency = z.enum(['hour', 'day', 'week', 'month', 'year']);

const chatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const sourceResult = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string().optional(),
  date: z.string().optional(),
  last_updated: z.string().optional(),
  source: z.string().optional(),
});

const imageResult = z.object({
  image_url: z.string().optional(),
  origin_url: z.string().optional(),
  title: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const searchInput = z.object({
  query: z.string(),
  max_results: z.number().int().min(1).max(20).optional(),
  country: z.string().length(2).optional(),
  search_context_size: searchContextSize.optional(),
  max_tokens: z.number().int().positive().optional(),
  max_tokens_per_page: z.number().int().positive().optional(),
  search_language_filter: z.array(z.string().length(2)).max(20).optional(),
  search_domain_filter: z.array(z.string()).max(20).optional(),
  search_recency_filter: searchRecency.optional(),
  search_after_date_filter: z.string().optional().describe('MM/DD/YYYY.'),
  search_before_date_filter: z.string().optional().describe('MM/DD/YYYY.'),
  last_updated_after_filter: z.string().optional().describe('MM/DD/YYYY.'),
  last_updated_before_filter: z.string().optional().describe('MM/DD/YYYY.'),
});

const answerInput = z.object({
  messages: z.array(chatMessage).min(1),
  model: sonarModel.optional().describe('Defaults to sonar.'),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  search_mode: searchMode.optional(),
  search_context_size: searchContextSize.optional(),
  return_images: z.boolean().optional(),
  return_related_questions: z.boolean().optional(),
  search_domain_filter: z.array(z.string()).max(20).optional(),
  search_language_filter: z.array(z.string().length(2)).max(20).optional(),
  search_recency_filter: searchRecency.optional(),
  search_after_date_filter: z.string().optional().describe('MM/DD/YYYY.'),
  search_before_date_filter: z.string().optional().describe('MM/DD/YYYY.'),
  last_updated_after_filter: z.string().optional().describe('MM/DD/YYYY.'),
  last_updated_before_filter: z.string().optional().describe('MM/DD/YYYY.'),
});

const answerOutput = z.object({
  id: z.string(),
  model: z.string(),
  answer: z.string(),
  citations: z.array(z.string()).nullable().optional(),
  search_results: z.array(sourceResult).nullable().optional(),
  related_questions: z.array(z.string()).nullable().optional(),
  images: z.array(imageResult).nullable().optional(),
  usage: z.unknown().optional(),
});

const researchOutput = z.object({
  id: z.string(),
  status: z.string(),
  model: z.string(),
  output: z.array(z.unknown()),
  usage: z.unknown().optional(),
  error: z.unknown().optional(),
});

const asyncResearchOutput = z.object({
  id: z.string(),
  status: z.string(),
  model: z.string().optional(),
  response: z.unknown().optional(),
  error_message: z.unknown().optional(),
});

const perplexity = connector('perplexity')
  .version('1.0.0')
  .http({
    baseUrl: 'https://api.perplexity.ai',
    allowedOrigins: ['https://api.perplexity.ai'],
    auth: {
      kind: 'bearer',
      secret: 'PERPLEXITY_API_KEY',
    },
    operations: {
      search_web: {
        type: 'read',
        method: 'POST',
        path: '/search',
        input: z.object({
          query: z.string(),
          max_results: z.number().optional(),
          country: z.string().optional(),
          search_context_size: z.string().optional(),
          max_tokens: z.number().optional(),
          max_tokens_per_page: z.number().optional(),
          search_language_filter: z.array(z.unknown()).optional(),
          search_domain_filter: z.array(z.unknown()).optional(),
          search_recency_filter: z.string().optional(),
          search_after_date_filter: z.string().optional(),
          search_before_date_filter: z.string().optional(),
          last_updated_after_filter: z.string().optional(),
          last_updated_before_filter: z.string().optional(),
        }),
        output: z.object({
          id: z.string().optional(),
          results: z.array(z.unknown()).optional(),
          server_time: z.unknown().optional(),
        }),
        request: {
          query: '${args.query}',
          max_results: '${args.max_results}',
          country: '${args.country}',
          search_context_size: '${args.search_context_size}',
          max_tokens: '${args.max_tokens}',
          max_tokens_per_page: '${args.max_tokens_per_page}',
          search_language_filter: '${args.search_language_filter}',
          search_domain_filter: '${args.search_domain_filter}',
          search_recency_filter: '${args.search_recency_filter}',
          search_after_date_filter: '${args.search_after_date_filter}',
          search_before_date_filter: '${args.search_before_date_filter}',
          last_updated_after_filter: '${args.last_updated_after_filter}',
          last_updated_before_filter: '${args.last_updated_before_filter}',
        },
        response: {
          id: '${response.id}',
          results: '${response.results}',
          server_time: '${response.server_time}',
        },
      },
      create_chat_completion: {
        type: 'read',
        method: 'POST',
        path: '/v1/sonar',
        input: z.object({
          messages: z.array(z.unknown()),
          model: z.string().optional(),
          max_tokens: z.number().optional(),
          temperature: z.number().optional(),
          top_p: z.number().optional(),
          search_mode: z.string().optional(),
          search_context_size: z.string().optional(),
          return_images: z.boolean().optional(),
          return_related_questions: z.boolean().optional(),
          search_domain_filter: z.array(z.unknown()).optional(),
          search_language_filter: z.array(z.unknown()).optional(),
          search_recency_filter: z.string().optional(),
          search_after_date_filter: z.string().optional(),
          search_before_date_filter: z.string().optional(),
          last_updated_after_filter: z.string().optional(),
          last_updated_before_filter: z.string().optional(),
        }),
        output: z.object({
          id: z.string().optional(),
          model: z.string().optional(),
          answer: z.string().optional(),
          citations: z.unknown().optional(),
          search_results: z.unknown().optional(),
          related_questions: z.unknown().optional(),
          images: z.unknown().optional(),
          usage: z.unknown().optional(),
        }),
        request: {
          model: '${args.model ?? "sonar"}',
          stream: false,
          messages: '${args.messages}',
          max_tokens: '${args.max_tokens}',
          temperature: '${args.temperature}',
          top_p: '${args.top_p}',
          search_mode: '${args.search_mode}',
          web_search_options: {
            search_context_size: '${args.search_context_size}',
          },
          return_images: '${args.return_images}',
          return_related_questions: '${args.return_related_questions}',
          search_domain_filter: '${args.search_domain_filter}',
          search_language_filter: '${args.search_language_filter}',
          search_recency_filter: '${args.search_recency_filter}',
          search_after_date_filter: '${args.search_after_date_filter}',
          search_before_date_filter: '${args.search_before_date_filter}',
          last_updated_after_filter: '${args.last_updated_after_filter}',
          last_updated_before_filter: '${args.last_updated_before_filter}',
        },
        response: {
          id: '${response.id}',
          model: '${response.model}',
          answer: '${response.choices[0].message.content}',
          citations: '${response.citations}',
          search_results: '${response.search_results}',
          related_questions: '${response.related_questions}',
          images: '${response.images}',
          usage: '${response.usage}',
        },
      },
      create_agent_response: {
        type: 'read',
        method: 'POST',
        path: '/v1/agent',
        input: z.object({
          input: z.string(),
          model: z.string().optional(),
          models: z.array(z.unknown()).optional(),
          preset: z.string().optional(),
          instructions: z.string().optional(),
          language_preference: z.string().optional(),
          max_output_tokens: z.number().optional(),
          max_steps: z.number().optional(),
          tools: z.array(z.unknown()).optional(),
          reasoning: z.record(z.string(), z.unknown()).optional(),
          response_format: z.record(z.string(), z.unknown()).optional(),
        }),
        output: z.object({
          id: z.string().optional(),
          status: z.string().optional(),
          model: z.string().optional(),
          output: z.array(z.unknown()).optional(),
          usage: z.unknown().optional(),
          error: z.unknown().optional(),
        }),
        request: {
          input: '${args.input}',
          stream: false,
          model: '${args.model}',
          models: '${args.models}',
          preset: '${args.preset}',
          instructions: '${args.instructions}',
          language_preference: '${args.language_preference}',
          max_output_tokens: '${args.max_output_tokens}',
          max_steps: '${args.max_steps}',
          tools: '${args.tools}',
          reasoning: '${args.reasoning}',
          response_format: '${args.response_format}',
        },
        response: {
          id: '${response.id}',
          status: '${response.status}',
          model: '${response.model}',
          output: '${response.output}',
          usage: '${response.usage}',
          error: '${response.error}',
        },
      },
      start_async_chat_completion: {
        type: 'read',
        method: 'POST',
        path: '/v1/async/sonar',
        input: z.object({
          messages: z.array(z.unknown()),
          model: z.string().optional(),
          idempotency_key: z.string().optional(),
          max_tokens: z.number().optional(),
          temperature: z.number().optional(),
          search_context_size: z.string().optional(),
        }),
        output: z.object({
          id: z.string().optional(),
          status: z.string().optional(),
          model: z.string().optional(),
        }),
        request: {
          idempotency_key: '${args.idempotency_key}',
          request: {
            model: '${args.model ?? "sonar-deep-research"}',
            stream: false,
            messages: '${args.messages}',
            max_tokens: '${args.max_tokens}',
            temperature: '${args.temperature}',
            web_search_options: {
              search_context_size: '${args.search_context_size}',
            },
          },
        },
        response: {
          id: '${response.id}',
          status: '${response.status}',
          model: '${response.model}',
        },
      },
      get_async_chat_completion: {
        type: 'read',
        method: 'GET',
        path: '/v1/async/sonar/{api_request}',
        input: z.object({
          api_request: z.string(),
        }),
        output: z.object({
          id: z.string().optional(),
          status: z.string().optional(),
          model: z.string().optional(),
          response: z.unknown().optional(),
          error_message: z.unknown().optional(),
        }),
        response: {
          id: '${response.id}',
          status: '${response.status}',
          model: '${response.model}',
          response: '${response.response}',
          error_message: '${response.error_message}',
        },
      },
      list_async_chat_completions: {
        type: 'read',
        method: 'GET',
        path: '/v1/async/sonar',
        output: z.object({
          data: z.array(z.unknown()).optional(),
        }),
        response: {
          data: '${response.data}',
        },
      },
    },
  });

export default server(
  'perplexity',
  {
    title: 'Perplexity Grounding',
    version: '1.0.0',
    use: { api: perplexity },
    branding: {
      name: 'Perplexity Grounding',
      accent: '#16A394',
      radius: 'md',
      density: 'compact',
    },
  },
  [
    tool('search', {
      description:
        'Search current web sources with Perplexity Search and return ranked source results.',
      input: searchInput,
      output: z.object({
        id: z.string(),
        results: z.array(sourceResult),
        server_time: z.string().nullable().optional(),
      }),
      fulfil: ({ input, connectors }) => {
        const search = connectors.api.searchWeb({
          query: input.query,
          max_results: input.max_results,
          country: input.country,
          search_context_size: input.search_context_size,
          max_tokens: input.max_tokens,
          max_tokens_per_page: input.max_tokens_per_page,
          search_language_filter: input.search_language_filter,
          search_domain_filter: input.search_domain_filter,
          search_recency_filter: input.search_recency_filter,
          search_after_date_filter: input.search_after_date_filter,
          search_before_date_filter: input.search_before_date_filter,
          last_updated_after_filter: input.last_updated_after_filter,
          last_updated_before_filter: input.last_updated_before_filter,
        });
        return {
          id: search.id,
          results: search.results,
          server_time: search.server_time,
        };
      },
    }),
    tool('answer', {
      description:
        'Answer from current Perplexity Sonar web grounding with citations and search results.',
      input: answerInput,
      output: answerOutput,
      fulfil: ({ input, connectors }) => {
        const answer = connectors.api.createChatCompletion({
          messages: input.messages,
          model: input.model,
          max_tokens: input.max_tokens,
          temperature: input.temperature,
          top_p: input.top_p,
          search_mode: input.search_mode,
          search_context_size: input.search_context_size,
          return_images: input.return_images,
          return_related_questions: input.return_related_questions,
          search_domain_filter: input.search_domain_filter,
          search_language_filter: input.search_language_filter,
          search_recency_filter: input.search_recency_filter,
          search_after_date_filter: input.search_after_date_filter,
          search_before_date_filter: input.search_before_date_filter,
          last_updated_after_filter: input.last_updated_after_filter,
          last_updated_before_filter: input.last_updated_before_filter,
        });
        return {
          id: answer.id,
          model: answer.model,
          answer: answer.answer,
          citations: answer.citations,
          search_results: answer.search_results,
          related_questions: answer.related_questions,
          images: answer.images,
          usage: answer.usage,
        };
      },
    }),
    tool('research', {
      description:
        'Run a generic non-streaming Perplexity Agent research request with caller-provided instructions and controls.',
      input: z.object({
        input: z.string(),
        model: z.string().optional(),
        models: z.array(z.string()).min(1).max(5).optional(),
        preset: z
          .string()
          .optional()
          .describe('For example: fast-search, pro-search, or deep-research.'),
        instructions: z.string().optional(),
        language_preference: z.string().length(2).optional(),
        max_output_tokens: z.number().int().positive().optional(),
        max_steps: z.number().int().min(1).max(10).optional(),
        tools: z.array(z.unknown()).optional(),
        reasoning: z.unknown().optional(),
        response_format: z.unknown().optional(),
      }),
      output: researchOutput,
      fulfil: ({ input, connectors }) => {
        const research = connectors.api.createAgentResponse({
          input: input.input,
          model: input.model,
          models: input.models,
          preset: input.preset,
          instructions: input.instructions,
          language_preference: input.language_preference,
          max_output_tokens: input.max_output_tokens,
          max_steps: input.max_steps,
          tools: input.tools,
          reasoning: input.reasoning,
          response_format: input.response_format,
        });
        return {
          id: research.id,
          status: research.status,
          model: research.model,
          output: research.output,
          usage: research.usage,
          error: research.error,
        };
      },
    }),
    tool('start_research', {
      description:
        'Start an asynchronous Sonar research request and return its request id for polling.',
      input: z.object({
        messages: z.array(chatMessage).min(1),
        model: sonarModel.optional().describe('Defaults to sonar-deep-research.'),
        idempotency_key: z.string().optional(),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        search_context_size: searchContextSize.optional(),
      }),
      output: z.object({
        id: z.string(),
        status: z.string(),
        model: z.string(),
      }),
      fulfil: ({ input, connectors }) => {
        const started = connectors.api.startAsyncChatCompletion({
          messages: input.messages,
          model: input.model,
          idempotency_key: input.idempotency_key,
          max_tokens: input.max_tokens,
          temperature: input.temperature,
          search_context_size: input.search_context_size,
        });
        return {
          id: started.id,
          status: started.status,
          model: started.model,
        };
      },
    }),
    tool('get_research', {
      description:
        'Fetch the current status and result for an asynchronous Sonar research request.',
      input: z.object({
        api_request: z.string().describe('Async request id returned by start_research.'),
      }),
      output: asyncResearchOutput,
      fulfil: ({ input, connectors }) => {
        const result = connectors.api.getAsyncChatCompletion({
          api_request: input.api_request,
        });
        return {
          id: result.id,
          status: result.status,
          model: result.model,
          response: result.response,
          error_message: result.error_message,
        };
      },
    }),
    tool('list_research', {
      description: 'List asynchronous Sonar research requests for the Perplexity account.',
      input: z.object({}),
      output: z.object({
        data: z.array(z.unknown()),
      }),
      fulfil: ({ connectors }) => {
        const result = connectors.api.listAsyncChatCompletions();
        return { data: result.data };
      },
    }),
  ],
);
