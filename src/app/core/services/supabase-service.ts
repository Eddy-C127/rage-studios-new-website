import { Injectable, signal, PLATFORM_ID, Inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';
import { BehaviorSubject, Observable, debounceTime, distinctUntilChanged } from 'rxjs';
import { AuthTokenManagerService } from './auth-token-manager.service';
import { getTodayLocalYYYYMMDD, formatDateToLocalYYYYMMDD } from '../functions/date-utils';

export interface Profile {
  id: string;
  full_name: string;
  phone: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface UserSearchResult {
  id: string;
  full_name: string;
  phone: string;
  role: string;
}

export interface AdminStats {
  totalReservas: number;
  reservasHoy: number;
  usuariosActivos: number;
  creditosTotales: number;
}

@Injectable({
  providedIn: 'root'
})
export class SupabaseService {
  private supabaseClient: SupabaseClient;
  private currentUser = new BehaviorSubject<User | null>(null);
  public currentUser$ = this.currentUser.asObservable().pipe(
    // 🔄 IMPROVED DEBOUNCING: Increased to 500ms and added distinctUntilChanged
    debounceTime(500), // 🔄 INCREASED from 50ms to 500ms
    distinctUntilChanged((prev, curr) => prev?.id === curr?.id) // 🔄 PREVENT DUPLICATE EMISSIONS
  );
  private isBrowser: boolean;
  private tokenManager: AuthTokenManagerService;
  
  // 🔄 SSR OPTIMIZATION: Prevent duplicate initialization during hydration
  private userLoadAttempted = false;
  
  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    this.isBrowser = isPlatformBrowser(platformId);
    this.tokenManager = new AuthTokenManagerService(platformId);
    
    this.supabaseClient = createClient(environment.SUPABASE_URL, environment.SUPABASE_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: this.isBrowser,
        detectSessionInUrl: this.isBrowser
      }
    });
    if (this.isBrowser) {
      this.loadUser();
    }
  }

  // Public getter para acceso controlado al client
  get client() {
    return this.supabaseClient;
  }

  private async loadUser() {
    // 🔄 SSR OPTIMIZATION: Prevent duplicate load during hydration
    if (this.isBrowser && !this.userLoadAttempted) {
      this.userLoadAttempted = true;
      
      try {
        const { data: { user } } = await this.supabaseClient.auth.getUser();
        this.currentUser.next(user);
      
      // Solo registrar un listener de estado de auth, con manejo de rate limiting
      this.supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'TOKEN_REFRESHED') {
          console.log('🔄 Token refreshed successfully');
          // No emitir cambios solo por refresh de token para reducir rate limiting
          return;
        }
        
        if (event === 'SIGNED_OUT') {
          this.tokenManager.reset();
        }
        
        // Para eventos importantes (SIGNED_IN, SIGNED_OUT), siempre emitir
        // Para otros eventos, solo emitir si hay cambio real en el usuario
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
          this.currentUser.next(session?.user ?? null);
        } else {
          // Para otros eventos, verificar cambios
          const currentUserId = this.currentUser.value?.id;
          const newUserId = session?.user?.id;
          if (currentUserId !== newUserId) {
            this.currentUser.next(session?.user ?? null);
          }
        }
      });
      } catch (error) {
        console.warn('Error loading user:', error);
        this.currentUser.next(null);
      }
    }
  }

  // Método optimizado para obtener sesión con throttling coordinado
  async getSessionSafe() {
    if (!this.isBrowser) {
      return { data: { session: null }, error: null };
    }
    
    const result = await this.tokenManager.executeTokenRefresh(async () => {
      return await this.supabaseClient.auth.getSession();
    }).catch(error => {
      console.warn('Session refresh failed:', error);
      return { data: { session: null }, error };
    });
    
    return result || { data: { session: null }, error: null };
  }

  // Método para obtener el estado del token manager
  getTokenManagerStatus() {
    return this.tokenManager.getRefreshStatus();
  }

  async signIn(email: string, password: string) {
    const { data, error } = await this.supabaseClient.auth.signInWithPassword({
      email,
      password
    });
    
    if (error) throw error;
    return data;
  }

  async signUp(email: string, password: string, fullName: string, phone: string) {
    const { data, error } = await this.supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          phone: phone // Respaldo en metadata
        }
      }
    });
    
    if (error) throw error;
    
    if (data.user) {
      // Intentar actualizar perfil con retry logic
      await this.updateProfileWithRetry(data.user.id, { full_name: fullName, phone });
    }
    
    return data;
  }

  private async updateProfileWithRetry(userId: string, updates: Partial<Profile>, maxRetries: number = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Esperar un poco más en cada intento para dar tiempo al trigger
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, attempt * 500));
        }
        
        const result = await this.updateProfile(userId, updates);
        return result; // Si es exitoso, salir del loop
      } catch (error: any) {
        console.warn(`Profile update attempt ${attempt} failed:`, error.message);
        
        if (attempt === maxRetries) {
          // En el último intento, intentar crear el perfil si no existe
          try {
            console.log('Attempting to create profile as fallback...');
            return await this.createProfile(userId, {
              ...updates,
              role: 'user' // Establecer rol por defecto
            });
          } catch (createError: any) {
            console.error('Both update and create profile failed:', createError.message);
            // No lanzar error para no interrumpir el registro
            // El usuario puede completar su perfil después
            return null;
          }
        }
      }
    }
    return null; // En caso de que todos los intentos fallen
  }

  async updateProfile(userId: string, updates: Partial<Profile>) {
    const { data, error } = await this.supabaseClient
      .from('profiles')
      .update(updates)
      .eq('id', userId);
    
    if (error) throw error;
    return data;
  }

  async getProfile(userId: string) {
    const { data, error } = await this.supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    
    if (error) throw error;
    return data as Profile | null;
  }
  
  async createProfile(userId: string, profileData: Partial<Profile>) {
    const { data, error } = await this.supabaseClient
      .from('profiles')
      .insert({
        id: userId,
        ...profileData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) throw error;
    return data as Profile;
  }

  async signOut() {
    const { error } = await this.supabaseClient.auth.signOut();
    if (error) throw error;
  }

  async resetPasswordForEmail(email: string) {
    const { data, error } = await this.supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: `${environment.baseUrl}/dashboard/cambiar-contrasena`
    });
    
    if (error) throw error;
    return data;
  }

  getUser() {
    return this.currentUser.value;
  }

  isLoggedIn() {
    return !!this.currentUser.value;
  }


async updatePassword(newPassword: string) {
  return await this.supabaseClient.auth.updateUser({
    password: newPassword
  });
}

// Admin Statistics Methods
async getAdminStats(): Promise<AdminStats> {
  try {
    const [totalReservas, reservasHoy, usuariosActivos, creditosTotales] = await Promise.all([
      this.getTotalBookings(),
      this.getTodaysBookings(),
      this.getActiveUsers(),
      this.getTotalCredits()
    ]);

    return {
      totalReservas,
      reservasHoy,
      usuariosActivos,
      creditosTotales
    };
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    throw error;
  }
}

private async getTotalBookings(): Promise<number> {
  const { count, error } = await this.supabaseClient
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');
  
  if (error) throw error;
  return count || 0;
}

private async getTodaysBookings(): Promise<number> {
  // ✅ FIX: Use local timezone to get today's date
  // CRITICAL: Prevents timezone bugs in Mexico (UTC-6)
  const today = getTodayLocalYYYYMMDD();

  console.log('📅 [SupabaseService] Getting today\'s bookings for date (local):', today);

  const { count, error } = await this.supabaseClient
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active')
    .eq('session_date', today);

  if (error) throw error;
  return count || 0;
}

private async getActiveUsers(): Promise<number> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoString = thirtyDaysAgo.toISOString();

  const { data, error } = await this.supabaseClient
    .from('bookings')
    .select('user_id')
    .gte('created_at', thirtyDaysAgoString);
  
  if (error) throw error;
  
  // Get unique user IDs
  const uniqueUserIds = new Set(data?.map(booking => booking.user_id));
  return uniqueUserIds.size;
}

private async getTotalCredits(): Promise<number> {
  // ✅ FIX: Solo contar créditos de batches no expirados para estadísticas precisas
  const { data, error } = await this.supabaseClient
    .from('credit_batches')
    .select('credits_remaining, expiration_date')
    .gt('credits_remaining', 0)
    .or('expiration_date.is.null,expiration_date.gt.' + new Date().toISOString());

  if (error) throw error;

  // Sum up all remaining credits
  const totalCredits = data?.reduce((sum, batch) => sum + (batch.credits_remaining || 0), 0) || 0;
  return totalCredits;
}

// Admin Bookings Management
async getAdminBookings(startDate: Date, endDate: Date, statusFilter: string = 'all'): Promise<any[]> {
  try {
    // ✅ FIX: Use local timezone conversion for date range
    // CRITICAL: Prevents timezone bugs in Mexico (UTC-6)
    const startDateString = formatDateToLocalYYYYMMDD(startDate);
    const endDateString = formatDateToLocalYYYYMMDD(endDate);

    console.log('📅 [SupabaseService] Getting admin bookings from', startDateString, 'to', endDateString, 'with status:', statusFilter);

    let query = this.supabaseClient
      .from('bookings')
      .select(`
        *,
        profiles!user_id (
          id,
          full_name,
          phone
        )
      `)
      .gte('session_date', startDateString)
      .lte('session_date', endDateString)
      .order('session_date', { ascending: true })
      .order('session_time', { ascending: true });

    // Apply status filter
    if (statusFilter === 'active') {
      query = query.eq('status', 'active');
    } else if (statusFilter === 'cancelled') {
      query = query.eq('status', 'cancelled');
    }
    // 'all' means no additional filter

    const { data, error } = await query;

    if (error) throw error;

    console.log(`📊 [SupabaseService] Found ${data?.length || 0} booking(s)`);

    return data || [];

  } catch (error) {
    console.error('Error fetching admin bookings:', error);
    throw error;
  }
}

async getAllBookingsStats(): Promise<{
  totalBookings: number;
  activeBookings: number;
  cancelledBookings: number;
  totalCreditsUsed: number;
}> {
  try {
    const { data, error } = await this.supabaseClient
      .from('bookings')
      .select('status, credits_used');

    if (error) throw error;

    const stats = {
      totalBookings: data?.length || 0,
      activeBookings: data?.filter(b => b.status === 'active').length || 0,
      cancelledBookings: data?.filter(b => b.status === 'cancelled').length || 0,
      totalCreditsUsed: data?.reduce((sum, b) => sum + (b.credits_used || 0), 0) || 0
    };

    return stats;
  } catch (error) {
    console.error('Error fetching booking stats:', error);
    throw error;
  }
}

// Admin Credits Management
async searchUsers(query: string): Promise<UserSearchResult[]> {
  if (!query || query.trim().length < 2) {
    return [];
  }

  try {
    const { data, error } = await this.supabaseClient
      .from('profiles')
      .select('id, full_name, phone, role')
      .or(`full_name.ilike.%${query}%,phone.ilike.%${query}%`)
      .limit(10)
      .order('full_name', { ascending: true });

    if (error) throw error;
    return data as UserSearchResult[] || [];
  } catch (error) {
    console.error('Error searching users:', error);
    throw error;
  }
}

async getAllUsers(): Promise<UserSearchResult[]> {
  try {
    const { data, error } = await this.supabaseClient
      .from('profiles')
      .select('id, full_name, phone, role')
      .order('full_name', { ascending: true });

    if (error) throw error;
    return data as UserSearchResult[] || [];
  } catch (error) {
    console.error('Error fetching all users:', error);
    throw error;
  }
}
}