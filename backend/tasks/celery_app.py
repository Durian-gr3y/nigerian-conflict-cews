"""
Nigeria CEWS - Celery Application & Task Definitions
=====================================================
Defines the Celery app with 5 priority queues and all processing tasks:
  - process_ussd_report        : USSD session → geo-resolve, ML score
  - process_web_report         : Web/SMS report → ML enrichment pipeline
  - assign_wardens_to_alert    : Select and notify wardens for manual verification
  - compute_zone_risk_score    : Recompute rolling risk score for a geo zone
  - detect_coordinated_flood   : Identify suspicious coordinated submission patterns

Environment variables required
-------------------------------
CELERY_BROKER_URL     : Redis or RabbitMQ broker URL
                        e.g. redis://:password@localhost:6379/0
CELERY_RESULT_BACKEND : Redis result backend URL
                        e.g. redis://:password@localhost:6379/1
DATABASE_URL          : Async-compatible PostgreSQL DSN
                        e.g. postgresql+asyncpg://user:pass@host/dbname
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from celery import Celery, Task
from celery.utils.log import get_task_logger
from kombu import Exchange, Queue
from tenacity import (
    after_log,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

logger = get_task_logger(__name__)

# ---------------------------------------------------------------------------
# Broker / backend configuration
# ---------------------------------------------------------------------------

CELERY_BROKER_URL: str = os.environ.get(
    "CELERY_BROKER_URL", "redis://localhost:6379/0"
)
CELERY_RESULT_BACKEND: str = os.environ.get(
    "CELERY_RESULT_BACKEND", "redis://localhost:6379/1"
)

# ---------------------------------------------------------------------------
# Queue definitions — 5 priority levels
# ---------------------------------------------------------------------------

QUEUE_HIGH_PRIORITY = "high_priority"
QUEUE_NORMAL = "normal"
QUEUE_ML_ENRICHMENT = "ml_enrichment"
QUEUE_WARDEN_ASSIGNMENT = "warden_assignment"
QUEUE_ANALYTICS = "analytics"

_default_exchange = Exchange("cews", type="direct")

TASK_QUEUES: tuple[Queue, ...] = (
    Queue(QUEUE_HIGH_PRIORITY,    _default_exchange, routing_key=QUEUE_HIGH_PRIORITY),
    Queue(QUEUE_NORMAL,           _default_exchange, routing_key=QUEUE_NORMAL),
    Queue(QUEUE_ML_ENRICHMENT,    _default_exchange, routing_key=QUEUE_ML_ENRICHMENT),
    Queue(QUEUE_WARDEN_ASSIGNMENT, _default_exchange, routing_key=QUEUE_WARDEN_ASSIGNMENT),
    Queue(QUEUE_ANALYTICS,        _default_exchange, routing_key=QUEUE_ANALYTICS),
)

# ---------------------------------------------------------------------------
# Celery application
# ---------------------------------------------------------------------------

celery_app = Celery(
    "cews",
    broker=CELERY_BROKER_URL,
    backend=CELERY_RESULT_BACKEND,
    include=["tasks.celery_app"],
)

celery_app.conf.update(
    # Queues
    task_queues=TASK_QUEUES,
    task_default_queue=QUEUE_NORMAL,
    task_default_exchange=_default_exchange.name,
    task_default_routing_key=QUEUE_NORMAL,
    # Serialisation
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # Timezone
    timezone="Africa/Lagos",
    enable_utc=True,
    # Reliability
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,  # fair dispatch
    # Result expiry
    result_expires=timedelta(days=7),
    # Beat schedule (optional analytics roll-up)
    beat_schedule={
        "recompute-all-zone-scores-hourly": {
            "task": "backend.tasks.celery_app.compute_zone_risk_score",
            "schedule": timedelta(hours=1),
            "args": [None],          # None triggers all-zones mode
            "options": {"queue": QUEUE_ANALYTICS},
        },
        "flood-detection-every-15min": {
            "task": "backend.tasks.celery_app.detect_coordinated_flood",
            "schedule": timedelta(minutes=15),
            "args": [],
            "options": {"queue": QUEUE_ANALYTICS},
        },
    },
)

# ---------------------------------------------------------------------------
# Base task class with structured error logging
# ---------------------------------------------------------------------------


class CEWSBaseTask(Task):
    """Base task that logs failures to the audit log."""

    abstract = True

    def on_failure(
        self,
        exc: Exception,
        task_id: str,
        args: tuple,
        kwargs: dict,
        einfo: Any,
    ) -> None:
        logger.error(
            "Task %s [%s] failed: %s",
            self.name,
            task_id,
            str(exc),
            exc_info=True,
        )
        super().on_failure(exc, task_id, args, kwargs, einfo)


# ---------------------------------------------------------------------------
# Database session helper (sync wrapper for Celery tasks)
# ---------------------------------------------------------------------------

def _get_sync_db_session():
    """
    Create a synchronous SQLAlchemy session for use inside Celery tasks.

    Celery workers are not async; use the sync psycopg2-backed engine here.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    db_url = os.environ.get("DATABASE_URL", "").replace("+asyncpg", "")
    if not db_url:
        raise EnvironmentError("DATABASE_URL environment variable is not set.")

    engine = create_engine(db_url, pool_pre_ping=True, pool_size=5, max_overflow=10)
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    return SessionLocal()


# ---------------------------------------------------------------------------
# Tenacity retry policy (reusable decorator factory)
# ---------------------------------------------------------------------------

def _db_retry():
    """Return a Tenacity retry decorator suitable for DB-hitting tasks."""
    from sqlalchemy.exc import OperationalError

    return retry(
        retry=retry_if_exception_type((OperationalError, ConnectionError)),
        wait=wait_exponential(multiplier=1, min=2, max=60),
        stop=stop_after_attempt(5),
        after=after_log(logger, logging.WARNING),
        reraise=True,
    )


# ---------------------------------------------------------------------------
# Task: process_ussd_report
# ---------------------------------------------------------------------------

@celery_app.task(
    bind=True,
    base=CEWSBaseTask,
    name="backend.tasks.celery_app.process_ussd_report",
    queue=QUEUE_HIGH_PRIORITY,
    max_retries=5,
    default_retry_delay=10,
    soft_time_limit=120,
    time_limit=180,
)
def process_ussd_report(self: Task, alert_id_str: str) -> dict:
    """
    Process a USSD-submitted conflict alert.

    Steps:
      1. Load the alert from the database.
      2. Resolve LGA code → GeoLGA FK (if embedded in description).
      3. Assign a basic heuristic risk score.
      4. Persist updates and trigger warden assignment.
    """

    @_db_retry()
    def _run() -> dict:
        from sqlalchemy import select
        from models.database import ConflictAlert, RiskLevelEnum, VerificationStatusEnum

        alert_id = uuid.UUID(alert_id_str)
        db = _get_sync_db_session()
        try:
            alert: Optional[ConflictAlert] = db.execute(
                select(ConflictAlert).where(ConflictAlert.id == alert_id)
            ).scalar_one_or_none()

            if alert is None:
                logger.warning("process_ussd_report: alert %s not found", alert_id_str)
                return {"status": "not_found", "alert_id": alert_id_str}

            # --- Heuristic risk scoring (placeholder for ML model call) ---
            heuristic_score = _compute_heuristic_risk(alert)
            alert.ml_risk_score = heuristic_score
            alert.risk_level = _score_to_risk_level(heuristic_score)

            # Mark as auto-verified if score threshold is met
            if heuristic_score >= 0.7:
                alert.verification_status = VerificationStatusEnum.auto_verified
            
            alert.behavioral_trigger_flags = {
                "source": "ussd",
                "heuristic_score": heuristic_score,
                "processed_at": datetime.now(tz=timezone.utc).isoformat(),
            }

            db.commit()
            logger.info("USSD alert processed: %s → risk=%s", alert_id_str, alert.risk_level.value)

            # Trigger warden assignment
            assign_wardens_to_alert.apply_async(
                args=[alert_id_str],
                queue=QUEUE_WARDEN_ASSIGNMENT,
            )

            return {
                "status": "processed",
                "alert_id": alert_id_str,
                "risk_level": alert.risk_level.value,
                "ml_risk_score": float(heuristic_score),
            }
        except Exception as exc:
            db.rollback()
            raise
        finally:
            db.close()

    try:
        return _run()
    except Exception as exc:
        raise self.retry(exc=exc)


# ---------------------------------------------------------------------------
# Task: process_web_report
# ---------------------------------------------------------------------------

@celery_app.task(
    bind=True,
    base=CEWSBaseTask,
    name="backend.tasks.celery_app.process_web_report",
    queue=QUEUE_HIGH_PRIORITY,
    max_retries=5,
    default_retry_delay=10,
    soft_time_limit=180,
    time_limit=240,
)
def process_web_report(self: Task, alert_id_str: str) -> dict:
    """
    Process a web-form or SMS-submitted conflict alert.

    Steps:
      1. Load alert from the database.
      2. Run ML risk scoring (stub; replace with model inference call).
      3. Check for duplicate signals via phone_hash.
      4. Update risk level and verification status.
      5. Enqueue warden assignment if risk >= medium.
      6. Enqueue flood detection check.
    """

    @_db_retry()
    def _run() -> dict:
        from sqlalchemy import select, func as sqlfunc
        from models.database import (
            ConflictAlert,
            ReporterPIIVault,
            RiskLevelEnum,
            VerificationStatusEnum,
        )

        alert_id = uuid.UUID(alert_id_str)
        db = _get_sync_db_session()
        try:
            alert: Optional[ConflictAlert] = db.execute(
                select(ConflictAlert).where(ConflictAlert.id == alert_id)
            ).scalar_one_or_none()

            if alert is None:
                logger.warning("process_web_report: alert %s not found", alert_id_str)
                return {"status": "not_found", "alert_id": alert_id_str}

            # --- Duplicate detection via phone_hash ---
            duplicate_count = 0
            if alert.anon_token:
                vault: Optional[ReporterPIIVault] = db.execute(
                    select(ReporterPIIVault).where(
                        ReporterPIIVault.anon_token == alert.anon_token
                    )
                ).scalar_one_or_none()

                if vault and vault.phone_hash:
                    recent_cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=24)
                    duplicate_count = db.execute(
                        select(sqlfunc.count(ReporterPIIVault.id))
                        .join(
                            ConflictAlert,
                            ConflictAlert.anon_token == ReporterPIIVault.anon_token
                        )
                        .where(
                            ReporterPIIVault.phone_hash == vault.phone_hash,
                            ConflictAlert.created_at >= recent_cutoff,
                            ConflictAlert.id != alert_id,
                        )
                    ).scalar() or 0

            # --- ML risk scoring (stub; replace with model inference) ---
            heuristic_score = _compute_heuristic_risk(alert)
            if duplicate_count > 3:
                heuristic_score = min(heuristic_score * 0.5, 0.3)  # penalise repeated reports

            alert.ml_risk_score = heuristic_score
            alert.risk_level = _score_to_risk_level(heuristic_score)
            alert.behavioral_trigger_flags = {
                "source": alert.submission_channel,
                "heuristic_score": heuristic_score,
                "duplicate_count_24h": duplicate_count,
                "processed_at": datetime.now(tz=timezone.utc).isoformat(),
            }

            if heuristic_score >= 0.8:
                alert.verification_status = VerificationStatusEnum.auto_verified

            db.commit()
            logger.info(
                "Web/SMS alert processed: %s → risk=%s score=%.4f dup=%d",
                alert_id_str, alert.risk_level.value, heuristic_score, duplicate_count,
            )

            # Trigger downstream tasks
            if alert.risk_level in (RiskLevelEnum.medium, RiskLevelEnum.high, RiskLevelEnum.critical):
                assign_wardens_to_alert.apply_async(
                    args=[alert_id_str],
                    queue=QUEUE_WARDEN_ASSIGNMENT,
                )

            detect_coordinated_flood.apply_async(queue=QUEUE_ANALYTICS)

            return {
                "status": "processed",
                "alert_id": alert_id_str,
                "risk_level": alert.risk_level.value,
                "ml_risk_score": float(heuristic_score),
                "duplicate_count_24h": duplicate_count,
            }
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    try:
        return _run()
    except Exception as exc:
        raise self.retry(exc=exc)


# ---------------------------------------------------------------------------
# Task: assign_wardens_to_alert
# ---------------------------------------------------------------------------

@celery_app.task(
    bind=True,
    base=CEWSBaseTask,
    name="backend.tasks.celery_app.assign_wardens_to_alert",
    queue=QUEUE_WARDEN_ASSIGNMENT,
    max_retries=3,
    default_retry_delay=30,
    soft_time_limit=60,
    time_limit=90,
)
def assign_wardens_to_alert(self: Task, alert_id_str: str) -> dict:
    """
    Select vetted wardens for a given alert and notify them.

    Selection criteria:
      - Role = 'vetted_monitor', status = 'active'
      - Same state as the alert (if state_id is set)
      - Fewest outstanding assignments (load balancing)

    Notification: sends a push/email notification (stub — integrate
    with your notification service here).
    """

    @_db_retry()
    def _run() -> dict:
        from sqlalchemy import select, func as sqlfunc, and_
        from models.database import (
            AccountStatusEnum,
            AlertVerification,
            AppUser,
            ConflictAlert,
            UserRoleEnum,
        )

        WARDENS_PER_ALERT = 3

        alert_id = uuid.UUID(alert_id_str)
        db = _get_sync_db_session()
        try:
            alert: Optional[ConflictAlert] = db.execute(
                select(ConflictAlert).where(ConflictAlert.id == alert_id)
            ).scalar_one_or_none()

            if alert is None:
                return {"status": "not_found", "alert_id": alert_id_str}

            # Count pending verifications per warden (load-balancing subquery)
            warden_load_sq = (
                select(
                    AlertVerification.warden_id,
                    sqlfunc.count(AlertVerification.id).label("load"),
                )
                .group_by(AlertVerification.warden_id)
                .subquery()
            )

            filters = [
                AppUser.user_role == UserRoleEnum.vetted_monitor,
                AppUser.account_status == AccountStatusEnum.active,
            ]

            wardens = db.execute(
                select(AppUser)
                .outerjoin(warden_load_sq, AppUser.id == warden_load_sq.c.warden_id)
                .where(and_(*filters))
                .order_by(
                    sqlfunc.coalesce(warden_load_sq.c.load, 0).asc()
                )
                .limit(WARDENS_PER_ALERT)
            ).scalars().all()

            if not wardens:
                logger.warning(
                    "assign_wardens_to_alert: no active wardens available for alert %s",
                    alert_id_str,
                )
                return {"status": "no_wardens", "alert_id": alert_id_str}

            assigned_ids = []
            for warden in wardens:
                # Check not already assigned
                existing = db.execute(
                    select(AlertVerification).where(
                        AlertVerification.alert_id == alert_id,
                        AlertVerification.warden_id == warden.id,
                    )
                ).scalar_one_or_none()

                if existing is None:
                    _notify_warden(warden, alert)
                    assigned_ids.append(str(warden.id))

            db.commit()
            logger.info(
                "Assigned %d wardens to alert %s", len(assigned_ids), alert_id_str
            )
            return {
                "status": "assigned",
                "alert_id": alert_id_str,
                "warden_ids": assigned_ids,
            }
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    try:
        return _run()
    except Exception as exc:
        raise self.retry(exc=exc)


def _notify_warden(warden: Any, alert: Any) -> None:
    """
    Send a notification to a warden about a new alert assignment.

    Stub implementation — integrate with your notification service
    (e.g. Firebase Cloud Messaging, SendGrid, Africa's Talking SMS).
    """
    logger.info(
        "NOTIFY warden=%s about alert=%s [%s]",
        warden.id,
        alert.id,
        alert.alert_type.value,
    )
    # TODO: call notification_service.send(warden=warden, alert=alert)


# ---------------------------------------------------------------------------
# Task: compute_zone_risk_score
# ---------------------------------------------------------------------------

@celery_app.task(
    bind=True,
    base=CEWSBaseTask,
    name="backend.tasks.celery_app.compute_zone_risk_score",
    queue=QUEUE_ANALYTICS,
    max_retries=3,
    default_retry_delay=60,
    soft_time_limit=300,
    time_limit=360,
)
def compute_zone_risk_score(self: Task, zone_id: Optional[int]) -> dict:
    """
    Compute and persist the rolling risk score for one or all zones.

    Args:
        zone_id: ID of the zone to update, or ``None`` to recompute all zones.

    Score formula (composite):
        score = 0.4 * frequency_score
              + 0.3 * severity_score
              + 0.2 * geographic_spread_score
              + 0.1 * recency_score

    All sub-scores are normalised to [0, 1].
    """

    @_db_retry()
    def _run() -> dict:
        from sqlalchemy import select, func as sqlfunc, and_
        from models.database import (
            ConflictAlert,
            GeoZone,
            RiskLevelEnum,
            VerificationStatusEnum,
            ZoneRiskScore,
        )

        WINDOW_DAYS = 7
        cutoff = datetime.now(tz=timezone.utc) - timedelta(days=WINDOW_DAYS)

        risk_weight = {
            RiskLevelEnum.low.value: 0.1,
            RiskLevelEnum.medium.value: 0.4,
            RiskLevelEnum.high.value: 0.75,
            RiskLevelEnum.critical.value: 1.0,
        }

        db = _get_sync_db_session()
        try:
            # Determine which zones to process
            if zone_id is not None:
                zone_ids = [zone_id]
            else:
                zone_ids = [
                    row[0]
                    for row in db.execute(select(GeoZone.id)).all()
                ]

            results = []
            for zid in zone_ids:
                alerts = db.execute(
                    select(ConflictAlert).where(
                        and_(
                            ConflictAlert.zone_id == zid,
                            ConflictAlert.created_at >= cutoff,
                            ConflictAlert.verification_status.in_([
                                VerificationStatusEnum.auto_verified.value,
                                VerificationStatusEnum.warden_verified.value,
                                VerificationStatusEnum.published.value,
                            ]),
                        )
                    )
                ).scalars().all()

                if not alerts:
                    composite = 0.0
                    component_scores = {
                        "frequency": 0.0,
                        "severity": 0.0,
                        "geographic_spread": 0.0,
                        "recency": 0.0,
                    }
                else:
                    # Frequency score (normalised against a reference maximum of 50/week)
                    frequency_score = min(len(alerts) / 50.0, 1.0)

                    # Severity score (weighted average of risk levels)
                    severity_score = sum(
                        risk_weight.get(a.risk_level.value, 0.0) for a in alerts
                    ) / len(alerts)

                    # Geographic spread (unique states involved)
                    unique_states = len({a.state_id for a in alerts if a.state_id})
                    geographic_spread_score = min(unique_states / 6.0, 1.0)

                    # Recency score (fraction of alerts in last 24h)
                    recent_cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=24)
                    recent_count = sum(
                        1 for a in alerts if a.created_at >= recent_cutoff
                    )
                    recency_score = min(recent_count / max(len(alerts), 1), 1.0)

                    composite = (
                        0.4 * frequency_score
                        + 0.3 * severity_score
                        + 0.2 * geographic_spread_score
                        + 0.1 * recency_score
                    )
                    component_scores = {
                        "frequency": round(frequency_score, 4),
                        "severity": round(severity_score, 4),
                        "geographic_spread": round(geographic_spread_score, 4),
                        "recency": round(recency_score, 4),
                    }

                score_row = ZoneRiskScore(
                    zone_id=zid,
                    score=round(composite, 4),
                    component_scores=component_scores,
                    alert_window_days=WINDOW_DAYS,
                )
                db.add(score_row)
                results.append({"zone_id": zid, "score": round(composite, 4)})

            db.commit()
            logger.info("Zone risk scores computed: %d zones", len(results))
            return {"status": "ok", "zones_updated": len(results), "results": results}
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    try:
        return _run()
    except Exception as exc:
        raise self.retry(exc=exc)


# ---------------------------------------------------------------------------
# Task: detect_coordinated_flood
# ---------------------------------------------------------------------------

@celery_app.task(
    bind=True,
    base=CEWSBaseTask,
    name="backend.tasks.celery_app.detect_coordinated_flood",
    queue=QUEUE_ANALYTICS,
    max_retries=3,
    default_retry_delay=60,
    soft_time_limit=180,
    time_limit=240,
)
def detect_coordinated_flood(self: Task) -> dict:
    """
    Identify suspicious coordinated submission patterns.

    Detection signals:
      1. **IP subnet flood**: > N reports from the same /24 (/48) subnet
         within 30 minutes.
      2. **Phone hash flood**: > M reports from the same phone within 1 hour.
      3. **Content similarity**: Future enhancement (NLP dedup).

    Flagged alerts have ``behavioral_trigger_flags.flood_suspect = True``
    set and ``verification_status`` demoted to ``pending`` for human review.

    Thresholds are intentionally conservative to minimise false positives
    in low-connectivity areas where one phone may relay many reports.
    """
    IP_FLOOD_THRESHOLD = 10    # reports from same subnet per 30 min
    PHONE_FLOOD_THRESHOLD = 5  # reports from same phone per 1 hour

    @_db_retry()
    def _run() -> dict:
        from sqlalchemy import select, func as sqlfunc, and_, text
        from models.database import (
            ConflictAlert,
            ReporterPIIVault,
            VerificationStatusEnum,
        )

        ip_window = datetime.now(tz=timezone.utc) - timedelta(minutes=30)
        phone_window = datetime.now(tz=timezone.utc) - timedelta(hours=1)

        db = _get_sync_db_session()
        try:
            flagged_alerts: list[str] = []

            # --- IP subnet flood detection ---
            ip_flood_rows = db.execute(
                select(
                    ReporterPIIVault.ip_subnet_hash,
                    sqlfunc.count(ConflictAlert.id).label("cnt"),
                    sqlfunc.array_agg(ConflictAlert.id).label("alert_ids"),
                )
                .join(
                    ConflictAlert,
                    ConflictAlert.anon_token == ReporterPIIVault.anon_token,
                )
                .where(
                    and_(
                        ConflictAlert.created_at >= ip_window,
                        ReporterPIIVault.ip_subnet_hash.isnot(None),
                    )
                )
                .group_by(ReporterPIIVault.ip_subnet_hash)
                .having(sqlfunc.count(ConflictAlert.id) >= IP_FLOOD_THRESHOLD)
            ).all()

            for row in ip_flood_rows:
                for aid in row.alert_ids:
                    flagged_alerts.append(str(aid))
                    logger.warning(
                        "IP subnet flood detected: subnet_hash=%s count=%d alert=%s",
                        row.ip_subnet_hash[:8] + "...", row.cnt, aid,
                    )

            # --- Phone hash flood detection ---
            phone_flood_rows = db.execute(
                select(
                    ReporterPIIVault.phone_hash,
                    sqlfunc.count(ConflictAlert.id).label("cnt"),
                    sqlfunc.array_agg(ConflictAlert.id).label("alert_ids"),
                )
                .join(
                    ConflictAlert,
                    ConflictAlert.anon_token == ReporterPIIVault.anon_token,
                )
                .where(
                    and_(
                        ConflictAlert.created_at >= phone_window,
                        ReporterPIIVault.phone_hash.isnot(None),
                    )
                )
                .group_by(ReporterPIIVault.phone_hash)
                .having(sqlfunc.count(ConflictAlert.id) >= PHONE_FLOOD_THRESHOLD)
            ).all()

            for row in phone_flood_rows:
                for aid in row.alert_ids:
                    aid_str = str(aid)
                    if aid_str not in flagged_alerts:
                        flagged_alerts.append(aid_str)
                    logger.warning(
                        "Phone flood detected: phone_hash=%s count=%d alert=%s",
                        row.phone_hash[:8] + "...", row.cnt, aid,
                    )

            # --- Flag all affected alerts ---
            if flagged_alerts:
                flood_alerts = db.execute(
                    select(ConflictAlert).where(
                        ConflictAlert.id.in_(
                            [uuid.UUID(a) for a in flagged_alerts]
                        )
                    )
                ).scalars().all()

                for alert in flood_alerts:
                    flags = alert.behavioral_trigger_flags or {}
                    flags["flood_suspect"] = True
                    flags["flood_flagged_at"] = datetime.now(tz=timezone.utc).isoformat()
                    alert.behavioral_trigger_flags = flags
                    # Demote to pending for human review if not already rejected
                    if alert.verification_status not in (
                        VerificationStatusEnum.rejected,
                        VerificationStatusEnum.disputed,
                    ):
                        alert.verification_status = VerificationStatusEnum.pending

                db.commit()
                logger.warning(
                    "Flood detection complete: %d alerts flagged", len(flagged_alerts)
                )
            else:
                logger.info("Flood detection complete: no suspicious patterns found")

            return {
                "status": "ok",
                "flagged_count": len(flagged_alerts),
                "flagged_alert_ids": flagged_alerts,
            }
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    try:
        return _run()
    except Exception as exc:
        raise self.retry(exc=exc)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _compute_heuristic_risk(alert: Any) -> float:
    """
    Simple heuristic risk scorer used until an ML model is deployed.

    Returns a float in [0.0, 1.0].

    Factors:
      - High-severity alert types get a base score boost.
      - Non-zero casualty estimate raises score.
      - Available coordinates (geom) are a positive signal.

    TODO: Replace with a trained scikit-learn / XGBoost model loaded at
          worker startup for production.
    """
    from models.database import AlertTypeEnum

    high_severity_types = {
        AlertTypeEnum.armed_clash,
        AlertTypeEnum.kidnapping_abduction,
        AlertTypeEnum.ieds_unexploded,
        AlertTypeEnum.infrastructure_attack,
    }
    medium_severity_types = {
        AlertTypeEnum.banditry,
        AlertTypeEnum.protest_riot,
        AlertTypeEnum.farmer_herder,
        AlertTypeEnum.election_violence,
        AlertTypeEnum.police_military_abuse,
    }

    score = 0.2  # base

    if alert.alert_type in high_severity_types:
        score += 0.4
    elif alert.alert_type in medium_severity_types:
        score += 0.2

    if alert.estimated_casualties:
        if alert.estimated_casualties >= 10:
            score += 0.3
        elif alert.estimated_casualties >= 3:
            score += 0.15
        else:
            score += 0.05

    if alert.geom is not None:
        score += 0.05  # geolocated report is more credible

    if alert.description and len(alert.description) > 100:
        score += 0.05  # detailed description is more credible

    return min(round(score, 4), 1.0)


def _score_to_risk_level(score: float) -> Any:
    """Map a continuous risk score to a discrete RiskLevelEnum value."""
    from models.database import RiskLevelEnum

    if score >= 0.75:
        return RiskLevelEnum.critical
    elif score >= 0.5:
        return RiskLevelEnum.high
    elif score >= 0.25:
        return RiskLevelEnum.medium
    else:
        return RiskLevelEnum.low
