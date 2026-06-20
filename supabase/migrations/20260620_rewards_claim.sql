-- ============================================================================
-- MIGRATION: Reclamo de recompensas + cupones y canjes (Fase C)
-- Date: 2026-06-20
-- Description:
--   Añade las tablas de cupones personales (coupons) y canjes de premios físicos
--   (reward_redemptions), y la RPC claim_achievement_reward que la clienta usa
--   para reclamar un logro desbloqueado.
--
--   Mecánica "cofre" confirmada con el cliente: la clienta acumula racha y decide
--   cuándo reclamar. AL RECLAMAR, la racha correspondiente vuelve a 0 (se mueve el
--   ancla) y se cierran los demás logros desbloqueados de ese ciclo.
--
--   Según el tipo de recompensa:
--     - discount_coupon → crea un cupón personal (coupons) usable en checkout.
--     - free_credits    → otorga créditos (credit_batches + credit_history).
--     - physical_perk   → crea un canje 'pending' (recepción lo entrega).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reward_id uuid REFERENCES public.rewards(id) ON DELETE SET NULL,
  code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired')),
  discount_percent integer NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  applicable_package_ids uuid[] DEFAULT NULL,   -- NULL/vacío = todos
  source text NOT NULL DEFAULT 'achievement',   -- achievement | manual
  expires_at timestamptz,
  used_at timestamptz,
  used_purchase_id uuid REFERENCES public.purchases(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE INDEX IF NOT EXISTS idx_coupons_user ON public.coupons(user_id, status);

CREATE TABLE IF NOT EXISTS public.reward_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reward_id uuid REFERENCES public.rewards(id) ON DELETE SET NULL,
  source_achievement_id uuid REFERENCES public.achievements(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','expired')),
  delivered_by uuid,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_user ON public.reward_redemptions(user_id, status);

-- Vincular user_achievements con lo que generó (para trazabilidad / UI)
ALTER TABLE public.user_achievements
  ADD COLUMN IF NOT EXISTS coupon_id uuid REFERENCES public.coupons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS redemption_id uuid REFERENCES public.reward_redemptions(id) ON DELETE SET NULL;

-- Genera un código de cupón legible y único
CREATE OR REPLACE FUNCTION public.generate_coupon_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_code text;
BEGIN
  LOOP
    v_code := 'RG' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.coupons WHERE code = v_code);
  END LOOP;
  RETURN v_code;
END;
$$;

-- ── Reclamo de recompensa ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_achievement_reward(p_achievement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_ua public.user_achievements%ROWTYPE;
  v_ach public.achievements%ROWTYPE;
  v_reward public.rewards%ROWTYPE;
  v_code text;
  v_percent int;
  v_credits int;
  v_validity int;
  v_batch_id uuid;
  v_coupon_id uuid;
  v_redemption_id uuid;
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status_code', 'UNAUTHENTICATED', 'message', 'No autenticado');
  END IF;

  SELECT * INTO v_ach FROM public.achievements WHERE id = p_achievement_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status_code', 'NOT_FOUND', 'message', 'Logro no encontrado');
  END IF;

  -- Tomar el logro desbloqueado y sin reclamar del usuario (bloqueo de fila)
  SELECT * INTO v_ua
  FROM public.user_achievements
  WHERE user_id = v_user AND achievement_id = p_achievement_id
    AND claimed_at IS NULL AND cycle_closed = false
  ORDER BY unlocked_at ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status_code', 'NOT_CLAIMABLE', 'message', 'No tienes este logro disponible para reclamar');
  END IF;

  IF v_ach.reward_id IS NULL THEN
    RETURN jsonb_build_object('status_code', 'NO_REWARD', 'message', 'Este logro no tiene recompensa asociada');
  END IF;

  SELECT * INTO v_reward FROM public.rewards WHERE id = v_ach.reward_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status_code', 'REWARD_INACTIVE', 'message', 'La recompensa ya no está disponible');
  END IF;

  -- Entregar según el tipo
  IF v_reward.type = 'discount_coupon' THEN
    v_percent := COALESCE((v_reward.value->>'percent')::int, 0);
    IF v_percent < 1 THEN
      RETURN jsonb_build_object('status_code', 'INVALID_REWARD', 'message', 'Cupón mal configurado');
    END IF;
    v_code := public.generate_coupon_code();
    INSERT INTO public.coupons (user_id, reward_id, code, discount_percent, applicable_package_ids, source, expires_at, created_by)
    VALUES (v_user, v_reward.id, v_code, v_percent, v_reward.applicable_package_ids, 'achievement', now() + INTERVAL '90 days', v_user)
    RETURNING id INTO v_coupon_id;
    v_result := jsonb_build_object('reward_type', 'discount_coupon', 'coupon_code', v_code, 'discount_percent', v_percent);

  ELSIF v_reward.type = 'free_credits' THEN
    v_credits := COALESCE((v_reward.value->>'credits')::int, 0);
    v_validity := COALESCE((v_reward.value->>'validity_days')::int, 30);
    IF v_credits < 1 THEN
      RETURN jsonb_build_object('status_code', 'INVALID_REWARD', 'message', 'Recompensa de créditos mal configurada');
    END IF;
    INSERT INTO public.credit_batches (user_id, credits_total, credits_remaining, validity_days, is_unlimited, expiration_activated)
    VALUES (v_user, v_credits, v_credits, v_validity, false, false)
    RETURNING id INTO v_batch_id;
    INSERT INTO public.credit_history (user_id, credit_batch_id, type, amount, description)
    VALUES (v_user, v_batch_id, 'added', v_credits, 'Crédito de regalo por logro: ' || v_ach.name);
    v_result := jsonb_build_object('reward_type', 'free_credits', 'credits', v_credits);

  ELSIF v_reward.type IN ('physical_perk', 'gift_card') THEN
    INSERT INTO public.reward_redemptions (user_id, reward_id, source_achievement_id, status)
    VALUES (v_user, v_reward.id, v_ach.id, 'pending')
    RETURNING id INTO v_redemption_id;
    v_result := jsonb_build_object('reward_type', v_reward.type, 'redemption_id', v_redemption_id);

  ELSE
    RETURN jsonb_build_object('status_code', 'INVALID_REWARD', 'message', 'Tipo de recompensa no soportado');
  END IF;

  -- Marcar el logro como reclamado
  UPDATE public.user_achievements
  SET claimed_at = now(), coupon_id = v_coupon_id, redemption_id = v_redemption_id
  WHERE id = v_ua.id;

  -- Reiniciar la racha correspondiente (mecánica "cofre") y cerrar el ciclo
  IF v_ach.condition_type = 'daily_streak' THEN
    UPDATE public.user_streaks
    SET daily_streak = 0, daily_streak_start_date = public.mx_today() + 1, updated_at = now()
    WHERE user_id = v_user;
    -- Cerrar otros logros diarios desbloqueados sin reclamar de este ciclo
    UPDATE public.user_achievements ua
    SET cycle_closed = true
    FROM public.achievements a
    WHERE ua.achievement_id = a.id
      AND ua.user_id = v_user
      AND ua.claimed_at IS NULL
      AND ua.cycle_closed = false
      AND a.condition_type = 'daily_streak';

  ELSIF v_ach.condition_type = 'sunday_streak' THEN
    UPDATE public.user_streaks
    SET sunday_streak = 0, sunday_streak_start_date = public.mx_today() + 1, updated_at = now()
    WHERE user_id = v_user;
    UPDATE public.user_achievements ua
    SET cycle_closed = true
    FROM public.achievements a
    WHERE ua.achievement_id = a.id
      AND ua.user_id = v_user
      AND ua.claimed_at IS NULL
      AND ua.cycle_closed = false
      AND a.condition_type = 'sunday_streak';
  END IF;

  RETURN v_result || jsonb_build_object('status_code', 'OK', 'message', '¡Recompensa reclamada!', 'reward_name', v_reward.name);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('status_code', 'ERROR', 'message', 'No se pudo reclamar: ' || SQLERRM);
END;
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_redemptions ENABLE ROW LEVEL SECURITY;

-- El usuario ve sus propios cupones; admin ve todo. Escritura solo vía funciones.
CREATE POLICY coupons_select_own ON public.coupons
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());

-- Canjes: usuario ve los suyos; admin gestiona (marca entregado).
CREATE POLICY reward_redemptions_select_own ON public.reward_redemptions
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());
CREATE POLICY reward_redemptions_admin_update ON public.reward_redemptions
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT EXECUTE ON FUNCTION public.claim_achievement_reward(uuid) TO authenticated;
