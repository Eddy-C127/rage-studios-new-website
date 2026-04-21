import { Component, inject, model, output, signal, OnChanges, SimpleChanges, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { NewsService, NewsItem, NewsCreateInput } from '../../../../../core/services/news.service';
import { SupabaseService } from '../../../../../core/services/supabase-service';

@Component({
  selector: 'app-admin-news-dialog',
  standalone: true,
  imports: [
    FormsModule,
    DialogModule,
    ButtonModule,
    InputTextModule,
    TextareaModule,
    SelectModule,
    ToggleSwitchModule,
    DatePickerModule,
    ToastModule
  ],
  providers: [MessageService],
  template: `
<p-toast />
<p-dialog
  [visible]="visible()"
  (visibleChange)="visible.set($event)"
  [header]="editingItem() ? 'Editar Noticia' : 'Nueva Noticia'"
  [modal]="true"
  [style]="{ width: '640px', maxWidth: '95vw' }"
  [draggable]="false"
  [resizable]="false"
  (onHide)="resetForm()">

  <div class="flex flex-col gap-5 py-2">

    <!-- Title -->
    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold text-gray-700">Título *</label>
      <input pInputText [(ngModel)]="form.title" placeholder="Ej: Nueva clase HIIT Reformer" class="w-full" />
    </div>

    <!-- Body -->
    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold text-gray-700">Descripción *</label>
      <textarea pTextarea [(ngModel)]="form.body" rows="3" placeholder="Detalle de la noticia..." class="w-full" autoResize></textarea>
    </div>

    <!-- Tag + Tag Color -->
    <div class="grid grid-cols-2 gap-4">
      <div class="flex flex-col gap-1">
        <label class="text-sm font-semibold text-gray-700">Etiqueta</label>
        <input pInputText [(ngModel)]="form.tag" placeholder="Ej: 18 ABR, NUEVO" class="w-full" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-sm font-semibold text-gray-700">Color etiqueta</label>
        <p-select
          [(ngModel)]="form.tag_color"
          [options]="tagColorOptions"
          optionLabel="label"
          optionValue="value"
          styleClass="w-full">
        </p-select>
      </div>
    </div>

    <!-- CTA Link -->
    <div class="grid grid-cols-2 gap-4">
      <div class="flex flex-col gap-1">
        <label class="text-sm font-semibold text-gray-700">Texto del botón CTA</label>
        <input pInputText [(ngModel)]="form.link_label" placeholder="Ej: Ver más" class="w-full" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-sm font-semibold text-gray-700">URL del botón CTA</label>
        <input pInputText [(ngModel)]="form.link_url" placeholder="Ej: /dashboard/reservas" class="w-full" />
      </div>
    </div>

    <!-- Image upload -->
    <div class="flex flex-col gap-2">
      <label class="text-sm font-semibold text-gray-700">Imagen</label>
      @if (form.image_url) {
        <div class="relative w-full h-36 rounded-lg overflow-hidden border border-gray-200">
          <img [src]="form.image_url" alt="Preview" class="w-full h-full object-cover" />
          <button
            type="button"
            (click)="removeImage()"
            class="absolute top-2 right-2 bg-red-500 text-white rounded-full w-7 h-7 flex items-center justify-center shadow">
            <i class="pi pi-times text-xs"></i>
          </button>
        </div>
      } @else {
        <label class="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
          @if (uploadingImage()) {
            <i class="pi pi-spin pi-spinner text-2xl text-blue-500"></i>
            <span class="text-sm text-gray-500 mt-1">Subiendo imagen...</span>
          } @else {
            <i class="pi pi-image text-3xl text-gray-400"></i>
            <span class="text-sm text-gray-500 mt-1">Haz clic para subir imagen</span>
            <span class="text-xs text-gray-400">JPG, PNG, WEBP — máx 5 MB</span>
          }
          <input type="file" class="hidden" accept="image/*" (change)="onFileSelected($event)" [disabled]="uploadingImage()" />
        </label>
      }
    </div>

    <!-- Toggles -->
    <div class="flex flex-col gap-3 p-4 bg-gray-50 rounded-lg">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-semibold text-gray-700">Activo</p>
          <p class="text-xs text-gray-500">Si está activo aparecerá en el dashboard del cliente</p>
        </div>
        <p-toggleSwitch [(ngModel)]="form.is_active" />
      </div>
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-semibold text-gray-700">Enviar notificación push</p>
          <p class="text-xs text-gray-500">Se enviará una notificación a todos los usuarios</p>
        </div>
        <p-toggleSwitch [(ngModel)]="form.send_notification" />
      </div>
    </div>

    <!-- Scheduled date -->
    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold text-gray-700">Publicación programada</label>
      <p class="text-xs text-gray-500 -mt-0.5">Deja vacío para publicar inmediatamente al activar</p>
      <p-datepicker
        [(ngModel)]="scheduledDate"
        [showTime]="true"
        [showButtonBar]="true"
        [minDate]="minDate"
        placeholder="Selecciona fecha y hora"
        dateFormat="dd/mm/yy"
        styleClass="w-full">
      </p-datepicker>
    </div>

  </div>

  <ng-template pTemplate="footer">
    <div class="flex justify-end gap-3">
      <p-button label="Cancelar" severity="secondary" [outlined]="true" (onClick)="close()" />
      <p-button
        [label]="editingItem() ? 'Guardar cambios' : 'Crear noticia'"
        icon="pi pi-check"
        [loading]="saving()"
        (onClick)="save()" />
    </div>
  </ng-template>
</p-dialog>
  `
})
export class AdminNewsDialog implements OnChanges {
  private newsService = inject(NewsService);
  private supabaseService = inject(SupabaseService);
  private messageService = inject(MessageService);

  visible = model<boolean>(false);
  editingItem = input<NewsItem | null>(null);
  success = output<void>();

  saving = signal(false);
  uploadingImage = signal(false);

  minDate = new Date();
  scheduledDate: Date | null = null;

  tagColorOptions = [
    { label: 'Rojo', value: 'red' },
    { label: 'Azul', value: 'blue' },
    { label: 'Verde', value: 'green' },
    { label: 'Ámbar', value: 'amber' },
    { label: 'Morado', value: 'purple' }
  ];

  form: NewsCreateInput = this.emptyForm();

  ngOnChanges(changes: SimpleChanges) {
    if (changes['editingItem']) {
      const item = this.editingItem();
      if (item) {
        this.form = {
          title: item.title,
          body: item.body,
          tag: item.tag ?? '',
          tag_color: item.tag_color ?? 'red',
          image_url: item.image_url ?? '',
          link_label: item.link_label ?? '',
          link_url: item.link_url ?? '',
          is_active: item.is_active,
          send_notification: item.send_notification,
          scheduled_at: item.scheduled_at
        };
        this.scheduledDate = item.scheduled_at ? new Date(item.scheduled_at) : null;
      } else {
        this.resetForm();
      }
    }
  }

  private emptyForm(): NewsCreateInput {
    return {
      title: '',
      body: '',
      tag: '',
      tag_color: 'red',
      image_url: '',
      link_label: '',
      link_url: '',
      is_active: false,
      send_notification: false,
      scheduled_at: null
    };
  }

  resetForm() {
    this.form = this.emptyForm();
    this.scheduledDate = null;
  }

  close() {
    this.visible.set(false);
  }

  removeImage() {
    this.form.image_url = '';
  }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      this.messageService.add({ severity: 'warn', summary: 'Archivo muy grande', detail: 'Máximo 5 MB permitido' });
      return;
    }

    this.uploadingImage.set(true);
    try {
      const tempId = this.editingItem()?.id ?? crypto.randomUUID();
      const url = await this.newsService.uploadImage(file, tempId);
      this.form.image_url = url;
    } catch (e: any) {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo subir la imagen' });
    } finally {
      this.uploadingImage.set(false);
    }
  }

  async save() {
    if (!this.form.title.trim() || !this.form.body.trim()) {
      this.messageService.add({ severity: 'warn', summary: 'Campos requeridos', detail: 'Título y descripción son obligatorios' });
      return;
    }

    this.saving.set(true);
    try {
      const payload: NewsCreateInput = {
        ...this.form,
        scheduled_at: this.scheduledDate ? this.scheduledDate.toISOString() : null
      };

      const editing = this.editingItem();
      if (editing) {
        await this.newsService.updateNews(editing.id, payload);
        this.messageService.add({ severity: 'success', summary: 'Guardado', detail: 'Noticia actualizada correctamente' });
      } else {
        const user = this.supabaseService.getUser();
        await this.newsService.createNews(payload, user?.id ?? '');
        this.messageService.add({ severity: 'success', summary: 'Creada', detail: 'Noticia creada correctamente' });
      }

      this.visible.set(false);
      this.resetForm();
      this.success.emit();
    } catch (e: any) {
      this.messageService.add({ severity: 'error', summary: 'Error', detail: e.message ?? 'Error al guardar la noticia' });
    } finally {
      this.saving.set(false);
    }
  }
}
