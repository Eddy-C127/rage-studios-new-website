import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SelectButtonModule } from 'primeng/selectbutton';
import { FormsModule } from '@angular/forms';
import { MessageService } from 'primeng/api';
import { LoyaltyAdminService, RewardRedemption } from '../../../../core/services/loyalty-admin.service';

@Component({
  selector: 'app-admin-entregas',
  standalone: true,
  imports: [DatePipe, FormsModule, ButtonModule, TableModule, TagModule, ToastModule, SelectButtonModule],
  providers: [MessageService],
  templateUrl: './admin-entregas.html',
  styleUrl: './admin-entregas.scss',
})
export class AdminEntregas implements OnInit {
  private service = inject(LoyaltyAdminService);
  private messageService = inject(MessageService);

  redemptions = signal<RewardRedemption[]>([]);
  loading = signal(true);
  markingId = signal<string | null>(null);
  filter = signal<string>('pending');

  filterOptions = [
    { label: 'Pendientes', value: 'pending' },
    { label: 'Entregados', value: 'delivered' },
    { label: 'Todos', value: 'all' },
  ];

  async ngOnInit() {
    await this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      const status = this.filter() === 'all' ? null : this.filter();
      this.redemptions.set(await this.service.listRedemptions(status));
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las entregas' });
    } finally {
      this.loading.set(false);
    }
  }

  async onFilterChange() {
    await this.load();
  }

  async markDelivered(r: RewardRedemption) {
    if (this.markingId()) return;
    this.markingId.set(r.id);
    try {
      const res = await this.service.markDelivered(r.id);
      if (res.status_code === 'OK') {
        this.messageService.add({ severity: 'success', summary: 'Entregado', detail: `${r.reward_name} entregado a ${r.user_name}` });
        await this.load();
      } else {
        this.messageService.add({ severity: 'warn', summary: 'Aviso', detail: res.message });
      }
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo marcar como entregado' });
    } finally {
      this.markingId.set(null);
    }
  }
}
