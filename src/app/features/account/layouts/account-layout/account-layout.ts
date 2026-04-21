import { Component, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { DrawerModule } from 'primeng/drawer';
import { ButtonModule } from 'primeng/button';
import { MenuModule } from 'primeng/menu';
import { MenuItem } from 'primeng/api';
import { CardModule } from 'primeng/card';
import { AvatarModule } from 'primeng/avatar';
import { SupabaseService } from '../../../../core/services/supabase-service';


@Component({
  selector: 'app-account-layout',
   imports: [
    CommonModule,
    RouterModule,
    DrawerModule,
    ButtonModule,
    MenuModule,
    CardModule,
    AvatarModule
  ],
  templateUrl: './account-layout.html',
  styleUrl: './account-layout.scss'
})
export class AccountLayout {
  private router = inject(Router);
  private supabaseService = inject(SupabaseService);
  
  sidebarVisible = signal(false);
  isMobile = signal(false);
  currentUser = signal<any>(null);
  
  menuItems: MenuItem[] = [
    {
      label: 'Dashboard',
      icon: 'pi pi-home',
      routerLink: '/mi-cuenta/dashboard'
    },
    {
      label: 'Mi Perfil',
      icon: 'pi pi-user',
      routerLink: '/mi-cuenta/perfil'
    },
    {
      label: 'Cambiar Contraseña',
      icon: 'pi pi-lock',
      routerLink: '/mi-cuenta/cambiar-contrasena'
    },
    {
      label: 'Mis Reservas',
      icon: 'pi pi-calendar',
      routerLink: '/mi-cuenta/reservas'
    },
    {
      label: 'Gestión de Créditos',
      icon: 'pi pi-credit-card',
      routerLink: '/mi-cuenta/gestion-creditos'
    },
    {
      label: 'Historial de Créditos',
      icon: 'pi pi-wallet',
      routerLink: '/mi-cuenta/historial-creditos'
    }
  ];
  
  ngOnInit() {
    this.checkScreenSize();
    window.addEventListener('resize', () => this.checkScreenSize());
    
    const user = this.supabaseService.getUser();
    this.currentUser.set(user);
  }
  
  private checkScreenSize() {
    this.isMobile.set(window.innerWidth < 768);
    if (!this.isMobile()) {
      this.sidebarVisible.set(true);
    }
  }
  
  toggleSidebar() {
    this.sidebarVisible.set(!this.sidebarVisible());
  }
  
  getUserDisplayName(): string {
    const user = this.currentUser();
    return user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Usuario';
  }
  
  navigateTo(route: string) {
    this.router.navigate([route]);
    if (this.isMobile()) {
      this.sidebarVisible.set(false);
    }
  }
}
