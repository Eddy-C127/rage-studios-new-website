import { Component, inject, signal, effect, PLATFORM_ID, Injector, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { PwaInstallService } from '../../../core/services/pwa-install.service';

@Component({
  selector: 'app-pwa-install-dialog',
  standalone: true,
  imports: [],
  templateUrl: './pwa-install-dialog.html',
  styleUrl: './pwa-install-dialog.scss'
})
export class PwaInstallDialogComponent {
  private readonly pwaService = inject(PwaInstallService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly injector = inject(Injector);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  show = signal(false);
  sheetVisible = signal(false);
  arrowVisible = signal(false);

  isIos = computed(() => {
    const state = this.pwaService.installabilityState();
    return state.platform === 'ios';
  });

  constructor() {
    if (!this.isBrowser) return;

    effect(() => {
      const shouldShow = this.pwaService.showInstallDialog();
      if (shouldShow) {
        this.open();
      } else {
        this.close();
      }
    }, { injector: this.injector });
  }

  private open(): void {
    this.show.set(true);
    // Sheet slides up after one frame
    requestAnimationFrame(() => {
      setTimeout(() => {
        this.sheetVisible.set(true);
        // Arrow appears after sheet is visible (iOS only)
        if (this.isIos()) {
          setTimeout(() => this.arrowVisible.set(true), 500);
        }
      }, 16);
    });
  }

  private close(): void {
    this.sheetVisible.set(false);
    this.arrowVisible.set(false);
    // Wait for slide-down animation before removing from DOM
    setTimeout(() => this.show.set(false), 400);
  }

  onOverlayClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.classList.contains('ath-overlay')) {
      this.understood();
    }
  }

  understood(): void {
    this.pwaService.closeInstallDialog();
  }

  dismiss(): void {
    this.pwaService.dismissInstall();
  }

  async install(): Promise<void> {
    await this.pwaService.promptInstall();
  }
}
