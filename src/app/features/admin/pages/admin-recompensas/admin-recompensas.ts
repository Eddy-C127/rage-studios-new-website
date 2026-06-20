import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { LoyaltyAdminService, Reward, CouponCampaign } from '../../../../core/services/loyalty-admin.service';

@Component({
  selector: 'app-admin-recompensas',
  standalone: true,
  imports: [
    FormsModule, DatePipe, ButtonModule, TableModule, TagModule, ToastModule, DialogModule,
    InputTextModule, InputNumberModule, SelectModule, MultiSelectModule, DatePickerModule,
    ToggleSwitchModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-recompensas.html',
  styleUrl: './admin-recompensas.scss',
})
export class AdminRecompensas implements OnInit {
  private service = inject(LoyaltyAdminService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);

  rewards = signal<Reward[]>([]);
  campaigns = signal<CouponCampaign[]>([]);
  packages = signal<{ id: string; title: string }[]>([]);
  loading = signal(true);
  saving = signal(false);

  rewardTypes = [
    { label: 'Cupón de descuento (%)', value: 'discount_coupon' },
    { label: 'Créditos gratis', value: 'free_credits' },
    { label: 'Premio físico (recepción)', value: 'physical_perk' },
    { label: 'Gift card', value: 'gift_card' },
  ];

  // Reward dialog
  showRewardDialog = signal(false);
  editingReward = signal<Partial<Reward>>({});
  rPercent = signal<number | null>(null);
  rCredits = signal<number | null>(null);
  rValidity = signal<number | null>(null);
  rLabel = signal<string>('');

  // Campaign dialog
  showCampaignDialog = signal(false);
  editingCampaign = signal<Partial<CouponCampaign>>({});
  campExpiry = signal<Date | null>(null);

  async ngOnInit() {
    await this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      const [rew, camp, pkgs] = await Promise.all([
        this.service.getRewards(), this.service.getCampaigns(), this.service.getPackages(),
      ]);
      this.rewards.set(rew);
      this.campaigns.set(camp);
      this.packages.set(pkgs);
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el plan de fidelización' });
    } finally {
      this.loading.set(false);
    }
  }

  typeLabel(t: string): string {
    return this.rewardTypes.find(x => x.value === t)?.label ?? t;
  }

  rewardValueSummary(r: Reward): string {
    if (r.type === 'discount_coupon') return `${r.value?.['percent'] ?? '?'}% off`;
    if (r.type === 'free_credits') return `${r.value?.['credits'] ?? '?'} crédito(s)`;
    return r.value?.['label'] ?? r.value?.['sku'] ?? '—';
  }

  packageNames(ids: string[] | null): string {
    if (!ids || ids.length === 0) return 'Todos los paquetes';
    return ids.map(id => this.packages().find(p => p.id === id)?.title ?? '?').join(', ');
  }

  patchReward(p: Partial<Reward>) {
    this.editingReward.update(e => ({ ...e, ...p }));
  }

  patchCampaign(p: Partial<CouponCampaign>) {
    this.editingCampaign.update(e => ({ ...e, ...p }));
  }

  // ── Rewards ───────────────────────────────────────────────────
  openCreateReward() {
    this.editingReward.set({ type: 'discount_coupon', is_active: true, applicable_package_ids: null });
    this.rPercent.set(10); this.rCredits.set(null); this.rValidity.set(30); this.rLabel.set('');
    this.showRewardDialog.set(true);
  }

  openEditReward(r: Reward) {
    this.editingReward.set({ ...r });
    this.rPercent.set(r.value?.['percent'] ?? null);
    this.rCredits.set(r.value?.['credits'] ?? null);
    this.rValidity.set(r.value?.['validity_days'] ?? 30);
    this.rLabel.set(r.value?.['label'] ?? r.value?.['sku'] ?? '');
    this.showRewardDialog.set(true);
  }

  async saveReward() {
    const r = this.editingReward();
    if (!r.name || !r.type) {
      this.messageService.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Nombre y tipo son obligatorios' });
      return;
    }
    let value: Record<string, any> = {};
    if (r.type === 'discount_coupon') {
      if (!this.rPercent() || this.rPercent()! < 1 || this.rPercent()! > 100) {
        this.messageService.add({ severity: 'warn', summary: 'Descuento inválido', detail: 'Pon un porcentaje entre 1 y 100' });
        return;
      }
      value = { percent: this.rPercent() };
    } else if (r.type === 'free_credits') {
      if (!this.rCredits() || this.rCredits()! < 1) {
        this.messageService.add({ severity: 'warn', summary: 'Créditos inválidos', detail: 'Pon al menos 1 crédito' });
        return;
      }
      value = { credits: this.rCredits(), validity_days: this.rValidity() ?? 30 };
    } else {
      value = { label: this.rLabel() };
    }
    this.saving.set(true);
    try {
      await this.service.saveReward({ ...r, value });
      this.messageService.add({ severity: 'success', summary: 'Guardado', detail: 'Recompensa guardada' });
      this.showRewardDialog.set(false);
      await this.load();
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar la recompensa' });
    } finally {
      this.saving.set(false);
    }
  }

  confirmDeleteReward(r: Reward) {
    this.confirmationService.confirm({
      message: `¿Eliminar la recompensa "${r.name}"? Los logros que la usen quedarán sin recompensa.`,
      header: 'Eliminar recompensa', icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar', rejectLabel: 'Cancelar', acceptButtonStyleClass: 'p-button-danger',
      accept: async () => {
        try { await this.service.deleteReward(r.id); await this.load(); }
        catch { this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar' }); }
      },
    });
  }

  async toggleRewardActive(r: Reward) {
    try { await this.service.saveReward({ ...r, is_active: !r.is_active }); await this.load(); }
    catch { this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar' }); }
  }

  // ── Campaigns ─────────────────────────────────────────────────
  openCreateCampaign() {
    this.editingCampaign.set({ discount_percent: 10, is_active: true, applicable_package_ids: null, max_uses: null });
    this.campExpiry.set(null);
    this.showCampaignDialog.set(true);
  }

  openEditCampaign(c: CouponCampaign) {
    this.editingCampaign.set({ ...c });
    this.campExpiry.set(c.expires_at ? new Date(c.expires_at) : null);
    this.showCampaignDialog.set(true);
  }

  async saveCampaign() {
    const c = this.editingCampaign();
    if (!c.code || !c.discount_percent || c.discount_percent < 1 || c.discount_percent > 100) {
      this.messageService.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Código y descuento (1-100) son obligatorios' });
      return;
    }
    this.saving.set(true);
    try {
      await this.service.saveCampaign({ ...c, expires_at: this.campExpiry() ? this.campExpiry()!.toISOString() : null });
      this.messageService.add({ severity: 'success', summary: 'Guardado', detail: 'Cupón de campaña guardado' });
      this.showCampaignDialog.set(false);
      await this.load();
    } catch (e: any) {
      const dup = (e?.message || '').includes('duplicate') || e?.code === '23505';
      this.messageService.add({ severity: 'error', summary: 'Error', detail: dup ? 'Ya existe un cupón con ese código' : 'No se pudo guardar el cupón' });
    } finally {
      this.saving.set(false);
    }
  }

  confirmDeleteCampaign(c: CouponCampaign) {
    this.confirmationService.confirm({
      message: `¿Eliminar el cupón "${c.code}"?`,
      header: 'Eliminar cupón', icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar', rejectLabel: 'Cancelar', acceptButtonStyleClass: 'p-button-danger',
      accept: async () => {
        try { await this.service.deleteCampaign(c.id); await this.load(); }
        catch { this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar' }); }
      },
    });
  }

  async toggleCampaignActive(c: CouponCampaign) {
    try { await this.service.saveCampaign({ ...c, is_active: !c.is_active }); await this.load(); }
    catch { this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar' }); }
  }
}
