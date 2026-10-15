export type ImageGenerationInput = {
  prompt: string;
  text: string;
  idempotencyKey: string;
};

export type ImageGenerationResult = { filePath: string };

export class ImageGenerationProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'ImageGenerationProviderError';
  }
}

export abstract class ImageGenerationAdapter {
  abstract generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}
