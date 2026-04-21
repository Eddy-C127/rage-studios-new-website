import { Injectable, inject } from '@angular/core';
import { signal } from '@angular/core';
import { SupabaseService } from './supabase-service';

export interface ScheduleSlot {
  id: string;
  day_of_week: number;
  day_name: string;
  start_time: string;
  end_time: string;
  is_active: boolean;
  max_capacity: number;
  description?: string;
  coaches: Coach[];
}

export interface Coach {
  id: string;
  name: string;
  image_url?: string;
  is_primary: boolean;
}

export interface ScheduleSlotOverride {
  id: string;
  schedule_slot_id: string;
  override_date: string; // YYYY-MM-DD format
  description?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Datos del slot original (para referencia)
  slot_day_of_week: number;
  slot_day_name: string;
  slot_start_time: string;
  slot_end_time: string;
  // Coaches asignados al override
  coaches: Coach[];
}

export interface TimeSlot {
  time: string;
  coach: string;
  available: boolean;
  occupiedBeds: number;
  slot_id?: string;
}

@Injectable({
  providedIn: 'root',
})
export class ScheduleService {
  private supabaseService = inject(SupabaseService);
  private _scheduleCache = signal<ScheduleSlot[]>([]);
  private _lastCacheUpdate = signal<Date | null>(null);
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutos

  constructor() {
    // Ya no necesitamos crear una instancia independiente
  }

  /**
   * Obtiene todos los horarios con sus coaches asignados
   */
  async getAllScheduleSlots(forceRefresh = false): Promise<ScheduleSlot[]> {
    const cachedData = this._scheduleCache();
    const lastUpdate = this._lastCacheUpdate();
    const now = new Date();

    // Usar cache si es válido y no se fuerza el refresh
    if (!forceRefresh && cachedData.length > 0 && lastUpdate) {
      const cacheAge = now.getTime() - lastUpdate.getTime();
      if (cacheAge < this.CACHE_DURATION_MS) {
        return cachedData;
      }
    }

    try {
      const { data, error } = await this.supabaseService.client
        .rpc('get_schedule_slots_with_coaches');

      if (error) throw error;

      const scheduleSlots: ScheduleSlot[] = (data || []).map((row: any) => ({
        id: row.slot_id,
        day_of_week: row.day_of_week,
        day_name: row.day_name,
        start_time: row.start_time,
        end_time: row.end_time,
        is_active: row.is_active,
        max_capacity: row.max_capacity,
        description: row.description,
        coaches: row.coaches || []
      }));

      // Actualizar cache
      this._scheduleCache.set(scheduleSlots);
      this._lastCacheUpdate.set(now);

      return scheduleSlots;
    } catch (error) {
      console.error('Error fetching schedule slots:', error);
      return cachedData; // Retornar cache anterior en caso de error
    }
  }

  /**
   * Obtiene horarios para un día específico de la semana
   */
  async getScheduleSlotsForDay(dayOfWeek: number): Promise<ScheduleSlot[]> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('get_schedule_slots_with_coaches', { target_day_of_week: dayOfWeek });

      if (error) throw error;

      return (data || []).map((row: any) => ({
        id: row.slot_id,
        day_of_week: row.day_of_week,
        day_name: row.day_name,
        start_time: row.start_time,
        end_time: row.end_time,
        is_active: row.is_active,
        max_capacity: row.max_capacity,
        description: row.description,
        coaches: row.coaches || []
      }));
    } catch (error) {
      console.error('Error fetching schedule slots for day:', error);
      return [];
    }
  }

  /**
   * Convierte ScheduleSlots a TimeSlots compatibles con BookingService
   * IMPORTANTE: Este método consulta PRIMERO las excepciones para la fecha específica
   * Si existe una excepción, usa los coaches de la excepción en lugar de los regulares
   */
  async getDayScheduleAsTimeSlots(date: Date | string): Promise<TimeSlot[]> {
    let dayIndex: number;
    let dateStr: string;

    if (typeof date === 'string') {
      dateStr = date;
      const [year, month, day] = date.split('-').map(Number);
      const localDate = new Date(year, month - 1, day);
      dayIndex = localDate.getDay();
    } else {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
      dayIndex = date.getDay();
    }

    // Convertir domingo (0) a 7 para match con BD
    const dayOfWeek = dayIndex === 0 ? 7 : dayIndex;

    // Obtener horarios regulares del día
    const scheduleSlots = await this.getScheduleSlotsForDay(dayOfWeek);

    // 🔔 CONSULTAR EXCEPCIONES PARA ESTA FECHA ESPECÍFICA
    const overrides = await this.getAllScheduleOverrides(dateStr, dateStr);

    // Si hay excepciones, reemplazar los coaches de los slots afectados
    if (overrides.length > 0) {
      const slotsWithOverrides = scheduleSlots.map(slot => {
        const override = overrides.find(o => o.schedule_slot_id === slot.id);

        if (override) {
          // Este slot tiene una excepción para esta fecha
          // Reemplazar los coaches con los de la excepción
          return {
            ...slot,
            coaches: override.coaches
          };
        }

        // Este slot no tiene excepción, usar coaches regulares
        return slot;
      });

      return this.convertScheduleSlotsToTimeSlots(slotsWithOverrides);
    }

    // No hay excepciones, usar horarios regulares
    return this.convertScheduleSlotsToTimeSlots(scheduleSlots);
  }

  /**
   * Convierte ScheduleSlots a formato TimeSlot para retrocompatibilidad.
   * Cada slot de BD representa una clase individual, no un rango de horas.
   */
  private convertScheduleSlotsToTimeSlots(scheduleSlots: ScheduleSlot[]): TimeSlot[] {
    const timeSlots: TimeSlot[] = scheduleSlots.map(slot => ({
      time: slot.start_time.substring(0, 5), // "HH:MM" preservando minutos
      coach: this.formatCoachNames(slot.coaches),
      available: true,
      occupiedBeds: 0,
      slot_id: slot.id
    }));

    return timeSlots.sort((a, b) => a.time.localeCompare(b.time));
  }

  /**
   * Formatea nombres de coaches según el formato existente
   */
  private formatCoachNames(coaches: Coach[]): string {
    if (coaches.length === 0) return '';
    if (coaches.length === 1) return coaches[0].name;

    const primaryCoach = coaches.find(c => c.is_primary);
    const otherCoaches = coaches.filter(c => !c.is_primary);

    if (primaryCoach && otherCoaches.length > 0) {
      return `${primaryCoach.name}/${otherCoaches.map(c => c.name).join('/')}`;
    }

    return coaches.map(c => c.name).join('/');
  }

  /**
   * ADMIN: Crear nuevo slot de horario
   */
  async createScheduleSlot(slot: Omit<ScheduleSlot, 'id' | 'coaches'>): Promise<{ success: boolean; error?: string; slot_id?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('create_schedule_slot_admin', {
          p_day_of_week: slot.day_of_week,
          p_day_name: slot.day_name,
          p_start_time: slot.start_time,
          p_end_time: slot.end_time,
          p_is_active: slot.is_active,
          p_max_capacity: slot.max_capacity,
          p_description: slot.description
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      // Invalidar cache
      this._lastCacheUpdate.set(null);

      return { success: true, slot_id: result.slot_id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ADMIN: Actualizar slot de horario
   */
  async updateScheduleSlot(slotId: string, updates: Partial<Omit<ScheduleSlot, 'id' | 'coaches'>>): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('update_schedule_slot_admin', {
          p_slot_id: slotId,
          p_day_of_week: updates.day_of_week || null,
          p_day_name: updates.day_name || null,
          p_start_time: updates.start_time || null,
          p_end_time: updates.end_time || null,
          p_is_active: updates.is_active ?? null,
          p_max_capacity: updates.max_capacity || null,
          p_description: updates.description || null
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      // Invalidar cache
      this._lastCacheUpdate.set(null);

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ADMIN: Eliminar slot de horario
   */
  async deleteScheduleSlot(slotId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('delete_schedule_slot_admin', {
          p_slot_id: slotId
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      // Invalidar cache
      this._lastCacheUpdate.set(null);

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ADMIN: Asignar coach a slot
   */
  async assignCoachToSlot(slotId: string, coachId: string, isPrimary = false): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('assign_coach_to_slot_admin', {
          p_slot_id: slotId,
          p_coach_id: coachId,
          p_is_primary: isPrimary
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      // Invalidar cache
      this._lastCacheUpdate.set(null);

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ADMIN: Remover coach de slot
   */
  async removeCoachFromSlot(slotId: string, coachId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('remove_coach_from_slot_admin', {
          p_slot_id: slotId,
          p_coach_id: coachId
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      // Invalidar cache
      this._lastCacheUpdate.set(null);

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Obtener todos los coaches disponibles
   */
  async getAllCoaches(): Promise<any[]> {
    try {
      const { data, error } = await this.supabaseService.client
        .from('coaches')
        .select('*')
        .eq('is_active', true)
        .order('order_index');

      if (error) throw error;

      return data || [];
    } catch (error) {
      console.error('Error fetching coaches:', error);
      return [];
    }
  }

  /**
   * Invalidar cache manualmente
   */
  invalidateCache(): void {
    this._lastCacheUpdate.set(null);
    this._scheduleCache.set([]);
  }

  /**
   * Obtener estado del cache
   */
  get cacheInfo() {
    return {
      hasCache: this._scheduleCache().length > 0,
      lastUpdate: this._lastCacheUpdate(),
      itemCount: this._scheduleCache().length
    };
  }

  // ============================================================================
  // MÉTODOS PARA EXCEPCIONES (OVERRIDES)
  // ============================================================================

  /**
   * Obtener todas las excepciones con sus coaches asignados
   * @param fromDate Fecha de inicio (opcional, por defecto hoy)
   * @param toDate Fecha final (opcional)
   * @param scheduleSlotId Filtrar por horario específico (opcional)
   */
  async getAllScheduleOverrides(
    fromDate?: string,
    toDate?: string,
    scheduleSlotId?: string
  ): Promise<ScheduleSlotOverride[]> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('get_schedule_overrides_with_coaches', {
          p_from_date: fromDate || null,
          p_to_date: toDate || null,
          p_schedule_slot_id: scheduleSlotId || null
        });

      if (error) throw error;

      return (data || []).map((row: any) => ({
        id: row.override_id,
        schedule_slot_id: row.schedule_slot_id,
        override_date: row.override_date,
        description: row.description,
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at,
        slot_day_of_week: row.slot_day_of_week,
        slot_day_name: row.slot_day_name,
        slot_start_time: row.slot_start_time,
        slot_end_time: row.slot_end_time,
        coaches: row.coaches || []
      }));
    } catch (error) {
      console.error('Error fetching schedule overrides:', error);
      return [];
    }
  }

  /**
   * Obtener excepciones para un horario específico
   */
  async getOverridesForSlot(scheduleSlotId: string): Promise<ScheduleSlotOverride[]> {
    return this.getAllScheduleOverrides(undefined, undefined, scheduleSlotId);
  }

  /**
   * Verificar si existe una excepción para una fecha y horario específicos
   */
  async getOverrideForDate(
    scheduleSlotId: string,
    date: string
  ): Promise<ScheduleSlotOverride | null> {
    const overrides = await this.getAllScheduleOverrides(date, date, scheduleSlotId);
    return overrides.length > 0 ? overrides[0] : null;
  }

  /**
   * ADMIN: Crear nueva excepción de horario
   */
  async createScheduleOverride(
    scheduleSlotId: string,
    overrideDate: string,
    description?: string
  ): Promise<{ success: boolean; error?: string; override_id?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('create_schedule_override_admin', {
          p_schedule_slot_id: scheduleSlotId,
          p_override_date: overrideDate,
          p_description: description || null
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      return { success: true, override_id: result.override_id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ADMIN: Actualizar excepción existente
   */
  async updateScheduleOverride(
    overrideId: string,
    updates: {
      override_date?: string;
      description?: string;
      is_active?: boolean;
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('update_schedule_override_admin', {
          p_override_id: overrideId,
          p_override_date: updates.override_date || null,
          p_description: updates.description || null,
          p_is_active: updates.is_active ?? null
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ADMIN: Eliminar excepción
   */
  async deleteScheduleOverride(overrideId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('delete_schedule_override_admin', {
          p_override_id: overrideId
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ADMIN: Asignar coach a excepción
   */
  async assignCoachToOverride(
    overrideId: string,
    coachId: string,
    isPrimary = false
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('assign_coach_to_override_admin', {
          p_override_id: overrideId,
          p_coach_id: coachId,
          p_is_primary: isPrimary
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ADMIN: Remover coach de excepción
   */
  async removeCoachFromOverride(
    overrideId: string,
    coachId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await this.supabaseService.client
        .rpc('remove_coach_from_override_admin', {
          p_override_id: overrideId,
          p_coach_id: coachId
        });

      if (error) throw error;

      const result = data?.[0];
      if (!result?.success) {
        return { success: false, error: result?.error_message || 'Error desconocido' };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}