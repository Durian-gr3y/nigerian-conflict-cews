"""
Nigeria CEWS - SQLAlchemy 2.0 Async ORM Models
================================================
All database models using DeclarativeBase, Mapped, and mapped_column
(SQLAlchemy 2.0 style) with GeoAlchemy2 for spatial columns.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import List, Optional

from geoalchemy2 import Geometry
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------

class Base(DeclarativeBase):
    """Shared declarative base for all CEWS models."""
    pass


# ---------------------------------------------------------------------------
# Python Enum definitions
# ---------------------------------------------------------------------------

class UserRoleEnum(str, enum.Enum):
    public_reporter = "public_reporter"
    vetted_monitor = "vetted_monitor"
    admin_analyst = "admin_analyst"
    partner_api = "partner_api"


class AccountStatusEnum(str, enum.Enum):
    pending_approval = "pending_approval"
    active = "active"
    suspended = "suspended"
    deactivated = "deactivated"


class AlertTypeEnum(str, enum.Enum):
    armed_clash = "armed_clash"
    protest_riot = "protest_riot"
    kidnapping_abduction = "kidnapping_abduction"
    banditry = "banditry"
    farmer_herder = "farmer_herder"
    cult_gang_violence = "cult_gang_violence"
    election_violence = "election_violence"
    police_military_abuse = "police_military_abuse"
    communal_dispute = "communal_dispute"
    ieds_unexploded = "ieds_unexploded"
    sexual_gbv = "sexual_gbv"
    displacement_movement = "displacement_movement"
    infrastructure_attack = "infrastructure_attack"
    cyber_disinformation = "cyber_disinformation"
    other = "other"


class RiskLevelEnum(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class VerificationStatusEnum(str, enum.Enum):
    pending = "pending"
    auto_verified = "auto_verified"
    warden_verified = "warden_verified"
    disputed = "disputed"
    escalated = "escalated"
    rejected = "rejected"
    published = "published"


class WardenVoteEnum(str, enum.Enum):
    confirm = "confirm"
    dispute = "dispute"
    escalate = "escalate"


class SubmissionChannelEnum(str, enum.Enum):
    web = "web"
    ussd = "ussd"
    sms = "sms"
    partner_api = "partner_api"
    whatsapp = "whatsapp"


# ---------------------------------------------------------------------------
# Geography hierarchy
# ---------------------------------------------------------------------------

class GeoZone(Base):
    """Nigeria's 6 geopolitical zones."""

    __tablename__ = "geo_zones"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    code: Mapped[str] = mapped_column(String(10), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    states: Mapped[List["GeoState"]] = relationship("GeoState", back_populates="zone")
    risk_scores: Mapped[List["ZoneRiskScore"]] = relationship(
        "ZoneRiskScore", back_populates="zone"
    )

    __table_args__ = (
        Index("ix_geo_zones_code", "code"),
    )

    def __repr__(self) -> str:
        return f"<GeoZone id={self.id} name={self.name!r}>"


class GeoState(Base):
    """Nigeria's 36 states + FCT."""

    __tablename__ = "geo_states"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=True)
    zone_id: Mapped[int] = mapped_column(
        SmallInteger, ForeignKey("geo_zones.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    code: Mapped[str] = mapped_column(String(5), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    zone: Mapped["GeoZone"] = relationship("GeoZone", back_populates="states")
    lgas: Mapped[List["GeoLGA"]] = relationship("GeoLGA", back_populates="state")

    __table_args__ = (
        Index("ix_geo_states_code", "code"),
        Index("ix_geo_states_zone_id", "zone_id"),
    )

    def __repr__(self) -> str:
        return f"<GeoState id={self.id} name={self.name!r}>"


class GeoLGA(Base):
    """Local Government Areas (~774 LGAs)."""

    __tablename__ = "geo_lgas"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_id: Mapped[int] = mapped_column(
        SmallInteger, ForeignKey("geo_states.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    state: Mapped["GeoState"] = relationship("GeoState", back_populates="lgas")
    wards: Mapped[List["GeoWard"]] = relationship("GeoWard", back_populates="lga")

    __table_args__ = (
        UniqueConstraint("state_id", "name", name="uq_geo_lgas_state_name"),
        Index("ix_geo_lgas_state_id", "state_id"),
    )

    def __repr__(self) -> str:
        return f"<GeoLGA id={self.id} name={self.name!r}>"


class GeoWard(Base):
    """Electoral wards (~8,809 wards)."""

    __tablename__ = "geo_wards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    lga_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("geo_lgas.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    lga: Mapped["GeoLGA"] = relationship("GeoLGA", back_populates="wards")

    __table_args__ = (
        UniqueConstraint("lga_id", "name", name="uq_geo_wards_lga_name"),
        Index("ix_geo_wards_lga_id", "lga_id"),
    )

    def __repr__(self) -> str:
        return f"<GeoWard id={self.id} name={self.name!r}>"


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

class AppUser(Base):
    """Platform users — reporters, analysts, API partners."""

    __tablename__ = "app_users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[Optional[str]] = mapped_column(String(254), nullable=True, unique=True)
    password_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    display_name: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    user_role: Mapped[UserRoleEnum] = mapped_column(
        Enum(UserRoleEnum, name="user_role_enum"), nullable=False,
        default=UserRoleEnum.public_reporter
    )
    account_status: Mapped[AccountStatusEnum] = mapped_column(
        Enum(AccountStatusEnum, name="account_status_enum"), nullable=False,
        default=AccountStatusEnum.pending_approval
    )
    is_email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    verifications: Mapped[List["AlertVerification"]] = relationship(
        "AlertVerification", back_populates="warden"
    )

    __table_args__ = (
        Index("ix_app_users_email", "email"),
        Index("ix_app_users_role_status", "user_role", "account_status"),
    )

    def __repr__(self) -> str:
        return f"<AppUser id={self.id} role={self.user_role.value!r}>"


# ---------------------------------------------------------------------------
# PII Vault
# ---------------------------------------------------------------------------

class ReporterPIIVault(Base):
    """
    Encrypted PII store — decoupled from ConflictAlert via anon_token.
    Access requires separate key management authorisation.
    """

    __tablename__ = "reporter_pii_vault"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    anon_token: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, unique=True, default=uuid.uuid4,
        index=True, comment="Pseudonymous FK referenced by ConflictAlert"
    )
    phone_number_enc: Mapped[Optional[bytes]] = mapped_column(
        LargeBinary, nullable=True, comment="AES-256-GCM encrypted E.164 phone number"
    )
    ip_address_enc: Mapped[Optional[bytes]] = mapped_column(
        LargeBinary, nullable=True, comment="AES-256-GCM encrypted IPv4/IPv6 string"
    )
    phone_hash: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True, index=True,
        comment="HMAC-SHA256 hex digest for deduplication"
    )
    ip_subnet_hash: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True, index=True,
        comment="HMAC-SHA256 of /24 (IPv4) or /48 (IPv6) for flood detection"
    )
    submission_channel: Mapped[str] = mapped_column(
        String(30), nullable=False, default="web"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    alerts: Mapped[List["ConflictAlert"]] = relationship(
        "ConflictAlert", back_populates="pii_vault_entry",
        foreign_keys="ConflictAlert.anon_token"
    )

    def __repr__(self) -> str:
        return f"<ReporterPIIVault anon_token={self.anon_token}>"


# ---------------------------------------------------------------------------
# Conflict Alerts
# ---------------------------------------------------------------------------

class ConflictAlert(Base):
    """Core conflict report — the heart of the CEWS pipeline."""

    __tablename__ = "conflict_alerts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Geography FK cascade
    zone_id: Mapped[Optional[int]] = mapped_column(
        SmallInteger, ForeignKey("geo_zones.id", ondelete="SET NULL"), nullable=True
    )
    state_id: Mapped[Optional[int]] = mapped_column(
        SmallInteger, ForeignKey("geo_states.id", ondelete="SET NULL"), nullable=True
    )
    lga_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("geo_lgas.id", ondelete="SET NULL"), nullable=True
    )
    ward_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("geo_wards.id", ondelete="SET NULL"), nullable=True
    )
    # Spatial point (WGS-84)
    geom: Mapped[Optional[object]] = mapped_column(
        Geometry("POINT", srid=4326), nullable=True
    )
    # Taxonomy
    alert_type: Mapped[AlertTypeEnum] = mapped_column(
        Enum(AlertTypeEnum, name="alert_type_enum"), nullable=False
    )
    risk_level: Mapped[RiskLevelEnum] = mapped_column(
        Enum(RiskLevelEnum, name="risk_level_enum"), nullable=False,
        default=RiskLevelEnum.low
    )
    verification_status: Mapped[VerificationStatusEnum] = mapped_column(
        Enum(VerificationStatusEnum, name="verification_status_enum"),
        nullable=False, default=VerificationStatusEnum.pending
    )
    # Content
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    estimated_casualties: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # PII linkage (pseudonymous)
    anon_token: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("reporter_pii_vault.anon_token", ondelete="SET NULL"),
        nullable=True, index=True
    )
    # ML / heuristic enrichment
    zone_indicators: Mapped[Optional[dict]] = mapped_column(
        JSON, nullable=True,
        comment="Structured contextual indicators (e.g. market day, election proximity)"
    )
    behavioral_trigger_flags: Mapped[Optional[dict]] = mapped_column(
        JSON, nullable=True,
        comment="Flood-detection, bot-score, duplicate-score flags"
    )
    ml_risk_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 4), nullable=True)
    # Source tracking (non-PII)
    submission_channel: Mapped[str] = mapped_column(
        String(30), nullable=False, default="web"
    )
    source_reference: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # Timestamps
    incident_datetime: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    published_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    pii_vault_entry: Mapped[Optional["ReporterPIIVault"]] = relationship(
        "ReporterPIIVault", back_populates="alerts",
        foreign_keys=[anon_token]
    )
    zone: Mapped[Optional["GeoZone"]] = relationship("GeoZone")
    state: Mapped[Optional["GeoState"]] = relationship("GeoState")
    lga: Mapped[Optional["GeoLGA"]] = relationship("GeoLGA")
    ward: Mapped[Optional["GeoWard"]] = relationship("GeoWard")
    verifications: Mapped[List["AlertVerification"]] = relationship(
        "AlertVerification", back_populates="alert", cascade="all, delete-orphan"
    )
    media_evidence: Mapped[List["AlertMediaEvidence"]] = relationship(
        "AlertMediaEvidence", back_populates="alert", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_conflict_alerts_state_status", "state_id", "verification_status"),
        Index("ix_conflict_alerts_type_risk", "alert_type", "risk_level"),
        Index("ix_conflict_alerts_created_at", "created_at"),
        Index("ix_conflict_alerts_anon_token", "anon_token"),
        Index(
            "ix_conflict_alerts_geom_gist", "geom",
            postgresql_using="gist"
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<ConflictAlert id={self.id} type={self.alert_type.value!r} "
            f"risk={self.risk_level.value!r}>"
        )


# ---------------------------------------------------------------------------
# Alert Verification (Warden Voting)
# ---------------------------------------------------------------------------

class AlertVerification(Base):
    """Warden / analyst vote on a ConflictAlert."""

    __tablename__ = "alert_verifications"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    alert_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conflict_alerts.id", ondelete="CASCADE"),
        nullable=False
    )
    warden_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_users.id", ondelete="CASCADE"),
        nullable=False
    )
    vote: Mapped[WardenVoteEnum] = mapped_column(
        Enum(WardenVoteEnum, name="warden_vote_enum"), nullable=False
    )
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    voted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    alert: Mapped["ConflictAlert"] = relationship(
        "ConflictAlert", back_populates="verifications"
    )
    warden: Mapped["AppUser"] = relationship("AppUser", back_populates="verifications")

    __table_args__ = (
        UniqueConstraint("alert_id", "warden_id", name="uq_alert_verifications_alert_warden"),
        Index("ix_alert_verifications_alert_id", "alert_id"),
        Index("ix_alert_verifications_warden_id", "warden_id"),
    )

    def __repr__(self) -> str:
        return (
            f"<AlertVerification id={self.id} alert={self.alert_id} "
            f"vote={self.vote.value!r}>"
        )


# ---------------------------------------------------------------------------
# Zone Risk Score
# ---------------------------------------------------------------------------

class ZoneRiskScore(Base):
    """Time-series risk score per geopolitical zone, recomputed by Celery."""

    __tablename__ = "zone_risk_scores"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    zone_id: Mapped[int] = mapped_column(
        SmallInteger, ForeignKey("geo_zones.id", ondelete="CASCADE"), nullable=False
    )
    score: Mapped[float] = mapped_column(Numeric(6, 4), nullable=False)
    component_scores: Mapped[Optional[dict]] = mapped_column(
        JSON, nullable=True,
        comment="Breakdown: frequency, severity, geographic_spread, etc."
    )
    alert_window_days: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=7
    )
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    zone: Mapped["GeoZone"] = relationship("GeoZone", back_populates="risk_scores")

    __table_args__ = (
        Index("ix_zone_risk_scores_zone_computed", "zone_id", "computed_at"),
    )

    def __repr__(self) -> str:
        return f"<ZoneRiskScore zone={self.zone_id} score={self.score}>"


# ---------------------------------------------------------------------------
# Alert Media Evidence
# ---------------------------------------------------------------------------

class AlertMediaEvidence(Base):
    """Photo/video/audio evidence attached to an alert (stored in object storage)."""

    __tablename__ = "alert_media_evidence"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    alert_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conflict_alerts.id", ondelete="CASCADE"),
        nullable=False
    )
    storage_key: Mapped[str] = mapped_column(
        String(512), nullable=False,
        comment="S3/GCS object key — never a public URL"
    )
    media_type: Mapped[str] = mapped_column(
        String(50), nullable=False, comment="MIME type e.g. image/jpeg"
    )
    file_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    sha256_checksum: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    is_sensitive: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    alert: Mapped["ConflictAlert"] = relationship(
        "ConflictAlert", back_populates="media_evidence"
    )

    __table_args__ = (
        Index("ix_alert_media_evidence_alert_id", "alert_id"),
    )

    def __repr__(self) -> str:
        return f"<AlertMediaEvidence id={self.id} alert={self.alert_id}>"


# ---------------------------------------------------------------------------
# System Audit Log
# ---------------------------------------------------------------------------

class SystemAuditLog(Base):
    """
    Immutable audit trail for all state-changing operations.
    Rows are never updated or deleted (append-only).
    """

    __tablename__ = "system_audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    actor_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), nullable=True,
        comment="AppUser UUID; NULL for system/Celery actions"
    )
    action: Mapped[str] = mapped_column(
        String(120), nullable=False,
        comment="Dot-namespaced verb, e.g. alert.status.changed"
    )
    resource_type: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    resource_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    before_state: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    after_state: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    ip_address: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    __table_args__ = (
        Index("ix_audit_logs_actor_id", "actor_id"),
        Index("ix_audit_logs_action", "action"),
        Index("ix_audit_logs_resource", "resource_type", "resource_id"),
    )

    def __repr__(self) -> str:
        return f"<SystemAuditLog id={self.id} action={self.action!r}>"
