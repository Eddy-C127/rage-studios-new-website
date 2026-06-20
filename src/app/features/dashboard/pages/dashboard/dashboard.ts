import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { NgClass, DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { RouterModule } from '@angular/router';
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
import { getTodayLocalYYYYMMDD, formatDateToLocalYYYYMMDD } from '../../../../core/functions/date-utils';
import { Subscription } from 'rxjs';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import { WaitlistUiService } from '../../../../core/services/waitlist-ui.service';
import { MembershipService } from '../../../../core/services/membership.service';
import { MembershipInfoDialog } from '../../../../shared/components/membership-info-dialog/membership-info-dialog';
import { AppSettingsService } from '../../../../core/services/app-settings.service';
import { AccessPassSheet } from '../../components/access-pass-sheet/access-pass-sheet';
import { LoyaltyService, AchievementWithStatus } from '../../../../core/services/loyalty.service';

interface DaySlot {
  date: Date;
  label: string;
  num: number;
  iso: string;
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
  imports: [NgClass, DatePipe, ToastModule, DialogModule, RouterModule, MembershipInfoDialog, AccessPassSheet],
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
  private messageService = inject(MessageService);
  private waitlistUiService = inject(WaitlistUiService);
  protected membershipService = inject(MembershipService);
  private appSettingsService = inject(AppSettingsService);
  private loyaltyService = inject(LoyaltyService);

  private authSub?: Subscription;
  private bookingSub?: Subscription;
  private userId = signal<string | null>(null);

  userProfile = signal<any>(null);
  streak = signal(0);
  membership = signal('ÉLITE');
  showMembershipDialog = signal(false);
  userMembership = this.membershipService.userMembership;
  showMembershipPromo = false;

  nextBooking = signal<any | null>(null);
  markingAttendance = signal(false);
  showAccessPass = signal(false);

  readonly weekDays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  weekAttended = signal<boolean[]>([false, false, false, false, false, false, false]);

  quickActions = [
    { id: 'reservar', label: 'Reservar Clase',   icon: 'pi pi-calendar',      route: '/dashboard/reservas' },
    { id: 'espera',   label: 'Lista de Espera',   icon: 'pi pi-clock',         route: '' },
    { id: 'logros',   label: 'Mis Logros',        icon: 'pi pi-star',          route: '/dashboard/logros' },
    { id: 'comprar',  label: 'Comprar Créditos',  icon: 'pi pi-shopping-cart', route: '/checkout' }
  ];

  news = signal<NewsItem[]>([]);
  readNewsIds = signal<Set<string>>(new Set());
  selectedNews = signal<NewsItem | null>(null);
  showNewsDialog = signal<boolean>(false);

  achievements = signal<AchievementWithStatus[]>([]);
  hasClaimableReward = computed(() => this.achievements().some(a => a.claimable));

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

  days = signal<DaySlot[]>([]);
  selectedDay = signal<DaySlot | null>(null);
  dayBookings = signal<BookingCard[]>([]);
  loadingBookings = signal(false);
  cancellingId = signal<string | null>(null);

  // ── Streak Progress Analytics ──────────────────────────────────
  
  attendedDaysCount = computed(() => 
    this.weekAttended().filter(attended => attended).length
  );

  // Hitos de racha diaria (6 / 15 / 30 …) según los logros configurados
  dailyMilestones = computed(() =>
    this.achievements()
      .filter(a => a.condition_type === 'daily_streak')
      .map(a => a.condition_value)
      .sort((a, b) => a - b)
  );

  maxMilestone = computed(() => {
    const ms = this.dailyMilestones();
    return ms.length ? ms[ms.length - 1] : 0;
  });

  // Siguiente hito por alcanzar (o el máximo si ya los superó todos)
  nextMilestone = computed(() => {
    const s = this.streak();
    const ms = this.dailyMilestones();
    for (const m of ms) { if (s < m) return m; }
    return ms.length ? ms[ms.length - 1] : 6;
  });

  // ¿Ya alcanzó/superó el último hito?
  atMaxStreak = computed(() => this.maxMilestone() > 0 && this.streak() >= this.maxMilestone());

  streakProgress = computed(() => {
    const next = this.nextMilestone();
    return next ? Math.min((this.streak() / next) * 100, 100) : 0;
  });

  isRecordBroken = computed(() => this.atMaxStreak());

  streakStatusLabel = computed(() => {
    const s = this.streak();
    if (s === 0) return 'EL PRIMER PASO <b>ES HOY!</b>';
    if (this.hasClaimableReward()) return '<b>¡PREMIO LISTO!</b> RECLÁMALO';
    if (this.atMaxStreak()) return 'CONSTANCIA <b>PURA!</b>';
    const left = this.nextMilestone() - s;
    return `TE FALTA${left === 1 ? '' : 'N'} <b>${left} DÍA${left === 1 ? '' : 'S'}</b> PARA TU PREMIO`;
  });

  ngOnInit() {
    this.authSub = this.supabase.currentUser$.subscribe(async user => {
      if (user) {
        this.userId.set(user.id);
        const saved = localStorage.getItem(`read_news_${user.id}`);
        if (saved) {
          try {
            this.readNewsIds.set(new Set(JSON.parse(saved)));
          } catch (e) {
            console.warn('Could not parse read news state from localStorage', e);
          }
        }
        const profile = await this.supabase.getProfile(user.id);
        if (profile) this.userProfile.set(profile);
        await this.buildWeekDays(user.id);
        await this.loadCredits();
        await this.loadAttendanceData();
        await this.membershipService.loadUserMembership(user.id);
      }
    });

    this.bookingSub = this.bookingUiService.bookingSuccess$.subscribe(async () => {
      const uid = this.userId();
      if (uid) {
        await Promise.all([this.loadCredits(), this.buildWeekDays(uid), this.loadAttendanceData()]);
      }
    });

    this.newsService.getActiveNews().then(items => this.news.set(items)).catch(() => {});
  }

  ngOnDestroy() {
    this.authSub?.unsubscribe();
    this.bookingSub?.unsubscribe();
  }

  get displayName() {
    const profile = this.userProfile();
    return profile?.full_name ? profile.full_name.split(' ')[0] : 'Usuaria';
  }

  async refreshDashboardData() {
    const uid = this.userId();
    if (!uid) return;
    try {
      console.log('DashboardComponent: Refreshing dashboard data after check-in success');
      const profile = await this.supabase.getProfile(uid);
      if (profile) this.userProfile.set(profile);
      await Promise.all([
        this.buildWeekDays(uid),
        this.loadCredits(),
        this.loadAttendanceData(),
        this.membershipService.loadUserMembership(uid)
      ]);
    } catch (e) {
      console.error('Error refreshing dashboard data:', e);
    }
  }

  private async buildWeekDays(userId: string) {
    const bookingDates = await this.bookingService.getUserBookingDates(userId);
    const dateSet = new Set(bookingDates);
    const DAY_LABELS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
    const today = new Date();
    const todayIso = getTodayLocalYYYYMMDD();

    // 1. Obtener el modo de disponibilidad y determinar los días visibles
    const mode = this.appSettingsService.bookingAvailabilityMode();
    let displayDays = 15; // Por defecto 15 días (Opción 2)

    if (mode === 'date_range') {
      const endDateStr = this.appSettingsService.bookingDateRangeEnd();
      if (endDateStr) {
        // Parsear la fecha de finalización de la agenda como fecha local
        const [y, m, d] = endDateStr.split('-').map(Number);
        const endDate = new Date(y, m - 1, d);
        endDate.setHours(0, 0, 0, 0);

        const todayStart = new Date(today);
        todayStart.setHours(0, 0, 0, 0);

        const diffTime = endDate.getTime() - todayStart.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
        
        // Si el rango es válido, usarlo (cappeado a 30 días como máximo de seguridad)
        if (diffDays > 0) {
          displayDays = Math.min(diffDays, 30);
        }
      }
    }

    const slots: DaySlot[] = Array.from({ length: displayDays }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const iso = formatDateToLocalYYYYMMDD(d);
      return { date: d, label: DAY_LABELS[d.getDay()], num: d.getDate(), iso, hasBooking: dateSet.has(iso), isToday: iso === todayIso };
    });

    this.days.set(slots);
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
        await this.notificationService.cancelBookingNotifications(booking.id).catch(err =>
          console.warn('Error cancelando notificaciones:', err)
        );

        const result = await this.bookingService.cancelBookingWithRefund(booking.id, uid);

        if (result.success) {
          this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Reserva cancelada y créditos devueltos' });
          await this.paymentService.refundCreditsForBooking(uid, booking.id, booking.credits_used);
          await this.creditsService.refreshCredits();
          await new Promise(resolve => setTimeout(resolve, 500));
          await this.loadCredits();
          const day = this.selectedDay();
          if (day) await this.selectDay(day);
          await this.buildWeekDays(uid);
          await this.loadAttendanceData();
        } else {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: result.error || 'No se pudo cancelar la reserva' });
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

  // ── Attendance Logic ───────────────────────────────────────────

  async loadAttendanceData() {
    const uid = this.userId();
    if (!uid) return;

    try {
      // 1. Cargar la racha real (resumen del motor de fidelización) y los logros
      const summary = await this.loyaltyService.getStreakSummary(uid);
      this.streak.set(summary.daily_streak);
      this.loyaltyService.getAchievements(uid)
        .then(list => this.achievements.set(list))
        .catch(err => console.error('Error loading achievements:', err));

      // 2. Cargar la siguiente cita inminente
      const next = await this.bookingService.getNextImmediateBooking(uid);
      if (next) {
        this.nextBooking.set({
          ...next,
          timeFormatted: this.formatTime(next.session_time),
          fullDateFormatted: this.formatFullDate(next.session_date)
        });
      } else {
        this.nextBooking.set(null);
      }

      // 3. Cargar historial de la semana actual para el grid
      await this.loadWeeklyAttendance(uid);
    } catch (error) {
      console.error('Error loading attendance data:', error);
    }
  }

  private async loadWeeklyAttendance(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Obtener el Lunes de esta semana
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(today.setDate(diff));
    
    const weekData = new Array(7).fill(false);
    
    try {
      const bookings = await this.bookingService.getUserBookings(userId);
      // Solo reservas activas con asistencia confirmada (excluye canceladas)
      bookings.forEach(b => {
        if (b.status !== 'cancelled' && b.attendance_status === 'attended') {
          const bDate = new Date(b.session_date + 'T00:00:00');
          const dayDiff = Math.round((bDate.getTime() - monday.getTime()) / (1000 * 60 * 60 * 24));
          if (dayDiff >= 0 && dayDiff < 7) {
            weekData[dayDiff] = true;
          }
        }
      });
      this.weekAttended.set(weekData);
    } catch (error) {
      console.error('Error loading weekly attendance:', error);
    }
  }

  async onMarkAttendance(status: 'attended' | 'missed') {
    const booking = this.nextBooking();
    if (!booking || this.markingAttendance()) return;

    this.markingAttendance.set(true);
    try {
      const result = await this.bookingService.updateAttendance(booking.id, status);
      if (result.success) {
        const msg = status === 'attended' ? '¡Asistencia marcada! ¡Sigue así!' : 'Entendido, registraremos la inasistencia.';
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: msg });
        
        // Recargar datos para actualizar racha y ocultar módulo
        await this.loadAttendanceData();
        await this.buildWeekDays(this.userId()!);
      } else {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar la asistencia' });
      }
    } finally {
      this.markingAttendance.set(false);
    }
  }

  openBookingDialog() { this.bookingUiService.openBookingDialog(); }
  openPackagesModal() { this.packagesUiService.openPackagesModal(); }
  openGiftcardDialog() { this.giftcardUiService.openGiftcardDialog(); }
  openWaitlistDialog() { this.waitlistUiService.openWaitlistDialog(); }

  openNewsDetail(item: NewsItem) {
    this.selectedNews.set(item);
    this.showNewsDialog.set(true);

    const uid = this.userId();
    if (uid) {
      const current = new Set(this.readNewsIds());
      if (!current.has(item.id)) {
        current.add(item.id);
        this.readNewsIds.set(current);
        localStorage.setItem(`read_news_${uid}`, JSON.stringify(Array.from(current)));
      }
    }
  }

  onActionClick(action: any) {
    if (action.id === 'reservar') { this.openBookingDialog(); return; }
    if (action.id === 'comprar') { this.openPackagesModal(); return; }
    if (action.id === 'espera') { this.openWaitlistDialog(); return; }
    if (action.route) this.router.navigate([action.route]);
  }

  formatCtaUrl(url: string | undefined | null): string {
    if (!url) return '';
    const trimmed = url.trim();
    if (trimmed.startsWith('/') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    return `https://${trimmed}`;
  }

  isExternalUrl(url: string | undefined | null): boolean {
    if (!url) return false;
    const trimmed = url.trim();
    return !trimmed.startsWith('/');
  }

  private formatFullDate(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
    return new Intl.DateTimeFormat('es-MX', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long' 
    }).format(date).toUpperCase();
  }

  getUniqueBeds(schedules: any[]): string {
    if (!schedules) return '';
    const beds = new Set<number>();
    schedules.forEach(s => {
      if (s.bed_numbers) {
        s.bed_numbers.forEach((b: number) => beds.add(b));
      }
    });
    return Array.from(beds)
      .sort((a, b) => a - b)
      .map(b => b < 10 ? `0${b}` : `${b}`)
      .join(', ');
  }
}
