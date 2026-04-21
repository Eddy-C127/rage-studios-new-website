import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { NgClass, DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { SupabaseService } from '../../../../core/services/supabase-service';
import { CreditsService } from '../../../../core/services/credits.service';
import { PurchasesService, ICreditBatch } from '../../../../core/services/purchases.service';
import { BookingService } from '../../../../core/services/booking.service';
import { BookingUiService } from '../../../../core/services/booking-ui.service';
import { PackagesUiService } from '../../../../core/services/packages-ui.service';
import { GiftcardUiService } from '../../../../core/services/giftcard-ui.service';
import { NewsService, NewsItem } from '../../../../core/services/news.service';
import { PaymentService } from '../../../../core/services/payment.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { PwaInstallService } from '../../../../core/services/pwa-install.service';
import { getTodayLocalYYYYMMDD, formatDateToLocalYYYYMMDD } from '../../../../core/functions/date-utils';
import { Subscription } from 'rxjs';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';


interface DaySlot {
  date: Date;
  label: string;   // 'LUN', 'MAR'…
  num: number;     // day number
  iso: string;     // YYYY-MM-DD
  hasBooking: boolean;
  isToday: boolean;
}

interface BookingCard {
  id: string;
  name: string;
  coach: string;
  bed: string;
  time: string;
  date: string;
  credits_used: number;
  canCancel: boolean;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [NgClass, DatePipe, ToastModule],
  providers: [MessageService],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss'
})
export class DashboardComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  private supabase = inject(SupabaseService);
  protected creditsService = inject(CreditsService);
  protected purchasesService = inject(PurchasesService);
  protected bookingService = inject(BookingService);
  private bookingUiService = inject(BookingUiService);
  private packagesUiService = inject(PackagesUiService);
  private giftcardUiService = inject(GiftcardUiService);
  private newsService = inject(NewsService);
  private paymentService = inject(PaymentService);
  private notificationService = inject(NotificationService);
  protected pwaService = inject(PwaInstallService);
  private messageService = inject(MessageService);


  private authSub?: Subscription;
  private bookingSub?: Subscription;
  private notificationSub?: Subscription;
  private userId = signal<string | null>(null);

  userProfile = signal<any>(null);

  streak = signal(14);
  membership = signal('ÉLITE');

  // ── Week streak ─────────────────────────────────────────────────────
  readonly weekDays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  // Fake: L M X J . S . attended this week
  readonly weekAttended = [true, true, true, true, false, true, false];

  // ── Quick actions ───────────────────────────────────────────────────
  quickActions = [
    { id: 'reservar', label: 'Reservar Clase', icon: 'pi pi-calendar', route: '/dashboard/reservas' },
    { id: 'espera',   label: 'Lista de Espera', icon: 'pi pi-clock',    route: '' },
    { id: 'logros',   label: 'Mis Logros',      icon: 'pi pi-star',     route: '' },
    { id: 'comprar',  label: 'Comprar Créditos', icon: 'pi pi-shopping-cart', route: '/checkout' }
  ];

  // ── News ─────────────────────────────────────────────────────────────
  news = signal<NewsItem[]>([]);

  // ── Badges ───────────────────────────────────────────────────────────
  badges = [
    { id: 1, label: '5 días seguidos', icon: '🔥', unlocked: true,  glow: '255,100,30'  },
    { id: 2, label: 'Sin faltas este mes', icon: '⭐', unlocked: true,  glow: '250,200,0'   },
    { id: 3, label: 'Guerrera de lunes',   icon: '💪', unlocked: true,  glow: '239,68,68'   },
    { id: 4, label: 'Racha 3 semanas',     icon: '🏆', unlocked: false, glow: '120,120,120' }
  ];

  // ── Credits accordion ────────────────────────────────────────────────
  creditsOpen = signal(true);
  creditBatches = signal<ICreditBatch[]>([]);
  loadingBatches = signal(false);

  activeBatches = computed(() =>
    this.creditBatches().filter(b =>
      b.credits_remaining > 0 &&
      (!b.expiration_date || new Date(b.expiration_date) > new Date())
    )
  );

  urgentBatches = computed(() =>
    this.activeBatches().filter(b => {
      if (!b.expiration_date) return false;
      const daysLeft = this.daysUntil(b.expiration_date);
      return daysLeft <= 7 && daysLeft >= 0;
    })
  );

  // ── Calendar + bookings ──────────────────────────────────────────────
  days = signal<DaySlot[]>([]);
  selectedDay = signal<DaySlot | null>(null);
  dayBookings = signal<BookingCard[]>([]);
  loadingBookings = signal(false);
  cancellingId = signal<string | null>(null);

  // ── Notifications ────────────────────────────────────────────────────
  showNotifications = signal(false);
  unreadCount = this.notificationService.unreadNotificationsCount;
  notificationHistory = this.notificationService.history;

  // ─────────────────────────────────────────────────────────────────────

  ngOnInit() {
    this.authSub = this.supabase.currentUser$.subscribe(async user => {
      if (user) {
        this.userId.set(user.id);
        const profile = await this.supabase.getProfile(user.id);
        if (profile) this.userProfile.set(profile);
        await this.buildWeekDays(user.id);
        await this.loadCredits();
      }
    });

    // 🔄 Suscribirse a cambios en las reservas para refrescar créditos, calendario y notificaciones
    this.bookingSub = this.bookingUiService.bookingSuccess$.subscribe(async () => {
      const uid = this.userId();
      if (uid) {
        await Promise.all([
          this.loadCredits(),
          this.buildWeekDays(uid)
        ]);
        
        // Pequeña espera para dar tiempo al backend de generar el registro de notificación
        setTimeout(() => this.refreshNotifications(), 1500);
      }
    });

    // 🔔 Suscribirse a nuevas notificaciones recibidas en primer plano
    this.notificationSub = this.notificationService.notificationReceived$.subscribe(() => {
      this.refreshNotifications();
    });

    this.newsService.getActiveNews().then(items => this.news.set(items)).catch(() => {});
    
    // Cargar historial de notificaciones inicial
    this.refreshNotifications();
  }

  refreshNotifications() {
    // notification history is reactive via notificationService.history signal
  }

  openInstallDialog() {
    this.pwaService.openInstallDialog();
  }

  async reload() {
    const currentUrl = this.router.url;
    await this.router.navigateByUrl('/', { skipLocationChange: true });
    await this.router.navigate([currentUrl]);
  }

  toggleNotifications() {
    this.showNotifications.set(!this.showNotifications());
  }

  ngOnDestroy() {
    this.authSub?.unsubscribe();
    this.bookingSub?.unsubscribe();
    this.notificationSub?.unsubscribe();
  }

  get displayName() {
    const profile = this.userProfile();
    return profile?.full_name ? profile.full_name.split(' ')[0] : 'Usuaria';
  }

  // ── Build 7-day strip starting today ────────────────────────────────
  private async buildWeekDays(userId: string) {
    const bookingDates = await this.bookingService.getUserBookingDates(userId);
    const dateSet = new Set(bookingDates);

    const DAY_LABELS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
    const today = new Date();
    const todayIso = getTodayLocalYYYYMMDD();

    const slots: DaySlot[] = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const iso = formatDateToLocalYYYYMMDD(d);
      return {
        date: d,
        label: DAY_LABELS[d.getDay()],
        num: d.getDate(),
        iso,
        hasBooking: dateSet.has(iso),
        isToday: iso === todayIso
      };
    });

    this.days.set(slots);

    // Select today by default
    const todaySlot = slots.find(s => s.isToday) ?? slots[0];
    await this.selectDay(todaySlot);
  }

  async selectDay(day: DaySlot) {
    this.selectedDay.set(day);
    const uid = this.userId();
    if (!uid) return;

    this.loadingBookings.set(true);
    try {
      const raw = await this.bookingService.getUserBookingsForDate(uid, day.iso);
      this.dayBookings.set(raw.map(b => ({
        id: b.id,
        name: b.class_name ?? 'CLASE',
        coach: b.coach_name ?? '—',
        bed: b.bed_numbers?.join(', ') ?? '—',
        time: this.formatTime(b.session_time),
        date: b.session_date,
        credits_used: b.credits_used || 0,
        canCancel: this.bookingService.canCancelBooking(b.session_date, b.session_time)
      })));
    } finally {
      this.loadingBookings.set(false);
    }
  }

  async onCancelClass(booking: BookingCard) {
    if (!booking.canCancel || this.cancellingId()) return;
    this.cancellingId.set(booking.id);
    try {
      const uid = this.userId();
      if (uid) {
        // 1. Cancelar notificaciones programadas
        await this.notificationService.cancelBookingNotifications(booking.id).catch(err => 
          console.warn('Error cancelando notificaciones:', err)
        );

        // 2. Ejecutar cancelación en base de datos
        const result = await this.bookingService.cancelBookingWithRefund(booking.id, uid);
        
        if (result.success) {
          // ✅ MOSTRAR NOTIFICACIÓN DE ÉXITO (COLOR VERDE)
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Reserva cancelada y créditos devueltos'
          });

          // 3. Reembolsar créditos en lotes
          await this.paymentService.refundCreditsForBooking(uid, booking.id, booking.credits_used);
          
          // 4. Refrescar señales globales de créditos
          await this.creditsService.refreshCredits();

          // 5. Refrescar lotes locales para actualización en tiempo real
          await new Promise(resolve => setTimeout(resolve, 500));
          await this.loadCredits();

          // 6. Refrescar vista local
          const day = this.selectedDay();
          if (day) await this.selectDay(day);
          await this.buildWeekDays(uid);
        } else {
          // ❌ MOSTRAR NOTIFICACIÓN DE ERROR (COLOR ROJO)
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: result.error || 'No se pudo cancelar la reserva'
          });
        }
      }
    } catch (error) {
      console.error('Error durante la cancelación:', error);
    } finally {
      this.cancellingId.set(null);
    }
  }

  private formatTime(t: string): string {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  daysUntil(dateStr: string): number {
    const diff = new Date(dateStr).getTime() - Date.now();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  batchLabel(batch: ICreditBatch): string {
    return batch.package?.title ?? 'Paquete';
  }

  batchExpiry(batch: ICreditBatch): string {
    if (!batch.expiration_date) return 'Sin vencimiento';
    const d = new Date(batch.expiration_date);
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async loadCredits() {
    const uid = this.userId();
    if (!uid) return;
    
    this.loadingBatches.set(true);
    try {
      const batches = await this.purchasesService.loadUserCreditBatches(uid);
      this.creditBatches.set(batches);
    } finally {
      this.loadingBatches.set(false);
    }
  }

  async toggleCredits() {
    this.creditsOpen.set(!this.creditsOpen());
    if (this.creditsOpen() && this.creditBatches().length === 0) {
      await this.loadCredits();
    }
  }

  openBookingDialog() {
    this.bookingUiService.openBookingDialog();
  }

  openPackagesModal() {
    this.packagesUiService.openPackagesModal();
  }

  openGiftcardDialog() {
    this.giftcardUiService.openGiftcardDialog();
  }

  onActionClick(action: any) {
    if (action.id === 'reservar') {
      this.openBookingDialog();
      return;
    }
    if (action.id === 'comprar') {
      this.openPackagesModal();
      return;
    }
    if (action.route) this.router.navigate([action.route]);
  }
}
