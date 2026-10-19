"""
Nigeria CEWS - Ingestion API Router (v1)
=========================================
Handles multi-channel alert submissions:
  - POST /api/v1/ingest/web        — browser / mobile web form
  - POST /api/v1/ingest/ussd       — Africa's Talking USSD webhook
  - POST /api/v1/ingest/sms        — Africa's Talking / Twilio SMS webhook

All endpoints:
  1. Verify HMAC-SHA256 request signature (except web which uses bearer auth).
  2. Validate and sanitise input via Pydantic.
  3. Extract and vault PII asynchronously.
  4. Enqueue a Celery task for ML enrichment and warden assignment.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import uuid
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

try:
    from models.database import (
        AlertTypeEnum,
        ConflictAlert,
        RiskLevelEnum,
        SubmissionChannelEnum,
        VerificationStatusEnum,
    )
    from services.pii_handler import create_pii_vault_entry
except ImportError:
    from backend.models.database import (
        AlertTypeEnum,
        ConflictAlert,
        RiskLevelEnum,
        SubmissionChannelEnum,
        VerificationStatusEnum,
    )
    from backend.services.pii_handler import create_pii_vault_entry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/ingest", tags=["Ingestion"])

# ---------------------------------------------------------------------------
# Environment-driven secrets (loaded once at module import)
# ---------------------------------------------------------------------------

_WEBHOOK_HMAC_SECRET: bytes = os.environ.get("CEWS_WEBHOOK_HMAC_SECRET", "").encode("utf-8")
_USSD_AT_API_KEY: str = os.environ.get("AFRICAS_TALKING_API_KEY", "")
_SMS_AT_USERNAME: str = os.environ.get("AFRICAS_TALKING_USERNAME", "")


# ---------------------------------------------------------------------------
# DB Session dependency  (wire up your async engine in main.py / lifespan)
# ---------------------------------------------------------------------------

async def get_db() -> AsyncSession:  # pragma: no cover
    """
    Dependency that provides a SQLAlchemy async session per request.
    Override this in tests or replace with your lifespan-managed sessionmaker.
    """
    raise NotImplementedError(
        "get_db() must be overridden with a real AsyncSession factory. "
        "Example: use 'app.dependency_overrides[get_db] = your_session_factory'."
    )


# ---------------------------------------------------------------------------
# HMAC signature verification dependency
# ---------------------------------------------------------------------------

def _constant_time_compare(a: str, b: str) -> bool:
    """Timing-safe string comparison."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


async def verify_webhook_hmac(
    request: Request,
    x_cews_signature: Annotated[Optional[str], Header(alias="X-CEWS-Signature")] = None,
) -> None:
    """
    FastAPI dependency — validates HMAC-SHA256 signature on incoming webhook.

    The sender must include:
        X-CEWS-Signature: sha256=<hex_digest>

    Computed over the raw request body using CEWS_WEBHOOK_HMAC_SECRET.

    Raises:
        HTTP 401 if the header is missing.
        HTTP 403 if the signature does not match.
        HTTP 500 if CEWS_WEBHOOK_HMAC_SECRET is not configured.
    """
    if not _WEBHOOK_HMAC_SECRET:
        logger.critical(
            "CEWS_WEBHOOK_HMAC_SECRET is not set — webhook verification is disabled!"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server misconfiguration: webhook secret is not configured.",
        )

    if x_cews_signature is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-CEWS-Signature header.",
        )

    raw_body: bytes = await request.body()
    expected_hex = hmac.new(
        _WEBHOOK_HMAC_SECRET, raw_body, hashlib.sha256
    ).hexdigest()
    expected_header = f"sha256={expected_hex}"

    if not _constant_time_compare(x_cews_signature, expected_header):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Webhook signature verification failed.",
        )


HMACVerified = Annotated[None, Depends(verify_webhook_hmac)]


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------

class GeoCoordinates(BaseModel):
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)


class WebFormSubmission(BaseModel):
    """
    Payload for POST /api/v1/ingest/web.
    Submitted by authenticated or anonymous browser/mobile users.
    """
    alert_type: AlertTypeEnum
    description: str = Field(..., min_length=10, max_length=3000)
    state_code: Optional[str] = Field(None, max_length=5, description="ISO state code e.g. 'LA'")
    lga_name: Optional[str] = Field(None, max_length=100)
    ward_name: Optional[str] = Field(None, max_length=120)
    coordinates: Optional[GeoCoordinates] = None
    incident_datetime: Optional[datetime] = None
    estimated_casualties: Optional[int] = Field(None, ge=0, le=100_000)
    phone_e164: Optional[str] = Field(
        None,
        pattern=r"^\+[1-9]\d{6,14}$",
        description="Reporter phone in E.164 format — stored encrypted",
    )
    consent_given: bool = Field(
        ..., description="Reporter must explicitly consent to data processing"
    )

    @field_validator("description")
    @classmethod
    def strip_description(cls, v: str) -> str:
        return v.strip()

    @model_validator(mode="after")
    def check_consent(self) -> "WebFormSubmission":
        if not self.consent_given:
            raise ValueError("Data processing consent is required to submit a report.")
        return self


class USSDWebhookPayload(BaseModel):
    """
    Africa's Talking USSD webhook POST body.
    https://developers.africastalking.com/docs/ussd/callback
    """
    sessionId: str = Field(..., max_length=64)
    serviceCode: str = Field(..., max_length=20)
    phoneNumber: str = Field(..., max_length=20)
    text: str = Field("", max_length=2048, description="Concatenated USSD session input")
    networkCode: Optional[str] = Field(None, max_length=10)


class SMSWebhookPayload(BaseModel):
    """
    Africa's Talking / Twilio SMS incoming message webhook.
    Field names follow Africa's Talking conventions.
    """
    from_: str = Field(..., alias="from", max_length=20)
    to: str = Field(..., max_length=20)
    text: str = Field(..., max_length=1600)
    linkId: Optional[str] = Field(None, max_length=64)
    date: Optional[str] = Field(None, max_length=30)
    id: Optional[str] = Field(None, max_length=64, description="Provider message ID")
    networkCode: Optional[str] = Field(None, max_length=10)

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _get_client_ip(request: Request) -> Optional[str]:
    """Extract real client IP, respecting X-Forwarded-For behind a load balancer."""
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        # Take the first (leftmost) IP which is the originating client
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else None


async def _enqueue_web_report(alert_id: uuid.UUID) -> None:
    """Fire-and-forget Celery task for web report processing."""
    from backend.tasks.celery_app import process_web_report
    process_web_report.apply_async(
        args=[str(alert_id)],
        queue="high_priority",
        countdown=0,
    )


async def _enqueue_ussd_report(alert_id: uuid.UUID) -> None:
    """Fire-and-forget Celery task for USSD report processing."""
    from backend.tasks.celery_app import process_ussd_report
    process_ussd_report.apply_async(
        args=[str(alert_id)],
        queue="high_priority",
        countdown=0,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post(
    "/web",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit a conflict alert via the web form",
    response_description="Report accepted for processing",
)
async def ingest_web(
    payload: WebFormSubmission,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Accept a structured conflict report from the web or mobile app.

    - PII (phone, IP) is immediately encrypted and stored in a separate vault.
    - Only the pseudonymous ``anon_token`` is attached to the alert record.
    - The alert is enqueued for ML enrichment and warden assignment.
    """
    client_ip = _get_client_ip(request)

    async with db.begin():
        anon_token: uuid.UUID = await create_pii_vault_entry(
            phone=payload.phone_e164,
            ip=client_ip,
            channel=SubmissionChannelEnum.web.value,
            db_session=db,
        )

        geom = None
        if payload.coordinates:
            # WKT POINT for GeoAlchemy2
            geom = f"SRID=4326;POINT({payload.coordinates.longitude} {payload.coordinates.latitude})"

        alert = ConflictAlert(
            alert_type=payload.alert_type,
            description=payload.description,
            incident_datetime=payload.incident_datetime,
            estimated_casualties=payload.estimated_casualties,
            risk_level=RiskLevelEnum.low,  # Celery task will update after ML scoring
            verification_status=VerificationStatusEnum.pending,
            submission_channel=SubmissionChannelEnum.web.value,
            anon_token=anon_token,
            geom=geom,
        )
        db.add(alert)
        await db.flush()
        alert_id = alert.id

    await _enqueue_web_report(alert_id)

    logger.info("Web report accepted", extra={"alert_id": str(alert_id)})
    return {
        "status": "accepted",
        "reference": str(alert_id),
        "message": "Your report has been received. Thank you for helping keep communities safe.",
    }


@router.post(
    "/ussd",
    status_code=status.HTTP_200_OK,
    summary="Africa's Talking USSD webhook",
    dependencies=[Depends(verify_webhook_hmac)],
)
async def ingest_ussd(
    payload: USSDWebhookPayload,
    request: Request,
    _: HMACVerified,
    db: AsyncSession = Depends(get_db),
) -> str:
    """
    Receive USSD session data from Africa's Talking.

    The USSD session flow is menu-driven; the concatenated ``text`` field
    encodes the reporter's choices (e.g. ``"1*2*4526"`` for alert_type*state*lga).

    Returns a plain-text response consumed by the AT gateway:
      - ``CON <prompt>``  to continue the session
      - ``END <message>`` to close the session
    """
    steps = [s.strip() for s in payload.text.split("*") if s.strip()]
    num_steps = len(steps)

    # Step 0 — initial USSD dial-in → present main menu
    if num_steps == 0:
        return (
            "CON Welcome to CEWS Nigeria.\n"
            "Report a security incident:\n"
            "1. Armed clash\n"
            "2. Protest/Riot\n"
            "3. Kidnapping\n"
            "4. Banditry\n"
            "5. Other\n"
            "0. Exit"
        )

    alert_type_map = {
        "1": AlertTypeEnum.armed_clash,
        "2": AlertTypeEnum.protest_riot,
        "3": AlertTypeEnum.kidnapping_abduction,
        "4": AlertTypeEnum.banditry,
        "5": AlertTypeEnum.other,
        "0": None,
    }

    choice = steps[0]

    if choice == "0":
        return "END Thank you. Stay safe."

    if choice not in alert_type_map:
        return "END Invalid selection. Please dial again."

    # Step 1 — alert type selected → ask for LGA code
    if num_steps == 1:
        return "CON Enter your 4-digit LGA code\n(e.g. 2517 for Surulere, Lagos):"

    # Step 2 — LGA code entered → confirm and submit
    if num_steps == 2:
        lga_code = steps[1]
        return (
            f"CON Confirm report:\n"
            f"Type: {alert_type_map[choice].value.replace('_', ' ').title()}\n"
            f"LGA code: {lga_code}\n"
            "1. Confirm\n"
            "2. Cancel"
        )

    # Step 3 — confirmation
    if num_steps == 3:
        confirmation = steps[2]
        if confirmation == "2":
            return "END Report cancelled."

        if confirmation != "1":
            return "END Invalid input. Please dial again."

        # Persist and enqueue
        client_ip = _get_client_ip(request)
        alert_type = alert_type_map[choice]

        async with db.begin():
            anon_token = await create_pii_vault_entry(
                phone=payload.phoneNumber,
                ip=client_ip,
                channel=SubmissionChannelEnum.ussd.value,
                db_session=db,
            )
            alert = ConflictAlert(
                alert_type=alert_type,
                description=f"USSD report via session {payload.sessionId}. LGA code: {steps[1]}",
                risk_level=RiskLevelEnum.low,
                verification_status=VerificationStatusEnum.pending,
                submission_channel=SubmissionChannelEnum.ussd.value,
                anon_token=anon_token,
                source_reference=payload.sessionId,
            )
            db.add(alert)
            await db.flush()
            alert_id = alert.id

        await _enqueue_ussd_report(alert_id)
        logger.info("USSD report accepted", extra={"alert_id": str(alert_id)})
        return f"END Report submitted. Reference: {str(alert_id)[:8].upper()}. Thank you."

    return "END Session error. Please try again."


@router.post(
    "/sms",
    status_code=status.HTTP_200_OK,
    summary="Incoming SMS webhook (Africa's Talking / Twilio)",
    dependencies=[Depends(verify_webhook_hmac)],
)
async def ingest_sms(
    payload: SMSWebhookPayload,
    request: Request,
    _: HMACVerified,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Accept incoming SMS reports.

    Expected SMS format (case-insensitive):
        ``CEWS <ALERT_TYPE_CODE> <free text description>``

    Example:
        ``CEWS BANDIT Armed men on motorcycles attacked market at Gusau``

    Unknown formats are logged and discarded (no error reply — prevents info leakage).
    """
    raw_text = payload.text.strip()
    upper_text = raw_text.upper()

    sms_keyword_map: dict[str, AlertTypeEnum] = {
        "ARMED": AlertTypeEnum.armed_clash,
        "CLASH": AlertTypeEnum.armed_clash,
        "PROTEST": AlertTypeEnum.protest_riot,
        "RIOT": AlertTypeEnum.protest_riot,
        "KIDNAP": AlertTypeEnum.kidnapping_abduction,
        "ABDUCT": AlertTypeEnum.kidnapping_abduction,
        "BANDIT": AlertTypeEnum.banditry,
        "FARMER": AlertTypeEnum.farmer_herder,
        "HERDER": AlertTypeEnum.farmer_herder,
        "CULT": AlertTypeEnum.cult_gang_violence,
        "GANG": AlertTypeEnum.cult_gang_violence,
        "ELECT": AlertTypeEnum.election_violence,
        "POLICE": AlertTypeEnum.police_military_abuse,
        "COMMUNAL": AlertTypeEnum.communal_dispute,
        "IED": AlertTypeEnum.ieds_unexploded,
        "BOMB": AlertTypeEnum.ieds_unexploded,
        "GBV": AlertTypeEnum.sexual_gbv,
        "DISPLACE": AlertTypeEnum.displacement_movement,
        "INFRA": AlertTypeEnum.infrastructure_attack,
        "CYBER": AlertTypeEnum.cyber_disinformation,
        "REPORT": AlertTypeEnum.other,
        "CEWS": AlertTypeEnum.other,
    }

    if not upper_text.startswith("CEWS"):
        logger.warning(
            "SMS ignored — does not start with CEWS keyword",
            extra={"from": payload.from_, "text_snippet": raw_text[:50]},
        )
        return {"status": "ignored", "reason": "Keyword not recognised"}

    detected_type = AlertTypeEnum.other
    words = upper_text.split()
    for word in words[1:]:
        if word in sms_keyword_map:
            detected_type = sms_keyword_map[word]
            break

    # Use everything after "CEWS <KEYWORD>" as description
    description_parts = raw_text.split(None, 2)
    description = description_parts[2] if len(description_parts) >= 3 else raw_text

    client_ip = _get_client_ip(request)

    async with db.begin():
        anon_token = await create_pii_vault_entry(
            phone=payload.from_,
            ip=client_ip,
            channel=SubmissionChannelEnum.sms.value,
            db_session=db,
        )
        alert = ConflictAlert(
            alert_type=detected_type,
            description=description[:3000],
            risk_level=RiskLevelEnum.low,
            verification_status=VerificationStatusEnum.pending,
            submission_channel=SubmissionChannelEnum.sms.value,
            anon_token=anon_token,
            source_reference=payload.id,
        )
        db.add(alert)
        await db.flush()
        alert_id = alert.id

    # Re-use the general process_web_report task for SMS (same ML pipeline)
    from backend.tasks.celery_app import process_web_report
    process_web_report.apply_async(
        args=[str(alert_id)],
        queue="high_priority",
        countdown=0,
    )

    logger.info("SMS report accepted", extra={"alert_id": str(alert_id)})
    return {"status": "accepted", "reference": str(alert_id)}
