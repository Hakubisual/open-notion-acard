-- acard-next-account-delete: consent_records (041) are kept one year after the account is deleted, as
-- the privacy policy says ("필수 동의를 받은 사실의 기록 ... 대기자 정보나 계정을 지운 뒤 1년(동의 사실 증명용)"), then deleted.
--   * account_deleted_at: set by the Worker on every row of the account's email when the account deletes itself
--     (gate/cloud.ts deleteHostedData, before the auth user goes). NULL = no account deletion recorded for that row.
--   * consent_purge(p_limit, p_dry): the rows that are due are those with account_deleted_at more than one year ago AND no
--     auth user with that email any more (a row whose email has a live account is never a target, even when marked, e.g.
--     a deletion that failed after the mark, or a new account with the same email). p_dry counts only; otherwise it
--     deletes at most p_limit (1..1000) of the oldest due rows. The Worker (gate/consent.ts purgeConsents) calls it once
--     a day from the acard-workspace cron and writes the answer to admin_audit.
-- Access stays as 041: RLS on, no policies, nothing for anon / authenticated. The column update and the function are
-- service role only. No trigger. Rollback: DROP FUNCTION public.consent_purge(int, boolean);
--   ALTER TABLE public.consent_records DROP COLUMN account_deleted_at;
ALTER TABLE public.consent_records ADD COLUMN IF NOT EXISTS account_deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS consent_records_account_deleted_at ON public.consent_records (account_deleted_at) WHERE account_deleted_at IS NOT NULL;
GRANT UPDATE (account_deleted_at) ON TABLE public.consent_records TO service_role;

-- SECURITY DEFINER because it reads auth.users (same as 042 comp_pass_claim_launch).
CREATE OR REPLACE FUNCTION public.consent_purge(p_limit int, p_dry boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit int := greatest(1, least(coalesce(p_limit, 100), 1000));
  v_due bigint;
  v_deleted int := 0;
BEGIN
  SELECT count(*) INTO v_due FROM public.consent_records c
  WHERE c.account_deleted_at IS NOT NULL AND c.account_deleted_at < now() - interval '1 year'
    AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(btrim(u.email)) = lower(btrim(c.email)));
  IF NOT coalesce(p_dry, true) THEN
    DELETE FROM public.consent_records WHERE id IN (
      SELECT c.id FROM public.consent_records c
      WHERE c.account_deleted_at IS NOT NULL AND c.account_deleted_at < now() - interval '1 year'
        AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(btrim(u.email)) = lower(btrim(c.email)))
      ORDER BY c.account_deleted_at, c.id LIMIT v_limit FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('due', v_due, 'deleted', v_deleted, 'dry', coalesce(p_dry, true), 'limit', v_limit);
END $$;
REVOKE ALL ON FUNCTION public.consent_purge(int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consent_purge(int, boolean) TO service_role;
