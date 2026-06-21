-- ============================================================================
-- MIGRATION: Walk-in — ocupación de camas según CHECK-IN, no según reserva
-- Date: 2026-06-21
-- Description:
--   En recepción, una cama solo está realmente ocupada si alguien hizo check-in
--   (attendance_status='attended'). Caso real: 14 camas reservadas pero solo
--   asistieron 2-3 personas; las demás camas deben poder asignarse a walk-ins.
--   Por eso admin_register_walkin ahora bloquea una cama SOLO si ya tiene una
--   asistencia confirmada en ese turno (no por una reserva sin check-in).
--   (En la página de reservas la lógica sigue igual: ahí sí cuentan las reservas.)
-- ============================================================================

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
  v_available integer;
  v_booking_id uuid;
  v_consume jsonb;
  v_name text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('status_code', 'NOT_ADMIN', 'message', 'No autorizado');
  END IF;

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

  -- Cama ocupada SOLO si alguien ya hizo check-in (attended) en ese turno.
  -- Una reserva sin check-in NO bloquea: la cama se puede dar al walk-in.
  IF EXISTS (
    SELECT 1 FROM public.bookings
    WHERE session_date = p_session_date
      AND session_time = p_session_time
      AND status <> 'cancelled'
      AND attendance_status = 'attended'
      AND p_bed_number = ANY(bed_numbers)
  ) THEN
    RETURN jsonb_build_object('status_code', 'BED_TAKEN', 'message', 'La cama ' || p_bed_number || ' ya tiene check-in.');
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

  INSERT INTO public.bookings (
    user_id, session_date, session_time, bed_numbers,
    attendees, total_attendees, credits_used, coach_name, status,
    attendance_status, attendance_marked_at, checked_in_by, check_in_source
  ) VALUES (
    p_user_id, p_session_date, p_session_time, ARRAY[p_bed_number],
    ARRAY[]::text[], 1, 1, p_coach_name, 'active',
    'attended', now(), v_admin, 'walk_in'
  ) RETURNING id INTO v_booking_id;

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
