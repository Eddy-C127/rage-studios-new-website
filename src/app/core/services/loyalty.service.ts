import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase-service';

export interface StreakSummary {
  daily_streak: number;
  sunday_streak: number;
  cumulative_classes: number;
  longest_daily_streak: number;
}

export interface RewardInfo {
  id: string;
  name: string;
  type: 'discount_coupon' | 'free_credits' | 'physical_perk' | 'gift_card';
  value: Record<string, any>;
  description: string | null;
}

export interface AchievementWithStatus {
  id: string;
  name: string;
  icon: string;
  description: string | null;
  condition_type: 'daily_streak' | 'sunday_streak' | 'cumulative_classes';
  condition_value: number;
  order_index: number;
  reward: RewardInfo | null;
  // Estado para el usuario actual
  unlocked: boolean;
  claimable: boolean;   // desbloqueado y sin reclamar
  claimed: boolean;
  user_achievement_id: string | null;
}

@Injectable({ providedIn: 'root' })
export class LoyaltyService {
  private supabase = inject(SupabaseService);

  /** Resumen de racha "efectiva" (considera huecos) para el dashboard. */
  async getStreakSummary(userId: string): Promise<StreakSummary> {
    const { data, error } = await this.supabase.client.rpc('get_user_streak_summary', { p_user_id: userId });
    if (error || !data) {
      return { daily_streak: 0, sunday_streak: 0, cumulative_classes: 0, longest_daily_streak: 0 };
    }
    return data as StreakSummary;
  }

  /**
   * Logros activos con el estado del usuario (desbloqueado / reclamable / reclamado).
   */
  async getAchievements(userId: string): Promise<AchievementWithStatus[]> {
    const [{ data: achievements }, { data: userAch }] = await Promise.all([
      this.supabase.client
        .from('achievements')
        .select('id, name, icon, description, condition_type, condition_value, order_index, reward:rewards(id, name, type, value, description)')
        .eq('is_active', true)
        .order('order_index', { ascending: true }),
      this.supabase.client
        .from('user_achievements')
        .select('id, achievement_id, claimed_at, cycle_closed')
        .eq('user_id', userId)
        .eq('cycle_closed', false),
    ]);

    const byAchievement = new Map<string, { id: string; claimed_at: string | null }>();
    for (const ua of (userAch || []) as any[]) {
      // Conservar el más relevante (sin reclamar tiene prioridad)
      const existing = byAchievement.get(ua.achievement_id);
      if (!existing || (existing.claimed_at && !ua.claimed_at)) {
        byAchievement.set(ua.achievement_id, { id: ua.id, claimed_at: ua.claimed_at });
      }
    }

    return ((achievements || []) as any[]).map((a) => {
      const ua = byAchievement.get(a.id);
      const reward = Array.isArray(a.reward) ? a.reward[0] : a.reward;
      return {
        id: a.id,
        name: a.name,
        icon: a.icon,
        description: a.description,
        condition_type: a.condition_type,
        condition_value: a.condition_value,
        order_index: a.order_index,
        reward: reward ?? null,
        unlocked: !!ua,
        claimable: !!ua && !ua.claimed_at,
        claimed: !!ua && !!ua.claimed_at,
        user_achievement_id: ua?.id ?? null,
      } as AchievementWithStatus;
    });
  }

  /**
   * Previsualiza un cupón para un paquete (valida y devuelve el descuento aplicable).
   * Devuelve { valid, discount_percent?, message? }.
   */
  async previewCoupon(code: string, packageId: string): Promise<{ valid: boolean; discount_percent?: number; message?: string }> {
    const { data, error } = await this.supabase.client.rpc('preview_coupon', { p_code: code, p_package_id: packageId });
    if (error) return { valid: false, message: 'No se pudo validar el cupón' };
    return data as any;
  }

  /** Reclama la recompensa de un logro desbloqueado. Devuelve el resultado del servidor. */
  async claimReward(achievementId: string): Promise<{ status_code: string; message: string; [k: string]: any }> {
    const { data, error } = await this.supabase.client.rpc('claim_achievement_reward', { p_achievement_id: achievementId });
    if (error) throw error;
    return data as any;
  }
}
