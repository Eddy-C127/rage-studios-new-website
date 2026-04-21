import {
  ApplicationConfig,
  provideZonelessChangeDetection,
  importProvidersFrom,
  LOCALE_ID,
} from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEs from '@angular/common/locales/es';
import { provideRouter } from '@angular/router';

import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { AuthRateLimitInterceptor } from './core/interceptors/auth-rate-limit.interceptor';
import { providePrimeNG } from 'primeng/config';
import { MessageService } from 'primeng/api';
import Aura from '@primeuix/themes/aura';
import { PRIMENG_SPANISH_LOCALE } from './core/constants/primeng-spanish-locale';
import { NgxStripeModule } from 'ngx-stripe';
import { environment } from '../environments/environment';
import { routes } from './app.routes';

registerLocaleData(localeEs, 'es');

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(
      withFetch(),
      withInterceptors([AuthRateLimitInterceptor])
    ),
    providePrimeNG({
      theme: {
        preset: Aura,
        options: {
          darkModeSelector: '.my-app-dark',
          cssLayer: {
            name: 'primeng',
            order: 'theme, base, primeng'
          }
        }
      },
      ripple: true,
      translation: PRIMENG_SPANISH_LOCALE
    }),
    { provide: LOCALE_ID, useValue: 'es' },
    MessageService,
    importProvidersFrom(NgxStripeModule.forRoot(environment.STRIPE_PUBLISHABLE_KEY)),
  ],
};