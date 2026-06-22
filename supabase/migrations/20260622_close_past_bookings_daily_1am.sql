-- ============================================================================
-- MIGRATION: close_past_bookings solo cierra días pasados, y corre 1 vez al día
-- Date: 2026-06-22
-- Description:
--   Antes close_past_bookings() cerraba toda reserva cuya hora de inicio ya había
--   pasado (start < now) y el cron corría a las 06:00 y 18:00 (Monterrey). Eso
--   cerraba la clase de las 06:00 justo al iniciar, dejándola invisible para el
--   check-in dentro de su propia ventana (05:30–06:30).
--   Ahora:
--     1) Solo cierra reservas de DÍAS COMPLETOS pasados (session_date < hoy),
--        por lo que jamás toca una clase del día en curso.
--     2) El cron corre una sola vez al día, a la 01:00 hora de Monterrey
--        (07:00 UTC), cuando ya no hay ninguna clase viva.
--   El motor de rachas cuenta 'active' + 'closed' (status <> 'cancelled'), así que
--   dejar las clases de hoy en 'active' hasta la madrugada no afecta rachas.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.close_past_bookings()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  DECLARE
    updated_count integer;
  BEGIN
    UPDATE bookings
    SET
      status = 'closed',
      updated_at = now()
    WHERE
      status = 'active'
      AND session_date < (now() AT TIME ZONE 'America/Monterrey')::date;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
  END;
  $function$;

-- Reprogramar el cron: una vez al día a la 01:00 Monterrey (= 07:00 UTC).
-- cron.schedule actualiza el job existente al reutilizar el mismo nombre.
SELECT cron.schedule(
  'close-past-bookings',
  '0 7 * * *',
  $$SELECT public.close_past_bookings();$$
);
