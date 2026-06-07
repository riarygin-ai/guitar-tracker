-- ─── 1. Add admin column to app_users ────────────────────────────────────────
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS admin boolean NOT NULL DEFAULT false;

-- ─── 2. Helper function: is current user an admin? ────────────────────────────
-- SECURITY DEFINER so it bypasses RLS when reading app_users internally.
CREATE OR REPLACE FUNCTION get_app_user_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT admin FROM app_users WHERE auth_user_id = auth.uid()),
    false
  )
$$;

-- ─── 3. Enable RLS on brands ──────────────────────────────────────────────────
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read brands (existing app relies on this)
CREATE POLICY "Authenticated users can read brands"
  ON brands FOR SELECT
  TO authenticated
  USING (true);

-- All authenticated users can insert brands (InventoryForm lets users create brands)
CREATE POLICY "Authenticated users can insert brands"
  ON brands FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Only admins can update brands
CREATE POLICY "Admins can update brands"
  ON brands FOR UPDATE
  TO authenticated
  USING (get_app_user_is_admin())
  WITH CHECK (get_app_user_is_admin());

-- Only admins can delete brands
CREATE POLICY "Admins can delete brands"
  ON brands FOR DELETE
  TO authenticated
  USING (get_app_user_is_admin());
