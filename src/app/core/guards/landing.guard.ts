import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { SupabaseService } from '../services/supabase-service';

export const landingGuard: CanActivateFn = async () => {
  const supabaseService = inject(SupabaseService);
  const router = inject(Router);

  try {
    const { data: { session } } = await supabaseService.client.auth.getSession();
    if (!session?.user) return true;

    router.navigate(['/dashboard']);
    return false;
  } catch {
    return true;
  }
};
