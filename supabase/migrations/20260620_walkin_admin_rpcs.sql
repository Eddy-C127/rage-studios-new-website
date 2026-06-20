-- ============================================================================
-- MIGRATION: Registro de walk-ins desde recepción
-- Date: 2026-06-20
-- Description:
--   Recepción deja entrar a clientes por camas libres ("walk-ins") que NO están
--   en la lista de check-in y les descuenta el crédito manualmente. Hoy no hay
--   forma de registrar esa asistencia en el sistema, así que esas clases no
--   contarían para la racha de fidelización.
--
--   Esta migración añade dos RPCs (SECURITY DEFINER, solo admin):
--     1. admin_search_clients: busca clientes por nombre/teléfono y devuelve sus
--        créditos vigentes (para que recepción confirme antes de registrar).
--     2. admin_register_walkin: en UNA sola transacción crea la reserva, descuenta
--        1 crédito y marca la asistencia como 'attended' (check_in_source='walk_in').
--        Si algo falla (créditos insuficientes, cama ocupada), hace rollback total
--        y no deja estados a medias.
--
--   Regla de negocio: la entrada SIEMPRE descuenta 1 crédito. Si el cliente no
--   tiene créditos, NO se registra (recepción debe asignarle créditos primero).
-- ============================================================================

-- 1) Búsqueda de clientes con créditos vigentes para el selector de recepción
CREATE OR REPLACE FUNCTION public.admin_search_clients(p_query text)
RETURNS TABLE(id uuid, full_name text, phone text, available_credits bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'NOT_ADMIN';
  END IF;

  RETURN QUERY
  SELECT p.id,
         p.full_name,
         p.phone,
         COALESCE((
           SELECT sum(cb.credits_remaining)
           FROM public.credit_batches cb
           WHERE cb.user_id = p.id
             AND cb.credits_remaining > 0
             AND (cb.expiration_date IS NULL OR cb.expiration_date > now())
         ), 0)::bigint AS available_credits
  FROM public.profiles p
  WHERE p_query IS NOT NULL
    AND length(trim(p_query)) >= 2
    AND (p.full_name ILIKE '%' || p_query || '%' OR p.phone ILIKE '%' || p_query || '%')
  ORDER BY p.full_name
  LIMIT 20;
END;
$$;

-- 2) Registro atómico de walk-in: crea reserva + descuenta 1 crédito + marca asistencia
CREATE OR REPLACE FUNCTION public.admin_register_walkin(
  p_user_id uuid,
  p_session_date date,
  p_session_time time without time zone,
  p_bed_number integer,
  p_coach_name text DEFAULT 'Coach'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_admin uuid := auth.uid();
  v_occupied integer[];
  v_available integer;
  v_booking_id uuid;
  v_consume jsonb;
  v_name text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('status_code', 'NOT_ADMIN', 'message', 'No autorizado');
  END IF;

  -- Bloqueo silencioso para usuarios restringidos (lista negra)
  IF EXISTS (SELECT 1 FROM public.user_blacklist WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('status_code', 'RESTRICTED', 'message', 'No es posible completar esta operación.');
  END IF;

  -- Anti-duplicado: ya tiene reserva activa en este horario
  IF EXISTS (
    SELECT 1 FROM public.bookings
    WHERE user_id = p_user_id
      AND session_date = p_session_date
      AND session_time = p_session_time
      AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status_code', 'ALREADY_BOOKED', 'message', 'El cliente ya tiene una reserva en este horario.');
  END IF;

  -- Cama libre
  SELECT public.get_occupied_beds_public(p_session_date, p_session_time) INTO v_occupied;
  IF p_bed_number = ANY(COALESCE(v_occupied, '{}')) THEN
    RETURN jsonb_build_object('status_code', 'BED_TAKEN', 'message', 'La cama ' || p_bed_number || ' ya está ocupada.');
  END IF;

  -- Créditos vigentes (la entrada SIEMPRE descuenta 1)
  SELECT COALESCE(sum(credits_remaining), 0) INTO v_available
  FROM public.credit_batches
  WHERE user_id = p_user_id
    AND credits_remaining > 0
    AND (expiration_date IS NULL OR expiration_date > now());

  IF v_available < 1 THEN
    RETURN jsonb_build_object('status_code', 'INSUFFICIENT_CREDITS', 'message', 'El cliente no tiene créditos disponibles. Asígnale créditos primero.');
  END IF;

  -- Crear reserva ya marcada como asistida (walk-in)
  INSERT INTO public.bookings (
    user_id, session_date, session_time, bed_numbers,
    attendees, total_attendees, credits_used, coach_name, status,
    attendance_status, attendance_marked_at, checked_in_by, check_in_source
  ) VALUES (
    p_user_id, p_session_date, p_session_time, ARRAY[p_bed_number],
    ARRAY[]::text[], 1, 1, p_coach_name, 'active',
    'attended', now(), v_admin, 'walk_in'
  ) RETURNING id INTO v_booking_id;

  -- Descontar 1 crédito (FIFO, atómico). Si falla, rollback de todo vía EXCEPTION.
  v_consume := public.consume_credits_atomic(p_user_id, 1, v_booking_id, 'Walk-in registrado en recepción');
  IF NOT COALESCE((v_consume->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'CONSUME_FAILED:%', COALESCE(v_consume->>'error', 'unknown');
  END IF;

  UPDATE public.bookings
    SET credit_batch_id = (v_consume->>'first_batch_id')::uuid
  WHERE id = v_booking_id;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'status_code', 'OK',
    'message', 'Asistencia registrada',
    'client_name', v_name,
    'bed_number', p_bed_number,
    'booking_id', v_booking_id
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('status_code', 'ERROR', 'message', 'No se pudo registrar el walk-in: ' || SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_search_clients(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.admin_register_walkin(uuid, date, time without time zone, integer, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_search_clients(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_register_walkin(uuid, date, time without time zone, integer, text) TO authenticated;
