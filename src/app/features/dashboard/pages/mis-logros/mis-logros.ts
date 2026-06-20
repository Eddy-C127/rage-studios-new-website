import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { RouterModule } from '@angular/router';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SupabaseService } from '../../../../core/services/supabase-service';
import { CreditsService } from '../../../../core/services/credits.service';
import { LoyaltyService, AchievementWithStatus, StreakSummary } from '../../../../core/services/loyalty.service';

@Component({
  selector: 'app-mis-logros',
  standalone: true,
  imports: [RouterModule, ToastModule],
  providers: [MessageService],
  templateUrl: './mis-logros.html',
  styleUrl: './mis-logros.scss',
})
export class MisLogros implements OnInit {
  private supabase = inject(SupabaseService);
  private loyalty = inject(LoyaltyService);
  private creditsService = inject(CreditsService);
  private messageService = inject(MessageService);

  loading = signal(true);
  summary = signal<StreakSummary>({ daily_streak: 0, sunday_streak: 0, cumulative_classes: 0, longest_daily_streak: 0 });
  achievements = signal<AchievementWithStatus[]>([]);
  claimingId = signal<string | null>(null);

  dailyAchievements = computed(() => this.achievements().filter(a => a.condition_type === 'daily_streak'));
  sundayAchievements = computed(() => this.achievements().filter(a => a.condition_type === 'sunday_streak'));
  otherAchievements = computed(() => this.achievements().filter(a => a.condition_type === 'cumulative_classes'));

  private get uid(): string | null {
    return this.supabase.getUser()?.id ?? null;
  }

  async ngOnInit() {
    await this.reload();
  }

  private async reload() {
    const uid = this.uid;
    if (!uid) { this.loading.set(false); return; }
    this.loading.set(true);
    try {
      const [summary, achievements] = await Promise.all([
        this.loyalty.getStreakSummary(uid),
        this.loyalty.getAchievements(uid),
      ]);
      this.summary.set(summary);
      this.achievements.set(achievements);
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar tus logros.' });
    } finally {
      this.loading.set(false);
    }
  }

  /** Progreso (0-100) del usuario hacia la condición del logro. */
  progressFor(a: AchievementWithStatus): number {
    const current = a.condition_type === 'sunday_streak' ? this.summary().sunday_streak
      : a.condition_type === 'cumulative_classes' ? this.summary().cumulative_classes
      : this.summary().daily_streak;
    return Math.min(Math.round((current / a.condition_value) * 100), 100);
  }

  currentValueFor(a: AchievementWithStatus): number {
    if (a.condition_type === 'sunday_streak') return this.summary().sunday_streak;
    if (a.condition_type === 'cumulative_classes') return this.summary().cumulative_classes;
    return this.summary().daily_streak;
  }

  unitFor(a: AchievementWithStatus): string {
    if (a.condition_type === 'sunday_streak') return 'domingos';
    if (a.condition_type === 'cumulative_classes') return 'clases';
    return 'días';
  }

  rewardLabel(a: AchievementWithStatus): string {
    const r = a.reward;
    if (!r) return '';
    if (r.type === 'discount_coupon') return `${r.value['percent']}% de descuento`;
    if (r.type === 'free_credits') return `${r.value['credits']} crédito(s) gratis`;
    return r.name;
  }

  async claim(a: AchievementWithStatus) {
    if (!a.claimable || this.claimingId()) return;
    this.claimingId.set(a.id);
    try {
      const res = await this.loyalty.claimReward(a.id);
      if (res.status_code === 'OK') {
        let detail = res['reward_name'] ? `Reclamaste: ${res['reward_name']}.` : '¡Recompensa reclamada!';
        if (res['reward_type'] === 'discount_coupon') {
          detail = `¡Listo! Cupón ${res['coupon_code']} (${res['discount_percent']}% off) agregado a tu cuenta.`;
        } else if (res['reward_type'] === 'free_credits') {
          detail = `¡Listo! Se agregaron ${res['credits']} crédito(s) a tu cuenta.`;
          await this.creditsService.refreshCredits().catch(() => {});
        } else if (res['reward_type'] === 'physical_perk' || res['reward_type'] === 'gift_card') {
          detail = '¡Listo! Pasa a recepción a recoger tu premio.';
        }
        this.messageService.add({ severity: 'success', summary: '¡Felicidades!', detail, life: 7000 });
        await this.reload();
      } else {
        this.messageService.add({ severity: 'warn', summary: 'No se pudo reclamar', detail: res.message });
      }
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo reclamar la recompensa.' });
    } finally {
      this.claimingId.set(null);
    }
  }
}
