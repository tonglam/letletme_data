--
-- PostgreSQL database dump
--


-- Dumped from database version 15.18 (Debian 15.18-1.pgdg13+1)
-- Dumped by pg_dump version 15.18 (Debian 15.18-1.pgdg13+1)

SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', true);
SET LOCAL check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- Capability roles are cluster-level identities without credentials. Runtime LOGIN
-- roles are provisioned separately and receive these capabilities through membership.
DO $roles$
DECLARE
    role_name text;
    role_row record;
BEGIN
    FOREACH role_name IN ARRAY ARRAY[
        'letletme_data_owner',
        'letletme_data_writer',
        'letletme_graphql_reader'
    ]
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format(
                'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
                role_name
            );
        END IF;

        SELECT
            rolcanlogin,
            rolsuper,
            rolcreatedb,
            rolcreaterole,
            rolinherit,
            rolreplication,
            rolbypassrls,
            COALESCE(rolconfig, ARRAY[]::text[]) AS role_settings
        INTO STRICT role_row
        FROM pg_roles
        WHERE rolname = role_name;

        IF role_row.rolcanlogin
           OR role_row.rolsuper
           OR role_row.rolcreatedb
           OR role_row.rolcreaterole
           OR role_row.rolinherit
           OR role_row.rolreplication
           OR role_row.rolbypassrls
           OR cardinality(role_row.role_settings) > 0 THEN
            RAISE EXCEPTION 'capability role % has unsafe attributes', role_name;
        END IF;
    END LOOP;
END
$roles$;

DO $capability_memberships$
DECLARE
    unexpected_memberships text;
BEGIN
    SELECT string_agg(
        format('%s->%s', granted_role.rolname, member_role.rolname),
        ', ' ORDER BY granted_role.rolname, member_role.rolname
    )
    INTO unexpected_memberships
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname IN (
        'letletme_data_owner',
        'letletme_data_writer',
        'letletme_graphql_reader'
    )
       OR member_role.rolname IN (
        'letletme_data_owner',
        'letletme_data_writer',
        'letletme_graphql_reader'
    );

    IF unexpected_memberships IS NOT NULL THEN
        RAISE EXCEPTION
            'capability roles have pre-existing memberships: %',
            unexpected_memberships;
    END IF;
END
$capability_memberships$;

DO $migration_owner_grant$
BEGIN
    EXECUTE format('GRANT %I TO %I', 'letletme_data_owner', current_user);
END
$migration_owner_grant$;

--
-- Name: bridge; Type: SCHEMA; Schema: -; Owner: letletme_data_owner
--

CREATE SCHEMA bridge;


ALTER SCHEMA bridge OWNER TO letletme_data_owner;

--
-- Name: competition; Type: SCHEMA; Schema: -; Owner: letletme_data_owner
--

CREATE SCHEMA competition;


ALTER SCHEMA competition OWNER TO letletme_data_owner;

--
-- Name: fpl; Type: SCHEMA; Schema: -; Owner: letletme_data_owner
--

CREATE SCHEMA fpl;


ALTER SCHEMA fpl OWNER TO letletme_data_owner;

--
-- Name: ops; Type: SCHEMA; Schema: -; Owner: letletme_data_owner
--

CREATE SCHEMA ops;


ALTER SCHEMA ops OWNER TO letletme_data_owner;

--
-- Name: reporting; Type: SCHEMA; Schema: -; Owner: letletme_data_owner
--

CREATE SCHEMA reporting;


ALTER SCHEMA reporting OWNER TO letletme_data_owner;

--
-- Name: understat; Type: SCHEMA; Schema: -; Owner: letletme_data_owner
--

CREATE SCHEMA understat;


ALTER SCHEMA understat OWNER TO letletme_data_owner;

--
-- Name: entity_type; Type: TYPE; Schema: bridge; Owner: letletme_data_owner
--

CREATE TYPE bridge.entity_type AS ENUM (
    'team',
    'player'
);


ALTER TYPE bridge.entity_type OWNER TO letletme_data_owner;

--
-- Name: link_status; Type: TYPE; Schema: bridge; Owner: letletme_data_owner
--

CREATE TYPE bridge.link_status AS ENUM (
    'pending',
    'auto_verified',
    'manual_verified',
    'ambiguous',
    'quarantined',
    'rejected'
);


ALTER TYPE bridge.link_status OWNER TO letletme_data_owner;

--
-- Name: chip; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.chip AS ENUM (
    'n/a',
    'wildcard',
    'freehit',
    'bboost',
    '3xc',
    'manager'
);


ALTER TYPE competition.chip OWNER TO letletme_data_owner;

--
-- Name: cup_result; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.cup_result AS ENUM (
    'win',
    'loss'
);


ALTER TYPE competition.cup_result OWNER TO letletme_data_owner;

--
-- Name: group_mode; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.group_mode AS ENUM (
    'no_group',
    'points_races',
    'battle_races'
);


ALTER TYPE competition.group_mode OWNER TO letletme_data_owner;

--
-- Name: knockout_mode; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.knockout_mode AS ENUM (
    'no_knockout',
    'single_elimination',
    'double_elimination',
    'head_to_head'
);


ALTER TYPE competition.knockout_mode OWNER TO letletme_data_owner;

--
-- Name: league_type; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.league_type AS ENUM (
    'classic',
    'h2h'
);


ALTER TYPE competition.league_type OWNER TO letletme_data_owner;

--
-- Name: tournament_mode; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.tournament_mode AS ENUM (
    'normal'
);


ALTER TYPE competition.tournament_mode OWNER TO letletme_data_owner;

--
-- Name: tournament_roster_mode; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.tournament_roster_mode AS ENUM (
    'snapshot',
    'official_sync'
);


ALTER TYPE competition.tournament_roster_mode OWNER TO letletme_data_owner;

--
-- Name: tournament_setup_phase; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.tournament_setup_phase AS ENUM (
    'queued',
    'syncing_entries',
    'building_structure',
    'calculating_standings',
    'enriching_history',
    'finalizing',
    'ready',
    'failed'
);


ALTER TYPE competition.tournament_setup_phase OWNER TO letletme_data_owner;

--
-- Name: tournament_setup_status; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.tournament_setup_status AS ENUM (
    'pending',
    'processing',
    'ready',
    'failed'
);


ALTER TYPE competition.tournament_setup_status OWNER TO letletme_data_owner;

--
-- Name: tournament_state; Type: TYPE; Schema: competition; Owner: letletme_data_owner
--

CREATE TYPE competition.tournament_state AS ENUM (
    'active',
    'inactive',
    'finished'
);


ALTER TYPE competition.tournament_state OWNER TO letletme_data_owner;

--
-- Name: season_state; Type: TYPE; Schema: understat; Owner: letletme_data_owner
--

CREATE TYPE understat.season_state AS ENUM (
    'planned',
    'active',
    'complete'
);


ALTER TYPE understat.season_state OWNER TO letletme_data_owner;

--
-- Name: refresh_tournament_entry_event_summaries(); Type: FUNCTION; Schema: reporting; Owner: letletme_data_owner
--

CREATE FUNCTION reporting.refresh_tournament_entry_event_summaries() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  populated boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(73001, 2);
  SELECT ispopulated
    INTO populated
    FROM pg_matviews
   WHERE schemaname = 'reporting'
     AND matviewname = 'tournament_entry_event_summaries';
  IF populated THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.tournament_entry_event_summaries;
  ELSE
    REFRESH MATERIALIZED VIEW reporting.tournament_entry_event_summaries;
  END IF;
END
$$;


ALTER FUNCTION reporting.refresh_tournament_entry_event_summaries() OWNER TO letletme_data_owner;

--
-- Name: refresh_tournament_selection_stats(); Type: FUNCTION; Schema: reporting; Owner: letletme_data_owner
--

CREATE FUNCTION reporting.refresh_tournament_selection_stats() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  populated boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(73001, 1);
  SELECT ispopulated
    INTO populated
    FROM pg_matviews
   WHERE schemaname = 'reporting'
     AND matviewname = 'tournament_selection_stats';
  IF populated THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.tournament_selection_stats;
  ELSE
    REFRESH MATERIALIZED VIEW reporting.tournament_selection_stats;
  END IF;
END
$$;


ALTER FUNCTION reporting.refresh_tournament_selection_stats() OWNER TO letletme_data_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: entity_aliases; Type: TABLE; Schema: bridge; Owner: letletme_data_owner
--

CREATE TABLE bridge.entity_aliases (
    alias_id uuid NOT NULL,
    entity_type bridge.entity_type NOT NULL,
    provider text NOT NULL,
    provider_entity_id text NOT NULL,
    alias text NOT NULL,
    source text NOT NULL,
    first_observed_at timestamp with time zone NOT NULL,
    last_observed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bridge_entity_aliases_fields_nonempty CHECK (((btrim(provider) <> ''::text) AND (btrim(provider_entity_id) <> ''::text) AND (btrim(alias) <> ''::text) AND (btrim(source) <> ''::text))),
    CONSTRAINT bridge_entity_aliases_observed_order CHECK ((last_observed_at >= first_observed_at))
);


ALTER TABLE bridge.entity_aliases OWNER TO letletme_data_owner;

--
-- Name: entity_links; Type: TABLE; Schema: bridge; Owner: letletme_data_owner
--

CREATE TABLE bridge.entity_links (
    link_id uuid NOT NULL,
    entity_type bridge.entity_type NOT NULL,
    left_provider text NOT NULL,
    left_entity_id text,
    right_provider text NOT NULL,
    right_entity_id text NOT NULL,
    status bridge.link_status NOT NULL,
    method text NOT NULL,
    rule_id text NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    first_seen_season text,
    last_seen_season text,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bridge_entity_links_distinct_providers CHECK ((left_provider <> right_provider)),
    CONSTRAINT bridge_entity_links_evidence_object CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT bridge_entity_links_required_fields_nonempty CHECK (((btrim(left_provider) <> ''::text) AND (btrim(right_provider) <> ''::text) AND (btrim(right_entity_id) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(rule_id) <> ''::text))),
    CONSTRAINT bridge_entity_links_season_order CHECK (((last_seen_season IS NULL) OR (first_seen_season IS NULL) OR (last_seen_season >= first_seen_season))),
    CONSTRAINT bridge_entity_links_verified_complete CHECK (((status <> ALL (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status])) OR ((left_entity_id IS NOT NULL) AND (btrim(left_entity_id) <> ''::text))))
);


ALTER TABLE bridge.entity_links OWNER TO letletme_data_owner;

--
-- Name: match_links; Type: TABLE; Schema: bridge; Owner: letletme_data_owner
--

CREATE TABLE bridge.match_links (
    link_id uuid NOT NULL,
    season_code text NOT NULL,
    left_provider text NOT NULL,
    left_match_id text NOT NULL,
    right_provider text NOT NULL,
    right_match_id text NOT NULL,
    status bridge.link_status NOT NULL,
    method text NOT NULL,
    rule_id text NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bridge_match_links_distinct_providers CHECK ((left_provider <> right_provider)),
    CONSTRAINT bridge_match_links_evidence_object CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT bridge_match_links_required_fields_nonempty CHECK (((btrim(left_provider) <> ''::text) AND (btrim(left_match_id) <> ''::text) AND (btrim(right_provider) <> ''::text) AND (btrim(right_match_id) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(rule_id) <> ''::text))),
    CONSTRAINT bridge_match_links_season_format CHECK ((season_code ~ '^[0-9]{4}$'::text))
);


ALTER TABLE bridge.match_links OWNER TO letletme_data_owner;

--
-- Name: entries; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.entries (
    season_id smallint NOT NULL,
    entry_id integer NOT NULL,
    entry_name text NOT NULL,
    player_name text NOT NULL,
    region text,
    started_event integer,
    overall_points integer,
    overall_rank integer,
    bank integer,
    team_value integer,
    total_transfers integer,
    last_entry_name text,
    last_overall_points integer,
    last_overall_rank integer,
    last_team_value integer,
    last_bank integer,
    used_entry_names text[] DEFAULT '{}'::text[] NOT NULL,
    last_event_id integer DEFAULT 0 NOT NULL,
    snapshot_synced_through_event_id integer,
    transfers_synced_through_event_id integer,
    transfers_source_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entries_entry_id_positive CHECK ((entry_id > 0)),
    CONSTRAINT entries_event_ids_valid CHECK ((((started_event IS NULL) OR (started_event > 0)) AND (last_event_id >= 0) AND ((snapshot_synced_through_event_id IS NULL) OR (snapshot_synced_through_event_id >= 0)) AND ((transfers_synced_through_event_id IS NULL) OR (transfers_synced_through_event_id >= 0)))),
    CONSTRAINT entries_names_nonempty CHECK (((btrim(entry_name) <> ''::text) AND (btrim(player_name) <> ''::text)))
);


ALTER TABLE competition.entries OWNER TO letletme_data_owner;

--
-- Name: entry_event_cup_results; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.entry_event_cup_results (
    season_id smallint NOT NULL,
    source_result_id integer NOT NULL,
    entry_id integer NOT NULL,
    event_id integer NOT NULL,
    opponent_entry_id integer,
    opponent_name text,
    result competition.cup_result NOT NULL,
    entry_points integer NOT NULL,
    opponent_points integer NOT NULL,
    entry_name text,
    player_name text,
    against_entry_name text,
    against_player_name text,
    event_points integer,
    against_entry_id integer,
    against_event_points integer,
    source_season_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entry_event_cup_results_ids_positive CHECK (((source_result_id > 0) AND (entry_id > 0) AND (event_id > 0) AND ((opponent_entry_id IS NULL) OR (opponent_entry_id > 0)) AND ((against_entry_id IS NULL) OR (against_entry_id > 0))))
);


ALTER TABLE competition.entry_event_cup_results OWNER TO letletme_data_owner;

--
-- Name: entry_event_cup_results_source_result_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.entry_event_cup_results ALTER COLUMN source_result_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.entry_event_cup_results_source_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: entry_event_picks; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.entry_event_picks (
    season_id smallint NOT NULL,
    entry_id integer NOT NULL,
    event_id integer NOT NULL,
    "position" smallint NOT NULL,
    element_id integer NOT NULL,
    multiplier smallint NOT NULL,
    is_captain boolean NOT NULL,
    is_vice_captain boolean NOT NULL,
    active_chip competition.chip,
    transfers integer,
    transfers_cost integer,
    source_pick_row_id integer NOT NULL,
    source_created_at timestamp with time zone NOT NULL,
    source_updated_at timestamp with time zone NOT NULL,
    CONSTRAINT entry_event_picks_captain_roles_distinct CHECK ((NOT (is_captain AND is_vice_captain))),
    CONSTRAINT entry_event_picks_event_metadata_once CHECK ((("position" = 1) OR ((active_chip IS NULL) AND (transfers IS NULL) AND (transfers_cost IS NULL)))),
    CONSTRAINT entry_event_picks_ids_positive CHECK (((entry_id > 0) AND (event_id > 0) AND (element_id > 0) AND (source_pick_row_id > 0))),
    CONSTRAINT entry_event_picks_multiplier_valid CHECK (((multiplier >= 0) AND (multiplier <= 3))),
    CONSTRAINT entry_event_picks_position_valid CHECK ((("position" >= 1) AND ("position" <= 15))),
    CONSTRAINT entry_event_picks_source_time_order CHECK ((source_updated_at >= source_created_at)),
    CONSTRAINT entry_event_picks_transfer_counts_nonnegative CHECK ((((transfers IS NULL) OR (transfers >= 0)) AND ((transfers_cost IS NULL) OR (transfers_cost >= 0))))
);


ALTER TABLE competition.entry_event_picks OWNER TO letletme_data_owner;

--
-- Name: entry_event_picks_source_pick_row_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.entry_event_picks ALTER COLUMN source_pick_row_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.entry_event_picks_source_pick_row_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: entry_event_results; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.entry_event_results (
    season_id smallint NOT NULL,
    entry_id integer NOT NULL,
    event_id integer NOT NULL,
    source_result_id integer NOT NULL,
    event_points integer DEFAULT 0 NOT NULL,
    event_transfers integer DEFAULT 0 NOT NULL,
    event_transfers_cost integer DEFAULT 0 NOT NULL,
    event_net_points integer DEFAULT 0 NOT NULL,
    event_bench_points integer,
    event_auto_sub_points integer,
    event_rank integer,
    event_chip competition.chip,
    played_captain_element_id integer,
    captain_points integer,
    automatic_substitutions jsonb,
    overall_points integer DEFAULT 0 NOT NULL,
    overall_rank integer DEFAULT 0 NOT NULL,
    team_value integer,
    bank integer,
    rich_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entry_event_results_auto_sub_array CHECK (((automatic_substitutions IS NULL) OR (jsonb_typeof(automatic_substitutions) = 'array'::text))),
    CONSTRAINT entry_event_results_ids_positive CHECK (((entry_id > 0) AND (event_id > 0) AND (source_result_id > 0) AND ((played_captain_element_id IS NULL) OR (played_captain_element_id > 0)))),
    CONSTRAINT entry_event_results_rank_nonnegative CHECK ((((event_rank IS NULL) OR (event_rank >= 0)) AND (overall_rank >= 0))),
    CONSTRAINT entry_event_results_transfer_counts_nonnegative CHECK (((event_transfers >= 0) AND (event_transfers_cost >= 0)))
);


ALTER TABLE competition.entry_event_results OWNER TO letletme_data_owner;

--
-- Name: entry_event_results_source_result_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.entry_event_results ALTER COLUMN source_result_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.entry_event_results_source_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: entry_event_transfers; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.entry_event_transfers (
    season_id smallint NOT NULL,
    transfer_id integer NOT NULL,
    entry_id integer NOT NULL,
    event_id integer NOT NULL,
    element_in_id integer,
    element_in_cost integer,
    element_in_points integer,
    element_out_id integer,
    element_out_cost integer,
    element_out_points integer,
    element_in_played boolean,
    transfer_time timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entry_event_transfers_ids_positive CHECK (((transfer_id > 0) AND (entry_id > 0) AND (event_id > 0) AND ((element_in_id IS NULL) OR (element_in_id > 0)) AND ((element_out_id IS NULL) OR (element_out_id > 0))))
);


ALTER TABLE competition.entry_event_transfers OWNER TO letletme_data_owner;

--
-- Name: entry_event_transfers_transfer_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.entry_event_transfers ALTER COLUMN transfer_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.entry_event_transfers_transfer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: entry_leagues; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.entry_leagues (
    season_id smallint NOT NULL,
    entry_id integer NOT NULL,
    league_id integer NOT NULL,
    league_type competition.league_type NOT NULL,
    source_entry_league_id integer NOT NULL,
    league_name text NOT NULL,
    started_event integer,
    entry_rank integer,
    entry_last_rank integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entry_leagues_ids_positive CHECK (((entry_id > 0) AND (league_id > 0) AND (source_entry_league_id > 0))),
    CONSTRAINT entry_leagues_name_nonempty CHECK ((btrim(league_name) <> ''::text)),
    CONSTRAINT entry_leagues_started_event_positive CHECK (((started_event IS NULL) OR (started_event > 0)))
);


ALTER TABLE competition.entry_leagues OWNER TO letletme_data_owner;

--
-- Name: entry_leagues_source_entry_league_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.entry_leagues ALTER COLUMN source_entry_league_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.entry_leagues_source_entry_league_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: entry_season_histories; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.entry_season_histories (
    season_id smallint NOT NULL,
    entry_id integer NOT NULL,
    source_history_id integer NOT NULL,
    source_season_label text NOT NULL,
    total_points integer DEFAULT 0 NOT NULL,
    overall_rank integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entry_season_histories_ids_positive CHECK (((entry_id > 0) AND (source_history_id > 0))),
    CONSTRAINT entry_season_histories_label_format CHECK ((source_season_label ~ '^[0-9]{4}/[0-9]{2}$'::text)),
    CONSTRAINT entry_season_histories_totals_nonnegative CHECK (((total_points >= 0) AND (overall_rank >= 0)))
);


ALTER TABLE competition.entry_season_histories OWNER TO letletme_data_owner;

--
-- Name: entry_season_histories_source_history_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.entry_season_histories ALTER COLUMN source_history_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.entry_season_histories_source_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: league_event_results; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.league_event_results (
    season_id smallint NOT NULL,
    source_result_id integer NOT NULL,
    league_id integer NOT NULL,
    league_type competition.league_type NOT NULL,
    entry_id integer NOT NULL,
    event_id integer NOT NULL,
    event_points integer DEFAULT 0 NOT NULL,
    event_transfers integer DEFAULT 0 NOT NULL,
    event_transfers_cost integer DEFAULT 0 NOT NULL,
    event_net_points integer DEFAULT 0 NOT NULL,
    overall_points integer DEFAULT 0 NOT NULL,
    overall_rank integer DEFAULT 0 NOT NULL,
    entry_name text,
    player_name text,
    team_value integer,
    bank integer,
    event_bench_points integer,
    event_auto_sub_points integer,
    event_rank integer,
    event_chip competition.chip,
    captain_element_id integer,
    captain_points integer,
    captain_blank boolean,
    vice_captain_element_id integer,
    vice_captain_points integer,
    vice_captain_blank boolean,
    played_captain_element_id integer,
    highest_score_element_id integer,
    highest_score_points integer,
    highest_score_blank boolean,
    source_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT league_event_results_ids_positive CHECK (((source_result_id > 0) AND (league_id > 0) AND (entry_id > 0) AND (event_id > 0))),
    CONSTRAINT league_event_results_transfer_counts_nonnegative CHECK (((event_transfers >= 0) AND (event_transfers_cost >= 0)))
);


ALTER TABLE competition.league_event_results OWNER TO letletme_data_owner;

--
-- Name: league_event_results_source_result_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.league_event_results ALTER COLUMN source_result_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.league_event_results_source_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: public_league_trends; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.public_league_trends (
    season_id smallint NOT NULL,
    tournament_id integer NOT NULL,
    display_name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_league_trends_display_name_nonempty CHECK ((btrim(display_name) <> ''::text)),
    CONSTRAINT public_league_trends_sort_order_nonnegative CHECK ((sort_order >= 0)),
    CONSTRAINT public_league_trends_tournament_id_positive CHECK ((tournament_id > 0))
);


ALTER TABLE competition.public_league_trends OWNER TO letletme_data_owner;

--
-- Name: tournament_battle_group_results; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.tournament_battle_group_results (
    source_result_id integer NOT NULL,
    tournament_id integer NOT NULL,
    season_id smallint NOT NULL,
    group_id integer NOT NULL,
    event_id integer NOT NULL,
    home_index integer NOT NULL,
    home_entry_id integer NOT NULL,
    home_net_points integer,
    home_rank integer,
    home_match_points integer,
    away_index integer NOT NULL,
    away_entry_id integer NOT NULL,
    away_net_points integer,
    away_rank integer,
    away_match_points integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournament_battle_group_results_distinct_entries CHECK ((home_entry_id <> away_entry_id)),
    CONSTRAINT tournament_battle_group_results_ids_positive CHECK (((source_result_id > 0) AND (tournament_id > 0) AND (group_id > 0) AND (event_id > 0) AND (home_entry_id > 0) AND (away_entry_id > 0)))
);


ALTER TABLE competition.tournament_battle_group_results OWNER TO letletme_data_owner;

--
-- Name: tournament_battle_group_results_source_result_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.tournament_battle_group_results ALTER COLUMN source_result_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.tournament_battle_group_results_source_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tournament_entries; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.tournament_entries (
    tournament_id integer NOT NULL,
    season_id smallint NOT NULL,
    league_id integer NOT NULL,
    entry_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournament_entries_ids_positive CHECK (((tournament_id > 0) AND (league_id > 0) AND (entry_id > 0)))
);


ALTER TABLE competition.tournament_entries OWNER TO letletme_data_owner;

--
-- Name: tournament_groups; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.tournament_groups (
    source_group_row_id integer NOT NULL,
    tournament_id integer NOT NULL,
    season_id smallint NOT NULL,
    group_id integer NOT NULL,
    group_name text NOT NULL,
    group_index integer NOT NULL,
    entry_id integer NOT NULL,
    started_event_id integer,
    ended_event_id integer,
    group_points integer,
    group_rank integer,
    played integer,
    won integer,
    drawn integer,
    lost integer,
    total_points integer,
    total_transfers_cost integer,
    total_net_points integer,
    qualified integer,
    overall_rank integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournament_groups_event_order CHECK (((ended_event_id IS NULL) OR (started_event_id IS NULL) OR (ended_event_id >= started_event_id))),
    CONSTRAINT tournament_groups_ids_positive CHECK (((source_group_row_id > 0) AND (tournament_id > 0) AND (group_id > 0) AND (entry_id > 0))),
    CONSTRAINT tournament_groups_name_nonempty CHECK ((btrim(group_name) <> ''::text))
);


ALTER TABLE competition.tournament_groups OWNER TO letletme_data_owner;

--
-- Name: tournament_groups_source_group_row_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.tournament_groups ALTER COLUMN source_group_row_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.tournament_groups_source_group_row_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tournament_knockout_results; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.tournament_knockout_results (
    source_result_id integer NOT NULL,
    tournament_id integer NOT NULL,
    season_id smallint NOT NULL,
    event_id integer NOT NULL,
    match_id integer NOT NULL,
    play_against_id integer NOT NULL,
    home_entry_id integer,
    home_net_points integer,
    home_goals_scored integer,
    home_goals_conceded integer,
    away_entry_id integer,
    away_net_points integer,
    away_goals_scored integer,
    away_goals_conceded integer,
    match_winner integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournament_knockout_results_distinct_entries CHECK (((home_entry_id IS NULL) OR (away_entry_id IS NULL) OR (home_entry_id <> away_entry_id))),
    CONSTRAINT tournament_knockout_results_ids_positive CHECK (((source_result_id > 0) AND (tournament_id > 0) AND (event_id > 0) AND (match_id > 0) AND (play_against_id > 0)))
);


ALTER TABLE competition.tournament_knockout_results OWNER TO letletme_data_owner;

--
-- Name: tournament_knockout_results_source_result_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.tournament_knockout_results ALTER COLUMN source_result_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.tournament_knockout_results_source_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tournament_knockouts; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.tournament_knockouts (
    source_knockout_id integer NOT NULL,
    tournament_id integer NOT NULL,
    season_id smallint NOT NULL,
    round integer NOT NULL,
    started_event_id integer,
    ended_event_id integer,
    match_id integer NOT NULL,
    next_match_id integer,
    home_entry_id integer,
    home_net_points integer,
    home_goals_scored integer,
    home_goals_conceded integer,
    home_wins integer,
    away_entry_id integer,
    away_net_points integer,
    away_goals_scored integer,
    away_goals_conceded integer,
    away_wins integer,
    round_winner integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournament_knockouts_event_order CHECK (((ended_event_id IS NULL) OR (started_event_id IS NULL) OR (ended_event_id >= started_event_id))),
    CONSTRAINT tournament_knockouts_ids_positive CHECK (((source_knockout_id > 0) AND (tournament_id > 0) AND (round > 0) AND (match_id > 0)))
);


ALTER TABLE competition.tournament_knockouts OWNER TO letletme_data_owner;

--
-- Name: tournament_knockouts_source_knockout_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.tournament_knockouts ALTER COLUMN source_knockout_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.tournament_knockouts_source_knockout_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tournament_points_group_results; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.tournament_points_group_results (
    source_result_id integer NOT NULL,
    tournament_id integer NOT NULL,
    season_id smallint NOT NULL,
    group_id integer NOT NULL,
    event_id integer NOT NULL,
    entry_id integer NOT NULL,
    event_group_rank integer,
    event_points integer,
    event_cost integer,
    event_net_points integer,
    event_rank integer,
    cumulative_transfers integer DEFAULT 0 NOT NULL,
    cumulative_costs integer DEFAULT 0 NOT NULL,
    cumulative_bench_points integer DEFAULT 0 NOT NULL,
    cumulative_auto_sub_points integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournament_points_group_results_cumulative_nonnegative CHECK (((cumulative_transfers >= 0) AND (cumulative_costs >= 0) AND (cumulative_bench_points >= 0) AND (cumulative_auto_sub_points >= 0))),
    CONSTRAINT tournament_points_group_results_ids_positive CHECK (((source_result_id > 0) AND (tournament_id > 0) AND (group_id > 0) AND (event_id > 0) AND (entry_id > 0)))
);


ALTER TABLE competition.tournament_points_group_results OWNER TO letletme_data_owner;

--
-- Name: tournament_points_group_results_source_result_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.tournament_points_group_results ALTER COLUMN source_result_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.tournament_points_group_results_source_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tournaments; Type: TABLE; Schema: competition; Owner: letletme_data_owner
--

CREATE TABLE competition.tournaments (
    tournament_id integer NOT NULL,
    season_id smallint NOT NULL,
    name text NOT NULL,
    creator text NOT NULL,
    admin_entry_id integer NOT NULL,
    league_id integer NOT NULL,
    league_type competition.league_type NOT NULL,
    total_team_num integer NOT NULL,
    tournament_mode competition.tournament_mode NOT NULL,
    group_mode competition.group_mode,
    group_team_num integer,
    group_num integer,
    group_started_event_id integer,
    group_ended_event_id integer,
    group_auto_averages boolean NOT NULL,
    group_rounds integer,
    group_play_against_num integer,
    group_qualify_num integer,
    knockout_mode competition.knockout_mode,
    knockout_team_num integer,
    knockout_rounds integer,
    knockout_event_num integer,
    knockout_started_event_id integer,
    knockout_ended_event_id integer,
    knockout_play_against_num integer,
    state competition.tournament_state NOT NULL,
    setup_status competition.tournament_setup_status DEFAULT 'pending'::competition.tournament_setup_status NOT NULL,
    setup_error text,
    setup_started_at timestamp with time zone,
    setup_finished_at timestamp with time zone,
    source_league_name text,
    roster_mode competition.tournament_roster_mode DEFAULT 'snapshot'::competition.tournament_roster_mode NOT NULL,
    roster_sync_status competition.tournament_setup_status,
    roster_last_synced_at timestamp with time zone,
    roster_sync_error text,
    setup_phase competition.tournament_setup_phase DEFAULT 'queued'::competition.tournament_setup_phase NOT NULL,
    setup_completed_units integer DEFAULT 0 NOT NULL,
    setup_total_units integer DEFAULT 0 NOT NULL,
    setup_progress_updated_at timestamp with time zone,
    standings_ready_at timestamp with time zone,
    setup_warning_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournaments_group_event_order CHECK (((group_ended_event_id IS NULL) OR (group_started_event_id IS NULL) OR (group_ended_event_id >= group_started_event_id))),
    CONSTRAINT tournaments_ids_positive CHECK (((tournament_id > 0) AND (admin_entry_id > 0) AND (league_id > 0) AND (total_team_num > 0))),
    CONSTRAINT tournaments_knockout_event_order CHECK (((knockout_ended_event_id IS NULL) OR (knockout_started_event_id IS NULL) OR (knockout_ended_event_id >= knockout_started_event_id))),
    CONSTRAINT tournaments_name_nonempty CHECK (((btrim(name) <> ''::text) AND (btrim(creator) <> ''::text))),
    CONSTRAINT tournaments_setup_counts_valid CHECK (((setup_completed_units >= 0) AND (setup_total_units >= 0) AND (setup_completed_units <= setup_total_units) AND (setup_warning_count >= 0))),
    CONSTRAINT tournaments_setup_time_order CHECK (((setup_finished_at IS NULL) OR (setup_started_at IS NULL) OR (setup_finished_at >= setup_started_at)))
);


ALTER TABLE competition.tournaments OWNER TO letletme_data_owner;

--
-- Name: tournaments_tournament_id_seq; Type: SEQUENCE; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE competition.tournaments ALTER COLUMN tournament_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME competition.tournaments_tournament_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: events; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.events (
    season_id smallint NOT NULL,
    event_id integer NOT NULL,
    name text NOT NULL,
    deadline_time timestamp with time zone,
    average_entry_score integer,
    finished boolean DEFAULT false NOT NULL,
    data_checked boolean DEFAULT false NOT NULL,
    highest_scoring_entry bigint,
    deadline_time_epoch bigint,
    deadline_time_game_offset integer,
    highest_score integer,
    is_previous boolean DEFAULT false NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    is_next boolean DEFAULT false NOT NULL,
    cup_league_create boolean DEFAULT false NOT NULL,
    h2h_ko_matches_created boolean DEFAULT false NOT NULL,
    chip_plays jsonb DEFAULT '[]'::jsonb NOT NULL,
    most_selected integer,
    most_transferred_in integer,
    top_element integer,
    top_element_info jsonb,
    transfers_made bigint,
    most_captained integer,
    most_vice_captained integer,
    live_snapshot_checked_at timestamp with time zone,
    live_snapshot_finalized_at timestamp with time zone,
    data_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT events_chip_plays_array CHECK ((jsonb_typeof(chip_plays) = 'array'::text)),
    CONSTRAINT events_event_id_positive CHECK ((event_id > 0)),
    CONSTRAINT events_finalization_order CHECK (((live_snapshot_finalized_at IS NULL) OR (live_snapshot_checked_at IS NULL) OR (live_snapshot_finalized_at >= live_snapshot_checked_at))),
    CONSTRAINT events_scores_nonnegative CHECK ((((average_entry_score IS NULL) OR (average_entry_score >= 0)) AND ((highest_score IS NULL) OR (highest_score >= 0))))
);


ALTER TABLE fpl.events OWNER TO letletme_data_owner;

--
-- Name: fixtures; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.fixtures (
    season_id smallint NOT NULL,
    fixture_id integer NOT NULL,
    code integer NOT NULL,
    event_id integer,
    kickoff_time timestamp with time zone,
    started boolean DEFAULT false NOT NULL,
    finished boolean DEFAULT false NOT NULL,
    finished_provisional boolean DEFAULT false NOT NULL,
    provisional_start_time boolean DEFAULT false NOT NULL,
    minutes integer DEFAULT 0 NOT NULL,
    team_h_id integer,
    team_h_difficulty integer,
    team_h_score integer,
    team_a_id integer,
    team_a_difficulty integer,
    team_a_score integer,
    stats jsonb DEFAULT '[]'::jsonb NOT NULL,
    pulse_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fixtures_code_positive CHECK ((code > 0)),
    CONSTRAINT fixtures_difficulty_valid CHECK ((((team_h_difficulty IS NULL) OR ((team_h_difficulty >= 0) AND (team_h_difficulty <= 5))) AND ((team_a_difficulty IS NULL) OR ((team_a_difficulty >= 0) AND (team_a_difficulty <= 5))))),
    CONSTRAINT fixtures_distinct_teams CHECK (((team_h_id IS NULL) OR (team_a_id IS NULL) OR (team_h_id <> team_a_id))),
    CONSTRAINT fixtures_event_positive CHECK (((event_id IS NULL) OR (event_id > 0))),
    CONSTRAINT fixtures_fixture_id_positive CHECK ((fixture_id > 0)),
    CONSTRAINT fixtures_minutes_valid CHECK (((minutes >= 0) AND (minutes <= 180))),
    CONSTRAINT fixtures_scores_nonnegative CHECK ((((team_h_score IS NULL) OR (team_h_score >= 0)) AND ((team_a_score IS NULL) OR (team_a_score >= 0)))),
    CONSTRAINT fixtures_stats_array CHECK ((jsonb_typeof(stats) = 'array'::text))
);


ALTER TABLE fpl.fixtures OWNER TO letletme_data_owner;

--
-- Name: phases; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.phases (
    season_id smallint NOT NULL,
    phase_id integer NOT NULL,
    name text NOT NULL,
    start_event integer NOT NULL,
    stop_event integer NOT NULL,
    highest_score integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT phases_event_range CHECK (((start_event > 0) AND (stop_event >= start_event))),
    CONSTRAINT phases_highest_score_nonnegative CHECK (((highest_score IS NULL) OR (highest_score >= 0))),
    CONSTRAINT phases_name_nonempty CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT phases_phase_id_positive CHECK ((phase_id > 0))
);


ALTER TABLE fpl.phases OWNER TO letletme_data_owner;

--
-- Name: player_event_snapshots; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.player_event_snapshots (
    season_id smallint NOT NULL,
    event_id integer NOT NULL,
    element_id integer NOT NULL,
    source_snapshot_id integer NOT NULL,
    element_type integer NOT NULL,
    total_points integer,
    form numeric,
    influence numeric,
    creativity numeric,
    threat numeric,
    ict_index numeric,
    expected_goals numeric,
    expected_assists numeric,
    expected_goal_involvements numeric,
    expected_goals_conceded numeric,
    minutes integer,
    goals_scored integer,
    assists integer,
    clean_sheets integer,
    goals_conceded integer,
    own_goals integer,
    penalties_saved integer,
    yellow_cards integer,
    red_cards integer,
    saves integer,
    bonus integer,
    bps integer,
    starts integer,
    influence_rank integer,
    influence_rank_type integer,
    creativity_rank integer,
    creativity_rank_type integer,
    threat_rank integer,
    threat_rank_type integer,
    ict_index_rank integer,
    ict_index_rank_type integer,
    transfers_in integer,
    transfers_in_event integer,
    transfers_out integer,
    transfers_out_event integer,
    selected_by_percent numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT player_event_snapshots_ids_positive CHECK (((event_id > 0) AND (element_id > 0) AND (source_snapshot_id > 0) AND (element_type > 0))),
    CONSTRAINT player_event_snapshots_minutes_nonnegative CHECK (((minutes IS NULL) OR (minutes >= 0))),
    CONSTRAINT player_event_snapshots_selected_percent CHECK (((selected_by_percent IS NULL) OR ((selected_by_percent >= (0)::numeric) AND (selected_by_percent <= (100)::numeric))))
);


ALTER TABLE fpl.player_event_snapshots OWNER TO letletme_data_owner;

--
-- Name: player_event_snapshots_source_snapshot_id_seq; Type: SEQUENCE; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE fpl.player_event_snapshots ALTER COLUMN source_snapshot_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME fpl.player_event_snapshots_source_snapshot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: player_fixture_stats; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.player_fixture_stats (
    season_id smallint NOT NULL,
    fixture_id integer NOT NULL,
    element_id integer NOT NULL,
    source_fixture_stat_id integer NOT NULL,
    event_id integer NOT NULL,
    fixture_code integer NOT NULL,
    player_code integer NOT NULL,
    team_id integer NOT NULL,
    team_code integer NOT NULL,
    element_type integer NOT NULL,
    minutes integer NOT NULL,
    starts integer,
    goals integer NOT NULL,
    assists integer NOT NULL,
    own_goals integer NOT NULL,
    yellow_cards integer NOT NULL,
    red_cards integer NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT player_fixture_stats_counts_nonnegative CHECK (((minutes >= 0) AND ((starts IS NULL) OR (starts >= 0)) AND (goals >= 0) AND (assists >= 0) AND (own_goals >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0))),
    CONSTRAINT player_fixture_stats_ids_positive CHECK (((fixture_id > 0) AND (element_id > 0) AND (source_fixture_stat_id > 0) AND (event_id > 0) AND (fixture_code > 0) AND (player_code > 0) AND (team_id > 0) AND (team_code > 0) AND (element_type > 0))),
    CONSTRAINT player_fixture_stats_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text))
);


ALTER TABLE fpl.player_fixture_stats OWNER TO letletme_data_owner;

--
-- Name: player_fixture_stats_source_fixture_stat_id_seq; Type: SEQUENCE; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE fpl.player_fixture_stats ALTER COLUMN source_fixture_stat_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME fpl.player_fixture_stats_source_fixture_stat_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: player_gameweek_scoring_items; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.player_gameweek_scoring_items (
    season_id smallint NOT NULL,
    event_id integer NOT NULL,
    element_id integer NOT NULL,
    scoring_identifier text NOT NULL,
    scoring_value integer NOT NULL,
    points integer NOT NULL,
    source_explain_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT player_gameweek_scoring_items_identifier_valid CHECK ((scoring_identifier = ANY (ARRAY['minutes'::text, 'goals_scored'::text, 'assists'::text, 'clean_sheets'::text, 'goals_conceded'::text, 'own_goals'::text, 'penalties_saved'::text, 'penalties_missed'::text, 'yellow_cards'::text, 'red_cards'::text, 'saves'::text, 'bonus'::text, 'defensive_contribution'::text]))),
    CONSTRAINT player_gameweek_scoring_items_ids_positive CHECK (((event_id > 0) AND (element_id > 0) AND (source_explain_id > 0)))
);


ALTER TABLE fpl.player_gameweek_scoring_items OWNER TO letletme_data_owner;

--
-- Name: player_gameweek_scoring_items_source_explain_id_seq; Type: SEQUENCE; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE fpl.player_gameweek_scoring_items ALTER COLUMN source_explain_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME fpl.player_gameweek_scoring_items_source_explain_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: player_gameweek_stats; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.player_gameweek_stats (
    season_id smallint NOT NULL,
    event_id integer NOT NULL,
    element_id integer NOT NULL,
    source_live_id integer NOT NULL,
    minutes integer,
    goals_scored integer,
    assists integer,
    clean_sheets integer,
    goals_conceded integer,
    own_goals integer,
    penalties_saved integer,
    penalties_missed integer,
    yellow_cards integer,
    red_cards integer,
    saves integer,
    bonus integer,
    bps integer,
    starts boolean,
    expected_goals numeric,
    expected_assists numeric,
    expected_goal_involvements numeric,
    expected_goals_conceded numeric,
    in_dream_team boolean,
    total_points integer DEFAULT 0 NOT NULL,
    defensive_contribution integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT player_gameweek_stats_ids_positive CHECK (((event_id > 0) AND (element_id > 0) AND (source_live_id > 0))),
    CONSTRAINT player_gameweek_stats_minutes_nonnegative CHECK (((minutes IS NULL) OR (minutes >= 0)))
);


ALTER TABLE fpl.player_gameweek_stats OWNER TO letletme_data_owner;

--
-- Name: player_gameweek_stats_source_live_id_seq; Type: SEQUENCE; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE fpl.player_gameweek_stats ALTER COLUMN source_live_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME fpl.player_gameweek_stats_source_live_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: player_market_snapshots; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.player_market_snapshots (
    season_id smallint NOT NULL,
    snapshot_date date NOT NULL,
    element_id integer NOT NULL,
    source_snapshot_id integer,
    snapshot_source text DEFAULT 'upstream'::text NOT NULL,
    source_value_id integer,
    source_event_id integer,
    captured_at timestamp with time zone NOT NULL,
    player_code integer NOT NULL,
    web_name text NOT NULL,
    first_name text NOT NULL,
    second_name text NOT NULL,
    team_id integer NOT NULL,
    team_name text NOT NULL,
    team_short_name text NOT NULL,
    element_type integer NOT NULL,
    "position" text NOT NULL,
    price integer NOT NULL,
    selected_by_percent numeric NOT NULL,
    transfers_in integer NOT NULL,
    transfers_out integer NOT NULL,
    transfers_in_event integer NOT NULL,
    transfers_out_event integer NOT NULL,
    status text NOT NULL,
    news text NOT NULL,
    news_added timestamp with time zone,
    chance_of_playing_this_round integer,
    chance_of_playing_next_round integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT player_market_snapshots_chance_valid CHECK ((((chance_of_playing_this_round IS NULL) OR ((chance_of_playing_this_round >= 0) AND (chance_of_playing_this_round <= 100))) AND ((chance_of_playing_next_round IS NULL) OR ((chance_of_playing_next_round >= 0) AND (chance_of_playing_next_round <= 100))))),
    CONSTRAINT player_market_snapshots_ids_positive CHECK (((element_id > 0) AND (player_code > 0) AND (team_id > 0) AND (element_type > 0) AND ((source_snapshot_id IS NULL) OR (source_snapshot_id > 0)) AND ((source_value_id IS NULL) OR (source_value_id > 0)) AND ((source_event_id IS NULL) OR (source_event_id > 0)))),
    CONSTRAINT player_market_snapshots_price_nonnegative CHECK ((price >= 0)),
    CONSTRAINT player_market_snapshots_selected_percent CHECK (((selected_by_percent >= (0)::numeric) AND (selected_by_percent <= (100)::numeric))),
    CONSTRAINT player_market_snapshots_source_valid CHECK ((((snapshot_source = 'upstream'::text) AND (source_snapshot_id IS NOT NULL) AND (source_value_id IS NULL)) OR ((snapshot_source = 'value_seed'::text) AND (source_snapshot_id IS NULL) AND (source_value_id IS NOT NULL) AND (source_event_id IS NOT NULL)))),
    CONSTRAINT player_market_snapshots_transfers_nonnegative CHECK (((transfers_in >= 0) AND (transfers_out >= 0) AND (transfers_in_event >= 0) AND (transfers_out_event >= 0)))
);


ALTER TABLE fpl.player_market_snapshots OWNER TO letletme_data_owner;

--
-- Name: player_market_snapshots_source_snapshot_id_seq; Type: SEQUENCE; Schema: fpl; Owner: letletme_data_owner
--

CREATE SEQUENCE fpl.player_market_snapshots_source_snapshot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE fpl.player_market_snapshots_source_snapshot_id_seq OWNER TO letletme_data_owner;

--
-- Name: player_market_snapshots_source_snapshot_id_seq; Type: SEQUENCE OWNED BY; Schema: fpl; Owner: letletme_data_owner
--

ALTER SEQUENCE fpl.player_market_snapshots_source_snapshot_id_seq OWNED BY fpl.player_market_snapshots.source_snapshot_id;


--
-- Name: players; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.players (
    season_id smallint NOT NULL,
    element_id integer NOT NULL,
    code integer NOT NULL,
    element_type integer NOT NULL,
    team_id integer NOT NULL,
    price integer DEFAULT 0 NOT NULL,
    start_price integer DEFAULT 0 NOT NULL,
    first_name text,
    second_name text,
    web_name text NOT NULL,
    total_points integer DEFAULT 0 NOT NULL,
    price_source_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT players_code_positive CHECK ((code > 0)),
    CONSTRAINT players_element_id_positive CHECK ((element_id > 0)),
    CONSTRAINT players_element_type_positive CHECK ((element_type > 0)),
    CONSTRAINT players_prices_nonnegative CHECK (((price >= 0) AND (start_price >= 0))),
    CONSTRAINT players_web_name_nonempty CHECK ((btrim(web_name) <> ''::text))
);


ALTER TABLE fpl.players OWNER TO letletme_data_owner;

--
-- Name: seasons; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.seasons (
    season_id smallint NOT NULL,
    season_code text NOT NULL,
    display_name text NOT NULL,
    start_year smallint NOT NULL,
    end_year smallint NOT NULL,
    lifecycle_state text NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    starts_at date,
    ends_at date,
    source_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT seasons_code_format CHECK ((season_code ~ '^[0-9]{4}$'::text)),
    CONSTRAINT seasons_date_order CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at))),
    CONSTRAINT seasons_id_is_start_year CHECK ((season_id = start_year)),
    CONSTRAINT seasons_lifecycle_state_valid CHECK ((lifecycle_state = ANY (ARRAY['reference_only'::text, 'completed'::text, 'preseason'::text, 'active'::text, 'closed'::text]))),
    CONSTRAINT seasons_source_metadata_object CHECK ((jsonb_typeof(source_metadata) = 'object'::text)),
    CONSTRAINT seasons_year_span CHECK ((end_year = (start_year + 1)))
);


ALTER TABLE fpl.seasons OWNER TO letletme_data_owner;

--
-- Name: teams; Type: TABLE; Schema: fpl; Owner: letletme_data_owner
--

CREATE TABLE fpl.teams (
    season_id smallint NOT NULL,
    team_id integer NOT NULL,
    code integer NOT NULL,
    name text NOT NULL,
    short_name text NOT NULL,
    strength integer,
    "position" integer DEFAULT 0 NOT NULL,
    points integer DEFAULT 0 NOT NULL,
    win integer DEFAULT 0 NOT NULL,
    draw integer DEFAULT 0 NOT NULL,
    loss integer DEFAULT 0 NOT NULL,
    played integer DEFAULT 0 NOT NULL,
    form text,
    team_division integer,
    unavailable boolean DEFAULT false NOT NULL,
    strength_overall_home integer DEFAULT 1000 NOT NULL,
    strength_overall_away integer DEFAULT 1000 NOT NULL,
    strength_attack_home integer DEFAULT 1000 NOT NULL,
    strength_attack_away integer DEFAULT 1000 NOT NULL,
    strength_defence_home integer DEFAULT 1000 NOT NULL,
    strength_defence_away integer DEFAULT 1000 NOT NULL,
    pulse_id integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT teams_code_positive CHECK ((code > 0)),
    CONSTRAINT teams_names_nonempty CHECK (((btrim(name) <> ''::text) AND (btrim(short_name) <> ''::text))),
    CONSTRAINT teams_record_nonnegative CHECK ((("position" >= 0) AND (win >= 0) AND (draw >= 0) AND (loss >= 0) AND (played >= 0))),
    CONSTRAINT teams_team_id_positive CHECK ((team_id > 0))
);


ALTER TABLE fpl.teams OWNER TO letletme_data_owner;

--
-- Name: dataset_publication_revisions; Type: SEQUENCE; Schema: ops; Owner: letletme_data_owner
--

CREATE SEQUENCE ops.dataset_publication_revisions
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ops.dataset_publication_revisions OWNER TO letletme_data_owner;

--
-- Name: dataset_publications; Type: TABLE; Schema: ops; Owner: letletme_data_owner
--

CREATE TABLE ops.dataset_publications (
    publication_id uuid NOT NULL,
    dataset text NOT NULL,
    season_id smallint,
    event_id integer,
    revision bigint DEFAULT nextval('ops.dataset_publication_revisions'::regclass) NOT NULL,
    status text DEFAULT 'staging'::text NOT NULL,
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_run_id uuid,
    activated_at timestamp with time zone,
    retired_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dataset_publications_active_timestamp CHECK (((status <> 'active'::text) OR (activated_at IS NOT NULL))),
    CONSTRAINT dataset_publications_dataset_nonempty CHECK ((btrim(dataset) <> ''::text)),
    CONSTRAINT dataset_publications_event_positive CHECK (((event_id IS NULL) OR (event_id > 0))),
    CONSTRAINT dataset_publications_manifest_object CHECK ((jsonb_typeof(manifest) = 'object'::text)),
    CONSTRAINT dataset_publications_publication_id_rfc_uuid CHECK (((publication_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT dataset_publications_retired_timestamp CHECK (((status <> 'retired'::text) OR (retired_at IS NOT NULL))),
    CONSTRAINT dataset_publications_revision_positive CHECK ((revision > 0)),
    CONSTRAINT dataset_publications_status_valid CHECK ((status = ANY (ARRAY['staging'::text, 'active'::text, 'retired'::text, 'failed'::text])))
);


ALTER TABLE ops.dataset_publications OWNER TO letletme_data_owner;

--
-- Name: schema_migrations; Type: TABLE; Schema: ops; Owner: letletme_data_owner
--

CREATE TABLE ops.schema_migrations (
    filename text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schema_migrations_checksum_sha256 CHECK ((checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT schema_migrations_filename_nonempty CHECK ((btrim(filename) <> ''::text))
);


ALTER TABLE ops.schema_migrations OWNER TO letletme_data_owner;

--
-- Name: season_imports; Type: TABLE; Schema: ops; Owner: letletme_data_owner
--

CREATE TABLE ops.season_imports (
    season_id smallint NOT NULL,
    season_code text NOT NULL,
    status text NOT NULL,
    reason text,
    source_core_revision text,
    item_manifest jsonb DEFAULT '[]'::jsonb NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT season_imports_completion_order CHECK (((completed_at IS NULL) OR (started_at IS NULL) OR (completed_at >= started_at))),
    CONSTRAINT season_imports_manifest_array CHECK ((jsonb_typeof(item_manifest) = 'array'::text)),
    CONSTRAINT season_imports_season_code_format CHECK ((season_code ~ '^[0-9]{4}$'::text)),
    CONSTRAINT season_imports_status_valid CHECK ((status = ANY (ARRAY['unavailable'::text, 'pending'::text, 'building'::text, 'sealed'::text, 'failed'::text])))
);


ALTER TABLE ops.season_imports OWNER TO letletme_data_owner;

--
-- Name: sync_items; Type: TABLE; Schema: ops; Owner: letletme_data_owner
--

CREATE TABLE ops.sync_items (
    run_id uuid NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    source_hash text,
    normalized_payload jsonb,
    last_error text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_items_attempts_nonnegative CHECK ((attempts >= 0)),
    CONSTRAINT sync_items_payload_object CHECK (((normalized_payload IS NULL) OR (jsonb_typeof(normalized_payload) = 'object'::text))),
    CONSTRAINT sync_items_resource_id_nonempty CHECK ((btrim(resource_id) <> ''::text)),
    CONSTRAINT sync_items_resource_type_nonempty CHECK ((btrim(resource_type) <> ''::text)),
    CONSTRAINT sync_items_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'failed'::text, 'completed'::text, 'skipped'::text])))
);


ALTER TABLE ops.sync_items OWNER TO letletme_data_owner;

--
-- Name: sync_runs; Type: TABLE; Schema: ops; Owner: letletme_data_owner
--

CREATE TABLE ops.sync_runs (
    run_id uuid NOT NULL,
    provider text NOT NULL,
    lane text NOT NULL,
    scope text NOT NULL,
    season_id smallint,
    season_code text,
    event_id integer,
    mode text NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    expected_items integer DEFAULT 0 NOT NULL,
    completed_items integer DEFAULT 0 NOT NULL,
    failed_items integer DEFAULT 0 NOT NULL,
    skipped_items integer DEFAULT 0 NOT NULL,
    data_changed boolean DEFAULT false NOT NULL,
    publication_id uuid,
    error_summary text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_runs_completion_order CHECK (((completed_at IS NULL) OR (completed_at >= started_at))),
    CONSTRAINT sync_runs_event_positive CHECK (((event_id IS NULL) OR (event_id > 0))),
    CONSTRAINT sync_runs_item_counts_nonnegative CHECK (((expected_items >= 0) AND (completed_items >= 0) AND (failed_items >= 0) AND (skipped_items >= 0))),
    CONSTRAINT sync_runs_lane_nonempty CHECK ((btrim(lane) <> ''::text)),
    CONSTRAINT sync_runs_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT sync_runs_mode_nonempty CHECK ((btrim(mode) <> ''::text)),
    CONSTRAINT sync_runs_provider_nonempty CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT sync_runs_scope_nonempty CHECK ((btrim(scope) <> ''::text)),
    CONSTRAINT sync_runs_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'failed'::text, 'completed'::text, 'ready_to_publish'::text, 'published'::text, 'skipped'::text]))),
    CONSTRAINT sync_runs_trigger_nonempty CHECK ((btrim(trigger) <> ''::text))
);


ALTER TABLE ops.sync_runs OWNER TO letletme_data_owner;

--
-- Name: player_season_summaries; Type: VIEW; Schema: reporting; Owner: letletme_data_owner
--

CREATE VIEW reporting.player_season_summaries WITH (security_invoker='true') AS
 SELECT player.season_id,
    player.element_id,
    player.element_type,
    (count(stats.event_id))::integer AS gameweeks_available,
    (count(*) FILTER (WHERE (stats.starts IS TRUE)))::integer AS gameweeks_started,
    (COALESCE(sum(stats.minutes), (0)::bigint))::integer AS minutes,
    (COALESCE(sum(stats.goals_scored), (0)::bigint))::integer AS goals_scored,
    (COALESCE(sum(stats.assists), (0)::bigint))::integer AS assists,
    (COALESCE(sum(stats.clean_sheets), (0)::bigint))::integer AS clean_sheets,
    (COALESCE(sum(stats.goals_conceded), (0)::bigint))::integer AS goals_conceded,
    (COALESCE(sum(stats.own_goals), (0)::bigint))::integer AS own_goals,
    (COALESCE(sum(stats.penalties_saved), (0)::bigint))::integer AS penalties_saved,
    (COALESCE(sum(stats.penalties_missed), (0)::bigint))::integer AS penalties_missed,
    (COALESCE(sum(stats.yellow_cards), (0)::bigint))::integer AS yellow_cards,
    (COALESCE(sum(stats.red_cards), (0)::bigint))::integer AS red_cards,
    (COALESCE(sum(stats.saves), (0)::bigint))::integer AS saves,
    (COALESCE(sum(stats.bonus), (0)::bigint))::integer AS bonus,
    (COALESCE(sum(stats.bps), (0)::bigint))::integer AS bps,
    (COALESCE(sum(stats.total_points), (0)::bigint))::integer AS total_points,
    (COALESCE(sum(stats.defensive_contribution), (0)::bigint))::integer AS defensive_contribution,
    COALESCE(sum(stats.expected_goals), (0)::numeric) AS expected_goals,
    COALESCE(sum(stats.expected_assists), (0)::numeric) AS expected_assists,
    COALESCE(sum(stats.expected_goal_involvements), (0)::numeric) AS expected_goal_involvements,
    COALESCE(sum(stats.expected_goals_conceded), (0)::numeric) AS expected_goals_conceded,
    (count(*) FILTER (WHERE (stats.in_dream_team IS TRUE)))::integer AS dream_team_appearances
   FROM (fpl.players player
     LEFT JOIN fpl.player_gameweek_stats stats ON (((stats.season_id = player.season_id) AND (stats.element_id = player.element_id))))
  GROUP BY player.season_id, player.element_id, player.element_type;


ALTER TABLE reporting.player_season_summaries OWNER TO letletme_data_owner;

--
-- Name: player_value_changes; Type: VIEW; Schema: reporting; Owner: letletme_data_owner
--

CREATE VIEW reporting.player_value_changes WITH (security_invoker='true') AS
 WITH ordered_snapshots AS (
         SELECT snapshot.season_id,
            snapshot.snapshot_date,
            snapshot.element_id,
            snapshot.element_type,
            snapshot.price,
            snapshot.snapshot_source,
            snapshot.source_value_id,
            snapshot.source_event_id,
            lag(snapshot.price) OVER (PARTITION BY snapshot.season_id, snapshot.element_id ORDER BY snapshot.snapshot_date) AS previous_price,
            row_number() OVER (PARTITION BY snapshot.season_id, snapshot.element_id ORDER BY snapshot.snapshot_date) AS snapshot_number
           FROM fpl.player_market_snapshots snapshot
        ), changed_snapshots AS (
         SELECT ordered.season_id,
            ordered.snapshot_date,
            ordered.element_id,
            ordered.element_type,
            ordered.price,
            ordered.snapshot_source,
            ordered.source_value_id,
            ordered.source_event_id,
            ordered.previous_price,
            ordered.snapshot_number
           FROM ordered_snapshots ordered
          WHERE ((ordered.snapshot_number = 1) OR (ordered.price IS DISTINCT FROM ordered.previous_price))
        )
 SELECT changed.season_id,
    season.season_code,
    changed.snapshot_date,
    changed.element_id,
    changed.element_type,
    COALESCE(changed.source_event_id, event.event_id) AS event_id,
    changed.price AS value,
        CASE
            WHEN (changed.snapshot_number = 1) THEN 0
            ELSE changed.previous_price
        END AS last_value,
        CASE
            WHEN (changed.snapshot_number = 1) THEN 'start'::text
            WHEN (changed.price > changed.previous_price) THEN 'rise'::text
            ELSE 'fall'::text
        END AS change_type,
        CASE
            WHEN (changed.snapshot_number = 1) THEN changed.price
            ELSE (changed.price - changed.previous_price)
        END AS value_change,
    changed.snapshot_source,
    changed.source_value_id
   FROM ((changed_snapshots changed
     JOIN fpl.seasons season ON ((season.season_id = changed.season_id)))
     LEFT JOIN fpl.events event ON (((event.season_id = changed.season_id) AND ((event.deadline_time)::date = changed.snapshot_date))));


ALTER TABLE reporting.player_value_changes OWNER TO letletme_data_owner;

--
-- Name: tournament_entry_event_summaries; Type: MATERIALIZED VIEW; Schema: reporting; Owner: letletme_data_owner
--

CREATE MATERIALIZED VIEW reporting.tournament_entry_event_summaries AS
 WITH expected_entries AS (
         SELECT tournament_entries.tournament_id,
            tournament_entries.season_id,
            (count(*))::integer AS total_entries
           FROM competition.tournament_entries
          GROUP BY tournament_entries.tournament_id, tournament_entries.season_id
        ), valid_entry_events AS (
         SELECT entry.tournament_id,
            entry.season_id,
            pick.event_id,
            entry.entry_id
           FROM (competition.tournament_entries entry
             JOIN competition.entry_event_picks pick ON (((pick.season_id = entry.season_id) AND (pick.entry_id = entry.entry_id))))
          GROUP BY entry.tournament_id, entry.season_id, pick.event_id, entry.entry_id
         HAVING ((count(*) = 15) AND (min(pick."position") = 1) AND (max(pick."position") = 15) AND (count(*) FILTER (WHERE pick.is_captain) = 1) AND (count(*) FILTER (WHERE pick.is_vice_captain) = 1))
        ), complete_scopes AS (
         SELECT valid.tournament_id,
            valid.season_id,
            valid.event_id,
            expected.total_entries
           FROM (valid_entry_events valid
             JOIN expected_entries expected ON (((expected.tournament_id = valid.tournament_id) AND (expected.season_id = valid.season_id))))
          GROUP BY valid.tournament_id, valid.season_id, valid.event_id, expected.total_entries
         HAVING ((expected.total_entries > 0) AND (count(*) = expected.total_entries))
        ), pick_aggregates AS (
         SELECT entry.tournament_id,
            pick.season_id,
            pick.event_id,
            pick.entry_id,
            (count(*))::integer AS pick_count,
            (sum((pick.multiplier * COALESCE(stats.total_points, 0))))::integer AS selection_points,
            (sum(
                CASE
                    WHEN (pick.multiplier = 0) THEN COALESCE(stats.total_points, 0)
                    ELSE 0
                END))::integer AS calculated_bench_points,
            (sum(
                CASE
                    WHEN (player.element_type = 1) THEN (pick.multiplier * COALESCE(stats.total_points, 0))
                    ELSE 0
                END))::integer AS goalkeeper_points,
            (sum(
                CASE
                    WHEN (player.element_type = 2) THEN (pick.multiplier * COALESCE(stats.total_points, 0))
                    ELSE 0
                END))::integer AS defender_points,
            (sum(
                CASE
                    WHEN (player.element_type = 3) THEN (pick.multiplier * COALESCE(stats.total_points, 0))
                    ELSE 0
                END))::integer AS midfielder_points,
            (sum(
                CASE
                    WHEN (player.element_type = 4) THEN (pick.multiplier * COALESCE(stats.total_points, 0))
                    ELSE 0
                END))::integer AS forward_points,
            max(pick.element_id) FILTER (WHERE pick.is_captain) AS captain_element_id,
            max(pick.element_id) FILTER (WHERE pick.is_vice_captain) AS vice_captain_element_id
           FROM (((competition.tournament_entries entry
             JOIN competition.entry_event_picks pick ON (((pick.season_id = entry.season_id) AND (pick.entry_id = entry.entry_id))))
             JOIN fpl.players player ON (((player.season_id = pick.season_id) AND (player.element_id = pick.element_id))))
             LEFT JOIN fpl.player_gameweek_stats stats ON (((stats.season_id = pick.season_id) AND (stats.event_id = pick.event_id) AND (stats.element_id = pick.element_id))))
          GROUP BY entry.tournament_id, pick.season_id, pick.event_id, pick.entry_id
        ), transfer_aggregates AS (
         SELECT entry.tournament_id,
            transfer.season_id,
            transfer.event_id,
            transfer.entry_id,
            (count(*))::integer AS transfer_count
           FROM (competition.tournament_entries entry
             JOIN competition.entry_event_transfers transfer ON (((transfer.season_id = entry.season_id) AND (transfer.entry_id = entry.entry_id))))
          GROUP BY entry.tournament_id, transfer.season_id, transfer.event_id, transfer.entry_id
        ), base AS (
         SELECT entry.tournament_id,
            result.season_id,
            result.event_id,
            result.entry_id,
            scope.total_entries,
            result.event_points,
            result.event_transfers,
            result.event_transfers_cost,
            result.event_net_points,
            result.event_bench_points,
            result.event_auto_sub_points,
            result.event_rank,
            result.event_chip,
            result.played_captain_element_id,
            result.captain_points,
            result.overall_points,
            result.overall_rank,
            result.team_value,
            result.bank,
            pick.pick_count,
            pick.selection_points,
            pick.calculated_bench_points,
            pick.goalkeeper_points,
            pick.defender_points,
            pick.midfielder_points,
            pick.forward_points,
            pick.captain_element_id,
            pick.vice_captain_element_id,
            COALESCE(transfer.transfer_count, 0) AS transfer_row_count,
            event.live_snapshot_finalized_at AS source_finalized_at
           FROM (((((complete_scopes scope
             JOIN competition.tournament_entries entry ON (((entry.tournament_id = scope.tournament_id) AND (entry.season_id = scope.season_id))))
             JOIN competition.entry_event_results result ON (((result.season_id = entry.season_id) AND (result.entry_id = entry.entry_id) AND (result.event_id = scope.event_id) AND (result.rich_synced_at IS NOT NULL))))
             JOIN fpl.events event ON (((event.season_id = result.season_id) AND (event.event_id = result.event_id) AND event.finished AND event.data_checked AND (event.live_snapshot_finalized_at IS NOT NULL))))
             JOIN pick_aggregates pick ON (((pick.tournament_id = entry.tournament_id) AND (pick.season_id = result.season_id) AND (pick.event_id = result.event_id) AND (pick.entry_id = result.entry_id))))
             LEFT JOIN transfer_aggregates transfer ON (((transfer.tournament_id = entry.tournament_id) AND (transfer.season_id = result.season_id) AND (transfer.event_id = result.event_id) AND (transfer.entry_id = result.entry_id))))
        )
 SELECT base.tournament_id,
    base.season_id,
    base.event_id,
    base.entry_id,
    base.total_entries,
    base.event_points,
    base.event_transfers,
    base.event_transfers_cost,
    base.event_net_points,
    base.event_bench_points,
    base.event_auto_sub_points,
    base.event_rank,
    base.event_chip,
    base.played_captain_element_id,
    base.captain_points,
    base.overall_points,
    base.overall_rank,
    base.team_value,
    base.bank,
    base.pick_count,
    base.selection_points,
    base.calculated_bench_points,
    base.goalkeeper_points,
    base.defender_points,
    base.midfielder_points,
    base.forward_points,
    base.captain_element_id,
    base.vice_captain_element_id,
    base.transfer_row_count,
    base.source_finalized_at,
    rank() OVER (PARTITION BY base.tournament_id, base.event_id ORDER BY base.event_net_points DESC, base.entry_id) AS tournament_event_rank,
    (sum(base.event_net_points) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::integer AS cumulative_net_points,
    (sum(base.event_transfers) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::integer AS cumulative_transfers,
    (sum(base.event_transfers_cost) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::integer AS cumulative_transfer_cost,
    (sum(COALESCE(base.event_bench_points, 0)) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::integer AS cumulative_bench_points,
    (sum(COALESCE(base.event_auto_sub_points, 0)) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::integer AS cumulative_auto_sub_points,
    (sum(COALESCE(base.captain_points, 0)) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::integer AS cumulative_captain_points
   FROM base
  WITH NO DATA;


ALTER TABLE reporting.tournament_entry_event_summaries OWNER TO letletme_data_owner;

--
-- Name: tournament_event_results; Type: VIEW; Schema: reporting; Owner: letletme_data_owner
--

CREATE VIEW reporting.tournament_event_results WITH (security_invoker='true') AS
 SELECT points.tournament_id,
    points.season_id,
    points.event_id,
    'points_group'::text AS result_type,
    points.source_result_id,
    points.group_id,
    NULL::integer AS match_id,
    NULL::integer AS play_against_id,
    points.entry_id,
    NULL::integer AS opponent_entry_id,
    points.event_points,
    points.event_cost,
    points.event_net_points,
    points.event_rank,
    NULL::integer AS match_points,
    NULL::integer AS goals_for,
    NULL::integer AS goals_against,
    NULL::boolean AS is_winner,
    points.created_at,
    points.updated_at
   FROM competition.tournament_points_group_results points
UNION ALL
 SELECT battle.tournament_id,
    battle.season_id,
    battle.event_id,
    'battle_group'::text AS result_type,
    battle.source_result_id,
    battle.group_id,
    NULL::integer AS match_id,
    NULL::integer AS play_against_id,
    side.entry_id,
    side.opponent_entry_id,
    NULL::integer AS event_points,
    NULL::integer AS event_cost,
    side.net_points AS event_net_points,
    side.event_rank,
    side.match_points,
    NULL::integer AS goals_for,
    NULL::integer AS goals_against,
        CASE
            WHEN ((side.match_points IS NULL) OR (side.opponent_match_points IS NULL)) THEN NULL::boolean
            ELSE (side.match_points > side.opponent_match_points)
        END AS is_winner,
    battle.created_at,
    battle.updated_at
   FROM (competition.tournament_battle_group_results battle
     CROSS JOIN LATERAL ( VALUES (battle.home_entry_id,battle.away_entry_id,battle.home_net_points,battle.home_rank,battle.home_match_points,battle.away_match_points), (battle.away_entry_id,battle.home_entry_id,battle.away_net_points,battle.away_rank,battle.away_match_points,battle.home_match_points)) side(entry_id, opponent_entry_id, net_points, event_rank, match_points, opponent_match_points))
UNION ALL
 SELECT knockout.tournament_id,
    knockout.season_id,
    knockout.event_id,
    'knockout'::text AS result_type,
    knockout.source_result_id,
    NULL::integer AS group_id,
    knockout.match_id,
    knockout.play_against_id,
    side.entry_id,
    side.opponent_entry_id,
    NULL::integer AS event_points,
    NULL::integer AS event_cost,
    side.net_points AS event_net_points,
    NULL::integer AS event_rank,
    NULL::integer AS match_points,
    side.goals_for,
    side.goals_against,
        CASE
            WHEN ((knockout.match_winner IS NULL) OR (side.entry_id IS NULL)) THEN NULL::boolean
            ELSE (knockout.match_winner = side.entry_id)
        END AS is_winner,
    knockout.created_at,
    knockout.updated_at
   FROM (competition.tournament_knockout_results knockout
     CROSS JOIN LATERAL ( VALUES (knockout.home_entry_id,knockout.away_entry_id,knockout.home_net_points,knockout.home_goals_scored,knockout.home_goals_conceded), (knockout.away_entry_id,knockout.home_entry_id,knockout.away_net_points,knockout.away_goals_scored,knockout.away_goals_conceded)) side(entry_id, opponent_entry_id, net_points, goals_for, goals_against))
  WHERE (side.entry_id IS NOT NULL);


ALTER TABLE reporting.tournament_event_results OWNER TO letletme_data_owner;

--
-- Name: tournament_selection_stats; Type: MATERIALIZED VIEW; Schema: reporting; Owner: letletme_data_owner
--

CREATE MATERIALIZED VIEW reporting.tournament_selection_stats AS
 WITH candidate_events AS (
         SELECT DISTINCT roster.tournament_id,
            roster.season_id,
            pick_1.event_id
           FROM (competition.tournament_entries roster
             JOIN competition.entry_event_picks pick_1 ON (((pick_1.season_id = roster.season_id) AND (pick_1.entry_id = roster.entry_id))))
        ), eligible_entries AS (
         SELECT candidate.tournament_id,
            candidate.season_id,
            candidate.event_id,
            roster.entry_id,
            entry.transfers_synced_through_event_id
           FROM ((candidate_events candidate
             JOIN competition.tournament_entries roster ON (((roster.tournament_id = candidate.tournament_id) AND (roster.season_id = candidate.season_id))))
             JOIN competition.entries entry ON (((entry.season_id = roster.season_id) AND (entry.entry_id = roster.entry_id))))
          WHERE (COALESCE(entry.started_event, 1) <= candidate.event_id)
        ), expected_entries AS (
         SELECT eligible.tournament_id,
            eligible.season_id,
            eligible.event_id,
            (count(*))::integer AS total_entries,
            (count(*) FILTER (WHERE (eligible.transfers_synced_through_event_id >= eligible.event_id)))::integer AS transfer_checkpoint_entries
           FROM eligible_entries eligible
          GROUP BY eligible.tournament_id, eligible.season_id, eligible.event_id
        ), valid_entry_events AS (
         SELECT eligible.tournament_id,
            eligible.season_id,
            eligible.event_id,
            eligible.entry_id
           FROM (eligible_entries eligible
             JOIN competition.entry_event_picks pick_1 ON (((pick_1.season_id = eligible.season_id) AND (pick_1.entry_id = eligible.entry_id) AND (pick_1.event_id = eligible.event_id))))
          GROUP BY eligible.tournament_id, eligible.season_id, eligible.event_id, eligible.entry_id
         HAVING ((count(*) = 15) AND (min(pick_1."position") = 1) AND (max(pick_1."position") = 15) AND (count(*) FILTER (WHERE pick_1.is_captain) = 1) AND (count(*) FILTER (WHERE pick_1.is_vice_captain) = 1))
        ), complete_scopes AS (
         SELECT expected.tournament_id,
            expected.season_id,
            expected.event_id,
            expected.total_entries,
            expected.transfer_checkpoint_entries
           FROM (expected_entries expected
             LEFT JOIN valid_entry_events valid ON (((valid.tournament_id = expected.tournament_id) AND (valid.season_id = expected.season_id) AND (valid.event_id = expected.event_id))))
          GROUP BY expected.tournament_id, expected.season_id, expected.event_id, expected.total_entries, expected.transfer_checkpoint_entries
         HAVING ((expected.total_entries > 0) AND (expected.transfer_checkpoint_entries = expected.total_entries) AND (count(valid.entry_id) = expected.total_entries))
        ), eligible_picks AS (
         SELECT scope_1.tournament_id,
            scope_1.season_id,
            scope_1.event_id,
            scope_1.total_entries,
            pick_1.entry_id,
            pick_1.element_id,
            pick_1.multiplier,
            pick_1.is_captain,
            pick_1.is_vice_captain
           FROM ((complete_scopes scope_1
             JOIN eligible_entries eligible ON (((eligible.tournament_id = scope_1.tournament_id) AND (eligible.season_id = scope_1.season_id) AND (eligible.event_id = scope_1.event_id))))
             JOIN competition.entry_event_picks pick_1 ON (((pick_1.season_id = eligible.season_id) AND (pick_1.entry_id = eligible.entry_id) AND (pick_1.event_id = eligible.event_id))))
        ), pick_stats AS (
         SELECT pick_1.tournament_id,
            pick_1.season_id,
            pick_1.event_id,
            pick_1.total_entries,
            pick_1.element_id,
            (count(*))::integer AS selected_count,
            (count(*) FILTER (WHERE pick_1.is_captain))::integer AS captain_count,
            (count(*) FILTER (WHERE pick_1.is_vice_captain))::integer AS vice_captain_count,
            (sum(pick_1.multiplier))::integer AS effective_selection_count
           FROM eligible_picks pick_1
          GROUP BY pick_1.tournament_id, pick_1.season_id, pick_1.event_id, pick_1.total_entries, pick_1.element_id
        ), transfer_stats AS (
         SELECT scope_1.tournament_id,
            scope_1.season_id,
            scope_1.event_id,
            element_1.element_id,
            (count(*) FILTER (WHERE (element_1.direction = 'in'::text)))::integer AS transfer_in_count,
            (count(*) FILTER (WHERE (element_1.direction = 'out'::text)))::integer AS transfer_out_count
           FROM (((complete_scopes scope_1
             JOIN eligible_entries eligible ON (((eligible.tournament_id = scope_1.tournament_id) AND (eligible.season_id = scope_1.season_id) AND (eligible.event_id = scope_1.event_id))))
             JOIN competition.entry_event_transfers transfer_1 ON (((transfer_1.season_id = eligible.season_id) AND (transfer_1.entry_id = eligible.entry_id) AND (transfer_1.event_id = eligible.event_id))))
             CROSS JOIN LATERAL ( VALUES (transfer_1.element_in_id,'in'::text), (transfer_1.element_out_id,'out'::text)) element_1(element_id, direction))
          WHERE (element_1.element_id IS NOT NULL)
          GROUP BY scope_1.tournament_id, scope_1.season_id, scope_1.event_id, element_1.element_id
        ), elements AS (
         SELECT pick_stats.tournament_id,
            pick_stats.season_id,
            pick_stats.event_id,
            pick_stats.element_id
           FROM pick_stats
        UNION
         SELECT transfer_stats.tournament_id,
            transfer_stats.season_id,
            transfer_stats.event_id,
            transfer_stats.element_id
           FROM transfer_stats
        )
 SELECT element.tournament_id,
    element.season_id,
    element.event_id,
    element.element_id,
    scope.total_entries,
    COALESCE(pick.selected_count, 0) AS selected_count,
    COALESCE(pick.captain_count, 0) AS captain_count,
    COALESCE(pick.vice_captain_count, 0) AS vice_captain_count,
    COALESCE(pick.effective_selection_count, 0) AS effective_selection_count,
    COALESCE(transfer.transfer_in_count, 0) AS transfer_in_count,
    COALESCE(transfer.transfer_out_count, 0) AS transfer_out_count,
    round((((COALESCE(pick.selected_count, 0))::numeric * (100)::numeric) / (NULLIF(scope.total_entries, 0))::numeric), 4) AS selection_percentage,
    round((((COALESCE(pick.captain_count, 0))::numeric * (100)::numeric) / (NULLIF(scope.total_entries, 0))::numeric), 4) AS captain_percentage,
    round((((COALESCE(pick.vice_captain_count, 0))::numeric * (100)::numeric) / (NULLIF(scope.total_entries, 0))::numeric), 4) AS vice_captain_percentage,
    round((((COALESCE(pick.effective_selection_count, 0))::numeric * (100)::numeric) / (NULLIF(scope.total_entries, 0))::numeric), 4) AS effective_ownership_percentage
   FROM (((elements element
     JOIN complete_scopes scope ON (((scope.tournament_id = element.tournament_id) AND (scope.season_id = element.season_id) AND (scope.event_id = element.event_id))))
     LEFT JOIN pick_stats pick ON (((pick.tournament_id = element.tournament_id) AND (pick.season_id = element.season_id) AND (pick.event_id = element.event_id) AND (pick.element_id = element.element_id))))
     LEFT JOIN transfer_stats transfer ON (((transfer.tournament_id = element.tournament_id) AND (transfer.season_id = element.season_id) AND (transfer.event_id = element.event_id) AND (transfer.element_id = element.element_id))))
  WITH NO DATA;


ALTER TABLE reporting.tournament_selection_stats OWNER TO letletme_data_owner;

--
-- Name: matches; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.matches (
    match_id integer NOT NULL,
    season_code text NOT NULL,
    home_team_id integer NOT NULL,
    away_team_id integer NOT NULL,
    kickoff_at timestamp with time zone NOT NULL,
    is_result boolean DEFAULT false NOT NULL,
    home_goals integer,
    away_goals integer,
    home_xg numeric,
    away_xg numeric,
    forecast_home_win numeric,
    forecast_draw numeric,
    forecast_away_win numeric,
    source_hash text NOT NULL,
    source_checked_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_matches_distinct_teams CHECK ((home_team_id <> away_team_id)),
    CONSTRAINT understat_matches_forecast_range CHECK ((((forecast_home_win IS NULL) OR ((forecast_home_win >= (0)::numeric) AND (forecast_home_win <= (1)::numeric))) AND ((forecast_draw IS NULL) OR ((forecast_draw >= (0)::numeric) AND (forecast_draw <= (1)::numeric))) AND ((forecast_away_win IS NULL) OR ((forecast_away_win >= (0)::numeric) AND (forecast_away_win <= (1)::numeric))))),
    CONSTRAINT understat_matches_goals_nonnegative CHECK ((((home_goals IS NULL) OR (home_goals >= 0)) AND ((away_goals IS NULL) OR (away_goals >= 0)))),
    CONSTRAINT understat_matches_id_positive CHECK ((match_id > 0)),
    CONSTRAINT understat_matches_season_format CHECK ((season_code ~ '^[0-9]{4}$'::text)),
    CONSTRAINT understat_matches_seen_order CHECK ((last_seen_at >= source_checked_at)),
    CONSTRAINT understat_matches_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text))
);


ALTER TABLE understat.matches OWNER TO letletme_data_owner;

--
-- Name: player_match_stats; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.player_match_stats (
    roster_id integer NOT NULL,
    match_id integer NOT NULL,
    player_id integer NOT NULL,
    team_id integer NOT NULL,
    player_name text NOT NULL,
    side text NOT NULL,
    "position" text NOT NULL,
    position_order integer NOT NULL,
    minutes integer NOT NULL,
    started boolean NOT NULL,
    goals integer NOT NULL,
    own_goals integer NOT NULL,
    shots integer NOT NULL,
    key_passes integer NOT NULL,
    assists integer NOT NULL,
    yellow_cards integer NOT NULL,
    red_cards integer NOT NULL,
    xg numeric NOT NULL,
    xa numeric NOT NULL,
    xg_chain numeric NOT NULL,
    xg_buildup numeric NOT NULL,
    roster_in_id integer,
    roster_out_id integer,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_player_match_stats_counts_nonnegative CHECK (((position_order >= 0) AND (minutes >= 0) AND (goals >= 0) AND (own_goals >= 0) AND (shots >= 0) AND (key_passes >= 0) AND (assists >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0))),
    CONSTRAINT understat_player_match_stats_ids_positive CHECK (((roster_id > 0) AND (match_id > 0) AND (player_id > 0) AND (team_id > 0))),
    CONSTRAINT understat_player_match_stats_names_nonempty CHECK (((btrim(player_name) <> ''::text) AND (btrim("position") <> ''::text))),
    CONSTRAINT understat_player_match_stats_side_valid CHECK ((side = ANY (ARRAY['h'::text, 'a'::text]))),
    CONSTRAINT understat_player_match_stats_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text))
);


ALTER TABLE understat.player_match_stats OWNER TO letletme_data_owner;

--
-- Name: player_seasons; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.player_seasons (
    season_code text NOT NULL,
    player_id integer NOT NULL,
    source_name text NOT NULL,
    source_team_title text NOT NULL,
    games integer NOT NULL,
    time_minutes integer NOT NULL,
    goals integer NOT NULL,
    non_penalty_goals integer NOT NULL,
    assists integer NOT NULL,
    shots integer NOT NULL,
    key_passes integer NOT NULL,
    yellow_cards integer NOT NULL,
    red_cards integer NOT NULL,
    xg numeric NOT NULL,
    non_penalty_xg numeric NOT NULL,
    xa numeric NOT NULL,
    xg_chain numeric NOT NULL,
    xg_buildup numeric NOT NULL,
    "position" text NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_player_seasons_counts_nonnegative CHECK (((games >= 0) AND (time_minutes >= 0) AND (goals >= 0) AND (non_penalty_goals >= 0) AND (assists >= 0) AND (shots >= 0) AND (key_passes >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0))),
    CONSTRAINT understat_player_seasons_names_nonempty CHECK (((btrim(source_name) <> ''::text) AND (btrim(source_team_title) <> ''::text) AND (btrim("position") <> ''::text))),
    CONSTRAINT understat_player_seasons_season_format CHECK ((season_code ~ '^[0-9]{4}$'::text)),
    CONSTRAINT understat_player_seasons_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text))
);


ALTER TABLE understat.player_seasons OWNER TO letletme_data_owner;

--
-- Name: player_team_seasons; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.player_team_seasons (
    season_code text NOT NULL,
    player_id integer NOT NULL,
    team_id integer NOT NULL,
    games integer NOT NULL,
    time_minutes integer NOT NULL,
    goals integer NOT NULL,
    non_penalty_goals integer NOT NULL,
    assists integer NOT NULL,
    shots integer NOT NULL,
    key_passes integer NOT NULL,
    yellow_cards integer NOT NULL,
    red_cards integer NOT NULL,
    xg numeric NOT NULL,
    non_penalty_xg numeric NOT NULL,
    xa numeric NOT NULL,
    xg_chain numeric NOT NULL,
    xg_buildup numeric NOT NULL,
    "position" text NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_player_team_seasons_counts_nonnegative CHECK (((games >= 0) AND (time_minutes >= 0) AND (goals >= 0) AND (non_penalty_goals >= 0) AND (assists >= 0) AND (shots >= 0) AND (key_passes >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0))),
    CONSTRAINT understat_player_team_seasons_position_nonempty CHECK ((btrim("position") <> ''::text)),
    CONSTRAINT understat_player_team_seasons_season_format CHECK ((season_code ~ '^[0-9]{4}$'::text)),
    CONSTRAINT understat_player_team_seasons_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text))
);


ALTER TABLE understat.player_team_seasons OWNER TO letletme_data_owner;

--
-- Name: players; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.players (
    player_id integer NOT NULL,
    name text NOT NULL,
    favorite_position text,
    first_seen_season text NOT NULL,
    last_seen_season text NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_players_id_positive CHECK ((player_id > 0)),
    CONSTRAINT understat_players_name_nonempty CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT understat_players_season_format CHECK (((first_seen_season ~ '^[0-9]{4}$'::text) AND (last_seen_season ~ '^[0-9]{4}$'::text))),
    CONSTRAINT understat_players_season_order CHECK ((last_seen_season >= first_seen_season)),
    CONSTRAINT understat_players_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text))
);


ALTER TABLE understat.players OWNER TO letletme_data_owner;

--
-- Name: seasons; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.seasons (
    season_code text NOT NULL,
    source_year integer NOT NULL,
    league text NOT NULL,
    state understat.season_state NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_seasons_code_format CHECK ((season_code ~ '^[0-9]{4}$'::text)),
    CONSTRAINT understat_seasons_league_nonempty CHECK ((btrim(league) <> ''::text)),
    CONSTRAINT understat_seasons_seen_order CHECK ((last_seen_at >= first_seen_at)),
    CONSTRAINT understat_seasons_source_year_valid CHECK (((source_year >= 2000) AND (source_year <= 2100)))
);


ALTER TABLE understat.seasons OWNER TO letletme_data_owner;

--
-- Name: team_match_stats; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.team_match_stats (
    match_id integer NOT NULL,
    team_id integer NOT NULL,
    side text NOT NULL,
    xg numeric NOT NULL,
    xga numeric NOT NULL,
    npxg numeric NOT NULL,
    npxga numeric NOT NULL,
    npxgd numeric NOT NULL,
    ppda_att integer NOT NULL,
    ppda_def integer NOT NULL,
    ppda_allowed_att integer NOT NULL,
    ppda_allowed_def integer NOT NULL,
    deep integer NOT NULL,
    deep_allowed integer NOT NULL,
    scored integer NOT NULL,
    missed integer NOT NULL,
    xpoints numeric NOT NULL,
    result text NOT NULL,
    points integer NOT NULL,
    wins integer NOT NULL,
    draws integer NOT NULL,
    losses integer NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_team_match_stats_counts_nonnegative CHECK (((ppda_att >= 0) AND (ppda_def >= 0) AND (ppda_allowed_att >= 0) AND (ppda_allowed_def >= 0) AND (deep >= 0) AND (deep_allowed >= 0) AND (scored >= 0) AND (missed >= 0) AND (points >= 0) AND (wins >= 0) AND (draws >= 0) AND (losses >= 0))),
    CONSTRAINT understat_team_match_stats_result_valid CHECK ((result = ANY (ARRAY['w'::text, 'd'::text, 'l'::text]))),
    CONSTRAINT understat_team_match_stats_side_valid CHECK ((side = ANY (ARRAY['h'::text, 'a'::text]))),
    CONSTRAINT understat_team_match_stats_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text))
);


ALTER TABLE understat.team_match_stats OWNER TO letletme_data_owner;

--
-- Name: team_seasons; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.team_seasons (
    season_code text NOT NULL,
    team_id integer NOT NULL,
    source_title text NOT NULL,
    source_short_title text,
    games integer NOT NULL,
    wins integer NOT NULL,
    draws integer NOT NULL,
    losses integer NOT NULL,
    goals_for integer NOT NULL,
    goals_against integer NOT NULL,
    points integer NOT NULL,
    xg numeric NOT NULL,
    xga numeric NOT NULL,
    npxg numeric NOT NULL,
    npxga numeric NOT NULL,
    npxgd numeric NOT NULL,
    xpoints numeric NOT NULL,
    deep integer NOT NULL,
    deep_allowed integer NOT NULL,
    ppda_att integer NOT NULL,
    ppda_def integer NOT NULL,
    ppda_allowed_att integer NOT NULL,
    ppda_allowed_def integer NOT NULL,
    source_hash text NOT NULL,
    last_synced_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_team_seasons_counts_nonnegative CHECK (((games >= 0) AND (wins >= 0) AND (draws >= 0) AND (losses >= 0) AND (goals_for >= 0) AND (goals_against >= 0) AND (points >= 0) AND (deep >= 0) AND (deep_allowed >= 0) AND (ppda_att >= 0) AND (ppda_def >= 0) AND (ppda_allowed_att >= 0) AND (ppda_allowed_def >= 0))),
    CONSTRAINT understat_team_seasons_season_format CHECK ((season_code ~ '^[0-9]{4}$'::text)),
    CONSTRAINT understat_team_seasons_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text)),
    CONSTRAINT understat_team_seasons_title_nonempty CHECK ((btrim(source_title) <> ''::text))
);


ALTER TABLE understat.team_seasons OWNER TO letletme_data_owner;

--
-- Name: team_stat_splits; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.team_stat_splits (
    season_code text NOT NULL,
    team_id integer NOT NULL,
    dimension text NOT NULL,
    split_key text NOT NULL,
    label text,
    time_minutes integer,
    shots_for integer NOT NULL,
    goals_for integer NOT NULL,
    xg_for numeric NOT NULL,
    shots_against integer NOT NULL,
    goals_against integer NOT NULL,
    xg_against numeric NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_team_stat_splits_counts_nonnegative CHECK ((((time_minutes IS NULL) OR (time_minutes >= 0)) AND (shots_for >= 0) AND (goals_for >= 0) AND (shots_against >= 0) AND (goals_against >= 0))),
    CONSTRAINT understat_team_stat_splits_keys_nonempty CHECK (((btrim(dimension) <> ''::text) AND (btrim(split_key) <> ''::text))),
    CONSTRAINT understat_team_stat_splits_season_format CHECK ((season_code ~ '^[0-9]{4}$'::text)),
    CONSTRAINT understat_team_stat_splits_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text))
);


ALTER TABLE understat.team_stat_splits OWNER TO letletme_data_owner;

--
-- Name: teams; Type: TABLE; Schema: understat; Owner: letletme_data_owner
--

CREATE TABLE understat.teams (
    team_id integer NOT NULL,
    title text NOT NULL,
    short_title text,
    first_seen_season text NOT NULL,
    last_seen_season text NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT understat_teams_id_positive CHECK ((team_id > 0)),
    CONSTRAINT understat_teams_season_format CHECK (((first_seen_season ~ '^[0-9]{4}$'::text) AND (last_seen_season ~ '^[0-9]{4}$'::text))),
    CONSTRAINT understat_teams_season_order CHECK ((last_seen_season >= first_seen_season)),
    CONSTRAINT understat_teams_source_hash_nonempty CHECK ((btrim(source_hash) <> ''::text)),
    CONSTRAINT understat_teams_title_nonempty CHECK ((btrim(title) <> ''::text))
);


ALTER TABLE understat.teams OWNER TO letletme_data_owner;

--
-- Name: player_market_snapshots source_snapshot_id; Type: DEFAULT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_market_snapshots ALTER COLUMN source_snapshot_id SET DEFAULT nextval('fpl.player_market_snapshots_source_snapshot_id_seq'::regclass);


--
-- Name: entity_aliases bridge_entity_aliases_business_unique; Type: CONSTRAINT; Schema: bridge; Owner: letletme_data_owner
--

ALTER TABLE ONLY bridge.entity_aliases
    ADD CONSTRAINT bridge_entity_aliases_business_unique UNIQUE (entity_type, provider, provider_entity_id, alias, source);


--
-- Name: entity_links bridge_entity_links_pair_unique; Type: CONSTRAINT; Schema: bridge; Owner: letletme_data_owner
--

ALTER TABLE ONLY bridge.entity_links
    ADD CONSTRAINT bridge_entity_links_pair_unique UNIQUE NULLS NOT DISTINCT (entity_type, left_provider, left_entity_id, right_provider, right_entity_id);


--
-- Name: match_links bridge_match_links_pair_unique; Type: CONSTRAINT; Schema: bridge; Owner: letletme_data_owner
--

ALTER TABLE ONLY bridge.match_links
    ADD CONSTRAINT bridge_match_links_pair_unique UNIQUE (season_code, left_provider, left_match_id, right_provider, right_match_id);


--
-- Name: entity_aliases entity_aliases_pkey; Type: CONSTRAINT; Schema: bridge; Owner: letletme_data_owner
--

ALTER TABLE ONLY bridge.entity_aliases
    ADD CONSTRAINT entity_aliases_pkey PRIMARY KEY (alias_id);


--
-- Name: entity_links entity_links_pkey; Type: CONSTRAINT; Schema: bridge; Owner: letletme_data_owner
--

ALTER TABLE ONLY bridge.entity_links
    ADD CONSTRAINT entity_links_pkey PRIMARY KEY (link_id);


--
-- Name: match_links match_links_pkey; Type: CONSTRAINT; Schema: bridge; Owner: letletme_data_owner
--

ALTER TABLE ONLY bridge.match_links
    ADD CONSTRAINT match_links_pkey PRIMARY KEY (link_id);


--
-- Name: entries entries_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entries
    ADD CONSTRAINT entries_pkey PRIMARY KEY (season_id, entry_id);


--
-- Name: entry_event_cup_results entry_event_cup_results_business_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_cup_results
    ADD CONSTRAINT entry_event_cup_results_business_unique UNIQUE (season_id, entry_id, event_id);


--
-- Name: entry_event_cup_results entry_event_cup_results_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_cup_results
    ADD CONSTRAINT entry_event_cup_results_pkey PRIMARY KEY (season_id, source_result_id);


--
-- Name: entry_event_picks entry_event_picks_element_once; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_picks
    ADD CONSTRAINT entry_event_picks_element_once UNIQUE (season_id, entry_id, event_id, element_id);


--
-- Name: entry_event_picks entry_event_picks_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_picks
    ADD CONSTRAINT entry_event_picks_pkey PRIMARY KEY (season_id, entry_id, event_id, "position");


--
-- Name: entry_event_results entry_event_results_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_results
    ADD CONSTRAINT entry_event_results_pkey PRIMARY KEY (season_id, entry_id, event_id);


--
-- Name: entry_event_results entry_event_results_source_id_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_results
    ADD CONSTRAINT entry_event_results_source_id_unique UNIQUE (source_result_id);


--
-- Name: entry_event_transfers entry_event_transfers_business_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_transfers
    ADD CONSTRAINT entry_event_transfers_business_unique UNIQUE NULLS NOT DISTINCT (season_id, entry_id, event_id, element_in_id, element_out_id, transfer_time);


--
-- Name: entry_event_transfers entry_event_transfers_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_transfers
    ADD CONSTRAINT entry_event_transfers_pkey PRIMARY KEY (season_id, transfer_id);


--
-- Name: entry_leagues entry_leagues_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_leagues
    ADD CONSTRAINT entry_leagues_pkey PRIMARY KEY (season_id, entry_id, league_id, league_type);


--
-- Name: entry_leagues entry_leagues_source_id_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_leagues
    ADD CONSTRAINT entry_leagues_source_id_unique UNIQUE (source_entry_league_id);


--
-- Name: entry_season_histories entry_season_histories_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_season_histories
    ADD CONSTRAINT entry_season_histories_pkey PRIMARY KEY (season_id, entry_id);


--
-- Name: entry_season_histories entry_season_histories_source_id_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_season_histories
    ADD CONSTRAINT entry_season_histories_source_id_unique UNIQUE (source_history_id);


--
-- Name: league_event_results league_event_results_business_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_business_unique UNIQUE (season_id, league_id, league_type, entry_id, event_id);


--
-- Name: league_event_results league_event_results_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_pkey PRIMARY KEY (season_id, source_result_id);


--
-- Name: public_league_trends public_league_trends_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.public_league_trends
    ADD CONSTRAINT public_league_trends_pkey PRIMARY KEY (season_id, tournament_id);


--
-- Name: tournament_battle_group_results tournament_battle_group_results_business_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_battle_group_results
    ADD CONSTRAINT tournament_battle_group_results_business_unique UNIQUE (tournament_id, group_id, event_id, home_index, away_index);


--
-- Name: tournament_battle_group_results tournament_battle_group_results_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_battle_group_results
    ADD CONSTRAINT tournament_battle_group_results_pkey PRIMARY KEY (tournament_id, source_result_id);


--
-- Name: tournament_entries tournament_entries_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_entries
    ADD CONSTRAINT tournament_entries_pkey PRIMARY KEY (tournament_id, entry_id);


--
-- Name: tournament_groups tournament_groups_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_groups
    ADD CONSTRAINT tournament_groups_pkey PRIMARY KEY (tournament_id, group_id, entry_id);


--
-- Name: tournament_groups tournament_groups_source_id_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_groups
    ADD CONSTRAINT tournament_groups_source_id_unique UNIQUE (source_group_row_id);


--
-- Name: tournament_knockout_results tournament_knockout_results_business_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockout_results
    ADD CONSTRAINT tournament_knockout_results_business_unique UNIQUE (tournament_id, event_id, match_id, play_against_id);


--
-- Name: tournament_knockout_results tournament_knockout_results_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockout_results
    ADD CONSTRAINT tournament_knockout_results_pkey PRIMARY KEY (tournament_id, source_result_id);


--
-- Name: tournament_knockouts tournament_knockouts_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_pkey PRIMARY KEY (tournament_id, match_id);


--
-- Name: tournament_knockouts tournament_knockouts_source_id_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_source_id_unique UNIQUE (source_knockout_id);


--
-- Name: tournament_points_group_results tournament_points_group_results_business_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_points_group_results
    ADD CONSTRAINT tournament_points_group_results_business_unique UNIQUE (tournament_id, event_id, entry_id);


--
-- Name: tournament_points_group_results tournament_points_group_results_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_points_group_results
    ADD CONSTRAINT tournament_points_group_results_pkey PRIMARY KEY (tournament_id, source_result_id);


--
-- Name: tournaments tournaments_name_key; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_name_key UNIQUE (season_id, name);


--
-- Name: tournaments tournaments_pkey; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_pkey PRIMARY KEY (tournament_id);


--
-- Name: tournaments tournaments_season_identity_unique; Type: CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_season_identity_unique UNIQUE (season_id, tournament_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (season_id, event_id);


--
-- Name: fixtures fixtures_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.fixtures
    ADD CONSTRAINT fixtures_pkey PRIMARY KEY (season_id, fixture_id);


--
-- Name: fixtures fixtures_season_code_unique; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.fixtures
    ADD CONSTRAINT fixtures_season_code_unique UNIQUE (season_id, code);


--
-- Name: phases phases_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.phases
    ADD CONSTRAINT phases_pkey PRIMARY KEY (season_id, phase_id);


--
-- Name: player_event_snapshots player_event_snapshots_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_event_snapshots
    ADD CONSTRAINT player_event_snapshots_pkey PRIMARY KEY (season_id, event_id, element_id);


--
-- Name: player_fixture_stats player_fixture_stats_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_fixture_stats
    ADD CONSTRAINT player_fixture_stats_pkey PRIMARY KEY (season_id, fixture_id, element_id);


--
-- Name: player_gameweek_scoring_items player_gameweek_scoring_items_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_gameweek_scoring_items
    ADD CONSTRAINT player_gameweek_scoring_items_pkey PRIMARY KEY (season_id, event_id, element_id, scoring_identifier);


--
-- Name: player_gameweek_stats player_gameweek_stats_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_gameweek_stats
    ADD CONSTRAINT player_gameweek_stats_pkey PRIMARY KEY (season_id, event_id, element_id);


--
-- Name: player_market_snapshots player_market_snapshots_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_market_snapshots
    ADD CONSTRAINT player_market_snapshots_pkey PRIMARY KEY (season_id, snapshot_date, element_id);


--
-- Name: players players_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.players
    ADD CONSTRAINT players_pkey PRIMARY KEY (season_id, element_id);


--
-- Name: players players_season_code_unique; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.players
    ADD CONSTRAINT players_season_code_unique UNIQUE (season_id, code);


--
-- Name: seasons seasons_display_name_key; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.seasons
    ADD CONSTRAINT seasons_display_name_key UNIQUE (display_name);


--
-- Name: seasons seasons_end_year_key; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.seasons
    ADD CONSTRAINT seasons_end_year_key UNIQUE (end_year);


--
-- Name: seasons seasons_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.seasons
    ADD CONSTRAINT seasons_pkey PRIMARY KEY (season_id);


--
-- Name: seasons seasons_season_code_key; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.seasons
    ADD CONSTRAINT seasons_season_code_key UNIQUE (season_code);


--
-- Name: seasons seasons_start_year_key; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.seasons
    ADD CONSTRAINT seasons_start_year_key UNIQUE (start_year);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (season_id, team_id);


--
-- Name: teams teams_season_code_unique; Type: CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.teams
    ADD CONSTRAINT teams_season_code_unique UNIQUE (season_id, code);


--
-- Name: dataset_publications dataset_publications_pkey; Type: CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.dataset_publications
    ADD CONSTRAINT dataset_publications_pkey PRIMARY KEY (publication_id);


--
-- Name: dataset_publications dataset_publications_scope_unique; Type: CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.dataset_publications
    ADD CONSTRAINT dataset_publications_scope_unique UNIQUE NULLS NOT DISTINCT (dataset, season_id, event_id, revision);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: season_imports season_imports_pkey; Type: CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.season_imports
    ADD CONSTRAINT season_imports_pkey PRIMARY KEY (season_id);


--
-- Name: season_imports season_imports_season_code_key; Type: CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.season_imports
    ADD CONSTRAINT season_imports_season_code_key UNIQUE (season_code);


--
-- Name: sync_items sync_items_pkey; Type: CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.sync_items
    ADD CONSTRAINT sync_items_pkey PRIMARY KEY (run_id, resource_type, resource_id);


--
-- Name: sync_runs sync_runs_pkey; Type: CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.sync_runs
    ADD CONSTRAINT sync_runs_pkey PRIMARY KEY (run_id);


--
-- Name: matches matches_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.matches
    ADD CONSTRAINT matches_pkey PRIMARY KEY (match_id);


--
-- Name: player_match_stats player_match_stats_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_match_stats
    ADD CONSTRAINT player_match_stats_pkey PRIMARY KEY (roster_id);


--
-- Name: players players_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.players
    ADD CONSTRAINT players_pkey PRIMARY KEY (player_id);


--
-- Name: seasons seasons_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.seasons
    ADD CONSTRAINT seasons_pkey PRIMARY KEY (season_code);


--
-- Name: seasons seasons_source_year_key; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.seasons
    ADD CONSTRAINT seasons_source_year_key UNIQUE (source_year);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (team_id);


--
-- Name: player_seasons understat_player_seasons_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_seasons
    ADD CONSTRAINT understat_player_seasons_pkey PRIMARY KEY (season_code, player_id);


--
-- Name: player_team_seasons understat_player_team_seasons_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_team_seasons
    ADD CONSTRAINT understat_player_team_seasons_pkey PRIMARY KEY (season_code, player_id, team_id);


--
-- Name: team_match_stats understat_team_match_stats_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.team_match_stats
    ADD CONSTRAINT understat_team_match_stats_pkey PRIMARY KEY (match_id, team_id);


--
-- Name: team_seasons understat_team_seasons_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.team_seasons
    ADD CONSTRAINT understat_team_seasons_pkey PRIMARY KEY (season_code, team_id);


--
-- Name: team_stat_splits understat_team_stat_splits_pkey; Type: CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.team_stat_splits
    ADD CONSTRAINT understat_team_stat_splits_pkey PRIMARY KEY (season_code, team_id, dimension, split_key);


--
-- Name: bridge_entity_aliases_lookup_idx; Type: INDEX; Schema: bridge; Owner: letletme_data_owner
--

CREATE INDEX bridge_entity_aliases_lookup_idx ON bridge.entity_aliases USING btree (entity_type, provider, alias);


--
-- Name: bridge_entity_links_status_idx; Type: INDEX; Schema: bridge; Owner: letletme_data_owner
--

CREATE INDEX bridge_entity_links_status_idx ON bridge.entity_links USING btree (entity_type, status, last_seen_season);


--
-- Name: bridge_entity_links_verified_left_idx; Type: INDEX; Schema: bridge; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX bridge_entity_links_verified_left_idx ON bridge.entity_links USING btree (entity_type, left_provider, left_entity_id) WHERE (status = ANY (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status]));


--
-- Name: bridge_entity_links_verified_right_idx; Type: INDEX; Schema: bridge; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX bridge_entity_links_verified_right_idx ON bridge.entity_links USING btree (entity_type, right_provider, right_entity_id) WHERE (status = ANY (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status]));


--
-- Name: bridge_match_links_status_idx; Type: INDEX; Schema: bridge; Owner: letletme_data_owner
--

CREATE INDEX bridge_match_links_status_idx ON bridge.match_links USING btree (season_code, status);


--
-- Name: bridge_match_links_verified_left_idx; Type: INDEX; Schema: bridge; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX bridge_match_links_verified_left_idx ON bridge.match_links USING btree (season_code, left_provider, left_match_id) WHERE (status = ANY (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status]));


--
-- Name: bridge_match_links_verified_right_idx; Type: INDEX; Schema: bridge; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX bridge_match_links_verified_right_idx ON bridge.match_links USING btree (season_code, right_provider, right_match_id) WHERE (status = ANY (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status]));


--
-- Name: entries_entry_id_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entries_entry_id_idx ON competition.entries USING btree (entry_id, season_id DESC);


--
-- Name: entry_event_cup_results_entry_event_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_cup_results_entry_event_idx ON competition.entry_event_cup_results USING btree (season_id, entry_id, event_id);


--
-- Name: entry_event_cup_results_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_cup_results_event_fk_idx ON competition.entry_event_cup_results USING btree (season_id, event_id);


--
-- Name: entry_event_picks_element_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_picks_element_idx ON competition.entry_event_picks USING btree (season_id, event_id, element_id);


--
-- Name: entry_event_picks_event_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_picks_event_idx ON competition.entry_event_picks USING btree (season_id, event_id, entry_id);


--
-- Name: entry_event_picks_player_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_picks_player_fk_idx ON competition.entry_event_picks USING btree (season_id, element_id);


--
-- Name: entry_event_picks_source_row_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_picks_source_row_idx ON competition.entry_event_picks USING btree (source_pick_row_id);


--
-- Name: entry_event_results_captain_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_results_captain_fk_idx ON competition.entry_event_results USING btree (season_id, played_captain_element_id);


--
-- Name: entry_event_results_captain_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_results_captain_idx ON competition.entry_event_results USING btree (season_id, played_captain_element_id) WHERE (played_captain_element_id IS NOT NULL);


--
-- Name: entry_event_results_event_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_results_event_idx ON competition.entry_event_results USING btree (season_id, event_id, entry_id);


--
-- Name: entry_event_transfers_element_in_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_transfers_element_in_idx ON competition.entry_event_transfers USING btree (season_id, element_in_id) WHERE (element_in_id IS NOT NULL);


--
-- Name: entry_event_transfers_element_out_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_transfers_element_out_idx ON competition.entry_event_transfers USING btree (season_id, element_out_id) WHERE (element_out_id IS NOT NULL);


--
-- Name: entry_event_transfers_entry_event_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_transfers_entry_event_idx ON competition.entry_event_transfers USING btree (season_id, entry_id, event_id, transfer_time, transfer_id);


--
-- Name: entry_event_transfers_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_transfers_event_fk_idx ON competition.entry_event_transfers USING btree (season_id, event_id);


--
-- Name: entry_event_transfers_in_player_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_transfers_in_player_fk_idx ON competition.entry_event_transfers USING btree (season_id, element_in_id);


--
-- Name: entry_event_transfers_out_player_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_event_transfers_out_player_fk_idx ON competition.entry_event_transfers USING btree (season_id, element_out_id);


--
-- Name: entry_leagues_league_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_leagues_league_idx ON competition.entry_leagues USING btree (season_id, league_id, league_type);


--
-- Name: entry_season_histories_entry_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX entry_season_histories_entry_idx ON competition.entry_season_histories USING btree (entry_id, season_id DESC);


--
-- Name: league_event_results_captain_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX league_event_results_captain_fk_idx ON competition.league_event_results USING btree (season_id, captain_element_id);


--
-- Name: league_event_results_entry_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX league_event_results_entry_idx ON competition.league_event_results USING btree (season_id, entry_id, event_id);


--
-- Name: league_event_results_event_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX league_event_results_event_idx ON competition.league_event_results USING btree (season_id, event_id, league_id, league_type);


--
-- Name: league_event_results_high_score_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX league_event_results_high_score_fk_idx ON competition.league_event_results USING btree (season_id, highest_score_element_id);


--
-- Name: league_event_results_played_captain_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX league_event_results_played_captain_fk_idx ON competition.league_event_results USING btree (season_id, played_captain_element_id);


--
-- Name: league_event_results_vice_captain_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX league_event_results_vice_captain_fk_idx ON competition.league_event_results USING btree (season_id, vice_captain_element_id);


--
-- Name: public_league_trends_listing_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX public_league_trends_listing_idx ON competition.public_league_trends USING btree (season_id, enabled, sort_order, tournament_id);


--
-- Name: tournament_battle_group_results_event_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_battle_group_results_event_idx ON competition.tournament_battle_group_results USING btree (season_id, event_id, tournament_id);


--
-- Name: tournament_battle_results_away_entry_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_battle_results_away_entry_fk_idx ON competition.tournament_battle_group_results USING btree (season_id, away_entry_id);


--
-- Name: tournament_battle_results_home_entry_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_battle_results_home_entry_fk_idx ON competition.tournament_battle_group_results USING btree (season_id, home_entry_id);


--
-- Name: tournament_battle_results_tournament_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_battle_results_tournament_fk_idx ON competition.tournament_battle_group_results USING btree (season_id, tournament_id);


--
-- Name: tournament_entries_season_entry_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_entries_season_entry_idx ON competition.tournament_entries USING btree (season_id, entry_id);


--
-- Name: tournament_entries_tournament_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_entries_tournament_fk_idx ON competition.tournament_entries USING btree (season_id, tournament_id);


--
-- Name: tournament_groups_end_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_groups_end_event_fk_idx ON competition.tournament_groups USING btree (season_id, ended_event_id);


--
-- Name: tournament_groups_entry_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_groups_entry_idx ON competition.tournament_groups USING btree (season_id, entry_id, tournament_id);


--
-- Name: tournament_groups_start_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_groups_start_event_fk_idx ON competition.tournament_groups USING btree (season_id, started_event_id);


--
-- Name: tournament_groups_tournament_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_groups_tournament_fk_idx ON competition.tournament_groups USING btree (season_id, tournament_id);


--
-- Name: tournament_knockout_results_away_entry_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockout_results_away_entry_fk_idx ON competition.tournament_knockout_results USING btree (season_id, away_entry_id);


--
-- Name: tournament_knockout_results_event_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockout_results_event_idx ON competition.tournament_knockout_results USING btree (season_id, event_id, tournament_id);


--
-- Name: tournament_knockout_results_home_entry_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockout_results_home_entry_fk_idx ON competition.tournament_knockout_results USING btree (season_id, home_entry_id);


--
-- Name: tournament_knockout_results_tournament_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockout_results_tournament_fk_idx ON competition.tournament_knockout_results USING btree (season_id, tournament_id);


--
-- Name: tournament_knockout_results_winner_entry_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockout_results_winner_entry_fk_idx ON competition.tournament_knockout_results USING btree (season_id, match_winner);


--
-- Name: tournament_knockouts_away_entry_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_away_entry_fk_idx ON competition.tournament_knockouts USING btree (season_id, away_entry_id);


--
-- Name: tournament_knockouts_away_entry_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_away_entry_idx ON competition.tournament_knockouts USING btree (season_id, away_entry_id) WHERE (away_entry_id IS NOT NULL);


--
-- Name: tournament_knockouts_end_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_end_event_fk_idx ON competition.tournament_knockouts USING btree (season_id, ended_event_id);


--
-- Name: tournament_knockouts_home_entry_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_home_entry_fk_idx ON competition.tournament_knockouts USING btree (season_id, home_entry_id);


--
-- Name: tournament_knockouts_home_entry_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_home_entry_idx ON competition.tournament_knockouts USING btree (season_id, home_entry_id) WHERE (home_entry_id IS NOT NULL);


--
-- Name: tournament_knockouts_season_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_season_fk_idx ON competition.tournament_knockouts USING btree (season_id);


--
-- Name: tournament_knockouts_start_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_start_event_fk_idx ON competition.tournament_knockouts USING btree (season_id, started_event_id);


--
-- Name: tournament_knockouts_tournament_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_tournament_fk_idx ON competition.tournament_knockouts USING btree (season_id, tournament_id);


--
-- Name: tournament_knockouts_winner_entry_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_knockouts_winner_entry_fk_idx ON competition.tournament_knockouts USING btree (season_id, round_winner);


--
-- Name: tournament_points_group_results_entry_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_points_group_results_entry_idx ON competition.tournament_points_group_results USING btree (season_id, entry_id, event_id);


--
-- Name: tournament_points_group_results_event_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_points_group_results_event_idx ON competition.tournament_points_group_results USING btree (season_id, event_id, tournament_id);


--
-- Name: tournament_points_results_tournament_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournament_points_results_tournament_fk_idx ON competition.tournament_points_group_results USING btree (season_id, tournament_id);


--
-- Name: tournaments_admin_entry_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournaments_admin_entry_idx ON competition.tournaments USING btree (season_id, admin_entry_id);


--
-- Name: tournaments_group_end_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournaments_group_end_event_fk_idx ON competition.tournaments USING btree (season_id, group_ended_event_id);


--
-- Name: tournaments_group_start_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournaments_group_start_event_fk_idx ON competition.tournaments USING btree (season_id, group_started_event_id);


--
-- Name: tournaments_knockout_end_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournaments_knockout_end_event_fk_idx ON competition.tournaments USING btree (season_id, knockout_ended_event_id);


--
-- Name: tournaments_knockout_start_event_fk_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournaments_knockout_start_event_fk_idx ON competition.tournaments USING btree (season_id, knockout_started_event_id);


--
-- Name: tournaments_league_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournaments_league_idx ON competition.tournaments USING btree (season_id, league_id, league_type);


--
-- Name: tournaments_state_idx; Type: INDEX; Schema: competition; Owner: letletme_data_owner
--

CREATE INDEX tournaments_state_idx ON competition.tournaments USING btree (season_id, state, setup_status);


--
-- Name: events_current_flags_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX events_current_flags_idx ON fpl.events USING btree (season_id, is_current, is_next, is_previous);


--
-- Name: events_deadline_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX events_deadline_idx ON fpl.events USING btree (season_id, deadline_time);


--
-- Name: events_most_captained_fk_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX events_most_captained_fk_idx ON fpl.events USING btree (season_id, most_captained);


--
-- Name: events_most_selected_fk_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX events_most_selected_fk_idx ON fpl.events USING btree (season_id, most_selected);


--
-- Name: events_most_transferred_fk_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX events_most_transferred_fk_idx ON fpl.events USING btree (season_id, most_transferred_in);


--
-- Name: events_most_vice_captained_fk_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX events_most_vice_captained_fk_idx ON fpl.events USING btree (season_id, most_vice_captained);


--
-- Name: events_top_element_fk_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX events_top_element_fk_idx ON fpl.events USING btree (season_id, top_element);


--
-- Name: events_top_element_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX events_top_element_idx ON fpl.events USING btree (season_id, top_element) WHERE (top_element IS NOT NULL);


--
-- Name: fixtures_away_team_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX fixtures_away_team_idx ON fpl.fixtures USING btree (season_id, team_a_id);


--
-- Name: fixtures_event_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX fixtures_event_idx ON fpl.fixtures USING btree (season_id, event_id);


--
-- Name: fixtures_home_team_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX fixtures_home_team_idx ON fpl.fixtures USING btree (season_id, team_h_id);


--
-- Name: fixtures_kickoff_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX fixtures_kickoff_idx ON fpl.fixtures USING btree (season_id, kickoff_time);


--
-- Name: phases_event_range_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX phases_event_range_idx ON fpl.phases USING btree (season_id, start_event, stop_event);


--
-- Name: phases_stop_event_fk_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX phases_stop_event_fk_idx ON fpl.phases USING btree (season_id, stop_event);


--
-- Name: player_event_snapshots_player_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_event_snapshots_player_idx ON fpl.player_event_snapshots USING btree (season_id, element_id, event_id);


--
-- Name: player_event_snapshots_source_id_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX player_event_snapshots_source_id_idx ON fpl.player_event_snapshots USING btree (season_id, source_snapshot_id);


--
-- Name: player_fixture_stats_event_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_fixture_stats_event_idx ON fpl.player_fixture_stats USING btree (season_id, event_id);


--
-- Name: player_fixture_stats_player_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_fixture_stats_player_idx ON fpl.player_fixture_stats USING btree (season_id, element_id, event_id);


--
-- Name: player_fixture_stats_source_id_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX player_fixture_stats_source_id_idx ON fpl.player_fixture_stats USING btree (season_id, source_fixture_stat_id);


--
-- Name: player_fixture_stats_team_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_fixture_stats_team_idx ON fpl.player_fixture_stats USING btree (season_id, team_id);


--
-- Name: player_gameweek_scoring_items_player_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_gameweek_scoring_items_player_idx ON fpl.player_gameweek_scoring_items USING btree (season_id, element_id, event_id);


--
-- Name: player_gameweek_scoring_items_source_id_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_gameweek_scoring_items_source_id_idx ON fpl.player_gameweek_scoring_items USING btree (season_id, source_explain_id);


--
-- Name: player_gameweek_stats_player_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_gameweek_stats_player_idx ON fpl.player_gameweek_stats USING btree (season_id, element_id, event_id);


--
-- Name: player_gameweek_stats_source_id_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX player_gameweek_stats_source_id_idx ON fpl.player_gameweek_stats USING btree (season_id, source_live_id);


--
-- Name: player_market_snapshots_event_fk_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_market_snapshots_event_fk_idx ON fpl.player_market_snapshots USING btree (season_id, source_event_id);


--
-- Name: player_market_snapshots_player_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_market_snapshots_player_idx ON fpl.player_market_snapshots USING btree (season_id, element_id, snapshot_date);


--
-- Name: player_market_snapshots_source_id_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX player_market_snapshots_source_id_idx ON fpl.player_market_snapshots USING btree (season_id, source_snapshot_id) WHERE (source_snapshot_id IS NOT NULL);


--
-- Name: player_market_snapshots_source_value_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX player_market_snapshots_source_value_idx ON fpl.player_market_snapshots USING btree (season_id, source_value_id) WHERE (source_value_id IS NOT NULL);


--
-- Name: player_market_snapshots_team_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX player_market_snapshots_team_idx ON fpl.player_market_snapshots USING btree (season_id, team_id, snapshot_date);


--
-- Name: players_team_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX players_team_idx ON fpl.players USING btree (season_id, team_id);


--
-- Name: players_type_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX players_type_idx ON fpl.players USING btree (season_id, element_type);


--
-- Name: players_web_name_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX players_web_name_idx ON fpl.players USING btree (season_id, web_name);


--
-- Name: seasons_one_current_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX seasons_one_current_idx ON fpl.seasons USING btree (is_current) WHERE is_current;


--
-- Name: teams_season_name_idx; Type: INDEX; Schema: fpl; Owner: letletme_data_owner
--

CREATE INDEX teams_season_name_idx ON fpl.teams USING btree (season_id, name);


--
-- Name: dataset_publications_event_fk_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX dataset_publications_event_fk_idx ON ops.dataset_publications USING btree (season_id, event_id);


--
-- Name: dataset_publications_one_active_scope_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX dataset_publications_one_active_scope_idx ON ops.dataset_publications USING btree (dataset, season_id, event_id) NULLS NOT DISTINCT WHERE (status = 'active'::text);


--
-- Name: dataset_publications_season_fk_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX dataset_publications_season_fk_idx ON ops.dataset_publications USING btree (season_id);


--
-- Name: dataset_publications_source_run_fk_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX dataset_publications_source_run_fk_idx ON ops.dataset_publications USING btree (source_run_id);


--
-- Name: dataset_publications_source_run_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX dataset_publications_source_run_idx ON ops.dataset_publications USING btree (source_run_id) WHERE (source_run_id IS NOT NULL);


--
-- Name: dataset_publications_status_created_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX dataset_publications_status_created_idx ON ops.dataset_publications USING btree (status, created_at DESC);


--
-- Name: sync_items_status_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX sync_items_status_idx ON ops.sync_items USING btree (status, run_id);


--
-- Name: sync_runs_provider_scope_started_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX sync_runs_provider_scope_started_idx ON ops.sync_runs USING btree (provider, scope, started_at DESC);


--
-- Name: sync_runs_publication_fk_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX sync_runs_publication_fk_idx ON ops.sync_runs USING btree (publication_id);


--
-- Name: sync_runs_season_event_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX sync_runs_season_event_idx ON ops.sync_runs USING btree (season_id, event_id) WHERE (season_id IS NOT NULL);


--
-- Name: sync_runs_season_fk_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX sync_runs_season_fk_idx ON ops.sync_runs USING btree (season_id);


--
-- Name: sync_runs_status_started_idx; Type: INDEX; Schema: ops; Owner: letletme_data_owner
--

CREATE INDEX sync_runs_status_started_idx ON ops.sync_runs USING btree (status, started_at DESC);


--
-- Name: tournament_entry_event_summaries_entry_idx; Type: INDEX; Schema: reporting; Owner: letletme_data_owner
--

CREATE INDEX tournament_entry_event_summaries_entry_idx ON reporting.tournament_entry_event_summaries USING btree (tournament_id, entry_id, event_id);


--
-- Name: tournament_entry_event_summaries_grain_idx; Type: INDEX; Schema: reporting; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX tournament_entry_event_summaries_grain_idx ON reporting.tournament_entry_event_summaries USING btree (tournament_id, event_id, entry_id);


--
-- Name: tournament_entry_event_summaries_rank_idx; Type: INDEX; Schema: reporting; Owner: letletme_data_owner
--

CREATE INDEX tournament_entry_event_summaries_rank_idx ON reporting.tournament_entry_event_summaries USING btree (tournament_id, event_id, tournament_event_rank);


--
-- Name: tournament_selection_stats_captain_idx; Type: INDEX; Schema: reporting; Owner: letletme_data_owner
--

CREATE INDEX tournament_selection_stats_captain_idx ON reporting.tournament_selection_stats USING btree (tournament_id, event_id, captain_count DESC, element_id);


--
-- Name: tournament_selection_stats_grain_idx; Type: INDEX; Schema: reporting; Owner: letletme_data_owner
--

CREATE UNIQUE INDEX tournament_selection_stats_grain_idx ON reporting.tournament_selection_stats USING btree (tournament_id, event_id, element_id);


--
-- Name: tournament_selection_stats_selected_idx; Type: INDEX; Schema: reporting; Owner: letletme_data_owner
--

CREATE INDEX tournament_selection_stats_selected_idx ON reporting.tournament_selection_stats USING btree (tournament_id, event_id, selected_count DESC, element_id);


--
-- Name: tournament_selection_stats_transfer_in_idx; Type: INDEX; Schema: reporting; Owner: letletme_data_owner
--

CREATE INDEX tournament_selection_stats_transfer_in_idx ON reporting.tournament_selection_stats USING btree (tournament_id, event_id, transfer_in_count DESC, element_id);


--
-- Name: understat_matches_away_team_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_matches_away_team_idx ON understat.matches USING btree (away_team_id, season_code, kickoff_at);


--
-- Name: understat_matches_home_team_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_matches_home_team_idx ON understat.matches USING btree (home_team_id, season_code, kickoff_at);


--
-- Name: understat_matches_season_kickoff_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_matches_season_kickoff_idx ON understat.matches USING btree (season_code, kickoff_at);


--
-- Name: understat_player_match_stats_match_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_player_match_stats_match_idx ON understat.player_match_stats USING btree (match_id, team_id, player_id);


--
-- Name: understat_player_match_stats_player_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_player_match_stats_player_idx ON understat.player_match_stats USING btree (player_id, match_id);


--
-- Name: understat_player_match_stats_roster_in_fk_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_player_match_stats_roster_in_fk_idx ON understat.player_match_stats USING btree (roster_in_id);


--
-- Name: understat_player_match_stats_roster_out_fk_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_player_match_stats_roster_out_fk_idx ON understat.player_match_stats USING btree (roster_out_id);


--
-- Name: understat_player_match_stats_team_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_player_match_stats_team_idx ON understat.player_match_stats USING btree (team_id, match_id);


--
-- Name: understat_player_seasons_player_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_player_seasons_player_idx ON understat.player_seasons USING btree (player_id, season_code);


--
-- Name: understat_player_team_season_fk_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_player_team_season_fk_idx ON understat.player_team_seasons USING btree (season_code);


--
-- Name: understat_player_team_seasons_team_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_player_team_seasons_team_idx ON understat.player_team_seasons USING btree (team_id, season_code);


--
-- Name: understat_players_first_season_fk_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_players_first_season_fk_idx ON understat.players USING btree (first_seen_season);


--
-- Name: understat_players_last_season_fk_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_players_last_season_fk_idx ON understat.players USING btree (last_seen_season);


--
-- Name: understat_players_name_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_players_name_idx ON understat.players USING btree (name);


--
-- Name: understat_team_match_stats_team_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_team_match_stats_team_idx ON understat.team_match_stats USING btree (team_id, match_id);


--
-- Name: understat_team_seasons_team_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_team_seasons_team_idx ON understat.team_seasons USING btree (team_id, season_code);


--
-- Name: understat_team_stat_splits_team_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_team_stat_splits_team_idx ON understat.team_stat_splits USING btree (team_id, season_code);


--
-- Name: understat_teams_first_season_fk_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_teams_first_season_fk_idx ON understat.teams USING btree (first_seen_season);


--
-- Name: understat_teams_last_season_fk_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_teams_last_season_fk_idx ON understat.teams USING btree (last_seen_season);


--
-- Name: understat_teams_title_idx; Type: INDEX; Schema: understat; Owner: letletme_data_owner
--

CREATE INDEX understat_teams_title_idx ON understat.teams USING btree (title);


--
-- Name: entries entries_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entries
    ADD CONSTRAINT entries_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: entry_event_cup_results entry_event_cup_results_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_cup_results
    ADD CONSTRAINT entry_event_cup_results_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: entry_event_cup_results entry_event_cup_results_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_cup_results
    ADD CONSTRAINT entry_event_cup_results_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: entry_event_cup_results entry_event_cup_results_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_cup_results
    ADD CONSTRAINT entry_event_cup_results_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: entry_event_picks entry_event_picks_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_picks
    ADD CONSTRAINT entry_event_picks_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: entry_event_picks entry_event_picks_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_picks
    ADD CONSTRAINT entry_event_picks_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: entry_event_picks entry_event_picks_player_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_picks
    ADD CONSTRAINT entry_event_picks_player_fk FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: entry_event_picks entry_event_picks_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_picks
    ADD CONSTRAINT entry_event_picks_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: entry_event_results entry_event_results_captain_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_results
    ADD CONSTRAINT entry_event_results_captain_fk FOREIGN KEY (season_id, played_captain_element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: entry_event_results entry_event_results_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_results
    ADD CONSTRAINT entry_event_results_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: entry_event_results entry_event_results_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_results
    ADD CONSTRAINT entry_event_results_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: entry_event_results entry_event_results_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_results
    ADD CONSTRAINT entry_event_results_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: entry_event_transfers entry_event_transfers_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_transfers
    ADD CONSTRAINT entry_event_transfers_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: entry_event_transfers entry_event_transfers_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_transfers
    ADD CONSTRAINT entry_event_transfers_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: entry_event_transfers entry_event_transfers_in_player_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_transfers
    ADD CONSTRAINT entry_event_transfers_in_player_fk FOREIGN KEY (season_id, element_in_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: entry_event_transfers entry_event_transfers_out_player_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_transfers
    ADD CONSTRAINT entry_event_transfers_out_player_fk FOREIGN KEY (season_id, element_out_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: entry_event_transfers entry_event_transfers_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_event_transfers
    ADD CONSTRAINT entry_event_transfers_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: entry_leagues entry_leagues_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_leagues
    ADD CONSTRAINT entry_leagues_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: entry_leagues entry_leagues_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_leagues
    ADD CONSTRAINT entry_leagues_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: entry_season_histories entry_season_histories_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.entry_season_histories
    ADD CONSTRAINT entry_season_histories_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: league_event_results league_event_results_captain_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_captain_fk FOREIGN KEY (season_id, captain_element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: league_event_results league_event_results_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: league_event_results league_event_results_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: league_event_results league_event_results_high_score_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_high_score_fk FOREIGN KEY (season_id, highest_score_element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: league_event_results league_event_results_played_captain_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_played_captain_fk FOREIGN KEY (season_id, played_captain_element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: league_event_results league_event_results_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: league_event_results league_event_results_vice_captain_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.league_event_results
    ADD CONSTRAINT league_event_results_vice_captain_fk FOREIGN KEY (season_id, vice_captain_element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: public_league_trends public_league_trends_tournament_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.public_league_trends
    ADD CONSTRAINT public_league_trends_tournament_fk FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id) ON DELETE CASCADE;


--
-- Name: tournament_battle_group_results tournament_battle_group_results_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_battle_group_results
    ADD CONSTRAINT tournament_battle_group_results_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: tournament_battle_group_results tournament_battle_results_away_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_battle_group_results
    ADD CONSTRAINT tournament_battle_results_away_entry_fk FOREIGN KEY (season_id, away_entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_battle_group_results tournament_battle_results_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_battle_group_results
    ADD CONSTRAINT tournament_battle_results_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournament_battle_group_results tournament_battle_results_home_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_battle_group_results
    ADD CONSTRAINT tournament_battle_results_home_entry_fk FOREIGN KEY (season_id, home_entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_battle_group_results tournament_battle_results_tournament_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_battle_group_results
    ADD CONSTRAINT tournament_battle_results_tournament_fk FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id);


--
-- Name: tournament_entries tournament_entries_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_entries
    ADD CONSTRAINT tournament_entries_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_entries tournament_entries_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_entries
    ADD CONSTRAINT tournament_entries_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: tournament_entries tournament_entries_tournament_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_entries
    ADD CONSTRAINT tournament_entries_tournament_fk FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id);


--
-- Name: tournament_groups tournament_groups_end_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_groups
    ADD CONSTRAINT tournament_groups_end_event_fk FOREIGN KEY (season_id, ended_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournament_groups tournament_groups_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_groups
    ADD CONSTRAINT tournament_groups_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_groups tournament_groups_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_groups
    ADD CONSTRAINT tournament_groups_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: tournament_groups tournament_groups_start_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_groups
    ADD CONSTRAINT tournament_groups_start_event_fk FOREIGN KEY (season_id, started_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournament_groups tournament_groups_tournament_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_groups
    ADD CONSTRAINT tournament_groups_tournament_fk FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id);


--
-- Name: tournament_knockout_results tournament_knockout_results_away_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockout_results
    ADD CONSTRAINT tournament_knockout_results_away_entry_fk FOREIGN KEY (season_id, away_entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_knockout_results tournament_knockout_results_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockout_results
    ADD CONSTRAINT tournament_knockout_results_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournament_knockout_results tournament_knockout_results_home_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockout_results
    ADD CONSTRAINT tournament_knockout_results_home_entry_fk FOREIGN KEY (season_id, home_entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_knockout_results tournament_knockout_results_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockout_results
    ADD CONSTRAINT tournament_knockout_results_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: tournament_knockout_results tournament_knockout_results_tournament_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockout_results
    ADD CONSTRAINT tournament_knockout_results_tournament_fk FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id);


--
-- Name: tournament_knockout_results tournament_knockout_results_winner_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockout_results
    ADD CONSTRAINT tournament_knockout_results_winner_entry_fk FOREIGN KEY (season_id, match_winner) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_knockouts tournament_knockouts_away_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_away_entry_fk FOREIGN KEY (season_id, away_entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_knockouts tournament_knockouts_end_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_end_event_fk FOREIGN KEY (season_id, ended_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournament_knockouts tournament_knockouts_home_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_home_entry_fk FOREIGN KEY (season_id, home_entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_knockouts tournament_knockouts_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: tournament_knockouts tournament_knockouts_start_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_start_event_fk FOREIGN KEY (season_id, started_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournament_knockouts tournament_knockouts_tournament_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_tournament_fk FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id);


--
-- Name: tournament_knockouts tournament_knockouts_winner_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_knockouts
    ADD CONSTRAINT tournament_knockouts_winner_entry_fk FOREIGN KEY (season_id, round_winner) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_points_group_results tournament_points_group_results_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_points_group_results
    ADD CONSTRAINT tournament_points_group_results_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: tournament_points_group_results tournament_points_results_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_points_group_results
    ADD CONSTRAINT tournament_points_results_entry_fk FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournament_points_group_results tournament_points_results_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_points_group_results
    ADD CONSTRAINT tournament_points_results_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournament_points_group_results tournament_points_results_tournament_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournament_points_group_results
    ADD CONSTRAINT tournament_points_results_tournament_fk FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id);


--
-- Name: tournaments tournaments_admin_entry_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_admin_entry_fk FOREIGN KEY (season_id, admin_entry_id) REFERENCES competition.entries(season_id, entry_id);


--
-- Name: tournaments tournaments_group_end_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_group_end_event_fk FOREIGN KEY (season_id, group_ended_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournaments tournaments_group_start_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_group_start_event_fk FOREIGN KEY (season_id, group_started_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournaments tournaments_knockout_end_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_knockout_end_event_fk FOREIGN KEY (season_id, knockout_ended_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournaments tournaments_knockout_start_event_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_knockout_start_event_fk FOREIGN KEY (season_id, knockout_started_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: tournaments tournaments_season_fk; Type: FK CONSTRAINT; Schema: competition; Owner: letletme_data_owner
--

ALTER TABLE ONLY competition.tournaments
    ADD CONSTRAINT tournaments_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: events events_most_captained_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.events
    ADD CONSTRAINT events_most_captained_fk FOREIGN KEY (season_id, most_captained) REFERENCES fpl.players(season_id, element_id);


--
-- Name: events events_most_selected_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.events
    ADD CONSTRAINT events_most_selected_fk FOREIGN KEY (season_id, most_selected) REFERENCES fpl.players(season_id, element_id);


--
-- Name: events events_most_transferred_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.events
    ADD CONSTRAINT events_most_transferred_fk FOREIGN KEY (season_id, most_transferred_in) REFERENCES fpl.players(season_id, element_id);


--
-- Name: events events_most_vice_captained_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.events
    ADD CONSTRAINT events_most_vice_captained_fk FOREIGN KEY (season_id, most_vice_captained) REFERENCES fpl.players(season_id, element_id);


--
-- Name: events events_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.events
    ADD CONSTRAINT events_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: events events_top_element_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.events
    ADD CONSTRAINT events_top_element_fk FOREIGN KEY (season_id, top_element) REFERENCES fpl.players(season_id, element_id);


--
-- Name: fixtures fixtures_away_team_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.fixtures
    ADD CONSTRAINT fixtures_away_team_fk FOREIGN KEY (season_id, team_a_id) REFERENCES fpl.teams(season_id, team_id);


--
-- Name: fixtures fixtures_event_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.fixtures
    ADD CONSTRAINT fixtures_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: fixtures fixtures_home_team_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.fixtures
    ADD CONSTRAINT fixtures_home_team_fk FOREIGN KEY (season_id, team_h_id) REFERENCES fpl.teams(season_id, team_id);


--
-- Name: fixtures fixtures_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.fixtures
    ADD CONSTRAINT fixtures_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: phases phases_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.phases
    ADD CONSTRAINT phases_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: phases phases_start_event_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.phases
    ADD CONSTRAINT phases_start_event_fk FOREIGN KEY (season_id, start_event) REFERENCES fpl.events(season_id, event_id);


--
-- Name: phases phases_stop_event_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.phases
    ADD CONSTRAINT phases_stop_event_fk FOREIGN KEY (season_id, stop_event) REFERENCES fpl.events(season_id, event_id);


--
-- Name: player_event_snapshots player_event_snapshots_event_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_event_snapshots
    ADD CONSTRAINT player_event_snapshots_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: player_event_snapshots player_event_snapshots_player_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_event_snapshots
    ADD CONSTRAINT player_event_snapshots_player_fk FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: player_event_snapshots player_event_snapshots_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_event_snapshots
    ADD CONSTRAINT player_event_snapshots_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: player_fixture_stats player_fixture_stats_event_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_fixture_stats
    ADD CONSTRAINT player_fixture_stats_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: player_fixture_stats player_fixture_stats_fixture_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_fixture_stats
    ADD CONSTRAINT player_fixture_stats_fixture_fk FOREIGN KEY (season_id, fixture_id) REFERENCES fpl.fixtures(season_id, fixture_id);


--
-- Name: player_fixture_stats player_fixture_stats_player_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_fixture_stats
    ADD CONSTRAINT player_fixture_stats_player_fk FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: player_fixture_stats player_fixture_stats_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_fixture_stats
    ADD CONSTRAINT player_fixture_stats_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: player_fixture_stats player_fixture_stats_team_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_fixture_stats
    ADD CONSTRAINT player_fixture_stats_team_fk FOREIGN KEY (season_id, team_id) REFERENCES fpl.teams(season_id, team_id);


--
-- Name: player_gameweek_scoring_items player_gameweek_scoring_items_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_gameweek_scoring_items
    ADD CONSTRAINT player_gameweek_scoring_items_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: player_gameweek_stats player_gameweek_stats_event_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_gameweek_stats
    ADD CONSTRAINT player_gameweek_stats_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: player_gameweek_stats player_gameweek_stats_player_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_gameweek_stats
    ADD CONSTRAINT player_gameweek_stats_player_fk FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: player_gameweek_stats player_gameweek_stats_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_gameweek_stats
    ADD CONSTRAINT player_gameweek_stats_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: player_market_snapshots player_market_snapshots_event_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_market_snapshots
    ADD CONSTRAINT player_market_snapshots_event_fk FOREIGN KEY (season_id, source_event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: player_market_snapshots player_market_snapshots_player_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_market_snapshots
    ADD CONSTRAINT player_market_snapshots_player_fk FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id);


--
-- Name: player_market_snapshots player_market_snapshots_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_market_snapshots
    ADD CONSTRAINT player_market_snapshots_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: player_market_snapshots player_market_snapshots_team_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_market_snapshots
    ADD CONSTRAINT player_market_snapshots_team_fk FOREIGN KEY (season_id, team_id) REFERENCES fpl.teams(season_id, team_id);


--
-- Name: player_gameweek_scoring_items player_scoring_gameweek_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.player_gameweek_scoring_items
    ADD CONSTRAINT player_scoring_gameweek_fk FOREIGN KEY (season_id, event_id, element_id) REFERENCES fpl.player_gameweek_stats(season_id, event_id, element_id);


--
-- Name: players players_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.players
    ADD CONSTRAINT players_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: players players_team_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.players
    ADD CONSTRAINT players_team_fk FOREIGN KEY (season_id, team_id) REFERENCES fpl.teams(season_id, team_id);


--
-- Name: teams teams_season_fk; Type: FK CONSTRAINT; Schema: fpl; Owner: letletme_data_owner
--

ALTER TABLE ONLY fpl.teams
    ADD CONSTRAINT teams_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: dataset_publications dataset_publications_event_fk; Type: FK CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.dataset_publications
    ADD CONSTRAINT dataset_publications_event_fk FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id);


--
-- Name: dataset_publications dataset_publications_season_fk; Type: FK CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.dataset_publications
    ADD CONSTRAINT dataset_publications_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: dataset_publications dataset_publications_source_run_fk; Type: FK CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.dataset_publications
    ADD CONSTRAINT dataset_publications_source_run_fk FOREIGN KEY (source_run_id) REFERENCES ops.sync_runs(run_id);


--
-- Name: season_imports season_imports_season_fk; Type: FK CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.season_imports
    ADD CONSTRAINT season_imports_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: sync_items sync_items_run_fk; Type: FK CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.sync_items
    ADD CONSTRAINT sync_items_run_fk FOREIGN KEY (run_id) REFERENCES ops.sync_runs(run_id) ON DELETE CASCADE;


--
-- Name: sync_runs sync_runs_publication_fk; Type: FK CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.sync_runs
    ADD CONSTRAINT sync_runs_publication_fk FOREIGN KEY (publication_id) REFERENCES ops.dataset_publications(publication_id);


--
-- Name: sync_runs sync_runs_season_fk; Type: FK CONSTRAINT; Schema: ops; Owner: letletme_data_owner
--

ALTER TABLE ONLY ops.sync_runs
    ADD CONSTRAINT sync_runs_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id);


--
-- Name: matches understat_matches_away_team_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.matches
    ADD CONSTRAINT understat_matches_away_team_fk FOREIGN KEY (away_team_id) REFERENCES understat.teams(team_id);


--
-- Name: matches understat_matches_home_team_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.matches
    ADD CONSTRAINT understat_matches_home_team_fk FOREIGN KEY (home_team_id) REFERENCES understat.teams(team_id);


--
-- Name: matches understat_matches_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.matches
    ADD CONSTRAINT understat_matches_season_fk FOREIGN KEY (season_code) REFERENCES understat.seasons(season_code);


--
-- Name: player_match_stats understat_player_match_stats_match_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_match_stats
    ADD CONSTRAINT understat_player_match_stats_match_fk FOREIGN KEY (match_id) REFERENCES understat.matches(match_id);


--
-- Name: player_match_stats understat_player_match_stats_player_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_match_stats
    ADD CONSTRAINT understat_player_match_stats_player_fk FOREIGN KEY (player_id) REFERENCES understat.players(player_id);


--
-- Name: player_match_stats understat_player_match_stats_roster_in_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_match_stats
    ADD CONSTRAINT understat_player_match_stats_roster_in_fk FOREIGN KEY (roster_in_id) REFERENCES understat.player_match_stats(roster_id);


--
-- Name: player_match_stats understat_player_match_stats_roster_out_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_match_stats
    ADD CONSTRAINT understat_player_match_stats_roster_out_fk FOREIGN KEY (roster_out_id) REFERENCES understat.player_match_stats(roster_id);


--
-- Name: player_match_stats understat_player_match_stats_team_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_match_stats
    ADD CONSTRAINT understat_player_match_stats_team_fk FOREIGN KEY (team_id) REFERENCES understat.teams(team_id);


--
-- Name: player_seasons understat_player_seasons_player_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_seasons
    ADD CONSTRAINT understat_player_seasons_player_fk FOREIGN KEY (player_id) REFERENCES understat.players(player_id);


--
-- Name: player_seasons understat_player_seasons_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_seasons
    ADD CONSTRAINT understat_player_seasons_season_fk FOREIGN KEY (season_code) REFERENCES understat.seasons(season_code);


--
-- Name: player_team_seasons understat_player_team_player_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_team_seasons
    ADD CONSTRAINT understat_player_team_player_season_fk FOREIGN KEY (season_code, player_id) REFERENCES understat.player_seasons(season_code, player_id);


--
-- Name: player_team_seasons understat_player_team_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_team_seasons
    ADD CONSTRAINT understat_player_team_season_fk FOREIGN KEY (season_code) REFERENCES understat.seasons(season_code);


--
-- Name: player_team_seasons understat_player_team_team_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.player_team_seasons
    ADD CONSTRAINT understat_player_team_team_fk FOREIGN KEY (team_id) REFERENCES understat.teams(team_id);


--
-- Name: players understat_players_first_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.players
    ADD CONSTRAINT understat_players_first_season_fk FOREIGN KEY (first_seen_season) REFERENCES understat.seasons(season_code);


--
-- Name: players understat_players_last_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.players
    ADD CONSTRAINT understat_players_last_season_fk FOREIGN KEY (last_seen_season) REFERENCES understat.seasons(season_code);


--
-- Name: team_match_stats understat_team_match_stats_match_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.team_match_stats
    ADD CONSTRAINT understat_team_match_stats_match_fk FOREIGN KEY (match_id) REFERENCES understat.matches(match_id);


--
-- Name: team_match_stats understat_team_match_stats_team_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.team_match_stats
    ADD CONSTRAINT understat_team_match_stats_team_fk FOREIGN KEY (team_id) REFERENCES understat.teams(team_id);


--
-- Name: team_seasons understat_team_seasons_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.team_seasons
    ADD CONSTRAINT understat_team_seasons_season_fk FOREIGN KEY (season_code) REFERENCES understat.seasons(season_code);


--
-- Name: team_seasons understat_team_seasons_team_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.team_seasons
    ADD CONSTRAINT understat_team_seasons_team_fk FOREIGN KEY (team_id) REFERENCES understat.teams(team_id);


--
-- Name: team_stat_splits understat_team_stat_splits_parent_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.team_stat_splits
    ADD CONSTRAINT understat_team_stat_splits_parent_fk FOREIGN KEY (season_code, team_id) REFERENCES understat.team_seasons(season_code, team_id);


--
-- Name: teams understat_teams_first_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.teams
    ADD CONSTRAINT understat_teams_first_season_fk FOREIGN KEY (first_seen_season) REFERENCES understat.seasons(season_code);


--
-- Name: teams understat_teams_last_season_fk; Type: FK CONSTRAINT; Schema: understat; Owner: letletme_data_owner
--

ALTER TABLE ONLY understat.teams
    ADD CONSTRAINT understat_teams_last_season_fk FOREIGN KEY (last_seen_season) REFERENCES understat.seasons(season_code);


--
-- Name: SCHEMA bridge; Type: ACL; Schema: -; Owner: letletme_data_owner
--

GRANT USAGE ON SCHEMA bridge TO letletme_data_writer;
GRANT USAGE ON SCHEMA bridge TO letletme_graphql_reader;


--
-- Name: SCHEMA competition; Type: ACL; Schema: -; Owner: letletme_data_owner
--

GRANT USAGE ON SCHEMA competition TO letletme_data_writer;
GRANT USAGE ON SCHEMA competition TO letletme_graphql_reader;


--
-- Name: SCHEMA fpl; Type: ACL; Schema: -; Owner: letletme_data_owner
--

GRANT USAGE ON SCHEMA fpl TO letletme_data_writer;
GRANT USAGE ON SCHEMA fpl TO letletme_graphql_reader;


--
-- Name: SCHEMA ops; Type: ACL; Schema: -; Owner: letletme_data_owner
--

GRANT USAGE ON SCHEMA ops TO letletme_data_writer;
GRANT USAGE ON SCHEMA ops TO letletme_graphql_reader;


--
-- Name: SCHEMA reporting; Type: ACL; Schema: -; Owner: letletme_data_owner
--

GRANT USAGE ON SCHEMA reporting TO letletme_data_writer;
GRANT USAGE ON SCHEMA reporting TO letletme_graphql_reader;


--
-- Name: SCHEMA understat; Type: ACL; Schema: -; Owner: letletme_data_owner
--

GRANT USAGE ON SCHEMA understat TO letletme_data_writer;
GRANT USAGE ON SCHEMA understat TO letletme_graphql_reader;


--
-- Name: FUNCTION refresh_tournament_entry_event_summaries(); Type: ACL; Schema: reporting; Owner: letletme_data_owner
--

REVOKE ALL ON FUNCTION reporting.refresh_tournament_entry_event_summaries() FROM PUBLIC;
GRANT ALL ON FUNCTION reporting.refresh_tournament_entry_event_summaries() TO letletme_data_writer;


--
-- Name: FUNCTION refresh_tournament_selection_stats(); Type: ACL; Schema: reporting; Owner: letletme_data_owner
--

REVOKE ALL ON FUNCTION reporting.refresh_tournament_selection_stats() FROM PUBLIC;
GRANT ALL ON FUNCTION reporting.refresh_tournament_selection_stats() TO letletme_data_writer;


--
-- Name: TABLE entity_aliases; Type: ACL; Schema: bridge; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE bridge.entity_aliases TO letletme_data_writer;
GRANT SELECT ON TABLE bridge.entity_aliases TO letletme_graphql_reader;


--
-- Name: TABLE entity_links; Type: ACL; Schema: bridge; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE bridge.entity_links TO letletme_data_writer;
GRANT SELECT ON TABLE bridge.entity_links TO letletme_graphql_reader;


--
-- Name: TABLE match_links; Type: ACL; Schema: bridge; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE bridge.match_links TO letletme_data_writer;
GRANT SELECT ON TABLE bridge.match_links TO letletme_graphql_reader;


--
-- Name: TABLE entries; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.entries TO letletme_data_writer;
GRANT SELECT ON TABLE competition.entries TO letletme_graphql_reader;


--
-- Name: TABLE entry_event_cup_results; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.entry_event_cup_results TO letletme_data_writer;
GRANT SELECT ON TABLE competition.entry_event_cup_results TO letletme_graphql_reader;


--
-- Name: TABLE entry_event_picks; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.entry_event_picks TO letletme_data_writer;
GRANT SELECT ON TABLE competition.entry_event_picks TO letletme_graphql_reader;


--
-- Name: TABLE entry_event_results; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.entry_event_results TO letletme_data_writer;
GRANT SELECT ON TABLE competition.entry_event_results TO letletme_graphql_reader;


--
-- Name: TABLE entry_event_transfers; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.entry_event_transfers TO letletme_data_writer;
GRANT SELECT ON TABLE competition.entry_event_transfers TO letletme_graphql_reader;


--
-- Name: SEQUENCE entry_event_transfers_transfer_id_seq; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE competition.entry_event_transfers_transfer_id_seq TO letletme_data_writer;


--
-- Name: TABLE entry_leagues; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.entry_leagues TO letletme_data_writer;
GRANT SELECT ON TABLE competition.entry_leagues TO letletme_graphql_reader;


--
-- Name: TABLE entry_season_histories; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.entry_season_histories TO letletme_data_writer;
GRANT SELECT ON TABLE competition.entry_season_histories TO letletme_graphql_reader;


--
-- Name: TABLE league_event_results; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.league_event_results TO letletme_data_writer;
GRANT SELECT ON TABLE competition.league_event_results TO letletme_graphql_reader;


--
-- Name: SEQUENCE league_event_results_source_result_id_seq; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE competition.league_event_results_source_result_id_seq TO letletme_data_writer;


--
-- Name: TABLE public_league_trends; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.public_league_trends TO letletme_data_writer;
GRANT SELECT ON TABLE competition.public_league_trends TO letletme_graphql_reader;


--
-- Name: TABLE tournament_battle_group_results; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.tournament_battle_group_results TO letletme_data_writer;
GRANT SELECT ON TABLE competition.tournament_battle_group_results TO letletme_graphql_reader;


--
-- Name: SEQUENCE tournament_battle_group_results_source_result_id_seq; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE competition.tournament_battle_group_results_source_result_id_seq TO letletme_data_writer;


--
-- Name: TABLE tournament_entries; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.tournament_entries TO letletme_data_writer;
GRANT SELECT ON TABLE competition.tournament_entries TO letletme_graphql_reader;


--
-- Name: TABLE tournament_groups; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.tournament_groups TO letletme_data_writer;
GRANT SELECT ON TABLE competition.tournament_groups TO letletme_graphql_reader;


--
-- Name: SEQUENCE tournament_groups_source_group_row_id_seq; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE competition.tournament_groups_source_group_row_id_seq TO letletme_data_writer;


--
-- Name: TABLE tournament_knockout_results; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.tournament_knockout_results TO letletme_data_writer;
GRANT SELECT ON TABLE competition.tournament_knockout_results TO letletme_graphql_reader;


--
-- Name: SEQUENCE tournament_knockout_results_source_result_id_seq; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE competition.tournament_knockout_results_source_result_id_seq TO letletme_data_writer;


--
-- Name: TABLE tournament_knockouts; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.tournament_knockouts TO letletme_data_writer;
GRANT SELECT ON TABLE competition.tournament_knockouts TO letletme_graphql_reader;


--
-- Name: SEQUENCE tournament_knockouts_source_knockout_id_seq; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE competition.tournament_knockouts_source_knockout_id_seq TO letletme_data_writer;


--
-- Name: TABLE tournament_points_group_results; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.tournament_points_group_results TO letletme_data_writer;
GRANT SELECT ON TABLE competition.tournament_points_group_results TO letletme_graphql_reader;


--
-- Name: SEQUENCE tournament_points_group_results_source_result_id_seq; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE competition.tournament_points_group_results_source_result_id_seq TO letletme_data_writer;


--
-- Name: TABLE tournaments; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE competition.tournaments TO letletme_data_writer;
GRANT SELECT ON TABLE competition.tournaments TO letletme_graphql_reader;


--
-- Name: SEQUENCE tournaments_tournament_id_seq; Type: ACL; Schema: competition; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE competition.tournaments_tournament_id_seq TO letletme_data_writer;


--
-- Name: TABLE events; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.events TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.events TO letletme_graphql_reader;


--
-- Name: TABLE fixtures; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.fixtures TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.fixtures TO letletme_graphql_reader;


--
-- Name: TABLE phases; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.phases TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.phases TO letletme_graphql_reader;


--
-- Name: TABLE player_event_snapshots; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.player_event_snapshots TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.player_event_snapshots TO letletme_graphql_reader;


--
-- Name: TABLE player_fixture_stats; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.player_fixture_stats TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.player_fixture_stats TO letletme_graphql_reader;


--
-- Name: TABLE player_gameweek_scoring_items; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.player_gameweek_scoring_items TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.player_gameweek_scoring_items TO letletme_graphql_reader;


--
-- Name: TABLE player_gameweek_stats; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.player_gameweek_stats TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.player_gameweek_stats TO letletme_graphql_reader;


--
-- Name: TABLE player_market_snapshots; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.player_market_snapshots TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.player_market_snapshots TO letletme_graphql_reader;


--
-- Name: TABLE players; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.players TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.players TO letletme_graphql_reader;


--
-- Name: TABLE seasons; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.seasons TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.seasons TO letletme_graphql_reader;


--
-- Name: TABLE teams; Type: ACL; Schema: fpl; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE fpl.teams TO letletme_data_writer;
GRANT SELECT ON TABLE fpl.teams TO letletme_graphql_reader;


--
-- Name: SEQUENCE dataset_publication_revisions; Type: ACL; Schema: ops; Owner: letletme_data_owner
--

GRANT SELECT,USAGE ON SEQUENCE ops.dataset_publication_revisions TO letletme_data_writer;


--
-- Name: TABLE dataset_publications; Type: ACL; Schema: ops; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.dataset_publications TO letletme_data_writer;
GRANT SELECT ON TABLE ops.dataset_publications TO letletme_graphql_reader;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: ops; Owner: letletme_data_owner
--

DO $migration_actor$
BEGIN
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE ops.schema_migrations TO %I',
        current_user
    );
END
$migration_actor$;


--
-- Name: TABLE season_imports; Type: ACL; Schema: ops; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.season_imports TO letletme_data_writer;


--
-- Name: TABLE sync_items; Type: ACL; Schema: ops; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.sync_items TO letletme_data_writer;


--
-- Name: TABLE sync_runs; Type: ACL; Schema: ops; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ops.sync_runs TO letletme_data_writer;


--
-- Name: TABLE player_season_summaries; Type: ACL; Schema: reporting; Owner: letletme_data_owner
--

GRANT SELECT ON TABLE reporting.player_season_summaries TO letletme_graphql_reader;


--
-- Name: TABLE player_value_changes; Type: ACL; Schema: reporting; Owner: letletme_data_owner
--

GRANT SELECT ON TABLE reporting.player_value_changes TO letletme_graphql_reader;


--
-- Name: TABLE tournament_entry_event_summaries; Type: ACL; Schema: reporting; Owner: letletme_data_owner
--

GRANT SELECT ON TABLE reporting.tournament_entry_event_summaries TO letletme_graphql_reader;
GRANT SELECT ON TABLE reporting.tournament_entry_event_summaries TO letletme_data_writer;


--
-- Name: TABLE tournament_event_results; Type: ACL; Schema: reporting; Owner: letletme_data_owner
--

GRANT SELECT ON TABLE reporting.tournament_event_results TO letletme_graphql_reader;


--
-- Name: TABLE tournament_selection_stats; Type: ACL; Schema: reporting; Owner: letletme_data_owner
--

GRANT SELECT ON TABLE reporting.tournament_selection_stats TO letletme_graphql_reader;
GRANT SELECT ON TABLE reporting.tournament_selection_stats TO letletme_data_writer;


--
-- Name: TABLE matches; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.matches TO letletme_data_writer;
GRANT SELECT ON TABLE understat.matches TO letletme_graphql_reader;


--
-- Name: TABLE player_match_stats; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.player_match_stats TO letletme_data_writer;
GRANT SELECT ON TABLE understat.player_match_stats TO letletme_graphql_reader;


--
-- Name: TABLE player_seasons; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.player_seasons TO letletme_data_writer;
GRANT SELECT ON TABLE understat.player_seasons TO letletme_graphql_reader;


--
-- Name: TABLE player_team_seasons; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.player_team_seasons TO letletme_data_writer;
GRANT SELECT ON TABLE understat.player_team_seasons TO letletme_graphql_reader;


--
-- Name: TABLE players; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.players TO letletme_data_writer;
GRANT SELECT ON TABLE understat.players TO letletme_graphql_reader;


--
-- Name: TABLE seasons; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.seasons TO letletme_data_writer;
GRANT SELECT ON TABLE understat.seasons TO letletme_graphql_reader;


--
-- Name: TABLE team_match_stats; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.team_match_stats TO letletme_data_writer;
GRANT SELECT ON TABLE understat.team_match_stats TO letletme_graphql_reader;


--
-- Name: TABLE team_seasons; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.team_seasons TO letletme_data_writer;
GRANT SELECT ON TABLE understat.team_seasons TO letletme_graphql_reader;


--
-- Name: TABLE team_stat_splits; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.team_stat_splits TO letletme_data_writer;
GRANT SELECT ON TABLE understat.team_stat_splits TO letletme_graphql_reader;


--
-- Name: TABLE teams; Type: ACL; Schema: understat; Owner: letletme_data_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE understat.teams TO letletme_data_writer;
GRANT SELECT ON TABLE understat.teams TO letletme_graphql_reader;


--
-- PostgreSQL database dump complete
--
