export type TextGenerationInput = {
  prompt: string;
  topicPromptTemplate: string | null;
  revisionFeedback?: string | null;
  previousText?: string | null;
  maxCharacters?: number;
  idempotencyKey: string;
};

export type TextGenerationResult = {
  text: string;
  providerRequestId: string | null;
  inputUnits: number | null;
  outputUnits: number | null;
};

export abstract class TextGenerationAdapter {
  abstract generate(input: TextGenerationInput): Promise<TextGenerationResult>;
}

export class TextGenerationProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}
