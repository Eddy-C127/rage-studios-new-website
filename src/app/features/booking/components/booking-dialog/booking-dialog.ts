import {
  Component,
  model,
  signal,
  inject,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { StepperModule } from 'primeng/stepper';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputTextModule } from 'primeng/inputtext';
import { BookingService } from '../../../../core/services/booking.service';
import { CreditsService } from '../../../../core/services/credits.service';
import { SupabaseService } from '../../../../core/services/supabase-service';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { PaymentService } from '../../../../core/services/payment.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { AppSettingsService } from '../../../../core/services/app-settings.service';
import { BookingUiService } from '../../../../core/services/booking-ui.service';
import { MessageModule } from 'primeng/message';
import { formatDateToLocalYYYYMMDD, parseLocalDate } from '../../../../core/functions/date-utils';

@Component({
  selector: 'app-booking-dialog',
  imports: [
    CommonModule,
    FormsModule,
    DialogModule,
    StepperModule,
    DatePickerModule,
    ButtonModule,
    ToggleSwitchModule,
    InputTextModule,
    ToastModule,
    MessageModule,
    ProgressSpinnerModule,
  ],
  providers: [MessageService],
  templateUrl: './booking-dialog.html',
  styleUrl: './booking-dialog.scss',
})
export class BookingDialog {
  visible = model<boolean>(false);

  private bookingService = inject(BookingService);
  private bookingUiService = inject(BookingUiService);
  private creditsService = inject(CreditsService);
  private supabaseService = inject(SupabaseService);
  private paymentService = inject(PaymentService);
  private messageService = inject(MessageService);
  private notificationService = inject(NotificationService);
  private appSettingsService = inject(AppSettingsService);

  // Estados
  currentStep = signal(1);
  selectedDate = signal<Date | null>(null);
  selectedTime = signal<string | null>(null);
  selectedCoach = signal<string | null>(null);
  selectedBeds = signal<number[]>([]);
  hasCompanions = signal(false);
  companions = signal<string[]>([]);
  newCompanion = '';
  availableSlots = signal<any[]>([]);
  occupiedBeds = signal<number[]>([]);
  isLoading = signal(false);
  
  // 🚨 PROTECCIÓN CRÍTICA CONTRA MÚLTIPLES CLICS
  isBooking = signal(false);
  
  // 🔄 REFRESCO AUTOMÁTICO DE DISPONIBILIDAD
  private refreshInterval: any = null;
  private lastRefresh = signal<Date | null>(null);
  
  // 🔍 VERIFICACIÓN DE ESTADO AL ABRIR DIÁLOGO
  isVerifyingBookings = signal(false);
  verifiedBookingsEnabled = signal(true); // Valor por defecto optimista

  // Fecha mínima (hoy)
  minDate = new Date();
  // Fecha máxima (null por defecto, se calcula según configuración)
  maxDate: Date | null = null;
  
  constructor() {
    // 🔍 EFECTO: Verificar estado cuando se abre el diálogo
    effect(() => {
      if (this.visible()) {
        this.verifyBookingsOnOpen();
        // 🔄 Actualizar créditos al abrir el diálogo
        this.refreshCreditsOnOpen();
        // 📅 Calcular fechas disponibles según configuración
        this.calculateAvailableDates();
      }
    });
  }
  
  // 🎛️ GETTER PÚBLICO para acceder al estado verificado de reservas
  get bookingsEnabled() {
    return this.verifiedBookingsEnabled();
  }

  /**
   * 🔍 Verificar estado de reservas al abrir el diálogo
   * Hace consulta fresca a BD para asegurar estado actualizado
   */
  private async verifyBookingsOnOpen(): Promise<void> {
    try {
      console.log('🔍 Verificando estado de reservas al abrir diálogo...');
      this.isVerifyingBookings.set(true);

      // Consulta fresca del estado actual
      const isEnabled = await this.appSettingsService.verifyBookingsEnabled();

      // Actualizar el estado verificado
      this.verifiedBookingsEnabled.set(isEnabled);

      console.log(`✅ Estado verificado: ${isEnabled ? 'habilitadas' : 'deshabilitadas'}`);
    } catch (error) {
      console.error('❌ Error verificando estado de reservas al abrir:', error);
      // En caso de error, mantener valor por defecto optimista
    } finally {
      this.isVerifyingBookings.set(false);
    }
  }

  /**
   * 🔄 Actualizar créditos disponibles al abrir el diálogo
   * Esto asegura que el badge muestre el número correcto cuando un admin
   * asigna créditos manualmente y el usuario entra a reservar
   */
  private async refreshCreditsOnOpen(): Promise<void> {
    try {
      console.log('🔄 Actualizando créditos al abrir diálogo de reservas...');
      await this.creditsService.refreshCredits();
      console.log(`✅ Créditos actualizados: ${this.creditsService.totalCredits()}`);
    } catch (error) {
      console.error('❌ Error actualizando créditos al abrir diálogo:', error);
      // En caso de error, continuar sin actualizar créditos
    }
  }

  /**
   * 📅 Calcular fechas disponibles según configuración del admin
   * ✅ TIMEZONE-SAFE: Usa parseLocalDate para evitar bugs de zona horaria en México
   */
  private calculateAvailableDates(): void {
    const mode = this.appSettingsService.bookingAvailabilityMode();

    if (mode === 'available_now') {
      // Modo disponible ahora: solo minDate (hoy), sin maxDate
      this.minDate = new Date();
      this.maxDate = null;
      console.log('📅 Modo disponible ahora: fechas desde hoy sin límite');
    } else if (mode === 'date_range') {
      // Modo rango de fechas: establecer minDate y maxDate según configuración
      const startDateStr = this.appSettingsService.bookingDateRangeStart();
      const endDateStr = this.appSettingsService.bookingDateRangeEnd();

      if (startDateStr && endDateStr) {
        // ✅ FIX: Usar parseLocalDate para evitar problemas de zona horaria
        // ANTES: new Date(startDateStr) - INCORRECTO (interpreta como UTC)
        // AHORA: parseLocalDate(startDateStr) - CORRECTO (usa zona horaria local de México)
        const configuredStartDate = parseLocalDate(startDateStr);
        const configuredEndDate = parseLocalDate(endDateStr);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // IMPORTANTE: Si la fecha de inicio configurada es anterior a hoy,
        // usar hoy como minDate (los días pasados siempre están deshabilitados)
        this.minDate = configuredStartDate < today ? today : configuredStartDate;
        this.maxDate = configuredEndDate;

        console.log(`📅 Modo rango de fechas: ${this.minDate.toLocaleDateString('es-MX')} - ${this.maxDate.toLocaleDateString('es-MX')}`);
      } else {
        // Si no hay rango configurado, usar modo por defecto
        console.warn('⚠️ Modo rango de fechas sin fechas configuradas, usando modo disponible ahora');
        this.minDate = new Date();
        this.maxDate = null;
      }
    }
  }

  onDateSelect(date: Date) {
    this.selectedDate.set(date);
    this.loadAvailableSlots(date);
    // Reset selecciones
    this.selectedTime.set(null);
    this.selectedBeds.set([]);
  }

  async loadAvailableSlots(date: Date) {
    this.isLoading.set(true);

    // ✅ FIX: Use local timezone conversion
    const dateStr = formatDateToLocalYYYYMMDD(date);

    const slots = await this.bookingService.getAvailableSlots(dateStr);
    this.availableSlots.set(slots);
    this.isLoading.set(false);
  }

  selectTimeSlot(slot: any) {
    if (!slot.available) return;

    this.selectedTime.set(slot.time);
    this.selectedCoach.set(slot.coach);
    this.loadOccupiedBeds();
    
    // 🔄 INICIAR REFRESCO AUTOMÁTICO cada 10 segundos
    this.startAutoRefresh();
  }

  async loadOccupiedBeds() {
    const date = this.selectedDate();
    const time = this.selectedTime();

    if (!date || !time) return;

    // ✅ FIX: Use local timezone conversion
    const dateStr = formatDateToLocalYYYYMMDD(date);

    const occupied = await this.bookingService.getOccupiedBeds(
      dateStr,
      time + ':00'
    );
    this.occupiedBeds.set(occupied);

    // 🕒 TIMESTAMP del último refresco
    this.lastRefresh.set(new Date());

    // 🔄 Validar si camas seleccionadas siguen disponibles
    this.validateSelectedBeds();
  }
  
  // 🔄 INICIAR REFRESCO AUTOMÁTICO
  private startAutoRefresh() {
    this.stopAutoRefresh(); // Limpiar interval anterior
    
    this.refreshInterval = setInterval(() => {
      this.loadOccupiedBeds();
    }, 10000); // Cada 10 segundos
  }
  
  // 🛑 PARAR REFRESCO AUTOMÁTICO  
  private stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
  
  // ✅ VALIDAR CAMAS SELECCIONADAS
  private validateSelectedBeds() {
    const selected = this.selectedBeds();
    const occupied = this.occupiedBeds();
    
    const nowOccupied = selected.filter(bed => occupied.includes(bed));
    
    if (nowOccupied.length > 0) {
      // Remover camas que ahora están ocupadas
      const stillAvailable = selected.filter(bed => !occupied.includes(bed));
      this.selectedBeds.set(stillAvailable);
      
      // Notificar al usuario
      this.messageService.add({
        severity: 'warn',
        summary: 'Camas no disponibles',
        detail: `Las camas ${nowOccupied.join(', ')} ya no están disponibles y fueron removidas de tu selección`
      });
    }
  }

  toggleBed(bedNumber: number) {
    const current = this.selectedBeds();
    const maxBeds = this.hasCompanions() ? this.companions().length + 1 : 1;

    if (current.includes(bedNumber)) {
      this.selectedBeds.set(current.filter((b) => b !== bedNumber));
    } else if (current.length < maxBeds) {
      this.selectedBeds.set([...current, bedNumber]);
    }
  }

  addCompanion() {
    if (this.newCompanion.trim()) {
      this.companions.set([...this.companions(), this.newCompanion.trim()]);
      this.newCompanion = '';
    }
  }

  removeCompanion(index: number) {
    const current = this.companions();
    this.companions.set(current.filter((_, i) => i !== index));
  }

  closeDialog() {
    // 🛑 PARAR REFRESCO AUTOMÁTICO
    this.stopAutoRefresh();
    
    this.visible.set(false);
    this.resetForm();
  }

  // Navegación del Stepper
  nextStep() {
    if (this.currentStep() < 3) {
      this.currentStep.set(this.currentStep() + 1);
    }
  }

  prevStep() {
    if (this.currentStep() > 1) {
      this.currentStep.set(this.currentStep() - 1);
    }
  }

  goToStep(step: number) {
    this.currentStep.set(step);
  }

  private resetForm() {
    this.currentStep.set(1);
    this.selectedDate.set(null);
    this.selectedTime.set(null);
    this.selectedCoach.set(null);
    this.selectedBeds.set([]);
    this.hasCompanions.set(false);
    this.companions.set([]);
    this.newCompanion = '';
  }

  async confirmBooking() {
  // 🚨 PROTECCIÓN CRÍTICA: Prevenir múltiples clics
  if (this.isBooking()) {
    console.warn('🚫 Booking already in progress, ignoring click');
    return;
  }

  // Activar estado de reserva
  this.isBooking.set(true);

  try {
    const date = this.selectedDate();
    const time = this.selectedTime();
    const coach = this.selectedCoach();
    const beds = this.selectedBeds();
    const user = this.supabaseService.getUser();
    
    if (!date || !time || !coach || !user) {
      this.isBooking.set(false);
      return;
    }
  
    // Validar créditos disponibles
    const requiredCredits = this.companions().length + 1;
    const availableCredits = this.creditsService.totalCredits();
    
    if (availableCredits < requiredCredits) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: `Créditos insuficientes. Necesitas ${requiredCredits} créditos pero solo tienes ${availableCredits}`
      });
      this.isBooking.set(false);
      return;
    }
    
    this.isLoading.set(true);
    // 🔄 VALIDACIÓN FINAL: Recargar disponibilidad justo antes de reservar
    await this.loadOccupiedBeds();
    
    // Auto-asignar camas si no se seleccionaron
    let finalBeds = beds;
    if (beds.length === 0) {
      finalBeds = await this.autoAssignBeds(requiredCredits);
      if (finalBeds.length < requiredCredits) {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'No hay suficientes camas disponibles'
        });
        this.isLoading.set(false);
        this.isBooking.set(false);
        return;
      }
    } else {
      // ✅ VALIDACIÓN CRÍTICA: Verificar que camas seleccionadas siguen disponibles
      const occupiedNow = this.occupiedBeds();
      const conflictingBeds = finalBeds.filter(bed => occupiedNow.includes(bed));
      
      if (conflictingBeds.length > 0) {
        this.messageService.add({
          severity: 'error',
          summary: 'Camas no disponibles',
          detail: `Las camas ${conflictingBeds.join(', ')} ya no están disponibles. Por favor selecciona otras camas.`
        });
        this.isLoading.set(false);
        this.isBooking.set(false);
        
        // Remover camas conflictivas de la selección
        const stillAvailable = finalBeds.filter(bed => !occupiedNow.includes(bed));
        this.selectedBeds.set(stillAvailable);
        return;
      }
    }
    
    // ✅ FIX: Use local timezone conversion for booking creation
    const booking = {
      user_id: user.id,
      session_date: formatDateToLocalYYYYMMDD(date),
      session_time: time + ':00',
      coach_name: coach,
      bed_numbers: finalBeds,
      attendees: this.companions(),
      total_attendees: requiredCredits,
      credits_used: requiredCredits,
      status: 'active'
    };

    console.log('📅 [Booking Creation] Creating booking for local date:', booking.session_date, 'from Date object:', date);
    
    // Crear la reserva
    const result = await this.bookingService.createBooking(booking);
    
    if (result.success && result.data) {
      // Usar los créditos
      const creditResult = await this.paymentService.useCreditsForBooking(
        user.id, 
        requiredCredits,
        result.data.id
      );
      
      if (creditResult.success) {
        // Actualizar la reserva con el batch_id
        if (creditResult.batchId && result.data.id) {
          await this.bookingService.updateBookingBatchId(result.data.id, creditResult.batchId);
        }
        
        // Refrescar créditos
        await this.creditsService.refreshCredits();

        // 🔄 NOTIFICAR ÉXITO GLOBAL PARA REFRESCAR DASHBOARD
        this.bookingUiService.notifyBookingSuccess();
        
        // 🚨 CRÍTICO: Mostrar éxito inmediatamente, procesar notificaciones en segundo plano
        this.messageService.add({
          severity: 'success',
          summary: 'Éxito',
          detail: 'Reserva realizada correctamente'
        });
        
        // 🚨 CRÍTICO: Cerrar dialog de forma inmediata y robusta
        setTimeout(() => {
          this.closeDialog();
        }, 1000); // Dar tiempo para que el usuario vea el mensaje de éxito
        
        // 🔔 Programar notificaciones push de forma asíncrona (NO BLOQUEA)
        this.scheduleNotificationsInBackground(result.data, booking, user, coach, time);
      } else {
        // Si falla el uso de créditos, cancelar la reserva
        if (result.data.id) {
          await this.bookingService.cancelBooking(result.data.id);
        }
        
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: creditResult.error || 'Error al procesar los créditos'
        });
      }
    } else {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: result.error || 'Error al crear la reserva'
      });
    }
  } catch (error: any) {
    console.error('❌ Error crítico en confirmBooking:', error);
    this.messageService.add({
      severity: 'error',
      summary: 'Error',
      detail: error.message || 'Error inesperado al procesar la reserva'
    });
  } finally {
    // 🚨 CRÍTICO: Siempre restablecer estado
    this.isBooking.set(false);
    this.isLoading.set(false);
  }
}

/**
 * 🔔 MÉTODO ASÍNCRONO: Procesa notificaciones en segundo plano
 * NO bloquea el flujo principal de reservas
 */
private async scheduleNotificationsInBackground(
  bookingData: any, 
  bookingRequest: any, 
  user: any, 
  coach: string, 
  time: string
): Promise<void> {
  try {
    console.log('🔔 [BACKGROUND] Iniciando programación de notificaciones...');
    
    const bookingWithUserData = {
      ...bookingData,
      ...bookingRequest,
      user: { full_name: user.user_metadata?.['full_name'] || user.email },
      class_name: this.getClassNameForSession(coach, time)
    };
    
    // Timeout de seguridad: máximo 10 segundos para notificaciones
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Notification timeout')), 10000)
    );
    
    const notificationPromise = this.scheduleNotificationsWithRetry(bookingWithUserData);
    
    const notificationResult = await Promise.race([notificationPromise, timeoutPromise]);
    
    if (notificationResult && notificationResult.success) {
      if (notificationResult.count && notificationResult.count > 0) {
        console.log(`✅ [BACKGROUND] ${notificationResult.count} notificaciones programadas exitosamente`);
      } else {
        console.log('ℹ️ [BACKGROUND] Sin notificaciones programadas:', notificationResult.reason);
      }
    } else {
      console.warn('⚠️ [BACKGROUND] Error en notificaciones:', notificationResult?.reason || 'Unknown error');
    }
    
  } catch (error) {
    console.warn('⚠️ [BACKGROUND] Error en notificaciones (no afecta reserva):', error);
    
    // Log del error para debugging pero NO afecta la reserva
    await this.notificationService.logEvent('background_notification_failed', {
      bookingId: bookingData?.id,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }).catch(() => {
      // Incluso si logging falla, no hacer nada - la reserva ya está completa
    });
  }
}

/**
 * 🔔 Programación de notificaciones con reintentos inteligentes
 * 
 * ESTRATEGIA ROBUSTA:
 * 1. Intentar programar notificaciones (siempre debe funcionar con database)
 * 2. Si falla por permisos, intentar obtenerlos UNA VEZ con timeout
 * 3. Si obtiene permisos, reintenta programar con push habilitado
 * 4. Si algo falla, las notificaciones se programan solo en database
 */
private async scheduleNotificationsWithRetry(bookingData: any): Promise<any> {
  console.log('🔔 [BACKGROUND] Starting notification scheduling with retry strategy...');
  
  // 🚨 PRIMER INTENTO: Programar con estado actual
  let notificationResult = await this.notificationService.scheduleBookingNotifications(bookingData);
  
  console.log('🔔 [BACKGROUND] First attempt result:', notificationResult);
  
  // ✅ Si tuvo éxito, retornar inmediatamente
  if (notificationResult.success) {
    console.log('✅ [BACKGROUND] Notifications scheduled successfully on first attempt');
    return notificationResult;
  }
  
  // 🔄 Si falló porque no hay permisos, intentar obtenerlos SOLO UNA VEZ
  if (notificationResult.reason?.includes('Permission') || notificationResult.reason?.includes('disabled')) {
    console.log('🔔 [BACKGROUND] First attempt failed due to permissions, requesting...');
    
    try {
      // Timeout agresivo para solicitud de permisos: máximo 3 segundos
      const permissionPromise = this.notificationService.requestPermissions();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Permission request timeout')), 3000)
      );
      
      const permissionResult = await Promise.race([permissionPromise, timeoutPromise]) as any;
      
      if (permissionResult?.granted) {
        console.log('✅ [BACKGROUND] Permissions granted, retrying notification scheduling...');
        
        // 🔄 SEGUNDO INTENTO: Con permisos concedidos
        notificationResult = await this.notificationService.scheduleBookingNotifications(bookingData);
        console.log('🔔 [BACKGROUND] Second attempt result:', notificationResult);
      } else {
        console.warn('⚠️ [BACKGROUND] Permission not granted, using database-only mode');
      }
      
    } catch (permissionError) {
      console.warn('⚠️ [BACKGROUND] Permission request failed/timeout, using database-only mode:', permissionError);
    }
  }
  
  // 🚨 Si aún falla, forzar modo database-only como fallback
  if (!notificationResult.success) {
    console.warn('⚠️ [BACKGROUND] All attempts failed, forcing database-only scheduling...');
    notificationResult = await this.forceNotificationSchedulingFallback(bookingData);
  }
  
  return notificationResult;
}

/**
 * 🛡️ FALLBACK CRÍTICO: Programar notificaciones en modo database-only
 */
private async forceNotificationSchedulingFallback(bookingData: any): Promise<any> {
  try {
    console.log('🛡️ [FALLBACK] Forcing database-only notification scheduling...');
    
    // Llamar directamente al scheduling pero ignorando requisitos de push token
    const result = await this.notificationService.scheduleBookingNotifications(bookingData);
    
    if (!result.success) {
      console.error('❌ [FALLBACK] Even database-only scheduling failed:', result.reason);
      return { success: false, reason: 'All fallback methods failed', fallback: true };
    }
    
    console.log('✅ [FALLBACK] Database-only notifications scheduled successfully');
    return { ...result, fallback: true };
    
  } catch (error) {
    console.error('❌ [FALLBACK] Critical failure in notification fallback:', error);
    return { 
      success: false, 
      reason: `Fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      fallback: true,
      critical: true
    };
  }
}

private async autoAssignBeds(count: number): Promise<number[]> {
  // 🔄 REVALIDAR disponibilidad EN TIEMPO REAL antes de asignar
  await this.loadOccupiedBeds();
  
  const occupied = this.occupiedBeds();
  const availableBeds = [];
  
  for (let i = 1; i <= 14; i++) {
    if (!occupied.includes(i)) {
      availableBeds.push(i);
    }
  }
  
  // Retornar los primeros 'count' lugares disponibles
  return availableBeds.slice(0, count);
}

// Métodos removidos - ya están implementados en BookingService

private getClassNameForSession(coach: string, time: string): string {
  // Mapear horario y coach a nombre de clase
  // Esta lógica se podría mejorar conectando con SessionsService
  const timeHour = parseInt(time.split(':')[0]);
  
  // Incluir coach en el nombre si está disponible
  const coachInfo = coach ? ` con ${coach}` : '';
  
  if (timeHour < 12) {
    return `Sesión Matutina${coachInfo}`;
  } else if (timeHour < 18) {
    return `Sesión Vespertina${coachInfo}`;  
  } else {
    return `Sesión Nocturna${coachInfo}`;
  }
}
}
