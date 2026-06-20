import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { LoyaltyAdminService, Achievement, Reward } from '../../../../core/services/loyalty-admin.service';

@Component({
  selector: 'app-admin-logros',
  standalone: true,
  imports: [
    FormsModule, ButtonModule, TableModule, TagModule, ToastModule, DialogModule,
    InputTextModule, InputNumberModule, SelectModule, ToggleSwitchModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-logros.html',
  styleUrl: './admin-logros.scss',
})
export class AdminLogros implements OnInit {
  private service = inject(LoyaltyAdminService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);

  achievements = signal<Achievement[]>([]);
  rewards = signal<Reward[]>([]);
  loading = signal(true);
  saving = signal(false);

  showDialog = signal(false);
  editing = signal<Partial<Achievement>>({});

  conditionTypes = [
    { label: 'Racha de días seguidos', value: 'daily_streak' },
    { label: 'Racha de domingos', value: 'sunday_streak' },
    { label: 'Clases acumuladas (de por vida)', value: 'cumulative_classes' },
  ];

  async ngOnInit() {
    await this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      const [ach, rew] = await Promise.all([this.service.getAchievements(), this.service.getRewards()]);
      this.achievements.set(ach);
      this.rewards.set(rew);
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los logros' });
    } finally {
      this.loading.set(false);
    }
  }

  rewardOptions() {
    return this.rewards().filter(r => r.is_active).map(r => ({ label: r.name, value: r.id }));
  }

  conditionLabel(t: string): string {
    return this.conditionTypes.find(c => c.value === t)?.label ?? t;
  }

  unitFor(t: string | undefined): string {
    if (t === 'sunday_streak') return 'domingos';
    if (t === 'cumulative_classes') return 'clases';
    return 'días';
  }

  rewardName(id: string | null): string {
    if (!id) return '—';
    return this.rewards().find(r => r.id === id)?.name ?? '—';
  }

  patchEditing(p: Partial<Achievement>) {
    this.editing.update(e => ({ ...e, ...p }));
  }

  openCreate() {
    this.editing.set({
      icon: '🏅', condition_type: 'daily_streak', condition_value: 6,
      is_active: true, order_index: this.achievements().length + 1,
    });
    this.showDialog.set(true);
  }

  openEdit(a: Achievement) {
    this.editing.set({ ...a });
    this.showDialog.set(true);
  }

  async save() {
    const a = this.editing();
    if (!a.name || !a.condition_type || !a.condition_value || a.condition_value < 1) {
      this.messageService.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Nombre, condición y meta (>0) son obligatorios' });
      return;
    }
    this.saving.set(true);
    try {
      await this.service.saveAchievement(a);
      this.messageService.add({ severity: 'success', summary: 'Guardado', detail: 'Logro guardado correctamente' });
      this.showDialog.set(false);
      await this.load();
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar el logro' });
    } finally {
      this.saving.set(false);
    }
  }

  confirmDelete(a: Achievement) {
    this.confirmationService.confirm({
      message: `¿Eliminar el logro "${a.name}"?`,
      header: 'Eliminar logro',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: async () => {
        try {
          await this.service.deleteAchievement(a.id);
          this.messageService.add({ severity: 'success', summary: 'Eliminado', detail: 'Logro eliminado' });
          await this.load();
        } catch {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar' });
        }
      },
    });
  }

  async toggleActive(a: Achievement) {
    try {
      await this.service.saveAchievement({ ...a, is_active: !a.is_active });
      await this.load();
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar' });
    }
  }
}
