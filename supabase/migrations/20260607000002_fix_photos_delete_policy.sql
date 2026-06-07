-- Replace storage DELETE policy with a simpler path check.
-- storage.foldername() behavior varies across Supabase versions;
-- a LIKE check on name is unambiguous.

DROP POLICY IF EXISTS "inventory_photos_auth_delete" ON storage.objects;

CREATE POLICY "inventory_photos_auth_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'inventory-photos'
    AND name LIKE (auth.uid()::text || '/%')
  );
