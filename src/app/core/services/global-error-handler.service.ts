import { ErrorHandler, Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { environment } from '../../../environments/environment';

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly platformId = inject(PLATFORM_ID);

  handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);

    if (!environment.production) {
      console.error('[GlobalErrorHandler]', error);
      return;
    }

    // In production, suppress noisy chunk-loading errors from lazy routes
    if (message.includes('ChunkLoadError') || message.includes('Loading chunk')) {
      if (isPlatformBrowser(this.platformId)) {
        window.location.reload();
      }
      return;
    }

    console.error('[GlobalErrorHandler]', message);
  }
}
