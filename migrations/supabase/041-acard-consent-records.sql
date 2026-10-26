-- acard-legal-docs: the WAITLIST form and the sign-up screen ask for required consents (이용약관,
-- 개인정보 수집·이용, 국외 이전) and the Worker refuses a request without them. Each accepted request writes one row here:
-- the email, where it came from (waitlist / signup), the consent items, the privacy notice version the Worker served
-- (set by the Worker, never by the browser) and the time. Rows are only appended, so the history of what was agreed stays.
-- Same access as the other beta tables (008, 029): RLS on, no policies, no grants to anon / authenticated. Only the
-- Worker (service role) writes and reads it. No trigger and no function: the Worker inserts through PostgREST.
-- Nothing existing is changed. Rollback: DROP TABLE public.consent_records;
CREATE TABLE IF NOT EXISTS public.consent_records (
  id bigserial PRIMARY KEY,
  email text NOT NULL CHECK (char_length(email) <= 254),
  source text NOT NULL CHECK (source IN ('waitlist', 'signup')),
  doc_version text NOT NULL CHECK (char_length(doc_version) <= 40),
  items text[] NOT NULL CHECK (cardinality(items) BETWEEN 1 AND 8),
  agreed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consent_records_email ON public.consent_records (email);
ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.consent_records FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.consent_records_id_seq FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.consent_records TO service_role;
GRANT USAGE ON SEQUENCE public.consent_records_id_seq TO service_role;
