-- ============================================================================
-- MIGRATION (QA fixes): blindar resumen de racha + RPCs de entregas de premios
-- Date: 2026-06-20
-- Description:
--   1) get_user_streak_summary ahora solo deja consultar la racha propia (o admin).
--   2) RPCs para que recepción liste y entregue los premios físicos reclamados
--      (reward_redemptions en estado 'pending').
-- ============================================================================

-- 1) Blindar el resumen de racha (evita leer la racha de otro usuario) ─────────
CREATE OR REPLACE FUNCTION public.get_user_streak_summary(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v record;
  v_today date := public.mx_today();
  v_daily_eff int := 0;
  v_sunday_eff int := 0;
  v_cur_sun date;
  v_grace date;
  v_empty jsonb := jsonb_build_object('daily_streak',0,'sunday_streak',0,'cumulative_classes',0,'longest_daily_streak',0);
BEGIN
  -- Solo la racha propia (o un admin)
  IF p_user_id IS NULL OR (p_user_id <> auth.uid() AND NOT public.is_admin()) THEN
    RETURN v_empty;
  END IF;

  SELECT * INTO v FROM public.user_streaks WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN v_empty;
  END IF;

  IF v.last_attended_date IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM generate_series((v.last_attended_date + 1)::timestamp, (v_today - 1)::timestamp, INTERVAL '1 day') g(d)
      WHERE public.is_studio_open(g.d::date)
    ) THEN
      v_daily_eff := v.daily_streak;
    END IF;
  END IF;

  IF v.last_sunday_date IS NOT NULL THEN
    v_cur_sun := v_today - (EXTRACT(isodow FROM v_today)::int % 7);
    IF EXTRACT(isodow FROM v_today)::int = 7 THEN
      v_grace := v_cur_sun - 7;
    ELSE
      v_grace := v_cur_sun;
    END IF;
    IF v.last_sunday_date >= v_grace THEN
      v_sunday_eff := v.sunday_streak;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'daily_streak', v_daily_eff,
    'sunday_streak', v_sunday_eff,
    'cumulative_classes', v.cumulative_classes,
    'longest_daily_streak', v.longest_daily_streak
  );
END;
$$;

-- 2) Entregas de premios físicos (recepción) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_reward_redemptions(p_status text DEFAULT 'pending')
RETURNS TABLE(
  id uuid, user_id uuid, user_name text, user_phone text,
  reward_name text, reward_type text, status text, created_at timestamptz, delivered_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'NOT_ADMIN';
  END IF;

  RETURN QUERY
  SELECT rr.id, rr.user_id, p.full_name, p.phone,
         r.name, r.type, rr.status, rr.created_at, rr.delivered_at
  FROM public.reward_redemptions rr
  LEFT JOIN public.profiles p ON p.id = rr.user_id
  LEFT JOIN public.rewards r ON r.id = rr.reward_id
  WHERE (p_status IS NULL OR rr.status = p_status)
  ORDER BY rr.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_mark_redemption_delivered(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('status_code', 'NOT_ADMIN', 'message', 'No autorizado');
  END IF;

  UPDATE public.reward_redemptions
    SET status = 'delivered', delivered_by = auth.uid(), delivered_at = now()
  WHERE id = p_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status_code', 'NOT_FOUND', 'message', 'Canje no encontrado o ya entregado');
  END IF;

  RETURN jsonb_build_object('status_code', 'OK', 'message', 'Entregado');
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_reward_redemptions(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.admin_mark_redemption_delivered(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_reward_redemptions(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_mark_redemption_delivered(uuid) TO authenticated;
