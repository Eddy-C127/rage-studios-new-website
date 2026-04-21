import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { environment } from '../../../environments/environment';
import { Package } from '../../features/landing/services/packages.service';
import { isPlatformBrowser } from '@angular/common';
import { SupabaseService } from './supabase-service';

export interface Purchase {
  id: string;
  user_id: string;
  package_id: string;
  stripe_payment_intent_id?: string;
  stripe_session_id?: string;
  amount: number;
  status: string;
  transaction_type: string;
  assigned_by?: string;
  created_at: string;
  completed_at?: string;
}

export interface CreditBatch {
  id: string;
  user_id: string;
  purchase_id: string;
  package_id: string;
  credits_total: number;
  credits_remaining: number;
  validity_days: number;
  is_unlimited: boolean;
  expiration_activated: boolean;
  expiration_date?: string;
  first_use_date?: string;
  created_at: string;
}

export interface CreditHistory {
  id: string;
  user_id: string;
  credit_batch_id?: string;
  type: 'added' | 'used' | 'refunded' | 'expired' | 'penalty';
  amount: number;
  description: string;
  booking_id?: string;
  created_at: string;
}

@Injectable({
  providedIn: 'root',
})
export class PaymentService {
  private supabaseService = inject(SupabaseService);
  private platformId = inject(PLATFORM_ID);

  constructor() {
    // Ya no necesitamos crear una instancia independiente
  }

  async createCheckoutSession(packageData: Package, userId: string) {
    try {
      // Solo ejecutar en el cliente
      if (!isPlatformBrowser(this.platformId)) {
        throw new Error('Payment must be initiated from browser');
      }

      // Crear registro de compra pendiente
      const { data: purchase, error: purchaseError } = await this.supabaseService.client
        .from('purchases')
        .insert({
          user_id: userId,
          package_id: packageData.id,
          amount: packageData.price,
          status: 'pending',
          transaction_type: 'online',
        })
        .select()
        .single();

      if (purchaseError) throw purchaseError;

      // URLs dinámicas basadas en el entorno
      const successUrl = `${environment.baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${environment.baseUrl}/checkout/cancel`;

      const { data, error } = await this.supabaseService.client.functions.invoke(
        'create-checkout-session',
        {
          body: {
            packageData,
            userId,
            purchaseId: purchase.id,
            successUrl,
            cancelUrl,
          },
        }
      );

      if (error) throw error;

      return data;
    } catch (error) {
      throw error;
    }
  }

  // Asignar paquete manualmente (para admins)
  async assignPackageManually(
    packageData: Package,
    userId: string,
    adminId: string
  ) {
    try {
      // Crear registro de compra manual
      const { data: purchase, error: purchaseError } = await this.supabaseService.client
        .from('purchases')
        .insert({
          user_id: userId,
          package_id: packageData.id,
          amount: packageData.price,
          status: 'completed',
          transaction_type: 'manual',
          assigned_by: adminId,
          completed_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (purchaseError) throw purchaseError;

      // Asignar créditos
      await this.assignCreditsToUser(purchase.id, packageData, userId);

      return purchase;
    } catch (error) {
      console.error('Error assigning package manually:', error);
      throw error;
    }
  }

  // Asignar créditos al usuario
  // Método público para permitir que GiftCardService lo use
  async assignCreditsToUser(
    purchaseId: string,
    packageData: Package,
    userId: string
  ) {
    // Crear lote de créditos
    const { data: creditBatch, error: creditError } = await this.supabaseService.client
      .from('credit_batches')
      .insert({
        user_id: userId,
        purchase_id: purchaseId,
        package_id: packageData.id,
        credits_total: packageData.is_unlimited
          ? 999999
          : packageData.credits_count,
        credits_remaining: packageData.is_unlimited
          ? 999999
          : packageData.credits_count,
        validity_days: packageData.validity_days,
        is_unlimited: packageData.is_unlimited,
        expiration_activated: false,
      })
      .select()
      .single();

    if (creditError) throw creditError;

    // Registrar en historial
    await this.supabaseService.client.from('credit_history').insert({
      user_id: userId,
      credit_batch_id: creditBatch.id,
      type: 'added',
      amount: packageData.is_unlimited ? 999999 : packageData.credits_count,
      description: `Créditos asignados por compra de paquete: ${packageData.title}`,
    });

    return creditBatch;
  }

  // Manejar pago exitoso de Stripe
  async handleSuccessfulPayment(sessionId: string) {
    // Obtener la compra por session_id
    const { data: purchase, error: purchaseError } = await this.supabaseService.client
      .from('purchases')
      .select('*, packages(*)')
      .eq('stripe_session_id', sessionId)
      .single();

    if (purchaseError) throw purchaseError;

    // Actualizar estado de la compra
    await this.supabaseService.client
      .from('purchases')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', purchase.id);

    // Asignar créditos
    await this.assignCreditsToUser(
      purchase.id,
      purchase.packages,
      purchase.user_id
    );

    return purchase;
  }

  // Obtener historial de créditos
  async getCreditHistory(userId: string): Promise<CreditHistory[]> {
    const { data, error } = await this.supabaseService.client
      .from('credit_history')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // Obtener historial de pagos
  async getPurchaseHistory(userId: string): Promise<Purchase[]> {
    const { data, error } = await this.supabaseService.client
      .from('purchases')
      .select('*, packages(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // Obtener créditos disponibles
  async getAvailableCredits(userId: string): Promise<number> {
    const { data, error } = await this.supabaseService.client
      .from('user_available_credits')
      .select('total_credits')
      .eq('user_id', userId)
      .single();

    if (error) {
      console.error('Error getting available credits:', error);
      return 0;
    }

    return data?.total_credits || 0;
  }

  // Usar créditos (se activará la expiración si es el primer uso)
  async useCredits(
    userId: string,
    amount: number,
    bookingId: string
  ): Promise<boolean> {
    // Obtener lotes de créditos ordenados por fecha de expiración
    // ✅ FIX: Filtrar batches expirados para no usar créditos que ya no son válidos
    const { data: batches, error } = await this.supabaseService.client
      .from('credit_batches')
      .select('*')
      .eq('user_id', userId)
      .gt('credits_remaining', 0)
      .or('expiration_date.is.null,expiration_date.gt.' + new Date().toISOString())
      .order('expiration_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    if (error || !batches || batches.length === 0) {
      return false;
    }

    let creditsToUse = amount;

    for (const batch of batches) {
      if (creditsToUse <= 0) break;

      // Si es el primer uso, activar expiración
      if (!batch.expiration_activated && !batch.is_unlimited) {
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + batch.validity_days);

        await this.supabaseService.client
          .from('credit_batches')
          .update({
            expiration_activated: true,
            first_use_date: new Date().toISOString(),
            expiration_date: expirationDate.toISOString(),
          })
          .eq('id', batch.id);
      }

      const creditsFromBatch = Math.min(creditsToUse, batch.credits_remaining);

      // Actualizar créditos restantes
      await this.supabaseService.client
        .from('credit_batches')
        .update({
          credits_remaining: batch.credits_remaining - creditsFromBatch,
        })
        .eq('id', batch.id);

      // Registrar en historial
      await this.supabaseService.client.from('credit_history').insert({
        user_id: userId,
        credit_batch_id: batch.id,
        type: 'used',
        amount: -creditsFromBatch,
        description: 'Crédito usado para reserva',
        booking_id: bookingId,
      });

      creditsToUse -= creditsFromBatch;
    }

    return creditsToUse === 0;
  }

  // Devolver créditos (cancelación de reserva)
  async refundCredits(
    userId: string,
    amount: number,
    bookingId: string,
    batchId: string
  ): Promise<void> {
    // Actualizar créditos en el lote
    const { data: batch } = await this.supabaseService.client
      .from('credit_batches')
      .select('*')
      .eq('id', batchId)
      .single();

    if (batch) {
      await this.supabaseService.client
        .from('credit_batches')
        .update({
          credits_remaining: batch.credits_remaining + amount,
        })
        .eq('id', batchId);

      // Registrar en historial
      await this.supabaseService.client.from('credit_history').insert({
        user_id: userId,
        credit_batch_id: batchId,
        type: 'refunded',
        amount: amount,
        description: 'Crédito devuelto por cancelación de reserva',
        booking_id: bookingId,
      });
    }
  }

  // Usar créditos para una reserva
  async useCreditsForBooking(
    userId: string,
    amount: number,
    bookingId?: string
  ): Promise<{ success: boolean; batchId?: string; error?: string }> {
    try {
      // Obtener lotes de créditos ordenados por prioridad
      // ✅ FIX: Filtrar batches expirados para no usar créditos que ya no son válidos
      const { data: batches, error } = await this.supabaseService.client
        .from('credit_batches')
        .select('*')
        .eq('user_id', userId)
        .gt('credits_remaining', 0)
        .or('expiration_date.is.null,expiration_date.gt.' + new Date().toISOString())
        .order('expiration_activated', { ascending: false }) // Primero los ya activados
        .order('expiration_date', { ascending: true, nullsFirst: false }) // Luego por fecha de expiración
        .order('created_at', { ascending: true }); // Finalmente por antigüedad

      if (error || !batches || batches.length === 0) {
        return { success: false, error: 'No hay créditos disponibles' };
      }

      let creditsToUse = amount;
      let usedBatchId: string | null = null;

      for (const batch of batches) {
        if (creditsToUse <= 0) break;

        // Si es el primer uso y no es ilimitado, activar expiración
        // 🔧 FIX: Removida condición credits_remaining === credits_total
        // para permitir activación de expiración incluso después de penalizaciones
        if (
          !batch.expiration_activated &&
          !batch.is_unlimited
        ) {
          const expirationDate = new Date();
          expirationDate.setDate(
            expirationDate.getDate() + batch.validity_days
          );

          await this.supabaseService.client
            .from('credit_batches')
            .update({
              expiration_activated: true,
              first_use_date: new Date().toISOString(),
              expiration_date: expirationDate.toISOString(),
            })
            .eq('id', batch.id);
        }

        const creditsFromBatch = Math.min(
          creditsToUse,
          batch.credits_remaining
        );

        // Actualizar créditos restantes
        await this.supabaseService.client
          .from('credit_batches')
          .update({
            credits_remaining: batch.credits_remaining - creditsFromBatch,
          })
          .eq('id', batch.id);

        // Registrar en historial
        await this.supabaseService.client.from('credit_history').insert({
          user_id: userId,
          credit_batch_id: batch.id,
          type: 'used',
          amount: -creditsFromBatch,
          description: `Créditos usados para reserva`,
          booking_id: bookingId,
        });

        creditsToUse -= creditsFromBatch;
        if (!usedBatchId) usedBatchId = batch.id;
      }

      return {
        success: creditsToUse === 0,
        batchId: usedBatchId || undefined,
        error: creditsToUse > 0 ? 'Créditos insuficientes' : undefined,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // Devolver créditos al cancelar reserva
  async refundCreditsForBooking(
    userId: string,
    bookingId: string,
    amount: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 🔄 NUEVA LÓGICA: Buscar TODOS los registros de créditos usados para esta reserva
      const { data: historyRecords, error: historyError } = await this.supabaseService.client
        .from('credit_history')
        .select('credit_batch_id, amount')
        .eq('booking_id', bookingId)
        .eq('type', 'used')
        .order('created_at', { ascending: true });

      if (historyError || !historyRecords || historyRecords.length === 0) {
        return {
          success: false,
          error: 'No se encontró el historial de créditos',
        };
      }

      let totalCreditsToRefund = 0;
      const refundPromises: Promise<void>[] = [];

      // 🔄 PROCESAR CADA LOTE DE CRÉDITOS USADO
      for (const historyRecord of historyRecords) {
        const creditsUsedFromBatch = Math.abs(historyRecord.amount); // amount es negativo
        totalCreditsToRefund += creditsUsedFromBatch;

        // Crear promesa para procesar este lote en paralelo
        const refundBatchPromise = async () => {
          // Obtener el batch
          const { data: batch, error: batchError } = await this.supabaseService.client
            .from('credit_batches')
            .select('*')
            .eq('id', historyRecord.credit_batch_id)
            .single();

          if (batchError || !batch) {
            throw new Error(`No se encontró el lote de créditos ${historyRecord.credit_batch_id}`);
          }

          // Verificar si el batch no ha expirado (solo advertencia, no bloquear)
          if (batch.expiration_date) {
            const expDate = new Date(batch.expiration_date);
            if (expDate < new Date()) {
              console.warn(`⚠️ Los créditos del lote ${batch.id} han expirado, pero devolviendo por cancelación`);
            }
          }

          // Devolver los créditos a este lote específico
          await this.supabaseService.client
            .from('credit_batches')
            .update({
              credits_remaining: batch.credits_remaining + creditsUsedFromBatch,
            })
            .eq('id', batch.id);

          // Registrar en historial la devolución específica de este lote
          await this.supabaseService.client.from('credit_history').insert({
            user_id: userId,
            credit_batch_id: batch.id,
            type: 'refunded',
            amount: creditsUsedFromBatch,
            description: `Créditos devueltos por cancelación de reserva (${creditsUsedFromBatch} de ${historyRecords.length} lotes)`,
            booking_id: bookingId,
          });
        };

        refundPromises.push(refundBatchPromise());
      }

      // Ejecutar todas las devoluciones en paralelo
      await Promise.all(refundPromises);

      // Verificar que se devolvieron todos los créditos esperados
      if (totalCreditsToRefund !== amount) {
        console.warn(`⚠️ Se devolvieron ${totalCreditsToRefund} créditos, pero se esperaban ${amount}`);
      }

      console.log(`✅ Devolución exitosa: ${totalCreditsToRefund} créditos devueltos a ${historyRecords.length} lotes`);
      return { success: true };
    } catch (error: any) {
      console.error('❌ Error en refundCreditsForBooking:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 🚫 Descontar créditos como penalización (administrador)
   * Replica la lógica de descuento de reservas pero registra como 'penalty'
   * @param userId ID del usuario al que se le descontarán créditos
   * @param amount Cantidad de créditos a descontar
   * @param description Descripción opcional de la penalización
   * @returns Resultado de la operación con detalles de los batches afectados
   */
  async deductCreditsAsPenalty(
    userId: string,
    amount: number,
    description?: string
  ): Promise<{
    success: boolean;
    error?: string;
    batchesAffected?: number;
    creditsDeducted?: number;
  }> {
    try {
      // Validación de cantidad
      if (amount <= 0) {
        return { success: false, error: 'La cantidad debe ser mayor a 0' };
      }

      // Obtener lotes de créditos ordenados por prioridad (misma lógica que reservas)
      const { data: batches, error } = await this.supabaseService.client
        .from('credit_batches')
        .select('*')
        .eq('user_id', userId)
        .gt('credits_remaining', 0)
        .or('expiration_date.is.null,expiration_date.gt.' + new Date().toISOString())
        .order('expiration_activated', { ascending: false }) // Primero los ya activados
        .order('expiration_date', { ascending: true, nullsFirst: false }) // Luego por fecha de expiración
        .order('created_at', { ascending: true }); // Finalmente por antigüedad

      if (error) {
        return { success: false, error: 'Error al consultar créditos disponibles' };
      }

      if (!batches || batches.length === 0) {
        return { success: false, error: 'El usuario no tiene créditos disponibles' };
      }

      // Calcular créditos totales disponibles
      const totalAvailableCredits = batches.reduce(
        (acc, batch) => acc + batch.credits_remaining,
        0
      );

      // Validar que tenga suficientes créditos
      if (totalAvailableCredits < amount) {
        return {
          success: false,
          error: `El usuario solo tiene ${totalAvailableCredits} crédito${totalAvailableCredits !== 1 ? 's' : ''} disponible${totalAvailableCredits !== 1 ? 's' : ''}. No se pueden descontar ${amount}.`
        };
      }

      let creditsToDeduct = amount;
      let batchesAffected = 0;
      const deductionPromises: Promise<void>[] = [];
      const finalDescription = description || 'Descuento aplicado por el administrador';

      // Descontar de los batches según prioridad
      for (const batch of batches) {
        if (creditsToDeduct <= 0) break;

        const creditsFromBatch = Math.min(creditsToDeduct, batch.credits_remaining);

        // Crear promesa para procesar este batch
        const deductBatchPromise = async () => {
          // Actualizar créditos restantes del batch
          const { error: updateError } = await this.supabaseService.client
            .from('credit_batches')
            .update({
              credits_remaining: batch.credits_remaining - creditsFromBatch,
            })
            .eq('id', batch.id);

          if (updateError) {
            throw new Error(`Error al actualizar batch ${batch.id}: ${updateError.message}`);
          }

          // Registrar en historial como penalización
          const { error: historyError } = await this.supabaseService.client
            .from('credit_history')
            .insert({
              user_id: userId,
              credit_batch_id: batch.id,
              type: 'penalty',
              amount: -creditsFromBatch, // Negativo para indicar descuento
              description: `${finalDescription} (${creditsFromBatch} de ${amount} créditos)`,
            });

          if (historyError) {
            throw new Error(`Error al registrar historial para batch ${batch.id}: ${historyError.message}`);
          }
        };

        deductionPromises.push(deductBatchPromise());
        creditsToDeduct -= creditsFromBatch;
        batchesAffected++;
      }

      // Ejecutar todos los descuentos en paralelo
      await Promise.all(deductionPromises);

      console.log(`✅ Penalización exitosa: ${amount} créditos descontados de ${batchesAffected} lote${batchesAffected !== 1 ? 's' : ''} al usuario ${userId}`);

      return {
        success: true,
        batchesAffected,
        creditsDeducted: amount
      };

    } catch (error: any) {
      console.error('❌ Error en deductCreditsAsPenalty:', error);
      return { success: false, error: error.message || 'Error al descontar créditos' };
    }
  }
}
