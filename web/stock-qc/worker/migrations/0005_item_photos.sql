-- Product galleries reference the existing content-addressed R2 files; QC attachments are unchanged.
-- Item ids are validated against the authoritative engine before writing. No external image URLs are accepted.
CREATE TABLE sq_item_photos (
  item_id TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES sq_files(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 8),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  name TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (item_id,file_id),
  UNIQUE (item_id,slot)
);
CREATE UNIQUE INDEX sq_item_photos_primary ON sq_item_photos (item_id) WHERE is_primary=1;
