import { Component, signal, OnInit, OnDestroy, inject, ViewChild } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { RouterModule, Router, RouterLink } from '@angular/router';
import { Button } from 'primeng/button';
import { Drawer } from 'primeng/drawer';
import { Menu } from 'primeng/menu';
import { ToastModule } from 'primeng/toast';
import { MessageService, MenuItem } from 'primeng/api';
import { LoginDialog } from '../login-dialog/login-dialog';
import { RegisterDialog } from '../register-dialog/register-dialog';
import { ForgotPasswordDialog } from '../forgot-password-dialog/forgot-password-dialog';
import { Subscription } from 'rxjs';
import { SupabaseService } from '../../../core/services/supabase-service';
import { NavigationService } from '../../../core/services/navigation.service';
import { AuthUiService } from '../../../core/services/auth-ui.service';
import { BookingUiService } from '../../../core/services/booking-ui.service';
import { OverlayBadge } from 'primeng/overlaybadge';
import { Tooltip } from 'primeng/tooltip'
import { CreditsService } from '../../../core/services/credits.service';
import { BookingDialog } from '../../../features/booking/components/booking-dialog/booking-dialog';
import { BookingService } from '../../../core/services/booking.service';
import { BookingsDialog } from '../bookings-dialog/bookings-dialog';

interface NavItem {
  label: string;
  routerLink?: string;
  sectionId?: string;
  action?: 'route' | 'scroll';
}

interface Profile {
  id: string;
  full_name: string;
  phone: string;
  role: string;
  created_at: string;
  updated_at: string;
}

@Component({
  selector: 'app-topbar',
  standalone: true,
   imports: [
    UpperCasePipe,
    RouterModule, 
    Button, 
    Drawer, 
    Menu, 
    LoginDialog, 
    RegisterDialog,
    ForgotPasswordDialog,
    ToastModule,
    OverlayBadge,
    Tooltip,
    BookingDialog,
    BookingsDialog, 
    RouterLink
  ],
  providers: [MessageService],
  templateUrl: './topbar.html',
  styleUrl: './topbar.scss'
})
export class Topbar implements OnInit, OnDestroy {
  @ViewChild('userMenu') userMenu!: Menu;
  @ViewChild('bookingsDialog') bookingsDialog!: any;
  
  private supabaseService = inject(SupabaseService);
  private messageService = inject(MessageService);
  private navigationService = inject(NavigationService);
  private authUiService = inject(AuthUiService);
  private bookingUiService = inject(BookingUiService);
  private router = inject(Router);
  protected creditsService = inject(CreditsService);
  private bookingService = inject(BookingService);
  
  isLoggedIn = signal(false);
  currentUser = signal<any>(null);
  userProfile = signal<Profile | null>(null);
  profileLoading = signal(false);
  profileLoadAttempted = signal(false);
  leftMenuItems = signal<NavItem[]>([]);
  rightMenuItems = signal<NavItem[]>([]);
  showLoginDialog = this.authUiService.showLoginDialog;
  showRegisterDialog = this.authUiService.showRegisterDialog;
  showForgotPasswordDialog = this.authUiService.showForgotPasswordDialog;
  showBookingDialog = this.bookingUiService.showBookingDialog;
  mobileMenuVisible = signal(false);
  userMenuVisible = signal(false);
  userMenuItems = signal<MenuItem[]>([]);
  showBookingsDialog = signal(false);
  
  // 🔄 USAR SIGNAL REACTIVO CENTRALIZADO DEL BOOKING SERVICE
  activeBookingsCount = this.bookingService.activeBookingsCount;
  
  private authSubscription?: Subscription;
  
  // Left side menu items
  private leftNavItems: NavItem[] = [
    { label: 'Paquetes', sectionId: 'packages', action: 'scroll' },
    { label: 'Training', sectionId: 'sessions', action: 'scroll' }
  ];
  
  private leftNavItemsLoggedIn: NavItem[] = [
    { label: 'Reservar', action: 'scroll' },
    { label: 'Paquetes', sectionId: 'packages', action: 'scroll' },
    { label: 'Training', sectionId: 'sessions', action: 'scroll' }
  ];
  
  private leftNavItemsAdmin: NavItem[] = [
    { label: 'Reservar', action: 'scroll' },
    { label: 'Paquetes', sectionId: 'packages', action: 'scroll' },
    { label: 'Training', sectionId: 'sessions', action: 'scroll' },
    { label: 'Coaches', sectionId: 'coaches', action: 'scroll' }
  ];
  
  // Right side menu items
  private rightNavItems: NavItem[] = [
    { label: 'Coaches', sectionId: 'coaches', action: 'scroll' }
  ];
  
  private rightNavItemsLoggedIn: NavItem[] = [
    { label: 'Coaches', sectionId: 'coaches', action: 'scroll' },
    { label: 'Mi Cuenta', routerLink: '/dashboard', action: 'route' }
  ];
  
  private rightNavItemsAdmin: NavItem[] = [
    { label: 'Admin', routerLink: '/admin', action: 'route' },
    { label: 'Mi Cuenta', routerLink: '/dashboard', action: 'route' }
  ];
  
  ngOnInit() {
    this.authSubscription = this.supabaseService.currentUser$.subscribe(async user => {
      this.isLoggedIn.set(!!user);
      this.currentUser.set(user);
      
      if (user && !this.profileLoadAttempted()) {
        // CARGA ASÍNCRONA DEL PERFIL ANTES DE ACTUALIZAR MENÚS
        await this.loadUserProfile(user.id);
        // 🔄 ESTABLECER USUARIO EN BOOKING SERVICE PARA TRACKING REACTIVO
        this.bookingService.setCurrentUser(user.id);
      } else if (!user) {
        this.userProfile.set(null);
        this.profileLoadAttempted.set(false);
        // 🔄 LIMPIAR USUARIO EN BOOKING SERVICE
        this.bookingService.setCurrentUser(null);
      }
      
      // ACTUALIZAR MENÚS DESPUÉS DE CARGAR EL PERFIL
      this.updateMenuItems();
      this.updateUserMenu();
    });
  }
  
  ngOnDestroy() {
    this.authSubscription?.unsubscribe();
  }
  
  private updateMenuItems() {
    const loggedIn = this.isLoggedIn();
    const isAdmin = this.isAdmin();
    
    console.log('📋 Updating menu items:', { loggedIn, isAdmin });
    
    // Update left menu items based on user status
    if (!loggedIn) {
      this.leftMenuItems.set(this.leftNavItems);
    } else if (isAdmin) {
      this.leftMenuItems.set(this.leftNavItemsAdmin);
      console.log('✅ Admin left menu items set');
    } else {
      this.leftMenuItems.set(this.leftNavItemsLoggedIn);
    }
    
    // Update right menu items based on user status  
    if (!loggedIn) {
      this.rightMenuItems.set(this.rightNavItems);
    } else if (isAdmin) {
      this.rightMenuItems.set(this.rightNavItemsAdmin);
      console.log('✅ Admin right menu items set (includes Admin option)');
    } else {
      this.rightMenuItems.set(this.rightNavItemsLoggedIn);
    }
  }
  
  private updateUserMenu() {
    if (this.isLoggedIn()) {
      this.userMenuItems.set([
        {
          label: 'Cerrar Sesión',
          icon: 'pi pi-sign-out',
          command: () => this.logout()
        }
      ]);
    }
  }
  
  async logout() {
    try {
      await this.supabaseService.signOut();
      this.messageService.add({
        severity: 'success',
        summary: 'Éxito',
        detail: 'Sesión cerrada correctamente'
      });
      // Redirect to home page after successful logout
      this.router.navigate(['/']);
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Error al cerrar sesión'
      });
    }
  }
  
  openLoginDialog() {
    this.authUiService.openLoginDialog();
  }
  
  openRegisterDialog() {
    this.authUiService.openRegisterDialog();
  }
  
  onLoginDialogClose() {
    this.authUiService.closeLoginDialog();
  }
  
  onRegisterDialogClose() {
    this.authUiService.closeRegisterDialog();
  }
  
  onOpenRegisterFromLogin() {
    this.authUiService.openRegisterDialog();
  }
  
  onOpenLoginFromRegister() {
    this.authUiService.openLoginDialog();
  }
  
  onOpenForgotPasswordFromLogin() {
    this.authUiService.openForgotPasswordDialog();
  }
  
  onOpenLoginFromForgotPassword() {
    this.authUiService.openLoginDialog();
  }
  
  onForgotPasswordDialogClose() {
    this.authUiService.closeForgotPasswordDialog();
  }
  
  toggleMobileMenu() {
    this.mobileMenuVisible.set(!this.mobileMenuVisible());
  }
  
  toggleUserMenu(event: Event) {
    this.userMenu.toggle(event);
  }
  
  private async loadUserProfile(userId: string) {
    if (this.profileLoading()) return;
    
    this.profileLoading.set(true);
    this.profileLoadAttempted.set(true);
    
    try {
      const profile = await this.supabaseService.getProfile(userId);
      this.userProfile.set(profile);
      console.log('👤 Profile loaded:', { userId, role: profile?.role });
    } catch (error: any) {
      console.warn('User profile not found, using basic info:', error?.message);
      this.userProfile.set(null);
    } finally {
      this.profileLoading.set(false);
    }
  }
  
  getUserDisplayName(): string {
    const profile = this.userProfile();
    if (profile?.full_name) {
      return profile.full_name;
    }
    const user = this.currentUser();
    if (user?.user_metadata?.full_name) {
      return user.user_metadata.full_name;
    }
    return user?.email?.split('@')[0] || 'Usuario';
  }
  
  isAdmin(): boolean {
    const profile = this.userProfile();
    const isAdminUser = profile?.role === 'admin';
    console.log('🔐 isAdmin check:', { 
      profile: profile ? { id: profile.id, role: profile.role } : null, 
      isAdmin: isAdminUser 
    });
    return isAdminUser;
  }
  
  closeMobileMenu() {
    this.mobileMenuVisible.set(false);
  }
  
  onMenuItemClick() {
    this.closeMobileMenu();
  }
  
  onNavItemClick(item: NavItem, event?: Event) {
  if (event) {
    event.preventDefault();
  }
  
  // Caso especial para "Reservar"
  if (item.label === 'Reservar' && this.isLoggedIn()) {
    this.openBookingDialog();
    this.closeMobileMenu();
    return;
  }
  
  if (item.action === 'scroll' && item.sectionId) {
    this.navigationService.navigateToSection(item.sectionId);
  }
  
  this.closeMobileMenu();
}
  
  onLoginFromMobile() {
    this.closeMobileMenu();
    this.openLoginDialog();
  }
  
  onLogoutFromMobile() {
    this.closeMobileMenu();
    this.logout();
  }

  getCreditsTooltip(): string {
    if (this.creditsService.isUnlimited()) {
      return 'Créditos ilimitados';
    }
    return `${this.creditsService.totalCredits()} créditos disponibles`;
  }

  openBookingDialog() {
    this.bookingUiService.openBookingDialog();
  }

  // ✅ MÉTODO ELIMINADO - Ahora usa el signal reactivo del BookingService

  async openBookingsDialog() {
    // Usar el método del componente BookingsDialog para evitar bucles
    if (this.bookingsDialog) {
      await this.bookingsDialog.openDialog();
    } else {
      // Fallback si no hay referencia
      this.showBookingsDialog.set(true);
    }
    
    // 🔄 REFRESCAR AUTOMÁTICAMENTE EL CONTADOR (SIGNAL REACTIVO)
    await this.bookingService.refreshActiveBookingsCount();
  }

  closeBookingsDialog() {
    this.showBookingsDialog.set(false);
  }

  getActiveBookingsTooltip(): string {
    const count = this.activeBookingsCount();
    if (count === 0) return 'No tienes reservas activas';
    if (count === 1) return '1 reserva activa';
    return `${count} reservas activas`;
  }
}