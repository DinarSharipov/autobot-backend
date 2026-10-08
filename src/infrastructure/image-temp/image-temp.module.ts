import { Global, Module } from '@nestjs/common';

import { ImageTempService } from './image-temp.service.js';

@Global()
@Module({
  providers: [ImageTempService],
  exports: [ImageTempService],
})
export class ImageTempModule {}
