import type { Request } from 'express';

export type BrowserPrincipal = {
  kind: 'browser';
  userId: string;
  sessionId: string;
};

export type BotServicePrincipal = {
  kind: 'bot-service';
  service: 'autobot-bot';
  keyId: string;
  telegramUserId: string;
};

export type BotUserPrincipal = Omit<BotServicePrincipal, 'kind'> & {
  kind: 'bot-user';
  userId: string;
};

export type AuthPrincipal = BrowserPrincipal | BotServicePrincipal | BotUserPrincipal;

export type AuthenticatedRequest = Request & {
  authPrincipal?: AuthPrincipal;
  sessionExpiresAt?: Date;
  rawBody?: Buffer;
};
