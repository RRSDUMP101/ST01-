-- Usernames accept ASCII only. NOCASE preserves the existing spelling while enforcing one login identity.
-- Before applying to an existing database, check and resolve duplicate groups explicitly:
-- SELECT lower(username), COUNT(*) FROM sq_app_users GROUP BY username COLLATE NOCASE HAVING COUNT(*) > 1;
-- This migration intentionally fails on duplicates; it never merges identities or overwrites account data.
CREATE UNIQUE INDEX sq_app_users_username_nocase ON sq_app_users (username COLLATE NOCASE);
