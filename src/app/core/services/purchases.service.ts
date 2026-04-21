import { Injectable, inject, signal, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { SupabaseService } from './supabase-service';

export interface ICreditBatch {
  id: string;
  user_id: string;
  purchase_id: string;
  package_id: string;
  credits_total: number;
  credits_remaining: number;
  validity_days: number;
  is_unlimited: boolean;
  expiration_activated: boolean;
  expiration_date: string | null;
  first_use_date: string | null;
  created_at: string;
  package?: IPackage;
  purchase?: IPurchase;
}

export interface IPackage {
  id: string;
  title: string;
  classes_count: number | null;
  credits_count: number | null;
  validity_days: number;
  price: number;
  policies: string[];
  order_index: number;
  is_active: boolean;
  is_unlimited: boolean;
  created_at: string;
  updated_at: string;
}

export interface IPurchase {
  id: string;
  user_id: string;
  package_id: string;
  stripe_payment_intent_id: string | null;
  stripe_session_id: string | null;
  amount: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  transaction_type: string;
  assigned_by: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class PurchasesService {
  private supabaseService = inject(SupabaseService);
  private isBrowser: boolean;
  
  // Signals para el estado
  isLoading = signal(false);
  creditBatches = signal<ICreditBatch[]>([]);
  packages = signal<IPackage[]>([]);
  
  constructor(@Inject(PLATFORM_ID) platformId: Object) {
    this.isBrowser = isPlatformBrowser(platformId);
  }
  
  /**
   * Load credit batches with related package and purchase info
   */
  async loadUserCreditBatches(userId: string): Promise<ICreditBatch[]> {
    if (!this.isBrowser) return [];
    
    this.isLoading.set(true);
    
    try {
      const now = new Date().toISOString();
      const { data, error } = await this.supabaseService.client
        .from('credit_batches')
        .select(`
          *,
          package:packages(*),
          purchase:purchases(*)
        `)
        .eq('user_id', userId)
        .gt('credits_remaining', 0)
        .or(`expiration_date.is.null,expiration_date.gt.${now}`)
        .order('expiration_date', { ascending: true, nullsFirst: false });
      
      if (error) throw error;
      
      const creditBatches = (data as ICreditBatch[]) || [];
      this.creditBatches.set(creditBatches);
      return creditBatches;
      
    } catch (error) {
      console.error('Error loading credit batches:', error);
      return [];
    } finally {
      this.isLoading.set(false);
    }
  }
  
  /**
   * Load all active packages
   */
  async loadPackages(): Promise<IPackage[]> {
    if (!this.isBrowser) return [];
    
    try {
      const { data, error } = await this.supabaseService.client
        .from('packages')
        .select('*')
        .eq('is_active', true)
        .order('order_index', { ascending: true });
      
      if (error) throw error;
      
      const packages = (data as IPackage[]) || [];
      this.packages.set(packages);
      return packages;
      
    } catch (error) {
      console.error('Error loading packages:', error);
      return [];
    }
  }
  
  /**
   * Get credit batches for current user
   */
  async getUserCreditBatches(): Promise<ICreditBatch[]> {
    const user = this.supabaseService.getUser();
    if (!user) return [];
    
    return await this.loadUserCreditBatches(user.id);
  }
  
  /**
   * Calculate remaining days for expiration
   */
  getRemainingDays(expirationDate: string | null): number | null {
    if (!expirationDate) return null;
    
    const expDate = new Date(expirationDate);
    const now = new Date();
    const diffTime = expDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays > 0 ? diffDays : 0;
  }
  
  /**
   * Check if credit batch is expired
   */
  isExpired(expirationDate: string | null, expirationActivated: boolean): boolean {
    if (!expirationActivated || !expirationDate) return false;
    
    const expDate = new Date(expirationDate);
    return expDate < new Date();
  }
  
  /**
   * Format date for display
   */
  formatDate(date: string): string {
    return new Date(date).toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }
  
  /**
   * Format full date with time
   */
  formatDateTime(date: string): string {
    return new Date(date).toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  
  /**
   * Get status label for credit batch
   */
  getStatusLabel(batch: ICreditBatch): string {
    if (batch.is_unlimited) return 'Ilimitado';
    if (this.isExpired(batch.expiration_date, batch.expiration_activated)) return 'Expirado';
    if (batch.credits_remaining === 0) return 'Agotado';
    return 'Activo';
  }
  
  /**
   * Get status severity for PrimeNG tags
   */
  getStatusSeverity(batch: ICreditBatch): string {
    if (batch.is_unlimited) return 'success';
    if (this.isExpired(batch.expiration_date, batch.expiration_activated)) return 'danger';
    if (batch.credits_remaining === 0) return 'secondary';
    return 'success';
  }
}