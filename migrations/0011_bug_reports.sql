-- User-submitted problem reports. Identity is a bauth user id string (no cross-schema FK).

CREATE TABLE ops.bug_reports (
    id uuid PRIMARY KEY,
    public_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    user_id text,
    entry_id integer,
    body text NOT NULL,
    screenshot_url text,
    client_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    CONSTRAINT bug_reports_public_id_format CHECK (public_id ~ '^LL-[0-9A-F]{6}$'::text),
    CONSTRAINT bug_reports_source_known CHECK (source = ANY (ARRAY['website'::text, 'wechat_miniprogram'::text])),
    CONSTRAINT bug_reports_status_known CHECK (status = ANY (ARRAY['open'::text, 'ack'::text, 'closed'::text])),
    CONSTRAINT bug_reports_body_nonempty CHECK ((char_length(btrim(body)) >= 8) AND (char_length(body) <= 500)),
    CONSTRAINT bug_reports_entry_id_positive CHECK ((entry_id IS NULL) OR (entry_id > 0)),
    CONSTRAINT bug_reports_screenshot_https CHECK (
        (screenshot_url IS NULL) OR (screenshot_url ~ '^https://'::text)
    )
);

ALTER TABLE ops.bug_reports OWNER TO letletme_data_owner;

CREATE UNIQUE INDEX bug_reports_public_id_key ON ops.bug_reports USING btree (public_id);
CREATE INDEX bug_reports_created_idx ON ops.bug_reports USING btree (created_at DESC NULLS LAST);
CREATE INDEX bug_reports_user_created_idx ON ops.bug_reports USING btree (user_id, created_at DESC NULLS LAST)
    WHERE user_id IS NOT NULL;

GRANT SELECT,INSERT,UPDATE ON TABLE ops.bug_reports TO letletme_data_writer;

COMMENT ON TABLE ops.bug_reports IS
    'End-user problem reports. body is the user-written description; client_meta is silent diagnostics.';
