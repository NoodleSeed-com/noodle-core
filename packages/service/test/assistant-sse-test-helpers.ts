export interface TestAssistantEvent {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Test-only complete-stream reader; browser parser behavior remains owned by @noodleseed/assistant. */
export async function readAssistantEvents(
  response: Response,
): Promise<readonly TestAssistantEvent[]> {
  const body = await response.text();
  return body
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      if (!event || !data) throw new Error(`malformed assistant test event: ${frame}`);
      return { event, data: JSON.parse(data) as Readonly<Record<string, unknown>> };
    });
}
