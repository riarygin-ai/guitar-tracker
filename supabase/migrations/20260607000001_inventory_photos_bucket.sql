-- Create the inventory-photos storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'inventory-photos',
  'inventory-photos',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Storage object policies
-- Public read (bucket is public so getPublicUrl works without signed URLs)
CREATE POLICY "inventory_photos_public_read"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'inventory-photos');

-- Authenticated users can upload only inside their own folder
CREATE POLICY "inventory_photos_auth_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'inventory-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Authenticated users can delete only their own files
CREATE POLICY "inventory_photos_auth_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'inventory-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
