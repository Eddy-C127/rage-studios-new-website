-- ============================================================================
-- MIGRATION: Motor de rachas, logros y catálogo de recompensas (Fase B)
-- Date: 2026-06-20
-- Description:
--   Crea la base del sistema de fidelización:
--     - user_streaks: estado de racha por usuario (diaria, domingos, acumulado).
--     - rewards: catálogo de recompensas (Plan de Fidelización).
--     - achievements: logros editables (icono, condición, recompensa ligada).
--     - user_achievements: logros desbloqueados/reclamados por usuario.
--
--   Motor: un trigger sobre bookings.attendance_status recalcula la racha del
--   usuario cada vez que se marca/edita una asistencia (cubre QR, manual,
--   membresías y walk-in con una sola pieza). El cálculo es idempotente
--   (recalcula desde cero) para ser correcto ante re-marcados y cancelaciones.
--
--   Reglas de negocio:
--     - Racha diaria = días calendario consecutivos con ≥1 clase asistida; los
--       días de cierre del estudio no la rompen. Reclamar un premio la reinicia
--       (ancla daily_streak_start_date).
--     - Racha de domingos = domingos consecutivos asistidos (premio aparte).
--     - cumulative_classes = clases asistidas de por vida (backfill histórico).
--
--   NOTA (feriados): "día de cierre" se infiere del horario semanal
--   (schedule_slots). Cierres ad-hoc por feriado podrían necesitar a futuro una
--   tabla explícita de días cerrados; hoy el estudio abre los 7 días.
-- ============================================================================

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mx_today()
RETURNS date
LANGUAGE sql
STABLE
AS $$ SELECT (now() AT TIME ZONE 'America/Mexico_City')::date $$;

-- ¿El estudio opera ese día de la semana? (ISO dow: lunes=1 … domingo=7)
CREATE OR REPLACE FUNCTION public.is_studio_open(p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.schedule_slots s
    WHERE s.day_of_week = EXTRACT(isodow FROM p_date)::int
      AND COALESCE(s.is_active, true) = true
  );
$$;

-- ── Tablas ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('discount_coupon','free_credits','physical_perk','gift_card')),
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  applicable_package_ids uuid[] DEFAULT NULL,   -- NULL/vacío = aplica a todos
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  icon text NOT NULL DEFAULT '🏅',
  description text,
  condition_type text NOT NULL CHECK (condition_type IN ('daily_streak','sunday_streak','cumulative_classes')),
  condition_value integer NOT NULL CHECK (condition_value > 0),
  reward_id uuid REFERENCES public.rewards(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_streaks (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  daily_streak integer NOT NULL DEFAULT 0,
  longest_daily_streak integer NOT NULL DEFAULT 0,
  daily_streak_start_date date,            -- ancla: cuenta la racha actual desde aquí
  sunday_streak integer NOT NULL DEFAULT 0,
  sunday_streak_start_date date,
  cumulative_classes integer NOT NULL DEFAULT 0,
  last_attended_date date,
  last_sunday_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  achievement_id uuid NOT NULL REFERENCES public.achievements(id) ON DELETE CASCADE,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,                  -- NULL = desbloqueado pero sin reclamar
  cycle_closed boolean NOT NULL DEFAULT false,  -- true cuando se cerró el ciclo sin reclamarse
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON public.user_achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_achievements_active ON public.achievements(is_active, order_index);

-- ── Motor de cálculo ────────────────────────────────────────────────────────
-- Evalúa logros activos y desbloquea los que correspondan (sin duplicar en el ciclo).
CREATE OR REPLACE FUNCTION public.evaluate_achievements(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v record;
  v_anchor_daily date;
  v_anchor_sunday date;
BEGIN
  SELECT * INTO v FROM public.user_streaks WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_anchor_daily  := COALESCE(v.daily_streak_start_date, DATE '1900-01-01');
  v_anchor_sunday := COALESCE(v.sunday_streak_start_date, DATE '1900-01-01');

  FOR r IN SELECT * FROM public.achievements WHERE is_active = true LOOP
    IF r.condition_type = 'daily_streak' THEN
      IF v.daily_streak >= r.condition_value
         AND NOT EXISTS (
           SELECT 1 FROM public.user_achievements ua
           WHERE ua.user_id = p_user_id AND ua.achievement_id = r.id
             AND ua.claimed_at IS NULL AND ua.cycle_closed = false
             AND ua.unlocked_at >= v_anchor_daily
         ) THEN
        INSERT INTO public.user_achievements(user_id, achievement_id) VALUES (p_user_id, r.id);
      END IF;

    ELSIF r.condition_type = 'sunday_streak' THEN
      IF v.sunday_streak >= r.condition_value
         AND NOT EXISTS (
           SELECT 1 FROM public.user_achievements ua
           WHERE ua.user_id = p_user_id AND ua.achievement_id = r.id
             AND ua.claimed_at IS NULL AND ua.cycle_closed = false
             AND ua.unlocked_at >= v_anchor_sunday
         ) THEN
        INSERT INTO public.user_achievements(user_id, achievement_id) VALUES (p_user_id, r.id);
      END IF;

    ELSIF r.condition_type = 'cumulative_classes' THEN
      -- Hitos de por vida: una sola vez
      IF v.cumulative_classes >= r.condition_value
         AND NOT EXISTS (
           SELECT 1 FROM public.user_achievements ua
           WHERE ua.user_id = p_user_id AND ua.achievement_id = r.id
         ) THEN
        INSERT INTO public.user_achievements(user_id, achievement_id) VALUES (p_user_id, r.id);
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- Recalcula TODO el estado de racha del usuario desde sus bookings asistidos.
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

-- ── Trigger sobre bookings ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_attendance_streaks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- El cálculo de racha NUNCA debe romper una operación de reserva/check-in:
  -- cualquier error se registra como WARNING y se ignora.
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

DROP TRIGGER IF EXISTS trg_attendance_streaks ON public.bookings;
CREATE TRIGGER trg_attendance_streaks
AFTER INSERT OR DELETE OR UPDATE OF attendance_status, status ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.trg_attendance_streaks();

-- ── Resumen para el dashboard (calcula racha "efectiva" considerando huecos) ──
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
BEGIN
  SELECT * INTO v FROM public.user_streaks WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('daily_streak',0,'sunday_streak',0,'cumulative_classes',0,'longest_daily_streak',0);
  END IF;

  -- Racha diaria efectiva: si pasó un día ABIERTO (anterior a hoy) sin asistir tras
  -- la última asistencia, la racha ya está rota → 0.
  IF v.last_attended_date IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM generate_series((v.last_attended_date + 1)::timestamp, (v_today - 1)::timestamp, INTERVAL '1 day') g(d)
      WHERE public.is_studio_open(g.d::date)
    ) THEN
      v_daily_eff := v.daily_streak;
    END IF;
  END IF;

  -- Racha de domingos efectiva
  IF v.last_sunday_date IS NOT NULL THEN
    v_cur_sun := v_today - (EXTRACT(isodow FROM v_today)::int % 7);  -- domingo on/antes de hoy
    IF EXTRACT(isodow FROM v_today)::int = 7 THEN
      v_grace := v_cur_sun - 7;   -- hoy es domingo: aún no es obligatorio
    ELSE
      v_grace := v_cur_sun;       -- debe haber asistido el domingo ya pasado
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

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_streaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_achievements ENABLE ROW LEVEL SECURITY;

-- Catálogo: cualquiera autenticado lee lo activo; solo admin escribe.
CREATE POLICY rewards_select_active ON public.rewards
  FOR SELECT TO authenticated USING (is_active = true OR public.is_admin());
CREATE POLICY rewards_admin_write ON public.rewards
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY achievements_select_active ON public.achievements
  FOR SELECT TO authenticated USING (is_active = true OR public.is_admin());
CREATE POLICY achievements_admin_write ON public.achievements
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Estado por usuario: cada quien ve lo suyo; admin ve todo. Escritura solo vía
-- funciones SECURITY DEFINER (no hay policy de INSERT/UPDATE para usuarios).
CREATE POLICY user_streaks_select_own ON public.user_streaks
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY user_achievements_select_own ON public.user_achievements
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());

GRANT EXECUTE ON FUNCTION public.get_user_streak_summary(uuid) TO authenticated;

-- ── Seed inicial (reglas confirmadas con el cliente) ────────────────────────
INSERT INTO public.rewards (name, type, value, description) VALUES
  ('10% de descuento', 'discount_coupon', '{"percent":10}'::jsonb, '10% off en tu próximo paquete'),
  ('15% de descuento', 'discount_coupon', '{"percent":15}'::jsonb, '15% off en tu próximo paquete'),
  ('20% de descuento', 'discount_coupon', '{"percent":20}'::jsonb, '20% off en tu próximo paquete'),
  ('1 crédito gratis', 'free_credits',   '{"credits":1}'::jsonb,   '1 clase de regalo')
ON CONFLICT DO NOTHING;

INSERT INTO public.achievements (name, icon, description, condition_type, condition_value, reward_id, order_index)
SELECT '6 días seguidos', '🔥', 'Asiste 6 días seguidos', 'daily_streak', 6,
       (SELECT id FROM public.rewards WHERE name = '10% de descuento' LIMIT 1), 1
WHERE NOT EXISTS (SELECT 1 FROM public.achievements WHERE condition_type='daily_streak' AND condition_value=6);

INSERT INTO public.achievements (name, icon, description, condition_type, condition_value, reward_id, order_index)
SELECT '15 días seguidos', '⚡', 'Asiste 15 días seguidos', 'daily_streak', 15,
       (SELECT id FROM public.rewards WHERE name = '15% de descuento' LIMIT 1), 2
WHERE NOT EXISTS (SELECT 1 FROM public.achievements WHERE condition_type='daily_streak' AND condition_value=15);

INSERT INTO public.achievements (name, icon, description, condition_type, condition_value, reward_id, order_index)
SELECT '30 días seguidos', '🏆', 'Asiste 30 días seguidos', 'daily_streak', 30,
       (SELECT id FROM public.rewards WHERE name = '20% de descuento' LIMIT 1), 3
WHERE NOT EXISTS (SELECT 1 FROM public.achievements WHERE condition_type='daily_streak' AND condition_value=30);

INSERT INTO public.achievements (name, icon, description, condition_type, condition_value, reward_id, order_index)
SELECT '4 domingos seguidos', '☀️', 'Asiste 4 domingos seguidos', 'sunday_streak', 4,
       (SELECT id FROM public.rewards WHERE name = '1 crédito gratis' LIMIT 1), 4
WHERE NOT EXISTS (SELECT 1 FROM public.achievements WHERE condition_type='sunday_streak' AND condition_value=4);

-- ── Backfill: acumulado histórico; rachas arrancan en 0 desde el lanzamiento ──
INSERT INTO public.user_streaks (user_id, cumulative_classes, daily_streak, sunday_streak,
                                 daily_streak_start_date, sunday_streak_start_date)
SELECT b.user_id, count(*), 0, 0, public.mx_today(), public.mx_today()
FROM public.bookings b
WHERE b.status <> 'cancelled' AND b.attendance_status = 'attended' AND check_in_source IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = b.user_id)
GROUP BY b.user_id
ON CONFLICT (user_id) DO UPDATE SET
  cumulative_classes = EXCLUDED.cumulative_classes,
  daily_streak_start_date = EXCLUDED.daily_streak_start_date,
  sunday_streak_start_date = EXCLUDED.sunday_streak_start_date;
