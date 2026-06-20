import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CurrencyPipe } from '@angular/common';
import { DividerModule } from 'primeng/divider';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { PackagesService, Package } from '../../../landing/services/packages.service';
import { PaymentService } from '../../../../core/services/payment.service';
import { SupabaseService } from '../../../../core/services/supabase-service';
import { BlacklistService } from '../../../../core/services/blacklist.service';
import { LoyaltyService } from '../../../../core/services/loyalty.service';

@Component({
  selector: 'app-checkout',
    imports: [
    ButtonModule,
    CardModule,
    ProgressSpinnerModule,
    ToastModule,
    CurrencyPipe,
    DividerModule,
    FormsModule,
    InputTextModule
  ],
  providers: [MessageService],
  templateUrl: './checkout.html',
  styleUrl: './checkout.scss'
})
export class Checkout implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private packagesService = inject(PackagesService);
  private paymentService = inject(PaymentService);
  private supabaseService = inject(SupabaseService);
  private blacklistService = inject(BlacklistService);
  private loyaltyService = inject(LoyaltyService);
  private messageService = inject(MessageService);
  // MessageService raíz (el <p-toast> global de app.html), para mensajes que
  // deben verse DESPUÉS de redirigir fuera de esta página (sobrevive la navegación).
  private rootMessage = inject(MessageService, { skipSelf: true });
  
  packageData = signal<Package | null>(null);
  isLoading = signal(true);
  isProcessing = signal(false);
  userEmail = signal<string>('');

  // Cupón
  couponInput = signal<string>('');
  couponChecking = signal(false);
  appliedDiscount = signal<number | null>(null);   // % aplicado
  couponError = signal<string | null>(null);

  finalPrice(): number {
    const pkg = this.packageData();
    if (!pkg) return 0;
    const d = this.appliedDiscount();
    return d ? Math.round(pkg.price * (1 - d / 100) * 100) / 100 : pkg.price;
  }

  async applyCoupon() {
    const code = this.couponInput().trim();
    const pkg = this.packageData();
    if (!code || !pkg) return;
    this.couponChecking.set(true);
    this.couponError.set(null);
    try {
      const res = await this.loyaltyService.previewCoupon(code, pkg.id);
      if (res.valid && res.discount_percent) {
        this.appliedDiscount.set(res.discount_percent);
      } else {
        this.appliedDiscount.set(null);
        this.couponError.set(res.message || 'Cupón no válido');
      }
    } finally {
      this.couponChecking.set(false);
    }
  }

  removeCoupon() {
    this.couponInput.set('');
    this.appliedDiscount.set(null);
    this.couponError.set(null);
  }
  
  async ngOnInit() {
    const packageId = this.route.snapshot.paramMap.get('packageId');
    
    if (!packageId) {
      this.router.navigate(['/']);
      return;
    }
    
    const user = this.supabaseService.getUser();
    if (!user) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Sesión requerida',
        detail: 'Debes iniciar sesión para continuar'
      });
      this.router.navigate(['/']);
      return;
    }
    
    // 🚫 Acceso directo por URL: bloquear usuarios en lista de bloqueo.
    // Mensaje neutral: no se revela el motivo real.
    const isBlacklisted = await this.blacklistService.checkBlacklistStatus(user.id);
    if (isBlacklisted) {
      // Toast en el toast global: el de esta página se destruiría al redirigir.
      this.rootMessage.add({
        severity: 'info',
        summary: 'No disponible',
        detail: 'Por el momento no es posible completar esta operación.'
      });
      this.router.navigate(['/']);
      return;
    }

    this.userEmail.set(user.email || '');

    try {
      const packageData = await this.packagesService.getPackage(packageId);
      this.packageData.set(packageData);
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'No se pudo cargar el paquete'
      });
      this.router.navigate(['/']);
    } finally {
      this.isLoading.set(false);
    }
  }
  
 async proceedToPayment() {
  const user = this.supabaseService.getUser();
  const pkg = this.packageData();
  
  if (!user || !pkg) return;
  
  this.isProcessing.set(true);
  
  try {
    const couponCode = this.appliedDiscount() ? this.couponInput().trim() : null;
    const session = await this.paymentService.createCheckoutSession(pkg, user.id, couponCode);

    if (session?.url) {
      window.location.href = session.url;
    } else {
      throw new Error('No se recibió URL de pago de Stripe');
    }
  } catch (error: any) {
    console.error('Payment error:', error);
    this.messageService.add({
      severity: 'error',
      summary: 'Error',
      detail: error.message || 'Error al procesar el pago'
    });
    this.isProcessing.set(false);
  }
}
  
  goBack() {
    this.router.navigate(['/']);
  }
}
