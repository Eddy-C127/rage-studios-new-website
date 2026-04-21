import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { SupabaseService } from '../services/supabase-service';

export const landingGuard: CanActivateFn = async () => {
  const supabaseService = inject(SupabaseService);
  const router = inject(Router);

  try {
    const { data: { session } } = await supabaseService.client.auth.getSession();
    if (!session?.user) return true;

    const profile = await supabaseService.getProfile(session.user.id);
    if (profile?.role === 'admin') {
      router.navigate(['/admin']);
    } else {
      router.navigate(['/dashboard']);
    }
    return false;
  } catch {
    return true;
  }
};
