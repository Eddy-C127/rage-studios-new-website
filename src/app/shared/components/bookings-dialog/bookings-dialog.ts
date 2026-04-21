import { Component, model, signal, inject, OnInit, OnDestroy, ViewChild, ElementRef, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { Tooltip } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';
import { BookingService } from '../../../core/services/booking.service';
import { SupabaseService } from '../../../core/services/supabase-service';
import { PaymentService } from '../../../core/services/payment.service';
import { CreditsService } from '../../../core/services/credits.service';
import { NotificationService } from '../../../core/services/notification.service';
import { formatDateForDisplay, formatDateToLocalYYYYMMDD } from '../../../core/functions/date-utils';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-bookings-dialog',
  imports: [
    FormsModule,
    DatePipe,
    DialogModule,
    DatePickerModule,
    ButtonModule,
    SkeletonModule,
    TagModule,
    ToastModule,
    ConfirmDialogModule,
    Tooltip
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './bookings-dialog.html',
  styleUrl: './bookings-dialog.scss'
})
export class BookingsDialog implements OnInit, OnDestroy {
  visible = model<boolean>(false);

  @ViewChild('datePicker') datePicker!: ElementRef;

  private bookingService = inject(BookingService);
  private supabaseService = inject(SupabaseService);
  private paymentService = inject(PaymentService);
  private creditsService = inject(CreditsService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private notificationService = inject(NotificationService);

  selectedDate = signal<Date>(new Date());
  bookingsForDate = signal<any[]>([]);
  bookingDates = signal<string[]>([]);
  isLoading = signal(true);
  minDate = new Date();

  private authSubscription?: Subscription;
  private currentUserId: string | null = null;

  constructor() {
    // Removido el effect problemático que causa bucle infinito
  }

  async ngOnInit() {
    // Solo obtener usuario una vez, no suscribirse
    this.authSubscription = this.supabaseService.currentUser$.subscribe(user => {
      this.currentUserId = user?.id || null;
    });
  }

  ngOnDestroy() {
    this.authSubscription?.unsubscribe();
  }

  async initializeDialogData() {
    if (!this.currentUserId) {
      return;
    }

    await this.loadBookingDates();
    // Auto-cargar reservas del día actual
    await this.loadBookingsForToday();
  }

  // Método público para inicializar desde el componente padre
  public async openDialog() {
    this.visible.set(true);
    
    // Asegurar que tenemos el ID del usuario antes de cargar datos
    const user = this.supabaseService.getUser();
    if (user) {
      this.currentUserId = user.id;
    }

    // Esperar un tick para que el dialog se abra y el datepicker se renderice
    setTimeout(() => {
      this.initializeDialogData();
    }, 150);
  }

  async loadBookingDates() {
    if (!this.currentUserId) {
      console.warn('⚠️ [Bookings Dialog] No User ID available for loadBookingDates');
      this.bookingDates.set([]);
      return;
    }

    try {
      const dates = await this.bookingService.getUserBookingDates(this.currentUserId);
      console.log('✅ [Bookings Dialog] Unique booking dates loaded:', dates);
      this.bookingDates.set(dates);
    } catch (error) {
      console.error('❌ Error loading booking dates:', error);
      this.bookingDates.set([]);
    }
  }

  async loadBookingsForToday() {
    const today = new Date();
    this.selectedDate.set(today);
    // Cargar reservas del día actual inmediatamente
    await this.loadBookingsForDate(today);
  }

  async onDateSelect(date: Date) {
    this.selectedDate.set(date);
    await this.loadBookingsForDate(date);
  }

  async loadBookingsForDate(date: Date) {
    this.isLoading.set(true);

    // ✅ FIX: Use local timezone conversion to prevent date shift bug
    // BEFORE: date.toISOString().split('T')[0] - WRONG, converts to UTC causing date shift
    // AFTER: formatDateToLocalYYYYMMDD(date) - CORRECT, preserves local date
    const dateStr = formatDateToLocalYYYYMMDD(date);

    console.log('📅 [Bookings Dialog] Loading bookings for local date:', dateStr, 'from Date object:', date);

    if (!this.currentUserId) {
      this.isLoading.set(false);
      this.bookingsForDate.set([]);
      return;
    }

    try {
      const bookings = await this.bookingService.getUserBookingsForDate(this.currentUserId, dateStr);

      console.log(`📊 [Bookings Dialog] Found ${bookings.length} booking(s) for date ${dateStr}`);

      // Formatear bookings
      const formattedBookings = bookings.map(booking => ({
        ...booking,
        formattedDate: formatDateForDisplay(booking.session_date),
        formattedTime: booking.session_time.substring(0, 5),
        statusLabel: booking.status === 'active' ? 'Activa' : 'Cancelada',
        statusSeverity: booking.status === 'active' ? 'success' : 'danger',
        canCancel: booking.status === 'active' ? this.bookingService.canCancelBooking(booking.session_date, booking.session_time) : false
      }));

      this.bookingsForDate.set(formattedBookings);
    } catch (error) {
      console.error('Error loading bookings for date:', error);
      this.bookingsForDate.set([]);
    } finally {
      this.isLoading.set(false);
    }
  }

  closeDialog() {
    this.visible.set(false);
  }

  confirmCancelBooking(booking: any) {
    this.confirmationService.confirm({
      message: `¿Estás seguro de cancelar tu reserva del ${booking.formattedDate} a las ${booking.formattedTime}?`,
      header: 'Confirmar Cancelación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, cancelar',
      rejectLabel: 'No',
      accept: () => this.cancelBooking(booking)
    });
  }

  async cancelBooking(booking: any) {
    const user = this.supabaseService.getUser();
    if (!user) return;

    try {
      // 🚫 1. Cancelar notificaciones programadas ANTES de cancelar reserva
      console.log('🔔 Cancelando notificaciones programadas para reserva:', booking.id);
      await this.notificationService.cancelBookingNotifications(booking.id);

    } catch (notificationError) {
      console.warn('⚠️ Error cancelando notificaciones programadas:', notificationError);
      // No bloquear el flujo principal por errores de notificaciones
    }

    const result = await this.bookingService.cancelBookingWithRefund(booking.id, user.id);

    if (result.success) {
      // Devolver créditos
      await this.paymentService.refundCreditsForBooking(
        user.id,
        booking.id,
        booking.credits_used
      );

      // Refrescar créditos
      await this.creditsService.refreshCredits();

      // 🔔 2. Programar notificación de confirmación de cancelación
      try {
        console.log('🔔 Programando notificación de cancelación exitosa');

        const cancellationBookingData = {
          id: booking.id,
          class_name: booking.coach_name ? `clase con ${booking.coach_name}` : 'tu clase',
          session_date: new Date(booking.session_date).toLocaleDateString('es-MX', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          }),
          session_time: booking.session_time,
          user: { full_name: user.user_metadata?.['full_name'] || user.email }
        };

        // Crear notificación inmediata de cancelación exitosa
        const scheduleData = {
          booking_id: booking.id,
          user_id: user.id,
          notification_type: 'cancellation_user' as const,
          scheduled_for: new Date().toISOString(),
          status: 'scheduled' as const,
          priority: 4,
          message_payload: await this.buildCancellationPayload(cancellationBookingData),
          delivery_channels: ['push'],
          expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2h expiry
          session_data: {
            originalBookingId: booking.id,
            cancellationType: 'user_self_cancellation',
            refundAmount: booking.credits_used
          }
        };

        // Programar la notificación usando Supabase directamente
        const { error } = await this.supabaseService.client
          .from('notification_schedules')
          .insert([scheduleData]);

        if (error) {
          console.error('❌ Error programando notificación de cancelación:', error);
        } else {
          console.log('✅ Notificación de cancelación programada exitosamente');
        }

      } catch (notificationError) {
        console.warn('⚠️ Error programando notificación de cancelación:', notificationError);
        // No bloquear el flujo - la cancelación ya fue exitosa
      }

      this.messageService.add({
        severity: 'success',
        summary: 'Éxito',
        detail: 'Reserva cancelada y créditos devueltos'
      });

      // Recargar bookings y fechas
      await this.loadBookingDates();
      await this.loadBookingsForDate(this.selectedDate());
    } else {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: result.error || 'No se pudo cancelar la reserva'
      });
    }
  }

  private async buildCancellationPayload(bookingData: any): Promise<any> {
    try {
      // Variables para el template de cancelación de usuario
      const variables = {
        user_name: bookingData.user?.full_name || 'Usuario',
        class_name: bookingData.class_name,
        session_date: bookingData.session_date,
        refund_info: `Se han devuelto tus créditos automáticamente.`
      };

      console.log('🏗️ Procesando template de cancelación con variables:', variables);

      // Usar el template processor de Supabase
      const { data, error } = await this.supabaseService.client
        .rpc('process_notification_template', {
          p_template_key: 'cancellation_user_es',
          p_language_code: 'es-MX',
          p_variables: variables
        });

      if (error) {
        console.error('❌ Error procesando template de cancelación:', error);
        // Fallback payload
        return {
          title: 'Reserva cancelada ✅',
          body: `Tu reserva para ${bookingData.class_name} del ${bookingData.session_date} ha sido cancelada exitosamente.`,
          icon: '/icons/icon-192x192.png',
          badge: '/icons/badge-72x72.png',
          data: {
            bookingId: bookingData.id,
            type: 'cancellation_user',
            actionUrl: '/account/bookings',
            timestamp: new Date().toISOString()
          }
        };
      }

      return {
        title: data.title,
        body: data.body,
        icon: '/icons/icon-192x192.png',
        badge: '/icons/badge-72x72.png',
        data: {
          bookingId: bookingData.id,
          type: 'cancellation_user',
          actionUrl: data.action_url || '/account/bookings',
          timestamp: new Date().toISOString()
        },
        actions: data.action_text ? [{
          action: 'view',
          title: data.action_text
        }] : undefined
      };

    } catch (error) {
      console.error('❌ Error en buildCancellationPayload:', error);

      // Fallback básico
      return {
        title: 'Reserva cancelada ✅',
        body: 'Tu reserva ha sido cancelada exitosamente.',
        icon: '/icons/icon-192x192.png',
        badge: '/icons/badge-72x72.png',
        data: {
          bookingId: bookingData.id,
          type: 'cancellation_user',
          actionUrl: '/account/bookings',
          timestamp: new Date().toISOString(),
          fallback: true
        }
      };
    }
  }

  // Función para verificar si una fecha tiene reservas
  hasBookingOnDate(date: any): boolean {
    if (!date || date.year == null || date.month == null || date.day == null) {
      return false;
    }

    const year = date.year;
    const month = (date.month + 1).toString().padStart(2, '0');
    const day = date.day.toString().padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const hasBooking = this.bookingDates().includes(dateStr);
    
    // Log para debug interno si es necesario (puedes borrarlo después)
    if (hasBooking) {
      console.log(`✨ [Bookings Dialog] Encontrada reserva para: ${dateStr}`);
    }

    return hasBooking;
  }
}
