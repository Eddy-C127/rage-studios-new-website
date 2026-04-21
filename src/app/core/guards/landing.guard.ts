import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { SupabaseService } from '../services/supabase-service';

export const landingGuard: CanActivateFn = async () => {
  const supabaseService = inject(SupabaseService);
  const router = inject(Router);

  const user = supabaseService.getUser();
  if (!user) return true;

  try {
    const profile = await supabaseService.getProfile(user.id);
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
