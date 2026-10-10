export interface ModelClient {
  complete(request: {
    system: string;
    messages: Array<{ role: 'user'; content: string }>;
    temperature: 0;
    responseFormat: 'json_object';
  }): Promise<string>;
}

export interface OpenAiClientOptions {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  fetchFn?: typeof fetch;
}

export class OpenAiClient implements ModelClient {
  private apiKey: string;
  private baseUrl: string;
  private modelName: string;
  private fetchFn: typeof fetch;

  constructor(options: OpenAiClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (
      options.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      'https://api.openai.com/v1'
    ).replace(/\/+$/, '');
    this.modelName =
      options.modelName ?? process.env.IDT_MODEL_NAME ?? 'gpt-4o';
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async complete(request: {
    system: string;
    messages: Array<{ role: 'user'; content: string }>;
    temperature: 0;
    responseFormat: 'json_object';
  }): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;

    const requestBody = {
      model: this.modelName,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages,
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${errorText}`);
    }

    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenAI response missing message content in choices[0].message.content');
    }

    return content;
  }
}
