import { Module } from '@nestjs/common';

import { GptunnelClient } from './gptunnel.client.js';

@Module({ providers: [GptunnelClient], exports: [GptunnelClient] })
export class GptunnelModule {}
