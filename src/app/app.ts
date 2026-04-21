import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { Topbar } from './shared/components/topbar/topbar';
import { Footer } from './shared/components/footer/footer';
import { SocialSpeedDial } from './shared/components/social-speed-dial/social-speed-dial';
import { PwaInstallDialogComponent } from './shared/components/pwa-install-dialog/pwa-install-dialog';
import { PwaInstallService } from './core/services/pwa-install.service';
import { NotificationService } from './core/services/notification.service';
import { filter } from 'rxjs/operators';

const TOPBAR_HIDDEN_ROUTES = ['/dashboard'];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ButtonModule, ToastModule, Topbar, SocialSpeedDial, PwaInstallDialogComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  protected title = 'rage-studios';
  protected showTopbar = signal(true);

  private router = inject(Router);

  private readonly pwaInstallService = inject(PwaInstallService);
  private readonly notificationService = inject(NotificationService);

  ngOnInit(): void {
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd)
    ).subscribe((e: any) => {
      const hidden = TOPBAR_HIDDEN_ROUTES.some(r => e.urlAfterRedirects.startsWith(r));
      this.showTopbar.set(!hidden);
    });

    this.setupAutoInstallPrompt();
    
    // 🔔 Notification Service initialization happens automatically via constructor
    // but we ensure it's injected here for app startup
    console.log('🚀 App initialized - NotificationService status:', this.notificationService.getStatus());
  }
  
  private setupAutoInstallPrompt(): void {
    // Show install prompt ONLY for mobile first-time visitors
    // No manual buttons anywhere - only automatic dialog
    setTimeout(() => {
      const state = this.pwaInstallService.installabilityState();
      const isMobile = state.platform === 'android' || state.platform === 'ios';
      
      if (isMobile && this.pwaInstallService.canShowAutomaticPrompt()) {
        this.pwaInstallService.openInstallDialog();
      }
    }, 10000); // 10 seconds after app initialization
  }
}