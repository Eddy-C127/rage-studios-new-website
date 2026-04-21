import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';
import { landingGuard } from './core/guards/landing.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/landing/pages/landing/landing').then(m => m.Landing),
    canActivate: [landingGuard]
  },
  { 
    path: 'checkout',
    children: [
      {
        path: 'success',
        loadComponent: () => import('./features/checkout/pages/success/success').then(m => m.Success)
      },
      {
        path: 'cancel',
        loadComponent: () => import('./features/checkout/pages/cancel/cancel').then(m => m.Cancel)
      },
      {
        path: ':packageId',
        loadComponent: () => import('./features/checkout/pages/checkout/checkout').then(m => m.Checkout),
        canActivate: [authGuard]
      }
    ]
  },
  {
    path: 'mi-cuenta',
    redirectTo: '/dashboard',
    pathMatch: 'full'
  },
  {
    path: 'dashboard',
    loadComponent: () => import('./features/dashboard/layouts/dashboard-layout/dashboard-layout').then(m => m.DashboardLayout),
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/dashboard/pages/dashboard/dashboard').then(m => m.DashboardComponent)
      },
      {
        path: 'perfil',
        loadComponent: () => import('./features/account/pages/profile-edit/profile-edit').then(m => m.ProfileEdit)
      },
      {
        path: 'cambiar-contrasena',
        loadComponent: () => import('./features/account/pages/change-password/change-password').then(m => m.ChangePassword)
      },
      {
        path: 'reservas',
        loadComponent: () => import('./features/account/pages/my-bookings/my-bookings').then(m => m.MyBookings)
      },
      {
        path: 'gestion-creditos',
        loadComponent: () => import('./features/account/pages/credit-management/credit-management').then(m => m.CreditManagement)
      },
      {
        path: 'historial-creditos',
        loadComponent: () => import('./features/account/pages/credit-history/credit-history').then(m => m.CreditHistory)
      }
    ]
  },
  {
    path: 'admin',
    loadComponent: () => import('./features/admin/layouts/admin-layout/admin-layout').then(m => m.AdminLayout),
    canActivate: [adminGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/admin/pages/admin-dashboard/admin-dashboard').then(m => m.AdminDashboard)
      },
      {
        path: 'reservas',
        loadComponent: () => import('./features/admin/pages/admin-reservas/admin-reservas').then(m => m.AdminReservas)
      },
      {
        path: 'coaches',
        loadComponent: () => import('./features/admin/pages/admin-coaches/admin-coaches').then(m => m.AdminCoaches)
      },
      {
        path: 'slides',
        loadComponent: () => import('./features/admin/pages/admin-slides/admin-slides').then(m => m.AdminSlides)
      },
      {
        path: 'sessions',
        loadComponent: () => import('./features/admin/pages/admin-sessions/admin-sessions').then(m => m.AdminSessions)
      },
      {
        path: 'credits',
        children: [
          {
            path: '',
            loadComponent: () => import('./features/admin/pages/admin-credits-navigation/admin-credits-navigation').then(m => m.AdminCreditsNavigation)
          },
          {
            path: 'assign',
            loadComponent: () => import('./features/admin/pages/admin-credits-assign/admin-credits-assign').then(m => m.AdminCreditsAssign)
          },
          {
            path: 'deduct',
            loadComponent: () => import('./features/admin/pages/admin-credits-deduct/admin-credits-deduct').then(m => m.AdminCreditsDeduct)
          }
        ]
      },
      {
        path: 'giftcards',
        children: [
          {
            path: '',
            loadComponent: () => import('./features/admin/pages/admin-giftcards-navigation/admin-giftcards-navigation').then(m => m.AdminGiftcardsNavigation)
          },
          {
            path: 'manage',
            loadComponent: () => import('./features/admin/pages/admin-giftcards-manage/admin-giftcards-manage').then(m => m.AdminGiftcardsManage)
          },
          {
            path: 'assign',
            loadComponent: () => import('./features/admin/pages/admin-giftcards-assign/admin-giftcards-assign').then(m => m.AdminGiftcardsAssign)
          }
        ]
      },
      {
        path: 'horarios',
        loadComponent: () => import('./features/admin/pages/admin-schedule/admin-schedule').then(m => m.AdminSchedule)
      },
      {
        path: 'excepciones',
        loadComponent: () => import('./features/admin/pages/admin-exceptions/admin-exceptions').then(m => m.AdminExceptions)
      },
      {
        path: 'noticias',
        loadComponent: () => import('./features/admin/pages/admin-noticias/admin-noticias').then(m => m.AdminNoticias)
      }
    ]
  },
  {
    path: '**',
    redirectTo: ''
  }
];
