import { Component, inject, signal, computed, viewChild, ElementRef, AfterViewInit, OnDestroy, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { Popover } from 'primeng/popover';
import { CheckinService, ScanResult, ClassInfo, RosterEntry, ClientSearchResult } from '../../../../core/services/checkin.service';
import { BookingService } from '../../../../core/services/booking.service';

/**
 * Estación de check-in para recepción.
 *
 * - Un lector USB de QR (modo "keyboard wedge": teclea el contenido + Enter)
 *   inyecta el token en un input siempre enfocado; al recibir Enter se valida
 *   contra la RPC y se marca la asistencia.
 * - Muestra la LISTA en vivo de la clase en curso (esperados), con contador
 *   "X de Y", palomeando a cada quien al escanear. Permite marcado manual
 *   (respaldo) y cambiar de clase.
 */
@Component({
  selector: 'app-admin-checkin',
  standalone: true,
  imports: [FormsModule, DatePipe, DialogModule, ButtonModule, InputTextModule, Popover],
  templateUrl: './admin-checkin.html',
  styleUrl: './admin-checkin.scss'
})
export class AdminCheckin implements AfterViewInit, OnDestroy {
  private platformId = inject(PLATFORM_ID);
  private checkinService = inject(CheckinService);
  private bookingService = inject(BookingService);
  private router = inject(Router);

  private scanInput = viewChild<ElementRef<HTMLInputElement>>('scanInput');
  private statusMenu = viewChild<Popover>('statusMenu');

  // Persona del roster cuyo menú de estados está abierto.
  menuEntry = signal<RosterEntry | null>(null);

  // ── Escaneo ────────────────────────────────────────────────
  buffer = '';
  manualToken = '';
  processing = signal(false);
  result = signal<ScanResult | null>(null);
  successCount = signal(0);

  // ── Lista en vivo ──────────────────────────────────────────
  selectedDate = signal<string>(
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`
  );

  classes = signal<ClassInfo[]>([]);
  selectedTime = signal<string | null>(null);
  roster = signal<RosterEntry[]>([]);
  loadingRoster = signal(false);
  markingKey = signal<string | null>(null);

  expectedCount = computed(() => this.roster().length);
  checkedCount = computed(() => this.roster().filter(e => e.attended).length);
  progressPct = computed(() => {
    const total = this.expectedCount();
    return total === 0 ? 0 : Math.round((this.checkedCount() / total) * 100);
  });
  selectedClass = computed(() => this.classes().find(c => c.session_time === this.selectedTime()) ?? null);

  private resetTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private refocus = () => this.focusInput();

  ngAfterViewInit() {
    if (!isPlatformBrowser(this.platformId)) return;
    this.focusInput();
    window.addEventListener('click', this.refocus);
    this.loadAll();
    // Refresco en vivo (la clase dura ~50 min; 5s es de sobra)
    this.pollTimer = setInterval(() => this.refresh(), 5000);
  }

  ngOnDestroy() {
    if (isPlatformBrowser(this.platformId)) {
      window.removeEventListener('click', this.refocus);
    }
    if (this.resetTimer) clearTimeout(this.resetTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  focusInput() {
    if (!isPlatformBrowser(this.platformId)) return;
    // Mientras el diálogo de walk-in o el menú de estados están abiertos, NO robar
    // el foco del lector: el usuario necesita interactuar con ellos.
    if (this.showWalkinDialog() || this.menuEntry()) return;
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT' && !active.classList.contains('scan-input')) {
      return; // No interrumpir si el usuario está escribiendo en el input manual
    }
    // preventScroll evita que el navegador haga scroll al input oculto (que vive
    // arriba del componente): sin esto, cada click/marcado saltaba al inicio.
    setTimeout(() => this.scanInput()?.nativeElement?.focus({ preventScroll: true }), 0);
  }

  getTodayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  resetToToday() {
    this.changeDate(this.getTodayDateString());
  }

  async changeDate(newDate: string) {
    if (!newDate || newDate === this.selectedDate()) return;
    this.selectedDate.set(newDate);

    // Volver a cargar las clases para el nuevo día
    await this.loadClasses();
    
    // Si la hora previamente seleccionada no existe en el nuevo día, elegir la primera disponible o nula
    const times = this.classes().map(c => c.session_time);
    if (this.selectedTime() && !times.includes(this.selectedTime()!)) {
      this.selectedTime.set(null);
    }
    
    // Si no hay hora seleccionada, seleccionar la clase en curso (si la hay) o la primera clase
    if (!this.selectedTime()) {
      const current = this.classes().find(c => c.is_current) ?? this.classes()[0];
      if (current) this.selectedTime.set(current.session_time);
    }
    
    await this.loadRoster();
    this.focusInput();
  }

  // ── Carga / refresco ───────────────────────────────────────
  private async loadAll() {
    await this.loadClasses();
    if (!this.selectedTime()) {
      const current = this.classes().find(c => c.is_current) ?? this.classes()[0];
      if (current) this.selectedTime.set(current.session_time);
    }
    await this.loadRoster();
  }

  private async loadClasses() {
    try {
      this.classes.set(await this.checkinService.getTodayClasses(this.selectedDate()));
    } catch {
      // mantener lo previo en caso de fallo de red puntual
    }
  }

  private async loadRoster() {
    const time = this.selectedTime();
    if (!time) {
      this.roster.set([]);
      return;
    }
    this.loadingRoster.set(true);
    try {
      this.roster.set(await this.checkinService.getRoster(time, this.selectedDate()));
    } catch {
      // ignorar fallo puntual
    } finally {
      this.loadingRoster.set(false);
    }
  }

  private async refresh() {
    if (this.markingKey()) return; // no pisar una acción en curso
    await this.loadClasses();
    await this.loadRoster();
  }

  selectClass(time: string) {
    if (time === this.selectedTime()) return;
    this.selectedTime.set(time);
    this.loadRoster();
    this.focusInput();
  }

  // ── Escaneo ────────────────────────────────────────────────
  async onEnter() {
    const token = this.buffer.trim();
    this.buffer = '';
    console.log('AdminCheckin: Scanned code / input text entered:', token);
    if (!token) {
      console.warn('AdminCheckin: Empty token entered.');
      return;
    }
    if (this.processing()) {
      console.warn('AdminCheckin: Busy processing previous scan.');
      return;
    }

    this.processing.set(true);
    try {
      console.log('AdminCheckin: Submitting scanPass RPC with token:', token);
      const res = await this.checkinService.scanPass(token);
      console.log('AdminCheckin: Received scanPass response:', res);
      this.result.set(res);
      this.beep(res.status_code === 'OK');
      if (res.status_code === 'OK') {
        this.successCount.update(c => c + 1);
      }
      
      // Difundir resultado en tiempo real al dispositivo del cliente
      if (res.client_id) {
        console.log(`AdminCheckin: Client ID found in response: ${res.client_id}. Initiating realtime broadcast...`);
        this.checkinService.broadcastScanResult(res.client_id, res).catch(err => {
          console.warn('AdminCheckin: Error al transmitir el resultado del escaneo al cliente:', err);
        });
      } else {
        console.warn('AdminCheckin: No client_id returned from scanPass RPC, cannot broadcast.');
      }
    } catch (error) {
      console.error('AdminCheckin: Error executing scanPass RPC:', error);
      this.result.set({ status_code: 'INVALID_TOKEN', message: 'Error al procesar el QR. Intenta de nuevo.' });
      this.beep(false);
    } finally {
      this.processing.set(false);
      this.focusInput();
      this.refresh(); // palomear en vivo a quien acaba de escanear
      if (this.resetTimer) clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => this.result.set(null), 5000);
    }
  }

  async onManualSubmit() {
    if (!this.manualToken) return;
    this.buffer = this.manualToken;
    this.manualToken = '';
    await this.onEnter();
  }

  private changeTimer?: ReturnType<typeof setTimeout>;

  onBufferChange(value: string) {
    if (!value) return;
    
    const token = value.trim();
    const isHexToken = /^[0-9a-f]{56}$/i.test(token);
    const isJwtToken = token.startsWith('ey') && token.length === 152;
    
    if (isHexToken || isJwtToken) {
      console.log('AdminCheckin: Complete token format detected. Triggering INSTANT validation.');
      if (this.changeTimer) clearTimeout(this.changeTimer);
      this.onEnter();
      return;
    }

    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      if (this.buffer) {
        const trimmed = this.buffer.trim();
        if ((trimmed.length >= 50 && trimmed.startsWith('ey')) || /^[0-9a-f]{50,}$/i.test(trimmed)) {
          console.log('AdminCheckin: Auto-submitting buffer because of 150ms inactivity:', trimmed);
          this.onEnter();
        }
      }
    }, 150);
  }

  onInputFocus() {
    console.log('AdminCheckin: Hidden scan input focused successfully.');
  }

  onInputBlur() {
    console.log('AdminCheckin: Hidden scan input lost focus.');
    this.focusInput();
  }

  // ── Marcado manual ─────────────────────────────────────────
  entryKey(e: RosterEntry): string {
    return e.booking_id ?? e.membership_schedule_id ?? e.user_id ?? e.display_name;
  }

  /** Aplica un cambio de estado a una entrada del roster en memoria (optimista). */
  private patchEntry(key: string, status: RosterEntry['attendance_status']) {
    this.roster.update(list =>
      list.map(e =>
        this.entryKey(e) === key
          ? { ...e, attendance_status: status, attended: status === 'attended' }
          : e
      )
    );
  }

  /** Abre el menú de estados anclado a la fila de esa persona. */
  openStatusMenu(event: Event, entry: RosterEntry) {
    if (this.markingKey()) return;
    // Evitar que el click llegue al listener global que reenfoca el lector.
    event.stopPropagation();
    this.menuEntry.set(entry);
    this.statusMenu()?.toggle(event);
  }

  private closeStatusMenu() {
    this.statusMenu()?.hide();
    this.menuEntry.set(null);
  }

  /**
   * Fija un estado concreto a la persona del menú abierto (selección directa,
   * sin ciclar). Para socias VIP sin reserva, solo aplica 'attended' (materializa
   * la reserva); el resto de estados no tiene sobre qué actuar.
   */
  async setStatus(status: 'attended' | 'missed' | 'unattended' | 'pending') {
    const entry = this.menuEntry();
    if (!entry || this.markingKey()) return;
    const key = this.entryKey(entry);
    const prevStatus = entry.attendance_status;
    this.closeStatusMenu();

    // Sin cambios reales: no hacer round-trip.
    if (entry.kind === 'booking' && (entry.attendance_status ?? 'pending') === status) {
      this.focusInput();
      return;
    }

    this.markingKey.set(key);
    try {
      if (entry.kind === 'booking' && entry.booking_id) {
        // Feedback inmediato: refleja el nuevo estado antes del round-trip.
        this.patchEntry(key, status === 'pending' ? null : status);
        await this.checkinService.markBooking(entry.booking_id, status);
      } else if (entry.kind === 'membership' && entry.membership_schedule_id) {
        if (status !== 'attended') return; // VIP: solo "Asistió" tiene sentido
        this.patchEntry(key, 'attended');
        await this.checkinService.checkinMembership(entry.membership_schedule_id);
      }
      await this.loadClasses();
      await this.loadRoster();
    } catch {
      // revertir el optimismo; el próximo poll reconcilia de todas formas
      this.patchEntry(key, prevStatus);
    } finally {
      this.markingKey.set(null);
      this.focusInput();
    }
  }

  isOk(): boolean {
    return this.result()?.status_code === 'OK';
  }

  isNotice(): boolean {
    const code = this.result()?.status_code;
    return code === 'ALREADY_CHECKED_IN' ||
           code === 'NO_CLASS_IN_WINDOW' ||
           code === 'NO_BOOKING_TODAY' ||
           code === 'EXPIRED_TOKEN';
  }

  isError(): boolean {
    const code = this.result()?.status_code;
    return !!code && !this.isOk() && !this.isNotice();
  }

  getPopupTitle(): string {
    const code = this.result()?.status_code;
    switch (code) {
      case 'OK':
        return '¡Acceso Confirmado!';
      case 'ALREADY_CHECKED_IN':
        return '¡Ya Registrada!';
      case 'NO_CLASS_IN_WINDOW':
        return '¡Fuera de Horario!';
      case 'NO_BOOKING_TODAY':
        return '¡Sin Clases Hoy!';
      case 'EXPIRED_TOKEN':
        return '¡Pase Expirado!';
      case 'INVALID_TOKEN':
      default:
        return '¡Acceso Denegado!';
    }
  }

  getPopupIconClass(): string {
    const code = this.result()?.status_code;
    switch (code) {
      case 'OK':
        return 'pi-check';
      case 'ALREADY_CHECKED_IN':
        return 'pi-info-circle';
      case 'NO_CLASS_IN_WINDOW':
        return 'pi-clock';
      case 'NO_BOOKING_TODAY':
        return 'pi-calendar';
      case 'EXPIRED_TOKEN':
        return 'pi-exclamation-triangle';
      case 'INVALID_TOKEN':
      default:
        return 'pi-ban';
    }
  }

  // ── Walk-in (registro manual de quien entró por cama libre) ─────
  readonly bedRows: number[][] = [
    [1, 2, 3, 4, 5, 6, 7],
    [8, 9, 10, 11, 12, 13, 14],
  ];
  showWalkinDialog = signal(false);
  walkinStep = signal<1 | 2>(1);
  clientQuery = signal('');
  clientResults = signal<ClientSearchResult[]>([]);
  searchingClients = signal(false);
  selectedClient = signal<ClientSearchResult | null>(null);
  walkinCapacity = signal<number>(14);
  walkinSelectedBed = signal<number | null>(null);

  // Camas con CHECK-IN (asistió) en el turno seleccionado → ocupadas de verdad.
  walkinAttendedBeds = computed(() => {
    const beds = new Set<number>();
    for (const e of this.roster()) {
      if (e.attendance_status === 'attended') (e.bed_numbers || []).forEach(b => beds.add(b));
    }
    return beds;
  });

  // Camas con reserva pero SIN check-in → se pueden dar al walk-in (amarillo).
  walkinReservedBeds = computed(() => {
    const attended = this.walkinAttendedBeds();
    const beds = new Set<number>();
    for (const e of this.roster()) {
      if (e.attendance_status !== 'attended') {
        (e.bed_numbers || []).forEach(b => { if (!attended.has(b)) beds.add(b); });
      }
    }
    return beds;
  });
  registeringWalkin = signal(false);
  walkinError = signal<string | null>(null);
  private searchDebounce?: ReturnType<typeof setTimeout>;

  openWalkinDialog() {
    if (!this.selectedTime()) return;
    this.walkinStep.set(1);
    this.clientQuery.set('');
    this.clientResults.set([]);
    this.selectedClient.set(null);
    this.walkinSelectedBed.set(null);
    this.walkinError.set(null);
    this.showWalkinDialog.set(true);
  }

  closeWalkinDialog() {
    this.showWalkinDialog.set(false);
    // Restaurar el foco del lector QR una vez cerrado el diálogo.
    setTimeout(() => this.focusInput(), 0);
  }

  onClientQueryChange(value: string) {
    this.clientQuery.set(value);
    this.walkinError.set(null);
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    const term = value.trim();
    if (term.length < 2) {
      this.clientResults.set([]);
      this.searchingClients.set(false);
      return;
    }
    this.searchingClients.set(true);
    this.searchDebounce = setTimeout(() => this.runClientSearch(term), 300);
  }

  private async runClientSearch(term: string) {
    try {
      const results = await this.checkinService.searchClients(term);
      // Evitar carrera: solo aplicar si la query sigue siendo la misma
      if (this.clientQuery().trim() === term) {
        this.clientResults.set(results);
      }
    } catch {
      this.clientResults.set([]);
    } finally {
      this.searchingClients.set(false);
    }
  }

  async selectClient(client: ClientSearchResult) {
    if (client.available_credits < 1) return; // sin créditos no se puede registrar
    this.selectedClient.set(client);
    this.walkinSelectedBed.set(null);
    this.walkinStep.set(2);
    await this.loadWalkinBeds();
  }

  backToClientSearch() {
    this.walkinStep.set(1);
    this.walkinError.set(null);
  }

  goToAssignCredits(client: ClientSearchResult) {
    this.closeWalkinDialog();
    this.router.navigate(['/admin/credits/assign'], { queryParams: { userId: client.id } });
  }

  private async loadWalkinBeds() {
    const time = this.selectedTime();
    const date = this.selectedDate();
    if (!time || !date) return;
    // Refrescar el roster para tener el estado de check-in al día.
    await this.loadRoster();
    // Capacidad real del slot (para no ofrecer camas que excedan el aforo)
    try {
      const slots = await this.bookingService.getAvailableSlots(date);
      const slot = slots.find(s => s.time === time);
      this.walkinCapacity.set(slot?.capacity ?? 14);
    } catch {
      this.walkinCapacity.set(14);
    }
  }

  /** Cama con check-in confirmado → ocupada (roja, no seleccionable). */
  isBedAttended(bed: number): boolean {
    return this.walkinAttendedBeds().has(bed);
  }

  /** Cama reservada pero sin check-in → seleccionable, con aviso (amarilla). */
  isBedReserved(bed: number): boolean {
    return !this.isBedAttended(bed) && this.walkinReservedBeds().has(bed);
  }

  isBedDisabled(bed: number): boolean {
    return this.isBedAttended(bed) || bed > this.walkinCapacity();
  }

  selectWalkinBed(bed: number) {
    if (this.isBedDisabled(bed)) return;
    this.walkinSelectedBed.set(this.walkinSelectedBed() === bed ? null : bed);
  }

  async confirmWalkin() {
    const client = this.selectedClient();
    const bed = this.walkinSelectedBed();
    const time = this.selectedTime();
    const date = this.selectedDate();
    if (!client || bed === null || !time || !date || this.registeringWalkin()) return;

    this.registeringWalkin.set(true);
    this.walkinError.set(null);
    try {
      const res = await this.checkinService.registerWalkin({
        userId: client.id,
        sessionDate: date,
        sessionTime: time + ':00',
        bedNumber: bed,
        coachName: this.selectedClass()?.coach_name || 'Coach',
      });

      if (res.status_code === 'OK') {
        this.beep(true);
        this.closeWalkinDialog();
        await this.refresh(); // la persona aparece ya palomeada en el roster
      } else if (res.status_code === 'BED_TAKEN') {
        // refrescar camas para reflejar la ocupación real
        await this.loadWalkinBeds();
        this.walkinSelectedBed.set(null);
        this.walkinError.set(res.message);
        this.beep(false);
      } else {
        this.walkinError.set(res.message);
        this.beep(false);
      }
    } catch {
      this.walkinError.set('Error al registrar. Intenta de nuevo.');
      this.beep(false);
    } finally {
      this.registeringWalkin.set(false);
    }
  }

  private beep(ok: boolean) {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = ok ? 880 : 220;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.stop(ctx.currentTime + 0.25);
    } catch {
      // sin audio: no es crítico
    }
  }
}
