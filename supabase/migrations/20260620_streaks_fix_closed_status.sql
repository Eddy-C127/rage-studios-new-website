-- ============================================================================
-- MIGRATION (FIX): el motor de rachas debe contar bookings 'closed', no solo 'active'
-- Date: 2026-06-20
-- Description:
--   close_past_bookings() mueve las reservas pasadas a status='closed'. La versión
--   inicial de recompute_user_streaks filtraba status='active', por lo que las
--   asistencias pasadas (la mayoría) no contaban y las rachas nunca acumulaban.
--   Se corrige a status <> 'cancelled' (incluye 'active' y 'closed') en todas las
--   consultas, y se re-ejecuta el backfill del acumulado.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.recompute_user_streaks(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_anchor_daily date;
  v_anchor_sunday date;
  v_longest int;
  v_cumulative int;
  v_last_attended date;
  v_last_sunday date;
  v_daily int := 0;
  v_sunday int := 0;
  d date;
  v_guard int := 0;
BEGIN
  INSERT INTO public.user_streaks(user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT daily_streak_start_date, sunday_streak_start_date, longest_daily_streak
    INTO v_anchor_daily, v_anchor_sunday, v_longest
  FROM public.user_streaks WHERE user_id = p_user_id;

  v_anchor_daily  := COALESCE(v_anchor_daily, DATE '1900-01-01');
  v_anchor_sunday := COALESCE(v_anchor_sunday, DATE '1900-01-01');
  v_longest := COALESCE(v_longest, 0);

  -- Acumulado de por vida (clases asistidas)
  SELECT count(*) INTO v_cumulative
  FROM public.bookings
  WHERE user_id = p_user_id AND status <> 'cancelled' AND attendance_status = 'attended' AND check_in_source IS NOT NULL;

  -- Racha diaria: caminar hacia atrás desde la última asistencia sobre días abiertos
  SELECT max(session_date) INTO v_last_attended
  FROM public.bookings
  WHERE user_id = p_user_id AND status <> 'cancelled' AND attendance_status = 'attended' AND check_in_source IS NOT NULL
    AND session_date >= v_anchor_daily;

  IF v_last_attended IS NOT NULL THEN
    d := v_last_attended;
    LOOP
      EXIT WHEN d < v_anchor_daily OR v_guard > 800;
      v_guard := v_guard + 1;
      IF NOT public.is_studio_open(d) THEN
        d := d - 1; CONTINUE;   -- día cerrado: no suma ni rompe
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bookings
        WHERE user_id = p_user_id AND status <> 'cancelled'
          AND attendance_status = 'attended' AND check_in_source IS NOT NULL AND session_date = d
      ) THEN
        v_daily := v_daily + 1;
        d := d - 1;
      ELSE
        EXIT;   -- día abierto sin asistencia: rompe
      END IF;
    END LOOP;
  END IF;

  -- Racha de domingos: domingos consecutivos asistidos
  SELECT max(session_date) INTO v_last_sunday
  FROM public.bookings
  WHERE user_id = p_user_id AND status <> 'cancelled' AND attendance_status = 'attended' AND check_in_source IS NOT NULL
    AND session_date >= v_anchor_sunday
    AND EXTRACT(isodow FROM session_date) = 7;

  IF v_last_sunday IS NOT NULL THEN
    d := v_last_sunday;
    v_guard := 0;
    LOOP
      EXIT WHEN d < v_anchor_sunday OR v_guard > 400;
      v_guard := v_guard + 1;
      IF EXISTS (
        SELECT 1 FROM public.bookings
        WHERE user_id = p_user_id AND status <> 'cancelled'
          AND attendance_status = 'attended' AND check_in_source IS NOT NULL AND session_date = d
      ) THEN
        v_sunday := v_sunday + 1;
        d := d - 7;
      ELSE
        EXIT;
      END IF;
    END LOOP;
  END IF;

  UPDATE public.user_streaks SET
    daily_streak         = v_daily,
    longest_daily_streak = GREATEST(v_longest, v_daily),
    sunday_streak        = v_sunday,
    cumulative_classes   = v_cumulative,
    last_attended_date   = v_last_attended,
    last_sunday_date     = v_last_sunday,
    updated_at           = now()
  WHERE user_id = p_user_id;

  PERFORM public.evaluate_achievements(p_user_id);
END;
$$;

-- Blindar el trigger: el cálculo de racha nunca debe romper una reserva/check-in.
CREATE OR REPLACE FUNCTION public.trg_attendance_streaks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.attendance_status = 'attended' THEN
        PERFORM public.recompute_user_streaks(NEW.user_id);
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.attendance_status IS DISTINCT FROM OLD.attendance_status
         OR NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM public.recompute_user_streaks(NEW.user_id);
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      PERFORM public.recompute_user_streaks(OLD.user_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trg_attendance_streaks failed for %: %',
      COALESCE(NEW.user_id, OLD.user_id), SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- Re-ejecutar backfill del acumulado con el filtro corregido (incluye 'closed')
INSERT INTO public.user_streaks (user_id, cumulative_classes, daily_streak, sunday_streak,
                                 daily_streak_start_date, sunday_streak_start_date)
SELECT b.user_id, count(*), 0, 0, public.mx_today(), public.mx_today()
FROM public.bookings b
WHERE b.status <> 'cancelled' AND b.attendance_status = 'attended' AND check_in_source IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = b.user_id)
GROUP BY b.user_id
ON CONFLICT (user_id) DO UPDATE SET
  cumulative_classes = EXCLUDED.cumulative_classes;

-- Corregir filas infladas por el primer backfill: si un usuario ya no tiene
-- asistencia verificada (en recepción), su acumulado vuelve a 0.
UPDATE public.user_streaks us
SET cumulative_classes = 0
WHERE us.cumulative_classes > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.user_id = us.user_id
      AND b.status <> 'cancelled'
      AND b.attendance_status = 'attended'
      AND b.check_in_source IS NOT NULL
  );
