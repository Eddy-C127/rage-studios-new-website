-- ============================================================================
-- MIGRATION: Campañas de cupón manuales (EVENTO10) + validación de cupones
-- Date: 2026-06-20
-- Description:
--   Añade coupon_campaigns (cupones de código compartido que el admin lanza para
--   eventos) y las funciones para validar un cupón en el checkout:
--     - validate_coupon(user, code, package): autoritativa (la usa la edge function
--       con service role). Revisa primero cupones personales (tabla coupons) y luego
--       campañas. Devuelve el descuento aplicable o el motivo de rechazo.
--     - preview_coupon(code, package): wrapper para el frontend (usa auth.uid()).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.coupon_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  discount_percent integer NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  applicable_package_ids uuid[] DEFAULT NULL,   -- NULL/vacío = todos los paquetes
  max_uses integer,                              -- NULL = ilimitado
  used_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

-- Normaliza el código a MAYÚSCULAS para comparaciones case-insensitive
CREATE OR REPLACE FUNCTION public.normalize_coupon_code()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.code := upper(trim(NEW.code));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_campaign_code ON public.coupon_campaigns;
CREATE TRIGGER trg_normalize_campaign_code
BEFORE INSERT OR UPDATE OF code ON public.coupon_campaigns
FOR EACH ROW EXECUTE FUNCTION public.normalize_coupon_code();

-- ── Validación autoritativa (cupón personal o campaña) ──────────────────────
CREATE OR REPLACE FUNCTION public.validate_coupon(p_user_id uuid, p_code text, p_package_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_code text := upper(trim(coalesce(p_code, '')));
  v_c public.coupons%ROWTYPE;
  v_camp public.coupon_campaigns%ROWTYPE;
BEGIN
  IF v_code = '' THEN
    RETURN jsonb_build_object('valid', false, 'message', 'Código vacío');
  END IF;

  -- 1) Cupón personal del usuario
  SELECT * INTO v_c
  FROM public.coupons
  WHERE upper(code) = v_code
    AND user_id = p_user_id
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  IF FOUND THEN
    IF v_c.applicable_package_ids IS NOT NULL
       AND array_length(v_c.applicable_package_ids, 1) > 0
       AND NOT (p_package_id = ANY (v_c.applicable_package_ids)) THEN
      RETURN jsonb_build_object('valid', false, 'message', 'Este cupón no aplica a este paquete');
    END IF;
    RETURN jsonb_build_object(
      'valid', true, 'source', 'personal',
      'coupon_id', v_c.id, 'discount_percent', v_c.discount_percent
    );
  END IF;

  -- 2) Campaña (código compartido)
  SELECT * INTO v_camp
  FROM public.coupon_campaigns
  WHERE upper(code) = v_code
    AND is_active = true
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  IF FOUND THEN
    IF v_camp.max_uses IS NOT NULL AND v_camp.used_count >= v_camp.max_uses THEN
      RETURN jsonb_build_object('valid', false, 'message', 'Este cupón ya alcanzó su límite de usos');
    END IF;
    IF v_camp.applicable_package_ids IS NOT NULL
       AND array_length(v_camp.applicable_package_ids, 1) > 0
       AND NOT (p_package_id = ANY (v_camp.applicable_package_ids)) THEN
      RETURN jsonb_build_object('valid', false, 'message', 'Este cupón no aplica a este paquete');
    END IF;
    RETURN jsonb_build_object(
      'valid', true, 'source', 'campaign',
      'campaign_id', v_camp.id, 'discount_percent', v_camp.discount_percent
    );
  END IF;

  RETURN jsonb_build_object('valid', false, 'message', 'Cupón no válido o expirado');
END;
$$;

-- ── Wrapper para el frontend (previsualización del descuento) ───────────────
CREATE OR REPLACE FUNCTION public.preview_coupon(p_code text, p_package_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.validate_coupon(auth.uid(), p_code, p_package_id);
$$;

-- Incremento atómico del contador de usos de una campaña (lo llama el webhook)
CREATE OR REPLACE FUNCTION public.increment_coupon_campaign_use(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.coupon_campaigns SET used_count = used_count + 1 WHERE id = p_id;
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.coupon_campaigns ENABLE ROW LEVEL SECURITY;

-- Solo admin gestiona campañas (lectura y escritura).
CREATE POLICY coupon_campaigns_admin_all ON public.coupon_campaigns
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

REVOKE ALL ON FUNCTION public.validate_coupon(uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_coupon(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.preview_coupon(text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.increment_coupon_campaign_use(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_coupon_campaign_use(uuid) TO service_role;
