-- Serialize child-row freeze checks with the READY transition.  The parent
-- row lock closes the race where a child write observes `draft`, waits behind
-- the edition/story transition, and then commits after the parent is READY.
-- These are invoker-security trigger functions; they are not public RPCs.

CREATE OR REPLACE FUNCTION content.assert_draft_week_edition_items()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = content, pg_catalog
AS $$
DECLARE
  edition_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.edition_id IS DISTINCT FROM OLD.edition_id THEN
    RAISE EXCEPTION 'Week edition item parent cannot change' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO edition_status
  FROM content.week_editions
  WHERE edition_id = COALESCE(NEW.edition_id, OLD.edition_id)
  FOR UPDATE;
  IF edition_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Week edition items are immutable after READY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION content.assert_draft_story_localization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = content, pg_catalog
AS $$
DECLARE
  story_status text;
  version_group uuid := COALESCE(NEW.version_group_id, OLD.version_group_id);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version_group_id IS DISTINCT FROM OLD.version_group_id THEN
    RAISE EXCEPTION 'Story localization parent cannot change' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO story_status
  FROM content.stories
  WHERE version_group_id = version_group
  ORDER BY story_revision DESC
  LIMIT 1
  FOR UPDATE;
  IF story_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Story localization is immutable after READY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION content.assert_draft_story_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = content, pg_catalog
AS $$
DECLARE
  story_status text;
  story_key uuid := COALESCE(NEW.story_id, OLD.story_id);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.story_id IS DISTINCT FROM OLD.story_id THEN
    RAISE EXCEPTION 'Story evidence parent cannot change' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO story_status
  FROM content.stories
  WHERE story_id = story_key
  FOR UPDATE;
  IF story_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Story evidence is immutable after READY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION content.assert_draft_week_edition_items() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.assert_draft_story_localization() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.assert_draft_story_evidence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.assert_draft_week_edition_items() TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.assert_draft_story_localization() TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.assert_draft_story_evidence() TO letletme_data_writer;
