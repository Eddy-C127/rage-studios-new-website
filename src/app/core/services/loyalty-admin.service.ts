import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase-service';

export interface Reward {
  id: string;
  name: string;
  type: 'discount_coupon' | 'free_credits' | 'physical_perk' | 'gift_card';
  value: Record<string, any>;
  applicable_package_ids: string[] | null;
  description: string | null;
  is_active: boolean;
}

export interface Achievement {
  id: string;
  name: string;
  icon: string;
  description: string | null;
  condition_type: 'daily_streak' | 'sunday_streak' | 'cumulative_classes';
  condition_value: number;
  reward_id: string | null;
  is_active: boolean;
  order_index: number;
}

export interface CouponCampaign {
  id: string;
  code: string;
  discount_percent: number;
  applicable_package_ids: string[] | null;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

@Injectable({ providedIn: 'root' })
export class LoyaltyAdminService {
  private supabase = inject(SupabaseService);

  // ── Packages (para limitar cupones a ciertos paquetes) ────────
  async getPackages(): Promise<{ id: string; title: string }[]> {
    const { data, error } = await this.supabase.client
      .from('packages').select('id, title').eq('is_active', true).order('order_index', { ascending: true });
    if (error) throw error;
    return (data || []) as { id: string; title: string }[];
  }

  // ── Rewards ───────────────────────────────────────────────────
  async getRewards(): Promise<Reward[]> {
    const { data, error } = await this.supabase.client
      .from('rewards').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []) as Reward[];
  }

  async saveReward(reward: Partial<Reward>): Promise<void> {
    const payload = {
      name: reward.name,
      type: reward.type,
      value: reward.value ?? {},
      applicable_package_ids: reward.applicable_package_ids ?? null,
      description: reward.description ?? null,
      is_active: reward.is_active ?? true,
    };
    if (reward.id) {
      const { error } = await this.supabase.client.from('rewards').update(payload).eq('id', reward.id);
      if (error) throw error;
    } else {
      const { error } = await this.supabase.client.from('rewards').insert(payload);
      if (error) throw error;
    }
  }

  async deleteReward(id: string): Promise<void> {
    const { error } = await this.supabase.client.from('rewards').delete().eq('id', id);
    if (error) throw error;
  }

  // ── Achievements ──────────────────────────────────────────────
  async getAchievements(): Promise<Achievement[]> {
    const { data, error } = await this.supabase.client
      .from('achievements').select('*').order('order_index', { ascending: true });
    if (error) throw error;
    return (data || []) as Achievement[];
  }

  async saveAchievement(a: Partial<Achievement>): Promise<void> {
    const payload = {
      name: a.name,
      icon: a.icon || '🏅',
      description: a.description ?? null,
      condition_type: a.condition_type,
      condition_value: a.condition_value,
      reward_id: a.reward_id ?? null,
      is_active: a.is_active ?? true,
      order_index: a.order_index ?? 0,
    };
    if (a.id) {
      const { error } = await this.supabase.client.from('achievements').update(payload).eq('id', a.id);
      if (error) throw error;
    } else {
      const { error } = await this.supabase.client.from('achievements').insert(payload);
      if (error) throw error;
    }
  }

  async deleteAchievement(id: string): Promise<void> {
    const { error } = await this.supabase.client.from('achievements').delete().eq('id', id);
    if (error) throw error;
  }

  // ── Coupon campaigns ──────────────────────────────────────────
  async getCampaigns(): Promise<CouponCampaign[]> {
    const { data, error } = await this.supabase.client
      .from('coupon_campaigns').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []) as CouponCampaign[];
  }

  async saveCampaign(c: Partial<CouponCampaign>): Promise<void> {
    const payload = {
      code: (c.code || '').trim().toUpperCase(),
      discount_percent: c.discount_percent,
      applicable_package_ids: c.applicable_package_ids ?? null,
      max_uses: c.max_uses ?? null,
      expires_at: c.expires_at ?? null,
      is_active: c.is_active ?? true,
    };
    if (c.id) {
      const { error } = await this.supabase.client.from('coupon_campaigns').update(payload).eq('id', c.id);
      if (error) throw error;
    } else {
      const { error } = await this.supabase.client.from('coupon_campaigns').insert(payload);
      if (error) throw error;
    }
  }

  async deleteCampaign(id: string): Promise<void> {
    const { error } = await this.supabase.client.from('coupon_campaigns').delete().eq('id', id);
    if (error) throw error;
  }

  // ── Entregas de premios físicos ───────────────────────────────
  async listRedemptions(status: string | null = 'pending'): Promise<RewardRedemption[]> {
    const { data, error } = await this.supabase.client
      .rpc('admin_list_reward_redemptions', { p_status: status });
    if (error) throw error;
    return (data || []) as RewardRedemption[];
  }

  async markDelivered(id: string): Promise<{ status_code: string; message: string }> {
    const { data, error } = await this.supabase.client
      .rpc('admin_mark_redemption_delivered', { p_id: id });
    if (error) throw error;
    return data as any;
  }
}

export interface RewardRedemption {
  id: string;
  user_id: string;
  user_name: string | null;
  user_phone: string | null;
  reward_name: string | null;
  reward_type: string | null;
  status: string;
  created_at: string;
  delivered_at: string | null;
}
