import { Component, OnInit, inject, signal, OnDestroy } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { CreditsService } from '../../../../core/services/credits.service';
import { SupabaseService } from '../../../../core/services/supabase-service';

type PaymentState = 'processing' | 'success' | 'error' | 'already_processed' | 'timeout';

@Component({
  selector: 'app-success',
  imports: [ButtonModule, CardModule, ProgressSpinnerModule],
  templateUrl: './success.html',
  styleUrl: './success.scss',
})
export class Success implements OnInit, OnDestroy {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private supabaseService = inject(SupabaseService);
  private creditsService = inject(CreditsService);

  private timeoutId?: number;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAYS = [2000, 4000, 8000]; // Backoff exponencial
  private readonly TIMEOUT_MS = 30000; // 30 segundos

  // Estados mejorados
  paymentState = signal<PaymentState>('processing');
  errorMessage = signal('');
  retryAttempt = signal(0);
  statusMessage = signal('Verificando el estado de tu pago...');

  async ngOnInit() {
    const sessionId = this.route.snapshot.queryParamMap.get('session_id');

    if (!sessionId) {
      this.paymentState.set('error');
      this.errorMessage.set('Sesión de pago no válida');
      this.statusMessage.set('No se encontró información del pago');
      return;
    }

    // Configurar timeout de seguridad
    this.setupTimeout();

    // Iniciar proceso de verificación y procesamiento
    await this.processPayment(sessionId);
  }

  ngOnDestroy() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
  }

  private setupTimeout() {
    this.timeoutId = window.setTimeout(() => {
      if (this.paymentState() === 'processing') {
        this.paymentState.set('timeout');
        this.errorMessage.set('El proceso está tardando más de lo esperado');
        this.statusMessage.set('Puedes verificar tus créditos en Mi Cuenta');
      }
    }, this.TIMEOUT_MS);
  }

  private async processPayment(sessionId: string) {
    try {
      // PASO 1: Verificar estado actual de la compra
      this.statusMessage.set('Verificando el estado de tu compra...');

      const { data: purchase, error: purchaseError } = await this.supabaseService.client
        .from('purchases')
        .select('*, credit_batches(*)')
        .eq('stripe_session_id', sessionId)
        .single();

      if (purchaseError) {
        throw new Error('No se encontró la compra asociada a este pago');
      }

      // PASO 2: Verificar si ya fue procesada
      if (purchase.status === 'completed' && purchase.credit_batches?.length > 0) {
        console.log('✅ Pago ya procesado anteriormente');
        this.paymentState.set('already_processed');
        this.statusMessage.set('Tu pago ya fue procesado anteriormente');

        // Refrescar créditos para mostrar información actualizada
        await this.creditsService.refreshCredits();

        // Cambiar a estado success después de un momento
        setTimeout(() => {
          this.paymentState.set('success');
          this.statusMessage.set('¡Pago completado exitosamente!');
        }, 1500);

        return;
      }

      // PASO 3: Procesar pago con reintentos
      await this.processPaymentWithRetries(sessionId);

    } catch (error: any) {
      console.error('❌ Error en processPayment:', error);
      this.paymentState.set('error');
      this.errorMessage.set(error.message || 'Error al procesar el pago');
      this.statusMessage.set('Ocurrió un error al verificar tu pago');
    } finally {
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
      }
    }
  }

  private async processPaymentWithRetries(sessionId: string) {
    // Verify the authenticated user owns this session before polling
    const { data: { user } } = await this.supabaseService.client.auth.getUser();
    if (!user) {
      throw new Error('Sesión de usuario no válida');
    }

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      this.retryAttempt.set(attempt + 1);

      if (attempt > 0) {
        const delay = this.RETRY_DELAYS[attempt - 1];
        this.statusMessage.set(`Verificando pago (${attempt + 1}/${this.MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        this.statusMessage.set('Verificando tu pago con Stripe...');
      }

      try {
        // Poll the purchase record — only readable by the authenticated user (RLS enforced)
        const { data: purchase, error } = await this.supabaseService.client
          .from('purchases')
          .select('*, credit_batches(*)')
          .eq('stripe_session_id', sessionId)
          .eq('user_id', user.id)
          .single();

        if (error || !purchase) {
          if (attempt === this.MAX_RETRIES - 1) {
            throw new Error('No se encontró la compra asociada a este pago');
          }
          continue;
        }

        if (purchase.status === 'completed' && purchase.credit_batches?.length > 0) {
          this.statusMessage.set('Actualizando tus créditos...');
          await this.creditsService.refreshCredits();
          this.paymentState.set('success');
          this.statusMessage.set('¡Pago completado exitosamente!');
          return;
        }

        // Payment not yet processed by the Stripe webhook — retry
        if (attempt === this.MAX_RETRIES - 1) {
          throw new Error('El pago está siendo procesado. Revisa tus créditos en unos minutos.');
        }

      } catch (error: any) {
        if (attempt === this.MAX_RETRIES - 1) {
          throw error;
        }
      }
    }

    throw new Error('No se pudo verificar el pago después de varios intentos');
  }

  goToAccount() {
    this.router.navigate(['/dashboard']);
  }

  goToHome() {
    this.router.navigate(['/']);
  }

  // Método para reintentar manualmente
  async retryPayment() {
    const sessionId = this.route.snapshot.queryParamMap.get('session_id');
    if (!sessionId) return;

    this.paymentState.set('processing');
    this.retryAttempt.set(0);
    this.errorMessage.set('');

    this.setupTimeout();
    await this.processPayment(sessionId);
  }
}