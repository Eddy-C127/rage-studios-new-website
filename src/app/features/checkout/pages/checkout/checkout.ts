import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CurrencyPipe } from '@angular/common';
import { DividerModule } from 'primeng/divider';
import { PackagesService, Package } from '../../../landing/services/packages.service';
import { PaymentService } from '../../../../core/services/payment.service';
import { SupabaseService } from '../../../../core/services/supabase-service';

@Component({
  selector: 'app-checkout',
    imports: [
    ButtonModule, 
    CardModule, 
    ProgressSpinnerModule, 
    ToastModule, 
    CurrencyPipe,
    DividerModule
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
  private messageService = inject(MessageService);
  
  packageData = signal<Package | null>(null);
  isLoading = signal(true);
  isProcessing = signal(false);
  userEmail = signal<string>('');
  
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
    const session = await this.paymentService.createCheckoutSession(pkg, user.id);

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
