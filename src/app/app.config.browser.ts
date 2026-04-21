import { mergeApplicationConfig, ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideClientHydration,
  withEventReplay,
} from '@angular/platform-browser';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideServiceWorker } from '@angular/service-worker';
import { appConfig } from './app.config';
import { environment } from '../environments/environment';

function getServiceWorkerProviders() {
  const swConfig = environment.serviceWorker;

  if (!swConfig || !swConfig.enabled) {
    return [];
  }

  const swOptions: any = {
    enabled: swConfig.enabled,
    registrationStrategy: swConfig.registrationStrategy,
    scope: swConfig.scope || '/'
  };

  if (swConfig.updateViaCache) {
    swOptions.updateViaCache = swConfig.updateViaCache as 'all' | 'imports' | 'none';
  }

  return [
    provideServiceWorker(swConfig.script, swOptions)
  ];
}

const browserConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideClientHydration(withEventReplay()),
    provideAnimationsAsync(),
    ...getServiceWorkerProviders()
  ]
};

export const config = mergeApplicationConfig(appConfig, browserConfig);
