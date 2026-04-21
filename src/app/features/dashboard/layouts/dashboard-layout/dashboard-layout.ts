import { Component, signal, inject, OnInit, OnDestroy, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser, DatePipe } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { SupabaseService } from '../../../../core/services/supabase-service';
import { BookingUiService } from '../../../../core/services/booking-ui.service';
import { PackagesUiService } from '../../../../core/services/packages-ui.service';
import { BookingsUiService } from '../../../../core/services/bookings-ui.service';
import { GiftcardUiService } from '../../../../core/services/giftcard-ui.service';
import { PwaInstallService } from '../../../../core/services/pwa-install.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { BookingDialog } from '../../../booking/components/booking-dialog/booking-dialog';
import { BookingsDialog } from '../../../../shared/components/bookings-dialog/bookings-dialog';
import { PackagesModal } from '../../../../shared/components/packages-modal/packages-modal';
import { GiftcardRedeemDialog } from '../../../landing/components/giftcard-redeem-dialog/giftcard-redeem-dialog';
import { PwaInstallDialogComponent } from '../../../../shared/components/pwa-install-dialog/pwa-install-dialog';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { Subscription } from 'rxjs';

interface NavItem {
  label: string;
  icon: string;
  route: string;
}

@Component({
  selector: 'app-dashboard-layout',
  standalone: true,
  imports: [RouterModule, DatePipe, BookingDialog, BookingsDialog, PackagesModal, GiftcardRedeemDialog, PwaInstallDialogComponent, ToastModule],
  providers: [MessageService],
  templateUrl: './dashboard-layout.html',
  styleUrl: './dashboard-layout.scss'
})
export class DashboardLayout implements OnInit, OnDestroy {
  private platformId = inject(PLATFORM_ID);
  private router = inject(Router);
  private supabaseService = inject(SupabaseService);
  protected bookingUiService = inject(BookingUiService);
  protected packagesUiService = inject(PackagesUiService);
  protected bookingsUiService = inject(BookingsUiService);
  protected giftcardUiService = inject(GiftcardUiService);
  protected pwaService = inject(PwaInstallService);
  protected notificationService = inject(NotificationService);

  isMobile = signal(false);
  sidebarExpanded = signal(false);
  showNotifications = signal(false);

  unreadCount = this.notificationService.unreadNotificationsCount;
  notificationHistory = this.notificationService.history;

  navItems: NavItem[] = [
    { label: 'Dashboard',         icon: 'pi pi-home',          route: '/dashboard' },
    { label: 'Mis Reservas',      icon: 'pi pi-calendar',      route: '/dashboard/reservas' },
    { label: 'Créditos',          icon: 'pi pi-credit-card',   route: '/dashboard/gestion-creditos' },
    { label: 'Historial',         icon: 'pi pi-wallet',        route: '/dashboard/historial-creditos' },
    { label: 'Mi Perfil',         icon: 'pi pi-user',          route: '/dashboard/perfil' },
    { label: 'Contraseña',        icon: 'pi pi-lock',          route: '/dashboard/cambiar-contrasena' },
  ];

  bottomNavItems: NavItem[] = this.navItems.slice(0, 4);

  private resizeListener?: () => void;
  private notificationSub?: Subscription;

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      this.checkScreenSize();
      this.resizeListener = () => this.checkScreenSize();
      window.addEventListener('resize', this.resizeListener);
    }

    this.notificationSub = this.notificationService.notificationReceived$.subscribe(() => {
      // history signal updates reactively
    });
  }

  ngOnDestroy() {
    if (isPlatformBrowser(this.platformId) && this.resizeListener) {
      window.removeEventListener('resize', this.resizeListener);
    }
    this.notificationSub?.unsubscribe();
  }

  private checkScreenSize() {
    this.isMobile.set(window.innerWidth < 768);
  }

  toggleNotifications() {
    this.showNotifications.set(!this.showNotifications());
  }

  async reload() {
    const currentUrl = this.router.url;
    await this.router.navigateByUrl('/', { skipLocationChange: true });
    await this.router.navigate([currentUrl]);
  }

  openInstallDialog() {
    this.pwaService.openInstallDialog();
  }

  async logout() {
    await this.supabaseService.signOut();
    this.router.navigate(['/']);
  }
}
