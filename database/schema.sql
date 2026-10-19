-- ============================================================
-- Nigeria CEWS — PostgreSQL 15 + PostGIS 3.4 Database Schema
-- Version: 1.0.0  |  Encoding: UTF-8
-- Run as: psql -U postgres -d cews_db -f schema.sql
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================
-- UTILITY FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_attach_updated_at_trigger(p_table_name TEXT)
RETURNS VOID AS $$
BEGIN
    EXECUTE format(
        'CREATE TRIGGER trg_%s_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at()',
        p_table_name, p_table_name
    );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- GEOGRAPHIC HIERARCHY
-- ============================================================

CREATE TABLE geo_zones (
    id              SMALLINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    zone_code       CHAR(3)         NOT NULL UNIQUE,
    zone_name       VARCHAR(50)     NOT NULL UNIQUE,
    description     TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SELECT fn_attach_updated_at_trigger('geo_zones');

INSERT INTO geo_zones (zone_code, zone_name) VALUES
    ('NWZ', 'North-West'),
    ('NEZ', 'North-East'),
    ('NCZ', 'North-Central'),
    ('SWZ', 'South-West'),
    ('SSZ', 'South-South'),
    ('SEZ', 'South-East');

CREATE TABLE geo_states (
    id              SMALLINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    zone_id         SMALLINT        NOT NULL REFERENCES geo_zones(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    state_code      CHAR(2)         NOT NULL UNIQUE,
    state_name      VARCHAR(50)     NOT NULL UNIQUE,
    capital_city    VARCHAR(50)     NOT NULL,
    geom            GEOMETRY(MultiPolygon, 4326),
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SELECT fn_attach_updated_at_trigger('geo_states');
CREATE INDEX idx_geo_states_zone_id ON geo_states(zone_id);
CREATE INDEX idx_geo_states_geom ON geo_states USING GIST(geom);

-- Seed: All 36 states + FCT mapped to zones
INSERT INTO geo_states (zone_id, state_code, state_name, capital_city) VALUES
-- North-West (zone_id=1)
(1, 'KN', 'Kano',       'Kano City'),
(1, 'KT', 'Katsina',    'Katsina'),
(1, 'KB', 'Kebbi',      'Birnin Kebbi'),
(1, 'SO', 'Sokoto',     'Sokoto'),
(1, 'ZM', 'Zamfara',    'Gusau'),
(1, 'KD', 'Kaduna',     'Kaduna'),
(1, 'JG', 'Jigawa',     'Dutse'),
-- North-East (zone_id=2)
(2, 'BO', 'Borno',      'Maiduguri'),
(2, 'AD', 'Adamawa',    'Yola'),
(2, 'GM', 'Gombe',      'Gombe'),
(2, 'YO', 'Yobe',       'Damaturu'),
(2, 'TR', 'Taraba',     'Jalingo'),
(2, 'BA', 'Bauchi',     'Bauchi'),
-- North-Central (zone_id=3)
(3, 'NG', 'Niger',      'Minna'),
(3, 'PL', 'Plateau',    'Jos'),
(3, 'BE', 'Benue',      'Makurdi'),
(3, 'KG', 'Kogi',       'Lokoja'),
(3, 'KW', 'Kwara',      'Ilorin'),
(3, 'NS', 'Nasarawa',   'Lafia'),
(3, 'FC', 'FCT',        'Abuja'),
-- South-West (zone_id=4)
(4, 'LA', 'Lagos',      'Ikeja'),
(4, 'OG', 'Ogun',       'Abeokuta'),
(4, 'OY', 'Oyo',        'Ibadan'),
(4, 'OS', 'Osun',       'Osogbo'),
(4, 'ON', 'Ondo',       'Akure'),
(4, 'EK', 'Ekiti',      'Ado-Ekiti'),
-- South-South (zone_id=5)
(5, 'RV', 'Rivers',     'Port Harcourt'),
(5, 'DL', 'Delta',      'Asaba'),
(5, 'BY', 'Bayelsa',    'Yenagoa'),
(5, 'ED', 'Edo',        'Benin City'),
(5, 'CR', 'Cross River','Calabar'),
(5, 'AK', 'Akwa Ibom',  'Uyo'),
-- South-East (zone_id=6)
(6, 'AN', 'Anambra',    'Awka'),
(6, 'IM', 'Imo',        'Owerri'),
(6, 'EN', 'Enugu',      'Enugu'),
(6, 'EB', 'Ebonyi',     'Abakaliki'),
(6, 'AB', 'Abia',       'Umuahia');

CREATE TABLE geo_lgas (
    id              SMALLINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    state_id        SMALLINT        NOT NULL REFERENCES geo_states(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    lga_code        CHAR(3)         NOT NULL UNIQUE,
    lga_name        VARCHAR(100)    NOT NULL,
    population_est  INTEGER,
    area_km2        NUMERIC(10, 2),
    geom            GEOMETRY(MultiPolygon, 4326),
    centroid        GEOMETRY(Point, 4326)
        GENERATED ALWAYS AS (ST_Centroid(geom)) STORED,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(state_id, lga_name)
);
SELECT fn_attach_updated_at_trigger('geo_lgas');
CREATE INDEX idx_geo_lgas_state_id   ON geo_lgas(state_id);
CREATE INDEX idx_geo_lgas_geom       ON geo_lgas USING GIST(geom);
CREATE INDEX idx_geo_lgas_centroid   ON geo_lgas USING GIST(centroid);

CREATE TABLE geo_wards (
    id              INTEGER         PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    lga_id          SMALLINT        NOT NULL REFERENCES geo_lgas(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    ward_name       VARCHAR(150)    NOT NULL,
    ward_code       VARCHAR(10),
    geom            GEOMETRY(MultiPolygon, 4326),
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(lga_id, ward_name)
);
SELECT fn_attach_updated_at_trigger('geo_wards');
CREATE INDEX idx_geo_wards_lga_id ON geo_wards(lga_id);
CREATE INDEX idx_geo_wards_geom   ON geo_wards USING GIST(geom);

CREATE TABLE geo_infrastructure_corridors (
    id              SERIAL          PRIMARY KEY,
    corridor_name   VARCHAR(200)    NOT NULL UNIQUE,
    corridor_type   VARCHAR(50)     NOT NULL CHECK (corridor_type IN ('highway','pipeline','railway','waterway','power_line')),
    geom            GEOMETRY(LineString, 4326) NOT NULL,
    buffer_km       NUMERIC(5,1)    NOT NULL DEFAULT 25.0,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SELECT fn_attach_updated_at_trigger('geo_infrastructure_corridors');
CREATE INDEX idx_geo_infra_corridors_geom ON geo_infrastructure_corridors USING GIST(geom);

INSERT INTO geo_infrastructure_corridors (corridor_name, corridor_type, geom, buffer_km) VALUES
(
    'Kaduna–Abuja Expressway (A2)',
    'highway',
    ST_GeomFromText('LINESTRING(7.4411 10.5264, 7.6000 10.2000, 7.8000 9.8000, 8.5196 9.0765)', 4326),
    50.0
),
(
    'Trans-Niger Pipeline (Port Harcourt–Aba–Enugu)',
    'pipeline',
    ST_GeomFromText('LINESTRING(7.0134 4.8396, 7.3667 5.1167, 7.5167 6.3167)', 4326),
    25.0
),
(
    'Damaturu–Maiduguri Highway (A14)',
    'highway',
    ST_GeomFromText('LINESTRING(11.9608 11.7467, 12.5000 11.8500, 13.0851 11.8333)', 4326),
    30.0
),
(
    'Ore–Lagos Expressway (A121)',
    'highway',
    ST_GeomFromText('LINESTRING(4.8620 6.7437, 3.9000 6.7000, 3.3841 6.4550)', 4326),
    25.0
),
(
    'Nembe Creek Trunkline (Bayelsa)',
    'pipeline',
    ST_GeomFromText('LINESTRING(6.3000 4.9500, 6.4167 4.8167, 6.6833 4.7500)', 4326),
    20.0
),
(
    'Maiduguri–Damboa Road (Borno)',
    'highway',
    ST_GeomFromText('LINESTRING(13.0851 11.8333, 13.1500 11.5000, 13.1667 11.1333)', 4326),
    20.0
);

-- ============================================================
-- APPLICATION USERS
-- ============================================================

CREATE TYPE user_role_enum AS ENUM (
    'public_reporter',
    'vetted_monitor',
    'admin_analyst',
    'partner_api'
);

CREATE TYPE account_status_enum AS ENUM (
    'pending_approval',
    'active',
    'suspended',
    'deactivated'
);

CREATE TABLE app_users (
    id                      INTEGER         PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    public_id               UUID            NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    role                    user_role_enum  NOT NULL DEFAULT 'public_reporter',
    account_status          account_status_enum NOT NULL DEFAULT 'pending_approval',
    zone_id                 SMALLINT        REFERENCES geo_zones(id) ON DELETE SET NULL ON UPDATE CASCADE,
    state_id                SMALLINT        REFERENCES geo_states(id) ON DELETE SET NULL ON UPDATE CASCADE,
    keycloak_subject_id     VARCHAR(100)    UNIQUE,
    device_cert_cn          VARCHAR(200),
    total_submissions       INTEGER         NOT NULL DEFAULT 0,
    confirmed_submissions   INTEGER         NOT NULL DEFAULT 0,
    false_alarm_submissions INTEGER         NOT NULL DEFAULT 0,
    spam_flag_count         INTEGER         NOT NULL DEFAULT 0,
    trust_score             NUMERIC(4,3)    NOT NULL DEFAULT 0.500 CHECK (trust_score BETWEEN 0.0 AND 1.0),
    pending_review_count    INTEGER         NOT NULL DEFAULT 0 CHECK (pending_review_count >= 0),
    suspension_reason       TEXT,
    suspension_expires_at   TIMESTAMPTZ,
    suspended_by_user_id    INTEGER         REFERENCES app_users(id) ON DELETE SET NULL,
    last_active_at          TIMESTAMPTZ,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SELECT fn_attach_updated_at_trigger('app_users');
CREATE INDEX idx_app_users_zone_id       ON app_users(zone_id);
CREATE INDEX idx_app_users_state_id      ON app_users(state_id);
CREATE INDEX idx_app_users_role_status   ON app_users(role, account_status);
CREATE INDEX idx_app_users_trust_score   ON app_users(trust_score DESC) WHERE account_status = 'active';

-- ============================================================
-- REPORTER PII VAULT
-- ============================================================

CREATE TABLE reporter_pii_vault (
    id                      INTEGER         PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    anon_token              UUID            NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    user_id                 INTEGER         REFERENCES app_users(id) ON DELETE CASCADE,
    phone_number_enc        BYTEA,
    ip_address_enc          BYTEA,
    display_name_enc        BYTEA,
    email_enc               BYTEA,
    device_fingerprint_enc  BYTEA,
    phone_hash              CHAR(64),
    ip_subnet_hash          CHAR(64),
    submission_channel      VARCHAR(20)     NOT NULL CHECK (submission_channel IN ('web_form','ussd','sms','partner_api','radio_transcription')),
    network_code            VARCHAR(10),
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pii_vault_anon_token  ON reporter_pii_vault(anon_token);
CREATE INDEX idx_pii_vault_phone_hash  ON reporter_pii_vault(phone_hash)     WHERE phone_hash IS NOT NULL;
CREATE INDEX idx_pii_vault_ip_hash     ON reporter_pii_vault(ip_subnet_hash) WHERE ip_subnet_hash IS NOT NULL;

ALTER TABLE reporter_pii_vault ENABLE ROW LEVEL SECURITY;
CREATE POLICY pii_vault_admin_only ON reporter_pii_vault
    FOR ALL TO PUBLIC
    USING (current_setting('app.user_role', TRUE) = 'admin_analyst');

-- ============================================================
-- CONFLICT ALERTS
-- ============================================================

CREATE TYPE alert_type_enum AS ENUM (
    'banditry_kidnapping',
    'herder_farmer_violence',
    'jihadist_insurgency',
    'cult_gang_violence',
    'political_thuggery',
    'electoral_violence',
    'ethnic_communal_clash',
    'pipeline_vandalism',
    'separatist_activity',
    'security_force_abuse',
    'hate_speech_incitement',
    'market_closure_boycott',
    'iswap_governance_claim',
    'unknown_gunmen_attack',
    'other'
);

CREATE TYPE risk_level_enum AS ENUM (
    'watch',
    'advisory',
    'warning',
    'emergency'
);

CREATE TYPE verification_status_enum AS ENUM (
    'pending',
    'under_review',
    'disputed',
    'verified',
    'false_alarm',
    'expired_unverified',
    'flagged_suspicious'
);

CREATE TABLE conflict_alerts (
    id                      BIGINT          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    public_id               UUID            NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    anon_token              UUID            NOT NULL REFERENCES reporter_pii_vault(anon_token) ON DELETE RESTRICT,
    zone_id                 SMALLINT        NOT NULL REFERENCES geo_zones(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
    state_id                SMALLINT        NOT NULL REFERENCES geo_states(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    lga_id                  SMALLINT        NOT NULL REFERENCES geo_lgas(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
    ward_id                 INTEGER         REFERENCES geo_wards(id) ON DELETE SET NULL ON UPDATE CASCADE,
    alert_type              alert_type_enum     NOT NULL,
    risk_level              risk_level_enum     NOT NULL DEFAULT 'watch',
    verification_status     verification_status_enum NOT NULL DEFAULT 'pending',
    title                   VARCHAR(200)    NOT NULL,
    description             TEXT            NOT NULL CHECK (char_length(description) >= 20),
    description_language    CHAR(3)         NOT NULL DEFAULT 'eng',
    geom                    GEOMETRY(Point, 4326) NOT NULL,
    location_accuracy_m     INTEGER         CHECK (location_accuracy_m > 0),
    location_method         VARCHAR(20)     NOT NULL DEFAULT 'reporter_pin'
                            CHECK (location_method IN ('gps_device','reporter_pin','lga_centroid','address_geocode','ussd_lga_code')),
    zone_indicators         JSONB,
    behavioral_trigger_flags JSONB,
    casualties_confirmed    INTEGER         NOT NULL DEFAULT 0 CHECK (casualties_confirmed >= 0),
    casualties_estimated    INTEGER         NOT NULL DEFAULT 0 CHECK (casualties_estimated >= 0),
    displaced_persons_est   INTEGER         NOT NULL DEFAULT 0 CHECK (displaced_persons_est >= 0),
    has_media_evidence      BOOLEAN         NOT NULL DEFAULT FALSE,
    media_evidence_count    SMALLINT        NOT NULL DEFAULT 0,
    spam_classifier_score   NUMERIC(4,3)    CHECK (spam_classifier_score BETWEEN 0.0 AND 1.0),
    risk_composite_score    NUMERIC(5,2),
    submission_channel      VARCHAR(20)     NOT NULL CHECK (submission_channel IN ('web_form','ussd','sms','partner_api','radio_transcription')),
    ussd_session_id         VARCHAR(100),
    assigned_warden_ids     INTEGER[]       DEFAULT '{}',
    verification_deadline   TIMESTAMPTZ,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at             TIMESTAMPTZ,
    incident_occurred_at    TIMESTAMPTZ
);
SELECT fn_attach_updated_at_trigger('conflict_alerts');

-- Trigger: auto-set verification_deadline
CREATE OR REPLACE FUNCTION fn_set_verification_deadline()
RETURNS TRIGGER AS $$
BEGIN
    NEW.verification_deadline := NEW.created_at + INTERVAL '48 hours';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_conflict_alerts_verification_deadline
    BEFORE INSERT ON conflict_alerts
    FOR EACH ROW EXECUTE FUNCTION fn_set_verification_deadline();

-- Trigger: auto-set verified_at on status transition
CREATE OR REPLACE FUNCTION fn_set_verified_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.verification_status = 'verified' AND OLD.verification_status != 'verified' THEN
        NEW.verified_at := CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_conflict_alerts_set_verified_at
    BEFORE UPDATE OF verification_status ON conflict_alerts
    FOR EACH ROW EXECUTE FUNCTION fn_set_verified_at();

-- Trigger: Update user submission counts when alert status changes
CREATE OR REPLACE FUNCTION fn_update_user_submission_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id INTEGER;
BEGIN
    -- Get user_id via anon_token join
    SELECT user_id INTO v_user_id FROM reporter_pii_vault WHERE anon_token = NEW.anon_token;
    IF v_user_id IS NULL THEN RETURN NEW; END IF;

    IF NEW.verification_status = 'verified' AND OLD.verification_status != 'verified' THEN
        UPDATE app_users SET
            confirmed_submissions = confirmed_submissions + 1,
            trust_score = LEAST(1.0, trust_score + 0.05)
        WHERE id = v_user_id;
    ELSIF NEW.verification_status = 'false_alarm' AND OLD.verification_status != 'false_alarm' THEN
        UPDATE app_users SET
            false_alarm_submissions = false_alarm_submissions + 1,
            trust_score = GREATEST(0.0, trust_score - 0.15)
        WHERE id = v_user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_conflict_alerts_update_user_stats
    AFTER UPDATE OF verification_status ON conflict_alerts
    FOR EACH ROW EXECUTE FUNCTION fn_update_user_submission_stats();

-- Indexes
CREATE INDEX idx_conflict_alerts_geom            ON conflict_alerts USING GIST(geom);
CREATE INDEX idx_conflict_alerts_geom_created    ON conflict_alerts USING GIST(geom, created_at)
    WHERE verification_status = 'verified';
CREATE INDEX idx_conflict_alerts_zone_time       ON conflict_alerts(zone_id, created_at DESC)
    WHERE verification_status = 'verified';
CREATE INDEX idx_conflict_alerts_lga_status      ON conflict_alerts(lga_id, verification_status, created_at DESC);
CREATE INDEX idx_conflict_alerts_risk_level      ON conflict_alerts(risk_level, created_at DESC)
    WHERE verification_status = 'verified' AND risk_level IN ('warning', 'emergency');
CREATE INDEX idx_conflict_alerts_pending         ON conflict_alerts(created_at ASC)
    WHERE verification_status IN ('pending', 'under_review');
CREATE INDEX idx_conflict_alerts_suspicious      ON conflict_alerts(spam_classifier_score DESC)
    WHERE verification_status = 'flagged_suspicious';
CREATE INDEX idx_conflict_alerts_created_brin    ON conflict_alerts USING BRIN(created_at) WITH (pages_per_range = 32);
CREATE INDEX idx_conflict_alerts_zone_indicators ON conflict_alerts USING GIN(zone_indicators);
CREATE INDEX idx_conflict_alerts_behavioral_flags ON conflict_alerts USING GIN(behavioral_trigger_flags);

-- ============================================================
-- VERIFICATION AUDIT TRAIL
-- ============================================================

CREATE TYPE warden_vote_enum AS ENUM ('confirm', 'dispute', 'escalate');

CREATE TABLE alert_verifications (
    id                  INTEGER         PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    alert_id            BIGINT          NOT NULL REFERENCES conflict_alerts(id)  ON DELETE CASCADE ON UPDATE CASCADE,
    warden_id           INTEGER         NOT NULL REFERENCES app_users(id)        ON DELETE RESTRICT ON UPDATE CASCADE,
    vote                warden_vote_enum NOT NULL,
    vote_notes          TEXT,
    evidence_urls       TEXT[],
    corroborating_source VARCHAR(200),
    reviewed_at         TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(alert_id, warden_id)
);
CREATE INDEX idx_alert_verifications_alert_id  ON alert_verifications(alert_id);
CREATE INDEX idx_alert_verifications_warden_id ON alert_verifications(warden_id);

-- Trigger: auto-advance alert status after 2 CONFIRM votes
CREATE OR REPLACE FUNCTION fn_auto_advance_alert_status()
RETURNS TRIGGER AS $$
DECLARE
    v_confirm_count INTEGER;
    v_dispute_count INTEGER;
BEGIN
    SELECT
        COUNT(*) FILTER (WHERE vote = 'confirm'),
        COUNT(*) FILTER (WHERE vote = 'dispute')
    INTO v_confirm_count, v_dispute_count
    FROM alert_verifications
    WHERE alert_id = NEW.alert_id;

    IF v_confirm_count >= 2 THEN
        UPDATE conflict_alerts
        SET verification_status = 'verified'
        WHERE id = NEW.alert_id AND verification_status != 'verified';
    ELSIF v_dispute_count >= 1 THEN
        UPDATE conflict_alerts
        SET verification_status = 'disputed'
        WHERE id = NEW.alert_id AND verification_status = 'under_review';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_alert_verifications_auto_advance
    AFTER INSERT ON alert_verifications
    FOR EACH ROW EXECUTE FUNCTION fn_auto_advance_alert_status();

-- ============================================================
-- ZONE RISK SCORES
-- ============================================================

CREATE TABLE zone_risk_scores (
    id                  SERIAL          PRIMARY KEY,
    zone_id             SMALLINT        NOT NULL REFERENCES geo_zones(id) ON DELETE CASCADE ON UPDATE CASCADE,
    score_date          DATE            NOT NULL,
    composite_score     NUMERIC(5,2)    NOT NULL CHECK (composite_score BETWEEN 0 AND 100),
    alert_count_24h     INTEGER         NOT NULL DEFAULT 0,
    alert_count_7d      INTEGER         NOT NULL DEFAULT 0,
    dominant_alert_type alert_type_enum,
    risk_level          risk_level_enum NOT NULL DEFAULT 'watch',
    score_components    JSONB,
    computed_at         TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(zone_id, score_date)
);
CREATE INDEX idx_zone_risk_scores_zone_date ON zone_risk_scores(zone_id, score_date DESC);

-- ============================================================
-- ALERT MEDIA EVIDENCE
-- ============================================================

CREATE TABLE alert_media_evidence (
    id                  INTEGER         PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    alert_id            BIGINT          NOT NULL REFERENCES conflict_alerts(id)  ON DELETE CASCADE ON UPDATE CASCADE,
    uploaded_by_user_id INTEGER         REFERENCES app_users(id) ON DELETE SET NULL,
    storage_key         VARCHAR(500)    NOT NULL UNIQUE,
    media_type          VARCHAR(10)     NOT NULL CHECK (media_type IN ('image','audio','video','document')),
    mime_type           VARCHAR(50)     NOT NULL,
    file_size_bytes     INTEGER,
    is_exif_stripped    BOOLEAN         NOT NULL DEFAULT FALSE,
    is_ai_analyzed      BOOLEAN         NOT NULL DEFAULT FALSE,
    ai_analysis_summary TEXT,
    is_public_visible   BOOLEAN         NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_alert_media_evidence_alert_id ON alert_media_evidence(alert_id);

-- ============================================================
-- SYSTEM AUDIT LOG
-- ============================================================

CREATE TABLE system_audit_log (
    id                  BIGINT          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    actor_user_id       INTEGER         REFERENCES app_users(id) ON DELETE SET NULL,
    action              VARCHAR(100)    NOT NULL,
    entity_type         VARCHAR(50)     NOT NULL,
    entity_id           BIGINT,
    old_value           JSONB,
    new_value           JSONB,
    ip_hash             CHAR(64),
    user_agent_hash     CHAR(64),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_log_actor  ON system_audit_log(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_log_entity ON system_audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_log_action ON system_audit_log(action, created_at DESC);

-- ============================================================
-- INFRASTRUCTURE ALERT CORRELATIONS (SPATIAL JOIN CACHE)
-- ============================================================

CREATE TABLE alert_corridor_proximity (
    id                  SERIAL          PRIMARY KEY,
    alert_id            BIGINT          NOT NULL REFERENCES conflict_alerts(id) ON DELETE CASCADE,
    corridor_id         INTEGER         NOT NULL REFERENCES geo_infrastructure_corridors(id) ON DELETE CASCADE,
    distance_m          NUMERIC(10,2)   NOT NULL,
    computed_at         TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(alert_id, corridor_id)
);
CREATE INDEX idx_alert_corridor_proximity_corridor ON alert_corridor_proximity(corridor_id, distance_m ASC);

-- ============================================================
-- PUBLIC DASHBOARD VIEW (PII-SAFE)
-- ============================================================

CREATE MATERIALIZED VIEW conflict_alerts_public_view AS
SELECT
    ca.public_id,
    ca.alert_type,
    ca.risk_level,
    ca.zone_id,
    gz.zone_code,
    gz.zone_name,
    ca.state_id,
    gs.state_name,
    ca.lga_id,
    gl.lga_name,
    CASE
        WHEN ca.risk_level IN ('emergency', 'warning') THEN ca.geom
        ELSE gl.centroid
    END AS display_geom,
    ST_X(CASE WHEN ca.risk_level IN ('emergency', 'warning') THEN ca.geom ELSE gl.centroid END) AS display_lon,
    ST_Y(CASE WHEN ca.risk_level IN ('emergency', 'warning') THEN ca.geom ELSE gl.centroid END) AS display_lat,
    ca.casualties_confirmed,
    ca.casualties_estimated,
    ca.behavioral_trigger_flags,
    ca.description_language,
    ca.created_at,
    ca.verified_at
FROM conflict_alerts ca
JOIN geo_zones  gz ON ca.zone_id  = gz.id
JOIN geo_states gs ON ca.state_id = gs.id
JOIN geo_lgas   gl ON ca.lga_id   = gl.id
WHERE ca.verification_status = 'verified'
WITH DATA;

CREATE UNIQUE INDEX idx_public_view_public_id ON conflict_alerts_public_view(public_id);
CREATE INDEX idx_public_view_display_geom     ON conflict_alerts_public_view USING GIST(display_geom);
CREATE INDEX idx_public_view_zone_created     ON conflict_alerts_public_view(zone_id, created_at DESC);
CREATE INDEX idx_public_view_risk_level       ON conflict_alerts_public_view(risk_level, created_at DESC);

-- ============================================================
-- EXAMPLE ANALYTICAL QUERIES
-- ============================================================

/*
-- 1. Verified alerts within 50km of Kaduna-Abuja A2 in last 30 days
SELECT
    ca.public_id,
    ca.alert_type,
    ca.risk_level,
    gl.lga_name,
    gs.state_name,
    ROUND(ST_Distance(ca.geom::geography, ic.geom::geography) / 1000.0, 2) AS distance_km,
    ca.created_at
FROM conflict_alerts ca
JOIN geo_lgas gl ON ca.lga_id = gl.id
JOIN geo_states gs ON ca.state_id = gs.id
CROSS JOIN geo_infrastructure_corridors ic
WHERE
    ic.corridor_name = 'Kaduna–Abuja Expressway (A2)'
    AND ca.verification_status = 'verified'
    AND ca.created_at >= NOW() - INTERVAL '30 days'
    AND ST_DWithin(ca.geom::geography, ic.geom::geography, 50000)
ORDER BY distance_km ASC;

-- 2. Zone risk summary: alert counts and dominant type per zone last 7 days
SELECT
    gz.zone_name,
    COUNT(*) AS alert_count,
    MODE() WITHIN GROUP (ORDER BY ca.alert_type) AS dominant_type,
    SUM(ca.casualties_confirmed) AS total_casualties,
    MAX(ca.risk_level::text) AS max_risk_level
FROM conflict_alerts ca
JOIN geo_zones gz ON ca.zone_id = gz.id
WHERE
    ca.verification_status = 'verified'
    AND ca.created_at >= NOW() - INTERVAL '7 days'
GROUP BY gz.zone_name
ORDER BY alert_count DESC;

-- 3. LGAs with highest Monday Sit-At-Home violence (SEZ-specific indicator)
SELECT
    gl.lga_name,
    gs.state_name,
    SUM((ca.zone_indicators->>'sez_monday_sitin_enforcement_violence_count')::INTEGER) AS weekly_violence_count,
    COUNT(*) AS total_alerts
FROM conflict_alerts ca
JOIN geo_lgas gl ON ca.lga_id = gl.id
JOIN geo_states gs ON ca.state_id = gs.id
WHERE
    ca.zone_id = (SELECT id FROM geo_zones WHERE zone_code = 'SEZ')
    AND ca.verification_status = 'verified'
    AND ca.zone_indicators ? 'sez_monday_sitin_enforcement_violence_count'
    AND ca.created_at >= NOW() - INTERVAL '30 days'
GROUP BY gl.lga_name, gs.state_name
ORDER BY weekly_violence_count DESC
LIMIT 10;
*/

-- End of Schema
