import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SkeletonModule } from 'primeng/skeleton';
import { PaginatorModule } from 'primeng/paginator';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { MessageService, ConfirmationService } from 'primeng/api';
import { NewsService, NewsItem, NewsStatus } from '../../../../core/services/news.service';
import { AdminNewsDialog } from './components/admin-news-dialog';

@Component({
  selector: 'app-admin-noticias',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    TableModule,
    TagModule,
    ToastModule,
    SkeletonModule,
    PaginatorModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    ConfirmDialogModule,
    ToggleSwitchModule,
    AdminNewsDialog
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-noticias.html',
  styleUrl: './admin-noticias.scss'
})
export class AdminNoticias implements OnInit {
  private newsService = inject(NewsService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);

  news = signal<NewsItem[]>([]);
  loading = signal(true);
  searchText = signal('');

  showDialog = signal(false);
  editingItem = signal<NewsItem | null>(null);

  skeletonData = Array(6).fill({});
  mobileCurrentPage = signal(0);
  mobileRowsPerPage = signal(10);

  async ngOnInit() {
    await this.loadNews();
  }

  async loadNews() {
    this.loading.set(true);
    try {
      const data = await this.newsService.getAllNews();
      this.news.set(data);
    } catch (e: any) {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las noticias' });
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.editingItem.set(null);
    this.showDialog.set(true);
  }

  openEdit(item: NewsItem) {
    this.editingItem.set(item);
    this.showDialog.set(true);
  }

  confirmDelete(item: NewsItem) {
    this.confirmationService.confirm({
      message: `¿Eliminar la noticia "${item.title}"? Esta acción no se puede deshacer.`,
      header: 'Eliminar noticia',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.deleteItem(item.id)
    });
  }

  async deleteItem(id: string) {
    try {
      await this.newsService.deleteNews(id);
      this.messageService.add({ severity: 'success', summary: 'Eliminada', detail: 'Noticia eliminada correctamente' });
      await this.loadNews();
    } catch (e: any) {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar la noticia' });
    }
  }

  async toggleActive(item: NewsItem) {
    try {
      await this.newsService.updateNews(item.id, { is_active: !item.is_active });
      await this.loadNews();
    } catch (e: any) {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar el estado' });
    }
  }

  getStatusSeverity(item: NewsItem): 'success' | 'secondary' | 'info' | 'warn' | 'danger' {
    const map: Record<NewsStatus, 'success' | 'secondary' | 'info' | 'warn' | 'danger'> = {
      published: 'success',
      scheduled: 'info',
      draft: 'secondary',
      inactive: 'warn'
    };
    return map[this.newsService.getStatus(item)];
  }

  getStatusLabel(item: NewsItem): string {
    const map: Record<NewsStatus, string> = {
      published: 'Publicada',
      scheduled: 'Programada',
      draft: 'Borrador',
      inactive: 'Inactiva'
    };
    return map[this.newsService.getStatus(item)];
  }

  get filteredNews() {
    const q = this.searchText().toLowerCase();
    if (!q) return this.news();
    return this.news().filter(n =>
      n.title.toLowerCase().includes(q) ||
      (n.tag ?? '').toLowerCase().includes(q)
    );
  }

  get paginatedNews() {
    const start = this.mobileCurrentPage() * this.mobileRowsPerPage();
    return this.filteredNews.slice(start, start + this.mobileRowsPerPage());
  }

  onMobilePageChange(event: any) {
    this.mobileCurrentPage.set(event.page);
    this.mobileRowsPerPage.set(event.rows);
  }
}
