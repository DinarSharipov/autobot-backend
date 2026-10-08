import { HttpStatus, Injectable } from '@nestjs/common';

import { ApiHttpException } from '../http/api-http.exception.js';

@Injectable()
export class OwnershipService {
  assertOwner(ownerUserId: string, principalUserId: string): void {
    if (ownerUserId !== principalUserId) {
      throw new ApiHttpException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', 'Resource not found.');
    }
  }
}
